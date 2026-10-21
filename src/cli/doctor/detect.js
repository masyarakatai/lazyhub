/**
 * cli/doctor/detect.js — local detection of paths that can bypass lazyhub.
 *
 * Evidence, not proof (THREAT_MODEL T7): a finding says what was seen in known
 * locations; absence never means no alternate path exists. Read-only: files are
 * read, nothing is written or executed. SECRET SAFETY: only names, hosts and
 * counts are reported. Token values, credential-helper arguments, MCP `env` /
 * `args` / headers and key material are never copied into a finding.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, delimiter, resolve, isAbsolute } from 'path'
import { parse as parseToml } from 'smol-toml'

const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
const DIRECT_CLIENTS = ['hub', 'github']
const GITHUB_REMOTE = /^(?:git@|ssh:\/\/(?:[^@/]+@)?)([^:/]+)[:/]/

/**
 * Read a text file: `{state: 'ok'|'missing'|'unreadable', text}`.
 * @param path
 */
function readText(path) {
  try {
    return { state: 'ok', text: readFileSync(path, 'utf8') }
  } catch (err) {
    return { state: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'unreadable', text: '' }
  }
}

const finding = (id, category, status, reason, evidence = []) => ({ id, category, status, reason, evidence })

function envTokens(env) {
  const names = TOKEN_ENV.filter(n => env[n])
  return finding('env_tokens', 'alternate_credentials', names.length ? 'detected' : 'not_detected',
    names.length ? 'Token environment variables are set; any process with them can call GitHub without lazyhub.' : 'No token environment variables set in this shell.',
    names.map(n => ({ kind: 'env_var_present', source: n })))
}

/**
 * gh hosts.yml: only top-level host keys and account counts are read; token fields are never touched.
 * @param env
 * @param home
 */
function ghHosts(env, home) {
  const path = join(env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'gh'), 'hosts.yml')
  const f = readText(path)
  if (f.state === 'unreadable') return finding('gh_hosts', 'alternate_credentials', 'unknown', 'gh hosts file exists but could not be read.', [{ kind: 'file_unreadable', source: path }])
  if (f.state === 'missing') return finding('gh_hosts', 'alternate_credentials', 'not_detected', 'No gh hosts file at the known location.', [])
  const hosts = []
  let accounts = 0
  let inUsers = false
  for (const line of f.text.split(/\r?\n/)) {
    const host = /^([A-Za-z0-9.-]+):\s*$/.exec(line)
    if (host) { hosts.push(host[1]); inUsers = false; continue }
    if (/^\s{4}users:\s*$/.test(line)) { inUsers = true; continue }
    if (inUsers && /^\s{8}[^\s:]+:\s*$/.test(line)) accounts += 1
    else if (/^\s{4}\S/.test(line)) inUsers = false
  }
  const extra = hosts.length > 1 || accounts > 1
  return finding('gh_hosts', 'alternate_credentials', extra ? 'detected' : 'not_detected',
    extra ? 'gh holds more than one host or account; the active one may differ from the one lazyhub governs.' : 'gh holds a single host and at most one account.',
    [{ kind: 'gh_hosts', source: path, hosts, account_count: accounts }])
}

function helperLabel(value) {
  const v = value.trim()
  if (!v) return 'empty'
  if (v.startsWith('!')) return 'shell-command'
  return v.split(/\s+/)[0].slice(0, 40)
}

/**
 * Resolve the repo's real config path, following worktree `.git` files.
 * @param cwd
 */
function gitConfigPath(cwd) {
  const dotGit = join(cwd, '.git')
  let st
  try { st = statSync(dotGit) } catch { return { state: 'missing', path: null } }
  if (st.isDirectory()) return { state: 'ok', path: join(dotGit, 'config') }
  const ptr = /^gitdir:\s*(.+)$/m.exec(readText(dotGit).text)
  if (!ptr) return { state: 'unreadable', path: null }
  const gitdir = isAbsolute(ptr[1].trim()) ? ptr[1].trim() : resolve(cwd, ptr[1].trim())
  const common = readText(join(gitdir, 'commondir'))
  const base = common.state === 'ok' ? resolve(gitdir, common.text.trim()) : gitdir
  return { state: 'ok', path: join(base, 'config') }
}

