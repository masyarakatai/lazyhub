/**
 * src/ai/providers/_base.js — Shared spawn helper for CLI-based AI providers.
 *
 * Security requirements (mirroring executor.js):
 *  - execFile only — no exec, no shell interpretation
 *  - Prompt piped via stdin — never as argv (diffs exceed ARG_MAX; injection risk)
 *  - Isolation — empty 0700 temp cwd + throwaway HOME; minimal env plus the
 *    provider's explicit env-var auth only (no repo, no user agent settings)
 *  - Cleanup of the sandbox on success, error, timeout and parent termination
 *  - 60s hard timeout + SIGTERM → SIGKILL after 5s grace
 *  - 256KB output cap — larger responses truncated and treated as malformed
 */

import { execFile as _execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, sep } from 'node:path'

// Note: We deliberately do NOT import from execa here — execFile is sufficient
// and avoids adding a dependency. The project's .eslintrc overrides allow execFile
// in provider files (they are not gh CLI callers).

const OUTPUT_CAP_BYTES   = 256 * 1024  // 256KB
const DEFAULT_TIMEOUT_MS = 60_000       // 60s
const KILL_GRACE_MS      = 5_000        // SIGTERM → SIGKILL grace

// Never forward anything else from the parent env (proxy, GH_*, NODE_OPTIONS,
// other providers' keys...). Provider-specific vars arrive via `auth.env`.
const BASE_ENV_ALLOW = ['PATH', 'USER', 'LANG', 'LC_ALL']

const _activeDirs     = new Set()
const _activeChildren = new Set()
let   _hooksInstalled = false

/**
 * Collect the named env vars from the parent environment (non-empty only).
 * @param {string[]} names
 * @returns {Record<string,string>}
 */
export function pickEnv(names) {
  /** @type {Record<string,string>} */
  const out = {}
  for (const n of names) if (process.env[n]) out[n] = process.env[n]
  return out
}

function isolationError(message, cause) {
  return Object.assign(new Error(`Isolation unavailable: ${message}`), { isIsolationFailure: true, cause })
}

/** Synchronously kill live children and remove every live sandbox. Idempotent. */
export function cleanupAllIsolated() {
  for (const c of _activeChildren) { try { c.kill?.('SIGKILL') } catch { /* already gone */ } }
  _activeChildren.clear()
  for (const d of _activeDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  _activeDirs.clear()
}

function installExitHooks() {
  if (_hooksInstalled) return
  _hooksInstalled = true
  process.on('exit', cleanupAllIsolated)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      cleanupAllIsolated()
      // Preserve default termination when nobody else handles the signal.
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, handler)
        process.kill(process.pid, sig)
      }
    }
    process.on(sig, handler)
  }
}

/**
 * Build the sandbox: <root>/{work,home,tmp}, all 0700. Throws an
 * `isIsolationFailure` error (after removing anything created) on any failure.
 * @param {{env?:Record<string,string>, homeEnv?:Record<string,string>}} auth
 */
function createIsolation(auth) {
  let root
  try {
    root = mkdtempSync(join(tmpdir(), 'lazyhub-ai-'))  // created 0700
    chmodSync(root, 0o700)
    _activeDirs.add(root)
    const work = join(root, 'work')
    const home = join(root, 'home')
    const tmp  = join(root, 'tmp')
    for (const d of [work, home, tmp]) mkdirSync(d, { mode: 0o700 })

    const env = { ...(auth.env || {}), ...pickEnv(BASE_ENV_ALLOW) }
    for (const [name, rel] of Object.entries(auth.homeEnv || {})) {
      const p = join(home, normalize(rel))
      if (p !== home && !p.startsWith(home + sep)) throw new Error('config dir escapes isolated HOME')
      mkdirSync(p, { recursive: true, mode: 0o700 })
      env[name] = p
    }
    Object.assign(env, {
      HOME:            home,
      TMPDIR:          tmp,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME:   join(home, '.local', 'share'),
      XDG_CACHE_HOME:  join(home, '.cache'),
    })
    installExitHooks()
    return { root, work, env }
  } catch (err) {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
      _activeDirs.delete(root)
    }
    throw isolationError(err.message, err)
  }
}

