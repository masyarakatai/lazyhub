# lazyhub — Architecture & Point of Truth

> **Purpose of this file:** Single source of truth for any AI coding assistant or human contributor. Read this before touching any file. It documents every architectural decision, every known bug (with root cause + fix), and every invariant.

---

## 1. The Core Vision
lazyhub is a terminal-based UI for GitHub, heavily inspired by the keyboard-driven UX of `lazygit`.
- **Pure ESM**: Modern Node.js architecture.
- **Ink-Powered**: React-based TUI framework.
- **gh-CLI First**: All GitHub operations MUST happen via the official `gh` CLI.

---

## 2. Elite CI/CD & Staging Strategy

We use an **Enterprise Staging Model** to ensure 100% stable production releases.

| Branch | Action | Purpose |
| :--- | :--- | :--- |
| **Feature** | PR to `main` | Primary integration area. |
| **`main`** | **Release PR** | When ready to ship, `workflow_dispatch` opens a PR from `main` to a new release branch. |
| **`release`** | **Promotion** | Merging the release PR into `main` triggers production deploy. |

### The "Circular Sync" Pattern
To prevent merge conflicts and "branch drift":
1. **Prep**: Bot opens PR from `main` -> `release` with AI docs + version bump.
2. **Deploy**: Merging `release` -> `main` creates Tag + Publishes.
3. **Sync**: Bot automatically opens a **Sync PR** from `main` back to `release` to keep staging in sync with production.

---

## 3. Branch Protection (Ruleset enforced)

| Setting | `main` | `release` |
|---|---|---|
| Required checks | Test (Node 20/22), Dependency audit | same |
| strict (up-to-date) | `false` | `true` |
| Required reviews | 1 approval, dismiss stale | + admin review |
| Linear history | yes | yes |
| Force push | **BLOCKED** | **BLOCKED** |
| Deletions | blocked | blocked |
| enforce_admins | yes | yes |

---

## 4. Required Secrets

| Secret | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `release.yml`, `claude-review.yml` | AI Code Reviews & Release Notes |
| `GEMINI_API_KEY` | `release.yml`, `growth-engine.yml` | AI Architecture Docs & Marketing |
| `NPM_TOKEN` | `publish.yml` | `npm publish` authorization |
| `TAP_TOKEN` | `publish.yml` | Homebrew formula updates |
| `GITHUB_TOKEN` | all workflows | GitHub Actions built-in |

---

## 5. Development Invariants

1. **`src/executor/core.js` is the only implementation file that calls `gh`**. Public imports still go through `src/executor.js`, which is a barrel over the split executor modules.
2. **`useTheme()` not `import { t }`** — always use the hook in components.
3. **FuzzySearch always gets objects**, never strings.
4. **GraphQL integer variables use `-F`**, string variables use `-f`.
5. **`notifyDialog(true/false)`** must be called by any component that opens/closes a dialog.
6. **`ErrorBoundary` wraps every view branch** in `app.jsx`.
7. **`sanitize()`** every string from GitHub API before rendering in Ink components.
8. **`src/ai/providers/anthropic-api.js` is the only file that makes Anthropic HTTP calls. All AI calls (any provider) go through `src/ai/index.js`.**

---

## 6. Quality Control (Deterministic)

- **Dead Code:** Run `npx knip` to find unused files and exports.
- **Architectural Linting:** `npm run lint` enforces the "Executor Pattern".
- **Validation:** Always run `npm test` before any PR merge.
- **PTY Acceptance:** `npm run test:pty` exercises the built CLI in a real pseudo-terminal when `node-pty` can spawn. It covers smoke navigation plus crash restoration, degraded `gh` recovery, opt-in perf writes, and stale-while-revalidate cache first-frame behavior.

## 7. Runtime Resilience & Performance

- Fatal crashes install handlers before Ink renders. The shared `src/crash.js` restore path leaves the alternate screen, shows the cursor, disables mouse tracking/raw mode where possible, and prints the bug-report pointer.
- `useGh()` serves stale-while-revalidate data from `~/.cache/lazyhub/data/` when available, then refreshes in the background. Corrupt cache files are misses; mutation paths invalidate the affected repo cache coarsely.
- `useGhHealth()` tracks failed gh-backed calls globally. The status bar renders a sanitized degraded-state banner with retry guidance and clears automatically after successful refreshes.
- `LAZYHUB_PERF=1` records `runGh()` duration and keypress-to-render latency to `~/.cache/lazyhub/perf.ndjson`. `lazyhub perf report` summarizes count, p50, p95, and max per operation.