function gitHelpers(env, home, cwd) {
  const sources = [join(home, '.gitconfig'), join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config')]
  const repoCfg = gitConfigPath(cwd)
  if (repoCfg.path) sources.push(repoCfg.path)
  const helpers = []
  const unreadable = []
  for (const path of sources) {
    const f = readText(path)
    if (f.state === 'unreadable') unreadable.push({ kind: 'file_unreadable', source: path })
    let inCredential = false
    for (const line of f.text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line)
      if (section) inCredential = /^credential(\s|$)/i.test(section[1])
      const h = inCredential && /^\s*helper\s*=\s*(.*)$/.exec(line)
      if (h) helpers.push({ kind: 'credential_helper', source: path, helper: helperLabel(h[1]) })
    }
  }
  if (readText(join(home, '.git-credentials')).state !== 'missing') {
    helpers.push({ kind: 'plaintext_credential_store_file', source: join(home, '.git-credentials') })
  }
  const status = helpers.length ? 'detected' : unreadable.length ? 'unknown' : 'not_detected'
  return finding('git_credential_helpers', 'alternate_credentials', status,
    helpers.length ? 'git can authenticate to GitHub over HTTPS without gh or lazyhub.' : unreadable.length ? 'Some git config files could not be read.' : 'No credential helpers in the user or repository git config.',
    [...helpers, ...unreadable])
}

function sshPaths(env, home, cwd) {
  const cfg = gitConfigPath(cwd)
  if (cfg.state === 'missing') return finding('ssh_push_paths', 'ssh', 'unknown', 'Current directory is not a git repository; remotes were not inspected.', [])
  const gc = cfg.path ? readText(cfg.path) : { state: 'unreadable', text: '' }
  if (gc.state !== 'ok') return finding('ssh_push_paths', 'ssh', 'unknown', 'Repository git config could not be read.', [])
  const evidence = []
  let remote = null
  for (const line of gc.text.split(/\r?\n/)) {
    const section = /^\s*\[remote "([^"]+)"\]/.exec(line)
    if (section) { remote = section[1]; continue }
    if (/^\s*\[/.test(line)) { remote = null; continue }
    const url = remote && /^\s*(?:push)?url\s*=\s*(.*)$/.exec(line)
    const host = url && GITHUB_REMOTE.exec(url[1].trim())
    if (host) evidence.push({ kind: 'ssh_remote', source: cfg.path, remote, host: host[1] })
  }
  const sshDir = join(home, '.ssh')
  let keys = []
  try { keys = readdirSync(sshDir).filter(n => /^id_[a-z0-9_]+$/i.test(n)) } catch { /* no ~/.ssh */ }
  for (const k of keys) evidence.push({ kind: 'ssh_private_key_file', source: join(sshDir, k) })
  if (env.SSH_AUTH_SOCK) evidence.push({ kind: 'ssh_agent_socket_present', source: 'SSH_AUTH_SOCK' })
  if (/^\s*Host\s+.*\bgithub\.com\b/im.test(readText(join(sshDir, 'config')).text)) {
    evidence.push({ kind: 'ssh_config_host_entry', source: join(sshDir, 'config'), host: 'github.com' })
  }
  return finding('ssh_push_paths', 'ssh', evidence.length ? 'detected' : 'not_detected',
    evidence.length ? 'SSH remotes or keys may allow pushes that bypass gh and lazyhub. Which keys GitHub accepts cannot be determined locally.' : 'No SSH remotes, key files or agent found in known locations.',
    evidence)
}

function directClients(env) {
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean)
  const evidence = []
  for (const name of DIRECT_CLIENTS) {
    for (const d of dirs) {
      try {
        if (statSync(join(d, name)).isFile()) { evidence.push({ kind: 'github_client_on_path', source: join(d, name), client: name }); break }
      } catch { /* not in this directory */ }
    }
  }
  return finding('direct_github_clients', 'direct_clients', evidence.length ? 'detected' : 'not_detected',
    evidence.length ? 'Other GitHub command-line clients are installed.' : 'No known GitHub clients (hub, github) on PATH.', evidence)
}

/**
 * [agent, absolute path, parser] for each known agent MCP config location.
 * @param home
 * @param cwd
 */
