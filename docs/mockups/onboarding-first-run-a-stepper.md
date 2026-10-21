# Mockup: first-run onboarding, variant A (two-step stepper, single column)

Issue #70. 80x24 reference. One bordered panel (`ui.border`), header with
breadcrumb, persistent footer. Accent (`ui.selected`) only on: active step,
focused row, primary action key.

## Step 1: choose a repository

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ lazyhub · first run · octocat                       watch-only · read-only   │
│ [1 Repository] › 2 Report                                                    │
│                                                                              │
│ lazyhub will only READ through your existing gh login. It installs nothing,  │
│ creates no checks, changes no rulesets and writes nothing to GitHub.         │
│                                                                              │
│ Pick a repository to observe:                                                │
│  ▶ octocat/hello-world            (current directory)                        │
│    octocat/spoon-knife                                                       │
│    acme/platform                                                             │
│    acme/docs                                                                 │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
 j/k move │ Enter observe │ q quit (nothing is written)
```

## Step 2: watch-only report

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ lazyhub · first run · octocat/hello-world           watch-only · read-only   │
│ 1 Repository › [2 Report]                                                    │
│ Observed 20 PR(s) in 1 page(s). Nothing was enforced, installed or written.  │
│                                                                              │
│ Coverage  github_enforced | managed_gateway | advisory | ungoverned          │
│   pr_merge                   advisory                                        │
│   force_push                 ungoverned [observation_gap:timeline_truncated] │
│   local_agent_approval       ungoverned [alternate_path_detected:...]        │
│   cloud_agent_merge_approval ungoverned [ruleset_permission_missing]         │
│ Gaps  timeline_truncated (PR #12)                                            │
│ Activity  agent 2 · automation 1 · human 14 · shared 0 · unknown 3           │
│   3 unattributed event(s): unknown is not safe; treated as ungoverned.       │
│                                                                              │
│ Enforcement setup (coming, not available yet): a separate, explicit step.    │
│   Expect solo/pilot limits: you would approve your own agents' merges.       │
╰──────────────────────────────────────────────────────────────────────────────╯
 Enter open lazyhub │ b change repo │ q quit (nothing is written)
```

## Error panel (missing auth / rate limit / permission)

```
│ Not signed in to GitHub through gh.                                          │
│ Run `gh auth login` (add `--hostname <host>` for Enterprise), then start     │
│ lazyhub again. lazyhub did not log in, and wrote nothing.                    │
 r retry │ q quit
```

Tokens: border `ui.border`, title `ui.selected` (bold), body `ui.muted`,
coverage advisory `ci.pending`, ungoverned `ci.fail`, hints `ui.dim`.
