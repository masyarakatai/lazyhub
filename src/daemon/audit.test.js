import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditLogPath, hashArgs, writeAuditEntry } from './audit.js'

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('daemon audit log', () => {
  it('throws when the entry cannot be written so callers can fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lazyhub-audit-test-'))
    dirs.push(dir)
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    expect(() => writeAuditEntry({ op: 'pr merge' }, { audit: { path: join(blocker, 'audit.log') } })).toThrow()
  })

  it('hashes argv so payloads never reach the log', () => {
    expect(hashArgs(['pr', 'comment', '1', '--body', 'secret text'])).toMatch(/^[0-9a-f]{16}$/)
  })

  it('writes NDJSON audit entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lazyhub-audit-test-'))
    dirs.push(dir)
    const config = { audit: { path: join(dir, 'audit.log') } }
    writeAuditEntry({ op: 'pr merge', repo: 'owner/repo' }, config)
    const line = readFileSync(auditLogPath(config), 'utf8').trim()
    expect(JSON.parse(line)).toMatchObject({ op: 'pr merge', repo: 'owner/repo' })
  })
})
