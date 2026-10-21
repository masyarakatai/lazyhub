/**
 * config/schema.js — TOML config schema, defaults, validation, and merge logic.
 *
 * This is the pure (no I/O) core of the V1 user-config layer (issue #130, Phase E1).
 * `loader.js` handles all file/network I/O and calls into here.
 *
 * Exports:
 *   - SCHEMA_VERSION      current schema version string
 *   - BUILTIN_SCOPES      the six built-in permission scopes (ARCHITECT_DECISIONS §7)
 *   - DEFAULT_CONFIG      full JS defaults — emergency fallback + canonical shape.
 *                         Values MUST mirror defaultConfig.toml (enforced by a test).
 *   - validateConfig(raw) → { config, warnings }  type-checks a parsed TOML object,
 *                         drops invalid/unknown keys (never throws), collects warnings.
 *   - mergeConfig(a, b)   deep merge (b wins); plain objects merge, arrays/scalars replace.
 *   - mergePlatformKeymaps(keymaps, platform)  fold [keymaps.ctx.<platform>] onto base.
 *   - expandConfigPaths(config)  expand leading ~ to homedir() for known path fields.
 *
 * Validation philosophy (issue acceptance #2):
 *   - unknown key  → warn, ignore that key (don't crash)
 *   - wrong type   → warn, ignore that key (default fills in via merge)
 *   - valid value  → keep
 */

import { homedir } from 'os'
import { join } from 'path'

export const SCHEMA_VERSION = '1.0'

const PLATFORMS = ['darwin', 'linux', 'win32']

const SCOPE_BOOL_KEYS = ['allow_reads', 'allow_writes', 'allow_approvals', 'allow_merges', 'allow_comments']
const SCOPE_ARRAY_KEYS = ['repo_allowlist', 'branch_denylist']

// ─── Built-in permission scopes (ARCHITECT_DECISIONS §7) ────────────────────────

/** @typedef {{allow_reads:boolean,allow_writes:boolean,allow_approvals:boolean,allow_merges:boolean,allow_comments:boolean}} Scope */

function scope(reads, writes, approvals, merges, comments) {
  return {
    allow_reads: reads,
    allow_writes: writes,
    allow_approvals: approvals,
    allow_merges: merges,
    allow_comments: comments,
  }
}

export const BUILTIN_SCOPE_NAMES = ['full', 'read-only', 'review-only', 'comment-only', 'no-merge', 'triage-only']

export const BUILTIN_SCOPES = {
  'full':         scope(true,  true,  true,  true,  true),
  'read-only':    scope(true,  false, false, false, false),
  'review-only':  scope(true,  false, true,  false, true),
  'comment-only': scope(true,  false, false, false, true),
  'no-merge':     scope(true,  true,  true,  false, true),
  'triage-only':  scope(true,  false, false, false, true), // comments on issues only — enforced in L3 #148
}

// ─── Canonical JS defaults (mirror of defaultConfig.toml) ───────────────────────

