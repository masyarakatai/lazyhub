/**
 * config/writer.js — conservative TOML writes for settings-owned fields.
 *
 * smol-toml stringifies values, but it does not round-trip comments. To preserve
 * user-authored config, this module updates only the sections lazyhub owns:
 *   - [state] and [state.*] tables
 *   - [theme].name
 *   - [defaults].*
 *   - selected [app], [ai], [ai.openai_compatible], and [features.*] scalars
 *
 * Other sections, comments, ordering, keymaps, tabs, and unknown user keys are
 * left byte-for-byte intact. The [state] table is normalized to the end of the
 * file when saved because lazyhub owns that whole table tree.
 */

import { existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { ensurePrivateDir, writePrivateFile } from '../secure-fs.js'
import { parse, stringify } from 'smol-toml'
import { USER_CONFIG_PATH } from './loader.js'
import { isPlainObject } from './schema.js'

const SECTION_RE = /^\s*(\[\[?)([^\]]+)(\]\]?)\s*(?:#.*)?$/
const WRITABLE_DEFAULTS = new Set(['pr_scope', 'ai_provider'])
const WRITABLE_APP = new Set(['active_panes', 'default_pane', 'mouse', 'ai_review_enabled'])
const WRITABLE_AI = new Set(['provider', 'model', 'anthropic_api_key', 'openai_api_key', 'openai_base_url'])
const WRITABLE_OPENAI_COMPATIBLE = new Set(['base_url', 'api_key', 'model', 'timeout_ms'])
const WRITABLE_FEATURES = {
  'features.prs': new Set(['default_filter', 'default_scope', 'page_size']),
  'features.issues': new Set(['default_filter', 'page_size']),
  'features.actions': new Set(['page_size']),
}

function readToml(configPath) {
  return existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
}

function ensureTomlSafe(value) {
  if (value === null || value === undefined) return undefined
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return value
  if (Array.isArray(value)) return value.map(ensureTomlSafe).filter(v => v !== undefined)
  if (!isPlainObject(value)) return undefined
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    const safe = ensureTomlSafe(val)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

function splitLines(text) {
  if (!text) return []
  return text.match(/[^\n]*\n|[^\n]+/g) || []
}

function sectionName(line) {
  const match = line.match(SECTION_RE)
  return match ? match[2].trim() : null
}

function isSectionTree(name, root) {
  return name === root || name.startsWith(`${root}.`)
}

function removeSectionTree(text, root) {
  const lines = splitLines(text)
  const kept = []
  let dropping = false

  for (const line of lines) {
    const name = sectionName(line)
    if (name) {
      dropping = isSectionTree(name, root)
    }
    if (!dropping) kept.push(line)
  }

  return kept.join('')
}

function appendBlock(text, block) {
  const trimmedBlock = block.trimEnd()
  if (!trimmedBlock) return text
  const prefix = text.trim().length === 0 ? '' : (text.endsWith('\n') ? '\n' : '\n\n')
  return `${text}${prefix}${trimmedBlock}\n`
}

function serializeState(state) {
  const safe = ensureTomlSafe(state) || {}
  return stringify({ state: safe })
}

function scalarAssignment(key, value) {
  return stringify({ [key]: value }).trim()
}

function bracketDelta(line, state, startIndex = 0) {
  for (let i = startIndex; i < line.length; i += 1) {
    const ch = line[i]
    if (state.quote) {
      if (state.quote === '"' && ch === '\\') { i += 1; continue }
      if (ch === state.quote) state.quote = null
      continue
    }
    if (ch === '#') break
    if (ch === '"' || ch === "'") { state.quote = ch; continue }
    if (ch === '[') { state.seen = true; state.square += 1 }
    else if (ch === ']') state.square = Math.max(0, state.square - 1)
    else if (ch === '{') { state.seen = true; state.curly += 1 }
    else if (ch === '}') state.curly = Math.max(0, state.curly - 1)
  }
}

function assignmentEnd(lines, start, sectionEnd) {
  const eq = lines[start].indexOf('=')
  if (eq === -1) return start
  const state = { square: 0, curly: 0, quote: null, seen: false }
  for (let i = start; i < sectionEnd; i += 1) {
    bracketDelta(lines[i], state, i === start ? eq + 1 : 0)
    if (state.seen && state.square === 0 && state.curly === 0 && !state.quote) return i
    if (!state.seen) return start
  }
  return start
}

function upsertScalar(text, section, key, value) {
  const assignment = scalarAssignment(key, value)
  const lines = splitLines(text)
  let sectionStart = -1
  let sectionEnd = lines.length

  for (let i = 0; i < lines.length; i += 1) {
    const name = sectionName(lines[i])
    if (!name) continue
    if (sectionStart === -1) {
      if (name === section) sectionStart = i
    } else {
      sectionEnd = i
      break
    }
  }

  if (sectionStart === -1) {
    return appendBlock(text, `[${section}]\n${assignment}\n`)
  }

  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (keyRe.test(lines[i])) {
      const end = assignmentEnd(lines, i, sectionEnd)
      const newline = lines[end].endsWith('\n') ? '\n' : ''
      lines.splice(i, end - i + 1, `${assignment}${newline}`)
      return lines.join('')
    }
  }

  lines.splice(sectionEnd, 0, `${assignment}\n`)
  return lines.join('')
}

function upsertAllowedScalars(text, section, patch, allowed) {
  if (!isPlainObject(patch)) return text
  let next = text
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) continue
    if (['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value)) {
      next = upsertScalar(next, section, key, value)
    }
  }
  return next
}

