/**
 * CustomPane.jsx — generic pane renderer for user-defined tabs.
 *
 * A custom pane is declared in ~/.config/lazyhub/lazyhub.toml like:
 *
 *   [panes.my-deploys]
 *   label = "Deployments"
 *   icon = "▶"
 *   command = "gh api repos/{repo}/deployments --jq '[.[] | {title:.environment,number:.id,state:.task,updatedAt:.created_at,url:.url}]'"
 *
 *   [panes.my-deploys.actions]
 *   "o" = "open"
 *
 * The command runs in a shell. Placeholders: {repo}, {owner}, {name}.
 * stdout must be a JSON array. Recommended item fields:
 *   title      — main text (required for a useful display)
 *   number     — short id shown in gutter (optional)
 *   state      — status badge text (optional)
 *   updatedAt  — ISO date shown as time-ago (optional)
 *   url        — used by 'y' copy and 'o' open actions (optional)
 *
 * Built-in actions always available:
 *   j/k / ↑↓  navigate
 *   gg / G    jump top / bottom
 *   r         re-run command
 *   /         fuzzy search (title field)
 *   y         copy .url to clipboard (if present)
 *   o         open .url in browser (if present)
 *
 * User-defined actions (via [panes.<id>.actions]):
 *   Supports action value: "open" (same as o), "copy" (same as y)
 */

import React, { useState, useCallback, useEffect, useContext, useRef, memo } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { format } from 'timeago.js'
import { FuzzySearch } from './dialogs/FuzzySearch.jsx'
import { AppContext } from '../context.js'
import { useTheme } from '../theme.js'
import { sanitize, resolvePath, formatLogin, padEndWidth } from '../utils.js'

// Resolve {repo}, {owner}, {name} placeholders in a command string and return as array for execa
function resolveCommandArgs(cmd, repo) {
  const [owner = '', name = ''] = (repo || '').split('/')
  // This is a simple tokenizer that handles some basic shell-like behavior
  // but prioritize safety by passing args directly to execa.
  // It splits by whitespace but allows spaces if we had a more complex parser.
  // For now, we split by space and replace placeholders in each part.
  return cmd.split(/\s+/).map(part => {
    return part
      .replace(/\{repo\}/g, repo || '')
      .replace(/\{owner\}/g, owner)
      .replace(/\{name\}/g, name)
  })
}

const CustomPaneRow = memo(({ item, isSelected, t, stateColor }) => {
  const numStr  = item.number != null ? String(item.number).padEnd(5) : '     '
  const state   = sanitize(item.state || '')
  const title   = sanitize(item.title || item.name || item.description || JSON.stringify(item).slice(0, 60))
  const author  = sanitize(item.author || '')
  const timeStr = item.updatedAt ? format(item.updatedAt) : ''

  return (
    <Box paddingX={1} backgroundColor={isSelected ? t.ui.headerBg : undefined}>
      <Text color={t.ui.dim} bold>{numStr} </Text>
      {state ? <Text color={stateColor(state)}>{state.slice(0, 8).padEnd(9)}</Text> : null}
      <Box flexGrow={1}>
        <Text color={isSelected ? t.ui.selected : undefined} wrap="truncate">
          {title}
        </Text>
      </Box>
      {author && <Text color={t.ui.muted}> {padEndWidth(formatLogin(author, 12), 12)}</Text>}
      <Text color={t.ui.dim}> {timeStr}</Text>
    </Box>
  )
})