---

## 21. Complete bug fix log (reference)

### B-01 — comments.jsx: `useTheme` not imported
- **Symptom:** App crashes when navigating to PR comments view
- **Root cause:** `import { t } from '../../theme.js'` imports the static constant, but `const { t } = useTheme()` on the next line calls `useTheme` which was never imported → `ReferenceError`
- **Fix:** Changed import to `import { useTheme } from '../../theme.js'`

### B-02 — FuzzySearch: helper functions missing
- **Symptom:** `/` search in any list pane crashes; `f` file jump in diff crashes
- **Root cause:** `matchesQuery`, `getDisplayText`, `highlightMatch` were placeholder comments (`// ... (highlightMatch and matchesQuery)`), never implemented
- **Fix:** Implemented all three functions at the top of `FuzzySearch.jsx`

### B-03 — diff.jsx: `getLang` not defined
- **Symptom:** Diff view crashes on open
- **Root cause:** `getLang(f.filename)` called in `useMemo` for `langCache` but function was a placeholder comment
- **Fix:** Implemented `getLang(filename)` with extension→language map

### B-04 — diff.jsx: `openEditorSync` not defined
- **Symptom:** Pressing `e` in diff compose mode crashes
- **Root cause:** `openEditorSync(compose.body)` called but function was a placeholder comment
- **Fix:** Implemented `openEditorSync` using `spawnSync` + temp file

### B-05 — diff.jsx: `sanitize` not imported
- **Symptom:** Crash when a diff line has an inline comment thread
- **Root cause:** `sanitize()` used in `renderThreads()` but not in the import from `../../utils.js`
- **Fix:** Added `sanitize` to the utils import line

### B-06 — issues/detail.jsx: `IssueLabelDialog` uses `t` without `useTheme`
- **Symptom:** Crash when opening label edit dialog on an issue
- **Root cause:** `IssueLabelDialog` rendered `<Text color={t.ui.muted}>` but `t` was never in scope — no `const { t } = useTheme()` call in that function
- **Fix:** Added `const { t } = useTheme()` at the top of `IssueLabelDialog`

### B-07 — executor.js: GraphQL `number` variable wrong flag
- **Symptom:** `listPRComments` fails with GraphQL type error (`Int!` expected, got String)
- **Root cause:** `-f number=${number}` passes the value as a string. GraphQL schema declares `$number: Int!` which requires `-F` (non-string flag)
- **Fix:** Changed to `-F number=${number}`
- **Note:** This was a regression from commit `525cb32` which incorrectly changed `-F` back to `-f`

### B-08 — FuzzySearch: string items don't match
- **Symptom:** `f` key in diff view opens file search dialog but shows nothing and matches nothing
- **Root cause:** `items={files.map(f => f.filename)}` passes plain strings. `matchesQuery` reads `item.title`/`item.name` which are `undefined` on a string
- **Fix:** Changed to `items={files.map(f => ({ name: f.filename }))}` with `searchFields={['name']}`

### B-09 — Mouse: null character in keypress emit
- **Symptom:** Mouse scroll enabled (`LAZYHUB_MOUSE=1`) but scrolling does nothing
- **Root cause:** `process.stdin.emit('keypress', null, { name: 'k' })` — `null` as first arg means Ink's `useInput` receives `input = null`. Every handler checks `input === 'j'` / `input === 'k'` which always fails
- **Fix:** Changed to `process.stdin.emit('keypress', 'k', { name: 'k', sequence: 'k', ctrl: false, meta: false, shift: false })`

### B-10 — Mouse: settings toggle disconnected from App
- **Symptom:** Toggling Mouse Support in Settings saves to config but mouse remains inactive
- **Root cause:** `App` checked `process.env.LAZYHUB_MOUSE !== '1'` (env var only). Settings saved `config.mouse` to disk. The two systems never communicated
- **Fix:** `App` holds `mouseEnabled` in `useState` (seeded from `_config.mouse || env`). `setMouseEnabled` exposed via `AppContext`. Settings calls it on toggle

