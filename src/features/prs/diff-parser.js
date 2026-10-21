/**
 * src/features/prs/diff-parser.js — pure diff-parsing logic, no React/Ink deps.
 *
 * Extracted from diff.jsx so it can be unit-tested without mocking the entire
 * Ink/chalk/hljs stack.
 */

import { decodeHtmlEntities } from '../../utils.js'

/**
 * Parse a unified diff text (as returned by `gh pr diff`) into a tree of
 * file objects with typed line records.
 *
 * Each line record is one of:
 *   { type: 'hunk',  text, oldLine: null, newLine: null }
 *   { type: 'add',   text, oldLine: null, newLine: number }
 *   { type: 'del',   text, oldLine: number, newLine: null }
 *   { type: 'ctx',   text, oldLine: number, newLine: number }
 *
 * `text` is the code content with the leading +/-/ stripped and HTML entities
 * decoded so that downstream renderers never see raw &amp;, &#39;, &#NNN; etc.
 *
 * @param {string} diffText — raw output of `gh pr diff`
 * @returns {Array<{header:string, filename:string, addCount:number, delCount:number, lines:Array}>}
 */
export function parseDiff(diffText) {
  if (!diffText) return []
  const files = []
  let currentFile = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const hm = raw.match(/ b\/(.+)$/)
      currentFile = { header: raw, filename: hm ? hm[1] : '', addCount: 0, delCount: 0, lines: [] }
      files.push(currentFile)
      oldLine = 0; newLine = 0
      inHunk = false
    } else if (currentFile && !inHunk && !raw.startsWith('@@')) {
      // Extended header (index, mode, rename, ---/+++, Binary files) is metadata, not content.
      if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') currentFile.filename = raw.slice(4).replace(/^b\//, '')
    } else if (raw.startsWith('@@') && currentFile) {
      inHunk = true
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) { oldLine = parseInt(m[1], 10); newLine = parseInt(m[2], 10) }
      currentFile.lines.push({ type: 'hunk', text: raw, oldLine: null, newLine: null })
    } else if (currentFile) {
      if (raw.startsWith('\\')) continue // "\ No newline at end of file"
      if (raw.startsWith('+')) {
        currentFile.lines.push({ type: 'add', text: decodeHtmlEntities(raw.slice(1)), oldLine: null, newLine: newLine++ })
        currentFile.addCount++
      } else if (raw.startsWith('-')) {
        currentFile.lines.push({ type: 'del', text: decodeHtmlEntities(raw.slice(1)), oldLine: oldLine++, newLine: null })
        currentFile.delCount++
      } else {
        currentFile.lines.push({
          type: 'ctx',
          text: decodeHtmlEntities(raw.startsWith(' ') ? raw.slice(1) : raw),
          oldLine: oldLine++,
          newLine: newLine++,
        })
      }
    }
  }
  return files
}

/**
 * Flatten the parsed file array into a single array of renderable rows,
 * prepending a `file-header` row for each file.
 *
 * @param {Array} files — return value of parseDiff()
 * @returns {Array}
 */
export function flattenFiles(files) {
  const rows = []
  for (const file of files) {
    rows.push({ type: 'file-header', filename: file.filename, addCount: file.addCount, delCount: file.delCount })
    for (const line of file.lines) rows.push({ ...line, filename: file.filename })
  }
  return rows
}
