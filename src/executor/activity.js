/**
 * executor/activity.js — typed READ-ONLY GitHub activity methods for watch-only mode.
 *
 * Every call goes through runGh() (the single gh chokepoint) and is a GraphQL
 * `query` or a `gh repo view`; nothing here mutates. One GraphQL round-trip
 * returns, per pull request, the force-push timeline, reviews, commits and the
 * head commit's check suites/runs, plus `rateLimit`, so observing N PRs does not
 * cost N*4 REST calls. Integers go via -F, strings via -f; pagination is
 * explicit (`first`/`last` on every connection, PR pages via cursor).
 */

import { runGh } from './core.js'

const PR_ACTIVITY_QUERY = `
query($owner: String!, $name: String!, $limit: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: $limit, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number updatedAt headRefOid baseRefName merged mergedAt
        author { login __typename }
        mergedBy { login __typename }
        timelineItems(first: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on HeadRefForcePushedEvent {
              createdAt
              actor { login __typename }
              beforeCommit { oid }
              afterCommit { oid }
            }
          }
        }
        reviews(first: 50) {
          pageInfo { hasNextPage }
          nodes { id state submittedAt author { login __typename } commit { oid } }
        }
        commits(last: 30) {
          pageInfo { hasPreviousPage }
          nodes { commit {
            oid committedDate
            author { name email user { login } }
            authors(first: 5) { nodes { name email user { login } } }
          } }
        }
        headCommit: commits(last: 1) {
          nodes { commit {
            oid
            checkSuites(first: 10) {
              pageInfo { hasNextPage }
              nodes {
                app { slug name }
                checkRuns(first: 20) {
                  pageInfo { hasNextPage }
                  nodes { name conclusion completedAt }
                }
              }
            }
          } }
        }
      }
    }
  }
}`

/**
 * Fetch one page of recent pull requests with their activity.
 *
 * @param {string} repo      "owner/name"
 * @param {object} [opts]
 * @param {number} [opts.limit=20]   PRs per page (GraphQL `first`)
 * @param {string|null} [opts.after] cursor from the previous page
 * @returns {Promise<{rateLimit: object|null, pullRequests: {nodes: object[], pageInfo: {hasNextPage: boolean, endCursor: string|null}}}>}
 */
export async function fetchPullRequestActivityPage(repo, { limit = 20, after = null } = {}) {
  const [owner, name] = String(repo || '').split('/')
  if (!owner || !name) throw new Error(`invalid repo "${repo}", expected owner/name`)
  const args = [
    'api', 'graphql',
    '-f', `query=${PR_ACTIVITY_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `limit=${limit}`,
  ]
  if (after) args.push('-f', `after=${after}`)
  const result = await runGh(args)
  const data = result?.data
  if (!data?.repository?.pullRequests) {
    const reason = result?.errors?.[0]?.message || 'repository not found or not readable'
    throw new Error(`could not read pull request activity for ${repo}: ${reason}`)
  }
  return { rateLimit: data.rateLimit || null, pullRequests: data.repository.pullRequests }
}

/**
 * Resolve the repository of the current directory via the user's gh session.
 * @returns {Promise<string>} "owner/name"
 */
export async function resolveCurrentRepo() {
  const result = await runGh(['repo', 'view', '--json', 'nameWithOwner'])
  const name = result?.nameWithOwner
  if (!name) throw new Error('could not determine repository; pass --repo owner/name')
  return name
}