### B-11 — Mouse: listener order allows readline to parse mouse bytes
- **Symptom:** Mouse events sometimes trigger spurious Esc keypresses
- **Root cause:** `process.stdin.on('data', ...)` (appended) — our handler runs after readline's, which may attempt to parse the raw mouse escape sequence
- **Fix:** Changed to `process.stdin.prependListener('data', ...)` so we detect and handle mouse bytes first

### B-12 — settings/index.jsx: `logger` used but not imported
- **Symptom:** Crash on any settings save (`updateConfig` calls `logger.info`)
- **Root cause:** `logger` called in `updateConfig` but never imported
- **Fix:** Added `import { logger } from '../../utils.js'`

### B-13 — release.yml: curl retry doesn't cover HTTP errors
- **Symptom:** Pipeline fails or commits SHA256 of empty string (`e3b0c44...`) to Homebrew tap during npm CDN propagation
- **Root cause:** `sleep 5` unreliable for CDN propagation (can take 30-120s). `--retry` alone only retries network-level failures, not HTTP 4xx/5xx. Under `-f`, a 404 causes curl to exit non-zero and pipes empty input to `sha256sum`
- **Fix:** Polling loop (18 × 10s), `--retry-all-errors`, empty SHA guard before writing `GITHUB_OUTPUT`

### B-14 — release.yml: getContent swallows all errors
- **Symptom:** TAP_TOKEN permission errors (403) silently swallowed, `createOrUpdateFileContents` called without `sha`, causing a confusing downstream error
- **Root cause:** `catch {}` swallows all exceptions including permission errors
- **Fix:** `catch (err) { if (err.status !== 404) throw err }`

**B-15 — CI checks missing `await` in `getCheckRunAnnotations`**
- Root cause: `return run([...])` without `await` inside `try/catch` — the promise rejection escaped the catch block.
- Fix: Changed to `return await run([...])` so errors are caught and `[]` is returned.

**F-12 — Interactive CI checks in PR detail**
- `[c]` key enters checks navigation mode; `j/k` move within checks; `[l]` shows annotations in LogViewer; `[R]` re-requests check run via GitHub API `POST /check-runs/{id}/rerequest`; `[Enter/o]` opens check URL in browser; `[Esc]` exits checks mode.
- Failing checks are sorted to the top of the checks section automatically.
- `CIBadge` in PR list now shows `✗ N/total` count format instead of a bare `✗`.
- `[C]` key on non-conflicting PR → switches to Actions pane pre-filtered to PR's branch.
- `ActionList` accepts `initialBranch` prop; `[x]` clears the branch filter.

**B-16 — IssueDetail used addPRComment for issue replies**
- Root cause: `addPRComment` calls `gh pr comment`, which requires a PR number. Issues use `gh issue comment`.
- Fix: Added `addIssueComment` to executor.js; IssueDetail now uses it.

**B-17 — Assignee dialogs only added, never removed assignees**
- Root cause: All 4 assignee dialogs (PR list, PR detail, Issue list, Issue detail) called `gh pr/issue edit --add-assignee` only; unselected assignees were never removed.
- Fix: Added `addPRAssignees`, `removePRAssignees`, `addIssueAssignees`, `removeIssueAssignees` to executor.js. All dialogs now compute `toAdd`/`toRemove` diff and call both endpoints.
- Also: dialogs were calling `execa` directly, violating the executor pattern. Now all calls go through executor.js.

**B-18 — FuzzySearch author field gave "[object Object]"**
- Root cause: PR/Issue `author` field is `{login: 'string'}`. `String(item.author)` = `"[object Object]"` so author search never matched.
- Fix: PR list and Issue list now pass `fuzzyItems = items.map(pr => ({...pr, authorLogin: pr.author?.login || ''}))` to FuzzySearch and use `'authorLogin'` in searchFields.

**B-19 — diff.jsx AI review read wrong config key**
- Root cause: `config.anthropicApiKey` (root level) is empty; the key lives at `config.ai.anthropicApiKey`.
- Fix: Changed to `config.ai?.anthropicApiKey`.

