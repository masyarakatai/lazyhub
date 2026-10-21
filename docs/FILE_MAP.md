# File Map — concept → owning files

> Generated crosswalk so a fresh Claude session knows where things live.
> When in doubt, this doc points you at the right file; then read that file's JSDoc header for full context.
> Regenerate after any major refactor (add/remove/rename file) with `npm run docs:refresh`.

## Top-level entry points

| File | Purpose |
|---|---|
| `src/app.jsx` | root Ink layout + renderApp() entry point. Layout (≥100 cols): ┌─ sidebar 18 ─┐┌─ list (flex) ──────────────────┐┌─ detail 40 ─┐ │              ││                                 ││             │ └──────────────┘└─────────────────────────────────┘└─────────────┘ status bar (1 row) footer keys (1 row) Layout (<100 cols, ≥80):  sidebar + list only Layout (<80 cols):        list only (sidebar replaced by tab header) |
| `src/bootstrap.js` | runs BEFORE any Ink UI is rendered. Steps: 1. Detect gh CLI 2. Detect gh auth status 3. Detect repo context 4. Hand off to renderApp() |

## GitHub interface (the gh chokepoint)

| File | Purpose |
|---|---|
| `src/executor.js` | public barrel for the gh executor modules. Keep importing from this file; implementation modules live under src/executor/. |
| `src/executor/actions.js` | List workflow runs. @param repo @param filter |
| `src/executor/branches.js` | Request reviewers for a PR. @param repo @param number @param reviewers |
| `src/executor/core.js` | the ONLY place the `gh` CLI is invoked in lazyhub. `runGh(args, opts)` is the single chokepoint: every exported function routes through it. That gives one place to mock in tests, one place to type errors (GhError), and one place to instrument (timeout, future retry/observability). |
| `src/executor/gh-error.js` | the error type thrown by `runGh()` in executor.js. Carries the sanitized stderr, exit code, and args so callers can render an actionable message without re-parsing gh output. Lives in its own module so the executor and its tests (and future contract tests) share one definition. |
| `src/executor/issues.js` | List issues with optional filters. @param repo @param filter |
| `src/executor/misc.js` | List the authenticated user's gists. |
| `src/executor/notifications.js` | List notifications. @param filter |
| `src/executor/pr-comments.js` | Get the unified diff for a PR. @param repo @param number |
| `src/executor/prs.js` | Normalize the PR list GraphQL response to the legacy gh `pr list --json` shape consumed by the list pane. @param {object} result @returns {object[]} |

## AI provider abstraction