export const DEFAULT_CONFIG = {
  meta: {
    schema_version: SCHEMA_VERSION,
    config_url: '',
  },
  theme: {
    name: 'lazyhub-dark',
    overrides: {},
  },
  defaults: {
    pr_scope: 'mine',
    ai_provider: 'claude-code',
  },
  app: {
    active_panes: ['focus', 'prs', 'issues', 'branches', 'actions', 'notifications'],
    default_pane: 'focus',
    mouse: false,
    ai_review_enabled: true,
  },
  panes: {
    prs:           { label: 'Pull Requests', icon: '⎇', description: 'Review and manage pull requests' },
    issues:        { label: 'Issues', icon: '◎', description: 'Triage repository issues' },
    branches:      { label: 'Branches', icon: '⑂', description: 'Inspect and checkout branches' },
    actions:       { label: 'Actions', icon: '⚡', description: 'Inspect workflow runs' },
    notifications: { label: 'Notifications', icon: '◈', description: 'Review GitHub notifications' },
  },
  features: {
    prs:     { default_filter: 'open', default_scope: 'mine', page_size: 100 },
    issues:  { default_filter: 'open', page_size: 50 },
    actions: { page_size: 30 },
  },
  layout: {
    sidebar_width: 24,
    sidebar: true,
    preview_panel: true,
    preview_width: 40,
    border_style: 'round',
    compact_footer: false,
  },
  diff: {
    default_view: 'unified',
    syntax_highlight: true,
    max_lines: 2000,
  },
  editor: {
    command: 'auto',
    custom_command: '',
  },
  ipc: {
    enabled: true,
  },
  ui: {
    density: 'compact',
    show_hints: true,
    no_color: false,
    high_contrast: false,
  },
  keymaps: {
    global: {
      ':': 'command-palette.open',
      '<space><space>': 'command-palette.open',
      ',': 'app.settings',
      'q': 'app.back',
      '?': 'app.help',
      'Ctrl+D': 'debug.dump-state',
    },
    'pr-list': {
      'j': 'cursor.down',
      'k': 'cursor.up',
      'enter': 'pr.open-selected',
      'a': 'pr.approve',
      'm': 'pr.merge',
      'r': 'list.refresh',
    },
  },
  tabs: [{
    id: 'focus',
    label: 'Focus',
    order: 0,
    key: '<space>0',
    panes: [
      { kind: 'prs', filter: { reviewer: '@me', state: 'open' }, title: 'Review requested', limit: 25 },
      { kind: 'prs', filter: { author: '@me', state: 'open' }, title: 'My open PRs', limit: 25 },
      { kind: 'issues', filter: { assignee: '@me', state: 'open' }, title: 'Assigned issues', limit: 25 },
    ],
  }],
  actions: {
    'app.ai-assistant':      { keys: ['Ctrl+A'], hint: 'Ctrl+A', label: 'AI assistant', description: 'Open the AI assistant overlay', scope: 'global', group: 'global' },
    'app.next-pane':         { keys: ['Tab'], hint: 'Tab', label: 'pane', description: 'Cycle panes forward', scope: 'global', group: 'nav' },
    'app.prev-pane':         { keys: ['Shift+Tab'], hint: 'Shift+Tab', label: 'previous pane', description: 'Cycle panes backward', scope: 'global', group: 'nav' },
    'app.help':              { keys: ['?'], hint: '?', label: 'help', description: 'Toggle contextual help', scope: 'global', group: 'meta' },
    'app.settings':          { keys: ['S'], hint: 'S', label: 'settings', description: 'Open settings', scope: 'global', group: 'meta' },
    'app.open-config':       { keys: ['E'], hint: 'E', label: 'edit config', description: 'Open lazyhub.toml in the editor', scope: 'global', group: 'meta' },
    'app.back':              { keys: ['q', 'Esc'], hint: 'q / Esc', label: 'back', description: 'Back one level, or quit at root', scope: 'global', group: 'global' },
    'command-palette.open':  { keys: [':', '<space><space>'], hint: ':', label: 'command palette', description: 'Open the command palette', scope: 'global', group: 'global' },
    'app.visual-toggle':     { keys: ['V'], hint: 'V', label: 'visual', description: 'Toggle visual selection mode', scope: 'global', group: 'global' },
    'app.logs':              { keys: ['L'], hint: 'L', label: 'logs', description: 'Open debug logs when LAZYHUB_DEBUG=1', scope: 'global', group: 'debug' },
    'debug.dump-state':      { keys: ['Ctrl+D'], hint: 'Ctrl+D', label: 'debug state', description: 'Write a local debug-state dump', scope: 'global', group: 'debug' },
    'app.leader':            { keys: ['Space'], hint: '<Space>', label: 'leader', description: 'Start a leader-key chord', scope: 'global', group: 'global' },
    'app.leader-theme':      { keys: ['t'], hint: 't', label: 'theme', description: 'Open theme controls from leader mode', scope: 'global', group: 'leader' },
    'app.leader-ai':         { keys: ['a'], hint: 'a', label: 'AI', description: 'Open AI assistant from leader mode', scope: 'global', group: 'leader' },
    'app.leader-help':       { keys: ['?'], hint: '?', label: 'help', description: 'Open help from leader mode', scope: 'global', group: 'leader' },
    'app.leader-recent':     { keys: ['r'], hint: 'r', label: 'recent', description: 'Open recently viewed items from leader mode', scope: 'global', group: 'leader' },
    'cursor.down':           { keys: ['j', 'Down'], hint: 'j/k', label: 'nav', description: 'Move the cursor down', scope: 'list', group: 'nav' },
    'cursor.up':             { keys: ['k', 'Up'], hint: 'j/k', label: 'nav', description: 'Move the cursor up', scope: 'list', group: 'nav' },
    'cursor.top':            { keys: ['gg'], hint: 'gg / G', label: 'top/bottom', description: 'Jump to the top', scope: 'list', group: 'nav' },
    'cursor.bottom':         { keys: ['G'], hint: 'gg / G', label: 'top/bottom', description: 'Jump to the bottom', scope: 'list', group: 'nav' },
    'list.refresh':          { keys: ['r'], hint: 'r', label: 'refresh', description: 'Refresh the active list', scope: 'list', group: 'meta' },
    'list.search':           { keys: ['/'], hint: '/', label: 'search', description: 'Search the active list', scope: 'list', group: 'meta' },
    'log.filter':            { keys: ['f'], hint: 'f', label: 'filter', description: 'Filter log output', scope: 'dialog', group: 'filter' },
    'dialog.cancel':         { keys: ['Esc'], hint: 'Esc', label: 'cancel', description: 'Cancel or close the active dialog', scope: 'dialog', group: 'dialog' },
    'dialog.confirm':        { keys: ['Enter'], hint: 'Enter', label: 'confirm', description: 'Confirm the current dialog action', scope: 'dialog', group: 'dialog' },
    'dialog.down':           { keys: ['j', 'Down'], hint: 'j/k', label: 'navigate', description: 'Move down in a dialog list', scope: 'dialog', group: 'nav' },
    'dialog.up':             { keys: ['k', 'Up'], hint: 'j/k', label: 'navigate', description: 'Move up in a dialog list', scope: 'dialog', group: 'nav' },
    'dialog.top':            { keys: ['g', 'Ctrl+G'], hint: 'g', label: 'top', description: 'Jump to the top of a dialog list', scope: 'dialog', group: 'nav' },
    'dialog.bottom':         { keys: ['G', 'Ctrl+G'], hint: 'G', label: 'bottom', description: 'Jump to the bottom of a dialog list', scope: 'dialog', group: 'nav' },
    'dialog.toggle':         { keys: ['Space'], hint: 'Space', label: 'toggle', description: 'Toggle current selection', scope: 'dialog', group: 'dialog' },
    'dialog.submit':         { keys: ['Ctrl+G'], hint: 'Ctrl+G', label: 'submit', description: 'Submit composed form content', scope: 'dialog', group: 'dialog' },
    'dialog.editor':         { keys: ['Ctrl+E'], hint: 'Ctrl+E', label: 'editor', description: 'Open the current field in $EDITOR', scope: 'dialog', group: 'dialog' },
    'dialog.type':           { keys: ['type'], hint: 'type', label: 'filter', description: 'Type to filter in real time', scope: 'dialog', group: 'dialog' },
    'dialog.next-field':     { keys: ['Tab'], hint: 'Tab', label: 'next field', description: 'Move to the next form field', scope: 'dialog', group: 'dialog' },
    'dialog.yes':            { keys: ['y', 'Enter'], hint: 'y / Enter', label: 'confirm', description: 'Confirm a prompt', scope: 'dialog', group: 'dialog' },
    'dialog.no':             { keys: ['n', 'Esc'], hint: 'n / Esc', label: 'cancel', description: 'Cancel a prompt', scope: 'dialog', group: 'dialog' },
    'dialog.filter-up':      { keys: ['Up', 'Ctrl+K'], hint: '↑ / Ctrl+K', label: 'navigate', description: 'Move up while typing in a filter dialog', scope: 'dialog', group: 'nav' },
    'dialog.filter-down':    { keys: ['Down', 'Ctrl+J'], hint: '↓ / Ctrl+J', label: 'navigate', description: 'Move down while typing in a filter dialog', scope: 'dialog', group: 'nav' },
    'dialog.filter-top':     { keys: ['Ctrl+G'], hint: 'Ctrl+G', label: 'top', description: 'Jump to top while typing in a filter dialog', scope: 'dialog', group: 'nav' },
    'dialog.filter-bottom':  { keys: ['Ctrl+Shift+G'], hint: 'Ctrl+Shift+G', label: 'bottom', description: 'Jump to bottom while typing in a filter dialog', scope: 'dialog', group: 'nav' },
    'pr.open-selected':      { keys: ['Enter'], hint: 'Enter', label: 'open', description: 'Open PR detail', scope: 'pr-list', group: 'action' },
    'pr.diff':               { keys: ['d'], hint: 'd', label: 'diff', description: 'Open PR diff', scope: 'pr-list', group: 'action' },
    'pr.merge':              { keys: ['m'], hint: 'm', label: 'merge', description: 'Merge selected PR', scope: 'pr-list', group: 'action' },
    'pr.auto-merge':         { keys: ['M'], hint: 'M', label: 'auto-merge', description: 'Toggle auto-merge for selected PR', scope: 'pr-list', group: 'action' },
    'pr.approve':            { keys: ['a'], hint: 'a', label: 'approve', description: 'Approve selected PR', scope: 'pr-list', group: 'action' },
    'pr.request-changes':    { keys: ['x'], hint: 'x', label: 'request changes', description: 'Request changes on selected PR', scope: 'pr-list', group: 'action' },
    'pr.close':              { keys: ['X'], hint: 'X', label: 'close', description: 'Close selected PR', scope: 'pr-list', group: 'action' },
    'pr.labels':             { keys: ['l'], hint: 'l', label: 'labels', description: 'Edit PR labels', scope: 'pr-list', group: 'action' },
    'pr.assignees':          { keys: ['A'], hint: 'A', label: 'assignees', description: 'Edit PR assignees', scope: 'pr-list', group: 'action' },
    'pr.reviewers':          { keys: ['R'], hint: 'R', label: 'reviewers', description: 'Request PR reviewers', scope: 'pr-list', group: 'action' },
    'pr.checkout':           { keys: ['c'], hint: 'c', label: 'checkout', description: 'Checkout PR branch locally', scope: 'pr-list', group: 'action' },
    'pr.copy-url':           { keys: ['y'], hint: 'y', label: 'copy URL', description: 'Copy PR URL to clipboard', scope: 'pr-list', group: 'action' },
    'pr.open-browser':       { keys: ['o'], hint: 'o', label: 'browser', description: 'Open PR in browser', scope: 'pr-list', group: 'action' },
    'pr.filter-cycle':       { keys: ['f'], hint: 'f', label: 'filter', description: 'Cycle PR filter state', scope: 'pr-list', group: 'filter' },
    'pr.filter-open':        { keys: ['O'], hint: 'O', label: 'open', description: 'Toggle open PRs', scope: 'pr-list', group: 'filter' },
    'pr.filter-closed':      { keys: ['C'], hint: 'C', label: 'closed', description: 'Toggle closed PRs', scope: 'pr-list', group: 'filter' },
    'pr.filter-merged':      { keys: ['M'], hint: 'M', label: 'merged', description: 'Toggle merged PRs when auto-merge is unavailable', scope: 'pr-list', group: 'filter' },
    'pr.scope-cycle':        { keys: ['s'], hint: 's', label: 'scope', description: 'Cycle PR list scope', scope: 'pr-list', group: 'filter' },
    'pr.author-filter':      { keys: ['@'], hint: '@', label: 'author', description: 'Filter PRs by author', scope: 'pr-list', group: 'filter' },
    'pr.new':                { keys: ['N'], hint: 'N', label: 'new PR', description: 'Create a new PR', scope: 'pr-list', group: 'action' },
    'issue.open-selected':   { keys: ['Enter'], hint: 'Enter', label: 'open', description: 'Open issue detail', scope: 'issue-list', group: 'action' },
    'issue.new':             { keys: ['n'], hint: 'n', label: 'new', description: 'Create an issue', scope: 'issue-list', group: 'action' },
    'issue.close':           { keys: ['x'], hint: 'x', label: 'close', description: 'Close selected issue', scope: 'issue-list', group: 'action' },
    'issue.labels':          { keys: ['l'], hint: 'l', label: 'labels', description: 'Edit issue labels', scope: 'issue-list', group: 'action' },
    'issue.assignees':       { keys: ['A'], hint: 'A', label: 'assignees', description: 'Edit issue assignees', scope: 'issue-list', group: 'action' },
    'issue.copy-url':        { keys: ['y'], hint: 'y', label: 'copy URL', description: 'Copy issue URL', scope: 'issue-list', group: 'action' },
    'issue.open-browser':    { keys: ['o'], hint: 'o', label: 'browser', description: 'Open issue in browser', scope: 'issue-list', group: 'action' },
    'issue.filter-cycle':    { keys: ['f'], hint: 'f', label: 'filter', description: 'Cycle issue filter state', scope: 'issue-list', group: 'filter' },
    'issue.filter-open':     { keys: ['O'], hint: 'O', label: 'open', description: 'Toggle open issues', scope: 'issue-list', group: 'filter' },
    'issue.filter-closed':   { keys: ['C'], hint: 'C', label: 'closed', description: 'Toggle closed issues', scope: 'issue-list', group: 'filter' },
    'issue.sort-cycle':      { keys: ['s'], hint: 's', label: 'sort', description: 'Cycle issue sort order', scope: 'issue-list', group: 'filter' },
    'branch.checkout':       { keys: ['Space', 'Enter'], hint: 'Space / Enter', label: 'checkout', description: 'Checkout selected branch', scope: 'branch-list', group: 'action' },
    'branch.new':            { keys: ['n'], hint: 'n', label: 'new', description: 'Create a new branch', scope: 'branch-list', group: 'action' },
    'branch.delete':         { keys: ['D'], hint: 'D', label: 'delete', description: 'Delete selected branch', scope: 'branch-list', group: 'action' },
    'branch.push':           { keys: ['p'], hint: 'p', label: 'push', description: 'Push current branch', scope: 'branch-list', group: 'action' },
    'workflow.logs':         { keys: ['Enter', 'l'], hint: 'Enter / l', label: 'logs', description: 'Open workflow run logs', scope: 'workflow-list', group: 'action' },
    'workflow.rerun':        { keys: ['R'], hint: 'R', label: 're-run', description: 'Re-run selected workflow run', scope: 'workflow-list', group: 'action' },
    'workflow.cancel':       { keys: ['X'], hint: 'X', label: 'cancel', description: 'Cancel selected workflow run', scope: 'workflow-list', group: 'action' },
    'workflow.clear-filter': { keys: ['x'], hint: 'x', label: 'clear filter', description: 'Clear workflow branch filter', scope: 'workflow-list', group: 'filter' },
    'notification.open':     { keys: ['Enter'], hint: 'Enter', label: 'open', description: 'Open selected notification target', scope: 'notification-list', group: 'action' },
    'notification.mark-read': { keys: ['m'], hint: 'm', label: 'mark read', description: 'Mark selected notification as read', scope: 'notification-list', group: 'action' },
    'notification.mark-all': { keys: ['M'], hint: 'M', label: 'mark all', description: 'Mark all notifications as read', scope: 'notification-list', group: 'action' },
  },
  agent: {
    auto_spawn_daemon: true,
    mcp_auto_register: false,
    default_scope: 'read-only',
    require_confirm: false,
    audit_log_path: '~/.config/lazyhub/audit.log',
  },
  daemon: {
    idle_timeout_minutes: 30,
    socket_path: '~/.config/lazyhub/daemon.sock',
    pid_file: '~/.config/lazyhub/daemon.pid',
  },
  scopes: { ...BUILTIN_SCOPES },
  ai: {
    provider: 'anthropic',
    model: '',
    anthropic_api_key: '',
    openai_api_key: '',
    openai_base_url: 'https://api.openai.com/v1',
    openai_compatible: {
      base_url: 'http://localhost:11434/v1',
      api_key: '',
      model: 'qwen2.5-coder:32b',
      timeout_ms: 60000,
    },
    second_opinion: {
      enabled: true,
      map: {
        copilot: 'anthropic-api',
        claude: 'codex',
        codex: 'anthropic-api',
        gemini: 'anthropic-api',
      },
    },
    budget: {
      monthly_usd_cap: 0,
      per_call_usd_cap: 0,
      on_cap_exceeded: 'warn',
    },
  },
  state: {},
}

