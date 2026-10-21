import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'fs'

/** Wire protocol version. Every message must carry it; mismatches fail closed. */
export const PROTOCOL_VERSION = 1
/** Largest accepted NDJSON line, in bytes. */
export const MAX_MESSAGE_BYTES = 64 * 1024
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const MAX_TTL_MS = 5 * 60_000
export const DEFAULT_TTL_MS = 60_000

/** Stable, machine-readable denial codes. */
export const ERR = Object.freeze({
  MALFORMED: 'E_MALFORMED',
  TOO_LARGE: 'E_TOO_LARGE',
  VERSION: 'E_VERSION',
  UNKNOWN_TYPE: 'E_UNKNOWN_TYPE',
  UNKNOWN_OP: 'E_UNKNOWN_OP',
  BAD_PARAMS: 'E_BAD_PARAMS',
  UNAUTHENTICATED: 'E_UNAUTHENTICATED',
  AUTH_EXPIRED: 'E_AUTH_EXPIRED',
  AUTH_REVOKED: 'E_AUTH_REVOKED',
  UNSUPPORTED: 'E_UNSUPPORTED',
  IDENTITY: 'E_IDENTITY',
  FAILED: 'E_FAILED',
})

/** Control messages that need an authenticated session. */
export const PRIVILEGED_TYPES = new Set(['stop', 'invalidate', 'policy', 'safe-mode', 'revoke'])

/** Error carrying a stable ERR code that is sent back to the client. */
export class ProtocolError extends Error {
  /**
   * @param {string} code one of ERR
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ─── Typed read operations ────────────────────────────────────────────────────
// Each op maps validated params to a fixed gh argv. There is deliberately no
// generic "run this gh/API call" op.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FIELDS_RE = /^[A-Za-z]+(,[A-Za-z]+)*$/
// No leading dash (flag injection), no whitespace-leading or control chars.
const SAFE_VALUE_RE = /^[^\s\u0000-\u001f-][^\u0000-\u001f]*$/

/**
 * @param {RegExp} re
 * @param {number} max
 */
const str = (re, max) => v => typeof v === 'string' && v.length <= max && re.test(v)
const posInt = max => v => Number.isInteger(v) && v >= 1 && v <= max

const isRepoShape = str(REPO_RE, 200)
const validRepo = v => isRepoShape(v) && !v.split('/').some(seg => seg === '.' || seg === '..')
const validFields = str(FIELDS_RE, 600)
const validValue = str(SAFE_VALUE_RE, 200)

/**
 * op name -> { params: required validators, optional: param -> gh flag, build }
 */
export const READ_OPS = {
  'pr.view': {
    params: { repo: validRepo, number: posInt(1e9), fields: validFields },
    build: p => ['pr', 'view', String(p.number), '--repo', p.repo, '--json', p.fields],
  },
  'pr.diff': {
    params: { repo: validRepo, number: posInt(1e9) },
    build: p => ['pr', 'diff', String(p.number), '--repo', p.repo],
  },
  'issue.list': {
    params: { repo: validRepo, limit: posInt(1000), fields: validFields },
    optional: { state: '--state', author: '--author', label: '--label', assignee: '--assignee', milestone: '--milestone' },
    build: (p, opt) => ['issue', 'list', '--repo', p.repo, '--limit', String(p.limit), ...opt, '--json', p.fields],
  },
  'run.list': {
    params: { repo: validRepo, limit: posInt(1000), fields: validFields },
    optional: { workflow: '--workflow', branch: '--branch', status: '--status' },
    build: (p, opt) => ['run', 'list', '--repo', p.repo, '--json', p.fields, '--limit', String(p.limit), ...opt],
  },
}

/**
 * Validate a typed read request and build its gh argv.
 *
 * @param {string} op
 * @param {unknown} params
 * @returns {string[]}
 * @throws {ProtocolError}
 */
export function buildReadArgs(op, params) {
  const def = typeof op === 'string' && Object.hasOwn(READ_OPS, op) ? READ_OPS[op] : null
  if (!def) throw new ProtocolError(ERR.UNKNOWN_OP, 'unknown read operation')
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new ProtocolError(ERR.BAD_PARAMS, 'params must be an object')
  }
  const allowed = new Set([...Object.keys(def.params), ...Object.keys(def.optional || {})])
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw new ProtocolError(ERR.BAD_PARAMS, `unexpected param: ${key}`)
  }
  for (const [key, valid] of Object.entries(def.params)) {
    if (!valid(params[key])) throw new ProtocolError(ERR.BAD_PARAMS, `invalid param: ${key}`)
  }
  const opt = []
  for (const [key, flag] of Object.entries(def.optional || {})) {
    if (params[key] === undefined) continue
    if (!validValue(params[key])) throw new ProtocolError(ERR.BAD_PARAMS, `invalid param: ${key}`)
    opt.push(flag, params[key])
  }
  return def.build(params, opt)
}

