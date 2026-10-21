// @ts-nocheck
// TODO(#197): issue list view needs explicit item/dialog prop typedefs.
/**
 * src/features/issues/list.jsx — Issue list pane
 */

import React, { useState, useCallback, useEffect, useContext, useRef, memo } from 'react'
import { Box, Text, useStdout } from 'ink'
import { format } from 'timeago.js'
import { useKeymapInput } from '../../config/keymap.js'
import { useGh } from '../../hooks/useGh.js'
import { listIssues, listLabels, listCollaborators, closeIssue, createIssue, addLabels, removeLabels, addIssueAssignees, removeIssueAssignees } from '../../executor.js'
import { sanitize, formatLogin, padEndWidth } from '../../utils.js'
import { FuzzySearch } from '../../components/dialogs/FuzzySearch.jsx'
import { MultiSelect } from '../../components/dialogs/MultiSelect.jsx'
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.jsx'
import { FormCompose } from '../../components/dialogs/FormCompose.jsx'
import { AppContext } from '../../context.js'
import { useKeyScope } from '../../keyscope.js'
import { loadConfig } from '../../config.js'
import { firstActionKey, matchesAction } from '../../config/actions.js'
import { useTheme } from '../../theme.js'
import { IssueListSkeleton } from '../../components/Skeleton.jsx'

const _appConfig = loadConfig()
const _cfg = _appConfig.issues
const _actions = _appConfig.toml

// ─── Age colour ───────────────────────────────────────────────────────────────

function ageColor(updatedAt, t) {
  if (!updatedAt) return t.ui.dim
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000
  if (days < 3)  return t.ci.pass     // green  — fresh
  if (days < 7)  return undefined     // default — normal
  if (days < 14) return t.ci.pending  // yellow — getting stale
  return t.ci.fail                     // red    — stale
}

function IssueStateBadge({ issue, t }) {
  switch (issue.state) {
    case 'OPEN':   return <Text color={t.issue.open}>●</Text>
    case 'CLOSED': return <Text color={t.issue.closed}>●</Text>
    default:       return <Text color={t.ui.muted}>●</Text>
  }
}

const IssueRow = memo(({ issue, isSelected, t }) => {
  const authorLogin   = padEndWidth(formatLogin(issue.author?.login, 12), 12)
  const visibleLabels = (issue.labels || []).slice(0, 2)
  const extraLabels   = (issue.labels || []).length - 2
  const timeColor     = ageColor(issue.updatedAt, t)

  return (
    <Box paddingX={1} backgroundColor={isSelected ? t.ui.headerBg : undefined}>
      <IssueStateBadge issue={issue} t={t} />
      <Text> </Text>
      <Text color={t.ui.dim} bold>#{String(issue.number).padEnd(5)}</Text>
      <Text color={isSelected ? t.ui.selected : undefined} wrap="truncate" flexGrow={1}>
        {sanitize(issue.title)}
      </Text>
      {visibleLabels.map(l => (
        <Text key={l.name} color={`#${l.color}`}> [{l.name.slice(0, 14)}]</Text>
      ))}
      {extraLabels > 0 && (
        <Text color={t.ui.muted}> +{extraLabels}</Text>
      )}
      <Text color={t.ui.muted}> {authorLogin}</Text>
      <Text color={timeColor}> {format(issue.updatedAt)}</Text>
    </Box>
  )
})