**B-20 — PR Detail missing v/a/x/o key handlers**
- Root cause: Help overlay advertised `[v]` (comments), `[a]` (approve), `[x]` (request changes), `[o]` (browser) for PR detail view but none were wired up.
- Fix: Added handlers and `approve-body`/`reqchanges-body` FormCompose dialogs to detail.jsx. Added `onViewComments` prop; app.jsx passes `goToComments`.

**B-21 — Issue list missing [o] open in browser**
- Root cause: Help overlay listed `[o]` for issues but no handler existed.
- Fix: Added `o` key handler to issues/list.jsx.

**B-22 — Notifications hardcoded background color**
- Root cause: `backgroundColor={'#1c2128'}` hardcoded; should use `t.ui.headerBg` from theme.
- Fix: Changed to `t.ui.headerBg`.

**B-23 — Issue Detail contentRows useMemo missing `t` dependency**
- Root cause: The `t` theme object was used inside the useMemo but not listed in deps, causing stale theme on theme change.
- Fix: Added `t` to the dependency array `[issue, termCols, t]`.

**B-24 — actionsBranch not cleared on Tab/number-key pane navigation**
- Root cause: Tab and number key handlers in app.jsx set pane/view but never called `setActionsBranch(null)`, so switching away from Actions and back kept the stale branch filter.
- Fix: Added `setActionsBranch(null)` to both Tab and number-key pane switch handlers.

**B-25 — gg/G jump not implemented in Branches, Actions, Notifications, Comments**
- Root cause: Help overlay listed `gg/G` for all panes but these components had no handler.
- Fix: Added `useRef` + `lastKeyRef`/`lastKeyTimer` gg pattern and `G` handler to all four components.

**B-26 — Branches [n] create new branch not implemented**
- Root cause: Help overlay listed `[n]` for create new branch but no handler existed.
- Fix: Added `n` key handler, `new-branch` dialog with `TextInput`, runs `git checkout -b <name>` via execa.

**B-27 — addPRLineComment bypassed GH_HOST (GHE users could not post line comments)**
- Root cause: `addPRLineComment` called `execa('gh', args)` directly without prepending `--hostname` as `run()` does.
- Fix: Prepend `['--hostname', process.env.GH_HOST]` to args when `GH_HOST` is set.

**B-28 — markAllNotificationsRead fired N concurrent API calls, triggering GitHub secondary rate limits**
- Root cause: `Promise.all(items.map(n => markNotificationRead(n.id)))` for potentially 100+ notifications.
- Fix: Added `markAllNotificationsRead()` to executor.js using `PUT /notifications`; notifications pane now calls it.

**B-29 — listBranches truncated at 30 (missing per_page parameter)**
- Root cause: `gh api repos/.../branches` defaults to 30 items; no `per_page` was set.
- Fix: Appended `?per_page=100` to the URL in `listBranches`.

**B-30 — admin merge from diff view skipped confirmation dialog**
- Root cause: `merge-admin` dialog in diff.jsx went directly to `mergePR()` after method selection; no confirm step.
- Fix: Added `merge-admin-confirm` ConfirmDialog step before executing the admin bypass merge.

**B-31 — G (jump to bottom) set cursor to -1 when list was empty**
- Root cause: `const last = items.length - 1` = -1 when empty; no guard.
- Fix: Added `if (items.length > 0)` guard in all list components (PRList, IssueList, BranchList, NotificationList, ActionList).

**B-32 — gg timer refs leaked on component unmount**
- Root cause: `lastKeyTimer.current = setTimeout(...)` had no cleanup in useEffect.
- Fix: Added `useEffect(() => () => { clearTimeout(lastKeyTimer.current) }, [])` to all components using the gg pattern.

**B-33 — IssueList and NotificationList rendered API strings without sanitize()**
- Root cause: `issue.title` and `notif.subject?.title` rendered directly; violates ARCHITECTURE §5 invariant.
- Fix: Added `sanitize()` calls; imported `sanitize` into issues/list.jsx and notifications/index.jsx.

**B-34 — Close-PR ConfirmDialog interpolated unsanitized PR/issue title into message**
- Root cause: Template literals in ConfirmDialog `message` prop used raw `selectedPR.title` / `selectedIssue.title`.
- Fix: Wrapped with `sanitize()` in both prs/list.jsx and issues/list.jsx.

