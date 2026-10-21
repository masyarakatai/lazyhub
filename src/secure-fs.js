/**
 * secure-fs.js — private-by-default filesystem helpers (#253).
 *
 * Every lazyhub-owned directory that may hold repository metadata, request
 * arguments, config or IPC endpoints is created 0700 and every file 0600,
 * regardless of the process umask. Existing paths are tightened in place
 * (migration from releases that wrote with default modes). On win32 POSIX
 * modes do not apply, so these helpers degrade to plain fs calls.
 *
 * This is defense in depth against other local accounts; a hostile process
 * running as the same OS user is out of scope (docs/THREAT_MODEL.md).
 */

import {
  chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  openSync, renameSync, unlinkSync, writeSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'

const POSIX = process.platform !== 'win32'
const NOFOLLOW = constants.O_NOFOLLOW || 0

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * Create `dir` (and missing parents) and force the leaf to 0700, even when it
 * already exists with a looser mode or the umask is permissive.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (POSIX) chmodSync(dir, 0o700)
}

/**
 * Verify `dir` is a real directory (not a symlink) owned by the current user
 * and not group/world accessible. A directory we own with loose permissions is
 * tightened to 0700 and re-checked; anything else throws.
 * @param {string} dir
 */
export function assertPrivateDir(dir) {
  if (!POSIX) return
  let st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`refusing symlinked directory: ${dir}`)
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`)
  const uid = currentUid()
  if (uid !== null && st.uid !== uid) throw new Error(`directory not owned by current user: ${dir}`)
  if (st.mode & 0o077) {
    chmodSync(dir, 0o700)
    st = lstatSync(dir)
    if (st.mode & 0o077) throw new Error(`directory is group/world accessible: ${dir}`)
  }
}

/**
 * Prepare a Unix socket path before bind: the entry must be absent, or a stale
 * socket we own (unlinked). Symlinks, other file types and foreign-owned
 * entries are treated as squatting and throw.
 * @param {string} path
 */
export function prepareSocketPath(path) {
  if (!POSIX) return
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (st.isSymbolicLink()) throw new Error(`refusing symlink at socket path: ${path}`)
  if (!st.isSocket()) throw new Error(`socket path exists and is not a socket: ${path}`)
  const uid = currentUid()
  if (uid !== null && st.uid !== uid) throw new Error(`socket path owned by another user: ${path}`)
  unlinkSync(path)
}

/**
 * Atomically replace `path` with `data` at mode 0600. Writes a sibling temp
 * file (exclusive create) then renames, so a pre-planted symlink or file at
 * `path` is replaced rather than followed.
 * @param {string} path
 * @param {string} data
 */
export function writePrivateFile(path, data) {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    if (POSIX) fchmodSync(fd, 0o600)
    writeSync(fd, data)
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
  closeSync(fd)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
}

/**
 * Append to `path`, creating it 0600 and tightening an existing file. Refuses
 * to follow a symlink at `path`.
 * @param {string} path
 * @param {string} data
 */
export function appendPrivateFile(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600)
  try {
    if (POSIX) fchmodSync(fd, 0o600)
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

/**
 * Tighten an existing file to 0600 (no-op when absent or on win32).
 * @param {string} path
 */
export function tightenFile(path) {
  if (!POSIX) return
  try {
    chmodSync(path, 0o600)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