| File | Purpose |
|---|---|
| `src/ai-assistant.js` | AI assistant brain Exposes a Claude tool-use loop that: - Executes read-only tools freely (up to MAX_TOOL_ROUNDS) - Intercepts mutating tools and returns them to the UI for confirmation - Parses <<NAVIGATE:pane[:key=val]*>> markers for app navigation Direct fetch pattern (same as ai.js). No SDK dependency. |
| `src/ai.js` | DEPRECATED re-export shim. @deprecated Import from './ai/index.js' directly. This shim is kept for one release per the migration plan (spec §11). It will be removed in the next release. |
| `src/ai/detect.js` | Provider auto-detection and selection. Phase 1 priority: claude-code → anthropic-api (codex → gemini-cli added in Phase 2) Override mechanisms (in order of precedence): 1. LAZYHUB_AI_PROVIDER env var — hardest override, useful for CI 2. Default priority list below Detection results are cached in-module for the session lifetime. Call clearDetectionCache() in tests to reset. |
| `src/ai/error.js` | AIError class definition. Standalone module to avoid circular imports between index.js, parse.js, detect.js, and the provider modules. |
| `src/ai/index.js` | Public API for AI-powered code review. This is the ONLY entry point callers should use. Provider selection, prompt building, and parsing are all internal. Usage: import { getAICodeReview, AIError, listProviders } from './ai/index.js' const result = await getAICodeReview({ diff, prTitle, prBody, opts }) // result: { summary: string, suggestions: [{file, line, severity, comment}] } |
| `src/ai/parse.js` | Response parsing for AI code review. Extracted unchanged from src/ai.js. Handles JSON extraction, markdown fence stripping, and suggestion shape normalization. |
| `src/ai/prompt.js` | Pure prompt-building helpers. Extracted unchanged from src/ai.js. These are research-backed techniques and must NOT be modified without updating the citations in src/ai.js. Research-backed techniques applied: 1. PR description in prompt: +72% F1 improvement (ContextCRBench, 2024) 2. Inline line numbers embedded in diff lines: KBI 23.7% → 42.96% (Towards Practical Defect-Focused Automated Code Review, 2025) 3. Diff pruning — strip pure-deletion hunks + keep ±3 context lines: "Left Flow" approach (same paper) |
| `src/ai/providers/_base.js` | Shared spawn helper for CLI-based AI providers. Security requirements (mirroring executor.js): - execFile only — no exec, no shell interpretation - Prompt piped via stdin — never as argv (diffs exceed ARG_MAX; injection risk) - Curated env — PATH/HOME/USER only; no secret leakage - 60s hard timeout + SIGTERM → SIGKILL after 5s grace - 256KB output cap — larger responses truncated and treated as malformed |
| `src/ai/providers/anthropic-api.js` | Anthropic HTTP API provider. This is the ONLY file that makes Anthropic HTTP calls. HTTP logic extracted unchanged from src/ai.js. Preserves the cache_control ephemeral header on the system prompt. |
| `src/ai/providers/claude-code.js` | Claude Code CLI provider. Uses the `claude` CLI in non-interactive (-p) mode. Prompt is piped via stdin — never argv (diffs exceed ARG_MAX). Auth is managed by the user's Claude Code installation (~/.claude/). |
| `src/ai/providers/codex.js` | Codex CLI provider. Uses the `codex` CLI for executing agent tasks. Prompt is piped via stdin — never argv (diffs exceed ARG_MAX). Auth is managed by the user's Codex installation (~/.codex/). Note: Codex outputs NDJSON event stream (one JSON object per line). We filter for 'agent_message' events and concatenate their text. |
| `src/ai/providers/gemini-cli.js` | Gemini CLI provider. Uses the `gemini` CLI for executing agent tasks. Prompt is piped via stdin — never argv (diffs exceed ARG_MAX). Auth is managed by the user's Gemini CLI installation (~/.gemini/). |
| `src/ai/providers/openai-compatible.js` | OpenAI-compatible HTTP provider. |
| `src/ai/usage.js` | AI usage logging wrapper. Centralizes usage recording for all AI providers. Mirrors the project's existing logAiUsage() pattern. tokens{In,Out} may be null for CLI providers — that is expected. |

## Theme system