// ─── Type helpers ───────────────────────────────────────────────────────────────

/**
 * True for a plain (non-array, non-null) object.
 * @param {*} v value to test
 * @returns {boolean} whether v is a plain object
 */
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function checkType(val, type) {
  switch (type) {
    case 'array':   return Array.isArray(val)
    case 'object':  return isPlainObject(val)
    case 'integer': return typeof val === 'number' && Number.isInteger(val)
    case 'number':  return typeof val === 'number' && Number.isFinite(val)
    default:        return typeof val === type
  }
}

/**
 * Validate a flat table of typed scalar fields against a field-spec map.
 * Unknown keys and type/enum/validate violations are dropped with a warning.
 * @param {*} val       raw value (expected to be a table)
 * @param {Object} spec map of key → { type, enum?, validate? }
 * @param {string[]} warnings sink for warning strings
 * @param {string} path dotted section path for messages
 * @returns {Object|undefined} cleaned object, or undefined if `val` isn't a table
 */
function validateFlat(val, spec, warnings, path) {
  if (!isPlainObject(val)) {
    warnings.push(`[${path}] must be a table — section ignored`)
    return undefined
  }
  const out = {}
  for (const [k, v] of Object.entries(val)) {
    const fs = spec[k]
    if (!fs) {
      warnings.push(`unknown key "${k}" in [${path}] — ignored`)
      continue
    }
    if (!checkType(v, fs.type)) {
      warnings.push(`[${path}].${k} expected ${fs.type} — ignored`)
      continue
    }
    if (fs.enum && !fs.enum.includes(v)) {
      warnings.push(`[${path}].${k} = ${JSON.stringify(v)} not one of ${fs.enum.join(' | ')} — ignored`)
      continue
    }
    if (fs.validate) {
      const err = fs.validate(v)
      if (err) {
        warnings.push(`[${path}].${k}: ${err} — ignored`)
        continue
      }
    }
    out[k] = v
  }
  return out
}

