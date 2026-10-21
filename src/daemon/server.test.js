import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../executor/core.js', () => ({
  runGh: vi.fn(async args => (args[0] === 'api' ? 'octocat' : [{ number: 1 }])),
}))

const dirs = []
let daemon
let ctx

beforeEach(() => {
  process.env.LAZYHUB_CACHE_DIR = mkdtempSync(join(tmpdir(), 'lh-c-'))
  dirs.push(process.env.LAZYHUB_CACHE_DIR)
})
afterEach(async () => {
  await new Promise(resolve => (daemon ? daemon.server.close(resolve) : resolve()))
  daemon = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.LAZYHUB_CACHE_DIR
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'lh-d-'))
  dirs.push(dir)
  const config = { daemon: { socket_path: join(dir, 's.sock'), pid_file: join(dir, 'd.pid') } }
  const { startDaemon } = await import('./server.js')
  daemon = startDaemon(config, { PATH: '/bin' })
  await new Promise(resolve => daemon.server.once('listening', resolve))
  return { tokenPath: join(dir, 'daemon.token'), socketPath: join(dir, 's.sock') }
}

function rawExchange(socketPath, payload) {
  return new Promise(resolve => {
    const socket = connect(socketPath)
    let data = ''
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => {
      data += chunk.toString()
      if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data.split('\n')[0])) }
    })
    socket.on('close', () => resolve(data ? JSON.parse(data.split('\n')[0]) : null))
  })
}
const msg = o => rawExchange(ctx.socketPath, JSON.stringify({ v: 1, id: 'x', ...o }) + '\n')

describe('daemon IPC', () => {
  beforeEach(async () => { ctx = await boot() })

  it('writes the session secret to a private file', () => {
    expect(statSync(ctx.tokenPath).mode & 0o077).toBe(0)
  })

  it('denies arbitrary gh passthrough', async () => {
    expect(await msg({ type: 'gh', args: ['auth', 'token'] })).toMatchObject({ ok: false, code: 'E_UNKNOWN_TYPE' })
  })

  it('denies unauthenticated and wrongly authenticated privileged messages', async () => {
    for (const type of ['stop', 'invalidate', 'policy', 'safe-mode']) {
      expect(await msg({ type })).toMatchObject({ code: 'E_UNAUTHENTICATED' })
      expect(await msg({ type, auth: 'wrong' })).toMatchObject({ code: 'E_UNAUTHENTICATED' })
    }
  })

  it('serves authenticated control messages and then honors revocation', async () => {
    const auth = readFileSync(ctx.tokenPath, 'utf8')
    expect(await msg({ type: 'invalidate', auth })).toMatchObject({ ok: true })
    expect(await msg({ type: 'policy', auth })).toMatchObject({ code: 'E_UNSUPPORTED' })
    expect(await msg({ type: 'revoke', auth })).toMatchObject({ ok: true })
    expect(await msg({ type: 'invalidate', auth })).toMatchObject({ code: 'E_AUTH_REVOKED' })
  })

  it('rotates an expired secret so stop keeps working with the fresh token file', async () => {
    const stale = readFileSync(ctx.tokenPath, 'utf8')
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 13 * 3600_000)
    try {
      expect(await msg({ type: 'invalidate', auth: stale })).toMatchObject({ code: 'E_UNAUTHENTICATED' })
      const fresh = readFileSync(ctx.tokenPath, 'utf8')
      expect(fresh).not.toBe(stale)
      expect(await msg({ type: 'invalidate', auth: fresh })).toMatchObject({ ok: true })
    } finally { spy.mockRestore() }
  })

  it('fails closed on malformed, version-mismatched, and oversized messages', async () => {
    expect(await rawExchange(ctx.socketPath, 'not json\n')).toMatchObject({ code: 'E_MALFORMED' })
    expect(await rawExchange(ctx.socketPath, '[1]\n')).toMatchObject({ code: 'E_MALFORMED' })
    expect(await rawExchange(ctx.socketPath, JSON.stringify({ id: 1, type: 'status' }) + '\n')).toMatchObject({ code: 'E_VERSION' })
    expect(await msg({ v: 99, type: 'status' })).toMatchObject({ code: 'E_VERSION' })
    expect(await rawExchange(ctx.socketPath, 'x'.repeat(70 * 1024))).toMatchObject({ code: 'E_TOO_LARGE' })
  })

  it('serves typed reads from cache and rejects bad params', async () => {
    const read = { type: 'read', op: 'pr.view', params: { repo: 'o/r', number: 1, fields: 'number' } }
    expect(await msg(read)).toMatchObject({ ok: true, cached: false, payload: [{ number: 1 }] })
    expect(await msg(read)).toMatchObject({ ok: true, cached: true })
    expect(await msg({ ...read, params: { ...read.params, repo: '../x' } })).toMatchObject({ code: 'E_BAD_PARAMS' })
    expect(await msg({ type: 'read', op: 'api.graphql', params: {} })).toMatchObject({ code: 'E_UNKNOWN_OP' })
  })
})

describe('daemon startup', () => {
  it('refuses to start with inherited NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=64'
    try {
      const { startDaemon } = await import('./server.js')
      expect(() => startDaemon({}, process.env)).toThrow(/NODE_OPTIONS/)
    } finally { delete process.env.NODE_OPTIONS }
  })
})
