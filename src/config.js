/**
 * config.js — compatibility shim over lazyhub.toml.
 *
 * The runtime source of truth is `~/.config/lazyhub/lazyhub.toml`, loaded by
 * `src/config/loader.js`. This module keeps the historical `loadConfig()`
 * shape alive for older call sites while projecting every value from TOML.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { ensurePrivateDir, tightenFile, writePrivateFile } from './secure-fs.js'
import { logger } from './utils.js'
import { fileURLToPath } from 'url'
import { loadConfig as loadTomlConfig, USER_CONFIG_PATH } from './config/loader.js'
import { DEFAULT_CONFIG } from './config/schema.js'
import { readState as readTomlState, writeConfig as writeTomlConfig, writeState as writeTomlState } from './config/writer.js'

export const BUILTIN_PANES = ['prs', 'issues', 'branches', 'actions', 'notifications']
export const CONFIG_PATH = USER_CONFIG_PATH
const DEFAULT_CONFIG_TOML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'config', 'defaultConfig.toml')

function firstActionKey(actions, id, fallback) {
  const key = actions?.[id]?.keys?.[0]
  return typeof key === 'string' ? key : fallback
}

function scopeFromToml(scope) {
  return scope === 'mine' ? 'own' : scope
}

function camelAi(ai = {}) {
  return {
    provider:        ai.provider || 'anthropic',
    model:           ai.model || '',
    anthropicApiKey: ai.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey:    ai.openai_api_key || process.env.OPENAI_API_KEY || '',
    openaiBaseUrl:   ai.openai_base_url || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openai_compatible: ai.openai_compatible || {},
  }
}

function customPanesFromToml(toml) {
  const custom = {}
  for (const [id, pane] of Object.entries(toml.panes || {})) {
    if (BUILTIN_PANES.includes(id) || !pane?.command) continue
    custom[id] = {
      id,
      label: pane.label || id,
      icon: pane.icon || '✦',
      command: pane.command,
      actions: pane.actions || {},
    }
  }
  return custom
}

function tabsFromToml(toml) {
  const tabs = {}
  for (const tab of toml.tabs || []) {
    if (!tab?.id) continue
    tabs[tab.id] = {
      id: tab.id,
      label: tab.label || tab.id,
      icon: '▣',
      panes: Array.isArray(tab.panes) ? tab.panes : [],
      key: tab.key || '',
      order: Number.isInteger(tab.order) ? tab.order : 999,
    }
  }
  return tabs
}

function legacyFromToml(toml) {
  const customPanes = customPanesFromToml(toml)
  const customTabs = tabsFromToml(toml)
  const knownPanes = [...Object.keys(customTabs), ...BUILTIN_PANES, ...Object.keys(customPanes)]
  const panes = (toml.app?.active_panes || DEFAULT_CONFIG.app.active_panes)
    .filter(p => knownPanes.includes(p))
  if (panes.length === 0) panes.push('prs')

  const prFeature = toml.features?.prs || DEFAULT_CONFIG.features.prs
  const issueFeature = toml.features?.issues || DEFAULT_CONFIG.features.issues
  const actionFeature = toml.features?.actions || DEFAULT_CONFIG.features.actions
  const layout = toml.layout || DEFAULT_CONFIG.layout
  const diff = toml.diff || DEFAULT_CONFIG.diff
  const editor = toml.editor || DEFAULT_CONFIG.editor

  return {
    panes,
    defaultPane: panes.includes(toml.app?.default_pane) ? toml.app.default_pane : panes[0],
    theme: { name: toml.theme?.name || DEFAULT_CONFIG.theme.name, overrides: toml.theme?.overrides || {} },
    mouse: toml.app?.mouse === true,
    aiReviewEnabled: toml.app?.ai_review_enabled !== false,
    customPanes,
    customTabs,
    layout: {
      sidebarWidth:  layout.sidebar_width,
      sidebar:       layout.sidebar,
      previewPanel:  layout.preview_panel,
      previewWidth:  layout.preview_width,
      borderStyle:   layout.border_style,
      compactFooter: layout.compact_footer,
    },
    pr: {
      defaultFilter: prFeature.default_filter,
      defaultScope:  scopeFromToml(prFeature.default_scope),
      pageSize:      prFeature.page_size,
      keys: {
        filterOpen:   firstActionKey(toml.actions, 'pr.filter-open', 'O'),
        filterClosed: firstActionKey(toml.actions, 'pr.filter-closed', 'C'),
        filterMerged: firstActionKey(toml.actions, 'pr.filter-merged', 'M'),
      },
    },
    issues: {
      defaultFilter: issueFeature.default_filter,
      pageSize:      issueFeature.page_size,
      keys: {
        filterOpen:   firstActionKey(toml.actions, 'issue.filter-open', 'O'),
        filterClosed: firstActionKey(toml.actions, 'issue.filter-closed', 'C'),
      },
    },
    actions: { pageSize: actionFeature.page_size },
    diff: {
      defaultView:     diff.default_view,
      syntaxHighlight: diff.syntax_highlight,
      maxLines:        diff.max_lines,
    },
    editor: {
      command:       editor.command,
      customCommand: editor.custom_command || null,
    },
    ipc: { enabled: toml.ipc?.enabled !== false },
    ai: camelAi(toml.ai),
    toml,
  }
}

/**
 * Load app config from lazyhub.toml and expose the legacy object shape.
 * @returns {Object} compatibility config object
 */
