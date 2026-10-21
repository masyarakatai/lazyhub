/**
 * cli/doctor/coverage.test.js — doctor coverage: states, downgrade paths, human/JSON agreement.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { checkCoverage, formatCoverageReport } from './coverage.js'

const SECRET = 'ghp_supersecretvalue123'
const NOW = Date.parse('2026-10-21T10:40:00Z')
const fixture = () => JSON.parse(readFileSync(new URL('../../watch-only/fixtures/pr-activity.json', import.meta.url), 'utf8'))
const pageFrom = f => ({ rateLimit: f.data.rateLimit, pullRequests: f.data.repository.pullRequests })
const verified = async () => ({ status: 'verified', repo: 'acme/widgets', host: 'github.com', node_id: 'R_kgDOabc', reason: null })
const readable = async () => ({ status: 'readable', count: 1, names: ['protect main'], approval_check_verified: false })

function cleanHome() {
  const root = mkdtempSync(join(tmpdir(), 'lazyhub-cov-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(home, { recursive: true })
  return { home, cwd, env: { HOME: home, PATH: '' } }
}

async function run(over = {}, fx = fixture()) {
  const { home, cwd, env } = cleanHome()
  return checkCoverage({
    repo: 'acme/widgets', env, home, cwd, now: () => NOW,
    watchOnly: { fetchPage: async () => pageFrom(fx) },
    identity: verified, rulesets: readable, ...over,
  })
}
const op = (r, name) => r.operations.find(o => o.operation === name)

describe('doctor coverage states', () => {
  it('uses only the four states and never reports github_enforced or managed_gateway', async () => {
    const r = await run()
    expect(r.coverage_states).toEqual(['github_enforced', 'managed_gateway', 'advisory', 'ungoverned'])
    for (const o of r.operations) expect(r.coverage_states).toContain(o.coverage)
    expect(r.operations.map(o => o.coverage)).not.toContain('github_enforced')
    expect(r.operations.map(o => o.coverage)).not.toContain('managed_gateway')
    expect(r.app_verification).toMatchObject({ status: 'unavailable', github_enforced_possible: false })
    expect(formatCoverageReport(r)).toContain('no operation can be reported github_enforced')
  })

  it('reports advisory for fully observed operations on a clean machine, with evidence', async () => {
    const r = await run()
    expect(op(r, 'pr_merge')).toMatchObject({ coverage: 'advisory', downgrade_reasons: [] })
    expect(op(r, 'local_agent_approval')).toMatchObject({ coverage: 'advisory', evidence: { gateway: 'unavailable' } })
    expect(op(r, 'cloud_agent_merge_approval')).toMatchObject({ coverage: 'advisory', evidence: { app_source_verification: 'unavailable', ruleset_status: 'readable' } })
    expect(op(r, 'non_github_paths').coverage).toBe('ungoverned')
  })
})

describe('doctor downgrade paths', () => {
  it('downgrades on partial results (truncated PR pages)', async () => {
    const fx = fixture()
    fx.data.repository.pullRequests.pageInfo = { hasNextPage: true, endCursor: 'x' }
    const r = await run({ watchOnly: { maxPages: 1, fetchPage: async () => pageFrom(fx) } }, fx)
    expect(r.observation).toMatchObject({ complete: false, gap_codes: ['pr_page_limit'] })
    for (const name of ['pr_merge', 'local_agent_approval', 'cloud_agent_merge_approval']) {
      expect(op(r, name)).toMatchObject({ coverage: 'ungoverned' })
      expect(op(r, name).downgrade_reasons).toContain('observation_gap:pr_page_limit')
    }
  })

  it('downgrades on stale observation', async () => {
    const r = await run({ now: () => NOW + 3_600_000, watchOnly: { observeNow: () => NOW, fetchPage: async () => pageFrom(fixture()) } })
    expect(r.observation.stale).toBe(true)
    expect(op(r, 'local_agent_approval')).toMatchObject({ coverage: 'ungoverned', downgrade_reasons: ['stale_observation'] })
  })

  it('downgrades on missing permissions: unreadable PR activity, ruleset and identity', async () => {
    const denied = async () => { throw Object.assign(new Error('HTTP 403: Resource not accessible'), { stderr: '' }) }
    const r = await run({
      watchOnly: { fetchPage: denied },
      identity: async () => ({ status: 'unverified', repo: 'acme/widgets', host: null, node_id: null, reason: 'permission_missing' }),
      rulesets: async () => ({ status: 'permission_missing', count: null, names: [], approval_check_verified: false }),
    })
    expect(r.observation.gap_codes).toEqual(['permission_missing'])
    expect(op(r, 'pr_merge').coverage).toBe('ungoverned')
    expect(op(r, 'cloud_agent_merge_approval').downgrade_reasons).toEqual(expect.arrayContaining([
      'observation_gap:permission_missing', 'repo_identity_unverified:permission_missing', 'ruleset_permission_missing',
    ]))
  })

  it('downgrades when the ruleset cannot be read even if everything else is clean', async () => {
    const r = await run({ rulesets: async () => ({ status: 'permission_missing', count: null, names: [], approval_check_verified: false }) })
    expect(op(r, 'cloud_agent_merge_approval')).toMatchObject({ coverage: 'ungoverned', downgrade_reasons: ['ruleset_permission_missing'] })
    expect(op(r, 'local_agent_approval').coverage).toBe('advisory')
  })

  it('downgrades local-agent approval (only) when an alternate credential is detected', async () => {
    const { home, cwd, env } = cleanHome()
    const r = await run({ env: { ...env, GH_TOKEN: SECRET }, home, cwd })
    expect(op(r, 'local_agent_approval')).toMatchObject({ coverage: 'ungoverned', downgrade_reasons: ['alternate_path_detected:env_tokens'] })
    expect(op(r, 'pr_merge').coverage).toBe('advisory')
  })

  it('downgrades every operation when repository identity is unverified', async () => {
    const r = await run({ identity: async () => ({ status: 'unverified', repo: 'acme/widgets', host: 'ghe.example', node_id: 'R_x', reason: 'host_mismatch' }) })
    for (const o of r.operations) expect(o.coverage).toBe('ungoverned')
    expect(op(r, 'pr_review').downgrade_reasons).toContain('repo_identity_unverified:host_mismatch')
  })
})

describe('doctor output', () => {
  it('human output agrees with JSON for every operation and finding, and never leaks secrets', async () => {
    const { home, cwd, env } = cleanHome()
    writeFileSync(join(home, '.git-credentials'), `https://u:${SECRET}@github.com\n`)
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', env: { T: SECRET } } } }))
    const r = await run({ env: { ...env, GH_TOKEN: SECRET }, home, cwd })
    const human = formatCoverageReport(r)
    const json = formatCoverageReport(r, { json: true })
    expect(JSON.parse(json)).toEqual(r)
    for (const o of r.operations) {
      const line = human.split('\n').find(l => l.trim().startsWith(`${o.operation} `))
      expect(line, o.operation).toContain(o.coverage)
      for (const reason of o.downgrade_reasons) expect(line).toContain(reason)
    }
    for (const f of r.detections.findings) expect(human).toMatch(new RegExp(`${f.status}\\s+${f.id}:`))
    for (const u of r.detections.unknown) expect(human).toContain(u.id)
    expect(r.detections.findings.find(f => f.id === 'env_tokens').status).toBe('detected')
    expect(human + json).not.toContain(SECRET)
  })
})
