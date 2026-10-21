#!/usr/bin/env node
// Fixture-only stand-in for the GitHub CLI, used by `npm run demo` (scripts/demo.mjs)
// so recordings are deterministic and never touch real GitHub data.
// Modelled on the inline stub in test/pty/run.js; watch-only data reuses
// src/watch-only/fixtures/pr-activity.json. Unknown commands print `[]`.
// Set LAZYHUB_DEMO_GH_LOG=<file> to log every invocation while extending fixtures.
import { appendFileSync, readFileSync } from 'node:fs'

const REPO = 'acme/rocket'
const args = process.argv.slice(2)
if (process.env.LAZYHUB_DEMO_GH_LOG) appendFileSync(process.env.LAZYHUB_DEMO_GH_LOG, `${args.map(a => a.slice(0, 80)).join(' ')}\n`)

const ago = hours => new Date(Date.now() - hours * 3600e3).toISOString()
const out = value => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0) }
const gql = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)

const check = (name, conclusion) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, startedAt: ago(3), completedAt: ago(2.9) })
const pending = name => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: null, startedAt: ago(0.2), completedAt: null })
const LABELS = { bug: 'd73a4a', feature: '0e8a16', infra: '5319e7', deps: '0366d6' }
const labels = (...names) => names.map(name => ({ name, color: LABELS[name] }))

const PRS = [
  { number: 142, title: 'feat(guidance): add closed-loop attitude controller', author: 'maria-lopez', labels: labels('feature'), head: 'feat/attitude-ctrl', draft: false, decision: 'APPROVED', checks: [check('build', 'SUCCESS'), check('unit', 'SUCCESS'), check('lint', 'SUCCESS')], age: 2 },
  { number: 141, title: 'fix(telemetry): drop duplicate frames on reconnect', author: 'dev-agent[bot]', labels: labels('bug'), head: 'agent/telemetry-dedupe', draft: false, decision: 'REVIEW_REQUIRED', checks: [check('build', 'SUCCESS'), check('unit', 'FAILURE'), pending('integration')], age: 5 },
  { number: 139, title: 'chore(deps): bump serde from 1.0.201 to 1.0.203', author: 'dependabot[bot]', labels: labels('deps'), head: 'dependabot/cargo/serde-1.0.203', draft: false, decision: null, checks: [check('build', 'SUCCESS'), check('unit', 'SUCCESS')], age: 20 },
  { number: 137, title: 'refactor(launch): split sequencer into stages', author: 'jin-park', labels: labels('infra'), head: 'refactor/sequencer', draft: true, decision: null, checks: [pending('build')], age: 30 },
  { number: 134, title: 'docs: document fuel-budget invariants', author: 'sam-okafor', labels: [], head: 'docs/fuel-budget', draft: false, decision: 'CHANGES_REQUESTED', checks: [check('build', 'SUCCESS'), check('lint', 'FAILURE')], age: 52 },
  { number: 131, title: 'ci: cache cargo registry between jobs', author: 'maria-lopez', labels: labels('infra'), head: 'ci/cargo-cache', draft: false, decision: 'APPROVED', checks: [check('build', 'SUCCESS'), check('unit', 'SUCCESS')], age: 77 },
]
const prNode = p => ({
  __typename: 'PullRequest', number: p.number, title: p.title, state: 'OPEN', author: { login: p.author },
  labels: { nodes: p.labels }, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'sam-okafor', name: 'Sam Okafor' } }] },
  statusCheckRollup: { nodes: p.checks }, reviewDecision: p.decision, updatedAt: ago(p.age), isDraft: p.draft,
  headRefName: p.head, baseRefName: 'main', assignees: { nodes: [] }, mergeable: 'MERGEABLE', autoMergeRequest: null,
  body: `## Summary\n\n${p.title}\n\n## Test plan\n\n- [x] cargo test\n- [ ] hardware-in-loop run`,
  url: `https://github.com/${REPO}/pull/${p.number}`,
})
const prView = p => ({
  ...prNode(p), labels: p.labels, author: { login: p.author }, reviewRequests: [{ login: 'sam-okafor', name: 'Sam Okafor' }], assignees: [],
  statusCheckRollup: p.checks.map(c => ({ name: c.name, state: c.status, status: c.status, conclusion: c.conclusion })),
  reviews: p.decision === 'APPROVED' ? [{ author: { login: 'sam-okafor' }, state: 'APPROVED', body: 'Looks good.', submittedAt: ago(1) }] : [],
  files: [{ path: 'src/guidance/attitude.rs', additions: 18, deletions: 2 }, { path: 'src/guidance/mod.rs', additions: 1, deletions: 0 }],
  additions: 19, deletions: 2, changedFiles: 2, mergeStateStatus: 'CLEAN', headRefOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
})
const DIFF = `diff --git a/src/guidance/attitude.rs b/src/guidance/attitude.rs
index 3f2a1c0..9b7d4e2 100644
--- a/src/guidance/attitude.rs
+++ b/src/guidance/attitude.rs
@@ -10,8 +10,24 @@ pub struct Attitude {
     pub pitch: f64,
     pub roll: f64,
     pub yaw: f64,
 }

-pub fn correct(a: &Attitude) -> Attitude {
-    a.clone()
-}
+/// Proportional correction toward the commanded attitude.
+pub fn correct(a: &Attitude, target: &Attitude, gains: &Gains) -> Attitude {
+    let err = Attitude {
+        pitch: target.pitch - a.pitch,
+        roll: target.roll - a.roll,
+        yaw: target.yaw - a.yaw,
+    };
+    Attitude {
+        pitch: a.pitch + gains.kp * err.pitch,
+        roll: a.roll + gains.kp * err.roll,
+        yaw: a.yaw + gains.kp * err.yaw,
+    }
+}
+
+pub struct Gains {
+    pub kp: f64,
+    pub kd: f64,
+}
diff --git a/src/guidance/mod.rs b/src/guidance/mod.rs
index 7c1e0aa..2d9f3b1 100644
--- a/src/guidance/mod.rs
+++ b/src/guidance/mod.rs
@@ -1,3 +1,4 @@
 pub mod nav;
+pub mod attitude;
 pub mod thrust;
`

