import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getGhCallHistory } from './executor.js'
import { ensurePrivateDir, writePrivateFile } from './secure-fs.js'

const CACHE_DIR = join(homedir(), '.cache', 'lazyhub')
const FILE_PREFIX = 'debug-state-'
const FILE_SUFFIX = '.json'

function packageInfo() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return { name: pkg.name, version: pkg.version }
  } catch {
    return { name: 'lazyhub', version: 'unknown' }
  }
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null
}

function cleanString(value) {
  return String(value)
    .replace(/\b(authorization|proxy-authorization|cookie)\s*[:=]\s*[^\n]*/gi, '$1: [redacted]')
    .replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .replace(/\bhttps?:\/\/[^\s"']+/gi, '[url]')
    .replace(/\brepos\/[^/\s]+\/[^/\s]+/g, 'repos/[repo]')
    .slice(0, 500)
}

// Keys whose values are credentials or free-form/private content; dropped entirely.
const DROPPED_KEY = /secret|password|auth|credential|cookie|body|comment|payload|diff|content/i
// Keys that identify a repository; the value is replaced, not copied.
const REPO_KEY = /^(repo|repository|owner|nwo|full_?name|slug)$/i

/**
 * Reduce a recorded gh argv to its shape: command words and flag names stay;
 * values (repo slugs, field bodies, queries, branch names, ids in paths) do not.
 * @param {string[]} args
 */
function redactGhArgs(args) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i])
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=')
      out.push(eq > 0 ? `${arg.slice(0, eq)}=[redacted]` : arg)
      if (eq < 0 && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) { out.push('[redacted]'); i += 1 }
    } else if (i === 0) {
      out.push(cleanString(arg).slice(0, 40))
    } else if (args[0] === 'api' && i === 1) {
      out.push(arg.split('?')[0].replace(/^\/?repos\/[^/]+\/[^/]+/, 'repos/[repo]').replace(/\/[^/]*\d[^/]*(?=\/|$)/g, '/[id]'))
    } else if (i === 1 && /^[a-z-]{1,20}$/.test(arg)) {
      out.push(arg)
    } else {
      out.push(/^\d+$/.test(arg) ? arg : '[redacted]')
    }
  }
  return out
}

function redactGhCall(call) {
  return {
    args: redactGhArgs(call.args || []),
    durationMs: call.durationMs,
    exitCode: call.exitCode,
    ...(call.error ? { error: '[redacted]' } : {}),
  }
}

function cleanValue(value, depth = 0) {
  if (depth > 4) return '[depth-limit]'
  if (value == null) return value
  if (typeof value === 'string') return cleanString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map(item => cleanValue(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (DROPPED_KEY.test(key)) continue
    if (REPO_KEY.test(key)) { out[key] = '[redacted]'; continue }
    const safeKey = key.replace(/token/ig, 'redacted').replace(/api[_-]?key/ig, 'redacted')
    out[safeKey] = cleanValue(child, depth + 1)
  }
  return out
}

// Filters are user-entered and may hold anything; only short enum-like words survive.
function cleanFilters(filters) {
  const out = {}
  for (const [key, value] of Object.entries(filters && typeof filters === 'object' ? filters : {})) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else out[key] = typeof value === 'string' && /^[A-Za-z_-]{1,16}$/.test(value) ? value : '[redacted]'
  }
  return out
}

/**
 * Build the redacted debug-state object.
 * @param {object} appState optional app-level state snapshot
 * @returns {object} serializable debug-state payload
 */
export function collectDebugState(appState = {}) {
  const pkg = packageInfo()
  const state = cleanValue(appState)
  return {
    generatedAt: new Date().toISOString(),
    version: pkg.version,
    node: process.version,
    platform: {
      name: process.platform,
      arch: process.arch,
    },
    terminal: {
      columns: safeNumber(process.stdout.columns),
      rows: safeNumber(process.stdout.rows),
      term: cleanString(process.env.TERM || ''),
    },
    app: {
      activePane: state.activePane ?? null,
      view: state.view ?? null,
      itemNumber: state.itemNumber ?? null,
      filters: cleanFilters(state.filters),
      cursors: state.cursors ?? {},
      dialog: state.dialog ?? null,
      mode: state.mode ?? null,
    },
    ghCalls: getGhCallHistory().map(redactGhCall),
    // Toast text can embed titles, repo names or API errors; keep only the severity.
    recentStatus: Array.isArray(state.recentStatus) ? state.recentStatus.slice(-5).map(s => ({ variant: typeof s?.variant === 'string' ? s.variant.slice(0, 16) : null })) : [],
  }
}

function ensureCacheDir() {
  ensurePrivateDir(CACHE_DIR)
}

/**
 * Find the newest debug-state file in the lazyhub cache directory.
 * @returns {string|null} absolute path, or null when none exists
 */
export function getMostRecentDebugStatePath() {
  if (!existsSync(CACHE_DIR)) return null
  const files = readdirSync(CACHE_DIR)
    .filter(file => file.startsWith(FILE_PREFIX) && file.endsWith(FILE_SUFFIX))
    .sort()
  const latest = files.at(-1)
  return latest ? join(CACHE_DIR, latest) : null
}

/**
 * Write a redacted debug-state snapshot to the lazyhub cache directory.
 * @param {object} appState optional app-level state snapshot
 * @returns {{path:string,state:object}} written path and payload
 */
export function writeDebugState(appState = {}) {
  ensureCacheDir()
  const state = collectDebugState(appState)
  const stamp = state.generatedAt.replace(/[:.]/g, '-')
  const path = join(CACHE_DIR, `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`)
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`)
  return { path, state }
}

/**
 * Return the latest debug-state payload, creating an environment-only dump if needed.
 * @returns {{path:string,state:object}} debug-state path and payload
 */
export function printDebugState() {
  const latest = getMostRecentDebugStatePath()
  if (latest) {
    return { path: latest, state: JSON.parse(readFileSync(latest, 'utf8')) }
  }
  return writeDebugState()
}
