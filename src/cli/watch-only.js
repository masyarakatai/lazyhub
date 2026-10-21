/**
 * cli/watch-only.js — `lazyhub watch-only [--repo owner/name] [--json] [--limit N] [--max-pages N]`
 *
 * Read-only: queries GitHub through the existing gh session and prints a local
 * coverage report. Requires no agent, App, webhook or MCP configuration.
 */

import { generateWatchOnlyReport } from '../watch-only/index.js'
import { resolveCurrentRepo } from '../executor/activity.js'
import { DEFAULT_LIMIT, DEFAULT_MAX_PAGES } from '../watch-only/observe.js'
import { sanitize } from '../utils.js'

/**
 * @param {string[]} args
 * @returns {{json: boolean, repo: string|null, limit: number, maxPages: number, error?: string}}
 */
export function parseWatchOnlyArgs(args) {
  const out = { json: false, repo: null, limit: DEFAULT_LIMIT, maxPages: DEFAULT_MAX_PAGES }
  const intFlag = value => {
    const n = Number(value)
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null
  }
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s)
    const value = () => inline ?? args[++i]
    if (flag === '--json') out.json = true
    else if (flag === '--repo') out.repo = value() || null
    else if (flag === '--limit') { out.limit = intFlag(value()); if (!out.limit) return { ...out, error: '--limit must be an integer 1-100' } }
    else if (flag === '--max-pages') { out.maxPages = intFlag(value()); if (!out.maxPages) return { ...out, error: '--max-pages must be an integer 1-100' } }
    else return { ...out, error: `unknown argument: ${args[i]}` }
  }
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) return { ...out, error: '--repo must be owner/name' }
  return out
}

/**
 * Render the report as plain text. Every GitHub-sourced string is sanitized.
 * @param {object} report
 * @returns {string}
 */
export function formatWatchOnlyReport(report) {
  const o = report.observation
  const lines = [
    `lazyhub watch-only report: ${sanitize(report.repo)}`,
    `observed ${o.pull_requests_examined} PR(s) in ${o.pages_fetched} page(s); nothing was enforced or written`,
    '',
    'Coverage per operation (github_enforced | managed_gateway | advisory | ungoverned):',
  ]
  for (const op of report.operations) {
    const a = op.observed.by_attribution
    const seen = op.observed.total ? ` seen=${op.observed.total} (agent ${a.agent}, automation ${a.automation}, human ${a.human}, shared ${a.shared}, unknown ${a.unknown})` : ''
    lines.push(`  ${op.operation.padEnd(28)} ${op.coverage}${seen}`)
  }
  if (o.gaps.length) {
    lines.push('', 'Observation gaps:')
    for (const g of o.gaps) lines.push(`  ${g.code}${g.pr ? ` (PR #${g.pr})` : ''}${g.detail ? `: ${sanitize(g.detail)}` : ''}`)
  }
  if (o.rate_limit) lines.push('', `GraphQL rate limit remaining: ${o.rate_limit.remaining}`)
  if (report.staleness.stale) lines.push(`Data is stale (${report.staleness.age_seconds}s old).`)
  if (report.actors.length) {
    lines.push('', 'Actors (audit metadata only; never used for authority):')
    for (const a of report.actors.slice(0, 15)) {
      lines.push(`  ${sanitize(a.login || a.registry_id || '(no github account)')}  ${a.class}${a.label ? ` [${sanitize(a.label)}]` : ''}  x${a.event_count}`)
    }
  }
  lines.push('', ...report.notes.map(n => `- ${n}`))
  return `${lines.join('\n')}\n`
}

/**
 * Run `lazyhub watch-only`.
 * @param {string[]} args
 * @param {{out?: object, err?: object}} [io]
 * @returns {Promise<number>} exit code
 */
export async function runWatchOnly(args = [], { out = process.stdout, err = process.stderr } = {}) {
  const parsed = parseWatchOnlyArgs(args)
  if (parsed.error) {
    err.write(`lazyhub watch-only: ${parsed.error}\n`)
    return 2
  }
  try {
    const repo = parsed.repo || await resolveCurrentRepo()
    const report = await generateWatchOnlyReport({ repo, limit: parsed.limit, maxPages: parsed.maxPages })
    out.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatWatchOnlyReport(report))
    return 0
  } catch (e) {
    err.write(`lazyhub watch-only: ${sanitize(e.message)}\n`)
    return 1
  }
}
