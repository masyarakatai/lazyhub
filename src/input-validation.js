/**
 * src/input-validation.js — shared runtime validators for untrusted
 * agent/model-supplied input (MCP adapter, AI assistant). Dependency-free so
 * the daemon can import it without pulling in UI code.
 */

const REPO_RE = /^([A-Za-z0-9.-]{1,253}\/)?[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** @param {unknown} v */
export const isRepoSlug = v => typeof v === 'string' && REPO_RE.test(v)

/** @param {unknown} v */
export const isPositiveId = v => Number.isSafeInteger(v) && /** @type {number} */ (v) > 0
