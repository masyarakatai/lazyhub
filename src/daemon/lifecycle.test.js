import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonPidPath, daemonSocketPath, ensureSocketDir, removeStaleSocket, requestDaemon } from './lifecycle.js'

const tempDirs = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('daemon lifecycle helpers', () => {
  it('resolves configured unix socket and pid paths', () => {
    const config = {
      daemon: {
        socket_path: '~/.config/lazyhub/test-daemon.sock',
        pid_file: '~/.config/lazyhub/test-daemon.pid',
      },
    }
    expect(daemonSocketPath(config)).toContain('test-daemon.sock')
    expect(daemonPidPath(config)).toContain('test-daemon.pid')
  })

  it('rejects cleanly when no daemon is listening', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.lazyhub-daemon-test-'))
    tempDirs.push(dir)
    const socketPath = join(dir, 'daemon.sock')
    ensureSocketDir(socketPath)
    await expect(requestDaemon(socketPath, { type: 'status', id: 'test' }, 50)).rejects.toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('daemon socket hardening', () => {
  it('rejects a symlinked socket dir and a squatted socket path, and tightens a loose owned dir', () => {
    const root = mkdtempSync(join('/tmp', 'lh-life-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'real'), { mode: 0o755 })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(() => ensureSocketDir(join(root, 'link', 'daemon.sock'))).toThrow(/symlink/)

    ensureSocketDir(join(root, 'real', 'daemon.sock'))
    expect(statSync(join(root, 'real')).mode & 0o777).toBe(0o700)

    const target = join(root, 'victim')
    writeFileSync(target, 'keep')
    symlinkSync(target, join(root, 'real', 'daemon.sock'))
    expect(() => removeStaleSocket(join(root, 'real', 'daemon.sock'))).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('rejects a socket dir owned by another user', () => {
    const root = mkdtempSync(join('/tmp', 'lh-life-'))
    tempDirs.push(root)
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1)
    expect(() => ensureSocketDir(join(root, 'daemon.sock'))).toThrow(/not owned/)
  })
})
