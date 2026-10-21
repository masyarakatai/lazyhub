import { describe, it, expect } from 'vitest'
import stringWidth from 'string-width'
import {
  DEFAULT_CONFIG,
  BUILTIN_SCOPES,
  BUILTIN_SCOPE_NAMES,
  validateConfig,
  mergeConfig,
  mergePlatformKeymaps,
  expandConfigPaths,
  expandHome,
  isPlainObject,
} from './schema.js'
import { homedir } from 'os'
import { join } from 'path'

describe('validateConfig — valid input', () => {
  it('passes a well-formed partial config through untouched', () => {
    const raw = {
      defaults: { pr_scope: 'reviewing', ai_provider: 'codex' },
      ui: { density: 'comfortable', show_hints: false },
    }
    const { config, warnings } = validateConfig(raw)
    expect(warnings).toEqual([])
    expect(config).toEqual(raw)
  })

  it('never throws on a non-object root', () => {
    const { config, warnings } = validateConfig('not a table')
    expect(config).toEqual({})
    expect(warnings.length).toBe(1)
  })
})

describe('validateConfig — unknown keys (warn, do not crash)', () => {
  it('warns on an unknown top-level section and drops it', () => {
    const { config, warnings } = validateConfig({ nonsense: { a: 1 }, ui: { show_hints: true } })
    expect(config).toEqual({ ui: { show_hints: true } })
    expect(warnings.some((w) => w.includes('nonsense'))).toBe(true)
  })

  it('warns on an unknown key inside a known section and drops it', () => {
    const { config, warnings } = validateConfig({ ui: { show_hints: true, bogus: 1 } })
    expect(config.ui).toEqual({ show_hints: true })
    expect(warnings.some((w) => w.includes('bogus'))).toBe(true)
  })
})

describe('validateConfig — invalid types (warn + ignore that key)', () => {
  it('drops a wrong-typed scalar but keeps siblings', () => {
    const { config, warnings } = validateConfig({ ui: { show_hints: 'yes', density: 'compact' } })
    expect(config.ui).toEqual({ density: 'compact' })
    expect(warnings.some((w) => w.includes('show_hints'))).toBe(true)
  })

  it('drops an out-of-enum value', () => {
    const { config, warnings } = validateConfig({ defaults: { pr_scope: 'everything' } })
    expect(config.defaults).toEqual({})
    expect(warnings.some((w) => w.includes('pr_scope'))).toBe(true)
  })
})

describe('validateConfig — meta.config_url HTTPS enforcement', () => {
  it('accepts an https url', () => {
    const { config, warnings } = validateConfig({ meta: { config_url: 'https://example.com/c.toml' } })
    expect(config.meta.config_url).toBe('https://example.com/c.toml')
    expect(warnings).toEqual([])
  })

  it('rejects an http url with a warning', () => {
    const { config, warnings } = validateConfig({ meta: { config_url: 'http://example.com/c.toml' } })
    expect(config.meta).toEqual({})
    expect(warnings.some((w) => w.includes('HTTPS'))).toBe(true)
  })

  it('accepts empty string (unset)', () => {
    const { config } = validateConfig({ meta: { config_url: '' } })
    expect(config.meta.config_url).toBe('')
  })
})

describe('validateConfig — daemon', () => {
  it('accepts a positive integer idle_timeout_minutes', () => {
    const { config, warnings } = validateConfig({ daemon: { idle_timeout_minutes: 45 } })
    expect(config.daemon.idle_timeout_minutes).toBe(45)
    expect(warnings).toEqual([])
  })

  it('rejects zero / negative / non-integer timeouts', () => {
    for (const bad of [0, -5, 12.5]) {
      const { config, warnings } = validateConfig({ daemon: { idle_timeout_minutes: bad } })
      expect(config.daemon).toEqual({})
      expect(warnings.length).toBeGreaterThan(0)
    }
  })
})

