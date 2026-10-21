import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.LAZYHUB_CACHE_DIR
})

describe('daemon cache', () => {
  it('serves memory hits and invalidates by repo', async () => {
    vi.resetModules()
    const dir = mkdtempSync(join(tmpdir(), 'lazyhub-daemon-cache-test-'))
    dirs.push(dir)
    process.env.LAZYHUB_CACHE_DIR = dir
    const { DaemonCache } = await import('./cache.js')
    const cache = new DaemonCache()
    const key = cache.key(['gh', ['pr', 'list']])
    cache.set(key, [{ number: 1 }], { repo: 'owner/repo', op: 'issue.list' })
    expect(cache.get(key)?.payload).toEqual([{ number: 1 }])
    cache.invalidate('owner/repo')
    expect(cache.get(key)).toBeNull()
  })

  it('only caches allowlisted ops and keeps keys distinct per op, params, and identity', async () => {
    vi.resetModules()
    const dir = mkdtempSync(join(tmpdir(), 'lazyhub-daemon-cache-test-'))
    dirs.push(dir)
    process.env.LAZYHUB_CACHE_DIR = dir
    const { DaemonCache } = await import('./cache.js')
    const cache = new DaemonCache()
    const me = { host: 'github.com', account: 'a', repo: 'o/r' }
    const keys = new Set([
      cache.key(['pr.view', { number: 1 }], me),
      cache.key(['pr.diff', { number: 1 }], me),
      cache.key(['pr.view', { number: 2 }], me),
      cache.key(['pr.view', { number: 1 }], { ...me, account: 'b' }),
    ])
    expect(keys.size).toBe(4)
    for (const op of ['pr.merge', 'api.graphql', undefined]) {
      expect(() => cache.set(cache.key([op]), { ok: true }, { op, repo: 'o/r' })).toThrow(/non-allowlisted/)
    }
    expect(cache.get(cache.key(['pr.merge']))).toBeNull()
  })
})
