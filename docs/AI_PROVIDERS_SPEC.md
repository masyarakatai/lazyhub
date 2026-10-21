# AI Providers — Pluggable Backend Spec

> **Status:** Proposed
> **Owner:** `src/ai/`
> **Related:** `src/ai.js` (current), `src/ai-assistant.js`, `ARCHITECTURE.md` §5
> **Audience:** Any contributor (human or AI) replacing the AI backend.

---

## 1. Vision & motivation

**Today:** `src/ai.js` calls `api.anthropic.com` directly. Requires `ANTHROPIC_API_KEY`. Users manage keys, manage billing, manage rotation.

**Tomorrow:** lazyhub detects whichever AI CLI the user *already has logged in* (`claude`, `codex`, `gemini`) and uses it. Zero key management. Zero billing for lazyhub to track. The user's existing subscription pays.

### Goals

- **Zero-config for users with any supported CLI installed and authenticated.**
- **Drop-in for existing key-based flow** — `ANTHROPIC_API_KEY` still works as a fallback.
- **Cross-provider** — Claude Code, OpenAI Codex CLI, Gemini CLI, future Ollama.
- **No behavior change at call sites** — `getAICodeReview()` keeps the same signature; provider selection is internal.

### Non-goals

- Streaming token-by-token in the TUI (current code is non-streaming; out of scope here).
- Multi-provider ensembling.
- Per-PR provider override (single setting, applies globally).
- Provider-specific prompts — the same prompt goes to every provider. Prompt quality is the prompt's job, not the provider's.

---

## 2. Current state (what changes)

`src/ai.js` (~600 LOC) currently:
- Annotates diff with line numbers
- Prunes pure-deletion hunks
- Builds system + user prompts
- POSTs to `api.anthropic.com/v1/messages` with `cache_control` ephemeral on system
- Parses Claude's JSON response
- Returns `{ summary, suggestions: [{ file, line, severity, comment }] }`

Of this:
- **Prompt construction, diff annotation, response parsing** → moved to `src/ai/prompt.js`, reused unchanged across providers.
- **HTTP transport** → moved to `src/ai/providers/anthropic-api.js`.
- **Provider selection** → new `src/ai/detect.js` + `src/ai/index.js`.

Public API (unchanged):
```js
import { getAICodeReview, AIError } from './ai/index.js'
const result = await getAICodeReview({ diff, prTitle, prBody, opts })
```

Callers (`AIReviewPane`, `ai-assistant.js`) need **no changes**.

---

## 3. Architecture

### 3.1 File layout

```
src/ai/
├── index.js              ← public API (getAICodeReview, AIError, listProviders)
├── detect.js             ← provider auto-detection + caching
├── prompt.js             ← shared diff annotation + prompt building
├── parse.js              ← shared response parsing (JSON extraction)
├── settings.js           ← read/write user's chosen provider
├── usage.js              ← logAiUsage() wrapper (existing project pattern)
└── providers/
    ├── anthropic-api.js  ← current HTTP path, refactored
    ├── claude-code.js    ← `claude` CLI
    ├── codex.js          ← `codex` CLI
    ├── gemini-cli.js     ← `gemini` CLI
    ├── openai-compatible.js ← OpenAI-compatible HTTP (covers Ollama, Groq, LM Studio, Azure OpenAI, OpenRouter, etc.)
    └── _base.js          ← shared spawn helper, timeout, stdin piping
```

### 3.2 Provider interface

Every provider exports:
```js
export const id = 'claude-code'              // stable identifier
export const displayName = 'Claude Code'     // for UI
export const authSource = 'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN'  // for UI

// Detection — runs cheaply at startup
export async function detect()
  → { available: boolean, version?: string, model?: string, reason?: string }

// Inference — given a fully-built prompt, return raw assistant text
export async function complete({ system, user, maxTokens, signal })
  → { text: string, modelUsed: string, tokensIn?: number, tokensOut?: number }

// Optional capability flags
export const capabilities = {
  systemPrompt: true,      // supports separate system message
  jsonMode: false,         // can force JSON output
  promptCaching: false,    // supports cache_control or equivalent
}
```

Provider implementations are leaf modules with no knowledge of lazyhub's prompts or response shape. `index.js` does prompt building and parsing around them.

### 3.3 Selection flow

```
getAICodeReview(args)
  ↓
selectProvider()
  1. $LAZYHUB_AI_PROVIDER env override?       → use it (or throw if unavailable)
  2. ~/.config/lazyhub/lazyhub.toml [defaults].ai_provider set?  → use it
  3. Iterate auto-detect priority:
       claude-code → codex → gemini → anthropic-api
     (openai-compatible skipped; only available via env/config above)
     First with available:true wins.
  4. None available?                          → throw AIError('no-provider')
  ↓
build prompt (prompt.js)
  ↓
provider.complete({ system, user, maxTokens })
  ↓
parse response (parse.js)
  ↓
logAiUsage({ provider, model, tokensIn, tokensOut })
  ↓
return { summary, suggestions }
```

