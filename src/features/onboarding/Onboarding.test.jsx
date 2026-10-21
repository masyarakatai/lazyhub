/**
 * Onboarding.test.jsx — zero-configuration watch-only first run (#70).
 *
 * Drives the real <Onboarding> + flow + doctor/watch-only code over a stubbed
 * read-only gh (execa is mocked beneath the real runGh() chokepoint) and asserts
 * the safety acceptance criteria: every recorded gh call classifies as a read,
 * nothing is written to disk, and quitting leaves nothing behind.
 */

import React from 'react'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { classifyGh } from '../../daemon/protocol.js'
import { renderWithProviders, flush, cleanup, waitForExpectation } from '../../test/test-helpers.jsx'
import { Onboarding } from './Onboarding.jsx'
import { classifyFailure, shouldOnboard } from './flow.js'

const fixture = () => JSON.parse(readFileSync(new URL('../../watch-only/fixtures/pr-activity.json', import.meta.url), 'utf8'))
const ok = body => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: '' })
const fail = stderr => ({ exitCode: 1, stdout: '', stderr })

let calls
let home
let originalHome

/** Stub gh. `mode` overrides individual endpoints with a failure. */
function stubGh(mode = {}) {
  execa.mockImplementation(async (bin, args) => {
    calls.push({ bin, args })
    if (mode.user) return mode.user
    if (args[0] === 'api' && args[1] === 'user') return ok({ login: 'octocat' })
    if (args[0] === 'repo' && args[1] === 'view') {
      return args.includes('nameWithOwner') ? ok({ nameWithOwner: 'octocat/hello' })
        : ok({ id: 'R_1', nameWithOwner: args[2], url: `https://github.com/${args[2]}` })
    }
    if (args[0] === 'api' && args[1].startsWith('user/repos')) return ok([{ full_name: 'octocat/hello' }, { full_name: 'acme/platform' }])
    if (args[0] === 'api' && args[1].includes('/rulesets')) return mode.rulesets || ok([])
    if (args[0] === 'api' && args[1] === 'graphql') return mode.graphql || ok(mode.activity || fixture())
    return fail('unexpected stub call')
  })
}

function start(props = {}) {
  const onDone = vi.fn()
  const view = renderWithProviders(<Onboarding onDone={onDone} {...props} />)
  return { onDone, ...view }
}

const frame = view => view.lastFrame() || ''

async function pick(view) {
  await waitForExpectation(() => expect(frame(view)).toContain('Pick a repository to observe'))
  await flush(50) // let Ink attach its input handler before the keypress
  view.stdin.write('\r')
}

function expectOnlyReads() {
  expect(calls.length).toBeGreaterThan(0)
  for (const { bin, args } of calls) {
    expect(bin).toBe('gh')
    expect(classifyGh(args)).toBe('read')
  }
}

beforeEach(() => {
  calls = []
  originalHome = process.env.HOME
  home = mkdtempSync(join(tmpdir(), 'lazyhub-onboard-'))
  process.env.HOME = home
})

afterEach(() => {
  cleanup()
  process.env.HOME = originalHome
  vi.restoreAllMocks()
  execa.mockReset()
})

