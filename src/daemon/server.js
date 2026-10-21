import { createServer } from 'net'
import { writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { runGh } from '../executor/core.js'
import {
  daemonPidPath, daemonSocketPath, daemonTokenPath, ensureSocketDir, removeStaleSocket,
} from './lifecycle.js'
import { DaemonCache } from './cache.js'
import { EventBus } from './event-bus.js'
import {
  DEFAULT_TTL_MS, ERR, MAX_MESSAGE_BYTES, MAX_TTL_MS, PRIVILEGED_TYPES, PROTOCOL_VERSION,
  ProtocolError, buildReadArgs, checkSession, issueSession, unsafeDaemonEnv,
} from './protocol.js'

const DEFAULT_HOST = 'github.com'
const ACCOUNT_TTL_MS = 60_000

function send(socket, payload) {
  try { socket.write(JSON.stringify(payload) + '\n') } catch { /* disconnected */ }
}

function deny(socket, id, code, message) {
  send(socket, { id: id ?? null, ok: false, code, error: message })
}

/**
 * Start the K-lite daemon in the current process.
 *
 * @param {object} config loaded lazyhub config
 * @param {NodeJS.ProcessEnv} [env] environment to vet; unsafe inherited variables abort startup
 */
export function startDaemon(config = {}, env = process.env) {
  const unsafe = unsafeDaemonEnv(env)
  if (unsafe.length > 0) {
    throw new Error(`refusing to start daemon with inherited environment: ${unsafe.join(', ')}`)
  }
  const socketPath = daemonSocketPath(config)
  const pidPath = daemonPidPath(config)
  const tokenPath = daemonTokenPath(config)
  const idleMs = Math.max(1, config.daemon?.idle_timeout_minutes || 30) * 60_000
  const startedAt = Date.now()
  const clients = new Set()
  const bus = new EventBus()
  const cache = new DaemonCache({ defaultTtl: DEFAULT_TTL_MS })
  let ghCalls = 0
  let cacheHits = 0
  let idleTimer = null
  let session = null
  let account = null

  ensureSocketDir(socketPath)
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })
  removeStaleSocket(socketPath)

  const server = createServer(socket => {
    clients.add(socket)
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    let buffer = ''

    socket.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      if (buffer.length > MAX_MESSAGE_BYTES || lines.some(l => l.length > MAX_MESSAGE_BYTES)) {
        deny(socket, null, ERR.TOO_LARGE, 'message too large')
        socket.destroy()
        return
      }
      for (const line of lines) {
        if (line.trim()) handleMessage(socket, line.trim())
      }
    })
    socket.on('close', () => {
      clients.delete(socket)
      armIdleShutdown()
    })
    socket.on('error', () => {
      clients.delete(socket)
      armIdleShutdown()
    })
  })

  async function resolveIdentity() {
    if (account && Date.now() - account.ts < ACCOUNT_TTL_MS) return account.login
    const login = await runGh(['api', 'user', '--jq', '.login'], { skipDaemon: true, json: false })
    if (typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(login)) {
      throw new ProtocolError(ERR.IDENTITY, 'could not resolve authenticated account')
    }
    account = { login, ts: Date.now() }
    return login
  }

  async function handleRead(socket, msg) {
    const args = buildReadArgs(msg.op, msg.params)
    const ttl = Number.isFinite(msg.ttl) ? Math.min(Math.max(msg.ttl, 0), MAX_TTL_MS) : DEFAULT_TTL_MS
    const identity = { host: DEFAULT_HOST, account: await resolveIdentity(), repo: msg.params.repo }
    const key = cache.key([msg.op, msg.params], identity)
    const cached = cache.get(key, ttl)
    if (cached) {
      cacheHits += 1
      send(socket, { id: msg.id, ok: true, cached: true, source: cached.source, payload: cached.payload })
      return
    }
    ghCalls += 1
    const payload = await runGh(args, { skipDaemon: true })
    cache.set(key, payload, { repo: identity.repo, op: msg.op })
    send(socket, { id: msg.id, ok: true, cached: false, payload })
  }

  async function handleMessage(socket, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return deny(socket, null, ERR.MALFORMED, 'malformed message') }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return deny(socket, null, ERR.MALFORMED, 'malformed message')
    }
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
    if (msg.v !== PROTOCOL_VERSION) return deny(socket, id, ERR.VERSION, 'unsupported protocol version')
    msg.id = id

    if (PRIVILEGED_TYPES.has(msg.type)) {
      const code = session ? checkSession(session, msg.auth) : ERR.UNAUTHENTICATED
      if (code) return deny(socket, id, code, 'privileged message denied')
    }

    try {
      switch (msg.type) {
        case 'ping':
        case 'status':
          send(socket, { id, ok: true, status: status() })
          return
        case 'read':
          await handleRead(socket, msg)
          return
        case 'subscribe':
        case 'watch': {
          const event = msg.event || msg.payload?.event || 'pr-state-changed'
          if (typeof event !== 'string' || event.length > 64) throw new ProtocolError(ERR.BAD_PARAMS, 'invalid event')
          bus.subscribe(event, socket)
          send(socket, { id, ok: true, subscribed: event })
          return
        }
        case 'stop':
          send(socket, { id, ok: true })
          shutdown(0)
          return
        case 'invalidate': {
          const repo = msg.repo || msg.payload?.repo || null
          if (repo !== null && typeof repo !== 'string') throw new ProtocolError(ERR.BAD_PARAMS, 'invalid repo')
          cache.invalidate(repo)
          send(socket, { id, ok: true })
          bus.publish('cache-invalidated', { repo })
          return
        }
        case 'revoke':
          session.revoked = true
          try { unlinkSync(tokenPath) } catch { /* ignore */ }
          send(socket, { id, ok: true })
          return
        case 'policy':
        case 'safe-mode':
          // Authenticated, but policy and safe-mode controls are not served here yet.
          throw new ProtocolError(ERR.UNSUPPORTED, `${msg.type} is not supported by this daemon`)
        default:
          throw new ProtocolError(ERR.UNKNOWN_TYPE, 'unknown message type')
      }
    } catch (err) {
      if (err instanceof ProtocolError) deny(socket, id, err.code, err.message)
      else deny(socket, id, ERR.FAILED, 'request failed')
    }
  }

  function status() {
    return {
      pid: process.pid,
      socketPath,
      uptimeMs: Date.now() - startedAt,
      clients: clients.size,
      ghCalls,
      cacheHits,
      protocols: ['ipc', 'mcp', 'gh-cache'],
      protocolVersion: PROTOCOL_VERSION,
    }
  }

  function armIdleShutdown() {
    if (clients.size > 0 || idleTimer) return
    idleTimer = setTimeout(() => shutdown(0), idleMs)
    idleTimer.unref?.()
  }

  function cleanup() {
    try { unlinkSync(pidPath) } catch { /* ignore */ }
    try { unlinkSync(socketPath) } catch { /* ignore */ }
    try { unlinkSync(tokenPath) } catch { /* ignore */ }
  }

  function shutdown(code = 0) {
    cleanup()
    server.close(() => process.exit(code))
  }

  server.listen(socketPath, () => {
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
    session = issueSession(tokenPath)
    writeFileSync(pidPath, String(process.pid), 'utf8')
    process.stdout.write(JSON.stringify({ ok: true, socketPath, pid: process.pid }) + '\n')
    armIdleShutdown()
  })

  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  process.once('exit', cleanup)

  return { server, socketPath, status, shutdown }
}