describe('validateConfig — scopes', () => {
  it('accepts a custom scope with bool flags and allow/deny lists', () => {
    const raw = {
      scopes: {
        'custom-bot': {
          allow_reads: true,
          allow_merges: false,
          repo_allowlist: ['org/a', 'org/b'],
          branch_denylist: ['main'],
        },
      },
    }
    const { config, warnings } = validateConfig(raw)
    expect(config.scopes['custom-bot']).toEqual(raw.scopes['custom-bot'])
    expect(warnings).toEqual([])
  })

  it('drops invalid scope keys / values', () => {
    const { config, warnings } = validateConfig({
      scopes: { weird: { allow_reads: 'yep', repo_allowlist: [1, 2], junk: true } },
    })
    expect(config.scopes.weird).toEqual({})
    expect(warnings.length).toBe(3)
  })

  it('ships all six built-in scope names in DEFAULT_CONFIG', () => {
    for (const name of BUILTIN_SCOPE_NAMES) {
      expect(DEFAULT_CONFIG.scopes[name]).toEqual(BUILTIN_SCOPES[name])
    }
  })
})

describe('validateConfig — ai.budget', () => {
  it('accepts caps and on_cap_exceeded', () => {
    const { config, warnings } = validateConfig({
      ai: { budget: { monthly_usd_cap: 10, per_call_usd_cap: 0.5, on_cap_exceeded: 'block' } },
    })
    expect(config.ai.budget).toEqual({ monthly_usd_cap: 10, per_call_usd_cap: 0.5, on_cap_exceeded: 'block' })
    expect(warnings).toEqual([])
  })

  it('rejects negative caps and unknown on_cap_exceeded', () => {
    const { config, warnings } = validateConfig({
      ai: { budget: { monthly_usd_cap: -1, on_cap_exceeded: 'explode' } },
    })
    expect(config.ai.budget).toEqual({})
    expect(warnings.length).toBe(2)
  })
})

describe('validateConfig — theme overrides', () => {
  it('accepts string and { fg, bg } token overrides', () => {
    const raw = {
      theme: {
        name: 'lazyhub-dark',
        overrides: { 'accent.primary': '#ff7eb6', 'diff.add': { fg: '#a8e6a3', bg: '#1b2a1b' } },
      },
    }
    const { config, warnings } = validateConfig(raw)
    expect(config.theme).toEqual(raw.theme)
    expect(warnings).toEqual([])
  })
})

describe('validateConfig — keymaps with platform sub-section', () => {
  it('keeps base bindings and a darwin sub-section as a nested table', () => {
    const { config, warnings } = validateConfig({
      keymaps: { 'pr-list': { j: 'cursor.down', darwin: { m: 'pr.merge' } } },
    })
    expect(config.keymaps['pr-list']).toEqual({ j: 'cursor.down', darwin: { m: 'pr.merge' } })
    expect(warnings).toEqual([])
  })

  it('warns when a keymap points at an unknown action id', () => {
    const { warnings } = validateConfig({
      keymaps: { global: { ',': 'settings.open' } },
    })
    expect(warnings.join('\n')).toContain('unknown action "settings.open"')
  })

  it('warns when normalized keys conflict in one scope', () => {
    const { warnings } = validateConfig({
      keymaps: { global: { enter: 'app.help', '<enter>': 'app.back' } },
    })
    expect(warnings.join('\n')).toContain('duplicate binding "<enter>" conflicts with "enter"')
  })
})

describe('validateConfig — openai-compatible provider', () => {
  it('warns when selected provider has an empty base_url', () => {
    const { warnings } = validateConfig({
      defaults: { ai_provider: 'openai-compatible' },
      ai: { openai_compatible: { base_url: '', model: 'qwen' } },
    })

    expect(warnings.join('\n')).toContain('[ai.openai_compatible].base_url')
  })
})

