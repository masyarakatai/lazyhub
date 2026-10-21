import { createHash } from 'crypto'
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
 * Write one NDJSON audit entry for a state-changing operation. Throws when the
 * entry cannot be durably written: callers must treat that as a block (D8/D11).
 *
 * @param {object} entry
 * @param {object} config
 */
export function writeAuditEntry(entry, config = {}) {
  const path = auditLogPath(config)
  ensurePrivateDir(dirname(path))
  rotateAuditLog(path)
  appendPrivateFile(path, JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...entry,
  }) + '\n')
}

/**
 * Stable digest of a gh argv, so audit entries never carry payloads.
 *
 * @param {string[]} args
 */
export function hashArgs(args = []) {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)
}
