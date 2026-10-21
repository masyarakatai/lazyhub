/**
 * executor.js — the ONLY place the `gh` CLI is invoked in lazyhub.
 *
 * `runGh(args, opts)` is the single chokepoint: every exported function routes
 * through it. That gives one place to mock in tests, one place to type errors
 * (GhError), and one place to instrument (timeout, future retry/observability).
 */

import { execa } from 'execa'
import { GhError } from './gh-error.js'
import { recordDuration } from '../perf.js'
import { invalidateRepoCache } from '../cache.js'
import { requestDaemon } from '../daemon/lifecycle.js'
import { toTypedRead } from '../daemon/protocol.js'
import { isGhMutation, writeAuditEntry } from '../daemon/audit.js'

// Re-exported so `import { GhError } from './executor.js'` keeps working.
export { GhError }

// ─── runGh() — the gh chokepoint ──────────────────────────────────────────────

/** Default per-call timeout for the gh CLI (ms). Override via opts.timeout. */
const GH_TIMEOUT = 30_000
const GH_HISTORY_LIMIT = 20
const ghCallHistory = []

function pushGhCall(entry) {
  ghCallHistory.push({
    args: Array.isArray(entry.args) ? entry.args.map(arg => String(arg)) : [],
    durationMs: Math.max(0, Math.round(entry.durationMs || 0)),
    exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : 1,
    ...(entry.error ? { error: String(entry.error).slice(0, 240) } : {}),
  })
  if (ghCallHistory.length > GH_HISTORY_LIMIT) {
    ghCallHistory.splice(0, ghCallHistory.length - GH_HISTORY_LIMIT)
  }
}

function ghOpName(args) {
  return args.slice(0, 2).join(' ') || 'gh'
}

function repoFromArgs(args) {
  const repoIndex = args.indexOf('--repo')
  if (repoIndex >= 0 && args[repoIndex + 1]) return args[repoIndex + 1]
  const apiPath = args[0] === 'api' ? args[1] : null
  const match = typeof apiPath === 'string' ? apiPath.match(/^repos\/([^/]+\/[^/]+)/) : null
  return match?.[1] || null
}

/**
 * Return a sanitized copy of the recent gh CLI call history.
 * @returns {{args:string[],durationMs:number,exitCode:number,error?:string}[]}
 */
export function getGhCallHistory() {
  return ghCallHistory.map(entry => ({ ...entry, args: [...entry.args] }))
}

/**
 * The ONLY function that spawns the `gh` CLI. All executor functions route here.
 *
 * On exit code 0: returns parsed JSON, or the raw stdout string when the body
 * is not JSON (e.g. a diff). On non-zero exit, timeout, or spawn failure: throws
 * a GhError carrying sanitized stderr, the exit code, and the args.
 *
 * @param {string[]} args            argv to pass to gh
 * @param {object}   [opts]
 * @param {number}   [opts.timeout]  per-call timeout in ms (default 30s)
	 * @param {boolean}  [opts.json]     false → never JSON.parse (return raw text);
	 *                                   true/undefined → parse JSON, fall back to raw
	 * @param {string}   [opts.stdin]    optional payload written to the gh stdin
	 * @param {boolean}  [opts.skipDaemon] bypass the local daemon even when available
	 * @param {number}   [opts.ttl]      daemon cache TTL override in ms
	 * @returns {Promise<any>}           parsed JSON or raw string (null if empty)
 * @throws {GhError}                 on non-zero exit, timeout, or spawn failure
 */
