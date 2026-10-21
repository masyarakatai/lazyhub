# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** page.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Do not open a public issue with exploit steps, credentials, private repository
content, or a working bypass. A public issue may describe affected boundaries
and remediation status after maintainers have contained the issue.

Include the affected Lazyhub version, platform, operation, expected security
boundary, observed behavior, reproduction, and any evidence of credential or
repository impact. Remove live secrets from attachments.

## Supported versions

Until the first stable gateway release, security fixes target the latest npm
release and the current `main` branch. Maintainers may ask reporters to verify a
private candidate build before coordinated disclosure.

## Security model

Read `docs/THREAT_MODEL.md` for the exact claims, exclusions, coverage states,
and T1-T21 threat checklist. In particular, Alpha is approval-only and Lazyhub does not claim to secure a fully
compromised same-user operating system.

## Checking your own coverage: `lazyhub doctor --coverage`

```
lazyhub doctor --coverage [--repo owner/name] [--json]
```

Read-only and local: it uses your existing `gh` session, writes nothing, fixes
nothing and sends nothing anywhere. For each operation it reports exactly one of
`github_enforced`, `managed_gateway`, `advisory` or `ungoverned`, with the
evidence and `downgrade_reasons` behind it.

- In this Alpha, `github_enforced` and `managed_gateway` are **never** reported:
  the pinned lazyhub App and its ruleset verification (#245) and the local
  gateway do not exist yet, and doctor says so in its output. Local-agent
  approval is at best `advisory`.
- Partial or rate-limited GitHub reads, stale observations, an unverified
  repository identity (host and node ID), unreadable rulesets or missing
  permissions downgrade an operation to `ungoverned`, visibly.
- Doctor also lists alternate paths it finds in known locations: token
  environment variables, extra `gh` hosts/accounts, git credential helpers,
  SSH remotes/keys/agent, other GitHub clients on `PATH`, and MCP servers in
  common agent configs (Claude, Cursor, Windsurf, VS Code, Gemini, Codex). A
  detected path downgrades local-agent approval. Only names, hosts and counts
  are shown; secret values are never read into the report.
- Detection is evidence, not proof. A clean result does not mean no alternate
  path exists; conditions doctor cannot inspect (OS keychains, other machines,
  which keys GitHub accepts) are listed as `unknown`.

`--json` carries the same data as the text output (`schema_version` 1).
