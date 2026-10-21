/**
 * src/ai/providers/codex.test.js — Unit tests for the Codex CLI provider.
 *
 * Mocks execFile at the node:child_process level (used by _base.js spawnAndPipe).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detect, complete, id } from './codex.js'
import { cleanupAllIsolated } from './_base.js'
import { AIError } from '../error.js'

// ─── Mock child_process.execFile ─────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

// Import after mock is set up
const childProcess = await import('node:child_process')


// Capture the sandbox as it exists at spawn time (it is removed afterwards).
let snap
function listFiles(root, rel = '') {
  return fs.readdirSync(join(root, rel), { withFileTypes: true }).flatMap(e => {
    const r = join(rel, e.name)
    return e.isDirectory() ? listFiles(root, r) : [r]
  })
}
function snapshot(opts) {
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8)
  const home = opts.env.HOME
  return {
    cwd: opts.cwd, cwdMode: mode(opts.cwd), cwdEntries: fs.readdirSync(opts.cwd),
    root: dirname(opts.cwd), home, homeMode: mode(home), homeFiles: listFiles(home),
    files: Object.fromEntries(listFiles(home).map(rel => [rel, { mode: mode(join(home, rel)), data: fs.readFileSync(join(home, rel), 'utf8') }])),
    env: { ...opts.env },
  }
}

let fakeHome
const SAVED = {}
const TOUCHED = ['HOME', 'TMPDIR', 'GH_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN']

// Real HOME must never matter: tests run against a fake HOME holding a fake login
// plus decoy config the sandbox must not receive.
beforeEach(() => {
  for (const k of TOUCHED) SAVED[k] = process.env[k]
  for (const k of TOUCHED) delete process.env[k]
  fakeHome = fs.mkdtempSync(join(tmpdir(), 'lh-test-home-'))
  fs.mkdirSync(join(fakeHome, '.codex'))
  fs.writeFileSync(join(fakeHome, '.codex', 'auth.json'), '{"fixture":"login"}', { mode: 0o644 })
  fs.writeFileSync(join(fakeHome, '.codex', 'config.toml'), '[mcp_servers.decoy]\n')
  fs.writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'decoy')
  process.env.HOME = fakeHome
  snap = undefined
})
afterEach(() => {
  vi.resetAllMocks()
  cleanupAllIsolated()
  fs.rmSync(fakeHome, { recursive: true, force: true })
  for (const k of TOUCHED) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k] }
})

// Helper: create a fake child process that resolves with the given output
function makeChild(options = {}) {
  const { exitCode = 0, stdout = '', stderr = '', writeError = null } = options

  const stdinMock = {
    write: vi.fn((data, enc, cb) => {
      if (writeError) {
        cb && cb(writeError)
        return
      }
      cb && cb(null)
    }),
    end: vi.fn(),
  }

  const childMock = {
    stdin: stdinMock,
  }

  // execFile callback form
  childProcess.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
    snap = snapshot(_opts)
    // Schedule callback asynchronously so stdin writes can happen first
    setImmediate(() => {
      if (exitCode !== 0) {
        const err = new Error(stderr || 'process exited')
        err.code = exitCode
        callback(err, '', stderr)
      } else {
        callback(null, stdout, '')
      }
    })
    return childMock
  })

  return { stdinMock, childMock }
}

// ─── detect() tests ───────────────────────────────────────────────────────────

describe('detect()', () => {
  afterEach(() => vi.resetAllMocks())

  it('returns available:true when codex --version exits 0', async () => {
    makeChild({ stdout: 'Codex CLI 1.2.3\n' })
    const result = await detect()
    expect(result.available).toBe(true)
    expect(result.version).toBe('Codex CLI 1.2.3')
  })

  it('returns available:false with reason when ENOENT', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('spawn codex ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })
    const result = await detect()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/not found/i)
  })

  it('returns available:false when codex --version exits non-zero', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('failed')
      err.code = 1
      setImmediate(() => cb(err, '', 'error output'))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })
    const result = await detect()
    expect(result.available).toBe(false)
  })
})

// ─── complete() tests ─────────────────────────────────────────────────────────

describe('complete()', () => {
  afterEach(() => vi.resetAllMocks())

  it('sends combined system+user via stdin, not argv', async () => {
    const { stdinMock } = makeChild({
      stdout: JSON.stringify({ type: 'agent_message', message: 'Hello from Codex' }),
    })

    await complete({ system: 'system prompt', user: 'user message' })

    // Verify stdin was written (not argv)
    expect(stdinMock.write).toHaveBeenCalled()
    const writtenContent = stdinMock.write.mock.calls[0][0]
    expect(writtenContent).toContain('system prompt')
    expect(writtenContent).toContain('user message')
  })

  it('argv contains exec, --json, --skip-git-repo-check', async () => {
    makeChild({
      stdout: JSON.stringify({ type: 'agent_message', message: 'response' }),
    })

    await complete({ system: 'sys', user: 'usr' })

    const [_cmd, args] = childProcess.execFile.mock.calls[0]
    expect(args).toContain('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    // Prompt NOT in argv
    expect(args).not.toContain('system prompt')
    expect(args).not.toContain('user message')
  })

  it('parses agent_message events from NDJSON output', async () => {
    const ndjson = [
      JSON.stringify({ type: 'log', message: 'Starting...' }),
      JSON.stringify({ type: 'agent_message', message: 'Hello' }),
      JSON.stringify({ type: 'log', message: 'Processing...' }),
      JSON.stringify({ type: 'agent_message', message: ' World' }),
    ].join('\n')

    makeChild({ stdout: ndjson })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Hello World')
    expect(out.tokensIn).toBeNull()
    expect(out.tokensOut).toBeNull()
  })

  it('ignores non-agent_message events in NDJSON output', async () => {
    const ndjson = [
      JSON.stringify({ type: 'tool_call', name: 'grep' }),
      JSON.stringify({ type: 'agent_message', message: 'Result:' }),
      JSON.stringify({ type: 'tool_result', output: 'data' }),
    ].join('\n')

    makeChild({ stdout: ndjson })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Result:')
  })

  it('throws AIError timeout when process is killed', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('timed out')
      err.killed = true
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('timeout')
    expect(err.provider).toBe(id)
  })

  it('throws AIError spawn-failed on ENOENT', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('spawn codex ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('spawn-failed')
  })

  it('throws AIError auth-required when stderr contains "not logged in"', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('not logged in')
      err.code = 1
      setImmediate(() => cb(err, '', 'error: not logged in'))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('auth-required')
    expect(err.message).toContain('Codex not logged in')
  })

  it('throws AIError malformed-response when no agent_message events found', async () => {
    const ndjson = [
      JSON.stringify({ type: 'log', message: 'Starting...' }),
      JSON.stringify({ type: 'tool_call', name: 'grep' }),
    ].join('\n')

    makeChild({ stdout: ndjson })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
    expect(err.message).toContain('No assistant message')
  })

  it('tolerates unparseable NDJSON lines if there are valid agent_message events', async () => {
    const ndjson = [
      JSON.stringify({ type: 'agent_message', message: 'Hello' }),
      'not valid json at all',
      JSON.stringify({ type: 'agent_message', message: ' World' }),
    ].join('\n')

    makeChild({ stdout: ndjson })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Hello World')
  })


  it('enforces a timeout option', async () => {
    makeChild({
      stdout: JSON.stringify({ type: 'agent_message', message: 'response' }),
    })

    await complete({ system: 'sys', user: 'usr', timeoutMs: 30_000 })

    const [_cmd, _args, opts] = childProcess.execFile.mock.calls[0]
    expect(opts.timeout).toBe(30_000)
  })
})

// ─── Isolation (#252) ─────────────────────────────────────────────────────────

const OK_OUT = JSON.stringify({ type: 'agent_message', message: 'response' })

describe('isolation', () => {
  it('runs in an empty 0700 cwd; only auth.json (0600) reaches the isolated CODEX_HOME', async () => {
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    expect(snap.cwd).not.toBe(process.cwd())
    expect(snap.cwdMode).toBe('700')
    expect(snap.cwdEntries).toEqual([])
    expect(snap.homeMode).toBe('700')
    expect(snap.homeFiles).toEqual([join('.codex', 'auth.json')])  // no config.toml / AGENTS.md
    expect(snap.files[join('.codex', 'auth.json')]).toEqual({ mode: '600', data: '{"fixture":"login"}' })
    expect(snap.env.CODEX_HOME).toBe(join(snap.home, '.codex'))
    expect(snap.env.HOME).toBe(snap.home)
  })

  it('passes a minimal env and the hardening flags; no secrets in argv', async () => {
    Object.assign(process.env, {
      GH_TOKEN: 'ghp-x', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require x',
      ANTHROPIC_API_KEY: 'sk-ant', GEMINI_API_KEY: 'g-key',
    })
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    const names = Object.keys(snap.env)
    for (const n of ['GH_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
      expect(names).not.toContain(n)
    }
    const [, args] = childProcess.execFile.mock.calls[0]
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only']))
    expect(args.join(' ')).not.toContain('login')
  })

  it('prefers CODEX_API_KEY over copying auth.json', async () => {
    process.env.CODEX_API_KEY = 'codex-key-fixture'
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    expect(snap.env.CODEX_API_KEY).toBe('codex-key-fixture')
    expect(snap.homeFiles).toEqual([])
  })

  it('honours CODEX_HOME inside HOME and still copies only auth.json', async () => {
    fs.mkdirSync(join(fakeHome, 'alt'))
    fs.writeFileSync(join(fakeHome, 'alt', 'auth.json'), '{"alt":1}')
    fs.writeFileSync(join(fakeHome, 'alt', 'config.toml'), 'decoy')
    process.env.CODEX_HOME = join(fakeHome, 'alt')
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    expect(snap.homeFiles).toEqual([join('.codex', 'auth.json')])
    expect(snap.files[join('.codex', 'auth.json')].data).toBe('{"alt":1}')
  })

  const outcomes = {
    success:            () => makeChild({ stdout: OK_OUT }),
    'malformed output': () => makeChild({ stdout: 'garbage' }),
    'auth failure':     () => makeChild({ exitCode: 1, stderr: 'not logged in' }),
    timeout:            () => childProcess.execFile.mockImplementation((_c, _a, o, cb) => {
      snap = snapshot(o)
      const err = new Error('timed out'); err.killed = true; err.signal = 'SIGTERM'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    }),
    'killed by signal': () => childProcess.execFile.mockImplementation((_c, _a, o, cb) => {
      snap = snapshot(o)
      const err = new Error('killed'); err.signal = 'SIGKILL'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    }),
  }
  for (const [name, arrange] of Object.entries(outcomes)) {
    it(`removes the sandbox (including the copied credential) after ${name}`, async () => {
      arrange()
      await complete({ system: 'sys', user: 'usr' }).catch(() => {})
      expect(fs.existsSync(snap.root)).toBe(false)
    })
  }

  it('is unavailable (no spawn) when there is no API key and no auth.json', async () => {
    fs.rmSync(join(fakeHome, '.codex', 'auth.json'))
    makeChild({ stdout: 'codex-cli 1.0\n' })

    const status = await detect()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/codex login|CODEX_API_KEY/)

    childProcess.execFile.mockClear()
    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err.code).toBe('auth-required')
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('refuses a symlinked auth.json (treated as no credential)', async () => {
    fs.rmSync(join(fakeHome, '.codex', 'auth.json'))
    fs.writeFileSync(join(fakeHome, 'elsewhere'), 'secret')
    fs.symlinkSync(join(fakeHome, 'elsewhere'), join(fakeHome, '.codex', 'auth.json'))
    makeChild({ stdout: OK_OUT })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err.code).toBe('auth-required')
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('is unavailable (no spawn) when the sandbox cannot be created', async () => {
    process.env.TMPDIR = join(fakeHome, 'does-not-exist')
    makeChild({ stdout: OK_OUT })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('provider-unavailable')
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })
})