export async function runGh(args, opts = {}) {
  const { timeout = GH_TIMEOUT, json, stdin, skipDaemon, ttl } = opts
  const typed = !skipDaemon && process.env.LAZYHUB_DAEMON_SOCKET && stdin === undefined && json !== false
    ? toTypedRead(args)
    : null
  if (typed) {
    try {
      const response = await requestDaemon(process.env.LAZYHUB_DAEMON_SOCKET, {
        type: 'read',
        ...typed,
        ttl,
      }, Math.min(timeout, 5000))
      return response.payload
    } catch {
      // Fall back to direct gh if the daemon vanished or is stale.
    }
  }
  const started = Date.now()
  // GH_HOST / GH_TOKEN are inherited by the child process from process.env
  // (we pass no curated env here — see ARCHITECT_DECISIONS invariant 4, which
  // scopes env-stripping to AI provider subprocesses, NOT gh). gh CLI honors
  // GH_HOST for `--repo OWNER/REPO`-style invocations. We deliberately do NOT
  // pass --hostname: it's a per-subcommand flag (valid on `gh api`, `gh auth *`,
  // `gh repo *`) and is rejected globally by `gh pr list`, `gh issue list`, etc.
  let result
  try {
    const proc = execa('gh', args, { reject: false, timeout })
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
    result = await proc
  } catch (err) {
    pushGhCall({
      args,
      durationMs: Date.now() - started,
      exitCode: err.exitCode ?? 1,
      error: err.message,
    })
    recordDuration('gh', ghOpName(args), Date.now() - started)
    throw new GhError({
      message: err.message,
      stderr: err.stderr || '',
      exitCode: err.exitCode ?? 1,
      args,
    })
  }

  if (result.timedOut) {
    pushGhCall({
      args,
      durationMs: Date.now() - started,
      exitCode: result.exitCode ?? 1,
      error: 'timeout',
    })
    recordDuration('gh', ghOpName(args), Date.now() - started)
    throw new GhError({
      message: `gh ${args.slice(0, 3).join(' ')} timed out after ${timeout}ms`,
      stderr: (result.stderr || '').replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]'),
      exitCode: result.exitCode ?? 1,
      args: args.map(arg => typeof arg === 'string' ? arg.replace(/[a-zA-Z0-9_-]{40,}/g, '[REDACTED]') : arg),
    })
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr || ''
    let message = `gh ${args.slice(0, 3).join(' ')} failed`

    if (stderr.includes('rate limit')) {
      message = 'GitHub API rate limit exceeded'
    } else if (stderr.includes('not found') || stderr.includes('Could not resolve') || /HTTP\s*404/i.test(stderr)) {
      message = 'Resource not found'
    } else if (stderr) {
      // Sanitize the user-facing message: redact only token-length runs (40+
      // chars — the length of a gh PAT like `ghp_…`). The char class excludes
      // `/` and `.`, so repo names (myorg/very-long-repo-name) and branch names
      // (feature/jira-XYZ-123-…) survive intact. The full `stderr` field below
      // stays more aggressive (20+) since it's diagnostic, not user-facing.
      message = stderr.split('\n')[0].trim().replace(/[a-zA-Z0-9_-]{40,}/g, '[REDACTED]')
    }

    pushGhCall({
      args,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      error: message,
    })
    recordDuration('gh', ghOpName(args), Date.now() - started)
    throw new GhError({
      message,
      stderr: stderr.replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]'),
      exitCode: result.exitCode,
      args: args.map(arg => typeof arg === 'string' ? arg.replace(/[a-zA-Z0-9_-]{40,}/g, '[REDACTED]') : arg),
    })
  }

  pushGhCall({
    args,
    durationMs: Date.now() - started,
    exitCode: 0,
  })
  recordDuration('gh', ghOpName(args), Date.now() - started)
  if (isGhMutation(args)) {
    const repo = repoFromArgs(args)
    invalidateRepoCache(repo)
    writeAuditEntry({ op: ghOpName(args), repo, args: args.slice(0, 4) })
  }

  const stdout = result.stdout?.trim()
  if (!stdout) return null

  if (json === false) return stdout // caller wants raw text (diff, logs, …)

  try {
    return JSON.parse(stdout)
  } catch {
    // Not JSON — return raw string (e.g. diff output)
    return stdout
  }
}

// ─── Helper: get current repo from env ───────────────────────────────────────

/**
 * Resolve the effective repository for a gh call.
 * @param {string} overrideRepo
 */
export function getRepo(overrideRepo) {
  return overrideRepo || process.env.GHUI_REPO
}