describe('mergeConfig', () => {
  it('deep-merges objects and replaces arrays/scalars', () => {
    const base = { a: { x: 1, y: 2 }, list: [1, 2], n: 5 }
    const out = mergeConfig(base, { a: { y: 9, z: 3 }, list: [3], n: 7 })
    expect(out).toEqual({ a: { x: 1, y: 9, z: 3 }, list: [3], n: 7 })
    // base untouched
    expect(base.a).toEqual({ x: 1, y: 2 })
  })

  it('merges a partial scope override onto a built-in (user wins per-key)', () => {
    const out = mergeConfig(DEFAULT_CONFIG, { scopes: { 'read-only': { allow_comments: true } } })
    expect(out.scopes['read-only']).toEqual({
      allow_reads: true,
      allow_writes: false,
      allow_approvals: false,
      allow_merges: false,
      allow_comments: true, // overridden
    })
    // other built-ins preserved
    expect(out.scopes.full).toEqual(BUILTIN_SCOPES.full)
  })
})

describe('mergePlatformKeymaps', () => {
  const keymaps = {
    'pr-list': { j: 'cursor.down', m: 'pr.merge', darwin: { m: 'pr.merge-mac' }, linux: { m: 'pr.merge-linux' } },
    global: { q: 'app.quit' },
  }

  it('folds the matching platform block onto the base and drops other platforms', () => {
    expect(mergePlatformKeymaps(keymaps, 'darwin')['pr-list']).toEqual({ j: 'cursor.down', m: 'pr.merge-mac' })
    expect(mergePlatformKeymaps(keymaps, 'linux')['pr-list']).toEqual({ j: 'cursor.down', m: 'pr.merge-linux' })
  })

  it('leaves base bindings intact when no platform block matches', () => {
    expect(mergePlatformKeymaps(keymaps, 'win32')['pr-list']).toEqual({ j: 'cursor.down', m: 'pr.merge' })
    expect(mergePlatformKeymaps(keymaps, 'darwin').global).toEqual({ q: 'app.quit' })
  })
})

describe('expandHome / expandConfigPaths', () => {
  it('expands ~ and ~/ via homedir, leaves other paths alone', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/.config/lazyhub/x')).toBe(join(homedir(), '.config/lazyhub/x'))
    expect(expandHome('/abs/path')).toBe('/abs/path')
    expect(expandHome('relative/x')).toBe('relative/x')
    expect(expandHome(42)).toBe(42)
  })

  it('expands the three known path fields in a config', () => {
    const out = expandConfigPaths(structuredClone(DEFAULT_CONFIG))
    expect(out.agent.audit_log_path).toBe(join(homedir(), '.config/lazyhub/audit.log'))
    expect(out.daemon.socket_path).toBe(join(homedir(), '.config/lazyhub/daemon.sock'))
    expect(out.daemon.pid_file).toBe(join(homedir(), '.config/lazyhub/daemon.pid'))
  })
})

describe('isPlainObject', () => {
  it('is true for plain objects only', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})

describe('agent default scope', () => {
  it('defaults to read-only', () => {
    expect(DEFAULT_CONFIG.agent.default_scope).toBe('read-only')
  })

  it('warns that a broader configured scope does not gain agent write authority', () => {
    const { config, warnings } = validateConfig({ agent: { default_scope: 'full' } })
    expect(config.agent.default_scope).toBe('full')
    expect(warnings.some(w => w.includes('agent mutations stay disabled'))).toBe(true)
  })
})

describe('default pane icons', () => {
  // Terminals and Ink disagree on the width of emoji-presentation and East Asian
  // ambiguous glyphs, which shifts box borders. Defaults must be 1 column everywhere.
  it.each(Object.entries(DEFAULT_CONFIG.panes))('%s icon is one column wide in narrow and wide-ambiguous terminals', (_pane, { icon }) => {
    expect(stringWidth(icon, { ambiguousIsNarrow: true })).toBe(1)
    expect(stringWidth(icon, { ambiguousIsNarrow: false })).toBe(1)
  })
})
