/**
 * perf.js — opt-in local NDJSON performance instrumentation.
 */

import { existsSync, statSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { appendPrivateFile, ensurePrivateDir, writePrivateFile } from './secure-fs.js'

const PERF_PATH = process.env.LAZYHUB_PERF_PATH || join(homedir(), '.cache', 'lazyhub', 'perf.ndjson')
const MAX_BYTES = 10 * 1024 * 1024
const ENABLED = process.env.LAZYHUB_PERF === '1'

/**
 * Return whether local perf instrumentation is enabled.
 */
export function isPerfEnabled() {
  return ENABLED
}

/**
 * Start a high-resolution timer when perf is enabled.
 */
export function startTimer() {
  return ENABLED ? process.hrtime.bigint() : 0n
}

/**
 * Record a duration from a high-resolution start time.
 * @param {string} type
 * @param {string} name
 * @param {bigint} started
 */
export function recordMeasure(type, name, started) {
  if (!ENABLED || !started) return
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  appendPerf({ ts: new Date().toISOString(), type, name, ms })
}

/**
 * Record an already-computed duration.
 * @param {string} type
 * @param {string} name
 * @param {number} ms
 */
export function recordDuration(type, name, ms) {
  if (!ENABLED) return
  appendPerf({ ts: new Date().toISOString(), type, name, ms })
}

function appendPerf(entry) {
  ensurePrivateDir(dirname(PERF_PATH))
  try {
    if (existsSync(PERF_PATH) && statSync(PERF_PATH).size > MAX_BYTES) {
      writePrivateFile(PERF_PATH, '')
    }
  } catch {}
  appendPrivateFile(PERF_PATH, `${JSON.stringify(entry)}\n`)
}

/**
 * Calculate an inclusive nearest-rank percentile.
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

/**
 * Build aggregate report rows from perf NDJSON text.
 * @param {string} text
 */
export function buildPerfReport(text) {
  const groups = new Map()
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry?.type || !entry?.name || typeof entry.ms !== 'number') continue
    const key = `${entry.type}:${entry.name}`
    if (!groups.has(key)) groups.set(key, { op: key, values: [] })
    groups.get(key).values.push(entry.ms)
  }
  return [...groups.values()]
    .map(({ op, values }) => ({
      op,
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: Math.max(...values),
    }))
    .sort((a, b) => b.p95 - a.p95)
}

/**
 * Read and aggregate a perf report file.
 * @param {string} path
 */
export function readPerfReport(path = PERF_PATH) {
  if (!existsSync(path)) return []
  return buildPerfReport(readFileSync(path, 'utf8'))
}