export function CustomPane({ paneDef, repo, listHeight = 10, onPaneState }) {
  const { t } = useTheme()
  const { notifyDialog } = useContext(AppContext)

  const stateColor = useCallback((state) => {
    if (!state) return t.ui.muted
    const s = String(state).toLowerCase()
    if (/open|active|success|ok|pass|running/.test(s)) return t.ci.pass
    if (/fail|error|closed|reject/.test(s))           return t.ci.fail
    if (/pending|wait|queue|in_progress/.test(s))     return t.ci.pending
    return t.ui.muted
  }, [t])

  const { stdout } = useStdout()
  const visibleHeight = listHeight || Math.max(5, (stdout?.rows || 24) - 8)

  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [cursor, setCursor]       = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [dialog, setDialog]       = useState(null)
  const [statusMsg, setStatusMsg] = useState(null)
  const lastKeyRef   = useRef(null)
  const lastKeyTimer = useRef(null)

  const showStatus = (msg, isError = false) => {
    setStatusMsg({ msg, isError })
    setTimeout(() => setStatusMsg(null), 3000)
  }

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const args = resolveCommandArgs(paneDef.command, repo)
      const { execa } = await import('execa')
      const [bin, ...rest] = args
      const result = await execa(bin, rest, { reject: false })
      if (result.exitCode !== 0) {
        throw new Error(result.stderr?.split('\n')[0] || 'Command failed')
      }
      
      let data = JSON.parse(result.stdout)
      
      if (paneDef.preProcessor) {
        try {
          const scriptPath = resolvePath(paneDef.preProcessor)
          const { default: processor } = await import(`file://${scriptPath}`)
          if (typeof processor === 'function') {
            data = await processor(data, { repo, paneDef })
          }
        } catch (procErr) {
          setError(`Pre-processor error: ${procErr.message}`)
        }
      }

      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || String(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [paneDef, repo])

  useEffect(() => { fetchItems() }, [fetchItems])

  useEffect(() => {
    if (onPaneState) onPaneState({ loading, error, count: items.length })
  }, [loading, error, items.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    notifyDialog(!!dialog)
    return () => notifyDialog(false)
  }, [dialog, notifyDialog])

  const moveCursor = useCallback((delta) => {
    setCursor(prev => {
      const next = Math.max(0, Math.min(items.length - 1, prev + delta))
      if (next < scrollOffset) setScrollOffset(next)
      if (next >= scrollOffset + visibleHeight) setScrollOffset(next - visibleHeight + 1)
      return next
    })
  }, [items.length, scrollOffset, visibleHeight])

  const selectedItem = items[cursor]

  const openInBrowser = useCallback((url) => {
    if (!url) return showStatus('No URL', true)
    import('execa').then(({ execa }) => {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
      execa(cmd, [url]).catch(() => {})
    })
  }, [])

  const copyUrl = useCallback((url) => {
    if (!url) return showStatus('No URL', true)
    import('execa').then(({ execa }) => {
      const [cmd, args] = process.platform === 'darwin'
        ? ['pbcopy', []]
        : ['xclip', ['-selection', 'clipboard']]
      const proc = execa(cmd, args)
      proc.stdin?.end(url)
      proc.then(() => showStatus(`✓ Copied`)).catch(() => showStatus('✗ Copy failed', true))
    })
  }, [])

  useInput((input, key) => {
    if (dialog) return

    // gg → top
    if (input === 'g') {
      if (lastKeyRef.current === 'g') {
        clearTimeout(lastKeyTimer.current)
        lastKeyRef.current = null
        setCursor(0); setScrollOffset(0)
        return
      }
      lastKeyRef.current = 'g'
      lastKeyTimer.current = setTimeout(() => { lastKeyRef.current = null }, 400)
      return
    }
    lastKeyRef.current = null

    if (input === 'G') {
      if (items.length > 0) {
        const last = items.length - 1
        setCursor(last); setScrollOffset(Math.max(0, last - visibleHeight + 1))
      }
      return
    }
    if (input === 'j' || key.downArrow) { moveCursor(1);  return }
    if (input === 'k' || key.upArrow)   { moveCursor(-1); return }
    if (input === 'r') { fetchItems(); return }
    if (input === '/') { setDialog('fuzzy'); return }

    if (!selectedItem) return

    // Built-in actions
    if (input === 'y') { copyUrl(selectedItem.url); return }
    if (input === 'o') { openInBrowser(selectedItem.url); return }

    // User-defined actions
    const userActions = paneDef.actions || {}
    if (userActions[input]) {
      const action = userActions[input]
      if (action === 'open')  { openInBrowser(selectedItem.url); return }
      if (action === 'copy')  { copyUrl(selectedItem.url); return }
    }
  })

  // ── Dialogs ───────────────────────────────────────────────────────────────

  if (dialog === 'fuzzy') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <FuzzySearch
          items={items}
          searchFields={['title', 'number', 'state', 'author']}
          onSubmit={(item) => {
            const idx = items.indexOf(item)
            if (idx !== -1) { setCursor(idx); setScrollOffset(Math.max(0, idx - 2)) }
            setDialog(null)
          }}
          onCancel={() => setDialog(null)}
        />
      </Box>
    )
  }

  // ── List ──────────────────────────────────────────────────────────────────

  const visibleItems = items.slice(scrollOffset, scrollOffset + visibleHeight)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header bar */}
      <Box paddingX={1} gap={1}>
        <Text color={t.ui.selected} bold>{paneDef.label}</Text>
        {items.length > 0 && <Text color={t.ui.dim}>({items.length})</Text>}
        <Text color={t.ui.dim}>[r] refresh  [/] search  [y] copy url  [o] browser</Text>
        {statusMsg && (
          <Text color={statusMsg.isError ? t.ci.fail : t.ci.pass}> {statusMsg.msg}</Text>
        )}
      </Box>

      {/* Loading */}
      {loading && (
        <Box paddingX={2} paddingY={1}>
          <Text color={t.ui.muted}>Loading {paneDef.label}…</Text>
        </Box>
      )}

      {/* Error */}
      {!loading && error && (
        <Box paddingX={2} paddingY={1} flexDirection="column">
          <Text color={t.ci.fail}>⚠ Command failed — [r] retry</Text>
          <Text color={t.ui.dim}>{error}</Text>
          <Text color={t.ui.dim} dimColor>$ {resolveCommandArgs(paneDef.command, repo).join(' ')}</Text>
        </Box>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <Box paddingX={2} paddingY={1}>
          <Text color={t.ui.muted}>No items returned. [r] re-run</Text>
        </Box>
      )}

      {/* List rows */}
      {!loading && !error && visibleItems.map((item, i) => {
        const idx = scrollOffset + i
        return (
          <CustomPaneRow
            key={idx}
            item={item}
            isSelected={idx === cursor}
            t={t}
            stateColor={stateColor}
          />
        )
      })}

      {/* Scroll indicator */}
      {items.length > visibleHeight && (
        <Box paddingX={1}>
          <Text color={t.ui.dim}>
            {scrollOffset + 1}–{Math.min(scrollOffset + visibleHeight, items.length)} / {items.length}
          </Text>
        </Box>
      )}
    </Box>
  )
}