// ─── Per-section field specs ────────────────────────────────────────────────────

const META_SPEC = {
  schema_version: { type: 'string' },
  config_url: {
    type: 'string',
    validate: (v) => (v === '' || /^https:\/\//i.test(v) ? null : 'must be an HTTPS URL'),
  },
}

const DEFAULTS_SPEC = {
  pr_scope:    { type: 'string', enum: ['mine', 'reviewing', 'all'] },
  ai_provider: { type: 'string', enum: ['claude-code', 'codex', 'gemini-cli', 'anthropic-api', 'openai-compatible'] },
}

const APP_SPEC = {
  active_panes:      { type: 'array' },
  default_pane:      { type: 'string' },
  mouse:             { type: 'boolean' },
  ai_review_enabled: { type: 'boolean' },
}

const LAYOUT_SPEC = {
  sidebar_width:  { type: 'integer', validate: (v) => (v >= 16 && v <= 40 ? null : 'must be between 16 and 40') },
  sidebar:        { type: 'boolean' },
  preview_panel:  { type: 'boolean' },
  preview_width:  { type: 'integer', validate: (v) => (v >= 24 && v <= 80 ? null : 'must be between 24 and 80') },
  border_style:   { type: 'string', enum: ['round', 'single', 'double', 'bold', 'classic', 'none'] },
  compact_footer: { type: 'boolean' },
}

const PRS_FEATURE_SPEC = {
  default_filter: { type: 'string', enum: ['open', 'closed', 'merged'] },
  default_scope:  { type: 'string', enum: ['mine', 'own', 'reviewing', 'all'] },
  page_size:      { type: 'integer', validate: (v) => (v > 0 ? null : 'must be positive') },
}

const ISSUES_FEATURE_SPEC = {
  default_filter: { type: 'string', enum: ['open', 'closed'] },
  page_size:      { type: 'integer', validate: (v) => (v > 0 ? null : 'must be positive') },
}

const ACTIONS_FEATURE_SPEC = {
  page_size: { type: 'integer', validate: (v) => (v > 0 ? null : 'must be positive') },
}

const DIFF_SPEC = {
  default_view:     { type: 'string', enum: ['unified', 'split'] },
  syntax_highlight: { type: 'boolean' },
  max_lines:        { type: 'integer', validate: (v) => (v > 0 ? null : 'must be positive') },
}

const EDITOR_SPEC = {
  command:        { type: 'string' },
  custom_command: { type: 'string' },
}

const IPC_SPEC = {
  enabled: { type: 'boolean' },
}

const UI_SPEC = {
  density:       { type: 'string', enum: ['compact', 'comfortable'] },
  show_hints:    { type: 'boolean' },
  no_color:      { type: 'boolean' },
  high_contrast: { type: 'boolean' },
}

const AGENT_SPEC = {
  auto_spawn_daemon: { type: 'boolean' },
  mcp_auto_register: { type: 'boolean' },
  default_scope:     { type: 'string' },
  require_confirm:   { type: 'boolean' },
  audit_log_path:    { type: 'string' },
}

const DAEMON_SPEC = {
  idle_timeout_minutes: { type: 'integer', validate: (v) => (v > 0 ? null : 'must be a positive integer') },
  socket_path:          { type: 'string' },
  pid_file:             { type: 'string' },
}

const BUDGET_SPEC = {
  monthly_usd_cap:  { type: 'number', validate: (v) => (v >= 0 ? null : 'must be >= 0') },
  per_call_usd_cap: { type: 'number', validate: (v) => (v >= 0 ? null : 'must be >= 0') },
  on_cap_exceeded:  { type: 'string', enum: ['warn', 'block'] },
}

const AI_SPEC = {
  provider:          { type: 'string', enum: ['anthropic', 'openai', 'ollama', 'openai-compatible'] },
  model:             { type: 'string' },
  anthropic_api_key: { type: 'string' },
  openai_api_key:    { type: 'string' },
  openai_base_url:   { type: 'string' },
}

const OPENAI_COMPATIBLE_SPEC = {
  base_url:   { type: 'string', validate: (v) => (v.trim() ? null : 'must not be empty') },
  api_key:    { type: 'string' },
  model:      { type: 'string', validate: (v) => (v.trim() ? null : 'must not be empty') },
  timeout_ms: { type: 'integer', validate: (v) => (v > 0 ? null : 'must be positive') },
}

const SECOND_OPINION_SPEC = {
  enabled: { type: 'boolean' },
  map:     { type: 'object' },
}

// ─── Section validators with bespoke shapes ─────────────────────────────────────

function validateTheme(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[theme] must be a table — section ignored')
    return undefined
  }
  const out = {}
  if ('name' in val) {
    if (typeof val.name === 'string') out.name = val.name
    else warnings.push('[theme].name expected string — ignored')
  }
  if ('overrides' in val) {
    if (!isPlainObject(val.overrides)) {
      warnings.push('[theme.overrides] must be a table — ignored')
    } else {
      const ov = {}
      for (const [token, def] of Object.entries(val.overrides)) {
        // A token value is either a hex/color string or a { fg?, bg? } table.
        if (typeof def === 'string') {
          ov[token] = def
        } else if (isPlainObject(def)) {
          const pair = {}
          if (typeof def.fg === 'string') pair.fg = def.fg
          if (typeof def.bg === 'string') pair.bg = def.bg
          if ('fg' in def && typeof def.fg !== 'string') warnings.push(`[theme.overrides]."${token}".fg expected string — ignored`)
          if ('bg' in def && typeof def.bg !== 'string') warnings.push(`[theme.overrides]."${token}".bg expected string — ignored`)
          ov[token] = pair
        } else {
          warnings.push(`[theme.overrides]."${token}" expected string or { fg, bg } — ignored`)
        }
      }
      out.overrides = ov
    }
  }
  // unknown keys
  for (const k of Object.keys(val)) {
    if (k !== 'name' && k !== 'overrides') warnings.push(`unknown key "${k}" in [theme] — ignored`)
  }
  return out
}

