/**
 * src/ai/providers/claude-code.js — Claude Code CLI provider.
 *
 * Uses the `claude` CLI in non-interactive (-p) mode.
 * Prompt is piped via stdin — never argv (diffs exceed ARG_MAX).
 *
 * Isolation (#252): runs in an empty temp cwd with a throwaway HOME, so no
 * repo CLAUDE.md/.claude settings, plugins, hooks, or the user's ~/.claude are
 * loaded. Auth is handed over explicitly via env only:
 *   - ANTHROPIC_API_KEY        -> `--bare` (API-key-only minimal mode)
 *   - CLAUDE_CODE_OAUTH_TOKEN  -> (`claude setup-token`) non-bare
 * Without either, the provider is unavailable (OAuth/keychain logins cannot be
 * handed over without exposing the real config dir).
 */

import { spawnAndPipe, pickEnv } from './_base.js'
import { AIError } from '../error.js'
import { DEFAULT_MODEL } from '../prompt.js'

// ── Provider metadata ─────────────────────────────────────────────────────────

export const id          = 'claude-code'
export const displayName = 'Claude Code'
export const authSource  = 'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN'

// ── Capability flags ──────────────────────────────────────────────────────────

export const capabilities = {
  systemPrompt:   true,
  jsonMode:       false,
  promptCaching:  false,  // CLI handles caching internally
}

// ── Isolation / auth ──────────────────────────────────────────────────────────

const AUTH_HELP = 'unavailable: run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or set ANTHROPIC_API_KEY (a `claude login` session is not shared with the isolated run)'

/** Minimum auth material for the isolated run, or null if none is configured. */
function resolveAuth() {
  const key = pickEnv(['ANTHROPIC_API_KEY'])
  if (key.ANTHROPIC_API_KEY) return { auth: { env: key }, bare: true }
  const tok = pickEnv(['CLAUDE_CODE_OAUTH_TOKEN'])
  if (tok.CLAUDE_CODE_OAUTH_TOKEN) return { auth: { env: tok }, bare: false }
  return null
}

// Disable everything that could execute or load repo/user-controlled content.
const HARDENING_ARGS = [
  '--tools', '',                // no built-in tools
  '--strict-mcp-config',        // ignore all MCP configs (none supplied)
  '--disable-slash-commands',   // no skills/commands
  '--setting-sources', '',      // no user/project/local settings
  '--no-session-persistence',
]

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect whether the Claude Code CLI is available on PATH.
 * @returns {Promise<{available: boolean, version?: string, reason?: string}>}
 */
export async function detect() {
  try {
    const stdout = await spawnAndPipe({
      cmd:       'claude',
      args:      ['--version'],
      stdin:     '',
      timeoutMs: 5_000,
    })
    const version = stdout.trim().split('\n')[0] || 'unknown'
    if (!resolveAuth()) return { available: false, version, reason: AUTH_HELP }
    return { available: true, version }
  } catch (err) {
    if (err.isNotFound) {
      return { available: false, reason: 'claude CLI not found on PATH' }
    }
    return { available: false, reason: err.message }
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────

/**
 * Run the prompt through the Claude Code CLI.
 *
 * The combined system+user prompt is piped via stdin in the format:
 *   <system>\n\n<user>
 *
 * `--output-format json` returns { type, result, ... } where `result` is the
 * assistant text. `--max-turns 1` prevents agent tool-use loops.
 *
 * @param {object} opts
 * @param {string}  opts.system     - System prompt text
 * @param {string}  opts.user       - User message text
 * @param {number}  [opts.maxTokens] - Ignored (CLI controls max tokens)
 * @param {string}  [opts.model]    - Model override (default: claude-haiku-4-5)
 * @param {number}  [opts.timeoutMs] - Timeout override
 * @returns {Promise<{text: string, modelUsed: string, tokensIn: null, tokensOut: null}>}
 */
export async function complete({ system, user, model, timeoutMs }) {
  const resolvedModel = model || DEFAULT_MODEL

  const resolved = resolveAuth()
  if (!resolved) throw new AIError(AUTH_HELP, { code: 'auth-required', provider: id })

  // Combine system + user into a single stdin payload
  const stdinPayload = system
    ? `${system}\n\n${user}`
    : user

  const argv = [
    ...(resolved.bare ? ['--bare'] : []),
    '-p',
    ...HARDENING_ARGS,
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', resolvedModel,
  ]

  let rawOutput
  try {
    rawOutput = await spawnAndPipe({
      cmd:       'claude',
      args:      argv,
      stdin:     stdinPayload,
      timeoutMs: timeoutMs || 60_000,
      auth:      resolved.auth,
    })
  } catch (err) {
    if (err.isIsolationFailure) {
      throw new AIError(`Claude Code unavailable: ${err.message}`, { code: 'provider-unavailable', provider: id })
    }
    if (err.isTimeout) {
      throw new AIError('Claude Code CLI timed out', { code: 'timeout', provider: id })
    }
    if (err.isNotFound) {
      throw new AIError('claude CLI not found on PATH', { code: 'spawn-failed', provider: id })
    }
    if (err.isOutputCap) {
      throw new AIError('Claude Code CLI output exceeded size cap', { code: 'malformed-response', provider: id })
    }
    // Non-zero exit — could be auth failure or other error
    const msg = err.message || 'claude CLI failed'
    if (/not logged in|unauthenticated|login/i.test(msg)) {
      throw new AIError(AUTH_HELP, { code: 'auth-required', provider: id })
    }
    throw new AIError(`Claude Code CLI error: ${msg}`, { code: 'provider-unavailable', provider: id })
  }

  // Parse JSON output: { type: 'result', result: '<assistant text>', ... }
  let parsed
  try {
    parsed = JSON.parse(rawOutput.trim())
  } catch {
    throw new AIError('Could not parse Claude Code CLI output as JSON', { code: 'malformed-response', provider: id })
  }

  // The CLI reports API failures (e.g. 401 invalid key) as a JSON result with is_error:true
  if (parsed?.is_error) {
    if (parsed.api_error_status === 401 || /invalid api key|not logged in|oauth/i.test(String(parsed.result))) {
      throw new AIError('Claude Code rejected the configured credential — check CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY', { code: 'auth-required', provider: id })
    }
    throw new AIError('Claude Code CLI reported an error', { code: 'provider-unavailable', provider: id })
  }

  const text = parsed?.result
  if (typeof text !== 'string') {
    throw new AIError('Unexpected Claude Code CLI response shape', { code: 'malformed-response', provider: id })
  }

  return {
    text,
    modelUsed: parsed?.model || resolvedModel,
    tokensIn:  null,  // CLI doesn't expose token counts
    tokensOut: null,
  }
}