export function loadConfig() {
  return legacyFromToml(loadTomlConfig())
}

/**
 * Load persisted UI state from [state].
 * @returns {Object} state table
 */
export function loadState() {
  return readTomlState()
}

/**
 * Persist a partial UI state patch to [state].
 * @param {Object} patch state keys to merge
 */
export function saveState(patch) {
  writeTomlState(patch)
}

function patchToToml(patch) {
  const out = {}
  if ('theme' in patch) out.theme = typeof patch.theme === 'string' ? { name: patch.theme } : patch.theme
  if ('aiReviewEnabled' in patch) out.app = { ...(out.app || {}), ai_review_enabled: patch.aiReviewEnabled !== false }
  if ('mouse' in patch) out.app = { ...(out.app || {}), mouse: patch.mouse === true }
  if ('panes' in patch) out.app = { ...(out.app || {}), active_panes: patch.panes }
  if (patch.pr?.pageSize) out.features = { ...(out.features || {}), prs: { page_size: patch.pr.pageSize } }
  if (patch.ai) {
    out.ai = {
      provider:          patch.ai.provider,
      model:             patch.ai.model,
      anthropic_api_key: patch.ai.anthropicApiKey,
      openai_api_key:    patch.ai.openaiApiKey,
      openai_base_url:   patch.ai.openaiBaseUrl,
      openai_compatible: patch.ai.openai_compatible || patch.ai.openaiCompatible,
    }
  }
  return out
}

/**
 * Persist settings-owned config to lazyhub.toml.
 * @param {Object} patch legacy config-shaped patch
 */
export function saveConfig(patch) {
  writeTomlConfig(patchToToml(patch))
}

/**
 * Create lazyhub.toml from bundled defaults if it does not exist.
 */
export function writeDefaultConfig() {
  try {
    readFileSync(CONFIG_PATH, 'utf8')
    // Migrate files written by older releases with default (world-readable) modes.
    try { ensurePrivateDir(dirname(CONFIG_PATH)); tightenFile(CONFIG_PATH) } catch (err) {
      logger.warn('config: could not tighten config permissions', { error: err.message })
    }
  } catch {
    try {
      ensurePrivateDir(dirname(CONFIG_PATH))
      writePrivateFile(CONFIG_PATH, readFileSync(DEFAULT_CONFIG_TOML_PATH, 'utf8'))
    } catch { /* non-fatal: defaults are bundled and loaded in-memory */ }
  }
}
