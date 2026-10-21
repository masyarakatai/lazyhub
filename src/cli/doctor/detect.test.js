/**
 * cli/doctor/detect.test.js — alternate-path detection against fixture homes.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { detectAlternatePaths } from './detect.js'

const SECRET = 'ghp_supersecretvalue123'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'lazyhub-detect-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const put = (base, rel, text) => {
    const p = join(base, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
  }
  return { home, cwd, put, env: { HOME: home, PATH: '' } }
}
const byId = (r, id) => r.findings.find(f => f.id === id)

describe('detectAlternatePaths', () => {
  it('reports not_detected everywhere on a clean machine, and always lists unknown conditions', () => {
    const { home, cwd, env, put } = sandbox()
    put(cwd, '.git/config', '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n')
    const r = detectAlternatePaths({ env, home, cwd })
    expect(r.findings.map(f => f.status)).toEqual(Array(r.findings.length).fill('not_detected'))
    expect(r.unknown.length).toBeGreaterThan(0)
  })

  it('detects env tokens, extra gh hosts/accounts and credential helpers by name only', () => {
    const { home, cwd, env, put } = sandbox()
    put(home, '.config/gh/hosts.yml', `github.com:\n    users:\n        alice:\n        bob:\n    oauth_token: ${SECRET}\nghe.corp.example:\n    oauth_token: ${SECRET}\n`)
    put(home, '.gitconfig', `[credential]\n\thelper = store --file=/x/${SECRET}\n[credential "https://github.com"]\n\thelper = !f() { echo password=${SECRET}; }; f\n`)
    put(home, '.git-credentials', `https://u:${SECRET}@github.com\n`)
    const r = detectAlternatePaths({ env: { ...env, GH_TOKEN: SECRET, GITHUB_TOKEN: SECRET }, home, cwd })
    expect(byId(r, 'env_tokens')).toMatchObject({ status: 'detected', evidence: [{ source: 'GH_TOKEN' }, { source: 'GITHUB_TOKEN' }] })
    expect(byId(r, 'gh_hosts').evidence[0]).toMatchObject({ hosts: ['github.com', 'ghe.corp.example'], account_count: 2 })
    expect(byId(r, 'git_credential_helpers').evidence.map(e => e.helper || e.kind)).toEqual(['store', 'shell-command', 'plaintext_credential_store_file'])
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('detects SSH remotes, key files, agent and direct clients; unknown outside a repo', () => {
    const { home, cwd, env, put } = sandbox()
    put(cwd, '.git/config', '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n')
    put(home, '.ssh/id_ed25519', 'PRIVATE KEY MATERIAL')
    put(home, '.ssh/id_ed25519.pub', 'pub')
    put(home, 'bin/hub', '#!/bin/sh\n')
    const r = detectAlternatePaths({ env: { ...env, SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: join(home, 'bin') }, home, cwd })
    expect(byId(r, 'ssh_push_paths').evidence.map(e => e.kind)).toEqual(['ssh_remote', 'ssh_private_key_file', 'ssh_agent_socket_present'])
    expect(byId(r, 'direct_github_clients')).toMatchObject({ status: 'detected', evidence: [{ client: 'hub' }] })
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY MATERIAL')
    expect(byId(detectAlternatePaths({ env, home, cwd: home }), 'ssh_push_paths').status).toBe('unknown')
  })

  it('lists MCP servers for known agents, flags GitHub ones, skips lazyhub, never prints env/args', () => {
    const { home, cwd, env, put } = sandbox()
    put(cwd, '.mcp.json', JSON.stringify({ mcpServers: {
      lazyhub: { command: 'lazyhub', args: ['mcp-server'] },
      github: { command: 'npx', args: ['server-github'], env: { GITHUB_TOKEN: SECRET } },
      docs: { url: 'https://docs.example/mcp', headers: { Authorization: SECRET } },
    } }))
    put(home, '.codex/config.toml', `[mcp_servers.search]\ncommand = "search"\nenv = { KEY = "${SECRET}" }\n`)
    put(home, '.cursor/mcp.json', '{ not json')
    const r = detectAlternatePaths({ env, home, cwd })
    const other = byId(r, 'other_mcp_servers')
    expect(other.status).toBe('detected')
    expect(other.evidence.filter(e => e.server).map(e => `${e.agent}:${e.server}`)).toEqual(['claude-code:github', 'claude-code:docs', 'codex:search'])
    expect(other.evidence.some(e => e.kind === 'file_unreadable_or_invalid')).toBe(true)
    expect(byId(r, 'github_mcp_servers').evidence.filter(e => e.server).map(e => e.server)).toEqual(['github'])
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('reports unknown (not not_detected) when an MCP config cannot be parsed and nothing else is found', () => {
    const { home, cwd, env, put } = sandbox()
    put(home, '.cursor/mcp.json', '{ not json')
    expect(byId(detectAlternatePaths({ env, home, cwd }), 'other_mcp_servers').status).toBe('unknown')
  })
})
