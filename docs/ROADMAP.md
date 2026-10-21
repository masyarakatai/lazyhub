# Lazyhub Roadmap

## Product direction

Lazyhub is a human approval and evidence surface for GitHub work performed by
agents and people. It does not compete with coding agents, GitHub dashboards, or
general-purpose agent runtimes. Alpha validates whether maintainers value:

1. zero-configuration observation of GitHub-side agent activity;
2. honest, operation-level coverage reporting;
3. a commit-bound approval that GitHub can require before merging.

Read `docs/ARCHITECT_DECISIONS.md` and `docs/THREAT_MODEL.md` before selecting
work. The milestone and issue body are authoritative when this roadmap only
summarizes them.

## Alpha audience and limits

Alpha supports solo maintainers and pilot repositories. It has two slices.

- Slice 1 is watch-only, safety containment, published-package hardening, and
  trusted npm delivery.
- Slice 2 records approval and updates `lazyhub/approval`. It does not execute
  merges.
- Local-agent merge approval is `managed_gateway`.
- Eligible cloud-agent merge approval is `github_enforced` after ruleset and
  App-source verification.
- Team availability and an always-on verifier are Beta.

## Slice 1 - observe safely and reach pilots

| Order | Issue | Exit condition | Status |
|---:|---|---|---|
| 1 | #247 | D1-D12, T1-T21, canonical agent rules, and private disclosure path are tracked. | Tracked |
| 2 | #249 | Agent mutations are disabled and fresh/default capability is read-only. | Done |
| 3 | #250 | Arbitrary daemon passthrough is gone and privileged IPC is authenticated. | Done |
| 4 | #251 | Only typed reads are cacheable; unknown/write-shaped operations fail closed. | Done |
| 5 | #252 | Shipped external AI subprocesses use isolated cwd, HOME, config, and environment. | Done |
| 6 | #253 | Shipped local files, sockets, caches, and diagnostics are permissioned and redacted. | Done |
| 7 | #246 | Watch-only observes GitHub timelines, commits, reviews, and checks with zero agent configuration. | Done |
| 8 | #133 | Doctor reports evidence-backed coverage and ungoverned paths. | Done |
| 9 | #70 | First run reaches a useful watch-only report through the existing `gh` login. | Done |
| 10 | #248 | Pilot npm release uses trusted publishing and verifiable provenance. | Open (pending maintainer npm trusted-publisher setup, PR #265) |

Progress: items marked Done are merged; each PR lists its own residual gaps under "Not done / needs maintainer". #248 stays open until the maintainer completes npm trusted-publisher setup and PR #265 lands.

### Slice 1 exit

- Ten maintainers complete watch-only onboarding.
- Reports never call an unknown path enforced.
- Published-package security fixes and the provenance release gate are merged.
- No enabled agent mutation path remains outside typed policy.

## Slice 2 - approval-only GitHub enforcement

| Order | Issue | Exit condition |
|---:|---|---|
| 1 | #245 | A user-owned checks-only App publishes one check through a one-use repository token. |
| 2 | #235 | Canonical approval records bind exact repository, commit, policy, and evidence state. |
| 3 | #203 | A maintainer can make safe decisions from computed facts without reading the agent transcript. |
| 4 | #244 | Every protected-branch PR requires the App-pinned check; Lazyhub never merges it. |
| 5 | #141 | Live sandbox evidence proves source pinning, invalidation, bypass handling, and no merge execution. |

### Slice 2 exit

- Every enrolled protected-branch PR is blocked without the App-sourced check.
- New commits and stale/revoked approvals cannot reuse a passing check.
- The UI and diagnostics label local-agent coverage `managed_gateway`.
- The sandbox proves eligible cloud-agent coverage `github_enforced`.
- A human still performs the final merge through GitHub or another client.

## Beta - supervised execution and team operation

Beta work must not block Alpha user learning.

| Area | Issues |
|---|---|
| Governed execution, crash recovery, idempotency, reconciliation | #255, #147 |
| Native payload-bound presence signing | #256 |
| Policy, identity, budgets, sandboxing | #148, #153, #155, #236 |
| Policy/approval daemon, audit, recovery | #145, #237, #238 |
| Stable errors, previews, contracts, events | #146, #149, #150, #151 |
| Evidence, CI, integration journeys | #73, #140, #175 |
| Credential and local security depth | #234 |
| Broader release hardening | #257 |
| Team verifier and governance | #72 and Team Governance milestone |

## Backlog and frozen work

- #174 is the strategy umbrella, not an executable milestone item.
- #201 is design-reference work and does not block either Alpha slice.
- Editor integrations, broad TUI feature expansion, and packaging beyond npm
  and Homebrew are frozen until pilot evidence changes the priority.
- Reopen a frozen direction only with concrete user evidence or a security and
  correctness reason.

## Picking the next issue

1. Finish the earliest incomplete issue in the active slice unless a concrete
   security incident requires containment first.
2. Read `AGENTS.md`, `docs/ARCHITECT_DECISIONS.md`, and
   `docs/THREAT_MODEL.md`.
3. Verify every issue precondition against the current tree.
4. Treat the issue's Files NOT to touch and Constraints sections as hard scope.
5. Update this roadmap in the same PR when ordering, scope, or exit criteria
   change.
