/**
 * src/ai/providers/codex.js — Codex CLI provider.
 *
 * Uses the `codex` CLI for executing agent tasks.
 * Prompt is piped via stdin — never argv (diffs exceed ARG_MAX).
 *
 * Isolation (#252): runs in an empty temp cwd with a throwaway HOME/CODEX_HOME.
 * Auth handoff is the minimum available: CODEX_API_KEY / OPENAI_API_KEY env if
 * set, else ONLY ~/.codex/auth.json (or $CODEX_HOME/auth.json) is copied (0600)
 * into the isolated CODEX_HOME. config.toml, rules, hooks, MCP, AGENTS.md and
 * history are never exposed. No credential -> provider unavailable.
 *
 * Note: Codex outputs NDJSON event stream (one JSON object per line).
 * We filter for 'agent_message' events and concatenate their text.
 */

import { spawnAndPipe, pickEnv, realHome, credentialFileExists } from './_base.js'
import { isAbsolute, join, relative } from 'node:path'
import { AIError } from '../error.js'

// ── Provider metadata ─────────────────────────────────────────────────────────

export const id          = 'codex'
export const displayName = 'Codex CLI'
export const authSource  = '~/.codex/auth.json or CODEX_API_KEY'

// ── Capability flags ──────────────────────────────────────────────────────────

export const capabilities = {
  systemPrompt:   true,
  jsonMode:       false,
  promptCaching:  false,
}

// ── Isolation / auth ──────────────────────────────────────────────────────────

const AUTH_HELP = 'run `codex login` (or set CODEX_API_KEY) to use Codex'

/** Path of auth.json relative to the real HOME, or null if CODEX_HOME is outside HOME. */
function authFileRel() {
  const ch = process.env.CODEX_HOME
  if (!ch) return join('.codex', 'auth.json')
  const rel = relative(realHome(), join(ch, 'auth.json'))
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel
}

/** Minimum auth material for the isolated run, or null if none is available. */
function resolveAuth() {
  const keys = pickEnv(['CODEX_API_KEY', 'OPENAI_API_KEY'])
  if (Object.keys(keys).length) return { env: keys, homeEnv: { CODEX_HOME: '.codex' } }
  const rel = authFileRel()
  if (rel && credentialFileExists(rel)) {
    return {
      files:   [{ src: join(realHome(), rel), dest: join('.codex', 'auth.json') }],
      homeEnv: { CODEX_HOME: '.codex' },
    }
  }
  return null
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect whether the Codex CLI is available on PATH.
 * @returns {Promise<{available: boolean, version?: string, reason?: string}>}
 */
export async function detect() {
  try {
    const stdout = await spawnAndPipe({
      cmd:       'codex',
      args:      ['--version'],
      stdin:     '',
      timeoutMs: 5_000,
    })
    const version = stdout.trim().split('\n')[0] || 'unknown'
    if (!resolveAuth()) return { available: false, version, reason: AUTH_HELP }
    return { available: true, version }
  } catch (err) {
    if (err.isNotFound) {
      return { available: false, reason: 'codex CLI not found on PATH' }
    }
    return { available: false, reason: err.message }
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────

/**
 * Run the prompt through the Codex CLI.
 *
 * The combined system+user prompt is piped via stdin in the format:
 *   <system>\n\n<user>
 *
 * Codex outputs NDJSON event stream. We filter for 'agent_message' type
 * events and concatenate their 'message' fields.
 *
 * @param {object} opts
 * @param {string}  opts.system      - System prompt text
 * @param {string}  opts.user        - User message text
 * @param {number}  [opts.maxTokens] - Ignored (CLI controls max tokens)
 * @param {string}  [opts._model]    - Model override (not applicable to Codex)
 * @param {number}  [opts.timeoutMs] - Timeout override
 * @returns {Promise<{text: string, modelUsed: string, tokensIn: null, tokensOut: null}>}
 */
export async function complete({ system, user, _model, timeoutMs }) {
  const auth = resolveAuth()
  if (!auth) throw new AIError(AUTH_HELP, { code: 'auth-required', provider: id })

  // Combine system + user into a single stdin payload
  const stdinPayload = system
    ? `${system}\n\n${user}`
    : user

  const argv = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',     // never load $CODEX_HOME/config.toml (auth still uses CODEX_HOME)
    '--ignore-rules',           // no execpolicy .rules files
    '--ephemeral',              // no session files
    '--sandbox', 'read-only',
  ]

  let rawOutput
  try {
    rawOutput = await spawnAndPipe({
      cmd:       'codex',
      args:      argv,
      stdin:     stdinPayload,
      timeoutMs: timeoutMs || 60_000,
      auth,
    })
  } catch (err) {
    if (err.isIsolationFailure) {
      throw new AIError(`Codex unavailable: ${err.message}`, { code: 'provider-unavailable', provider: id })
    }
    if (err.isTimeout) {
      throw new AIError('Codex CLI timed out', { code: 'timeout', provider: id })
    }
    if (err.isNotFound) {
      throw new AIError('codex CLI not found on PATH', { code: 'spawn-failed', provider: id })
    }
    if (err.isOutputCap) {
      throw new AIError('Codex CLI output exceeded size cap', { code: 'malformed-response', provider: id })
    }
    // Non-zero exit — could be auth failure or other error
    const msg = err.message || 'codex CLI failed'
    if (/not logged in|unauthenticated|login/i.test(msg)) {
      throw new AIError('Codex not logged in — run `codex login`', { code: 'auth-required', provider: id })
    }
    throw new AIError(`Codex CLI error: ${msg}`, { code: 'provider-unavailable', provider: id })
  }

  // Parse NDJSON output: each line is a JSON event object
  const lines = rawOutput.trim().split('\n').filter(line => line.length > 0)
  const messages = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'agent_message' && typeof event.message === 'string') {
        messages.push(event.message)
      }
    } catch {
      // Silently skip unparseable lines (could be logging or other noise)
      continue
    }
  }

  if (messages.length === 0) {
    throw new AIError('No assistant message in Codex output', { code: 'malformed-response', provider: id })
  }

  const text = messages.join('')

  return {
    text,
    modelUsed: 'codex',  // Codex doesn't expose model name
    tokensIn:  null,     // CLI doesn't expose token counts
    tokensOut: null,
  }
}