/**
 * Spawn a subprocess in an isolated sandbox, pipe stdin, capture stdout.
 * Enforces isolation (cwd + HOME), timeout (SIGTERM → SIGKILL), output cap and
 * a minimal env. The sandbox is removed on success, error, timeout and parent
 * termination. Rejects with `isIsolationFailure` if the sandbox can't be built.
 *
 * @param {object} opts
 * @param {string}   opts.cmd        - Executable path (resolved by caller)
 * @param {string[]} opts.args       - Argv array (never includes the prompt)
 * @param {string}   opts.stdin      - Text to pipe to the process's stdin
 * @param {number}   [opts.timeoutMs] - Timeout in ms (default: 60000)
 * @param {object}   [opts.auth]     - Explicit auth handoff (everything else is withheld)
 * @param {Record<string,string>} [opts.auth.env]     - Env vars to pass through
 * @param {Record<string,string>} [opts.auth.homeEnv] - Env var → path relative to isolated HOME
 * @returns {Promise<string>} stdout (up to OUTPUT_CAP_BYTES)
 */
export async function spawnAndPipe({ cmd, args, stdin, timeoutMs = DEFAULT_TIMEOUT_MS, auth = {} }) {
  const iso = createIsolation(auth)

  try {
    // execFile does NOT use a shell. To pipe stdin we use the callback form.
    const { stdout } = await new Promise((resolve, reject) => {
      let killTimer
      const child = _execFile(
        cmd,
        args,
        {
          cwd:        iso.work,
          env:        iso.env,
          timeout:    timeoutMs,
          killSignal: 'SIGTERM',
          maxBuffer:  OUTPUT_CAP_BYTES,
        },
        (err, stdout, stderr) => {
          clearTimeout(killTimer)
          if (child) _activeChildren.delete(child)
          if (err) {
            // timeout: err.killed === true (or err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' for cap)
            if (err.killed || err.signal === 'SIGTERM') {
              reject(Object.assign(new Error(`Process timed out after ${timeoutMs}ms`), { isTimeout: true }))
            } else if (err.code === 'ENOENT') {
              reject(Object.assign(new Error(`Command not found: ${cmd}`), { isNotFound: true }))
            } else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              // Output cap exceeded — treat as truncated but not fatal for detection
              reject(Object.assign(new Error(`Output exceeded ${OUTPUT_CAP_BYTES} byte cap`), { isOutputCap: true }))
            } else {
              const msg = (stderr || err.message || 'subprocess failed').split('\n')[0].trim()
              reject(Object.assign(new Error(msg), { exitCode: err.code, stderr }))
            }
            return
          }
          resolve({ stdout: stdout || '' })
        }
      )

      if (child) {
        _activeChildren.add(child)
        // execFile sends SIGTERM at timeoutMs; escalate if the child ignores it.
        killTimer = setTimeout(() => {
          try { child.kill?.('SIGKILL') } catch { /* already gone */ }
        }, timeoutMs + KILL_GRACE_MS)
        killTimer.unref?.()
      }

      // Write prompt to stdin then close it
      if (stdin) {
        child.stdin.write(stdin, 'utf8', (writeErr) => {
          if (writeErr) {
            // stdin may already be closed (e.g. process exited early)
            return
          }
          child.stdin.end()
        })
      } else {
        child.stdin.end()
      }
    })

    // Enforce output cap at the string level too (maxBuffer is in bytes)
    return stdout.slice(0, OUTPUT_CAP_BYTES)
  } finally {
    try { rmSync(iso.root, { recursive: true, force: true }) } catch { /* best effort */ }
    _activeDirs.delete(iso.root)
  }
}
