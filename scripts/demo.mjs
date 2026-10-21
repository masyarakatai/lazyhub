#!/usr/bin/env node
/**
 * scripts/demo.mjs — render the promo recordings in docs/demo/tapes with VHS.
 *
 *   npm run demo              # every tape
 *   npm run demo -- watch-only   # one tape (name without .tape)
 *
 * Deterministic and LLM-free: the tapes run against a fixture-only `gh`
 * (scripts/demo/gh-shim.mjs) with a throwaway HOME, so no real GitHub data,
 * credentials or personal config can appear in a recording.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TAPES = join(ROOT, 'docs', 'demo', 'tapes')
const OUT = join(ROOT, 'docs', 'demo', 'out')
const BIN = join(ROOT, 'dist', 'lazyhub.js')
const SHIM = join(ROOT, 'scripts', 'demo', 'gh-shim.mjs')

// Minimal config. Pane icons are plain single-width characters: the default glyphs
// (e.g. the emoji-width lightning bolt) make terminals and Ink disagree on column
// widths, which shifts box borders in the recordings.
const DEMO_CONFIG = `[meta]
schema_version = "1.0"

[panes.prs]
icon = "+"
[panes.issues]
icon = "o"
[panes.branches]
icon = "Y"
[panes.actions]
icon = "*"
[panes.notifications]
icon = "!"
`

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

function ensureVhs() {
  try {
    execFileSync('vhs', ['--version'], { stdio: 'ignore' })
  } catch {
    console.error('demo: `vhs` is not installed (it also needs ttyd and ffmpeg).\n  macOS:  brew install vhs\n  other:  https://github.com/charmbracelet/vhs#installation')
    process.exit(1)
  }
}

function listTapes(only) {
  const names = readdirSync(TAPES).filter(f => f.endsWith('.tape') && !f.startsWith('_')).map(f => f.slice(0, -5)).sort()
  if (!only) return names
  if (!names.includes(only)) {
    console.error(`demo: no tape named "${only}". Available: ${names.join(', ')}`)
    process.exit(1)
  }
  return [only]
}

function installWrappers(dir) {
  mkdirSync(dir, { recursive: true })
  const wrappers = { gh: SHIM, lazyhub: BIN }
  for (const [name, target] of Object.entries(wrappers)) {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(target)} "$@"\n`)
    chmodSync(file, 0o755)
  }
}

async function main() {
  const only = process.argv[2]
  const tapes = listTapes(only)
  ensureVhs()
  // Build only when dist is missing; run `npm run build` yourself after source changes.
  if (!existsSync(BIN)) await run('npm', ['run', 'build'], { cwd: ROOT })

  mkdirSync(OUT, { recursive: true })
  const temp = mkdtempSync(join(tmpdir(), 'lazyhub-demo-'))
  const home = join(temp, 'home')
  const bin = join(temp, 'bin')
  mkdirSync(home, { recursive: true })
  installWrappers(bin)
  // A config file keeps first-run onboarding from taking over the recording.
  mkdirSync(join(home, '.config', 'lazyhub'), { recursive: true })
  writeFileSync(join(home, '.config', 'lazyhub', 'lazyhub.toml'), DEMO_CONFIG)

  // vhs itself keeps the real HOME (it caches a browser there); the recorded
  // shell switches to DEMO_HOME/DEMO_BIN in the hidden setup of _settings.tape.
  const env = { ...process.env, DEMO_HOME: home, DEMO_BIN: bin, PATH: `${bin}${delimiter}${process.env.PATH}` }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.ANTHROPIC_API_KEY

  try {
    for (const name of tapes) {
      console.log(`demo: recording ${name}`)
      await run('vhs', [join(TAPES, `${name}.tape`)], { cwd: ROOT, env, maxBuffer: 1 << 26 })
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  console.log(`demo: wrote ${tapes.length} tape(s) to docs/demo/out/`)
}

main().catch(err => {
  console.error(`demo: ${err.stderr || err.message}`)
  process.exit(1)
})
