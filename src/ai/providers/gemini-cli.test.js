/**
 * src/ai/providers/gemini-cli.test.js — Unit tests for the Gemini CLI provider.
 *
 * Mocks execFile at the node:child_process level (used by _base.js spawnAndPipe).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detect, complete, id } from './gemini-cli.js'
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

// Real HOME must never matter: tests run against a fake HOME holding a real-looking
// login plus decoy config the sandbox must never receive.
beforeEach(() => {
  for (const k of TOUCHED) SAVED[k] = process.env[k]
  for (const k of TOUCHED) delete process.env[k]
  fakeHome = fs.mkdtempSync(join(tmpdir(), 'lh-test-home-'))
  fs.mkdirSync(join(fakeHome, '.gemini'))
  fs.writeFileSync(join(fakeHome, '.gemini', 'oauth_creds.json'), '{"fixture":"login"}', { mode: 0o644 })  // must never be copied
  process.env.GEMINI_API_KEY = 'gem-key-fixture'
  fs.writeFileSync(join(fakeHome, '.gemini', 'settings.json'), '{"mcpServers":{"decoy":{}}}')
  fs.writeFileSync(join(fakeHome, '.gemini', 'GEMINI.md'), 'decoy')
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

  it('returns available:true when gemini --version exits 0', async () => {
    makeChild({ stdout: 'Gemini CLI 2.0.1\n' })
    const result = await detect()
    expect(result.available).toBe(true)
    expect(result.version).toBe('Gemini CLI 2.0.1')
  })

  it('returns available:false with reason when ENOENT', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('spawn gemini ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })
    const result = await detect()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/not found/i)
  })

  it('returns available:false when gemini --version exits non-zero', async () => {
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
      stdout: JSON.stringify({ response: { text: 'Hello from Gemini' } }),
    })

    await complete({ system: 'system prompt', user: 'user message' })

    // Verify stdin was written (not argv)
    expect(stdinMock.write).toHaveBeenCalled()
    const writtenContent = stdinMock.write.mock.calls[0][0]
    expect(writtenContent).toContain('system prompt')
    expect(writtenContent).toContain('user message')
  })

  it('argv contains -p, -, --output-format json', async () => {
    makeChild({
      stdout: JSON.stringify({ response: { text: 'response' } }),
    })

    await complete({ system: 'sys', user: 'usr' })

    const [_cmd, args] = childProcess.execFile.mock.calls[0]
    expect(args).toContain('-p')
    expect(args).toContain('-')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    // Prompt NOT in argv
    expect(args).not.toContain('system prompt')
    expect(args).not.toContain('user message')
  })

  it('parses response.text from JSON output', async () => {
    makeChild({
      stdout: JSON.stringify({ response: { text: 'Hello from Gemini' } }),
    })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Hello from Gemini')
    expect(out.tokensIn).toBeNull()
    expect(out.tokensOut).toBeNull()
  })

  it('parses candidates[0].content.parts[0].text as fallback', async () => {
    makeChild({
      stdout: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Fallback response text' },
              ],
            },
          },
        ],
      }),
    })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Fallback response text')
  })

  it('prefers response.text over candidates format', async () => {
    makeChild({
      stdout: JSON.stringify({
        response: { text: 'Primary format' },
        candidates: [
          {
            content: {
              parts: [
                { text: 'Fallback format' },
              ],
            },
          },
        ],
      }),
    })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe('Primary format')
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
      const err = new Error('spawn gemini ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('spawn-failed')
  })

  it('throws AIError auth-required when stderr contains "unauthenticated"', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('unauthenticated')
      err.code = 1
      setImmediate(() => cb(err, '', 'error: unauthenticated'))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('auth-required')
    expect(err.message).toContain('GEMINI_API_KEY')
  })

  it('throws AIError malformed-response on non-JSON output', async () => {
    makeChild({ stdout: 'not valid json at all' })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
  })

  it('throws AIError malformed-response when no text field found', async () => {
    makeChild({
      stdout: JSON.stringify({ response: {} }),
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
    expect(err.message).toContain('assistant text')
  })

  it('throws AIError malformed-response when text is not a string', async () => {
    makeChild({
      stdout: JSON.stringify({ response: { text: 123 } }),
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
    expect(err.message).toContain('Unexpected')
  })

  it('enforces a timeout option', async () => {
    makeChild({
      stdout: JSON.stringify({ response: { text: 'response' } }),
    })

    await complete({ system: 'sys', user: 'usr', timeoutMs: 30_000 })

    const [_cmd, _args, opts] = childProcess.execFile.mock.calls[0]
    expect(opts.timeout).toBe(30_000)
  })
})

// ─── Isolation (#252) ─────────────────────────────────────────────────────────

const OK_OUT = JSON.stringify({ response: { text: 'response' } })

describe('isolation', () => {
  it('runs in an empty 0700 cwd with an empty isolated HOME; no file from the real HOME is copied', async () => {
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    expect(snap.cwd).not.toBe(process.cwd())
    expect(snap.cwdMode).toBe('700')
    expect(snap.cwdEntries).toEqual([])
    expect(snap.homeMode).toBe('700')
    expect(snap.homeFiles).toEqual([])  // no oauth_creds.json (refresh risk), settings.json, GEMINI.md
    expect(snap.env.GEMINI_API_KEY).toBe('gem-key-fixture')
    expect(snap.env.GEMINI_CLI_HOME).toBe(snap.home)
    expect(snap.env.HOME).toBe(snap.home)
    expect(snap.env.GOOGLE_GENAI_USE_GCA).toBeUndefined()
  })

  it('passes a minimal env and the hardening flags; no secrets in argv', async () => {
    Object.assign(process.env, {
      GH_TOKEN: 'ghp-x', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require x',
      ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-o', CODEX_API_KEY: 'c-key',
    })
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    const names = Object.keys(snap.env)
    for (const n of ['GH_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
      expect(names).not.toContain(n)
    }
    const [, args] = childProcess.execFile.mock.calls[0]
    expect(args).toEqual(expect.arrayContaining(['--approval-mode', 'plan', '--extensions', 'none', '--skip-trust']))
    expect(args.join(' ')).not.toContain('login')
  })

  const outcomes = {
    success:            () => makeChild({ stdout: OK_OUT }),
    'malformed output': () => makeChild({ stdout: 'garbage' }),
    'auth failure':     () => makeChild({ exitCode: 1, stderr: 'unauthenticated' }),
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
    it(`removes the sandbox after ${name}`, async () => {
      arrange()
      await complete({ system: 'sys', user: 'usr' }).catch(() => {})
      expect(fs.existsSync(snap.root)).toBe(false)
    })
  }

  it('is unavailable (no spawn) without an API key, even with a Google-login oauth_creds.json present', async () => {
    delete process.env.GEMINI_API_KEY
    makeChild({ stdout: '0.65.0\n' })

    const status = await detect()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/unavailable: set GEMINI_API_KEY/)

    childProcess.execFile.mockClear()
    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err.code).toBe('auth-required')
    expect(err.message).toMatch(/GEMINI_API_KEY/)
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
