import { isCacheableOp } from './protocol.js'
import { cacheKey, readCache, writeCache, invalidateRepoCache } from '../cache.js'

/**
 * Read-through cache used by the daemon for gh results.
 *
 * @property {Map<string, {ts:number, payload:unknown}>} memory
 */
export class DaemonCache {
  /**
	 * @param {object} [options]
	 * @param {number} [options.defaultTtl]
   */
  constructor({ defaultTtl = 60_000 } = {}) {
    this.memory = new Map()
    this.defaultTtl = defaultTtl
  }

  /**
   * Cache identity always includes host, account, and repo so entries never
   * cross GitHub identities.
   *
   * @param {unknown[]} parts
   * @param {{host?:string, account?:string, repo?:string}} [identity]
   */
  key(parts, { host = null, account = null, repo = null } = {}) {
    return cacheKey(['daemon', host, account, repo, ...parts])
  }

  /**
   * @param {string} key
   * @param {number} ttl
   */
  get(key, ttl = this.defaultTtl) {
    const now = Date.now()
    const mem = this.memory.get(key)
    if (mem && now - mem.ts < ttl) return { payload: mem.payload, source: 'memory' }
    const disk = readCache(key)
    if (disk && now - disk.ts < ttl) {
      this.memory.set(key, { ts: disk.ts, payload: disk.payload })
      return { payload: disk.payload, source: 'disk' }
    }
    return null
  }

  /**
   * @param {string} key
   * @param {unknown} payload
   * @param {object} meta
   */
  set(key, payload, meta = {}) {
    if (!isCacheableOp(meta.op)) throw new Error('refusing to cache a non-allowlisted operation')
    this.memory.set(key, { ts: Date.now(), payload })
    writeCache(key, payload, meta)
  }

  /**
   * @param {string} repo
   */
  invalidate(repo) {
    for (const key of this.memory.keys()) this.memory.delete(key)
    invalidateRepoCache(repo)
  }
}