const ISSUES = [
  { number: 88, title: 'Telemetry stream stalls after 10k frames', author: 'jin-park', labels: [{ name: 'bug', color: LABELS.bug }], comments: 4, age: 6 },
  { number: 86, title: 'Support configurable burn profiles', author: 'maria-lopez', labels: [{ name: 'feature', color: LABELS.feature }], comments: 9, age: 28 },
  { number: 83, title: 'Flaky hardware-in-loop test on CI', author: 'sam-okafor', labels: [{ name: 'infra', color: LABELS.infra }], comments: 2, age: 50 },
  { number: 79, title: 'Document the launch sequencer state machine', author: 'dev-agent[bot]', labels: [], comments: 0, age: 96 },
]
const issueView = i => ({ number: i.number, title: i.title, state: 'OPEN', author: { login: i.author }, labels: i.labels, assignees: [], updatedAt: ago(i.age), body: `${i.title}.\n\nSteps to reproduce are in the linked thread.`, milestone: null, comments: [], url: `https://github.com/${REPO}/issues/${i.number}` })
const issueList = i => ({ ...issueView(i), comments: Array.from({ length: i.comments }, () => ({})) })

const RUNS = [
  ['CI', 'success', 'main', 'push', 1], ['CI', 'failure', 'agent/telemetry-dedupe', 'pull_request', 5], ['Release', 'success', 'main', 'push', 22],
  ['CI', 'success', 'feat/attitude-ctrl', 'pull_request', 2], ['Docs', 'cancelled', 'docs/fuel-budget', 'pull_request', 52], ['CI', 'success', 'ci/cargo-cache', 'pull_request', 77],
].map(([name, conclusion, headBranch, event, age], i) => ({
  databaseId: 9000 + i, name, status: 'completed', conclusion, workflowName: name, headBranch, event,
  createdAt: ago(age), updatedAt: ago(age - 0.05), url: `https://github.com/${REPO}/actions/runs/${9000 + i}`,
}))

const [a0, a1] = args
if (args.includes('--version')) out('gh version 2.0.0 (demo)\n')
if (a0 === 'auth' && a1 === 'token') out('demo-token\n')
if (a0 === 'auth' && a1 === 'status') out('github.com\n  ✓ Logged in to github.com account demo-user (demo shim)\n')
if (a0 === 'api' && a1 === 'user') out('demo-user\n')
if (a0 === 'repo' && a1 === 'view') {
  const wanted = args.find((a, i) => i > 1 && !a.startsWith('-') && args[i - 1] !== '--json')
  out({ id: 'R_kgDODemoRocket', name: 'rocket', owner: { login: 'acme' }, nameWithOwner: wanted || REPO, url: `https://github.com/${wanted || REPO}`, defaultBranchRef: { name: 'main' } })
}
if (a0 === 'repo' && a1 === 'list') out([{ name: 'rocket', nameWithOwner: REPO }])
if (a0 === 'api' && a1 === 'graphql') {
  const query = gql('query') || ''
  if (/pullRequests\(/.test(query)) {
    const base = JSON.parse(readFileSync(new URL('../../src/watch-only/fixtures/pr-activity.json', import.meta.url), 'utf8'))
    base.data.repository.nameWithOwner = REPO
    out(base)
  }
  if (/reviewThreads/.test(query)) out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })
  if (/search\(/.test(query)) out({ data: { search: { nodes: PRS.map(prNode) }, repository: { id: 'R_kgDODemoRocket' } } })
  out({ data: {} })
}
if (a0 === 'api' && /\/rulesets/.test(a1 || '')) out([{ id: 1, name: 'Protect main' }])
if (a0 === 'api' && /\/protection$/.test(a1 || '')) out({ requiredReviews: 1, requireCodeOwnerReviews: false, requireStatusChecks: true, requiredChecks: ['build', 'unit'] })
if (a0 === 'api' && /\/check-runs$/.test(a1 || '')) out(['build', 'unit', 'lint'].map((name, id) => ({ id, name, status: 'completed', conclusion: 'success', appName: 'GitHub Actions' })))
if (a0 === 'api' && /\/branches/.test(a1 || '')) out([{ name: 'main', protected: true, commit: { sha: 'a1b2c3d' } }, { name: 'feat/attitude-ctrl', protected: false, commit: { sha: 'd4e5f60' } }])
if (a0 === 'pr' && a1 === 'list') out(PRS.map(p => ({ ...prView(p), files: undefined })))
if (a0 === 'pr' && a1 === 'view') out(prView(PRS.find(p => args.includes(String(p.number))) || PRS[0]))
if (a0 === 'pr' && a1 === 'diff') out(DIFF)
if (a0 === 'issue' && a1 === 'list') out(ISSUES.map(issueList))
if (a0 === 'issue' && a1 === 'view') out(issueView(ISSUES.find(i => args.includes(String(i.number))) || ISSUES[0]))
if (a0 === 'run' && a1 === 'list') out(RUNS)
if (a0 === 'run' && a1 === 'view') out('build\tSet up job\t2026-01-01T00:00:00Z ok\n')
out([])
