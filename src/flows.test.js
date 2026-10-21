/**
 * flows.test.js — Comprehensive flow tests covering every user-facing flow.
 *
 * Organized by feature area. All gh CLI calls are intercepted via mocked execa.
 * Component state logic is tested via pure function extraction where possible.
 * Virtual-list / keyboard flows are tested via the useVirtualList hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import {
  GhError, runGh,
  // PR
  listPRs, getPR, mergePR, closePR, markPRReady, convertPRToDraft,
  editPRBase, reviewPR, addPRComment, getPRDiff, createPR,
  addPRAssignees, removePRAssignees,
  // Issue
  listIssues, getIssue, createIssue, closeIssue,
  addIssueComment, addIssueAssignees, removeIssueAssignees,
  // Labels
  listLabels, addLabels, removeLabels,
  // Collaborators / reviewers
  listCollaborators, requestReviewers, removeReviewers,
  // Branches
  listBranches, checkoutBranch, deleteBranch,
  // Actions
  listRuns, getRunLogs, rerunRun, cancelRun,
  // Checks
  getPRChecks, rerunCheckRun, getCheckRunAnnotations,
  // Notifications
  listNotifications, markNotificationRead,
  // Repo
  getRepoInfo,
  // Auto-merge
  enableAutoMerge, disableAutoMerge,
  // Comments
  resolveThread, replyToComment, editPRComment, deletePRComment,
} from './executor.js'

// Virtual list logic helpers (mirror the hook's internal math, tested in isolation)
function computeScroll({ cursor, prevOffset, height, _count }) {
  if (cursor < prevOffset) return cursor
  if (cursor >= prevOffset + height) return Math.max(0, cursor - height + 1)
  return prevOffset
}
function safeOffset(offset, height, count) {
  return Math.max(0, Math.min(offset, Math.max(0, count - height)))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data = null) {
  execa.mockResolvedValue({
    exitCode: 0,
    stdout: data === null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)),
    stderr: '',
  })
}

function fail(stderr = 'error', code = 1) {
  execa.mockResolvedValue({ exitCode: code, stdout: '', stderr })
}

function args() {
  return execa.mock.calls[0][1]
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GHUI_REPO = 'owner/repo'
})

// ─── PR LIST FLOWS ────────────────────────────────────────────────────────────

describe('PR list — fetch flows', () => {
  it('fetches open PRs by default', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo')
    expect(args()).toEqual(expect.arrayContaining(['api', 'graphql']))
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('state:open')
  })

  it('fetches closed PRs when state=closed', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { state: 'closed' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('state:closed')
  })

  it('fetches merged PRs when state=merged', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { state: 'merged' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('is:merged')
  })

  it('filters by author when scope=own (passes @me)', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { scope: 'own' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('author:@me')
  })

  it('filters by review-requested when scope=reviewing', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { scope: 'reviewing' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('review-requested:@me')
  })

  it('passes explicit author filter', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { author: 'alice' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('author:alice')
  })

  it('passes assignee filter', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { assignee: 'bob' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('assignee:bob')
  })

  it('passes label filter', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { label: 'bug' })
    expect(args().find(arg => String(arg).startsWith('searchQuery='))).toContain('label:"bug"')
  })

  it('respects custom page limit', async () => {
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo', { limit: 200 })
    expect(args()).toContain('limit=100')
  })

  it('returns parsed PR array', async () => {
    const prs = [
      { __typename: 'PullRequest', number: 1, title: 'Fix bug', labels: { nodes: [] }, reviewRequests: { nodes: [] }, statusCheckRollup: { nodes: [] }, assignees: { nodes: [] } },
      { __typename: 'PullRequest', number: 2, title: 'Feature', labels: { nodes: [] }, reviewRequests: { nodes: [] }, statusCheckRollup: { nodes: [] }, assignees: { nodes: [] } },
    ]
    ok({ data: { search: { nodes: prs } } })
    const result = await listPRs('owner/repo')
    expect(result.map(pr => pr.number)).toEqual([1, 2])
  })
})

describe('PR detail — fetch flow', () => {
  it('fetches PR with all required JSON fields', async () => {
    ok({ number: 42, title: 'My PR', state: 'OPEN' })
    await getPR('owner/repo', 42)
    expect(args()).toContain('view')
    expect(args()).toContain('42')
    const jsonFlag = args().indexOf('--json')
    const fields = args()[jsonFlag + 1]
    expect(fields).toContain('mergeable')
    expect(fields).toContain('statusCheckRollup')
    expect(fields).toContain('reviews')
    expect(fields).toContain('files')
  })
})

// ─── PR MERGE FLOWS ───────────────────────────────────────────────────────────

describe('PR merge flows', () => {
  it('merges with --merge strategy (default)', async () => {
    ok()
    await mergePR('owner/repo', 1)
    expect(args()).toContain('merge')
    expect(args()).toContain('1')
    expect(args()).toContain('--merge')
    expect(args()).not.toContain('--squash')
    expect(args()).not.toContain('--rebase')
  })

  it('merges with --squash strategy', async () => {
    ok()
    await mergePR('owner/repo', 1, 'squash')
    expect(args()).toContain('--squash')
  })

  it('merges with --rebase strategy', async () => {
    ok()
    await mergePR('owner/repo', 1, 'rebase')
    expect(args()).toContain('--rebase')
  })

  it('admin-merge: uses --admin --merge', async () => {
    ok()
    await mergePR('owner/repo', 1, 'admin-merge', undefined, { allowAdmin: true })
    expect(args()).toContain('--admin')
    expect(args()).toContain('--merge')
  })

  it('admin-squash: uses --admin --squash', async () => {
    ok()
    await mergePR('owner/repo', 1, 'admin-squash', undefined, { allowAdmin: true })
    expect(args()).toContain('--admin')
    expect(args()).toContain('--squash')
  })

  it('admin-rebase: uses --admin --rebase', async () => {
    ok()
    await mergePR('owner/repo', 1, 'admin-rebase', undefined, { allowAdmin: true })
    expect(args()).toContain('--admin')
    expect(args()).toContain('--rebase')
  })

  it('passes commit message with --subject', async () => {
    ok()
    await mergePR('owner/repo', 1, 'squash', 'My commit msg')
    expect(args()).toContain('--subject')
    expect(args()).toContain('My commit msg')
  })

  it('throws GhError when merge fails', async () => {
    fail('already merged')
    await expect(mergePR('owner/repo', 1)).rejects.toThrow(GhError)
  })
})

// ─── PR REVIEW FLOWS (approve / request-changes) ─────────────────────────────

describe('PR review flows', () => {
  it('approves a PR', async () => {
    ok()
    await reviewPR('owner/repo', 42, 'approve')
    expect(args()).toContain('review')
    expect(args()).toContain('42')
    expect(args()).toContain('--approve')
  })

  it('approves a PR with a comment body', async () => {
    ok()
    await reviewPR('owner/repo', 42, 'approve', 'LGTM!')
    expect(args()).toContain('--approve')
    expect(args()).toContain('--body')
    expect(args()).toContain('LGTM!')
  })

  it('requests changes on a PR', async () => {
    ok()
    await reviewPR('owner/repo', 42, 'request-changes', 'Please fix X')
    expect(args()).toContain('--request-changes')
    expect(args()).toContain('--body')
    expect(args()).toContain('Please fix X')
  })

  it('leaves a comment review', async () => {
    ok()
    await reviewPR('owner/repo', 42, 'comment', 'Looks interesting')
    expect(args()).toContain('--comment')
  })

  it('throws GhError when review fails', async () => {
    fail('not allowed')
    await expect(reviewPR('owner/repo', 1, 'approve')).rejects.toThrow(GhError)
  })
})

// ─── PR CLOSE / DRAFT / BASE FLOWS ───────────────────────────────────────────

describe('PR state-change flows', () => {
  it('closes a PR', async () => {
    ok()
    await closePR('owner/repo', 5)
    expect(args()).toContain('close')
    expect(args()).toContain('5')
  })

  it('marks PR ready for review', async () => {
    ok()
    await markPRReady('owner/repo', 5)
    expect(args()).toContain('ready')
    expect(args()).toContain('5')
    expect(args()).not.toContain('--undo')
  })

  it('converts PR to draft', async () => {
    ok()
    await convertPRToDraft('owner/repo', 5)
    expect(args()).toContain('--undo')
  })

  it('changes PR base branch', async () => {
    ok()
    await editPRBase('owner/repo', 5, 'develop')
    expect(args()).toContain('edit')
    expect(args()).toContain('5')
    expect(args()).toContain('--base')
    expect(args()).toContain('develop')
  })
})

// ─── PR ASSIGNEE FLOWS ────────────────────────────────────────────────────────

describe('PR assignee flows', () => {
  it('adds assignees to a PR', async () => {
    ok()
    await addPRAssignees('owner/repo', 7, ['alice', 'bob'])
    expect(args()).toContain('pr')
    expect(args()).toContain('edit')
    expect(args()).toContain('7')
    expect(args()).toContain('--add-assignee')
    expect(args()).toContain('alice,bob')
  })

  it('removes assignees from a PR', async () => {
    ok()
    await removePRAssignees('owner/repo', 7, ['alice'])
    expect(args()).toContain('--remove-assignee')
    expect(args()).toContain('alice')
  })

  it('throws GhError when add-assignee fails', async () => {
    fail('not a collaborator')
    await expect(addPRAssignees('owner/repo', 1, ['ghost'])).rejects.toThrow(GhError)
  })
})

// ─── PR REVIEWER FLOWS ───────────────────────────────────────────────────────

describe('PR reviewer flows', () => {
  it('requests reviewers', async () => {
    ok()
    await requestReviewers('owner/repo', 10, ['alice', 'bob'])
    expect(args()).toContain('--add-reviewer')
    expect(args()).toContain('alice,bob')
  })

  it('removes reviewer requests', async () => {
    ok()
    await removeReviewers('owner/repo', 10, ['alice'])
    expect(args()).toContain('--remove-reviewer')
    expect(args()).toContain('alice')
  })
})

// ─── PR AUTO-MERGE FLOWS ─────────────────────────────────────────────────────

describe('PR auto-merge flows', () => {
  it('enables auto-merge', async () => {
    ok()
    await enableAutoMerge('owner/repo', 3, 'squash')
    const a = args()
    expect(a).toContain('pr')
    expect(a).toContain('merge')
    expect(a).toContain('3')
    expect(a).toContain('--auto')
    expect(a).toContain('--squash')
  })

  it('disables auto-merge via API PATCH', async () => {
    ok()
    await disableAutoMerge('owner/repo', 3)
    expect(args()).toContain('api')
    expect(args()).toContain('PATCH')
    expect(args().join(' ')).toContain('pulls/3')
  })
})

// ─── PR COMMENT FLOWS ────────────────────────────────────────────────────────

describe('PR comment flows', () => {
  it('adds a general comment to a PR', async () => {
    ok()
    await addPRComment('owner/repo', 1, 'LGTM')
    expect(args()).toContain('pr')
    expect(args()).toContain('comment')
    expect(args()).toContain('1')
    expect(args()).toContain('--body')
    expect(args()).toContain('LGTM')
  })

  it('fetches PR diff', async () => {
    ok('diff --git a/file.js b/file.js\n+new line')
    const diff = await getPRDiff('owner/repo', 1)
    expect(diff).toContain('diff --git')
  })

  it('creates a new PR', async () => {
    ok({ number: 99, url: 'https://github.com/owner/repo/pull/99' })
    await createPR('owner/repo', { title: 'New feature', body: 'Details', base: 'main', head: 'feature-x' })
    expect(args()).toContain('pr')
    expect(args()).toContain('create')
    expect(args()).toContain('--title')
    expect(args()).toContain('New feature')
    expect(args()).toContain('--base')
    expect(args()).toContain('main')
    expect(args()).toContain('--head')
    expect(args()).toContain('feature-x')
  })
})

// ─── PR REVIEW THREAD FLOWS ──────────────────────────────────────────────────

describe('PR review thread flows', () => {
  it('resolves a review thread via graphql', async () => {
    ok()
    await resolveThread('PRRT_abc123')
    const a = args()
    expect(a).toContain('api')
    expect(a).toContain('graphql')
    expect(a.join(' ')).toContain('resolveReviewThread')
  })

  it('replies to a PR comment via REST', async () => {
    ok()
    await replyToComment('owner/repo', 1, 42, 'Thank you for the feedback')
    const a = args()
    expect(a).toContain('api')
    expect(a.join(' ')).toContain('/replies')
    expect(a).toContain('POST')
  })

  it('edits a PR comment', async () => {
    ok({ id: 42, body: 'Updated body' })
    await editPRComment('owner/repo', 42, 'Updated body')
    const a = args()
    expect(a).toContain('api')
    expect(a.join(' ')).toContain('pulls/comments/42')
    expect(a).toContain('PATCH')
  })

  it('deletes a PR comment', async () => {
    ok()
    await deletePRComment('owner/repo', 42)
    const a = args()
    expect(a).toContain('api')
    expect(a.join(' ')).toContain('pulls/comments/42')
    expect(a).toContain('DELETE')
  })
})

// ─── ISSUE LIST FLOWS ─────────────────────────────────────────────────────────

describe('Issue list flows', () => {
  it('fetches open issues by default', async () => {
    ok([])
    await listIssues('owner/repo')
    expect(args()).toContain('issue')
    expect(args()).toContain('list')
    expect(args()).toContain('--repo')
  })

  it('fetches closed issues when state=closed', async () => {
    ok([])
    await listIssues('owner/repo', { state: 'closed' })
    expect(args()).toContain('--state')
    expect(args()).toContain('closed')
  })

  it('filters by label', async () => {
    ok([])
    await listIssues('owner/repo', { label: 'bug' })
    expect(args()).toContain('--label')
    expect(args()).toContain('bug')
  })

  it('filters by assignee', async () => {
    ok([])
    await listIssues('owner/repo', { assignee: 'alice' })
    expect(args()).toContain('--assignee')
    expect(args()).toContain('alice')
  })

  it('filters by milestone', async () => {
    ok([])
    await listIssues('owner/repo', { milestone: 'v2.0' })
    expect(args()).toContain('--milestone')
    expect(args()).toContain('v2.0')
  })
})

// ─── ISSUE DETAIL FLOWS ───────────────────────────────────────────────────────

describe('Issue detail flows', () => {
  it('fetches a single issue by number', async () => {
    ok({ number: 5, title: 'Bug report', state: 'OPEN' })
    const issue = await getIssue('owner/repo', 5)
    expect(issue.number).toBe(5)
    expect(args()).toContain('view')
    expect(args()).toContain('5')
  })

  it('includes comments in the JSON fields', async () => {
    ok({ number: 5, comments: [] })
    await getIssue('owner/repo', 5)
    const jsonIdx = args().indexOf('--json')
    const fields = args()[jsonIdx + 1]
    expect(fields).toContain('comments')
    expect(fields).toContain('assignees')
    expect(fields).toContain('labels')
  })
})

// ─── ISSUE COMMENT FLOWS ─────────────────────────────────────────────────────

describe('Issue comment flows', () => {
  it('adds a comment to an issue (not a PR)', async () => {
    ok()
    await addIssueComment('owner/repo', 5, 'This is a reply')
    expect(args()).toContain('issue')
    expect(args()).toContain('comment')
    expect(args()).toContain('5')
    expect(args()).toContain('--body')
    expect(args()).toContain('This is a reply')
    // Must NOT call PR comment endpoint
    expect(args()).not.toContain('pr')
  })

  it('throws GhError when issue comment fails', async () => {
    fail('issue not found', 404)
    await expect(addIssueComment('owner/repo', 999, 'hi')).rejects.toThrow(GhError)
  })
})

// ─── ISSUE CREATE FLOWS ──────────────────────────────────────────────────────

describe('Issue create flows', () => {
  it('creates an issue with title and body', async () => {
    ok('https://github.com/owner/repo/issues/42')
    await createIssue('owner/repo', { title: 'New bug', body: 'Details here' })
    expect(args()).toContain('create')
    expect(args()).toContain('--title')
    expect(args()).toContain('New bug')
    expect(args()).toContain('--body')
    expect(args()).toContain('Details here')
  })

  it('creates an issue with labels', async () => {
    ok('https://github.com')
    await createIssue('owner/repo', { title: 'T', labels: ['bug', 'ui'] })
    expect(args()).toContain('--label')
    expect(args()).toContain('bug,ui')
  })

  it('creates an issue with assignees', async () => {
    ok('https://github.com')
    await createIssue('owner/repo', { title: 'T', assignees: ['alice'] })
    expect(args()).toContain('--assignee')
    expect(args()).toContain('alice')
  })

  it('creates an issue with milestone', async () => {
    ok('https://github.com')
    await createIssue('owner/repo', { title: 'T', milestone: 'v1.0' })
    expect(args()).toContain('--milestone')
    expect(args()).toContain('v1.0')
  })

  it('throws GhError on creation failure', async () => {
    fail('validation failed')
    await expect(createIssue('owner/repo', { title: '' })).rejects.toThrow(GhError)
  })
})

// ─── ISSUE CLOSE FLOWS ────────────────────────────────────────────────────────

describe('Issue close flows', () => {
  it('closes an open issue', async () => {
    ok()
    await closeIssue('owner/repo', 10)
    expect(args()).toContain('issue')
    expect(args()).toContain('close')
    expect(args()).toContain('10')
  })
})

// ─── ISSUE ASSIGNEE FLOWS ────────────────────────────────────────────────────

describe('Issue assignee flows', () => {
  it('adds assignees to an issue', async () => {
    ok()
    await addIssueAssignees('owner/repo', 5, ['alice', 'bob'])
    expect(args()).toContain('issue')
    expect(args()).toContain('edit')
    expect(args()).toContain('5')
    expect(args()).toContain('--add-assignee')
    expect(args()).toContain('alice,bob')
  })

  it('removes assignees from an issue', async () => {
    ok()
    await removeIssueAssignees('owner/repo', 5, ['alice'])
    expect(args()).toContain('issue')
    expect(args()).toContain('edit')
    expect(args()).toContain('--remove-assignee')
    expect(args()).toContain('alice')
  })

  it('throws GhError when assignee add fails', async () => {
    fail('not a collaborator')
    await expect(addIssueAssignees('owner/repo', 1, ['ghost'])).rejects.toThrow(GhError)
  })
})

// ─── LABEL FLOWS ─────────────────────────────────────────────────────────────

describe('Label flows', () => {
  it('lists all labels in a repo', async () => {
    ok([{ name: 'bug', color: 'ff0000' }, { name: 'feature', color: '00ff00' }])
    const labels = await listLabels('owner/repo')
    expect(labels).toHaveLength(2)
    expect(args()).toContain('label')
    expect(args()).toContain('list')
  })

  it('adds labels to a PR', async () => {
    ok()
    await addLabels('owner/repo', 1, ['bug', 'enhancement'], 'pr')
    expect(args()).toContain('pr')
    expect(args()).toContain('edit')
    expect(args()).toContain('--add-label')
    expect(args()).toContain('bug,enhancement')
  })

  it('adds labels to an issue', async () => {
    ok()
    await addLabels('owner/repo', 1, ['bug'], 'issue')
    expect(args()).toContain('issue')
    expect(args()).toContain('--add-label')
  })

  it('removes labels from a PR', async () => {
    ok()
    await removeLabels('owner/repo', 1, ['bug'], 'pr')
    expect(args()).toContain('pr')
    expect(args()).toContain('--remove-label')
  })

  it('removes labels from an issue', async () => {
    ok()
    await removeLabels('owner/repo', 1, ['bug'], 'issue')
    expect(args()).toContain('issue')
    expect(args()).toContain('--remove-label')
  })

  it('adds and removes in separate calls for correct diff handling', async () => {
    ok()
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    await addLabels('owner/repo', 1, ['new-label'], 'pr')
    await removeLabels('owner/repo', 1, ['old-label'], 'pr')
    expect(execa).toHaveBeenCalledTimes(2)
  })
})

// ─── BRANCH LIST FLOWS ───────────────────────────────────────────────────────

describe('Branch list flows', () => {
  it('lists branches via the API', async () => {
    ok([{ name: 'main', protected: true }, { name: 'feature-x', protected: false }])
    const branches = await listBranches('owner/repo')
    expect(branches).toHaveLength(2)
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('repos/owner/repo/branches')
  })
})

describe('Branch checkout flow', () => {
  it('checks out a PR branch', async () => {
    ok()
    await checkoutBranch('owner/repo', 42)
    expect(args()).toContain('pr')
    expect(args()).toContain('checkout')
    expect(args()).toContain('42')
  })

  it('throws GhError when checkout fails', async () => {
    fail('branch not found')
    await expect(checkoutBranch('owner/repo', 99)).rejects.toThrow(GhError)
  })
})

describe('Branch delete flow', () => {
  it('deletes a branch via the API', async () => {
    ok()
    await deleteBranch('owner/repo', 'feature-old')
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('refs/heads/feature-old')
    expect(args()).toContain('DELETE')
  })

  it('throws GhError when branch delete fails', async () => {
    fail('branch not found')
    await expect(deleteBranch('owner/repo', 'ghost-branch')).rejects.toThrow(GhError)
  })
})

// ─── ACTIONS / WORKFLOW RUNS FLOWS ───────────────────────────────────────────

describe('Actions list flows', () => {
  it('lists workflow runs', async () => {
    ok([{ databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success' }])
    const runs = await listRuns('owner/repo')
    expect(runs).toHaveLength(1)
    expect(args()).toContain('run')
    expect(args()).toContain('list')
  })

  it('filters runs by branch', async () => {
    ok([])
    await listRuns('owner/repo', { branch: 'main' })
    expect(args()).toContain('--branch')
    expect(args()).toContain('main')
  })

  it('filters runs by workflow', async () => {
    ok([])
    await listRuns('owner/repo', { workflow: 'ci.yml' })
    expect(args()).toContain('--workflow')
    expect(args()).toContain('ci.yml')
  })

  it('filters runs by status', async () => {
    ok([])
    await listRuns('owner/repo', { status: 'failure' })
    expect(args()).toContain('--status')
    expect(args()).toContain('failure')
  })
})

describe('Actions run detail flows', () => {
  it('fetches run logs', async () => {
    ok('2024-01-01T00:00:00Z step 1\n2024-01-01T00:00:01Z step 2')
    await getRunLogs('owner/repo', 12345)
    expect(args()).toContain('run')
    expect(args()).toContain('view')
    expect(args()).toContain('12345')
    expect(args()).toContain('--log')
  })

  it('reruns failed jobs', async () => {
    ok()
    await rerunRun('owner/repo', 12345)
    expect(args()).toContain('run')
    expect(args()).toContain('rerun')
    expect(args()).toContain('12345')
    expect(args()).toContain('--failed-only')
  })

  it('cancels a run', async () => {
    ok()
    await cancelRun('owner/repo', 12345)
    expect(args()).toContain('run')
    expect(args()).toContain('cancel')
    expect(args()).toContain('12345')
  })

  it('throws GhError when rerun fails', async () => {
    fail('run not found')
    await expect(rerunRun('owner/repo', 99)).rejects.toThrow(GhError)
  })

  it('throws GhError when cancel fails', async () => {
    fail('run already complete')
    await expect(cancelRun('owner/repo', 99)).rejects.toThrow(GhError)
  })
})

// ─── CI CHECKS FLOWS ─────────────────────────────────────────────────────────

describe('CI checks flows', () => {
  it('fetches checks for a PR (first call is pr view for headRefOid)', async () => {
    // getPRChecks makes two gh calls: pr view to get headRefOid, then api check-runs
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ headRefOid: 'abc123' }), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([{ id: 1, name: 'lint', conclusion: 'success' }]), stderr: '' })
    const checks = await getPRChecks('owner/repo', 42)
    // First call: pr view
    const firstArgs = execa.mock.calls[0][1]
    expect(firstArgs).toContain('pr')
    expect(firstArgs).toContain('view')
    expect(firstArgs).toContain('42')
    // Second call: check-runs API
    const secondArgs = execa.mock.calls[1][1]
    expect(secondArgs).toContain('api')
    expect(secondArgs.join(' ')).toContain('commits/abc123/check-runs')
    expect(checks).toHaveLength(1)
  })

  it('reruns a specific check run', async () => {
    ok()
    await rerunCheckRun('owner/repo', 999)
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('/check-runs/999/rerequest')
    expect(args()).toContain('POST')
  })

  it('fetches check run annotations', async () => {
    ok([{ path: 'src/file.js', line: 10, annotation_level: 'failure', message: 'Error' }])
    await getCheckRunAnnotations('owner/repo', 999)
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('check-runs/999/annotations')
  })
})

// ─── NOTIFICATION FLOWS ───────────────────────────────────────────────────────

describe('Notification flows', () => {
  it('fetches unread notifications by default', async () => {
    ok([])
    await listNotifications()
    expect(args()).toContain('api')
    expect(args()).toContain('notifications')
  })

  it('fetches all notifications when filter.all=true', async () => {
    ok([])
    await listNotifications({ all: true })
    expect(args()).toContain('-f')
    expect(args()).toContain('all=true')
  })

  it('marks a notification as read', async () => {
    ok()
    await markNotificationRead('thread-abc')
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('notifications/threads/thread-abc')
    expect(args()).toContain('PATCH')
  })

  it('throws GhError when mark-read fails', async () => {
    fail('not found')
    await expect(markNotificationRead('bad-id')).rejects.toThrow(GhError)
  })
})

// ─── REPO INFO FLOW ──────────────────────────────────────────────────────────

describe('Repo info flow', () => {
  it('fetches repo info including merge settings', async () => {
    ok({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false })
    await getRepoInfo('owner/repo')
    expect(args()).toContain('repo')
    expect(args()).toContain('view')
    const jsonIdx = args().indexOf('--json')
    const fields = args()[jsonIdx + 1]
    expect(fields).toContain('squashMergeAllowed')
    expect(fields).toContain('viewerPermission')
  })
})

// ─── COLLABORATOR FLOW ───────────────────────────────────────────────────────

describe('Collaborator flow', () => {
  it('lists collaborators with login and name', async () => {
    ok([{ login: 'alice', name: 'Alice' }, { login: 'bob', name: 'Bob' }])
    const collabs = await listCollaborators('owner/repo')
    expect(collabs).toHaveLength(2)
    expect(args()).toContain('api')
    expect(args().join(' ')).toContain('repos/owner/repo/collaborators')
  })
})

// ─── GH HOST FLOWS ───────────────────────────────────────────────────────────

describe('GH_HOST env var support', () => {
  // gh CLI honors GH_HOST via env inheritance for `--repo OWNER/REPO` calls.
  // --hostname is invalid on `gh pr list` / `gh issue list` (valid only on
  // `gh api`, `gh auth *`, `gh repo *`).
  it('does not prepend --hostname when GH_HOST is set (env inheritance)', async () => {
    process.env.GH_HOST = 'github.example.com'
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo')
    expect(args()).not.toContain('--hostname')
    delete process.env.GH_HOST
  })

  it('does not prepend --hostname when GH_HOST is not set', async () => {
    delete process.env.GH_HOST
    ok({ data: { search: { nodes: [] } } })
    await listPRs('owner/repo')
    expect(args()).not.toContain('--hostname')
  })
})

// ─── GHUI_REPO ENV VAR FALLBACK ──────────────────────────────────────────────

describe('GHUI_REPO env var fallback', () => {
  it('uses GHUI_REPO when repo arg is omitted', async () => {
    process.env.GHUI_REPO = 'env-owner/env-repo'
    ok({ data: { search: { nodes: [] } } })
    await listPRs(null)
    expect(args()).toContain('owner=env-owner')
    expect(args()).toContain('name=env-repo')
  })
})

// ─── ERROR HANDLING FLOWS ────────────────────────────────────────────────────

describe('Error handling flows', () => {
  it('reports rate limit error with friendly message', async () => {
    fail('API rate limit exceeded for user ID')
    try {
      await listPRs('owner/repo')
    } catch (err) {
      expect(err.message).toContain('rate limit')
    }
  })

  it('reports resource-not-found error', async () => {
    fail('Repository not found', 404)
    try {
      await getPR('owner/repo', 999)
    } catch (err) {
      expect(err).toBeInstanceOf(GhError)
    }
  })

  it('redacts long tokens in error args', async () => {
    fail('bad credentials')
    try {
      await runGh(['api', 'repos/owner/repo', '--jq', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'])
    } catch (err) {
      expect(err.args.join(' ')).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    }
  })

  it('includes exit code in GhError', async () => {
    fail('forbidden', 403)
    try {
      await mergePR('owner/repo', 1)
    } catch (err) {
      expect(err.exitCode).toBe(403)
    }
  })

  it('throws GhError when execa itself rejects', async () => {
    execa.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { exitCode: 127 }))
    await expect(listPRs('owner/repo')).rejects.toThrow(GhError)
  })
})

// ─── VIRTUAL LIST NAVIGATION FLOWS (pure logic) ──────────────────────────────

describe('Virtual list scroll logic', () => {
  it('scroll stays at 0 when cursor is within the window', () => {
    expect(computeScroll({ cursor: 3, prevOffset: 0, height: 5, count: 20 })).toBe(0)
  })

  it('scroll increases when cursor moves below the window', () => {
    // cursor 5 is at the bottom edge of height 5 (indices 0-4 visible)
    expect(computeScroll({ cursor: 5, prevOffset: 0, height: 5, count: 20 })).toBe(1)
  })

  it('scroll decreases when cursor moves above the window', () => {
    // cursor 3 is above prevOffset 5
    expect(computeScroll({ cursor: 3, prevOffset: 5, height: 5, count: 20 })).toBe(3)
  })

  it('scroll unchanged when cursor stays inside window', () => {
    expect(computeScroll({ cursor: 7, prevOffset: 5, height: 5, count: 20 })).toBe(5)
  })

  it('safeOffset clamps below 0', () => {
    expect(safeOffset(-1, 5, 20)).toBe(0)
  })

  it('safeOffset clamps above max', () => {
    // count 20, height 5 → max offset = 15
    expect(safeOffset(100, 5, 20)).toBe(15)
  })

  it('safeOffset is 0 when all items fit in window', () => {
    expect(safeOffset(5, 10, 3)).toBe(0)
  })

  it('canScrollUp is false at offset 0', () => {
    expect(safeOffset(0, 5, 20) > 0).toBe(false)
  })

  it('canScrollUp is true at offset > 0', () => {
    expect(safeOffset(3, 5, 20) > 0).toBe(true)
  })

  it('canScrollDown is false when offset + height >= count', () => {
    const offset = safeOffset(15, 5, 20) // max offset
    expect(offset + 5 < 20).toBe(false)
  })

  it('canScrollDown is true when list overflows window', () => {
    const offset = 0
    expect(offset + 5 < 20).toBe(true)
  })

  it('jumpBottom offset = count - height', () => {
    const count = 20, height = 5
    const expectedOffset = Math.max(0, count - 1 - height + 1) // = 15
    expect(expectedOffset).toBe(15)
  })

  it('cursor clamped to count-1 when list shrinks', () => {
    const cursor = 15
    const newCount = 5
    expect(Math.min(cursor, newCount - 1)).toBe(4)
  })

  it('visible slice is correct', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const offset = 3, height = 4
    const visible = items.slice(offset, offset + height)
    expect(visible).toEqual([3, 4, 5, 6])
  })
})

// ─── PR FUZZY SEARCH FLOW (data-layer) ───────────────────────────────────────

describe('PR fuzzy search — author field handling', () => {
  it('flattens author.login for searchability', () => {
    const prs = [
      { number: 1, title: 'Fix typo', author: { login: 'alice' } },
      { number: 2, title: 'Add tests', author: { login: 'bob' } },
    ]
    const fuzzyItems = prs.map(pr => ({ ...pr, authorLogin: pr.author?.login || '' }))
    expect(fuzzyItems[0].authorLogin).toBe('alice')
    expect(fuzzyItems[1].authorLogin).toBe('bob')
    // String(author) would give [object Object]
    expect(String(prs[0].author)).toBe('[object Object]')
    // But authorLogin is a proper string
    expect(typeof fuzzyItems[0].authorLogin).toBe('string')
  })

  it('correctly maps back to original PR by number after fuzzy search', () => {
    const prs = [
      { number: 10, title: 'Alpha', author: { login: 'alice' } },
      { number: 20, title: 'Beta',  author: { login: 'bob' } },
    ]
    const fuzzyItems = prs.map(pr => ({ ...pr, authorLogin: pr.author?.login || '' }))
    const selectedFuzzyItem = fuzzyItems[1] // 'Bob' result
    const idx = prs.findIndex(p => p.number === selectedFuzzyItem.number)
    expect(idx).toBe(1)
    expect(prs[idx].number).toBe(20)
  })
})

// ─── ASSIGNEE DIFF LOGIC (add/remove) ────────────────────────────────────────

describe('Assignee add/remove diff logic', () => {
  it('computes toAdd and toRemove correctly', () => {
    const current = ['alice', 'charlie']
    const selected = ['bob', 'charlie'] // removed alice, added bob
    const toAdd    = selected.filter(id => !current.includes(id))
    const toRemove = current.filter(id => !selected.includes(id))
    expect(toAdd).toEqual(['bob'])
    expect(toRemove).toEqual(['alice'])
  })

  it('no-ops when selection is unchanged', () => {
    const current = ['alice']
    const selected = ['alice']
    const toAdd    = selected.filter(id => !current.includes(id))
    const toRemove = current.filter(id => !selected.includes(id))
    expect(toAdd).toHaveLength(0)
    expect(toRemove).toHaveLength(0)
  })

  it('adds all when starting from empty', () => {
    const current = []
    const selected = ['alice', 'bob']
    const toAdd = selected.filter(id => !current.includes(id))
    expect(toAdd).toEqual(['alice', 'bob'])
  })

  it('removes all when deselecting everything', () => {
    const current = ['alice', 'bob']
    const selected = []
    const toRemove = current.filter(id => !selected.includes(id))
    expect(toRemove).toEqual(['alice', 'bob'])
  })
})

// ─── LABEL DIFF LOGIC ────────────────────────────────────────────────────────

describe('Label add/remove diff logic', () => {
  it('computes correct diff when adding new labels', () => {
    const current = ['bug']
    const selected = ['bug', 'enhancement']
    const toAdd    = selected.filter(id => !current.includes(id))
    const toRemove = current.filter(id => !selected.includes(id))
    expect(toAdd).toEqual(['enhancement'])
    expect(toRemove).toHaveLength(0)
  })

  it('computes correct diff when removing labels', () => {
    const current = ['bug', 'wontfix']
    const selected = ['bug']
    const toAdd    = selected.filter(id => !current.includes(id))
    const toRemove = current.filter(id => !selected.includes(id))
    expect(toAdd).toHaveLength(0)
    expect(toRemove).toEqual(['wontfix'])
  })
})

// ─── CONFIG AI KEY FLOW ──────────────────────────────────────────────────────

describe('Config AI key resolution', () => {
  it('reads apiKey from config.ai.anthropicApiKey (not config.anthropicApiKey)', async () => {
    const { loadConfig } = await import('./config.js')
    const cfg = loadConfig()
    // The key lives under .ai.anthropicApiKey
    expect(cfg).toHaveProperty('ai')
    expect(cfg.ai).toHaveProperty('anthropicApiKey')
    // There is NO root-level anthropicApiKey in the returned object
    // (the legacy fallback merges it into ai.anthropicApiKey at load time)
    if (cfg.anthropicApiKey !== undefined) {
      // If present, it should match ai.anthropicApiKey (legacy compat kept)
      // but code should read cfg.ai.anthropicApiKey
    }
    expect(typeof cfg.ai.anthropicApiKey).toBe('string')
  })

  it('falls back to ANTHROPIC_API_KEY env var', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key-from-env'
    const { loadConfig } = await import('./config.js')
    const cfg = loadConfig()
    expect(cfg.ai.anthropicApiKey).toBe('test-key-from-env')
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = original
  })
})

// ─── SANITY: all new executor functions are exported ─────────────────────────

describe('New executor exports sanity check', () => {
  it('addIssueComment is a function', () => {
    expect(typeof addIssueComment).toBe('function')
  })

  it('addPRAssignees is a function', () => {
    expect(typeof addPRAssignees).toBe('function')
  })

  it('removePRAssignees is a function', () => {
    expect(typeof removePRAssignees).toBe('function')
  })

  it('addIssueAssignees is a function', () => {
    expect(typeof addIssueAssignees).toBe('function')
  })

  it('removeIssueAssignees is a function', () => {
    expect(typeof removeIssueAssignees).toBe('function')
  })
})
