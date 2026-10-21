import { mkdirSync } from 'fs'
import { homedir, userInfo } from 'os'
import { dirname, join } from 'path'
import { connect } from 'net'
import { spawn } from 'child_process'
import {
  PROTOCOL_VERSION, MAX_MESSAGE_BYTES, daemonSpawnEnv, isUntrustedAgentContext, readSessionToken,
} from './protocol.js'
import { assertPrivateDir, prepareSocketPath } from '../secure-fs.js'

function expandHome(path) {
  if (!path) return path
  return path === '~' ? homedir() : path.replace(/^~(?=\/|\\)/, homedir())
}

/**
 * Resolve the daemon endpoint. Unix uses a filesystem socket; Windows uses a
 * named pipe so the rest of the daemon can stay on Node's `net` module.
 *
 * @param {object} config
 */
export function daemonSocketPath(config = {}) {
  if (process.platform === 'win32') {
    const user = userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, '-')
    return `\\\\.\\pipe\\lazyhub-${user}`
  }
  return expandHome(config.daemon?.socket_path || '~/.config/lazyhub/daemon.sock')
}

/**
 * @param {object} config
 */
export function daemonPidPath(config = {}) {
  return expandHome(config.daemon?.pid_file || '~/.config/lazyhub/daemon.pid')
}

/**
 * Session secret file; lives beside the pid file in the user-private daemon dir.
 *
 * @param {object} config
 */
export function daemonTokenPath(config = {}) {
  return join(dirname(daemonPidPath(config)), 'daemon.token')
}

/**
 * Create the socket directory 0700 and verify it is a real directory owned by
 * the current user that is not group/world accessible (throws otherwise).
 * @param {string} socketPath
 */
export function ensureSocketDir(socketPath) {
  if (process.platform === 'win32') return
  const dir = dirname(socketPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivateDir(dir)
}

/**
 * Remove a stale socket left by a crashed daemon. Symlinks, non-sockets and
 * entries owned by another user are squatting and throw instead of being
 * followed or deleted.
 * @param {string} socketPath
 */
export function removeStaleSocket(socketPath) {
  prepareSocketPath(socketPath)
}

/**
 * Send one NDJSON request to the daemon and resolve with the response payload.
 *
 * @param {string} socketPath
 * @param {object} message
 * @param {number} timeoutMs
 * @param {{tokenPath?: string}} [opts] tokenPath attaches the session secret for privileged messages
 */
export function requestDaemon(socketPath, message, timeoutMs = 1000, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const id = message.id || String(Date.now())
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('daemon request timed out'))
    }, timeoutMs)

    socket.on('connect', () => {
      const auth = opts.tokenPath ? readSessionToken(opts.tokenPath) : null
      socket.write(JSON.stringify({ ...message, v: PROTOCOL_VERSION, id, ...(auth ? { auth } : {}) }) + '\n')
    })
    socket.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > MAX_MESSAGE_BYTES * 64) {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error('daemon response too large'))
        return
      }
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.id === id) {
            clearTimeout(timer)
            socket.end()
            if (parsed.error) reject(Object.assign(new Error(parsed.error), { code: parsed.code }))
            else resolve(parsed)
          }
        } catch {
          // Keep waiting for a complete JSON line.
        }
      }
    })
    socket.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    socket.on('close', () => clearTimeout(timer))
  })
}

/**
 * Publish the endpoint (and the path of its session secret, not the secret) to this process.
 *
 * @param {string} socketPath
 * @param {object} config
 */
function exposeDaemon(socketPath, config) {
  process.env.LAZYHUB_DAEMON_SOCKET = socketPath
  process.env.LAZYHUB_DAEMON_TOKEN_FILE = daemonTokenPath(config)
}

/**
 * Ensure a daemon is reachable, spawning one detached when needed.
 *
 * @param {object} config
 * @param {string} entrypoint absolute path to bin/lazyhub.js
 */
export async function ensureDaemon(config = {}, entrypoint) {
  if (process.env.LAZYHUB_NO_DAEMON === '1' || process.env.LAZYHUB_DAEMON_CHILD === '1') return null
  if (config.agent?.auto_spawn_daemon === false) return null
  const socketPath = daemonSocketPath(config)
  try {
    await requestDaemon(socketPath, { type: 'status' }, 150)
    exposeDaemon(socketPath, config)
    return socketPath
  } catch {
    // Spawn below, unless the caller is not a trusted interactive session.
  }
  if (isUntrustedAgentContext()) return null
  const child = spawn(process.execPath, [entrypoint, 'serve', '--json'], {
    detached: true,
    stdio: 'ignore',
    env: daemonSpawnEnv(),
  })
  child.unref()
  for (let i = 0; i < 20; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try {
      await requestDaemon(socketPath, { type: 'status' }, 150)
      exposeDaemon(socketPath, config)
      return socketPath
    } catch {
      // Keep waiting until the short startup window expires.
    }
  }
  return null
}
