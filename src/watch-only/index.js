/**
 * watch-only/index.js — observe -> classify -> report, read-only and local.
 */

import { observeRepo } from './observe.js'
import { classifyObservation } from './classify.js'
import { buildReport } from './report.js'

/**
 * Produce a watch-only report for `repo` using the user's existing gh session.
 * @param {object} opts  see observeRepo(); plus `now`
 * @returns {Promise<object>} report (see buildReport)
 */
export async function generateWatchOnlyReport(opts) {
  const observation = await observeRepo(opts)
  return buildReport(classifyObservation(observation), { now: opts.now })
}
