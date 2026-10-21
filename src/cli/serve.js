import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon/server.js'
import { daemonSocketPath, daemonTokenPath, requestDaemon } from '../daemon/lifecycle.js'

/**
 * CLI entry point for `lazyhub serve`.
 *
 * @param {string[]} argv
 */
export async function runServe(argv = []) {
  process.env.LAZYHUB_DAEMON_CHILD = '1'
  const config = loadConfig()
  const socketPath = daemonSocketPath(config)
  const json = argv.includes('--json')

  if (argv.includes('--status')) {
    try {
      const res = await requestDaemon(socketPath, { type: 'status' })
      const body = res.status || {}
      process.stdout.write(json ? `${JSON.stringify(body, null, 2)}\n` : `lazyhub daemon running pid=${body.pid} clients=${body.clients} socket=${body.socketPath}\n`)
      return 0
    } catch (err) {
      const body = { running: false, socketPath, error: err.message }
      process.stdout.write(json ? `${JSON.stringify(body, null, 2)}\n` : `lazyhub daemon not running (${err.message})\n`)
      return 1
    }
  }

  if (argv.includes('--stop')) {
    try {
      await requestDaemon(socketPath, { type: 'stop' }, 1000, { tokenPath: daemonTokenPath(config) })
      process.stdout.write(json ? `${JSON.stringify({ ok: true })}\n` : 'lazyhub daemon stopped\n')
      return 0
    } catch (err) {
      process.stderr.write(`lazyhub daemon stop failed: ${err.message}\n`)
      return 1
    }
  }

  startDaemon(config)
  return new Promise(() => {})
}