// Env that makes the daemon's gh identity differ from the caller's; such
// callers talk to gh directly instead of a shared cached identity.
const IDENTITY_ENV = ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/**
 * Map an executor gh argv to a typed read request, or null when the argv is not
 * an allowlisted read (the caller then runs gh directly). Round-trips through
 * buildReadArgs so the daemon runs exactly the argv the caller built.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{op:string, params:object}|null}
 */
export function toTypedRead(args, env = process.env) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return null
  if (IDENTITY_ENV.some(k => env[k]) || (env.GH_HOST && env.GH_HOST !== 'github.com')) return null
  const op = `${args[0]}.${args[1]}`
  if (!Object.hasOwn(READ_OPS, op)) return null
  const params = {}
  let rest = args.slice(2)
  if (args[0] === 'pr') {
    if (!/^[0-9]{1,9}$/.test(args[2] ?? '')) return null
    params.number = Number(args[2])
    rest = args.slice(3)
  }
  const flags = { '--repo': 'repo', '--json': 'fields', '--limit': 'limit' }
  for (const [key, flag] of Object.entries(READ_OPS[op].optional || {})) flags[flag] = key
  for (let i = 0; i < rest.length; i += 2) {
    const key = flags[rest[i]]
    if (!key || rest[i + 1] === undefined || params[key] !== undefined) return null
    params[key] = key === 'limit' ? Number(rest[i + 1]) : rest[i + 1]
  }
  try {
    const built = buildReadArgs(op, params)
    return built.length === args.length && built.every((a, i) => a === args[i]) ? { op, params } : null
  } catch {
    return null
  }
}

// ─── Operation classification (D8: fail closed) ───────────────────────────────
// Single source of truth for what runGh() may do with an argv. Only allowlisted
// reads are 'read'; known state-changing commands are 'write'; everything else
// (including anything that fails to parse) is 'unknown' and is refused. Only
// the typed READ_OPS subset is ever cacheable.

/** Read-only gh commands the app issues directly (superset of READ_OPS). */
const READ_COMMANDS = new Set([
  'pr list', 'pr view', 'pr diff', 'issue list', 'issue view', 'run list', 'run view',
  'release list', 'label list', 'gist list', 'gist view', 'repo view',
])
/** State-changing gh commands the TUI issues; audited, never cached or retried. */
const WRITE_COMMANDS = new Set([
  'pr merge', 'pr close', 'pr ready', 'pr review', 'pr comment', 'pr create', 'pr edit', 'pr checkout',
  'issue create', 'issue close', 'issue comment', 'issue edit',
  'run rerun', 'run cancel', 'gist delete',
])
const API_BODY_FLAGS = new Set(['-f', '-F', '--field', '--raw-field'])
const API_VALUE_FLAGS = new Set(['--jq', '-q', '--hostname'])
const API_BARE_FLAGS = new Set(['--paginate', '--slurp'])

/**
 * True for a GraphQL document that is a pure query (fail closed on anything odd).
 *
 * @param {unknown} doc
 */
function isGraphqlQuery(doc) {
  if (typeof doc !== 'string' || doc.startsWith('@')) return false
  const text = doc.replace(/#[^\n]*/g, '').trim()
  return /^(query\b|\{)/.test(text) && !/\b(mutation|subscription)\b/i.test(text)
}

/**
 * @param {string[]} args
 * @returns {'read'|'write'|'unknown'}
 */
function classifyApi(args) {
  let method = null
  let endpoint = null
  let input = false
  let body = false
  const queries = []
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--method' || a === '-X') {
      method = args[i += 1]
      if (typeof method !== 'string') return 'unknown'
    } else if (a.startsWith('--method=')) method = a.slice('--method='.length)
    else if (/^-X./.test(a)) method = a.slice(2)
    else if (API_BODY_FLAGS.has(a)) {
      const val = args[i += 1]
      if (typeof val !== 'string') return 'unknown'
      body = true
      if (val.startsWith('query=')) queries.push(val.slice('query='.length))
    } else if (a === '--input' || a.startsWith('--input=')) {
      input = true
      if (a === '--input') i += 1
    } else if (API_VALUE_FLAGS.has(a)) i += 1
    else if (API_BARE_FLAGS.has(a)) continue
    else if (a.startsWith('-')) return 'unknown'
    else if (endpoint === null) endpoint = a
    else return 'unknown'
  }
  if (endpoint === null) return 'unknown'
  const verb = method === null ? null : method.toUpperCase()
  if (input) return 'write'
  if (/graphql/i.test(endpoint)) {
    const ok = queries.length > 0 && queries.every(isGraphqlQuery)
    return ok && (verb === null || verb === 'GET' || verb === 'POST') ? 'read' : 'write'
  }
  // GET/HEAD is a read; so is no method with no fields (gh defaults to GET).
  // Any other method, and an implicit POST (fields without a method), is a write.
  return verb === 'GET' || verb === 'HEAD' || (verb === null && !body) ? 'read' : 'write'
}

