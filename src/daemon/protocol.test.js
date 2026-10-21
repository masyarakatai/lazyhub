import { describe, expect, it } from 'vitest'
import {
  ERR, buildReadArgs, checkSession, classifyGh, daemonSpawnEnv, isUntrustedAgentContext, toTypedRead, unsafeDaemonEnv,
} from './protocol.js'

describe('typed reads', () => {
  it('round-trips the executor argv shapes it accepts', () => {
    const args = ['issue', 'list', '--repo', 'o/r', '--limit', '50', '--state', 'open', '--json', 'number,title']
    const typed = toTypedRead(args, {})
    expect(typed?.op).toBe('issue.list')
    expect(buildReadArgs(typed.op, typed.params)).toEqual(args)
    expect(toTypedRead(['pr', 'view', '7', '--repo', 'o/r', '--json', 'number'], {})?.params.number).toBe(7)
  })

  it('refuses argv that is not an allowlisted read', () => {
    expect(toTypedRead(['api', 'graphql', '-f', 'query=x'], {})).toBeNull()
    expect(toTypedRead(['pr', 'merge', '7', '--repo', 'o/r'], {})).toBeNull()
    expect(toTypedRead(['pr', 'view', '7', '--repo', 'o/r', '--json', 'number', '--web'], {})).toBeNull()
  })

  it('keeps callers with their own token or host on direct gh', () => {
    const args = ['pr', 'diff', '7', '--repo', 'o/r']
    expect(toTypedRead(args, {})).not.toBeNull()
    expect(toTypedRead(args, { GH_TOKEN: 'x' })).toBeNull()
    expect(toTypedRead(args, { GH_CONFIG_DIR: '/other' })).toBeNull()
    expect(toTypedRead(args, { GH_HOST: 'ghe.example.com' })).toBeNull()
  })

  it('rejects unknown ops, unexpected params, and flag-shaped values', () => {
    expect(() => buildReadArgs('gh', {})).toThrow(expect.objectContaining({ code: ERR.UNKNOWN_OP }))
    expect(() => buildReadArgs('pr.diff', { repo: 'o/r', number: 1, extra: 1 })).toThrow(expect.objectContaining({ code: ERR.BAD_PARAMS }))
    expect(() => buildReadArgs('pr.diff', { repo: 'o/r/../x', number: 1 })).toThrow(expect.objectContaining({ code: ERR.BAD_PARAMS }))
    expect(() => buildReadArgs('issue.list', { repo: 'o/r', limit: 5, fields: 'number', label: '--web' })).toThrow(expect.objectContaining({ code: ERR.BAD_PARAMS }))
  })
})

describe('sessions', () => {
  const session = { token: 'abc', expiresAt: 1000, revoked: false }
  it('accepts only the matching, unexpired, unrevoked secret', () => {
    expect(checkSession(session, 'abc', 10)).toBeNull()
    expect(checkSession(session, 'abd', 10)).toBe(ERR.UNAUTHENTICATED)
    expect(checkSession(session, undefined, 10)).toBe(ERR.UNAUTHENTICATED)
    expect(checkSession(session, 'abc', 2000)).toBe(ERR.AUTH_EXPIRED)
    expect(checkSession({ ...session, revoked: true }, 'abc', 10)).toBe(ERR.AUTH_REVOKED)
  })
})

describe('daemon environment and spawn context', () => {
  it('builds a minimal env without GH_*, NODE_OPTIONS, or agent config', () => {
    const env = daemonSpawnEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 't', NODE_OPTIONS: '--x', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LAZYHUB_DAEMON_CHILD: '1' })
  })

  it('flags unsafe inherited env', () => {
    expect(unsafeDaemonEnv({ PATH: '/bin', GH_HOST: 'x', NODE_OPTIONS: '--y' }).sort()).toEqual(['GH_HOST', 'NODE_OPTIONS'])
  })

  it('treats non-TTY and agent-marked sessions as untrusted', () => {
    const tty = { stdin: { isTTY: true }, stdout: { isTTY: true } }
    expect(isUntrustedAgentContext({ PATH: '/bin' }, tty)).toBe(false)
    expect(isUntrustedAgentContext({ PATH: '/bin' }, { stdin: {}, stdout: {} })).toBe(true)
    expect(isUntrustedAgentContext({ CLAUDECODE: '1' }, tty)).toBe(true)
  })
})

describe('operation classification (fail closed)', () => {
  const gql = q => ['api', 'graphql', '-f', `query=${q}`, '-F', 'limit=5']
  it.each([
    // allowlisted reads
    ['typed read', ['pr', 'view', '7', '--repo', 'o/r', '--json', 'number'], 'read'],
    ['direct read command', ['gist', 'view', 'abc', '--raw'], 'read'],
    ['REST default GET', ['api', 'repos/o/r/branches?per_page=100', '--jq', '.[]'], 'read'],
    ['REST explicit GET with params', ['api', 'notifications', '--method', 'GET', '-f', 'all=true'], 'read'],
    ['graphql query', gql('query($n:Int!){ viewer { login } }'), 'read'],
    ['graphql shorthand query', gql('{ viewer { login } }'), 'read'],
    // writes
    ['known write command', ['pr', 'merge', '7', '--repo', 'o/r'], 'write'],
    ['graphql mutation', gql('mutation { x }'), 'write'],
    ['graphql mutation after a query-looking comment', gql('# query\nmutation { x }'), 'write'],
    ['graphql query document that also holds a mutation', gql('query A { a } mutation B { b }'), 'write'],
    ['graphql query read from a file', gql('@doc.graphql'), 'write'],
    ['graphql without a query', ['api', 'graphql', '-f', 'owner=o'], 'write'],
    ['--method POST', ['api', 'repos/o/r/issues', '--method', 'POST'], 'write'],
    ['--method=PATCH', ['api', 'repos/o/r/issues/1', '--method=PATCH'], 'write'],
    ['-X DELETE', ['api', 'repos/o/r/refs/heads/x', '-X', 'DELETE'], 'write'],
    ['-XPUT', ['api', 'notifications', '-XPUT'], 'write'],
    ['lowercase method', ['api', 'repos/o/r/issues', '--method', 'post'], 'write'],
    ['implicit POST via -f', ['api', 'repos/o/r/issues', '-f', 'title=t'], 'write'],
    ['implicit POST via -F', ['api', 'repos/o/r/issues', '-F', 'n=1'], 'write'],
    ['implicit POST via --raw-field', ['api', 'repos/o/r/issues', '--raw-field', 'title=t'], 'write'],
    ['--input with GET', ['api', 'repos/o/r/issues', '--method', 'GET', '--input', '-'], 'write'],
    // unknown: denied
    ['unknown command', ['repo', 'delete', 'o/r', '--yes'], 'unknown'],
    ['alias/extension', ['alias', 'set', 'x', 'pr merge'], 'unknown'],
    ['unlisted api flag', ['api', 'repos/o/r', '--header', 'X-Foo: 1'], 'unknown'],
    ['api without endpoint', ['api', '--method', 'GET'], 'unknown'],
    ['dangling method flag', ['api', 'repos/o/r', '--method'], 'unknown'],
    ['flag in command slot', ['--help'], 'unknown'],
    ['empty argv', [], 'unknown'],
    ['non-array', 'pr list', 'unknown'],
    ['non-string element', ['pr', 'list', 7], 'unknown'],
  ])('%s -> %s', (_name, args, expected) => {
    expect(classifyGh(args)).toBe(expected)
  })
})
