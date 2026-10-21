/**
 * config/migrate.js — one-shot state.json → lazyhub.toml migration.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { ensurePrivateDir, writePrivateFile } from '../secure-fs.js'
import { homedir } from 'os'
import { parse } from 'smol-toml'
import { logger } from '../utils.js'
import { USER_CONFIG_PATH } from './loader.js'
import { writeConfig } from './writer.js'
import { isPlainObject } from './schema.js'

const LEGACY_STATE_PATH = join(homedir(), '.config', 'lazyhub', 'state.json')

function readTomlState(configPath) {
  if (!existsSync(configPath)) return undefined
  try {
    const raw = parse(readFileSync(configPath, 'utf8'))
    return isPlainObject(raw.state) ? raw.state : undefined
  } catch {
    return undefined
  }
}

/**
 * Migrate legacy state.json into [state] once.
 *
 * If [state] already exists, state.json is removed so the app does not keep two
 * state stores alive. If migration writes [state], the old JSON payload is kept
 * as state.json.bak and the original state.json is removed.
 *
 * @param {Object} [opts]
 * @param {string} [opts.statePath]
 * @param {string} [opts.configPath]
 * @param {string} [opts.backupPath]
 * @returns {{migrated:boolean, deleted:boolean, reason:string}}
 */
export function migrateStateJsonToToml(opts = {}) {
  const {
    statePath = LEGACY_STATE_PATH,
    configPath = USER_CONFIG_PATH,
    backupPath = `${statePath}.bak`,
  } = opts

  if (!existsSync(statePath)) return { migrated: false, deleted: false, reason: 'missing-state-json' }

  const existingState = readTomlState(configPath)
  if (existingState !== undefined) {
    try {
      unlinkSync(statePath)
      return { migrated: false, deleted: true, reason: 'toml-state-exists' }
    } catch (err) {
      logger.warn('config: could not delete legacy state.json', { error: err.message })
      return { migrated: false, deleted: false, reason: 'delete-failed' }
    }
  }

  let stateText
  let state
  try {
    stateText = readFileSync(statePath, 'utf8')
    state = JSON.parse(stateText)
  } catch (err) {
    logger.warn('config: could not read legacy state.json for migration', { error: err.message })
    return { migrated: false, deleted: false, reason: 'invalid-state-json' }
  }

  if (!isPlainObject(state)) return { migrated: false, deleted: false, reason: 'state-json-not-object' }

  writeConfig({ state }, { configPath })
  ensurePrivateDir(dirname(backupPath))
  writePrivateFile(backupPath, stateText.endsWith('\n') ? stateText : `${stateText}\n`)
  unlinkSync(statePath)
  logger.info('migrated state.json into lazyhub.toml; old file kept as state.json.bak')
  return { migrated: true, deleted: true, reason: 'migrated' }
}
