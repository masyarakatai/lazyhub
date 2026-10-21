/**
 * bootstrap.js — runs BEFORE any Ink UI is rendered.
 * Steps:
 *   1. Detect gh CLI
 *   2. Detect gh auth status
 *   3. Detect repo context
 *   4. Hand off to renderApp()
 */

import { execa } from 'execa'
import { writeDefaultConfig } from './config.js'
import readline from 'readline'

// ─── Step 1: detect gh ────────────────────────────────────────────────────────

/**
 *
 */
export async function detectGh() {
  try {
    await execa('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 *
 * @param platform
 */
export function printInstallInstructions(platform) {
  console.error('\n  ✗ gh (GitHub CLI) is not installed.\n')

  if (platform === 'darwin') {
    console.error('  Install it with Homebrew:')
    console.error('    brew install gh\n')
  } else if (platform === 'linux') {
    console.error('  Install on Ubuntu/Debian:')
    console.error('    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\')
    console.error('      | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg')
    console.error('    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\')
    console.error('      | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null')
    console.error('    sudo apt update && sudo apt install gh')
    console.error('')
    console.error('  Install on Fedora/RHEL:')
    console.error('    sudo dnf install gh\n')
  } else if (platform === 'win32') {
    console.error('  Install on Windows (choose one):')
    console.error('    winget install --id GitHub.cli')
    console.error('    scoop install gh\n')
  } else {
    console.error('  Install instructions: https://cli.github.com\n')
  }
}

// ─── Step 2: detect auth ──────────────────────────────────────────────────────

/**
 * Extract the hostname (e.g. "github.enterprise.com") from the origin remote
 * URL of the current working directory. Returns null when not in a git repo,
 * when no origin is set, or when the URL can't be parsed.
 *
 * Handles:
 *   https://host/owner/repo(.git)?
 *   https://user@host/owner/repo(.git)?
 *   ssh://git@host[:port]/owner/repo(.git)?
 *   git@host:owner/repo(.git)?
 */
export async function detectHostFromRemote() {
  try {
    const result = await execa('git', ['remote', 'get-url', 'origin'], { reject: false })
    if (result.exitCode !== 0) return null
    const url = result.stdout.trim()
    const m = url.match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Check that the user is authenticated with `gh` for the target hostname
 * (GH_HOST if set, otherwise github.com).
 *
 * Uses `gh auth token` rather than `gh auth status`: the former exits 0 iff
 * there is a valid token for the host, while `gh auth status` can exit
 * non-zero when a secondary host has issues — falsely marking GHE users as
 * unauthenticated when they're perfectly logged in.
 */
export async function checkAuth() {
  const args = process.env.GH_HOST
    ? ['auth', 'token', '--hostname', process.env.GH_HOST]
    : ['auth', 'token']
  try {
    const result = await execa('gh', args, { reject: false })
    return result.exitCode === 0 && !!(result.stdout || '').trim()
  } catch {
    return false
  }
}

/**
 * Parse `gh auth status` output to find any host the user is logged into.
 * Prefers a host marked as the active account; otherwise returns the first
 * logged-in host found. Returns null if nothing is logged in.
 *
 * Why: `gh auth token` without `--hostname` only checks github.com. When a
 * user is GHE-only logged in and runs lazyhub outside a git repo (so the
 * remote-based GH_HOST auto-detect can't fire), the default check misses
 * their existing login and prompts a bogus re-login.
 */
export async function detectAuthenticatedHost() {
  try {
    const result = await execa('gh', ['auth', 'status'], { reject: false })
    const text = `${result.stdout || ''}\n${result.stderr || ''}`
    const blocks = text.split(/\n\s*\n/)
    let firstHost = null
    for (const block of blocks) {
      const loginMatch = block.match(/Logged in to (\S+)/)
      if (!loginMatch) continue
      const host = loginMatch[1]
      if (!firstHost) firstHost = host
      if (/Active account:\s*true/.test(block)) return host
    }
    return firstHost
  } catch {
    return null
  }
}

/**
 *
 */
export function hasBrowser() {
  if (process.platform === 'darwin') return true
  if (process.platform === 'win32') return true
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true
  return false
}

/**
 *
 * @param rl
 */
async function readPATFromStdin(rl) {
  return new Promise((resolve) => {
    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    }
    process.stdout.write('  Paste a GitHub PAT with repo + read:org scopes: ')
    // Suppress echoing
    const orig = rl.output
    rl.output = { write: () => {} }
    rl.question('', (answer) => {
      rl.output = orig
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/**
 *
 */
export async function getLoggedInUser() {
  try {
    const { stdout } = await execa('gh', ['api', 'user', '--jq', '.login'])
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 *
 */
async function runLoginFlow() {
  const ghHost = process.env.GH_HOST
  process.stdout.write('  lazyhub needs GitHub access. Starting login...\n')

  if (process.env.GITHUB_TOKEN) {
    try {
      const loginArgs = ghHost
        ? ['auth', 'login', '--hostname', ghHost, '--with-token']
        : ['auth', 'login', '--with-token']
      const proc = execa('gh', loginArgs, { reject: false })
      proc.stdin.write(process.env.GITHUB_TOKEN)
      proc.stdin.end()
      await proc
      return
    } catch {
      // fall through
    }
  }

  const loginArgs = ['auth', 'login']
  if (ghHost) loginArgs.push('--hostname', ghHost)
  if (hasBrowser()) {
    await execa('gh', [...loginArgs, '--web', '--git-protocol', 'https'], {
      stdio: 'inherit',
      reject: false,
    })
  } else {
    const pat = await readPATFromStdin()
    if (pat) {
      const withTokenArgs = ghHost
        ? ['auth', 'login', '--hostname', ghHost, '--with-token']
        : ['auth', 'login', '--with-token']
      const proc = execa('gh', withTokenArgs, { reject: false })
      proc.stdin.write(pat)
      proc.stdin.end()
      await proc
    }
  }
}

// ─── Step 3: detect repo context ─────────────────────────────────────────────

/**
 *
 */
export async function detectRepo() {
  const ghHost = process.env.GH_HOST || 'github.com'
  const escapedHost = ghHost.replace(/\./g, '\\.')

  // 1. Parse git remote origin URL — fast, no network needed
  try {
    const result = await execa('git', ['remote', 'get-url', 'origin'], { reject: false })
    if (result.exitCode === 0) {
      const url = result.stdout.trim()
      // Handles HTTPS (host/owner/repo) and SSH (git@host:owner/repo)
      const match = url.match(new RegExp(`${escapedHost}[/:]([^/\\s]+\\/[^/\\s.]+?)(?:\\.git)?$`))
      if (match) return match[1]
    }
  } catch { /* not in a git repo */ }

  // 2. Let gh resolve it from the git context
  const viewArgs = ['repo', 'view', '--json', 'name,owner']
  try {
    const result = await execa('gh', viewArgs, { reject: false })
    if (result.exitCode === 0 && result.stdout) {
      const data = JSON.parse(result.stdout)
      return `${data.owner.login}/${data.name}`
    }
  } catch { /* gh can't figure it out */ }

  return null
}

/**
 *
 */
export async function listRepos() {
  try {
    const { stdout } = await execa('gh', [
      'repo', 'list',
      '--limit', '20',
      '--json', 'name,nameWithOwner',
    ])
    return JSON.parse(stdout)
  } catch {
    return []
  }
}

/**
 *
 * @param repos
 */
async function pickRepoInteractive(repos) {
  return new Promise((resolve) => {
    if (repos.length === 0) {
      console.error('  No repositories found.')
      resolve(null)
      return
    }

    let selected = 0

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H')
      process.stdout.write('  Select a repository (j/k or ↑↓ to move, Enter to select):\n\n')
      repos.forEach((repo, i) => {
        const prefix = i === selected ? '  ▶ ' : '    '
        process.stdout.write(`${prefix}${repo.nameWithOwner}\n`)
      })
    }

    render()

    const onKeypress = (key) => {
      if (key === '\x1b[A' || key === 'k') {
        selected = Math.max(0, selected - 1)
        render()
      } else if (key === '\x1b[B' || key === 'j') {
        selected = Math.min(repos.length - 1, selected + 1)
        render()
      } else if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', onKeypress)
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false)
        }
        process.stdin.pause()
        process.stdout.write('\x1b[2J\x1b[H')
        resolve(repos[selected].nameWithOwner)
      } else if (key === '\x03') {
        process.exit(0)
      }
    }

    process.stdin.on('data', onKeypress)
  })
}

// ─── Main bootstrap() ─────────────────────────────────────────────────────────

/**
 *
 * @param renderApp
 * @param {object} [root0]
 * @param {string} [root0.repo] repository chosen in the first-run flow
 */
export async function bootstrap(renderApp, { repo: chosenRepo } = /** @type {{repo?: string}} */ ({})) {
  // Write default config on first run
  writeDefaultConfig()

  // Step 1 — detect gh
  const ghInstalled = await detectGh()
  if (!ghInstalled) {
    printInstallInstructions(process.platform)
    process.exit(1)
  }

  // Auto-detect GitHub Enterprise host from the git remote. Users who cloned
  // a GHE repo but haven't exported GH_HOST would otherwise be treated as if
  // they were targeting github.com and get a bogus "not logged in" prompt.
  if (!process.env.GH_HOST) {
    const detectedHost = await detectHostFromRemote()
    if (detectedHost && detectedHost !== 'github.com') {
      process.env.GH_HOST = detectedHost
    }
  }

  // Step 2 — detect auth
  let isLoggedIn = await checkAuth()
  if (!isLoggedIn && !process.env.GH_HOST) {
    // Covers the GHE-only-login-outside-a-git-repo case where checkAuth
    // defaulted to github.com and missed the user's actual login.
    const authedHost = await detectAuthenticatedHost()
    if (authedHost) {
      process.env.GH_HOST = authedHost
      isLoggedIn = await checkAuth()
    }
  }
  if (!isLoggedIn) {
    const host = process.env.GH_HOST || 'github.com'
    process.stdout.write(`  Not authenticated with ${host}.\n`)
    await runLoginFlow()

    const stillLoggedIn = await checkAuth()
    if (!stillLoggedIn) {
      console.error(`\n  ✗ GitHub authentication failed for ${host}.`)
      console.error(`    Please run: gh auth login${process.env.GH_HOST ? ` --hostname ${process.env.GH_HOST}` : ''}\n`)
      process.exit(1)
    }

    const username = await getLoggedInUser()
    if (username) {
      process.stdout.write(`  ✓ Logged in as ${username}\n`)
    }
  }

  // Step 3 — detect repo context
  let repo = chosenRepo || await detectRepo() // chosenRepo: picked in the first-run flow
  if (!repo) {
    const repos = await listRepos()
    repo = await pickRepoInteractive(repos)
    if (!repo) {
      console.error('\n  ✗ No repository selected. Exiting.\n')
      process.exit(1)
    }
  }
  process.env.GHUI_REPO = repo

  // Step 4 — hand off to Ink
  if (typeof renderApp === 'function') {
    renderApp()
  }
}
