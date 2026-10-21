/**
 * watch-only/observe.js — read GitHub-side PR activity into normalized events.
 *
 * Observes only what reached GitHub (PR timelines, commits, reviews, check
 * runs) through the user's existing `gh` session. Local work that never reached
 * GitHub is invisible by construction (THREAT_MODEL T7) and is never claimed.
 * Anything not fully read becomes an explicit `gap` rather than silence, so the
 * report can refuse to call an incompletely observed operation covered (T1).
 *
 * Event `type` values are the operation names used by report.js.
 */

import { fetchPullRequestActivityPage } from '../executor/activity.js'

export const DEFAULT_LIMIT = 20
export const DEFAULT_MAX_PAGES = 2

/** Event type -> the GraphQL connection that bounds how completely we saw it. */
const GAP_OPERATIONS = {
  timeline: ['force_push'],
  reviews: ['pr_review'],
  commits: ['commit_push'],
  check_suites: ['check_run'],
  check_runs: ['check_run'],
  pull_requests: ['pr_merge', 'pr_review', 'commit_push', 'force_push', 'check_run'],
  rate_limit: ['pr_merge', 'pr_review', 'commit_push', 'force_push', 'check_run'],
}

const ghActor = a => (a ? { login: a.login || null, type: a.__typename || null, source: 'github_actor' } : { login: null, type: null, source: 'github_actor' })
const gitActor = a => ({ login: a?.user?.login || null, type: a?.user ? 'User' : null, email: a?.email || null, source: 'git_author' })

function normalizePR(pr, addGap) {
  const events = []
  const n = pr.number
  const ref = { pr: n }

  if (pr.timelineItems?.pageInfo?.hasNextPage) addGap('timeline_truncated', 'timeline', n)
  for (const item of pr.timelineItems?.nodes || []) {
    if (item.__typename !== 'HeadRefForcePushedEvent') continue
    events.push({
      ...ref, type: 'force_push', at: item.createdAt, actors: [ghActor(item.actor)],
      detail: { before: item.beforeCommit?.oid || null, after: item.afterCommit?.oid || null },
    })
  }

  if (pr.reviews?.pageInfo?.hasNextPage) addGap('reviews_truncated', 'reviews', n)
  for (const r of pr.reviews?.nodes || []) {
    events.push({ ...ref, type: 'pr_review', at: r.submittedAt, actors: [ghActor(r.author)], detail: { state: r.state, commit: r.commit?.oid || null } })
  }

  if (pr.commits?.pageInfo?.hasPreviousPage) addGap('commits_truncated', 'commits', n)
  for (const { commit } of pr.commits?.nodes || []) {
    // Author + co-authors (shared commits). The committer is deliberately
    // ignored: it is usually GitHub's web-flow and says nothing about authorship.
    const people = [commit.author, ...(commit.authors?.nodes || [])].filter(Boolean)
    const seen = new Set()
    const actors = []
    for (const p of people) {
      const key = p.user?.login || p.email || p.name
      if (seen.has(key)) continue
      seen.add(key)
      actors.push(gitActor(p))
    }
    events.push({ ...ref, type: 'commit_push', at: commit.committedDate, actors, detail: { sha: commit.oid } })
  }

  if (pr.merged && pr.mergedBy) {
    events.push({ ...ref, type: 'pr_merge', at: pr.mergedAt, actors: [ghActor(pr.mergedBy)], detail: { base: pr.baseRefName } })
  }

  // Check runs are read for the head commit only: that is the state a merge sees.
  for (const { commit } of pr.headCommit?.nodes || []) {
    const suites = commit.checkSuites
    if (suites?.pageInfo?.hasNextPage) addGap('check_suites_truncated', 'check_suites', n)
    for (const suite of suites?.nodes || []) {
      if (suite.checkRuns?.pageInfo?.hasNextPage) addGap('check_runs_truncated', 'check_runs', n)
      const actor = { login: null, type: 'App', slug: suite.app?.slug || null, source: 'check_app' }
      for (const run of suite.checkRuns?.nodes || []) {
        events.push({ ...ref, type: 'check_run', at: run.completedAt || null, actors: [actor], detail: { name: run.name, conclusion: run.conclusion || null, sha: commit.oid } })
      }
    }
  }
  return events
}

/**
 * Observe recent PR activity for a repository.
 *
 * Output shape (stable; consumed by report.js and by doctor/onboarding):
 * `{repo, observed_at, pages_fetched, pull_requests[], events[], gaps[], rate_limit}`
 * where each gap is `{code, scope, pr?, operations[], detail?}`.
 *
 * @param {object} opts
 * @param {string} opts.repo
 * @param {number} [opts.limit]     PRs per page
 * @param {number} [opts.maxPages]  hard cap on pages; more available => `pr_page_limit` gap
 * @param {() => number} [opts.now]
 * @param {Function} [opts.fetchPage] injectable for tests
 */
export async function observeRepo({ repo, limit = DEFAULT_LIMIT, maxPages = DEFAULT_MAX_PAGES, now = Date.now, fetchPage = fetchPullRequestActivityPage }) {
  const gaps = []
  const events = []
  const pull_requests = []
  let rateLimit = null
  let after = null
  let pages = 0

  const addGap = (code, scope, pr, detail) =>
    gaps.push({ code, scope, ...(pr ? { pr } : {}), operations: GAP_OPERATIONS[scope], ...(detail ? { detail } : {}) })

  while (pages < maxPages) {
    let page
    try {
      page = await fetchPage(repo, { limit, after })
    } catch (err) {
      if (pages === 0 && !/rate limit/i.test(err.message)) throw err
      addGap(/rate limit/i.test(err.message) ? 'rate_limited' : 'fetch_failed', /rate limit/i.test(err.message) ? 'rate_limit' : 'pull_requests', null, err.message)
      return finish()
    }
    pages += 1
    rateLimit = page.rateLimit ? { remaining: page.rateLimit.remaining, cost: page.rateLimit.cost, reset_at: page.rateLimit.resetAt } : rateLimit

    for (const pr of page.pullRequests.nodes) {
      pull_requests.push({
        number: pr.number, updated_at: pr.updatedAt, head_sha: pr.headRefOid || null, base: pr.baseRefName || null,
        author: ghActor(pr.author),
      })
      events.push(...normalizePR(pr, (code, scope, n) => addGap(code, scope, n)))
    }

    const more = page.pullRequests.pageInfo.hasNextPage
    after = page.pullRequests.pageInfo.endCursor
    if (!more) return finish()
    if (rateLimit && rateLimit.remaining < rateLimit.cost * 2) {
      addGap('rate_limit_low', 'rate_limit', null, `remaining=${rateLimit.remaining} resets ${rateLimit.reset_at}`)
      return finish()
    }
  }
  addGap('pr_page_limit', 'pull_requests', null, `stopped after ${maxPages} page(s) of ${limit}; older PRs not observed`)
  return finish()

  function finish() {
    return { repo, observed_at: new Date(now()).toISOString(), pages_fetched: pages, pull_requests, events, gaps, rate_limit: rateLimit }
  }
}