/**
 * Classify a gh argv. Never throws; any failure classifies as 'unknown'.
 *
 * @param {unknown} args
 * @returns {'read'|'write'|'unknown'}
 */
export function classifyGh(args) {
  try {
    if (!Array.isArray(args) || args.length === 0 || args.some(a => typeof a !== 'string')) return 'unknown'
    if (args[0] === 'api') return classifyApi(args)
    const key = `${args[0]} ${args[1]}`
    if (READ_COMMANDS.has(key)) return 'read'
    if (WRITE_COMMANDS.has(key)) return 'write'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * True only for typed read ops, the sole cacheable operations.
 *
 * @param {unknown} op
 */
export function isCacheableOp(op) {
  return typeof op === 'string' && Object.hasOwn(READ_OPS, op)
}

// ─── Authenticated sessions ───────────────────────────────────────────────────

/**
 * Create a session secret and write it to a 0600 file.
 *
 * @param {string} tokenPath
 * @param {number} [now]
 * @returns {{token:string, expiresAt:number, revoked:boolean}}
 */
export function issueSession(tokenPath, now = Date.now()) {
  const token = randomBytes(32).toString('hex')
  try { unlinkSync(tokenPath) } catch { /* none yet */ }
  writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  if (process.platform !== 'win32') chmodSync(tokenPath, 0o600)
  return { token, expiresAt: now + SESSION_TTL_MS, revoked: false }
}

/**
 * @param {string} tokenPath
 * @returns {string|null}
 */
export function readSessionToken(tokenPath) {
  try { return readFileSync(tokenPath, 'utf8').trim() || null } catch { return null }
}

/**
 * Constant-time comparison of a presented secret against the session.
 *
 * @param {{token:string, expiresAt:number, revoked?:boolean}} session
 * @param {unknown} presented
 * @param {number} [now]
 * @returns {string|null} an ERR code, or null when authorized
 */
export function checkSession(session, presented, now = Date.now()) {
  if (session.revoked) return ERR.AUTH_REVOKED
  if (typeof presented !== 'string' || !presented) return ERR.UNAUTHENTICATED
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(session.token).digest()
  if (!timingSafeEqual(a, b)) return ERR.UNAUTHENTICATED
  if (now > session.expiresAt) return ERR.AUTH_EXPIRED
  return null
}

// ─── Daemon environment ───────────────────────────────────────────────────────

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'LAZYHUB_CACHE_DIR']
const UNSAFE_ENV_RE = /^(GH_|GITHUB_|ANTHROPIC_|CLAUDE|CODEX_|NODE_OPTIONS$)/

/**
 * Minimal explicit env for the daemon process.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function daemonSpawnEnv(env = process.env) {
  const out = { LAZYHUB_DAEMON_CHILD: '1' }
  for (const key of ENV_ALLOWLIST) if (env[key]) out[key] = env[key]
  return out
}

/**
 * Names of inherited variables the daemon refuses to run with.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function unsafeDaemonEnv(env = process.env) {
  return Object.keys(env).filter(k => UNSAFE_ENV_RE.test(k))
}

const AGENT_ENV_RE = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|GEMINI_CLI|AIDER_|LAZYHUB_AGENT|LAZYHUB_MCP)/

/**
 * Conservative untrusted-agent-context detection: anything that is not an
 * interactive TTY session, or that carries an agent marker, is untrusted.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{stdin?:{isTTY?:boolean}, stdout?:{isTTY?:boolean}}} [io]
 */
export function isUntrustedAgentContext(env = process.env, io = process) {
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) return true
  return Object.keys(env).some(k => AGENT_ENV_RE.test(k))
}
