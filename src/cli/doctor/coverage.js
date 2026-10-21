/**
 * cli/doctor/coverage.js — lazyhub doctor --coverage.
 *
 * Extends the watch-only coverage report (src/watch-only/report.js, the owner of
 * the four-state vocabulary) with repository identity, ruleset readability and
 * local alternate-path detection. It only ever DOWNGRADES a watch-only
 * conclusion; it never invents or upgrades one.
 *
 * COVERAGE HONESTY (ARCHITECT_DECISIONS D1/D7, THREAT_MODEL T1/T7):
 *   - `github_enforced` is never produced: it needs the pinned lazyhub App's
 *     `lazyhub/approval` check plus ruleset verification, and the App (#245)
 *     does not exist yet. `app_verification` says so in every report.
 *   - `managed_gateway` is never produced: no local gateway exists yet.
 *   - Local-agent approval is therefore `advisory` at best, `ungoverned` when
 *     observation is partial/stale, identity is unverified or an alternate path
 *     was detected. Detection is evidence, never proof of absence.
 * Read-only and local: no writes, no auto-fix, no telemetry.
 */

import { runGh } from '../../executor.js'
import { observeRepo } from '../../watch-only/observe.js'
import { classifyObservation } from '../../watch-only/classify.js'
import { buildReport, COVERAGE_STATES } from '../../watch-only/report.js'
import { sanitize } from '../../utils.js'
import { detectAlternatePaths } from './detect.js'

const DOCTOR_SCHEMA_VERSION = 1

const APP_VERIFICATION = Object.freeze({
  status: 'unavailable',
  issue: 245,
  github_enforced_possible: false,
  message: 'The lazyhub GitHub App and its ruleset verification do not exist yet (#245); no operation can be reported github_enforced.',
})

const permissionDenied = err => /\b(403|404)\b|forbidden|not found|resource not accessible/i.test(`${err?.message || ''} ${err?.stderr || ''}`)

/**
 * Verify host + repository node ID through gh (read-only).
 * @param repo
 * @param env
 */
async function fetchIdentity(repo, env) {
  const expectedHost = (env.GH_HOST || 'github.com').toLowerCase()
  try {
    const v = await runGh(['repo', 'view', repo, '--json', 'id,nameWithOwner,url'])
    const host = v?.url ? new URL(v.url).host.toLowerCase() : null
    if (!v?.id || !host) return { status: 'unverified', repo, host, node_id: v?.id || null, reason: 'identity_incomplete' }
    if (host !== expectedHost) return { status: 'unverified', repo, host, node_id: v.id, reason: 'host_mismatch' }
    if (String(v.nameWithOwner).toLowerCase() !== repo.toLowerCase()) return { status: 'unverified', repo, host, node_id: v.id, reason: 'repo_mismatch' }
    return { status: 'verified', repo: v.nameWithOwner, host, node_id: v.id, reason: null }
  } catch (err) {
    return { status: 'unverified', repo, host: null, node_id: null, reason: permissionDenied(err) ? 'permission_missing' : 'identity_unavailable' }
  }
}

/**
 * Read repository rulesets (names only). The App-source condition is never verified here.
 * @param repo
 */
async function fetchRulesets(repo) {
  try {
    const list = await runGh(['api', `repos/${repo}/rulesets?per_page=100`])
    const rows = Array.isArray(list) ? list : []
    return { status: 'readable', count: rows.length, names: rows.map(r => String(r.name || '')), approval_check_verified: false }
  } catch (err) {
    return { status: permissionDenied(err) ? 'permission_missing' : 'unavailable', count: null, names: [], approval_check_verified: false }
  }
}

const ALL_OBSERVED = ['pr_merge', 'pr_review', 'commit_push', 'force_push', 'check_run']

/**
 * Watch-only report; if nothing could be read (e.g. missing permission), an explicit all-gap report instead of a failure.
 * @param opts
 */
async function observedReport(opts) {
  try {
    return buildReport(classifyObservation(await observeRepo({ ...opts, now: opts.observeNow || opts.now })), { now: opts.now })
  } catch (err) {
    const gap = { code: permissionDenied(err) ? 'permission_missing' : 'observation_unavailable', scope: 'pull_requests', operations: ALL_OBSERVED, detail: err.message }
    const empty = { repo: opts.repo, observed_at: new Date((opts.observeNow || opts.now)()).toISOString(), pages_fetched: 0, pull_requests: [], events: [], gaps: [gap], rate_limit: null }
    return buildReport(classifyObservation(empty), { now: opts.now })
  }
}

const withReasons = (op, extra, evidence = {}) => {
  const downgrade_reasons = [...new Set([...op.downgrade_reasons, ...extra])]
  const reliable = downgrade_reasons.length === 0
  return {
    operation: op.operation,
    coverage: reliable ? 'advisory' : 'ungoverned',
    reason: reliable
      ? 'Observed on GitHub after the fact; reported, not enforced.'
      : 'Observation, identity or permissions are incomplete, or an alternate path was detected; no reliable visibility is claimed.',
    evidence: { ...op.evidence, ...evidence },
    observation: op.observation,
    downgrade_reasons,
    would_have_governed: op.would_have_governed,
  }
}