function validateKeymaps(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[keymaps] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [ctx, bindings] of Object.entries(val)) {
    if (!isPlainObject(bindings)) {
      warnings.push(`[keymaps.${ctx}] must be a table — ignored`)
      continue
    }
    const cleaned = {}
    const seen = new Map()
    const remember = (key) => {
      const normalized = normalizeKeyForValidation(key)
      const prior = seen.get(normalized)
      if (prior && prior !== key) {
        warnings.push(`[keymaps.${ctx}] duplicate binding "${key}" conflicts with "${prior}" after normalization`)
      }
      seen.set(normalized, key)
      return normalized
    }
    for (const [key, action] of Object.entries(bindings)) {
      if (typeof action === 'string') {
        remember(key)
        cleaned[key] = action
      } else if (isPlainObject(action) && PLATFORMS.includes(key)) {
        // Platform sub-section, e.g. [keymaps.pr-list.darwin]. Keep its string bindings;
        // mergePlatformKeymaps() folds it onto the base at load time.
        const sub = {}
        const platformSeen = new Map()
        for (const [pk, pv] of Object.entries(action)) {
          if (typeof pv === 'string') {
            const normalized = normalizeKeyForValidation(pk)
            const prior = platformSeen.get(normalized)
            if (prior && prior !== pk) {
              warnings.push(`[keymaps.${ctx}.${key}] duplicate binding "${pk}" conflicts with "${prior}" after normalization`)
            }
            platformSeen.set(normalized, pk)
            sub[pk] = pv
          } else warnings.push(`[keymaps.${ctx}.${key}].${pk} expected string action — ignored`)
        }
        cleaned[key] = sub
      } else if (key === 'unbind' && isPlainObject(action)) {
        const sub = {}
        for (const [pk, pv] of Object.entries(action)) {
          if (typeof pv === 'boolean') sub[pk] = pv
          else warnings.push(`[keymaps.${ctx}.unbind].${pk} expected boolean — ignored`)
        }
        cleaned[key] = sub
      } else {
        warnings.push(`[keymaps.${ctx}].${key} expected string action — ignored`)
      }
    }
    out[ctx] = cleaned
  }
  return out
}