function parseUserConfig(text, _configPath) {
  if (!text.trim()) return {}
  return parse(text)
}

/**
 * Read the raw persisted runtime state from lazyhub.toml.
 * @param {Object} [opts]
 * @param {string} [opts.configPath]
 * @returns {Object} state table, or {}
 */
export function readState(opts = {}) {
  const { configPath = USER_CONFIG_PATH } = opts
  try {
    const raw = parseUserConfig(readToml(configPath), configPath)
    return isPlainObject(raw.state) ? raw.state : {}
  } catch {
    return {}
  }
}

/**
 * Persist a partial patch into [state] in lazyhub.toml.
 * @param {Object} patch partial state values
 * @param {Object} [opts]
 * @param {string} [opts.configPath]
 * @returns {Object} full state after the write
 */
export function writeState(patch, opts = {}) {
  const { configPath = USER_CONFIG_PATH } = opts
  const current = readState({ configPath })
  const next = { ...current, ...(ensureTomlSafe(patch) || {}) }
  writeConfig({ state: next }, { configPath })
  return next
}

/**
 * Write settings-owned TOML fields while preserving unrelated user content.
 * @param {Object} patch settings-owned config/state patch
 * @param {Object} [opts]
 * @param {string} [opts.configPath]
 * @returns {Object} parsed user TOML after the write
 */
export function writeConfig(patch, opts = {}) {
  const { configPath = USER_CONFIG_PATH } = opts
  let text = readToml(configPath)

  if (isPlainObject(patch.state)) {
    text = removeSectionTree(text, 'state')
    text = appendBlock(text, serializeState(patch.state))
  }

  if (isPlainObject(patch.theme) && typeof patch.theme.name === 'string') {
    text = upsertScalar(text, 'theme', 'name', patch.theme.name)
  }

  if (isPlainObject(patch.defaults)) {
    text = upsertAllowedScalars(text, 'defaults', patch.defaults, WRITABLE_DEFAULTS)
  }

  if (isPlainObject(patch.app)) {
    text = upsertAllowedScalars(text, 'app', patch.app, WRITABLE_APP)
  }

  if (isPlainObject(patch.ai)) {
    text = upsertAllowedScalars(text, 'ai', patch.ai, WRITABLE_AI)
    if (isPlainObject(patch.ai.openai_compatible)) {
      text = upsertAllowedScalars(text, 'ai.openai_compatible', patch.ai.openai_compatible, WRITABLE_OPENAI_COMPATIBLE)
    }
  }

  if (isPlainObject(patch.features)) {
    for (const [name, sectionPatch] of Object.entries(patch.features)) {
      const section = `features.${name}`
      if (WRITABLE_FEATURES[section]) {
        text = upsertAllowedScalars(text, section, sectionPatch, WRITABLE_FEATURES[section])
      }
    }
  }

  ensurePrivateDir(dirname(configPath))
  writePrivateFile(configPath, text)
  return parseUserConfig(text, configPath)
}