export function IssueList({ repo, listHeight = 10, onSelectIssue, onPaneState, initialCursor = 0, initialScrollOffset = 0 }) {
  useKeyScope('pane')
  const { t } = useTheme()
  const { notifyDialog } = useContext(AppContext)
  const { stdout } = useStdout()
  const visibleHeight = listHeight || Math.max(5, (stdout?.rows || 24) - 8)

  const FK = _cfg.keys
  const [filterState, setFilterState] = useState(_cfg.defaultFilter)
  const [sortMode, setSortMode] = useState('default') // 'default' | 'oldest'
  const { data: issues, loading, error, refetch, isStale } = useGh(listIssues, [repo, { state: filterState, limit: _cfg.pageSize }])
  const [cursor, setCursor] = useState(initialCursor)
  const [scrollOffset, setScrollOffset] = useState(initialScrollOffset)
  const [dialog, setDialog] = useState(null)
  const [statusMsg, setStatusMsg] = useState(null)
  const lastKeyRef   = useRef(null)
  const lastKeyTimer = useRef(null)

  const rawItems = issues || []
  const items = sortMode === 'oldest'
    ? [...rawItems].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))
    : rawItems
  const STATE_CYCLE = ['open', 'closed']

  useEffect(() => {
    if (onPaneState) onPaneState({ loading, error, count: items.length, isStale })
  }, [loading, error, items.length, isStale]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    notifyDialog(!!dialog)
    if (onPaneState) onPaneState({ dialogHint: dialog || null })
    return () => { notifyDialog(false); if (onPaneState) onPaneState({ dialogHint: null }) }
  }, [dialog, notifyDialog]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { clearTimeout(lastKeyTimer.current) }, [])

  const showStatus = (msg, isError = false) => {
    setStatusMsg({ msg, isError, persist: isError })
    if (!isError) setTimeout(() => setStatusMsg(null), 3000)
  }

  const moveCursor = useCallback((delta) => {
    setCursor(prev => {
      const next = Math.max(0, Math.min(items.length - 1, prev + delta))
      if (next < scrollOffset) setScrollOffset(next)
      if (next >= scrollOffset + visibleHeight) setScrollOffset(next - visibleHeight + 1)
      return next
    })
  }, [items.length, scrollOffset, visibleHeight])

  useKeymapInput((input, key) => {
    if (statusMsg?.persist) { setStatusMsg(null) }
    if (dialog) return

    // gg → top
    const topSequenceKey = firstActionKey('cursor.top', 'gg', _actions)[0]
    if (input === topSequenceKey) {
      if (lastKeyRef.current === topSequenceKey) {
        clearTimeout(lastKeyTimer.current)
        lastKeyRef.current = null
        setCursor(0); setScrollOffset(0)
        return
      }
      lastKeyRef.current = topSequenceKey
      lastKeyTimer.current = setTimeout(() => { lastKeyRef.current = null }, 400)
      return
    }
    lastKeyRef.current = null

    // G → bottom
    if (matchesAction('cursor.bottom', input, key, _actions)) {
      if (items.length > 0) {
        const last = items.length - 1
        setCursor(last); setScrollOffset(Math.max(0, last - visibleHeight + 1))
      }
      return
    }

    if (matchesAction('cursor.down', input, key, _actions)) { moveCursor(1);  return }
    if (matchesAction('cursor.up', input, key, _actions))   { moveCursor(-1); return }
    if (matchesAction('list.refresh', input, key, _actions)) { refetch(); return }
    if (matchesAction('list.search', input, key, _actions)) { setDialog('fuzzy'); return }
    if (matchesAction('issue.new', input, key, _actions)) { setDialog('new'); return }

    // Direct filter keys from config (defaults: O=open, C=closed)
    if (FK.filterOpen   && input === FK.filterOpen   && filterState !== 'open')   { setFilterState('open');   showStatus('▸ open');   setCursor(0); setScrollOffset(0); return }
    if (FK.filterClosed && input === FK.filterClosed && filterState !== 'closed') { setFilterState('closed'); showStatus('▸ closed'); setCursor(0); setScrollOffset(0); return }
    // f still cycles as fallback
    if (matchesAction('issue.filter-cycle', input, key, _actions)) {
      setFilterState(prev => {
        const next = STATE_CYCLE[(STATE_CYCLE.indexOf(prev) + 1) % STATE_CYCLE.length]
        showStatus(`▸ ${next}`)
        return next
      })
      setCursor(0); setScrollOffset(0)
      return
    }

    // s — cycle age sort
    if (matchesAction('issue.sort-cycle', input, key, _actions)) {
      setSortMode(prev => {
        const next = prev === 'default' ? 'oldest' : 'default'
        showStatus(next === 'oldest' ? 'sort: oldest first' : 'sort: default')
        return next
      })
      setCursor(0); setScrollOffset(0)
      return
    }

    if (loading || items.length === 0) return
    const issue = items[cursor]

    if (matchesAction('issue.open-selected', input, key, _actions)) {
      if (issue) onSelectIssue(issue)
      return
    }

    // y — copy issue URL
    if (matchesAction('issue.copy-url', input, key, _actions) && issue?.url) {
      import('execa').then(({ execa }) => {
        const [cmd, args] = process.platform === 'darwin'
          ? ['pbcopy', []]
          : ['xclip', ['-selection', 'clipboard']]
        const proc = execa(cmd, args)
        proc.stdin?.end(issue.url)
        proc.then(() => showStatus(`✓ Copied ${issue.url}`)).catch(() => showStatus('✗ Copy failed', true))
      })
      return
    }

    if (matchesAction('issue.close', input, key, _actions)) {
      if (issue) setDialog('close')
      return
    }

    if (matchesAction('issue.labels', input, key, _actions)) {
      if (issue) setDialog('labels')
      return
    }

    if (matchesAction('issue.assignees', input, key, _actions)) {
      if (issue) setDialog('assignees')
      return
    }

    if (matchesAction('issue.open-browser', input, key, _actions) && issue?.url) {
      import('execa').then(({ execa }) => {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        execa(cmd, [issue.url]).catch(() => {})
      })
      return
    }
  })

  const selectedIssue = items[cursor]
  const visibleIssues = items.slice(scrollOffset, scrollOffset + visibleHeight)

  if (dialog === 'fuzzy') {
    const fuzzyItems = items.map(issue => ({ ...issue, authorLogin: issue.author?.login || '' }))
    return (
      <Box flexDirection="column" flexGrow={1}>
        <FuzzySearch
          items={fuzzyItems}
          searchFields={['title', 'number', 'authorLogin']}
          onSubmit={(item) => {
            const idx = items.findIndex(i => i.number === item.number)
            if (idx !== -1) { setCursor(idx); setScrollOffset(Math.max(0, idx - 2)) }
            setDialog(null)
          }}
          onCancel={() => setDialog(null)}
        />
      </Box>
    )
  }

  if (dialog === 'close' && selectedIssue) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <ConfirmDialog
          message={`Close issue #${selectedIssue.number}: ${sanitize(selectedIssue.title)}?`}
          destructive={true}
          onConfirm={async () => {
            setDialog(null)
            try {
              await closeIssue(repo, selectedIssue.number)
              showStatus(`Closed #${selectedIssue.number}`)
              refetch()
            } catch (err) {
              showStatus(`Failed: ${err.message}`, true)
            }
          }}
          onCancel={() => setDialog(null)}
        />
      </Box>
    )
  }

  if (dialog === 'new') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <FormCompose
          title="New Issue"
          fields={[
            { name: 'title', label: 'Title', type: 'text' },
            { name: 'body', label: 'Body', type: 'multiline' },
          ]}
          onSubmit={async (values) => {
            setDialog(null)
            try {
              await createIssue(repo, { title: values.title, body: values.body })
              showStatus('Issue created')
              refetch()
            } catch (err) {
              showStatus(`Failed: ${err.message}`, true)
            }
          }}
          onCancel={() => setDialog(null)}
        />
      </Box>
    )
  }

  if (dialog === 'labels' && selectedIssue) {
    return <IssueLabelDialog repo={repo} issue={selectedIssue} onClose={() => { setDialog(null); refetch() }} />
  }

  if (dialog === 'assignees' && selectedIssue) {
    return <IssueAssigneeDialog repo={repo} issue={selectedIssue} onClose={() => { setDialog(null); refetch() }} />
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingX={1} gap={1}>
        <Text color={t.ui.dim}>filter:</Text>
        <Text color={filterState === 'open' ? t.issue.open : t.issue.closed} bold>{filterState}</Text>
        {sortMode === 'oldest' && (
          <Text color={t.ci.pending} bold>↑ oldest</Text>
        )}
        <Text color={t.ui.dim}>  [{FK.filterOpen}] open  [{FK.filterClosed}] closed  [s] sort  [n] new</Text>
        {statusMsg && (
          <Text color={statusMsg.isError ? t.ci.fail : t.ci.pass}> {statusMsg.msg}{statusMsg.persist ? ' [any key]' : ''}</Text>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading && items.length === 0 && (
          <IssueListSkeleton count={visibleHeight} />
        )}
        {loading && items.length > 0 && (
          <Box paddingX={1}><Text color={t.ui.muted}>refreshing…</Text></Box>
        )}
        {visibleIssues.map((issue, i) => {
          const idx = scrollOffset + i
          const isSelected = idx === cursor

          return (
            <IssueRow
              key={issue.number}
              issue={issue}
              isSelected={isSelected}
              t={t}
            />
          )
        })}
        {!loading && items.length === 0 && (
          <Box paddingX={2} paddingY={1}>
            <Text color={t.ui.muted}>No {filterState} issues found. [f] cycle filter  [n] new issue  [r] refresh</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function IssueLabelDialog({ repo, issue, onClose }) {
  const { t } = useTheme()
  const { data: allLabels, loading } = useGh(listLabels, [repo])
  if (loading) return <Box><Text color={t.ui.muted}>Loading labels...</Text></Box>
  const items = (allLabels || []).map(l => ({
    id: l.name,
    name: l.name,
    color: l.color,
    selected: issue.labels?.some(il => il.name === l.name),
  }))
  return (
    <MultiSelect
      items={items}
      onSubmit={async (selectedIds) => {
        const currentLabels = issue.labels?.map(l => l.name) || []
        const toAdd = selectedIds.filter(id => !currentLabels.includes(id))
        const toRemove = currentLabels.filter(id => !selectedIds.includes(id))
        try {
          if (toAdd.length) await addLabels(repo, issue.number, toAdd, 'issue')
          if (toRemove.length) await removeLabels(repo, issue.number, toRemove, 'issue')
        } catch {}
        onClose()
      }}
      onCancel={onClose}
    />
  )
}

function IssueAssigneeDialog({ repo, issue, onClose }) {
  const { t } = useTheme()
  const { data: collabs, loading } = useGh(listCollaborators, [repo])
  if (loading) return <Box><Text color={t.ui.muted}>Loading collaborators...</Text></Box>
  const items = (collabs || []).map(c => ({
    id: c.login,
    name: c.login,
    selected: issue.assignees?.some(a => a.login === c.login),
  }))
  return (
    <MultiSelect
      items={items}
      onSubmit={async (selectedIds) => {
        const current = issue.assignees?.map(a => a.login) || []
        const toAdd    = selectedIds.filter(id => !current.includes(id))
        const toRemove = current.filter(id => !selectedIds.includes(id))
        try {
          if (toAdd.length)    await addIssueAssignees(repo, issue.number, toAdd)
          if (toRemove.length) await removeIssueAssignees(repo, issue.number, toRemove)
        } catch { /* ignore */ }
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