**B-35 — IssueDetail doReply cleared UI and set statusMsg timeout before request completed**
- Root cause: `setTimeout(() => setStatusMsg(null), 3000)` and `setReplyMode(false)` were outside the promise chain.
- Fix: Moved `setReplyMode(false)` before await; moved `setTimeout` into `.then()`/`.catch()` closures with appropriate timeouts.

**B-36 — IssueDetail missing [o] key to open issue in browser**
- Root cause: Global help overlay lists `o: open current item in browser` but IssueDetail had no handler.
- Fix: Added `o` key handler to issues/detail.jsx.

**B-37 — C key in PR detail opened conflict view for UNKNOWN mergeable state**
- Root cause: `pr.mergeable === 'UNKNOWN'` was included in the conflict handler condition; UNKNOWN means GitHub hasn't computed mergeability yet.
- Fix: Removed `|| pr.mergeable === 'UNKNOWN'` from conflict handler and footer hint; only `CONFLICTING` triggers conflict view.

**B-38 — PRSummaryPanel showed "Draft Draft" for draft PRs**
- Root cause: `stateBadge.label` = "Draft" AND `{pr.isDraft && <Text> Draft</Text>}` both rendered.
- Fix: Removed the duplicate `isDraft` conditional text.

**B-39 — HelpOverlay used fixed column widths (40+38+gap) overflowing on <90-column terminals**
- Root cause: Hardcoded `width={40}` and `width={38}` in a flex row with no responsive behaviour.
- Fix: Added `useStdout()` width check; global keys column hidden when `cols < 90`.

**B-40 — PRs and Branches panes shared the same ⎇ sidebar icon**
- Root cause: Both `BUILTIN_PANE_ICONS.prs` and `BUILTIN_PANE_ICONS.branches` were `'⎇'`.
- Fix: Changed branches icon to `'⊞'`.

**B-41 — CIBadge rendered ✗3/5 with no space between icon and count**
- Root cause: `<Text> ✗{failing}/{total}</Text>` — no space after icon character.
- Fix: Changed to `✗ {failing}/{total}` and `● {pending}/{total}`.

**B-42 — BranchList fetched PRs without TTL caching, refetching on every mount**
- Root cause: `useGh(listPRs, [repo])` passed no TTL option; also fetched all states instead of open-only.
- Fix: Added `{ state: 'open', limit: 100 }` filter and `{ ttl: 120_000 }` option.

**B-43 — deleteBranch confirmation did not warn user the operation is remote-only**
- Root cause: ConfirmDialog message said "Delete branch X?" with no indication local branch is unaffected.
- Fix: Updated messages to explicitly say "remote branch" and note local branch is unaffected.