function normalizeKeyForValidation(key) {
  const raw = String(key || '').trim()
  const angle = raw.match(/^<(.+)>$/)
  const body = (angle ? angle[1] : raw).toLowerCase()
  if (body === 'return') return 'enter'
  if (body === 'escape') return 'esc'
  if (body.startsWith('c-')) return `ctrl+${body.slice(2)}`
  if (body.startsWith('s-')) return `shift+${body.slice(2)}`
  if (body.startsWith('m-')) return `meta+${body.slice(2)}`
  return body
}

function actionScopeMatchesKeymap(actionScope, keymapScope) {
  if (actionScope === keymapScope) return true
  if (actionScope === 'list' && keymapScope.endsWith('-list')) return true
  return false
}

function validateKeymapReferences(config, warnings) {
  const actions = config?.actions || {}
  const keymaps = config?.keymaps || {}
  for (const [scope, bindings] of Object.entries(keymaps)) {
    if (!isPlainObject(bindings)) continue
    const defaultsByKey = new Map()
    for (const [actionId, action] of Object.entries(actions)) {
      if (!actionScopeMatchesKeymap(action.scope, scope)) continue
      for (const key of action.keys || []) {
        defaultsByKey.set(normalizeKeyForValidation(key), actionId)
      }
    }
    for (const [key, actionId] of Object.entries(bindings)) {
      if (key === 'unbind' || typeof actionId !== 'string') continue
      if (!actions[actionId]) {
        warnings.push(`[keymaps.${scope}].${key} points to unknown action "${actionId}"`)
        continue
      }
      const defaultAction = defaultsByKey.get(normalizeKeyForValidation(key))
      if (defaultAction && defaultAction !== actionId) {
        warnings.push(`[keymaps.${scope}].${key} maps to "${actionId}" but also matches "${defaultAction}"`)
      }
    }
  }
}

function validateTabs(val, warnings) {
  if (!Array.isArray(val)) {
    warnings.push('[[tabs]] must be an array of tables — ignored')
    return undefined
  }
  const out = []
  val.forEach((tab, i) => {
    if (!isPlainObject(tab)) {
      warnings.push(`[[tabs]] entry #${i} must be a table — ignored`)
      return
    }
    const cleaned = {}
    for (const f of ['id', 'label', 'key']) {
      if (f in tab) {
        if (typeof tab[f] === 'string') cleaned[f] = tab[f]
        else warnings.push(`[[tabs]] entry #${i} .${f} expected string — ignored`)
      }
    }
    if ('panes' in tab) {
      if (Array.isArray(tab.panes)) cleaned.panes = tab.panes.filter(isPlainObject)
      else warnings.push(`[[tabs]] entry #${i} .panes expected array — ignored`)
    }
    if ('order' in tab) {
      if (Number.isInteger(tab.order)) cleaned.order = tab.order
      else warnings.push(`[[tabs]] entry #${i} .order expected integer — ignored`)
    }
    if (!cleaned.id) {
      warnings.push(`[[tabs]] entry #${i} missing required string "id" — ignored`)
      return
    }
    out.push(cleaned)
  })
  return out
}