function mcpSources(home, cwd) {
  const json = text => { const j = JSON.parse(text); return { ...(j.mcpServers || {}), ...(j.servers || {}) } }
  const claudeJson = text => {
    const j = JSON.parse(text)
    return { ...(j.mcpServers || {}), ...(j.projects?.[cwd]?.mcpServers || {}) }
  }
  const toml = text => parseToml(text).mcp_servers || {}
  /** @type {[string, string, (text: string) => object][]} */
  const sources = [
    ['claude-code', join(home, '.claude.json'), claudeJson],
    ['claude-code', join(cwd, '.mcp.json'), json],
    ['claude-desktop', join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), json],
    ['claude-desktop', join(home, '.config', 'Claude', 'claude_desktop_config.json'), json],
    ['cursor', join(home, '.cursor', 'mcp.json'), json],
    ['cursor', join(cwd, '.cursor', 'mcp.json'), json],
    ['windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json'), json],
    ['vscode', join(cwd, '.vscode', 'mcp.json'), json],
    ['gemini', join(home, '.gemini', 'settings.json'), json],
    ['codex', join(home, '.codex', 'config.toml'), toml],
  ]
  return sources
}

function mcpServers(home, cwd) {
  const other = []
  const github = []
  const unreadable = []
  for (const [agent, path, parse] of mcpSources(home, cwd)) {
    const f = readText(path)
    if (f.state === 'missing') continue
    let servers
    try {
      if (f.state !== 'ok') throw new Error('unreadable')
      servers = parse(f.text)
    } catch {
      unreadable.push({ kind: 'file_unreadable_or_invalid', source: path, agent })
      continue
    }
    for (const [name, cfg] of Object.entries(servers || {})) {
      // Matching reads command/args/url internally; none of those values is reported.
      const haystack = [name, cfg?.command, cfg?.url, ...(Array.isArray(cfg?.args) ? cfg.args : [])].join(' ')
      if (/lazyhub/i.test(haystack)) continue
      const row = { kind: 'mcp_server', source: path, agent, server: name }
      other.push(row)
      if (/github/i.test(haystack)) github.push({ ...row, kind: 'github_mcp_server' })
    }
  }
  const mk = (id, category, rows, yes, no) => finding(id, category, rows.length ? 'detected' : unreadable.length ? 'unknown' : 'not_detected',
    rows.length ? yes : unreadable.length ? 'Some MCP config files could not be parsed.' : no, [...rows, ...unreadable])
  return [
    mk('other_mcp_servers', 'mcp_servers', other, 'Other MCP servers are configured for local agents; their tools are outside lazyhub governance.', 'No other MCP servers found in known agent config locations.'),
    mk('github_mcp_servers', 'direct_clients', github, 'An MCP server that appears to target GitHub is configured; it may hold its own credential.', 'No GitHub-targeting MCP servers found in known agent config locations.'),
  ]
}

/** Conditions lazyhub cannot inspect; always reported so absence is never read as proof. */
const UNKNOWN_CONDITIONS = [
  { id: 'os_credential_stores', reason: 'OS keychain / credential-manager contents and system-level git config are not inspected.' },
  { id: 'agent_runtime_secrets', reason: 'Credentials held by agents, CI, containers or other machines are not visible from this shell.' },
  { id: 'github_side_keys', reason: 'Which SSH keys, deploy keys and tokens GitHub accepts for this repository is not determined locally.' },
]

/**
 * Detect alternate paths around lazyhub. Read-only; I/O problems become `unknown`, never throws.
 *
 * @param {{env?: object, home?: string, cwd?: string}} [opts]
 * @returns {{findings: object[], unknown: {id: string, reason: string}[]}}
 *   finding = {id, category, status: 'detected'|'not_detected'|'unknown', reason, evidence[]}
 */
export function detectAlternatePaths({ env = process.env, home = env.HOME || '', cwd = process.cwd() } = {}) {
  return {
    findings: [envTokens(env), ghHosts(env, home), gitHelpers(env, home, cwd), sshPaths(env, home, cwd), directClients(env), ...mcpServers(home, cwd)],
    unknown: UNKNOWN_CONDITIONS,
  }
}
