/**
 * watch-only/report.js — per-operation coverage report (JSON schema v1).
 *
 * COVERAGE HONESTY (ARCHITECT_DECISIONS D1/D5/D7, THREAT_MODEL T1/T7):
 * In watch-only Alpha lazyhub installs nothing and blocks nothing, so:
 *   - `github_enforced` is NEVER assigned. It requires the pinned-source
 *     `lazyhub/approval` required check plus ruleset verification (D1); watch-only
 *     neither installs nor verifies either ("no required check is installed or
 *     auto-passed").
 *   - `managed_gateway` is NEVER assigned. It requires the local gateway/helper
 *     (Slice 2); none exists or is consulted here.
 *   - `advisory` is assigned to an operation lazyhub completely observed on
 *     GitHub: it can be reported after the fact, not prevented.
 *   - `ungoverned` is assigned when lazyhub has no reliable observation
 *     (THREAT_MODEL "Coverage vocabulary": stale observation and partial API
 *     results downgrade the state): observation was truncated / rate limited /
 *     failed for that operation, the data is stale, or the path is outside what
 *     GitHub-side watching can see.
 * Coverage state is kept separate from the observation facts that justify it:
 * every operation carries `observation` {complete, stale, gap_codes} and
 * `downgrade_reasons` so consumers never infer a gap from the state alone.
 * Coverage depends ONLY on observation quality, never on actor classification
 * (D1/D3: classification is metadata, never authority).
 *
 * Stable output shape for consumers (#133 doctor, #70 onboarding): see
 * buildReport()'s JSDoc. Additive changes bump the minor via `schema_version`
 * policy in docs/CONTRACT.md.
 */

const REPORT_SCHEMA_VERSION = 1
const STALE_AFTER_SECONDS = 10 * 60

/**
 * `would_have_governed`: operations the Alpha design (D1) would put behind
 * `lazyhub/approval`. Only the merge is gated by design; the others are
 * observed for audit context and have no Alpha policy yet.
 */
const OBSERVED_OPERATIONS = [
  { operation: 'pr_merge', event: 'pr_merge', would_have_governed: true },
  { operation: 'pr_review', event: 'pr_review', would_have_governed: false },
  { operation: 'commit_push', event: 'commit_push', would_have_governed: false },
  { operation: 'force_push', event: 'force_push', would_have_governed: false },
  { operation: 'check_run', event: 'check_run', would_have_governed: false },
]

/** Paths watch-only cannot see at all (T7). Always `ungoverned`. */
const UNOBSERVABLE_PATHS = [
  { operation: 'push_without_pull_request', reason: 'Only pull-request activity is read; direct branch pushes with no PR are not observed.' },
  { operation: 'non_github_paths', reason: 'Local work that never reached GitHub, alternate credentials, SSH, direct clients and other MCP servers are not observable from GitHub.' },
]

const GITHUB_ENFORCED_MISSING = 'lazyhub/approval required check with pinned App source and ruleset verification not installed or verified in watch-only'
const MANAGED_GATEWAY_MISSING = 'no lazyhub gateway/helper in the path in watch-only'

const emptyCounts = () => ({ agent: 0, automation: 0, human: 0, shared: 0, unknown: 0 })

function actorSummary(events) {
  const byKey = new Map()
  const add = a => {
    const key = `${a.source}:${a.login ?? a.registry_id ?? '?'}:${a.class}`
    const row = byKey.get(key) || { login: a.login, type: a.type, source: a.source, class: a.class, registry_id: a.registry_id, label: a.label, evidence: a.evidence, event_count: 0 }
    row.event_count += 1
    byKey.set(key, row)
  }
  events.forEach(e => e.actors.forEach(add))
  return [...byKey.values()].sort((a, b) => b.event_count - a.event_count)
}

