/**
 * cli/doctor/index.js — lazyhub doctor command.
 */

import { checkConfig, formatConfigReport } from './config.js'
import { checkCoverage, formatCoverageReport } from './coverage.js'
import { resolveCurrentRepo } from '../../executor/activity.js'
import { sanitize } from '../../utils.js'

const DOCTOR_HELP = `Usage: lazyhub doctor [options]

Inspect local configuration or repository enforcement coverage.

Options:
  --config       Check local configuration (default)
  --coverage     Check enforcement coverage for the current repository
  --ai           AI-assisted report (not yet implemented)
  --repo OWNER/NAME  Check coverage for a specific repository
  --json         Emit one JSON report instead of human-readable output
  --help, -h     Show this help text

Exit codes:
  0  Checks passed
  1  A check failed or the report could not be generated
  2  Invalid or conflicting options
`

/**
 * @param argv
 * @param out
 * @param err
 */
export async function runDoctor(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(DOCTOR_HELP)
    return 0
  }
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