function validatePanes(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[panes] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [id, pane] of Object.entries(val)) {
    if (!isPlainObject(pane)) {
      warnings.push(`[panes.${id}] must be a table — ignored`)
      continue
    }
    const cleaned = {}
    for (const [k, v] of Object.entries(pane)) {
      if (['label', 'icon', 'description', 'command'].includes(k)) {
        if (typeof v === 'string') cleaned[k] = v
        else warnings.push(`[panes.${id}].${k} expected string — ignored`)
      } else if (k === 'actions') {
        if (isPlainObject(v)) cleaned.actions = v
        else warnings.push(`[panes.${id}].actions expected table — ignored`)
      } else {
        warnings.push(`unknown key "${k}" in [panes.${id}] — ignored`)
      }
    }
    out[id] = cleaned
  }
  return out
}

function validateFeatures(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[features] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [key, section] of Object.entries(val)) {
    if (key === 'prs') out.prs = validateFlat(section, PRS_FEATURE_SPEC, warnings, 'features.prs')
    else if (key === 'issues') out.issues = validateFlat(section, ISSUES_FEATURE_SPEC, warnings, 'features.issues')
    else if (key === 'actions') out.actions = validateFlat(section, ACTIONS_FEATURE_SPEC, warnings, 'features.actions')
    else warnings.push(`unknown key "${key}" in [features] — ignored`)
  }
  return out
}

function validateActions(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[actions] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [id, action] of Object.entries(val)) {
    if (!isPlainObject(action)) {
      warnings.push(`[actions.${id}] must be a table — ignored`)
      continue
    }
    const cleaned = {}
    for (const [k, v] of Object.entries(action)) {
      if (k === 'keys') {
        if (Array.isArray(v) && v.every(key => typeof key === 'string')) cleaned.keys = v
        else warnings.push(`[actions.${id}].keys expected array of strings — ignored`)
      } else if (['hint', 'label', 'description', 'scope', 'group'].includes(k)) {
        if (typeof v === 'string') cleaned[k] = v
        else warnings.push(`[actions.${id}].${k} expected string — ignored`)
      } else {
        warnings.push(`unknown key "${k}" in [actions.${id}] — ignored`)
      }
    }
    out[id] = cleaned
  }
  return out
}

function validateScopes(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[scopes] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [name, def] of Object.entries(val)) {
    if (!isPlainObject(def)) {
      warnings.push(`[scopes.${name}] must be a table — ignored`)
      continue
    }
    const cleaned = {}
    for (const [k, v] of Object.entries(def)) {
      if (SCOPE_BOOL_KEYS.includes(k)) {
        if (typeof v === 'boolean') cleaned[k] = v
        else warnings.push(`[scopes.${name}].${k} expected boolean — ignored`)
      } else if (SCOPE_ARRAY_KEYS.includes(k)) {
        if (Array.isArray(v) && v.every((s) => typeof s === 'string')) cleaned[k] = v
        else warnings.push(`[scopes.${name}].${k} expected array of strings — ignored`)
      } else {
        warnings.push(`unknown key "${k}" in [scopes.${name}] — ignored`)
      }
    }
    out[name] = cleaned
  }
  return out
}

function validateAi(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[ai] must be a table — section ignored')
    return undefined
  }
  const out = {}
  for (const [k, v] of Object.entries(val)) {
    if (k === 'budget') {
      const budget = validateFlat(v, BUDGET_SPEC, warnings, 'ai.budget')
      if (budget !== undefined) out.budget = budget
    } else if (k === 'openai_compatible') {
      const cfg = validateFlat(v, OPENAI_COMPATIBLE_SPEC, warnings, 'ai.openai_compatible')
      if (cfg !== undefined) out.openai_compatible = cfg
    } else if (k === 'second_opinion') {
      const cfg = validateFlat(v, SECOND_OPINION_SPEC, warnings, 'ai.second_opinion')
      if (cfg?.map) {
        const cleaned = {}
        for (const [family, providerId] of Object.entries(cfg.map)) {
          if (typeof providerId === 'string' && ['claude-code', 'codex', 'gemini-cli', 'anthropic-api', 'openai-compatible'].includes(providerId)) {
            cleaned[family] = providerId
          } else {
            warnings.push(`[ai.second_opinion.map].${family} expected known provider id — ignored`)
          }
        }
        cfg.map = cleaned
      }
      if (cfg !== undefined) out.second_opinion = cfg
    } else if (AI_SPEC[k]) {
      const partial = validateFlat({ [k]: v }, { [k]: AI_SPEC[k] }, warnings, 'ai')
      if (partial !== undefined && k in partial) out[k] = partial[k]
    } else {
      warnings.push(`unknown key "${k}" in [ai] — ignored`)
    }
  }
  return out
}

function validateState(val, warnings) {
  if (!isPlainObject(val)) {
    warnings.push('[state] must be a table — section ignored')
    return undefined
  }
  return structuredClone(val)
}

// ─── Top-level validator ─────────────────────────────────────────────────────────

/**
 * Validate a parsed TOML config object. Never throws: invalid/unknown keys are
 * dropped and recorded in `warnings`. The returned `config` is a partial — only
 * the user-supplied valid keys — meant to be merged onto DEFAULT_CONFIG.
 * @param {*} raw parsed TOML object
 * @returns {{ config: Object, warnings: string[] }}
 */