/**
 * Build the report from a classified observation.
 *
 * @param {object} classified  classifyObservation(observeRepo(...))
 * @param {{now?: () => number}} [opts]
 * @returns {{
 *   schema_version: 1, mode: 'watch_only', repo: string, generated_at: string, observed_at: string,
 *   staleness: {stale: boolean, age_seconds: number, stale_after_seconds: number, newest_activity_at: string|null},
 *   observation: {complete: boolean, truncated: boolean, pages_fetched: number, pull_requests_examined: number, rate_limit: object|null, gaps: object[]},
 *   operations: {operation: string, coverage: string, reason: string, evidence: object,
 *                observation: {complete: boolean, stale: boolean, gap_codes: string[]}, downgrade_reasons: string[],
 *                would_have_governed: boolean, observed: {total: number, by_attribution: object}}[],
 *   pull_requests: object[], actors: object[], events: object[], notes: string[]
 * }}
 */
export function buildReport(classified, { now = Date.now } = {}) {
  const { events, gaps } = classified
  const generated = now()
  const age = Math.max(0, Math.floor((generated - Date.parse(classified.observed_at)) / 1000))
  const stale = age > STALE_AFTER_SECONDS
  const newest = events.map(e => e.at).filter(Boolean).sort().at(-1) || null

  const operations = OBSERVED_OPERATIONS.map(({ operation, event, would_have_governed }) => {
    const mine = events.filter(e => e.type === event)
    const gap_codes = gaps.filter(g => g.operations.includes(operation)).map(g => g.code)
    const by_attribution = emptyCounts()
    mine.forEach(e => { by_attribution[e.attribution] += 1 })
    const complete = gap_codes.length === 0
    const downgrade_reasons = [...gap_codes.map(code => `observation_gap:${code}`), ...(stale ? ['stale_observation'] : [])]
    const reliable = downgrade_reasons.length === 0
    return {
      operation,
      coverage: reliable ? 'advisory' : 'ungoverned',
      reason: reliable
        ? 'Observed on GitHub after the fact; watch-only reports it but enforces nothing (no lazyhub/approval check, no gateway).'
        : 'Observation is incomplete or stale for this operation; no reliable visibility is claimed.',
      evidence: {
        source: 'github_graphql_readonly',
        enforcement: 'none',
        github_enforced_missing: GITHUB_ENFORCED_MISSING,
        managed_gateway_missing: MANAGED_GATEWAY_MISSING,
      },
      observation: { complete, stale, gap_codes },
      downgrade_reasons,
      would_have_governed,
      observed: { total: mine.length, by_attribution },
    }
  })

  for (const p of UNOBSERVABLE_PATHS) {
    operations.push({
      operation: p.operation,
      coverage: 'ungoverned',
      reason: p.reason,
      evidence: { source: 'none', enforcement: 'none', github_enforced_missing: GITHUB_ENFORCED_MISSING, managed_gateway_missing: MANAGED_GATEWAY_MISSING },
      observation: { complete: false, stale, gap_codes: ['not_observable'] },
      downgrade_reasons: ['not_observable'],
      would_have_governed: false,
      observed: { total: 0, by_attribution: emptyCounts() },
    })
  }

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    mode: 'watch_only',
    repo: classified.repo,
    generated_at: new Date(generated).toISOString(),
    observed_at: classified.observed_at,
    staleness: { stale, age_seconds: age, stale_after_seconds: STALE_AFTER_SECONDS, newest_activity_at: newest },
    observation: {
      complete: gaps.length === 0,
      truncated: gaps.length > 0,
      pages_fetched: classified.pages_fetched,
      pull_requests_examined: classified.pull_requests.length,
      rate_limit: classified.rate_limit,
      gaps,
    },
    operations,
    pull_requests: classified.pull_requests,
    actors: actorSummary(events),
    events,
    notes: [
      'Report is local; nothing was sent anywhere and nothing was written to GitHub.',
      'Actor classes are audit metadata only and never grant or bypass authority.',
      '"human" means a GitHub User account with no known-agent evidence, not a verified person.',
      'Local work that never reached GitHub is not observed.',
    ],
  }
}