/**
 * Run the coverage diagnostics.
 *
 * @param {object} opts
 * @param {string} opts.repo                owner/name
 * @param {object} [opts.env]
 * @param {string} [opts.home]
 * @param {string} [opts.cwd]
 * @param {() => number} [opts.now]
 * @param {object} [opts.watchOnly]         extra watch-only options (fetchPage; observeNow = clock for the observation; both for tests)
 * @param {Function} [opts.identity]        injectable for tests
 * @param {Function} [opts.rulesets]        injectable for tests
 * @returns {Promise<object>} doctor coverage report (schema_version 1)
 */
export async function checkCoverage({ repo, env = process.env, home, cwd, now = Date.now, watchOnly = {}, identity = fetchIdentity, rulesets = fetchRulesets }) {
  const [report, id, rules] = await Promise.all([
    observedReport({ repo, now, ...watchOnly }),
    identity(repo, env),
    rulesets(repo),
  ])
  const detections = detectAlternatePaths({ env, home, cwd })
  const alternate = detections.findings.filter(f => f.status === 'detected').map(f => `alternate_path_detected:${f.id}`)
  const idReasons = id.status === 'verified' ? [] : [`repo_identity_unverified:${id.reason}`]
  const ruleReasons = rules.status === 'readable' ? [] : [`ruleset_${rules.status}`]
  const merge = report.operations.find(o => o.operation === 'pr_merge')

  const operations = report.operations.map(op => withReasons(op, idReasons))
  operations.push(
    {
      ...withReasons(merge, [...idReasons, ...alternate], { gateway: 'unavailable', approval_path: 'local_agent' }),
      operation: 'local_agent_approval',
    },
    {
      ...withReasons(merge, [...idReasons, ...ruleReasons], { app_source_verification: 'unavailable', ruleset_status: rules.status, approval_path: 'cloud_agent' }),
      operation: 'cloud_agent_merge_approval',
    },
  )

  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    kind: 'doctor_coverage',
    repo,
    generated_at: new Date(now()).toISOString(),
    coverage_states: COVERAGE_STATES,
    identity: id,
    app_verification: APP_VERIFICATION,
    rulesets: rules,
    observation: { complete: report.observation.complete, stale: report.staleness.stale, gap_codes: report.observation.gaps.map(g => g.code) },
    operations,
    detections,
    notes: [
      'Detection is evidence, not proof: absence of a finding does not mean no alternate path exists.',
      'Nothing was written, changed or sent anywhere; doctor never auto-fixes settings.',
      'Secret values are never read into this report; only names, hosts and counts.',
    ],
  }
}

/**
 * Render the report as text. Derived only from the report object, so it cannot
 * disagree with the JSON form.
 *
 * @param {object} report
 * @param {{json?: boolean}} [opts]
 * @returns {string}
 */
export function formatCoverageReport(report, { json = false } = {}) {
  if (json) return `${JSON.stringify(report, null, 2)}\n`
  const s = sanitize
  const lines = [
    `lazyhub doctor coverage: ${s(report.repo)}`,
    `identity: ${report.identity.status}${report.identity.reason ? ` (${report.identity.reason})` : ''}  host=${s(report.identity.host || 'unknown')}  node_id=${s(report.identity.node_id || 'unknown')}`,
    `observation: ${report.observation.complete ? 'complete' : 'partial'}${report.observation.stale ? ', stale' : ''}${report.observation.gap_codes.length ? ` [gaps: ${report.observation.gap_codes.join(', ')}]` : ''}`,
    `rulesets: ${report.rulesets.status}${report.rulesets.count === null ? '' : ` (${report.rulesets.count})`}`,
    `app verification: ${report.app_verification.status} - ${report.app_verification.message}`,
    '',
    `Coverage per operation (${report.coverage_states.join(' | ')}):`,
  ]
  for (const op of report.operations) {
    const why = op.downgrade_reasons.length ? ` [downgraded: ${op.downgrade_reasons.join(', ')}]` : ''
    lines.push(`  ${op.operation.padEnd(28)} ${op.coverage}${why}`)
  }
  lines.push('', 'Alternate paths (evidence, not proof):')
  for (const f of report.detections.findings) {
    const where = [...new Set(f.evidence.map(e => e.server ? `${e.agent}:${e.server}` : e.helper || e.client || e.source).filter(Boolean))]
    lines.push(`  ${f.status.padEnd(12)} ${f.id}: ${s(f.reason)}${where.length ? ` (${s(where.join(', '))})` : ''}`)
  }
  lines.push('', 'Unknown conditions (not detectable by doctor):')
  for (const u of report.detections.unknown) lines.push(`  unknown      ${u.id}: ${s(u.reason)}`)
  lines.push('', ...report.notes.map(n => `- ${n}`))
  return `${lines.join('\n')}\n`
}