describe('first-run onboarding', () => {
  it('happy path: existing gh login -> pick repo -> watch-only report with doctor coverage language, no writes', async () => {
    stubGh()
    const view = start()
    await waitForExpectation(() => expect(frame(view)).toContain('octocat/hello'))
    expect(frame(view)).toContain('watch-only · read-only')
    expect(frame(view)).toContain('writes nothing to GitHub')
    await pick(view)

    await waitForExpectation(() => expect(frame(view)).toContain('Coverage (github_enforced | managed_gateway | advisory | ungoverned)'))
    const out = frame(view)
    expect(out).toMatch(/pr_merge\s+advisory/)
    expect(out).toContain('local_agent_approval')
    expect(out).toContain('(coming, not available yet; #245)')
    expect(out).toContain('solo/pilot limits')
    expect(out).not.toMatch(/https?:\/\//)

    view.stdin.write('\r')
    await waitForExpectation(() => expect(view.onDone).toHaveBeenCalledWith({ status: 'completed', repo: 'octocat/hello' }))
    expectOnlyReads()
    expect(readdirSync(home)).toEqual([])
  })

  it('missing auth: explains gh auth login, never logs in, quits cleanly', async () => {
    stubGh({ user: fail('To get started with GitHub CLI, please run:  gh auth login') })
    const view = start()
    await waitForExpectation(() => expect(frame(view)).toContain('Not signed in to GitHub through gh.'))
    expect(frame(view)).toContain('gh auth login')
    expect(calls.map(c => c.args.join(' '))).toEqual(['api user'])
    view.stdin.write('q')
    await waitForExpectation(() => expect(view.onDone).toHaveBeenCalledWith({ status: 'cancelled' }))
    expectOnlyReads()
    expect(readdirSync(home)).toEqual([])
  })

  it('insufficient permissions: report downgrades to ungoverned and says why', async () => {
    stubGh({
      graphql: fail('gh: Resource not accessible by personal access token (HTTP 403)'),
      rulesets: fail('gh: Resource not accessible by personal access token (HTTP 403)'),
    })
    const view = start()
    await pick(view)
    await waitForExpectation(() => expect(frame(view)).toContain('Coverage ('))
    const out = frame(view)
    expect(out).toContain('rulesets: permission_missing')
    expect(out).toContain('Gaps: permission_missing')
    expect(out).toContain('cannot read this repository')
    expect(out).not.toMatch(/pr_merge\s+advisory/)
    expectOnlyReads()
  })

  it('rate limit: shows the observation gap instead of claiming coverage', async () => {
    stubGh({ graphql: fail('gh: API rate limit exceeded for user') })
    const view = start()
    await pick(view)
    await waitForExpectation(() => expect(frame(view)).toContain('Gaps: rate_limited'))
    expect(frame(view)).toContain('rate limit reached')
    expect(frame(view)).not.toMatch(/pr_merge\s+advisory/)
    expectOnlyReads()
  })

  it('rate limit while checking login: error panel with retry, which re-reads', async () => {
    stubGh({ user: fail('gh: API rate limit exceeded for user') })
    const view = start()
    await waitForExpectation(() => expect(frame(view)).toContain('GitHub API rate limit reached.'))
    stubGh()
    view.stdin.write('r')
    await waitForExpectation(() => expect(frame(view)).toContain('Pick a repository to observe'))
    expectOnlyReads()
  })

  it('unknown agent activity is surfaced as unattributed, not safe', async () => {
    const activity = fixture()
    const review = activity.data.repository.pullRequests.nodes[0].reviews.nodes[0]
    review.author = { login: 'mystery-helper', __typename: 'Bot' }
    stubGh({ activity })
    const view = start()
    await pick(view)
    await waitForExpectation(() => expect(frame(view)).toContain('Activity: agent'))
    expect(frame(view)).toMatch(/unknown [1-9]/)
    expect(frame(view)).toContain('unattributed event(s): unknown is not safe')
    expectOnlyReads()
  })

  it('Esc/b returns from the report to the repository list without completing', async () => {
    stubGh()
    const view = start()
    await pick(view)
    await waitForExpectation(() => expect(frame(view)).toContain('Coverage ('))
    view.stdin.write('b')
    await waitForExpectation(() => expect(frame(view)).toContain('Pick a repository to observe'))
    expect(view.onDone).not.toHaveBeenCalled()
  })
})

describe('first-run gating', () => {
  const base = { isTTY: true, env: {}, argv: ['node', 'lazyhub'], configExists: false }

  it('runs only for an interactive session with no config and no launcher-chosen repo', () => {
    expect(shouldOnboard(base)).toBe(true)
    expect(shouldOnboard({ ...base, isTTY: false })).toBe(false)
    expect(shouldOnboard({ ...base, configExists: true })).toBe(false)
    expect(shouldOnboard({ ...base, env: { GHUI_REPO: 'a/b' } })).toBe(false)
    expect(shouldOnboard({ ...base, env: { LAZYHUB_SKIP_ONBOARDING: '1' } })).toBe(false)
  })

  it('--onboarding re-runs it for existing users, but never without a TTY', () => {
    expect(shouldOnboard({ ...base, configExists: true, argv: ['node', 'lazyhub', '--onboarding'] })).toBe(true)
    expect(shouldOnboard({ ...base, isTTY: false, argv: ['node', 'lazyhub', '--onboarding'] })).toBe(false)
  })

  it('classifies gh failures for display', () => {
    expect(classifyFailure(new Error('spawn gh ENOENT'))).toBe('no_gh')
    expect(classifyFailure({ message: 'x', stderr: 'run: gh auth login' })).toBe('auth')
    expect(classifyFailure(new Error('GitHub API rate limit exceeded'))).toBe('rate_limit')
    expect(classifyFailure(new Error('Resource not found'))).toBe('permission')
    expect(classifyFailure(new Error('boom'))).toBe('error')
  })
})
