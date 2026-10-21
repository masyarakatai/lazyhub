/**
 * watch-only.test.js — fixture replay through the real runGh() chokepoint
 * (execa mocked), covering observe -> classify -> report and the read-only guarantee.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { generateWatchOnlyReport } from './index.js'
import { observeRepo } from './observe.js'
import { classifyObservation } from './classify.js'
import { buildReport } from './report.js'
import { parseWatchOnlyArgs, formatWatchOnlyReport } from '../cli/watch-only.js'

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/pr-activity.json', import.meta.url), 'utf8'))
const reply = body => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: '' })
const NOW = Date.parse('2026-10-21T10:40:00Z')
const run = (opts = {}) => generateWatchOnlyReport({ repo: 'acme/widgets', now: () => NOW, ...opts })
const op = (report, name) => report.operations.find(o => o.operation === name)
const events = (report, type, pred = () => true) => report.events.filter(e => e.type === type).filter(pred)

beforeEach(() => {
  execa.mockReset()
  execa.mockResolvedValue(reply(fixture()))
})

describe('classification (metadata only, evidence-bearing)', () => {
  it('attributes known Apps and bot accounts with registry evidence', async () => {
    const report = await run()
    const reviewer = events(report, 'pr_review', e => e.actors[0].login === 'copilot-pull-request-reviewer')[0]
    expect(reviewer.actors[0]).toMatchObject({ class: 'agent', registry_id: 'github-copilot-reviewer' })
    expect(reviewer.actors[0].evidence[0]).toMatchObject({ kind: 'registry_match' })
    const ci = events(report, 'check_run', e => e.detail.name === 'test')[0]
    expect(ci.actors[0]).toMatchObject({ class: 'automation', registry_id: 'github-actions', source: 'check_app' })
    expect(events(report, 'pr_review', e => e.actors[0].login === 'alice')[0].attribution).toBe('human')
    expect(events(report, 'force_push')[0]).toMatchObject({ attribution: 'agent', detail: { after: 'aaa111' } })
  })

  it('keeps unregistered bots, unlinked git identities and login/type mismatches as unknown', async () => {
    const report = await run()
    expect(events(report, 'pr_review', e => e.actors[0].login === 'mystery-bot')[0].attribution).toBe('unknown')
    expect(events(report, 'check_run', e => e.detail.name === 'build')[0].attribution).toBe('unknown')
    const botCommit = events(report, 'commit_push', e => e.pr === 102)[0]
    expect(botCommit.attribution).toBe('unknown')
    expect(botCommit.actors[0].evidence.map(x => x.kind)).toContain('self_declared_git_identity')
    const spoof = events(report, 'commit_push', e => e.pr === 103)[0]
    expect(spoof.actors[0].evidence[0].kind).toBe('registry_login_type_mismatch')
    expect(report.pull_requests.find(p => p.number === 103).author.class).toBe('unknown')
  })

  it('does not guess for a shared commit and marks human+agent events shared', async () => {
    const report = await run()
    const shared = events(report, 'commit_push', e => e.pr === 101)[0]
    expect(shared.actors).toHaveLength(2)
    expect(shared.attribution).toBe('unknown')

    const out = classifyObservation({
      pull_requests: [],
      events: [{ actors: [{ login: 'alice', type: 'User', source: 'github_actor' }, { login: 'claude', type: 'Bot', source: 'github_actor' }] }],
    })
    expect(out.events[0].attribution).toBe('shared')
  })
})

describe('report coverage', () => {
  it('never claims enforcement in watch-only and reports advisory for fully observed operations', async () => {
    const report = await run()
    expect(report).toMatchObject({ schema_version: 1, mode: 'watch_only' })
    const states = new Set(report.operations.map(o => o.coverage))
    expect(states.has('github_enforced')).toBe(false)
    expect(states.has('managed_gateway')).toBe(false)
    for (const name of ['pr_merge', 'pr_review', 'commit_push', 'force_push', 'check_run']) {
      expect(op(report, name)).toMatchObject({ coverage: 'advisory', observation: { complete: true, stale: false, gap_codes: [] }, downgrade_reasons: [] })
    }
    expect(op(report, 'pr_merge')).toMatchObject({ would_have_governed: true, observed: { total: 1 } })
    expect(op(report, 'non_github_paths').coverage).toBe('ungoverned')
    expect(op(report, 'push_without_pull_request').coverage).toBe('ungoverned')
    expect(report.observation).toMatchObject({ complete: true, truncated: false })
  })

  it('coverage does not depend on actor classification', async () => {
    const base = classifyObservation(await observeRepo({ repo: 'acme/widgets', now: () => NOW }))
    const reclassify = cls => ({ ...base, events: base.events.map(e => ({ ...e, attribution: cls })) })
    const coverage = r => buildReport(r, { now: () => NOW }).operations.map(o => o.coverage)
    expect(coverage(reclassify('agent'))).toEqual(coverage(reclassify('human')))
  })

  it('downgrades to ungoverned and records a gap when PR pages are truncated', async () => {
    const page = fixture()
    page.data.repository.pullRequests.pageInfo = { hasNextPage: true, endCursor: 'next' }
    execa.mockResolvedValue(reply(page))
    const report = await run({ maxPages: 1 })
    expect(report.observation).toMatchObject({ complete: false, truncated: true })
    expect(report.observation.gaps.map(g => g.code)).toContain('pr_page_limit')
    expect(op(report, 'pr_merge')).toMatchObject({ coverage: 'ungoverned', observation: { complete: false } })
    expect(op(report, 'pr_merge').downgrade_reasons).toContain('observation_gap:pr_page_limit')
    expect(execa).toHaveBeenCalledTimes(1)
  })

  it('attributes per-connection truncation only to the operations it affects', async () => {
    const page = fixture()
    page.data.repository.pullRequests.nodes[0].reviews.pageInfo.hasNextPage = true
    execa.mockResolvedValue(reply(page))
    const report = await run()
    expect(op(report, 'pr_review').coverage).toBe('ungoverned')
    expect(op(report, 'commit_push').coverage).toBe('advisory')
    expect(report.observation.gaps[0]).toMatchObject({ code: 'reviews_truncated', pr: 101 })
  })

  it('reports rate limiting mid-run as a gap instead of failing', async () => {
    const page = fixture()
    page.data.repository.pullRequests.pageInfo = { hasNextPage: true, endCursor: 'next' }
    execa.mockResolvedValueOnce(reply(page)).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' })
    const report = await run()
    expect(report.observation.gaps.map(g => g.code)).toContain('rate_limited')
    expect(report.events.length).toBeGreaterThan(0)
  })

  it('downgrades every observed operation to ungoverned when the data is stale', async () => {
    const classified = classifyObservation(await observeRepo({ repo: 'acme/widgets', now: () => NOW }))
    expect(buildReport(classified, { now: () => NOW }).staleness.stale).toBe(false)
    const stale = buildReport(classified, { now: () => NOW + 3_600_000 })
    expect(stale.staleness).toMatchObject({ stale: true, age_seconds: 3600 })
    expect(op(stale, 'pr_merge')).toMatchObject({ coverage: 'ungoverned', observation: { complete: true, stale: true }, downgrade_reasons: ['stale_observation'] })
  })
})

const readOnlyViolations = ([bin, args]) => {
  const query = args.find(a => a.startsWith('query=')) || ''
  const bad = []
  if (bin !== 'gh') bad.push('binary')
  if (args.slice(0, 2).join(' ') !== 'api graphql') bad.push('not graphql')
  if (args.some(a => ['-X', '--method', '--input'].includes(a))) bad.push('method/input flag')
  if (!/^\s*query\b/.test(query) || /\bmutation\b/i.test(query)) bad.push('not a pure query')
  return bad
}

describe('read-only guarantee', () => {
  it('issues only pure GraphQL queries with integer -F variables', async () => {
    await run()
    expect(execa).toHaveBeenCalled()
    for (const call of execa.mock.calls) {
      expect(readOnlyViolations(call)).toEqual([])
      expect(call[1][call[1].indexOf('limit=20') - 1]).toBe('-F')
    }
  })

  it('the read-only check itself rejects writes', () => {
    expect(readOnlyViolations(['gh', ['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input:{}) { clientMutationId } }']])).toContain('not a pure query')
    expect(readOnlyViolations(['gh', ['api', 'repos/a/b/merges', '-X', 'POST']])).toEqual(expect.arrayContaining(['not graphql', 'method/input flag']))
  })
})

describe('cli surface', () => {
  it('parses flags and rejects bad input', () => {
    expect(parseWatchOnlyArgs(['--json', '--repo=acme/widgets', '--limit', '5'])).toMatchObject({ json: true, repo: 'acme/widgets', limit: 5 })
    expect(parseWatchOnlyArgs(['--bogus']).error).toMatch(/unknown/)
    expect(parseWatchOnlyArgs(['--repo', 'nope']).error).toMatch(/owner\/name/)
  })

  it('renders human text and sanitizes GitHub-sourced strings', async () => {
    const report = await run()
    report.actors[0].login = 'evil\u001b[31mred'
    const text = formatWatchOnlyReport(report)
    expect(text).toContain('pr_merge')
    expect(text).toContain('advisory')
    expect(text).not.toContain('\u001b')
  })
})
