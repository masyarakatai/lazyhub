/**
 * cli/doctor/index.js — lazyhub doctor command.
 */

import { checkConfig, formatConfigReport } from './config.js'
import { checkCoverage, formatCoverageReport } from './coverage.js'
import { resolveCurrentRepo } from '../../executor/activity.js'
import { sanitize } from '../../utils.js'

/**
 * @param argv
 * @param out
 * @param err
 */
export async function runDoctor(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const json = argv.includes('--json')
  const coverage = argv.includes('--coverage')
  const configOnly = argv.includes('--config') || (!argv.includes('--ai') && !coverage)
  if (json && configOnly && coverage) {
    err.write('lazyhub doctor: --json accepts one report; use --config or --coverage, not both\n')
    return 2
  }
  let ok = true
  if (configOnly) {
    const report = checkConfig()
    ok = ok && report.ok
    out.write(formatConfigReport(report, { json }))
    if (!json && !coverage) out.write('\nTip: run `lazyhub doctor --coverage` to check enforcement coverage and alternate paths.\n')
  }
  if (coverage) {
    const i = argv.indexOf('--repo')
    const repoArg = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--repo='))?.slice(7)
    if (repoArg !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repoArg)) {
      err.write('lazyhub doctor: --repo must be owner/name\n')
      return 2
    }
    try {
      const repo = repoArg || await resolveCurrentRepo()
      out.write(formatCoverageReport(await checkCoverage({ repo }), { json }))
    } catch (e) {
      err.write(`lazyhub doctor: ${sanitize(e.message)}\n`)
      return 1
    }
  }
  return ok ? 0 : 1
}
