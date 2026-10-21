import { existsSync, renameSync, statSync } from 'fs'
import { dirname } from 'path'
import { homedir } from 'os'
import { appendPrivateFile, ensurePrivateDir } from '../secure-fs.js'

const MAX_AUDIT_BYTES = 10 * 1024 * 1024

function expandHome(path) {
  return path === '~' ? homedir() : String(path || '').replace(/^~(?=\/|\\)/, homedir())
}

/**
 * Resolve the audit log path from config.
 *
 * @param {object} config
 */
export function auditLogPath(config = {}) {
  return expandHome(config.audit?.path || config.agent?.audit_log_path || '~/.config/lazyhub/audit.log')
}

/**
 * Rotate audit logs at 10 MB, keeping the last three files.
 *
 * @param {string} path
 */
function rotateAuditLog(path) {
  if (!existsSync(path)) return
  try {
    if (statSync(path).size < MAX_AUDIT_BYTES) return
    for (let i = 3; i >= 1; i -= 1) {
      const from = i === 1 ? path : `${path}.${i - 1}`
      const to = `${path}.${i}`
      if (existsSync(from)) renameSync(from, to)
    }
  } catch {
    // Audit must never break user actions.
  }
}

/**
 * Write one NDJSON audit entry for a state-changing operation.
 *
 * @param {object} entry
 * @param {object} config
 */
export function writeAuditEntry(entry, config = {}) {
  const path = auditLogPath(config)
  try {
    ensurePrivateDir(dirname(path))
    rotateAuditLog(path)
    appendPrivateFile(path, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    }) + '\n')
  } catch {
    // Audit logging is best-effort; commands keep their original behavior.
  }
}

/**
 * Return true when gh args represent a state-changing operation.
 *
 * @param {string[]} args
 */
export function isGhMutation(args = []) {
  if (args.includes('--method')) {
    const method = args[args.indexOf('--method') + 1]
    if (method && method !== 'GET') return true
  }
  const [group, cmd] = args
  return [
    'merge', 'close', 'ready', 'review', 'comment', 'create', 'edit',
  ].includes(cmd) || (group === 'gist' && cmd === 'delete') || (group === 'run' && ['rerun', 'cancel'].includes(cmd))
}