**B-44 — New branch dialog accepted git-invalid characters without validation**
- Root cause: Only `.trim()` was applied; no check for spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..`, `.lock`, leading `-`, trailing `.`.
- Fix: Added regex validation in `onEnter`; shows error status and cancels if invalid.

**B-45 — Checkout of currently-checked-out branch showed confusing ConfirmDialog**
- Root cause: `ConfirmDialog` rendered with "already your current branch" message but still showed confirm/cancel buttons.
- Fix: Early-return with `showStatus()` instead of rendering a confirm dialog.

**B-46 — spawnSync editor open did not restore terminal, causing layout artifacts on return**
- Root cause: `spawnSync` with `stdio: 'inherit'` ran editor in the alternate screen, mixing editor output with Ink's render.
- Fix: Exit alternate screen before `spawnSync`; re-enter it after the editor closes.

**B-47 — Any-key dismiss of persistent errors swallowed the triggering key (e.g. r to retry required two presses)**
- Root cause: `if (statusMsg?.persist) { setStatusMsg(null); return }` — the `return` discarded the key.
- Fix: Removed `return` so the key falls through to its handler after clearing the error.

**B-48 — Knip and ESLint reported multiple unused exports, imports, and dead code**
- Root cause: Accumulation of unused helper functions, binaries (`which`), and missing devDependencies (`vite`).
- Fix: Added `vite` to `package.json`; ignored `which` in `knip.json`; removed or un-exported 10+ unused functions across `src/ai-assistant.js`, `src/executor.js`, `src/ipc.js`, and `src/utils.js`.

**B-49 — Maintenance scripts used outdated section references and CI included redundant Node versions**
- Root cause: `auto-docs.mjs` targeted incorrect section indices and used fragile splicing logic; CI matrix included Node 20 which is no longer the target runtime.
- Fix: Updated internal scripts to point to Section 21; simplified documentation auto-updates to append-only; restricted CI matrix to Node 22; updated LLM model string to stable `gemini-2.5-flash`.

**B-50 — Agent default scope was `full` and agent/AI tool inputs were not validated at runtime (#249, PR #264)**
- Symptom: a fresh config granted the broadest agent scope, and malformed or type-confused inputs (resource type, IDs, enums, lengths) reached MCP/AI dispatch.
- Root cause: schema default of `agent.default_scope` was not least-privilege; the MCP adapter and `executeMutatingTool` trusted input shape.
- Fix: default is `read-only` in `src/config/schema.js` and `defaultConfig.toml`; a broader requested scope produces a config warning. Shared validators in `src/input-validation.js` enforce tool name, repo, IDs, enums and length limits with stable `MCP_*` / `AI_*` error codes; client-supplied scope metadata is never read.

**B-51 — Daemon forwarded arbitrary `gh` argv and accepted unauthenticated control messages (#250, PR #266)**
- Symptom: any local process able to reach the daemon socket could have it run caller-chosen `gh` commands and stop or invalidate it.
- Root cause: `type: "gh"` passed caller argv to `runGh`; control messages had no authentication; the daemon inherited the launcher's environment.
- Fix: passthrough removed in favour of typed allowlisted reads (`src/daemon/protocol.js`); privileged messages require a per-daemon session token (0600 file, expiring, revocable; expired secret is rotated); versioned, size-limited protocol with stable error codes; minimal spawn env; no auto-spawn from agent or non-TTY contexts; callers with identity env (`GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`) bypass the daemon; cache key includes host and account.

**B-52 — Write-shaped `gh` invocations could bypass audit and cache invalidation; audit failure was swallowed (#251, PR #271)**
- Symptom: unrecognised write forms were treated as reads, so they skipped audit and invalidation, and a failed audit write did not block the operation.
- Root cause: `isGhMutation()` was a denylist of a few command names and flags; `writeAuditEntry` swallowed errors.
- Fix: allowlisted `classifyGh()` returns read/write/unknown; unknown is refused before spawn, writes are audit-first (failure blocks), never cached, never sent to the daemon, never retried, and invalidate the repo cache afterwards (added in review). Only typed `READ_OPS` are cacheable. Audit entries carry an args hash, not argv.

**B-53 — External AI CLI providers ran with the user's real HOME and the repo as cwd (#252, PR #268)**
- Symptom: Claude Code, Codex and Gemini CLI providers could load repo or user instructions, hooks, plugins and MCP config.
- Root cause: `spawnAndPipe` curated env but passed HOME through and set no cwd.
- Fix: per-call isolated sandbox (empty 0700 cwd, throwaway HOME/TMPDIR/XDG), minimal env, per-CLI hardening flags, guaranteed cleanup including signal paths, provider reported unavailable when isolation or credentials are missing. In review, credential-file copying was removed in favour of env-key-only auth, because a sandboxed token refresh could invalidate the user's real login. Claude CLI `is_error` results with exit 0 now map to error codes instead of assistant text.

**B-54 — Local files, sockets and debug exports were created with default permissions (#253, PR #269)**
- Symptom: config, logs, caches and debug exports were readable under default umask; the IPC socket lived at a predictable `/tmp` path with unchecked pre-existing paths; debug exports contained raw `gh` argv and error text.
- Root cause: raw `writeFileSync`/`appendFileSync`/`mkdirSync` at each writer, blind unlink-then-listen, ignored bind errors, unredacted debug state.
- Fix: shared `src/secure-fs.js` (0700 dirs, 0600 files, atomic and no-follow writes, ownership/symlink/type checks before chmod or unlink); IPC socket in a verified private directory with surfaced bind errors; debug export uses allowlist redaction. Windows named-pipe ACLs and the daemon pid file remain out of scope.
