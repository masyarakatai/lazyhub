# 🦥 lazyhub

### The high-performance, keyboard-driven terminal UI for GitHub.

![lazyhub demo: PR list, detail and diff](docs/demo/out/tour.gif)

[![CI](https://github.com/saketh-kowtha/lazyhub/actions/workflows/ci.yml/badge.svg)](https://github.com/saketh-kowtha/lazyhub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lazyhub?color=3fb950&label=npm)](https://www.npmjs.com/package/lazyhub)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Homebrew](https://img.shields.io/badge/brew-install-orange?logo=homebrew)](https://github.com/saketh-kowtha/homebrew-tap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**lazyhub** is a terminal UI (TUI) that wraps the GitHub CLI (`gh`) into a cohesive, Vim-inspired experience. Inspired by the legendary `lazygit`, it surfaces Pull Requests, Issues, Actions, and Notifications in a lightning-fast interface, allowing you to manage your entire GitHub workflow without your fingers ever leaving the home row.

---

## ⚡️ Why lazyhub?

Context switching is a flow-killer. Jumping between your terminal and a browser to approve a PR or check a CI log fragments your focus. **lazyhub** brings the entire GitHub Web UI into your terminal.

- **🚀 Zero Latency:** No browser tabs, no heavy Electron apps. Just a raw, optimized TUI.
- **🧠 AI-Native Review:** Integrated with Anthropic’s Claude 3.5 Sonnet to analyze diffs and suggest fixes with a single keystroke.
- **🔍 Fuzzy Search Everything:** Filter lists, jump to files in a 5,000-line diff, or find a specific workflow run instantly.
- **🎨 Elite Theming:** Includes Tokyo Night, Catppuccin, and GitHub Dark/Light presets. Fully customizable via JSON.

---

## 🏗 Architecture

lazyhub is built on a decoupled, reactive architecture using **React** and **Ink**. It treats the `gh` CLI as its primary data engine, ensuring your local authentication and enterprise configurations just work.

```mermaid
graph TD
    User([User Input]) --> UI[React / Ink TUI]
    UI --> Hook[useGh Hook / SWR Disk Cache]
    UI --> Context[AppContext / State Management]
    Hook --> Executor[executor.js Barrel / gh Chokepoint]
    Hook --> AI[ai.js / Anthropic Claude API]
    Executor --> GH[GitHub CLI / GraphQL & REST]
    AI --> Claude[Claude 3.5 Sonnet]
    GH --> API[GitHub API]
```

Operational notes:
- Warm panes render from `~/.cache/lazyhub/data/` immediately, then refresh in the background.
- `LAZYHUB_PERF=1 lazyhub` records local perf data; `lazyhub perf report` prints p50/p95/max by operation.
- Fatal crashes restore the terminal and point users at `lazyhub --debug-state`.
- Machine-facing contracts are documented in [`docs/CONTRACT.md`](./docs/CONTRACT.md) and [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md).

---

## 🚀 Power User Features

### 🤖 AI Inline Review (`A` key)
Don't just look at code; understand it. While in the Diff View, press `A`. Claude scans your changes, identifies potential bugs or architectural smells, and lets you post those suggestions as real GitHub comments instantly.

**Provider auth.** External AI CLIs (`claude`, `codex`, `gemini`) run in an isolated sandbox that never sees your repo or your logged-in config, so authenticate them with environment variables:

| CLI | Set |
|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` |
| Codex | `CODEX_API_KEY` or `OPENAI_API_KEY` |
| Gemini CLI | `GEMINI_API_KEY` |

### 🔭 Deep Diff Navigation
- **`f` (File Jump):** Fuzzy search filenames within a PR to jump directly to the relevant hunk.
- **`t` (File Tree):** Toggle a sidebar showing the directory structure of the changes.
- **`s` (Split View):** Toggle between Unified and Side-by-Side diff modes.

### 🛠 Extensible Custom Panes
Need a view for your team's specific deployments or Gists? Define a custom pane in your `config.json`.
```json
"customPanes": {
  "my-deploys": {
    "label": "Deployments",
    "icon": "🚀",
    "command": "gh api repos/{repo}/deployments"
  }
}
```

---

## 📦 Installation

| Channel | Command | Status |
| --- | --- | --- |
| npm | `npm install -g lazyhub` | Published |
| Homebrew | `brew install saketh-kowtha/tap/lazyhub` | Published after npm `latest` promotion |
| Scoop | `scoop install ./packaging/scoop/lazyhub.json` | Manifest prepared; bucket submission pending |
| winget | See `packaging/winget/README.md` | Manifest prepared; winget-pkgs PR is manual |
| Nix | `nix run github:saketh-kowtha/lazyhub` | Flake prepared; hash must be refreshed per release |
| mise/asdf | `mise plugin install lazyhub ./packaging/mise` | Plugin seed prepared |

### via Homebrew (Recommended)
```bash
brew install saketh-kowtha/tap/lazyhub
```

### via npm
```bash
npm install -g lazyhub
```

### Ambient status
```bash
lazyhub status --format tmux
lazyhub status --format starship
lazyhub status --format json
```

`status` reads only the local SWR cache, so it is safe for tmux and starship
segments. Open the app once to seed the cache.

---

## 🎹 Keybindings (The Essentials)

| Key | Action |
| --- | --- |
| `Tab` | Cycle Navigation Panes |
| `j / k` | Navigate List / Scroll Content |
| `Enter` | View Detail / Open PR |
| `d` | Open Diff View |
| `/` | Fuzzy Search Current List |
| `A` | Trigger AI Review (in Diff) |
| `m` | Merge PR (Pick Strategy) |
| `r` | Refresh (Bypass Cache) |
| `S` | Settings & Themes |
| `?` | Full Keyboard Cheat Sheet |

---

## 🤝 Contributing

We welcome contributions from the community! Whether it's a bug fix, a new theme, or a feature request, check out our [ARCHITECTURE.md](./docs/ARCHITECTURE.md) to understand the project's internal invariants.

```bash
# Setup for development
npm install
npm run dev   # Auto-rebuild on change
npm test      # Run Vitest suite
```

---

## 📜 License

MIT © [Saketh Kowtha](https://github.com/saketh-kowtha)

---
