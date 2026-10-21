# Demo recordings

Deterministic, LLM-free recordings of lazyhub made with [VHS](https://github.com/charmbracelet/vhs).
They run against a fixture-only `gh` (`scripts/demo/gh-shim.mjs`, fictional `acme/rocket` repo) with a
throwaway `HOME`, so no real GitHub data or personal config can leak in.

## Record locally

```
brew install vhs     # also pulls in ttyd and ffmpeg
npm run build        # the runner only builds if dist/ is missing
npm run demo         # all tapes
npm run demo -- tour # one tape (file name without .tape)
```

Outputs land in `docs/demo/out/` (GIFs, PNG screenshots, and `tour.mp4`).

## Tapes

| Tape | Shows |
|---|---|
| `tour` | launch, PR list, PR detail, diff (also renders `tour.mp4`) |
| `panes` | Issues and Actions panes |
| `watch-only` | `lazyhub watch-only --repo acme/rocket` |
| `doctor-coverage` | `lazyhub doctor --coverage --repo acme/rocket` |

## Add a tape

1. Create `docs/demo/tapes/<name>.tape`. Start with `Output`, set `Width`/`Height`, then
   `Source docs/demo/tapes/_settings.tape` (shared font, theme, and the hidden env setup).
2. Keep it under about 20 seconds. Wait on screen text (`Wait+Screen@30s /#142/`) rather than sleeping
   for app startup, and end with a short `Sleep` after the last `Screenshot` (VHS can drop it otherwise).
3. If the flow needs new `gh` responses, extend `scripts/demo/gh-shim.mjs`. Run with
   `LAZYHUB_DEMO_GH_LOG=/path/to/log npm run demo -- <name>` to see which calls the app makes.

## CI

`.github/workflows/demo.yml` runs on manual dispatch and on `v*` tag pushes. It re-records, and if the
outputs changed it force-pushes `auto/demo-refresh` and opens a PR (it never pushes to `main`).
The repository setting "Allow GitHub Actions to create and approve pull requests" must be enabled.

## Fonts

Tapes use `Hack Nerd Font Mono` (falls back to JetBrains Mono, then monospace). Pane icons are overridden in the demo config with single-width characters: the default glyphs (notably the lightning bolt) have ambiguous or double width, which makes Ink and the terminal disagree on columns and shifts box borders.
