/**
 * src/features/issues/detail.jsx — Issue detail pane
 */

import React, { useState, useContext, useMemo, useCallback, useRef } from 'react'
import { Box, Text, useStdout } from 'ink'
import { format } from 'timeago.js'
import { useKeymapInput } from '../../config/keymap.js'
import { useGh } from '../../hooks/useGh.js'
import { getIssue, addIssueComment, listLabels, listCollaborators, addLabels, removeLabels, addIssueAssignees, removeIssueAssignees } from '../../executor.js'
import { MultiSelect } from '../../components/dialogs/MultiSelect.jsx'
import { AppContext } from '../../context.js'
import { useKeyScope } from '../../keyscope.js'
import { useTheme } from '../../theme.js'
import { sanitize, getMarkdownRows, TextInput } from '../../utils.js'
import { IssueDetailSkeleton } from '../../components/Skeleton.jsx'

// Exported so app.jsx can use them if needed
const FOOTER_KEYS = [
  { key: 'r', label: 'reply' },
  { key: 'l', label: 'labels' },
  { key: 'A', label: 'assignees' },
  { key: 'Esc', label: 'back' },
]

export function IssueDetail({ issueNumber, repo, onBack }) {
  useKeyScope('pane')
  const { t } = useTheme()
  const { notifyDialog } = useContext(AppContext)
  const { stdout } = useStdout()
  const termRows = stdout?.rows || 24
  const termCols = stdout?.columns || 80

  const { data: issue, loading, error, refetch } = useGh(getIssue, [repo, issueNumber])
  const [scrollY, setScrollY] = useState(0)
  const [replyMode, setReplyMode] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [statusMsg, setStatusMsg] = useState(null)
  const [dialog, setDialog] = useState(null)
  const lastKeyRef   = useRef(null)
  const lastKeyTimer = useRef(null)

  // Notify App when dialog opens/closes
  React.useEffect(() => {
    notifyDialog(!!dialog)
    return () => notifyDialog(false)
  }, [dialog, notifyDialog])

  const contentRows = useMemo(() => {
    if (!issue) return []
    const rows = []
    
    // Labels
    if (issue.labels?.length > 0) {
      rows.push({ id: 'labels', el: (
        <Box key="labels" marginBottom={1} gap={1}>
          {issue.labels.map(l => (
            <Box key={l.name} paddingX={1} borderStyle="round" borderColor={`#${l.color}`}>
              <Text color={`#${l.color}`}>{sanitize(l.name)}</Text>
            </Box>
          ))}
        </Box>
      )})
    }

    // Body
    if (issue.body) {
      rows.push({ id: 'body-hdr', el: <Text color={t.ui.muted} bold>Description:</Text> })
      const mdRows = getMarkdownRows(issue.body, termCols - 4, t)
      mdRows.forEach((row, i) => rows.push({ id: `body-${i}`, el: row }))
    }

    // Comments
    if (issue.comments?.length > 0) {
      rows.push({ id: 'cmt-hdr', el: (
        <Box key="cmt-hdr" marginTop={1}>
          <Text color={t.ui.muted} bold>Comments ({issue.comments.length}):</Text>
        </Box>
      )})
      issue.comments.forEach((c, i) => {
        rows.push({ id: `cmt-${i}`, el: (
          <Box key={`cmt-${i}`} flexDirection="column" paddingX={1} marginBottom={1}>
            <Box gap={1}>
              <Text color={t.ui.selected}>{c.author?.login}</Text>
              <Text color={t.ui.dim}>{format(c.updatedAt || c.createdAt)}</Text>
            </Box>
            <Text color={t.diff.ctxFg}>{sanitize(c.body)}</Text>
          </Box>
        )})
      })
    }
    return rows
  }, [issue, termCols, t])

  const visibleHeight = Math.max(3, termRows - 10)
  const maxScroll = Math.max(0, contentRows.length - visibleHeight)
  const visibleRows = contentRows.slice(scrollY, scrollY + visibleHeight)

  const doReply = useCallback(() => {
    const text = replyText
    setReplyMode(false)
    setReplyText('')
    addIssueComment(repo, issueNumber, text)
      .then(() => { setStatusMsg('Reply sent'); refetch(); setTimeout(() => setStatusMsg(null), 3000) })
      .catch(err => { setStatusMsg(`Failed: ${err.message}`); setTimeout(() => setStatusMsg(null), 5000) })
  }, [repo, issueNumber, replyText, refetch])

  useKeymapInput((input, key) => {
    if (dialog) return

    if (replyMode) {
      if (key.escape) { setReplyMode(false); setReplyText(''); return }
      return
    }

    if (input === 'r') { setReplyMode(true); return }
    if (input === 'l') { setDialog('labels'); return }
    if (input === 'A') { setDialog('assignees'); return }
    if (input === 'o' && issue?.url) {
      import('execa').then(({ execa }) => {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        execa(cmd, [issue.url]).catch(() => {})
      })
      return
    }
    if (key.escape || input === 'q') { onBack(); return }

    // gg → top
    if (input === 'g') {
      if (lastKeyRef.current === 'g') {
        clearTimeout(lastKeyTimer.current)
        lastKeyRef.current = null
        setScrollY(0)
        return
      }
      lastKeyRef.current = 'g'
      lastKeyTimer.current = setTimeout(() => { lastKeyRef.current = null }, 400)
      return
    }
    lastKeyRef.current = null

    if (input === 'G') { setScrollY(maxScroll); return }
    if (input === 'j' || key.downArrow) { setScrollY(s => Math.min(maxScroll, s + 1)); return }
    if (input === 'k' || key.upArrow)   { setScrollY(s => Math.max(0, s - 1)); return }
  })

  if (loading) return <IssueDetailSkeleton />
  if (error) return <Box paddingX={1}><Text color={t.ci.fail}>⚠ Failed — r to retry</Text></Box>
  if (!issue) return null

  // ── Dialogs ────────────────────────────────────────────────────────────────

  if (dialog === 'labels') {
    return <IssueLabelDialog repo={repo} issue={issue} onClose={() => { setDialog(null); refetch() }} />
  }

  if (dialog === 'assignees') {
    return <IssueAssigneeDialog repo={repo} issue={issue} onClose={() => { setDialog(null); refetch() }} />
  }

  // ── Detail view ────────────────────────────────────────────────────────────

  const stateColor = issue.state === 'OPEN' ? t.issue.open : t.issue.closed

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box marginBottom={1} flexDirection="column" borderStyle="single" borderColor={t.ui.border} paddingX={1}>
        <Box gap={1}>
          <Text color={stateColor}>{issue.state === 'OPEN' ? '●' : '✗'}</Text>
          <Text bold color={t.ui.selected} wrap="truncate">#{issue.number} {sanitize(issue.title)}</Text>
        </Box>
        <Box gap={2}>
          <Text color={t.ui.muted}>by {issue.author?.login}</Text>
          <Text color={t.ui.dim}>{format(issue.updatedAt)}</Text>
          {issue.assignees?.length > 0 && (
            <Box gap={1}>
              {issue.assignees.map(a => (
                <Box key={a.login}>
                  <Text color={t.ui.muted}>@{a.login}</Text>
                </Box>
              ))}
            </Box>
          )}
          {issue.milestone?.title && (
            <Text color={t.ui.dim}>⚑ {issue.milestone.title}</Text>
          )}
        </Box>
      </Box>

      {/* ── Scrollable content ── */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleRows.map(row => row.el)}
      </Box>

      {/* ── Scroll info ── */}
      {maxScroll > 0 && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={t.ui.dim}>{scrollY + 1}–{Math.min(scrollY + visibleHeight, contentRows.length)} / {contentRows.length}  [j/k] scroll  [gg/G] top/bottom</Text>
        </Box>
      )}

      {replyMode && (
        <Box flexDirection="column" borderStyle="round" borderColor={t.ui.selected} paddingX={1} marginBottom={1}>
          <Text color={t.ui.muted} bold>Reply:</Text>
          <TextInput
            value={replyText}
            onChange={setReplyText}
            focus={true}
            onEnter={doReply}
          />
          <Text color={t.ui.dim}>[Enter] send  [Esc] cancel</Text>
        </Box>
      )}

      {statusMsg && <Text color={t.ci.pass}>{statusMsg}</Text>}
      
      <Box paddingX={1} gap={2} borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor={t.ui.border}>
        <Text color={t.ui.dim}>[r] reply  [l] labels  [A] assignees  [Esc] back</Text>
      </Box>
    </Box>
  )
}

// ─── Sub-dialogs ──────────────────────────────────────────────────────────────

function IssueLabelDialog({ repo, issue, onClose }) {
  const { t } = useTheme()
  const { data: allLabels, loading } = useGh(listLabels, [repo])
  if (loading) return <Box paddingX={1}><Text color={t.ui.muted}>Loading labels...</Text></Box>
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
  if (loading) return <Box paddingX={1}><Text color={t.ui.muted}>Loading collaborators...</Text></Box>
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
