/**
 * config/loader.js — file + network I/O for the TOML user-config layer (issue #130).
 *
 * Pipeline (synchronous local path):
 *   defaultConfig.toml (or DEFAULT_CONFIG fallback)
 *     → merge user ~/.config/lazyhub/lazyhub.toml (validated, invalid keys dropped)
 *     → fold platform keymap sub-sections for the current OS
 *     → expand ~ in path fields
 *
 * Remote config (`[meta].config_url`) is fetched asynchronously by the
 * ConfigProvider via `fetchRemoteConfig()` — HTTPS-only, cached locally, with the
 * cache as the fallback when the network/remote fails. See acceptance #6.
 *
 * Security invariants (issue Hard rules):
 *   - TOML is data only; smol-toml never executes code from the file.
 *   - `~` is expanded with Node homedir(), never via a shell.
 *   - config_url uses Node `fetch` with a timeout; never curl/wget. HTTP is refused.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { ensurePrivateDir, writePrivateFile } from '../secure-fs.js'
import { fileURLToPath } from 'url'
import { homedir, platform as osPlatform } from 'os'
import { parse, TomlError } from 'smol-toml'
import { logger } from '../utils.js'
import {
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  validateConfig,
  mergeConfig,
  mergePlatformKeymaps,
  expandConfigPaths,
  isPlainObject,
} from './schema.js'

// Resolved dynamically (not via `new URL(..., import.meta.url)`) so esbuild leaves
// it as a runtime read instead of trying to bundle the .toml as an asset.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_TOML_PATH = join(MODULE_DIR, 'defaultConfig.toml')

const CONFIG_DIR = join(homedir(), '.config', 'lazyhub')
export const USER_CONFIG_PATH = join(CONFIG_DIR, 'lazyhub.toml')
const CACHE_PATH = join(CONFIG_DIR, '.config-cache.toml')

const REMOTE_TIMEOUT_MS = 5000
// Cap remote config size. A config file is tiny; this stops a malicious or
// misconfigured config_url from filling the disk via the cache write (or RAM).
const MAX_REMOTE_BYTES = 256 * 1024

/**
 * Build a friendly one-line error string for a failed config load.
 * @param {Error} err the thrown error (often a smol-toml TomlError)
 * @param {string} source path or URL the config came from
 * @returns {string} human-readable message
 */
export function formatError(err, source) {
  if (err instanceof TomlError) {
    // smol-toml exposes line/column on parse errors.
    const where = typeof err.line === 'number' ? ` (line ${err.line}, column ${err.column})` : ''
    return `Invalid TOML in ${source}${where}: ${err.message}. Falling back to defaults.`
  }
  return `Failed to read config ${source}: ${err.message}. Falling back to defaults.`
}

/**
 * Parse the bundled defaults. Falls back to the in-code DEFAULT_CONFIG if the
 * shipped file is somehow missing/unreadable, so the app never starts config-less.
 * @returns {Object} the base (full) default config, raw (unexpanded paths)
 */
function loadDefaults() {
  try {
    return parse(readFileSync(DEFAULT_CONFIG_TOML_PATH, 'utf8'))
  } catch (err) {
    logger.warn('Could not read bundled defaultConfig.toml; using built-in defaults', { error: err.message })
    return structuredClone(DEFAULT_CONFIG)
  }
}

/**
 * Load and resolve the effective config (synchronous, local only).
 * Never throws: a missing user file yields defaults; invalid TOML logs a friendly
 * error and yields defaults; invalid keys are dropped with warnings.
 *
 * @param {Object} [opts]
 * @param {string} [opts.configPath] user config path (defaults to USER_CONFIG_PATH)
 * @param {string} [opts.platform]   OS platform for keymap folding (defaults to os.platform())
 * @returns {Object} the merged, path-expanded config
 */
export function loadConfig(opts = {}) {
  const { configPath = USER_CONFIG_PATH, platform = osPlatform() } = opts
  const base = loadDefaults()

  let userRaw = {}
  if (existsSync(configPath)) {
    try {
      userRaw = parse(readFileSync(configPath, 'utf8'))
    } catch (err) {
      logger.error(formatError(err, configPath), err)
      userRaw = {}
    }
  }

  const { config: userValidated, warnings } = validateConfig(userRaw)
  for (const w of warnings) logger.warn(`config: ${w}`)

  let merged = mergeConfig(base, userValidated)

  // schema_version mismatch → warn but continue (migration hook lands in E5 doctor #133).
  if (isPlainObject(merged.meta) && merged.meta.schema_version && merged.meta.schema_version !== SCHEMA_VERSION) {
    logger.warn(`config: schema_version "${merged.meta.schema_version}" differs from supported "${SCHEMA_VERSION}" — continuing`)
  }

  if (isPlainObject(merged.keymaps)) merged.keymaps = mergePlatformKeymaps(merged.keymaps, platform)
  merged = expandConfigPaths(merged)
  return merged
}

/**
 * Read and parse the local remote-config cache, if present.
 * @param {string} cachePath path to the cache file
 * @returns {Object|null} parsed config or null when missing/unreadable
 */
function readCache(cachePath) {
  if (!existsSync(cachePath)) return null
  try {
    return parse(readFileSync(cachePath, 'utf8'))
  } catch (err) {
    logger.warn('config: cache file is unreadable — ignoring', { error: err.message })
    return null
  }
}

/**
 * Fetch a remote config over HTTPS. On success, writes the body to the local
 * cache and returns the parsed (still-raw) config. On any failure — non-HTTPS
 * URL, timeout, non-200, network error, bad TOML — falls back to the cached copy
 * (or null if none). Never throws.
 *
 * The returned object is unvalidated; callers should run it through
 * validateConfig() + mergeConfig() like a local file.
 *
 * @param {string} url HTTPS URL from [meta].config_url
 * @param {Object} [opts]
 * @param {string}   [opts.cachePath]  where to cache the fetched body (defaults to CACHE_PATH)
 * @param {number}   [opts.timeoutMs]  request timeout (defaults to 5000)
 * @param {Function} [opts.fetchImpl]  fetch implementation (injectable for tests)
 * @returns {Promise<Object|null>} parsed remote/cached config, or null
 */
export async function fetchRemoteConfig(url, opts = {}) {
  const { cachePath = CACHE_PATH, timeoutMs = REMOTE_TIMEOUT_MS, fetchImpl = fetch } = opts

  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    logger.warn(`config: config_url must be HTTPS — refusing "${url}", using cache if present`)
    return readCache(cachePath)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error' })
    if (!res.ok) {
      logger.warn(`config: config_url returned HTTP ${res.status} — using cache`)
      return readCache(cachePath)
    }
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) {
      logger.warn(`config: config_url declares ${declared} bytes (> ${MAX_REMOTE_BYTES}) — using cache`)
      return readCache(cachePath)
    }
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_REMOTE_BYTES) {
      logger.warn(`config: config_url body exceeds ${MAX_REMOTE_BYTES} bytes — using cache`)
      return readCache(cachePath)
    }
    const parsed = parse(text) // validates TOML syntax; throws → caught below
    try {
      ensurePrivateDir(dirname(cachePath))
      writePrivateFile(cachePath, text)
    } catch (err) {
      logger.warn('config: could not write remote config cache', { error: err.message })
    }
    return parsed
  } catch (err) {
    logger.warn(`config: failed to fetch config_url (${err.message}) — using cache`)
    return readCache(cachePath)
  } finally {
    clearTimeout(timer)
  }
}
