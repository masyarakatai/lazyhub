# Mockup: first-run onboarding, variant B (live split preview)

Issue #70. Repo list left, report preview right (lazygit-style).

```
╭─ Repositories ─────────╮╭─ Watch-only report ─────────────────────────────────╮
│ ▶ octocat/hello-world  ││ 20 PR(s) observed, nothing written                   │
│   octocat/spoon-knife  ││ pr_merge        advisory                             │
│   acme/platform        ││ force_push      ungoverned                           │
│   acme/docs            ││ activity: unknown 3                                  │
│                        ││ Enforcement setup: coming, solo/pilot limits         │
╰────────────────────────╯╰──────────────────────────────────────────────────────╯
 j/k move │ Enter open lazyhub │ q quit
```

Rejected: every cursor move would trigger a GraphQL observation (rate-limit
cost; DESIGN_REFERENCES "no layout shifts on row focus"), and the narrow right
pane truncates the coverage vocabulary that must match
`lazyhub doctor --coverage`.