---

## 4. Provider implementations

### 4.1 Claude Code (`claude-code.js`)

**Detection:**
```sh
claude --version          # exit 0 → available
```
Caches result for the session.

**Invocation:**
```sh
claude -p --output-format json --max-turns 1 --model <model>
```
- Prompt piped via **stdin** (never argv — diffs can exceed 100KB)
- `--output-format json` returns `{ type, result, ... }` where `result` is the assistant text
- `--max-turns 1` prevents the agent from trying tool use; we want a one-shot answer
- Timeout: 60s default, configurable via `setup.aiTimeout`

**Isolation (#252):** every external CLI runs in an empty 0700 temp cwd with a throwaway `HOME`, a minimal env (PATH/USER/LANG/LC_ALL + the one auth var) and hardening flags, so repo `CLAUDE.md`/hooks/MCP and the user's agent config are never loaded. The sandbox is removed on success, error, timeout and parent exit/SIGINT/SIGTERM/SIGHUP.

**Auth (env only):** `CLAUDE_CODE_OAUTH_TOKEN` (create with `claude setup-token`) or `ANTHROPIC_API_KEY` (runs with `--bare`). A plain `claude login` session (keychain / `~/.claude`) is not shared with the sandbox, so OAuth-login-only users must run `claude setup-token` once.

**Notes:**
- Claude Code's `-p` mode is its supported non-interactive interface for exactly this use case.
- Project invariant: spawn with `execFile`, never `exec`. Argv = `['-p', '--output-format', 'json', '--max-turns', '1', '--model', model]`.

### 4.2 Codex CLI (`codex.js`)

**Detection:**
```sh
codex --version
```

**Invocation:**
```sh
codex exec --json --skip-git-repo-check
```
- Prompt piped via stdin
- `--json` returns NDJSON event stream; we collect events of type `agent_message` and concatenate `message` fields
- `--skip-git-repo-check` prevents Codex from refusing to run when invoked outside a repo context

**Auth (env only):** `CODEX_API_KEY` or `OPENAI_API_KEY`. `~/.codex/auth.json` (ChatGPT login) is deliberately not copied into the sandbox: Codex rotates single-use refresh tokens, so a sandboxed refresh would invalidate the user's real login. OAuth-only users see `unavailable: set CODEX_API_KEY or OPENAI_API_KEY`.

**Notes:**
- Codex is more agentic by default; we use `exec` (non-interactive one-shot) not `tui` mode.

### 4.3 Gemini CLI (`gemini-cli.js`)

**Detection:**
```sh
gemini --version
```

**Invocation:**
```sh
gemini -p - --output-format json
```
- Prompt piped via stdin (the `-` after `-p`)
- Parse JSON, extract assistant text from `response.text` or `candidates[0].content.parts[0].text`

**Auth (env only):** `GEMINI_API_KEY`. `~/.gemini/oauth_creds.json` (Google login) is not copied, for the same refresh-invalidation reason; OAuth-only users see `unavailable: set GEMINI_API_KEY`.

### 4.4 Anthropic API (`anthropic-api.js`)

Current `src/ai.js` HTTP logic, extracted unchanged. Detection = `!!process.env.ANTHROPIC_API_KEY`.

This provider keeps the `cache_control` ephemeral header. The CLI-based providers cannot use prompt caching because we don't control their request layer.

### 4.5 OpenAI-compatible HTTP (`openai-compatible.js`)

**Detection:** reads config; requires `[ai.openai_compatible].base_url` and `[ai.openai_compatible].model` in `~/.config/lazyhub/lazyhub.toml`.

**Invocation:**
```
POST {base_url}/chat/completions
{
  "model": "{model}",
  "messages": [
    { "role": "system", "content": "{system}" },
    { "role": "user", "content": "{user}" }
  ],
  "max_tokens": 2048
}
```
- Config can provide an optional `api_key` (sent as `Authorization: Bearer {api_key}`)
- Optional `timeout_ms` override (default: 60s)
- Parses response: `choices[0].message.content` is the assistant text

**Use cases:** Ollama, Groq, LM Studio, Azure OpenAI, OpenRouter, or any HTTP server implementing the OpenAI Chat Completions API.

**Config example:**
```toml
[ai.openai_compatible]
base_url = "http://localhost:11434/v1"
model = "llama2"
api_key = ""           # optional; omit if endpoint is unauth'd
timeout_ms = 60000
```

**Non-goal:** This is not a generic LLM aggregator. Providers with materially different HTTP APIs (not OpenAI-compatible) need separate provider modules.

### 4.6 Base helper (`_base.js`)

```js
export async function spawnAndPipe({ cmd, args, stdin, timeoutMs }) {
  // execFile-based spawn (project pattern from executor.js)
  // pipes stdin, captures stdout, enforces timeout, throws AIError on non-zero exit
}
```

Used by all three CLI providers. Single chokepoint for security review.

---

## 5. Detection & priority

```js
// src/ai/detect.js
const PROVIDERS = ['claude-code', 'codex', 'gemini-cli', 'anthropic-api', 'openai-compatible']
```

**Auto-detection priority** (first available wins): `claude-code` → `codex` → `gemini-cli` → `anthropic-api`. **Note:** `openai-compatible` is **not included in auto-detection** — it's only available via explicit configuration (see override mechanisms below) because users who have local/self-hosted HTTP endpoints must opt-in.

Override mechanisms (in order of precedence):
1. **Env:** `LAZYHUB_AI_PROVIDER=openai-compatible` — hardest override, useful for CI
2. **Config file:** `~/.config/lazyhub/lazyhub.toml` → `[defaults]` → `ai_provider = "openai-compatible"`
3. **Auto-detection** (skips `openai-compatible` unless forced above)

Detection runs **once at TUI startup**, results cached in-memory. A `[r]` key in the Settings → AI Provider panel re-runs detection.

If the chosen provider becomes unavailable mid-session (CLI uninstalled, HTTP endpoint down), the next call throws `AIError('provider-unavailable')` and prompts the user to pick another.

---

## 6. Settings UI

New panel: **Settings → AI Provider** (route: `settings/ai`).

```
╭─ AI Code Review ──────────────────────────────────────╮
│                                                       │
│  Active:  ● claude-code   (via ~/.claude login)      │
│           Model: claude-sonnet-4-7                    │
│           Status: ✓ ready                             │
│                                                       │
│  Available providers:                                 │
│           ● claude-code      (detected)               │
│           ○ codex            (detected)               │
│           ○ gemini-cli       (not installed)          │
│           ○ anthropic-api    (no ANTHROPIC_API_KEY)   │
│                                                       │
│  [j/k] move   [Enter] select   [r] re-detect          │
│  [t] test review on current PR    [q] back            │
╰───────────────────────────────────────────────────────╯
```

Persisted to `~/.config/lazyhub/settings.json`. New file — not coupled to existing config files.

**Test action `[t]`** runs a tiny canned diff through the selected provider and shows latency + first-line of response. Lets users verify auth/install without picking a PR.

---

## 7. Security requirements

All requirements are **must-do**, mirroring the `executor.js` pattern.

1. **`execFile`, never `exec`.** No shell interpretation, no argv interpolation.
2. **Prompt via stdin.** Never as argv — diffs blow past ARG_MAX and shell-escape bugs are how injection happens.
3. **Binary resolution.** Use `which`-equivalent lookup on PATH. Reject if resolved path is in user-writable locations outside standard CLI install dirs (`/usr/local/bin`, `~/.local/bin`, `~/.claude/bin`, etc.). Configurable allowlist.
4. **Timeout enforcement.** 60s default. SIGTERM, then SIGKILL after 5s grace.
5. **Output size cap.** 256KB. Larger responses are truncated and treated as malformed.
6. **No environment leakage.** Spawn with a curated env: PATH, HOME, USER, the provider's documented vars. Do NOT pass GH_TOKEN, ANTHROPIC_API_KEY (unless target is anthropic-api), or other secrets to CLIs that don't need them.
7. **Usage logging.** Every call goes through `logAiUsage({ provider, model, tokensIn, tokensOut, latencyMs, success })`. Tokens may be `null` for CLI providers — that's fine, just log `null`.
8. **No outbound HTTP except in `anthropic-api.js`.** Enforce with the same `no-restricted-imports` mechanism the project uses for `executor.js`.

---

## 8. Error model

```js
class AIError extends Error {
  // Note: message first (idiomatic JS), code in options
  constructor(message, { code, provider, status, cause } = {}) { ... }
}

// Error codes (stable, for UI mapping):
'no-provider'           // no provider available
'provider-unavailable'  // chosen provider stopped working
'auth-required'         // CLI exists but not logged in
'timeout'
'rate-limited'          // provider returned 429-equivalent
'malformed-response'    // parse failed
'spawn-failed'          // execFile error (ENOENT, EACCES)
```

UI translates these into actionable messages:
- `no-provider` → "Install Claude Code (`brew install anthropic/tap/claude`), Codex, or Gemini CLI — or set ANTHROPIC_API_KEY."
- `auth-required` → the provider's own message, e.g. "run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or set ANTHROPIC_API_KEY" / "set CODEX_API_KEY or OPENAI_API_KEY" / "set GEMINI_API_KEY".

---

## 9. Phased delivery

### Phase 1 — Refactor + Claude Code provider (1–2 days)

- Extract prompt/parse from `src/ai.js` → `src/ai/prompt.js`, `src/ai/parse.js`
- Create `src/ai/index.js` with `getAICodeReview()` matching current signature
- Create `src/ai/providers/anthropic-api.js` from the existing HTTP code
- Create `src/ai/providers/claude-code.js`
- Create `src/ai/detect.js` with priority `claude-code → anthropic-api`
- Update `AIReviewPane` and `ai-assistant.js` to import from `src/ai/index.js`
- Delete old `src/ai.js` (or make it a one-line re-export, then remove next release)

Acceptance:
- [ ] `npm test` passes (existing `ai.test.js` adapted to test through `index.js`)
- [ ] With only `ANTHROPIC_API_KEY` set: behavior identical to today
- [ ] With `claude` on PATH and logged in: CLI used, no API key needed
- [ ] `logAiUsage` records `provider` field

### Phase 2 — Codex + Gemini providers (1–2 days)

- Add `providers/codex.js`, `providers/gemini-cli.js`
- Extend priority list: `claude-code → codex → gemini-cli → anthropic-api`
- Per-provider test stubs (mock spawn)

### Phase 3 — Settings UI (1–2 days)

- New `settings/ai` route + component
- Provider list, detection status, selection
- Test action `[t]`
- Persisted to `~/.config/lazyhub/settings.json`

### Phase 4 — Polish

- `:checkhealth ai` or equivalent CLI subcommand: `lazyhub doctor --ai`
- Per-provider model override in settings (advanced)
- Future: Ollama provider for local models
- Future: streaming output (would require provider capability flag + UI changes)

---

## 10. Test plan

### Unit (`src/ai/*.test.js`)

- `prompt.test.js` — diff annotation, deletion pruning, line-number injection (port from existing `ai.test.js`)
- `parse.test.js` — JSON extraction from various model outputs, malformed handling
- `detect.test.js` — priority order, env override, settings override, unavailable fallback
- Each provider has `*.test.js` mocking spawn / fetch

### Integration

- Test fixture: a small known diff + expected suggestion shape
- Run against each provider in CI matrix (skipped if CLI not present)
- Manual: each provider on a real PR, validate suggestions are reasonable

### Regression

- Existing `ai.test.js` test cases must pass through the new `index.js`
- `logAiUsage` count must match call count

---

## 11. Migration & rollout

1. **Phase 1 ships as a refactor.** Default priority puts `anthropic-api` last only if no CLI is found, so existing key-only users see no change.
2. **First release with CLI providers:** changelog entry highlights "AI review now works without an API key if you have Claude Code / Codex / Gemini installed."
3. **No breaking changes.** `ANTHROPIC_API_KEY` continues to work indefinitely.
4. **`src/ai.js` removal:** kept as a re-export shim for one release, then deleted. Update internal callers immediately in Phase 1.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CLI cold-start adds 500–1500ms latency | Acceptable for one-shot review; document in settings UI ("CLI providers add ~1s startup") |
| CLI output format changes between versions | Capability detection on `--version`; pin tested versions in CHANGELOG; fall back to `anthropic-api` on parse failure |
| Users install CLI but never log in | Auth check in `detect()` — run a trivial query; surface as `auth-required` not `available` |
| Provider returns text wrapped in markdown code fences | `parse.js` already handles ```json fencing |
| Heavy diffs exceed CLI stdin buffer | Same `MAX_DIFF_CHARS` cap (16K) applied before any provider |
| User pays twice (subscription + API key) | Detection order puts CLIs first; settings UI shows "via your CLI" so they know |
| Subprocess hangs | Hard timeout + SIGTERM/SIGKILL; logged as `timeout` error |

---

## 13. Open questions

1. **Codex JSON event format stability.** Codex CLI is newer; confirm `--json` schema is stable enough to parse without per-version branching.
2. **Should we expose `model` selection per provider?** Recommendation: no in Phase 1 — use each CLI's default model. Phase 4 adds an advanced override.
3. **Prompt caching on Anthropic API.** Current code uses `cache_control`. CLI providers can't. This means anthropic-api may be measurably cheaper at scale — surface this in settings? Recommendation: only if a user asks.
4. **Telemetry on provider mix.** Useful product data ("80% of users on claude-code") but requires opt-in. Defer.
