/**
 * src/ai/providers/claude-code.test.js — Unit tests for the Claude Code CLI provider.
 *
 * Mocks execFile at the node:child_process level (used by _base.js spawnAndPipe).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detect, complete, id } from './claude-code.js'
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

// Real HOME must never matter: tests run against a fake HOME and explicit auth env.
beforeEach(() => {
  for (const k of TOUCHED) SAVED[k] = process.env[k]
  for (const k of TOUCHED) delete process.env[k]
  fakeHome = fs.mkdtempSync(join(tmpdir(), 'lh-test-home-'))
  fs.mkdirSync(join(fakeHome, '.claude'))
  fs.writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{"hooks":{}}')
  process.env.HOME = fakeHome
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-fixture'
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
        // simulate write error
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

  it('returns available:true when claude --version exits 0', async () => {
    makeChild({ stdout: 'Claude CLI 1.0.5\n' })
    const result = await detect()
    expect(result.available).toBe(true)
    expect(result.version).toBe('Claude CLI 1.0.5')
  })

  it('returns available:false with reason when ENOENT', async () => {
    childProcess.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('spawn claude ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })
    const result = await detect()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/not found/i)
  })

  it('returns available:false when claude --version exits non-zero', async () => {
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
    const reviewText = JSON.stringify({
      summary: 'Looks good',
      suggestions: [],
    })
    const { stdinMock } = makeChild({
      stdout: JSON.stringify({ type: 'result', result: reviewText }),
    })

    await complete({ system: 'system prompt', user: 'user message', model: 'claude-test' })

    // Verify stdin was written (not argv)
    expect(stdinMock.write).toHaveBeenCalled()
    const writtenContent = stdinMock.write.mock.calls[0][0]
    expect(writtenContent).toContain('system prompt')
    expect(writtenContent).toContain('user message')
  })

  it('argv contains -p, --output-format json, --max-turns 1, --model', async () => {
    makeChild({
      stdout: JSON.stringify({ type: 'result', result: '{"summary":"ok","suggestions":[]}' }),
    })

    await complete({ system: 'sys', user: 'usr', model: 'claude-model-x' })

    const [_cmd, args] = childProcess.execFile.mock.calls[0]
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args).toContain('--max-turns')
    expect(args).toContain('1')
    expect(args).toContain('--model')
    expect(args).toContain('claude-model-x')
    // Prompt NOT in argv
    expect(args).not.toContain('system prompt')
    expect(args).not.toContain('user message')
  })

  it('parses result field from JSON output', async () => {
    const assistantText = '{"summary":"Nice work","suggestions":[]}'
    makeChild({
      stdout: JSON.stringify({ type: 'result', result: assistantText }),
    })

    const out = await complete({ system: 'sys', user: 'usr' })
    expect(out.text).toBe(assistantText)
    expect(out.tokensIn).toBeNull()
    expect(out.tokensOut).toBeNull()
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
      const err = new Error('spawn claude ENOENT')
      err.code = 'ENOENT'
      setImmediate(() => cb(err, '', ''))
      return { stdin: { write: vi.fn(), end: vi.fn() } }
    })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('spawn-failed')
  })

  it('throws AIError malformed-response on non-JSON output', async () => {
    makeChild({ stdout: 'not valid json at all' })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
  })

  it('throws AIError malformed-response when result field is missing', async () => {
    makeChild({ stdout: JSON.stringify({ type: 'result', noResultField: true }) })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('malformed-response')
  })

  it('throws AIError auth-required when the CLI reports an invalid credential', async () => {
    makeChild({ stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Invalid API key' }) })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('auth-required')
  })

  it('maps a non-auth is_error:true result (exit 0) to provider-unavailable, not success', async () => {
    makeChild({ stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 500, result: 'Overloaded' }) })

    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err).toBeInstanceOf(AIError)
    expect(err.code).toBe('provider-unavailable')
  })

  it('enforces a timeout option', async () => {
    makeChild({
      stdout: JSON.stringify({ type: 'result', result: '{"summary":"ok","suggestions":[]}' }),
    })

    await complete({ system: 'sys', user: 'usr', timeoutMs: 30_000 })

    const [_cmd, _args, opts] = childProcess.execFile.mock.calls[0]
    expect(opts.timeout).toBe(30_000)
  })
})

// ─── Isolation (#252) ─────────────────────────────────────────────────────────

const OK_OUT = JSON.stringify({ type: 'result', result: '{"summary":"ok","suggestions":[]}' })

describe('isolation', () => {
  it('runs in an empty 0700 temp cwd with an empty 0700 throwaway HOME, never the repo or real HOME', async () => {
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    expect(snap.cwd).not.toBe(process.cwd())
    expect(snap.cwd.startsWith(tmpdir()) || snap.cwd.startsWith(fs.realpathSync(tmpdir()))).toBe(true)
    expect(snap.cwdMode).toBe('700')
    expect(snap.cwdEntries).toEqual([])
    expect(snap.home).not.toBe(fakeHome)
    expect(snap.homeMode).toBe('700')
    expect(snap.homeFiles).toEqual([])  // real ~/.claude/settings.json is not exposed
  })

  it('passes a minimal env: only PATH/USER/LANG + isolated HOME + the one auth var', async () => {
    Object.assign(process.env, {
      GH_TOKEN: 'ghp-x', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require x',
      OPENAI_API_KEY: 'sk-o', GEMINI_API_KEY: 'g-key', CODEX_API_KEY: 'c-key',
    })
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    const names = Object.keys(snap.env)
    for (const n of ['GH_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(names).not.toContain(n)
    }
    expect(snap.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-fixture')
    expect(snap.env.HOME).toBe(snap.home)
    expect(snap.env.PATH).toBeDefined()
  })

  it('hardening flags are passed; prompt and credentials are never in argv', async () => {
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    const [, args] = childProcess.execFile.mock.calls[0]
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']))
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', ''])
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', ''])
    expect(args.join(' ')).not.toContain('oauth-token-fixture')
    expect(args).not.toContain('--bare')  // OAuth token auth is not available under --bare
  })

  it('uses --bare when authenticating with ANTHROPIC_API_KEY', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture'
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })

    const [, args] = childProcess.execFile.mock.calls[0]
    expect(args).toContain('--bare')
    expect(snap.env.ANTHROPIC_API_KEY).toBe('sk-ant-fixture')
    expect(snap.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  const outcomes = {
    success:          () => makeChild({ stdout: OK_OUT }),
    'malformed output': () => makeChild({ stdout: 'not json' }),
    'auth failure':   () => makeChild({ exitCode: 1, stderr: 'not logged in' }),
    timeout:          () => childProcess.execFile.mockImplementation((_c, _a, o, cb) => {
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
      expect(snap.root).toBeDefined()
      expect(fs.existsSync(snap.root)).toBe(false)
    })
  }

  it('removes the sandbox and kills the child when the parent is terminated mid-run', async () => {
    const kill = vi.fn()
    childProcess.execFile.mockImplementation((_c, _a, o) => {
      snap = snapshot(o)
      return { stdin: { write: vi.fn((d, e, cb) => cb && cb(null)), end: vi.fn() }, kill }  // never completes
    })
    const pending = complete({ system: 'sys', user: 'usr' }).catch(e => e)
    await vi.waitFor(() => expect(snap).toBeDefined())
    expect(fs.existsSync(snap.root)).toBe(true)

    cleanupAllIsolated()  // what the exit/SIGINT/SIGTERM hooks run

    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(fs.existsSync(snap.root)).toBe(false)
    void pending
  })

  it('is unavailable (no spawn) when no credential is configured', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    makeChild({ stdout: 'Claude CLI 1.0.5\n' })

    const status = await detect()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/claude setup-token.*CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/)

    childProcess.execFile.mockClear()
    const err = await complete({ system: 'sys', user: 'usr' }).catch(e => e)
    expect(err.code).toBe('auth-required')
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it('registers process exit/signal hooks once, not per call', async () => {
    const count = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(e => process.listenerCount(e))
    makeChild({ stdout: OK_OUT })
    await complete({ system: 'sys', user: 'usr' })
    const after1 = count()
    for (let i = 0; i < 12; i++) await complete({ system: 'sys', user: 'usr' })
    expect(count()).toEqual(after1)
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