| File | Purpose |
|---|---|
| `src/theme.js` | resolves the active theme from config and exports t. |
| `src/theme/bg-detect.js` | Terminal background brightness detection. Pure function, no side effects, no I/O. Reads environment variables passed in as an argument (defaults to process.env) for easy testing. Detection strategy (in priority order): 1. $COLORFGBG   — set by many terminal emulators, format "fg;bg" bg component: 7 or 15 = light background, 0 or 8 = dark. 2. $TERM_PROGRAM — well-known values that imply a default background. 3. $COLORTHEME  — explicit hint some terminals set ('light'|'dark'). Returns 'dark' | 'light' | 'unknown'. Reference for COLORFGBG convention: The variable has the form "fg;bg" (sometimes "fg;bg;color-count"). The bg component encodes a terminal palette index: 0 = black (dark bg)       8  = bright black / dark gray (dark bg) 7 = white (light bg)      15 = bright white (light bg) Some terminals write just the bg number; some write fg;bg. We extract the LAST numeric segment to get the bg value. @param {NodeJS.ProcessEnv} [env] injectable for testing; defaults to process.env @returns {'dark' | 'light' | 'unknown'} |
| `src/theme/index.js` | Public API for the lazyhub theme system. Exports: themes         — Map of scheme name → scheme object getDefaultScheme(env) — Returns 'lazyhub-dark' or 'lazyhub-light' based on terminal background detection. Falls back to 'lazyhub-dark'. ThemeContext   — React context (for advanced consumers) ThemeProvider  — Wraps the app; provides `useTheme()` to all children useTheme()     — React hook; returns { scheme, schemeName, setScheme } Usage in components: import { useTheme } from '../theme/index.js' const { scheme } = useTheme() <Text color={scheme.accent.primary}>focused row</Text> Design contract (DESIGN_REVAMP.md §3.4): - Components NEVER import color literals directly. - They always consume tokens via useTheme().scheme[...]. - Theme switch is hot — no relaunch required. Only stable React APIs are used (createContext, useContext, useMemo, useState) to remain compatible with both React 18 and React 19. |
| `src/theme/schemes/lazyhub-dark.js` | Default dark color scheme. Inspired by GitHub Dark Dimmed (the dimmer variant of GitHub's dark theme) but tuned for terminal readability. Terminal renderers tend to crush saturation vs. a gamma-corrected web browser, so we bump saturation and lightness slightly on critical tokens. Design constraints (from DESIGN_REVAMP.md §12 row 1): - Foreground ~#adbac7  (GitHub Dark Dimmed body text) - Background ~#22272e  (GitHub Dark Dimmed canvas) - Accent     ~#539bf5  (GitHub Dark Dimmed blue) - Diff add   ~#347d39  on bg ~#0f2f23 - Diff del   ~#c93c37  on bg ~#3c1f1f Contrast ratios (approximate, checked against WCAG AA 4.5:1 for body text): fg.default  (#adbac7) on bg.default (#22272e): ~6.2:1  ✓ accent.primary (#539bf5) on bg.default:       ~4.7:1  ✓ fg.muted (#768390)   on bg.default:           ~3.8:1  (acceptable for metadata) fg.subtle (#545d68)  on bg.default:           ~2.4:1  (decorative / low-emphasis only) All values are hex strings accepted by Ink's `color` prop. Diff tokens use { fg, bg } shape (two channels — text + row background). |
| `src/theme/schemes/lazyhub-light.js` | Light color scheme (daylight counterpart to lazyhub-dark). Auto-selected when the terminal background is detected as light (via $COLORFGBG or bg-detect.js heuristics). Can also be set explicitly via config or the settings switcher. Design approach: - Light gray canvas (#f6f8fa, GitHub Light surface) instead of dark. - Dark foreground (#1f2328, GitHub Light body) for contrast. - Accent blue (#0969da, GitHub Light link) — same family, light-tuned. - Diff add: #0f7931 fg on #dafbe1 bg (GitHub Light diff-add palette). - Diff del: #82071e fg on #ffebe9 bg (GitHub Light diff-del palette). Contrast ratios (approximate, WCAG AA 4.5:1 target for body text): fg.default  (#1f2328) on bg.default (#f6f8fa): ~16:1   ✓ accent.primary (#0969da) on bg.default:        ~5.8:1  ✓ fg.muted (#57606a)   on bg.default:            ~5.0:1  ✓ fg.subtle (#8c959f)  on bg.default:            ~3.0:1  (metadata/decorative) All values are hex strings accepted by Ink's `color` prop. Diff tokens use { fg, bg } shape. |
| `src/theme/tokens.js` | Token taxonomy schema for lazyhub's design system. This file defines the SHAPE of the token tree (keys + documentation). It does NOT define values — values live in scheme files. Every scheme must provide a value for every token listed here. The test suite enforces full coverage. Token naming follows the §3.1 spec in DESIGN_REVAMP.md. Adding new tokens requires escalation to Opus (per §12 locked decisions). Diff tokens use an object shape { fg, bg } because they control two independent channels (foreground text color + background row color). All other tokens are plain hex strings. |
| `src/themes/ansi-16.js` | Standard 16-color ANSI theme for maximum compatibility. Works in any terminal (no hex support required). |
| `src/themes/aurora-dark.js` | cool navy/slate, lavender+cyan accents. |
| `src/themes/aurora-light.js` | cream surface, navy ink, periwinkle accents. |
| `src/themes/catppuccin-latte.js` | Catppuccin Latte (light) color scheme. |
| `src/themes/catppuccin-mocha.js` | Catppuccin Mocha (dark) color scheme. |
| `src/themes/github-dark.js` | GitHub Dark color scheme. |
| `src/themes/github-light.js` | GitHub Light color scheme. |
| `src/themes/tokyo-night.js` | Tokyo Night color scheme. |

## Features — Pull Requests

| File | Purpose |
|---|---|
| `src/features/prs/comments.jsx` | PR comments/threads view Supports: reply, edit, delete per comment |
| `src/features/prs/ConflictView.jsx` | GitHub PR merge-conflict resolution Resolves conflicts for a GitHub PR by: 1. Checking out the PR branch locally 2. Merging the base branch to expose conflict markers 3. Opening each conflicting file in the configured editor 4. Staging resolved files 5. Committing + immediately pushing back to GitHub (updates the PR) Phases: CHECKING   — probing local git state SETUP      — branch not checked out or no merge in progress yet CONFLICTS  — mid-merge, files listed with resolution status COMMITTING — committing + pushing in one step DONE       — pushed, PR updated |
| `src/features/prs/detail.jsx` | PR detail pane Scrollable view: j/k to scroll, gg/G top/bottom, / to search body |
| `src/features/prs/diff-parser.js` | pure diff-parsing logic, no React/Ink deps. Extracted from diff.jsx so it can be unit-tested without mocking the entire Ink/chalk/hljs stack. |
| `src/features/prs/diff.jsx` | PR diff view with syntax highlighting + line comments |
| `src/features/prs/list-dialogs.jsx` | (no header — inferred: list-dialogs) |
| `src/features/prs/list-row.jsx` | Maps a new-style token scheme object (src/theme/index.js) to the legacy `t.*` shape consumed by PR list sub-components. @param {object} scheme - Active scheme from useTheme().scheme @returns {{ ui: object, pr: object, ci: object, review: object }} |
| `src/features/prs/list-view.jsx` | (no header — inferred: list-view) |
| `src/features/prs/list.jsx` | PR list pane Props: repo         string listHeight   number   — visible row count from App onHover      fn(pr)   — called when cursor moves (for side panel) onSelectPR   fn(pr)   — called on Enter → full detail onOpenDiff   fn(pr)   — called on 'd' onPaneState  fn({loading, error, count}) |
| `src/features/prs/NewPRDialog.jsx` | Smart New PR creation dialog. Features: - Auto-detects current branch and offers to use it as head - Validates head branch against remote (not pushed / has unpushed commits / no diff) - Validates base branch exists on GitHub - Offers to push branch to origin if needed - Shift+Tab for backward field navigation |

## Features — Issues

| File | Purpose |
|---|---|
| `src/features/issues/detail.jsx` | Issue detail pane |
| `src/features/issues/list.jsx` | Issue list pane |

## Features — other

| File | Purpose |
|---|---|
| `src/features/actions/index.jsx` | Actions / workflow runs pane |
| `src/features/branches/index.jsx` | Branch list pane |
| `src/features/logs/index.jsx` | In-app structured log viewer |
| `src/features/notifications/index.jsx` | Notifications pane |
| `src/features/settings/index.jsx` | In-app settings and theme picker |

## UI primitives

| File | Purpose |
|---|---|
| `src/ui/actions.js` | Central action registry for the command palette. Each action shape: { id:       string          — unique identifier (e.g. 'pr.approve') label:    string          — human label shown in palette (e.g. 'Approve PR') hint:     string          — optional one-liner description category: string          — grouping label (e.g. 'pr', 'global') context:  string|string[] — 'global' | 'pr-list' | 'pr-detail' | 'diff' | ... '*' means always visible regardless of context keys:     string[]        — bindings that also trigger it (display only) run:      (ctx) => void|Promise — executes the action; receives current app context: { pane, selectedItem, repo, onNavigate, onTheme, onClose, onQuit, themes } } Context values that match panes/views: 'global'    — always visible 'pr-list'   — visible when pane === 'prs' and view === 'list' 'pr-detail' — visible when pane === 'prs' and view === 'detail' 'diff'      — visible when view === 'diff' 'issues'    — visible when pane === 'issues' The palette resolves context via resolveContext(pane, view). |
| `src/ui/Popover.jsx` | Floating popover primitive for lazyhub. Renders children in an absolutely-positioned overlay that does NOT cause layout shift in the parent flow.  The popover is taken out of normal Flex flow via `position: 'absolute'`, so the PR list (or any other host) keeps its dimensions intact. Position priority chain (DESIGN_REVAMP.md §12.1): right → below → above → left Auto-flips when the preferred side doesn't have enough room. Usage: <Popover anchor={{ x: 0, y: 2, width: 60, height: 1 }} popoverWidth={52} popoverHeight={12} termCols={120} termRows={30} preferredSide="right" onClose={() => setOpen(false)} > <MyContent /> </Popover> The outer <Box> is `position: 'absolute'` with marginLeft/marginTop computed from the anchor.  It never contributes to parent flow. |

## Components (shared)

| File | Purpose |
|---|---|
| `src/components/AIAssistant.jsx` | AI assistant overlay Full-screen content-area overlay triggered by Ctrl+A. Shows conversation history, a single-line prompt, and handles action confirmation + navigation prompts inline. |
| `src/components/AIReviewPane.jsx` | Interactive step-through AI code review Flow (research-backed: one-at-a-time > list; ~70% suggestions skipped): Phase 1 — Summary Show overall summary + suggestion count breakdown. [Enter] to start stepping through, [q] to close. Phase 2 — Step (per suggestion) Diff auto-scrolls to the relevant line. Shows: severity badge, file:line, AI comment as editable draft. [Enter/s] post draft as comment  [e] edit in $EDITOR  [n/Space] skip  [q] cancel all While editing inline (after pressing [i]): Esc returns to command mode. Phase 3 — Done "Posted N  Skipped M" summary, then close. |
| `src/components/CommandPalette.jsx` | fuzzy command palette overlay. Triggered by `:` or `<space><space>` from app.jsx. Fuzzy-searches every action available for the current view context. Props: context   { pane, view, selectedItem, repo, themeName } onClose   () onNavigate  ({ pane, view, itemNumber, filter }) onTheme   (themeName) onQuit    () themes    string[] |
| `src/components/CommentThread.jsx` | renders a list of comments as a threaded discussion. Props: comments ([Comment]), t (theme object) Used in: diff.jsx inline threads, comments.jsx view |
| `src/components/CustomPane.jsx` | generic pane renderer for user-defined tabs. A custom pane is declared in ~/.config/lazyhub/lazyhub.toml like: [panes.my-deploys] label = "Deployments" icon = "▶" command = "gh api repos/{repo}/deployments --jq '[.[] | {title:.environment,number:.id,state:.task,updatedAt:.created_at,url:.url}]'" [panes.my-deploys.actions] "o" = "open" The command runs in a shell. Placeholders: {repo}, {owner}, {name}. stdout must be a JSON array. Recommended item fields: title      — main text (required for a useful display) number     — short id shown in gutter (optional) state      — status badge text (optional) updatedAt  — ISO date shown as time-ago (optional) url        — used by 'y' copy and 'o' open actions (optional) Built-in actions always available: j/k / ↑↓  navigate gg / G    jump top / bottom r         re-run command /         fuzzy search (title field) y         copy .url to clipboard (if present) o         open .url in browser (if present) User-defined actions (via [panes.<id>.actions]): Supports action value: "open" (same as o), "copy" (same as y) |
| `src/components/dialogs/ConfirmDialog.jsx` | confirmation dialog primitive. Props: message, destructive (bool), onConfirm(), onCancel(), requireText? (string to type) |
| `src/components/dialogs/FormCompose.jsx` | multi-field form dialog primitive. Props: title, fields ([{name, label, type: 'text'|'multiline'|'select'}]) onSubmit(values), onCancel() |
| `src/components/dialogs/FuzzySearch.jsx` | fuzzy search dialog with virtual scrolling. Renders only as many items as fit in the terminal — safe for thousands of items. Props: items, onSubmit(item), onCancel(), searchFields |
| `src/components/dialogs/LogViewer.jsx` | full-screen scrollable log viewer primitive. Props: lines (string[]), onClose() |
| `src/components/dialogs/MultiSelect.jsx` | multi-select checklist with virtual scrolling. Renders only as many items as fit in the terminal — safe for large label/assignee lists. Props: items ([{id, name, color?, selected?}]), onSubmit(selectedIds[]), onCancel() |
| `src/components/dialogs/OptionPicker.jsx` | single-select option picker with virtual scrolling. Props: options ([{value, label, description?}]), onSubmit(value), onCancel(), title?, promptText? |
| `src/components/ErrorBoundary.jsx` | catches render crashes, logs them, shows a minimal error box. |
| `src/components/FooterKeys.jsx` | footer key hint bar. Keys shape: { key, label, group? } When group numbers present, renders groups separated by ┊ (U+250A). Falls back to plain │ separators when no groups defined. |
| `src/components/Sidebar.jsx` | Navigation sidebar for switching between feature views. |
| `src/components/Skeleton.jsx` | animated placeholder loaders for every list/detail pane. Each exported component mirrors the exact column layout of its real counterpart so the UI doesn't shift when data arrives. Animation: a single 700ms interval per skeleton component pulses all bars between ░ and ▒ — one setInterval total, not one per bar. |
| `src/components/Spinner.jsx` | animated braille spinner for loading states |
| `src/components/StatusBar.jsx` | Application status bar showing context and global state. |
| `src/components/TabStrip.jsx` | horizontal pane tabs for compact mode (<80 cols). Props: panes (string[]), currentPane, paneLabels, paneIcons, onSelect |
| `src/components/Toaster.jsx` | transient notification stack, max 3, bottom-right. Variants: success (2.5s), info (3s), warning (4s), error (sticky). Usage: call useToast() hook to get { toast } function. toast({ message, variant: 'success'|'info'|'warning'|'error' }) |

## Hooks

| File | Purpose |
|---|---|
| `src/hooks/useGh.js` | React hook that wraps executor calls with loading/error/data state and an in-memory TTL cache. |
| `src/hooks/useGhHealth.js` | global degraded-state tracker for gh-backed requests. |
| `src/hooks/useLayout.js` | responsive layout breakpoints based on terminal dimensions. Config overrides always win over breakpoint defaults. |
| `src/hooks/usePaneState.js` | preserve list/pane view state across navigation. State is stored in a Map on AppContext (via paneStateRef). Survives PRList unmount (back-nav from detail/diff). Cleared on explicit pane-switch (Tab, number key) by the App. Usage: const [state, setState] = usePaneState('prs', { cursor: 0, scrollOffset: 0, filterState: 'open', ... }) |
| `src/hooks/useVirtualList.js` | safe for repos with tens of thousands of items. Usage: const { cursor, scrollOffset, visibleItems, moveCursor, jumpTop, jumpBottom } = useVirtualList({ items, height }) // In JSX: visibleItems.map((item, i) => { const isSelected = scrollOffset + i === cursor ... }) |

## Configuration & Context

| File | Purpose |
|---|---|
| `src/config.js` | compatibility shim over lazyhub.toml. The runtime source of truth is `~/.config/lazyhub/lazyhub.toml`, loaded by `src/config/loader.js`. This module keeps the historical `loadConfig()` shape alive for older call sites while projecting every value from TOML. |
| `src/config/actions.js` | action/key metadata from lazyhub.toml. |
| `src/config/docs.js` | documentation/AI guidance model generated from TOML config. |
| `src/config/index.js` | React context for the TOML user-config layer (issue #130). Phase E1 ships the plumbing only: `<ConfigProvider>` loads and exposes the merged config, and `useConfig()` reads it — but no feature consumes it yet (keymaps E3 #132, settings writes E2 #131, custom tabs E4 #66, etc.). The provider loads the local config synchronously for first render. If `[meta].config_url` is set, it fetches the remote config once (HTTPS-only, cached, fallback-on-failure) and merges it on top — "remote wins". |
| `src/config/keymap.js` | TOML-backed keymap resolution. |
| `src/config/loader.js` | file + network I/O for the TOML user-config layer (issue #130). Pipeline (synchronous local path): defaultConfig.toml (or DEFAULT_CONFIG fallback) → merge user ~/.config/lazyhub/lazyhub.toml (validated, invalid keys dropped) → fold platform keymap sub-sections for the current OS → expand ~ in path fields Remote config (`[meta].config_url`) is fetched asynchronously by the ConfigProvider via `fetchRemoteConfig()` — HTTPS-only, cached locally, with the cache as the fallback when the network/remote fails. See acceptance #6. Security invariants (issue Hard rules): - TOML is data only; smol-toml never executes code from the file. - `~` is expanded with Node homedir(), never via a shell. - config_url uses Node `fetch` with a timeout; never curl/wget. HTTP is refused. |
| `src/config/migrate.js` | one-shot state.json → lazyhub.toml migration. |
| `src/config/schema.js` | TOML config schema, defaults, validation, and merge logic. This is the pure (no I/O) core of the V1 user-config layer (issue #130, Phase E1). `loader.js` handles all file/network I/O and calls into here. Exports: - SCHEMA_VERSION      current schema version string - BUILTIN_SCOPES      the six built-in permission scopes (ARCHITECT_DECISIONS §7) - DEFAULT_CONFIG      full JS defaults — emergency fallback + canonical shape. Values MUST mirror defaultConfig.toml (enforced by a test). - validateConfig(raw) → { config, warnings }  type-checks a parsed TOML object, drops invalid/unknown keys (never throws), collects warnings. - mergeConfig(a, b)   deep merge (b wins); plain objects merge, arrays/scalars replace. - mergePlatformKeymaps(keymaps, platform)  fold [keymaps.ctx.<platform>] onto base. - expandConfigPaths(config)  expand leading ~ to homedir() for known path fields. Validation philosophy (issue acceptance #2): - unknown key  → warn, ignore that key (don't crash) - wrong type   → warn, ignore that key (default fills in via merge) - valid value  → keep |
| `src/config/writer.js` | conservative TOML writes for settings-owned fields. smol-toml stringifies values, but it does not round-trip comments. To preserve user-authored config, this module updates only the sections lazyhub owns: - [state] and [state.*] tables - [theme].name - [defaults].* - selected [app], [ai], [ai.openai_compatible], and [features.*] scalars Other sections, comments, ordering, keymaps, tabs, and unknown user keys are left byte-for-byte intact. The [state] table is normalized to the end of the file when saved because lazyhub owns that whole table tree. |
| `src/context.js` | shared React contexts Kept separate from app.jsx so feature components don't create circular imports by reaching back into the root layout module. |

## Utilities & Infrastructure

| File | Purpose |
|---|---|
| `src/editor.js` | Editor detection and file-open utility Supports: vscode, cursor, nvim, vim, nano, emacs, and $EDITOR/$VISUAL fallback. Configured via config.editor.command ("auto" | "vscode" | "cursor" | "nvim" | etc.) openInEditor(file, line) — opens the file at the given line number in the detected/configured editor. Non-blocking; fires and returns immediately. |
| `src/ipc.js` | IPC Unix-socket server for IDE integrations Starts a Unix domain socket server at: $LAZYHUB_SOCKET  (if set) /tmp/lazyhub-<pid>.sock  (default) Also writes the socket path to ~/.lazyhub-socket so clients can discover the most recent instance without knowing the PID. Protocol: newline-delimited JSON (NDJSON) Requests  → { id, type, ...params } Responses → { id, type, ...result } Events    → { type: "event", event, data }   (pushed to all clients) Request types: ping                           → { pong: true } state                          → current lazyhub state snapshot navigate  { view, prNumber, issueNumber }  → navigate the TUI open-file { file, line }       → open file in editor from IDE side pr-for-branch { branch, repo? } → { prNumber, prState?, ciStatus?, unresolvedThreads? } or { prNumber: null } if no PR for the branch review-comments { prNumber }   → { comments: [{ id, threadId, path, line, body, user, resolved }] } reply-thread { threadId, body } → { ok: true, commentId } resolve-thread { threadId }    → { ok: true } subscribe { event }             → subscribe this client to an event stream invalidate { repo? }            → request cache invalidation watch { event? }                → alias for subscribe, used by daemon clients Events emitted to all clients (via emitIPC): cursor-changed    { view, prNumber, file, line } view-changed      { view } pr-merged         { prNumber } pr-state-changed  { branch, prNumber, ciStatus, unresolvedThreads } — broadcast helper provided; triggers (CI refresh, merge) ship in later phases. Call emitIPC('pr-state-changed', payload) from any refresh path. review-comment-added   { prNumber, comment } review-thread-resolved { prNumber, threadId } |
| `src/keyscope.js` | keyboard scope isolation for Ink TUI. Prevents useInput handlers in lower-priority components from firing when a higher-priority scope (e.g. text input dialog) is active. Scope priority: global(0) < pane(1) < view(2) < overlay(3) < dialog(4) < input(5) Usage: const { isActive } = useKeyScope with scope 'pane' useInput(handler, { isActive }) // Or the convenience hook that combines claim + useInput: useScopedInput('view', (input, key) => { … }) Legacy aliases kept for backward compat: list=pane, detail=view |
| `src/mcp.js` | (no header — inferred: mcp) |
| `src/utils.js` | shared utility functions |

## Uncategorized

| File | Purpose |
|---|---|
| `src/app-keys.js` | (no header — inferred: app-keys) |
| `src/app-panels.jsx` | (no header — inferred: app-panels) |
| `src/app-views.jsx` | (no header — inferred: app-views) |
| `src/cache.js` | stale-while-revalidate disk cache for gh-backed panes. |
| `src/cli/doctor/config.js` | lazyhub doctor --config. |
| `src/cli/doctor/index.js` | lazyhub doctor command. |
| `src/cli/mcp-server.js` | Run lazyhub MCP server mode. |
| `src/cli/serve.js` | CLI entry point for `lazyhub serve`. @param {string[]} argv |
| `src/cli/status.js` | Compute ambient-status counts from disk cache entries. @param {Array} entries @param {number} now @returns {object|null} |
| `src/crash.js` | terminal restoration and fatal-crash reporting. |
| `src/daemon/audit.js` | Resolve the audit log path from config. @param {object} config |
| `src/daemon/cache.js` | Read-through cache used by the daemon for gh results. @property {Map<string, {ts:number, payload:unknown}>} memory |
| `src/daemon/event-bus.js` | Small in-daemon event bus for IPC/MCP/TUI subscribers. @property {Map<string, Set<{write:Function}>>} subscribers |
| `src/daemon/lifecycle.js` | Resolve the daemon endpoint. Unix uses a filesystem socket; Windows uses a named pipe so the rest of the daemon can stay on Node's `net` module. @param {object} config |
| `src/daemon/mcp-adapter.js` | Runtime-validate tool arguments. Fails closed with stable error codes. Only fields validated here are ever read; client-supplied scope/identity metadata is ignored and never confers authority. @param {string} canonical @param {object} args |
| `src/daemon/server.js` | Start the K-lite daemon in the current process. @param {object} config loaded lazyhub config |
| `src/debug-state.js` | Build the redacted debug-state object. @param {object} appState optional app-level state snapshot @returns {object} serializable debug-state payload |
| `src/features/tabs/filter-to-gh.js` | translate TOML pane filters to executor args. |
| `src/features/tabs/pane.jsx` | one TOML-declared dashboard pane. |
| `src/features/tabs/registry.js` | TOML custom tab registry. |
| `src/features/tabs/view.jsx` | TOML-declared multi-pane dashboard. |
| `src/input-validation.js` | shared runtime validators for untrusted agent/model-supplied input (MCP adapter, AI assistant). Dependency-free so the daemon can import it without pulling in UI code. |
| `src/perf.js` | opt-in local NDJSON performance instrumentation. |
| `src/test/test-helpers.jsx` | (no header — inferred: test-helpers) |

## Tests

Test file counts by directory:

| Directory | Test files |
|---|---|
| `src/` | 14 |
| `src/ai/` | 3 |
| `src/ai/providers/` | 4 |
| `src/cli/` | 1 |
| `src/cli/doctor/` | 1 |
| `src/config/` | 6 |
| `src/daemon/` | 5 |
| `src/features/prs/` | 2 |
| `src/features/tabs/` | 2 |
| `src/hooks/` | 1 |
| `src/theme/` | 1 |
| `src/ui/` | 2 |

**Total non-test source files:** 122
**Total test files:** 42