export function validateConfig(raw) {
  const warnings = []
  if (!isPlainObject(raw)) {
    warnings.push('config root is not a table — using defaults')
    return { config: {}, warnings }
  }
  const out = {}
  const set = (key, value) => { if (value !== undefined) out[key] = value }

  for (const [key, val] of Object.entries(raw)) {
    switch (key) {
      case 'meta':     set('meta',     validateFlat(val, META_SPEC,     warnings, 'meta')); break
      case 'theme':    set('theme',    validateTheme(val, warnings)); break
      case 'defaults': set('defaults', validateFlat(val, DEFAULTS_SPEC, warnings, 'defaults')); break
      case 'app':      set('app',      validateFlat(val, APP_SPEC,      warnings, 'app')); break
      case 'panes':    set('panes',    validatePanes(val, warnings)); break
      case 'features': set('features', validateFeatures(val, warnings)); break
      case 'layout':   set('layout',   validateFlat(val, LAYOUT_SPEC,   warnings, 'layout')); break
      case 'diff':     set('diff',     validateFlat(val, DIFF_SPEC,     warnings, 'diff')); break
      case 'editor':   set('editor',   validateFlat(val, EDITOR_SPEC,   warnings, 'editor')); break
      case 'ipc':      set('ipc',      validateFlat(val, IPC_SPEC,      warnings, 'ipc')); break
      case 'ui':       set('ui',       validateFlat(val, UI_SPEC,       warnings, 'ui')); break
      case 'keymaps':  set('keymaps',  validateKeymaps(val, warnings)); break
      case 'tabs':     set('tabs',     validateTabs(val, warnings)); break
      case 'actions':  set('actions',  validateActions(val, warnings)); break
      case 'agent':    set('agent',    validateFlat(val, AGENT_SPEC,    warnings, 'agent')); break
      case 'daemon':   set('daemon',   validateFlat(val, DAEMON_SPEC,   warnings, 'daemon')); break
      case 'scopes':   set('scopes',   validateScopes(val, warnings)); break
      case 'ai':       set('ai',       validateAi(val, warnings)); break
      case 'state':    set('state',    validateState(val, warnings)); break
      default:         warnings.push(`unknown config section [${key}] — ignored`)
    }
  }
  if (out.agent?.default_scope !== undefined && out.agent.default_scope !== 'read-only') {
    warnings.push(`[agent].default_scope "${out.agent.default_scope}" does not grant agent write authority — agent mutations stay disabled (effective scope: read-only)`)
  }
  const selectedAiProvider = out.defaults?.ai_provider || out.ai?.provider
  if (selectedAiProvider === 'openai-compatible') {
    const openaiCompatible = out.ai?.openai_compatible
    if (!openaiCompatible?.base_url) {
      warnings.push('[ai.openai_compatible].base_url is required when provider is "openai-compatible"')
    }
    if (!openaiCompatible?.model) {
      warnings.push('[ai.openai_compatible].model is required when provider is "openai-compatible"')
    }
  }
  if (out.keymaps) {
    const mergedForActions = mergeConfig(DEFAULT_CONFIG, out)
    validateKeymapReferences({ actions: mergedForActions.actions, keymaps: out.keymaps }, warnings)
  }
  return { config: out, warnings }
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Deep-merge `override` onto `base`. Plain objects merge recursively; arrays and
 * scalars are replaced wholesale. Inputs are not mutated.
 * @param {*} base lower-precedence value
 * @param {*} override higher-precedence value
 * @returns {*} merged result
 */
export function mergeConfig(base, override) {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = (k in base && isPlainObject(base[k]) && isPlainObject(v))
      ? mergeConfig(base[k], v)
      : v
  }
  return out
}

/**
 * Fold platform sub-sections in keymaps onto their base context bindings.
 * e.g. `[keymaps.pr-list.darwin]` overrides `[keymaps.pr-list]` on macOS, and the
 * platform key is removed from the result. Other platforms' blocks are dropped.
 * @param {Object} keymaps merged keymaps table
 * @param {string} platform process.platform value (darwin|linux|win32|…)
 * @returns {Object} keymaps with platform blocks resolved away
 */
export function mergePlatformKeymaps(keymaps, platform) {
  if (!isPlainObject(keymaps)) return keymaps
  const out = {}
  for (const [ctx, bindings] of Object.entries(keymaps)) {
    if (!isPlainObject(bindings)) { out[ctx] = bindings; continue }
    const base = {}
    let platformOverride = {}
    for (const [key, val] of Object.entries(bindings)) {
      if (PLATFORMS.includes(key) && isPlainObject(val)) {
        if (key === platform) platformOverride = val
      } else {
        base[key] = val
      }
    }
    out[ctx] = { ...base, ...platformOverride }
  }
  return out
}

// ─── Path expansion ─────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` / `~/` to the user's home directory. Never uses a shell.
 * Non-tilde and non-string values pass through unchanged.
 * @param {*} p path-ish value
 * @returns {*} expanded path or original value
 */
export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Return a copy of `config` with known path fields (`~`) expanded to homedir().
 * Fields: agent.audit_log_path, daemon.socket_path, daemon.pid_file.
 * @param {Object} config merged config
 * @returns {Object} config copy with expanded paths
 */
export function expandConfigPaths(config) {
  if (!isPlainObject(config)) return config
  const out = { ...config }
  if (isPlainObject(out.agent)) {
    out.agent = { ...out.agent, audit_log_path: expandHome(out.agent.audit_log_path) }
  }
  if (isPlainObject(out.daemon)) {
    out.daemon = {
      ...out.daemon,
      socket_path: expandHome(out.daemon.socket_path),
      pid_file: expandHome(out.daemon.pid_file),
    }
  }
  return out
}
