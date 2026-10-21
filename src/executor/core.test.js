import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../daemon/lifecycle.js', () => ({ requestDaemon: vi.fn() }))
vi.mock('../daemon/audit.js', () => ({ writeAuditEntry: vi.fn(), hashArgs: vi.fn(() => 'h') }))
vi.mock('../cache.js', () => ({ invalidateRepoCache: vi.fn() }))

import { execa } from 'execa'
import { requestDaemon } from '../daemon/lifecycle.js'
import { writeAuditEntry } from '../daemon/audit.js'
import { invalidateRepoCache } from '../cache.js'
import { runGh, GhError, getGhCallHistory } from './core.js'

const ok = (stdout = '[]') => ({ exitCode: 0, stdout, stderr: '' })
const WRITE = ['pr', 'merge', '7', '--repo', 'o/r']
const TYPED_READ = ['pr', 'diff', '7', '--repo', 'o/r']

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.GH_HOST
  process.env.LAZYHUB_DAEMON_SOCKET = '/nonexistent/daemon.sock'
  execa.mockResolvedValue(ok())
  requestDaemon.mockRejectedValue(new Error('daemon gone'))
})

describe('runGh fail-closed write handling', () => {
  it('refuses unknown operations without spawning gh', async () => {
    await expect(runGh(['repo', 'delete', 'o/r'])).rejects.toBeInstanceOf(GhError)
    expect(execa).not.toHaveBeenCalled()
    expect(writeAuditEntry).not.toHaveBeenCalled()
  })

  it('blocks a write when the audit intent cannot be recorded', async () => {
    writeAuditEntry.mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(runGh(WRITE)).rejects.toThrow(/audit log unavailable/)
    expect(execa).not.toHaveBeenCalled()
  })

  it('audits intent before and result after a write, then drops cached reads', async () => {
    await runGh(WRITE)
    expect(writeAuditEntry.mock.calls.map(c => c[0].phase)).toEqual(['intent', 'result'])
    expect(writeAuditEntry.mock.calls[1][0].outcome).toBe('ok')
    expect(invalidateRepoCache).toHaveBeenCalledWith('o/r')
  })

  it('tells the daemon to drop its cache after a write, authenticated; a failure is logged, not thrown', async () => {
    process.env.LAZYHUB_DAEMON_TOKEN_FILE = '/nonexistent/daemon.token'
    requestDaemon.mockResolvedValueOnce({ ok: true })
    await runGh(WRITE)
    expect(requestDaemon).toHaveBeenCalledWith(
      '/nonexistent/daemon.sock', { type: 'invalidate', repo: 'o/r' }, 2000, { tokenPath: '/nonexistent/daemon.token' },
    )
    requestDaemon.mockRejectedValueOnce(new Error('denied'))
    await expect(runGh(WRITE)).resolves.toEqual([])
    expect(getGhCallHistory().at(-1).error).toMatch(/invalidate failed: denied/)
    delete process.env.LAZYHUB_DAEMON_TOKEN_FILE
  })

  it('does not audit reads, so an unavailable audit log never blocks them', async () => {
    writeAuditEntry.mockImplementation(() => { throw new Error('disk full') })
    await expect(runGh(['pr', 'list', '--repo', 'o/r'])).resolves.toEqual([])
    expect(writeAuditEntry).not.toHaveBeenCalled()
  })

  it('never sends a write to the daemon as a read or retries it after daemon loss or failure', async () => {
    execa.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' })
    await expect(runGh(WRITE)).rejects.toBeInstanceOf(GhError)
    expect(requestDaemon.mock.calls.filter(c => c[1].type === 'read')).toEqual([])
    expect(execa).toHaveBeenCalledTimes(1)
    expect(writeAuditEntry.mock.calls[1][0].outcome).toBe('error')
  })

  it('falls back to direct gh only for allowlisted reads when the daemon is gone', async () => {
    await expect(runGh(TYPED_READ)).resolves.toEqual([])
    expect(requestDaemon).toHaveBeenCalledTimes(1)
    expect(execa).toHaveBeenCalledTimes(1)
  })
})
