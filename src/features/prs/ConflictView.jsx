/**
 * src/features/prs/ConflictView.jsx — GitHub PR merge-conflict resolution
 *
 * Resolves conflicts for a GitHub PR by:
 *   1. Checking out the PR branch locally
 *   2. Merging the base branch to expose conflict markers
 *   3. Opening each conflicting file in the configured editor
 *   4. Staging resolved files
 *   5. Committing + immediately pushing back to GitHub (updates the PR)
 *
 * Phases:
 *   CHECKING   — probing local git state
 *   SETUP      — branch not checked out or no merge in progress yet
 *   CONFLICTS  — mid-merge, files listed with resolution status
 *   COMMITTING — committing + pushing in one step
 *   DONE       — pushed, PR updated
 */

import React, { useState, useEffect, useCallback, useContext, useRef } from 'react'
import { Box, Text, useStdout } from 'ink'
import { useKeymapInput } from '../../config/keymap.js'
import { useKeyScope } from '../../keyscope.js'
import { useTheme } from '../../theme.js'
import { AppContext } from '../../context.js'
import { loadConfig } from '../../config.js'
import { sanitize, TextInput } from '../../utils.js'
import { Spinner } from '../../components/Spinner.jsx'
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.jsx'
import {
  getCurrentBranch, checkoutBranch,
  isInMerge, getConflictedFiles, countFileConflicts,
  gitAdd, gitUnstage, gitMergeAbort, gitCommit, gitMergeBranch,
  getMergeCommitMessage, pushBranch,
} from '../../executor.js'
import { openInEditor } from '../../editor.js'

const _editorCfg = loadConfig().editor

const PHASE = Object.freeze({
  CHECKING:    'checking',
  SETUP:       'setup',
  CONFLICTS:   'conflicts',
  COMMITTING:  'committing',
  DONE:        'done',
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONFLICT_XY = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'])

function fileStatusIcon(file, t) {
  if (file.staged)   return { icon: '✓', color: t.ci.pass }
  if (file.hunks > 0) return { icon: '●', color: t.pr.conflict || t.ci.pending }
  return { icon: '○', color: t.ui.muted }
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConflictView({ pr, repo, onBack, onResolved }) {
  useKeyScope('view')
  const { t } = useTheme()
  const { notifyDialog } = useContext(AppContext)
  const { stdout } = useStdout()
  const termRows = stdout?.rows || 24

  const [phase,       setPhase]       = useState(PHASE.CHECKING)
  const [localBranch, setLocalBranch] = useState(null)
  const [files,       setFiles]       = useState([])
  const [cursor,      setCursor]      = useState(0)
  const [commitMsg,   setCommitMsg]   = useState('')
  const [statusMsg,   setStatusMsg]   = useState(null)
  const [dialog,      setDialog]      = useState(null)
  const [busy,        setBusy]        = useState(false)
  const [setupStep,   setSetupStep]   = useState('')  // progress label during setup

  const showStatus = useCallback((msg, isError = false) => {
    setStatusMsg({ msg, isError })
    if (!isError) setTimeout(() => setStatusMsg(null), 4000)
  }, [])

  useEffect(() => {
    notifyDialog(!!dialog)
    return () => notifyDialog(false)
  }, [dialog, notifyDialog])

  // ── Probe local git state ─────────────────────────────────────────────────
  const loadFiles = useCallback(async () => {
    const raw = await getConflictedFiles()
    const withHunks = await Promise.all(
      raw.map(async (f) => {
        const hunks  = await countFileConflicts(f.path)
        // staged = no conflict markers left (user resolved and it's an unmerged file)
        const staged = hunks === 0
        return { ...f, hunks, staged }
      })
    )
    setFiles(withHunks)
    return withHunks
  }, [])

  const probe = useCallback(async () => {
    setPhase(PHASE.CHECKING)
    try {
      const [branch, inMerge] = await Promise.all([getCurrentBranch(), isInMerge()])
      setLocalBranch(branch)

      if (!inMerge) {
        setPhase(PHASE.SETUP)
        return
      }

      const fs = await loadFiles()
      const allResolved = fs.length === 0 || fs.every(f => f.staged)

      if (allResolved && fs.length > 0) {
        const msg = await getMergeCommitMessage()
        setCommitMsg(msg)
        // Still show CONFLICTS phase so user can review before committing
        setPhase(PHASE.CONFLICTS)
      } else {
        setPhase(PHASE.CONFLICTS)
      }
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
      setPhase(PHASE.SETUP)
    }
  }, [loadFiles, showStatus])

  useEffect(() => { probe() }, [probe])

  // ── Key handler ───────────────────────────────────────────────────────────
  useKeymapInput((input, key) => {
    if (busy || dialog) return
    if (phase === PHASE.CHECKING || phase === PHASE.COMMITTING) return

    if (key.escape || input === 'q') { onBack(); return }

    if (phase === PHASE.DONE) return

    if (phase === PHASE.SETUP) {
      if (key.return || input === 's') { doSetup(); return }
      if (input === 'o') { openInBrowser(); return }
      return
    }

    // CONFLICTS phase
    if (key.upArrow   || input === 'k') { setCursor(c => Math.max(0, c - 1)); return }
    if (key.downArrow || input === 'j') { setCursor(c => Math.min(files.length - 1, c + 1)); return }

    const file = files[cursor]

    if ((key.return || input === 'e') && file) {
      openInEditor(file.path, 1, _editorCfg).catch(() => {})
      showStatus(`Opened ${file.path} in editor — resolve conflicts, save, then [Space] to stage`)
      return
    }

    if (input === ' ' && file) {
      if (file.staged) { doUnstage(file) } else { doStage(file) }
      return
    }

    if (input === 'r') {
      setBusy(true)
      loadFiles()
        .then(fs => {
          setFiles(fs)
          const allResolved = fs.every(f => f.staged)
          if (allResolved && fs.length > 0) {
            getMergeCommitMessage().then(msg => setCommitMsg(prev => prev || msg))
          }
        })
        .catch(err => showStatus(`✗ ${err.message}`, true))
        .finally(() => setBusy(false))
      return
    }

    if (input === 'c') {
      const allStaged = files.length > 0 && files.every(f => f.staged)
      if (!allStaged) {
        showStatus('✗ Stage all resolved files first ([Space] to stage)', true)
        return
      }
      doCommitAndPush()
      return
    }

    if (input === 'A') { setDialog('abort'); return }
    if (input === 'o') { openInBrowser(); return }
  })

  // ── Actions ───────────────────────────────────────────────────────────────

  const openInBrowser = useCallback(() => {
    const url = `${pr.url}/conflicts`
    import('execa').then(({ execa }) => {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
      execa(cmd, [url]).catch(() => {})
    })
    showStatus('Opening GitHub conflict editor in browser…')
  }, [pr, showStatus])

  const doSetup = useCallback(async () => {
    setBusy(true)
    setPhase(PHASE.CHECKING)
    try {
      const prBranch  = pr.headRefName
      const baseBranch = pr.baseRefName

      // Step 1: checkout if needed
      if (localBranch !== prBranch) {
        setSetupStep(`Checking out ${prBranch}…`)
        await checkoutBranch(repo, pr.number)
        setLocalBranch(prBranch)
      }

      // Step 2: merge base to surface conflicts
      setSetupStep(`Merging ${baseBranch} into ${prBranch}…`)
      await gitMergeBranch(baseBranch)

      // Step 3: probe again (merge may have completed cleanly or left conflicts)
      await probe()
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
      setPhase(PHASE.SETUP)
    } finally {
      setBusy(false)
      setSetupStep('')
    }
  }, [localBranch, pr, repo, probe, showStatus])

  const doStage = useCallback(async (file) => {
    if (file.hunks > 0) {
      showStatus(`✗ ${file.path} still has conflict markers — fix and save first`, true)
      return
    }
    setBusy(true)
    try {
      await gitAdd([file.path])
      const fs = await loadFiles()
      setFiles(fs)
      const allStaged = fs.every(f => f.staged)
      if (allStaged && fs.length > 0) {
        const msg = await getMergeCommitMessage()
        setCommitMsg(prev => prev || msg)
        showStatus('✓ All files staged — press [c] to commit and push')
      } else {
        showStatus(`✓ Staged ${file.path}`)
      }
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
    } finally {
      setBusy(false)
    }
  }, [loadFiles, showStatus])

  const doUnstage = useCallback(async (file) => {
    setBusy(true)
    try {
      await gitUnstage([file.path])
      const fs = await loadFiles()
      setFiles(fs)
      showStatus(`Unstaged ${file.path}`)
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
    } finally {
      setBusy(false)
    }
  }, [loadFiles, showStatus])

  const doCommitAndPush = useCallback(async () => {
    const msg = commitMsg.trim()
    if (!msg) { showStatus('✗ Enter a commit message first', true); return }

    setPhase(PHASE.COMMITTING)
    setBusy(true)
    try {
      // Commit
      await gitCommit(msg)
      // Immediately push — this is what updates the PR on GitHub
      await pushBranch(pr.headRefName)
      setPhase(PHASE.DONE)
      if (onResolved) onResolved()
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
      setPhase(PHASE.CONFLICTS)
    } finally {
      setBusy(false)
    }
  }, [commitMsg, pr, onResolved, showStatus])

  const doAbort = useCallback(async () => {
    setDialog(null)
    setBusy(true)
    try {
      await gitMergeAbort()
      setFiles([])
      setPhase(PHASE.SETUP)
      showStatus('✓ Merge aborted')
    } catch (err) {
      showStatus(`✗ ${err.message}`, true)
    } finally {
      setBusy(false)
    }
  }, [showStatus])

  // ── Shared header ─────────────────────────────────────────────────────────

  const header = (
    <Box paddingX={1}
      borderStyle="single" borderColor={t.ui.border}
      borderTop={false} borderLeft={false} borderRight={false} borderBottom={true}>
      <Box gap={1} flexGrow={1}>
        <Text color={t.pr.conflict || t.ci.pending} bold>↯</Text>
        <Text color={t.ui.selected} bold>Conflict Resolution</Text>
        <Text color={t.ui.dim}>·</Text>
        <Text color={t.ui.dim}>PR</Text>
        <Text color={t.ui.muted}>#{pr.number}</Text>
        <Text color={t.ui.dim} wrap="truncate">{sanitize(pr.title).slice(0, 45)}</Text>
      </Box>
      {localBranch && (
        <Text color={t.ui.dim}> branch: <Text color={t.ui.muted}>{localBranch}</Text></Text>
      )}
    </Box>
  )

  // ── Abort confirm ─────────────────────────────────────────────────────────
  if (dialog === 'abort') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexGrow={1} paddingX={2} paddingY={1}>
          <ConfirmDialog
            message="Abort merge? All unsaved conflict resolution will be lost."
            destructive={true}
            onConfirm={doAbort}
            onCancel={() => setDialog(null)}
          />
        </Box>
      </Box>
    )
  }

  // ── Checking / Committing spinner ─────────────────────────────────────────
  if (phase === PHASE.CHECKING) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexGrow={1} paddingX={2} paddingY={1}>
          <Spinner label={setupStep || 'Checking local git state…'} />
        </Box>
      </Box>
    )
  }

  if (phase === PHASE.COMMITTING) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexGrow={1} paddingX={2} paddingY={1} flexDirection="column" gap={1}>
          <Spinner label="Committing resolution…" />
          <Text color={t.ui.dim}>Then pushing to GitHub to update the PR…</Text>
        </Box>
      </Box>
    )
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (phase === PHASE.DONE) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1} gap={1}>
          <Box gap={1}>
            <Text color={t.ci.pass} bold>✓ Conflicts resolved and pushed to GitHub</Text>
          </Box>
          <Box gap={1}>
            <Text color={t.ui.dim}>Commit:</Text>
            <Text color={t.ui.muted}>{commitMsg.split('\n')[0].slice(0, 60)}</Text>
          </Box>
          <Box gap={1} marginTop={1}>
            <Text color={t.ui.dim}>The PR is updated. GitHub will re-check mergeability.</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={t.ui.dim}>[Esc/q] back to PR</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  if (phase === PHASE.SETUP) {
    const isOnBranch = localBranch === pr.headRefName
    return (
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1} gap={1}>

          <Box gap={1}>
            <Text color={t.pr.conflict || t.ci.pending} bold>↯ PR #{pr.number}</Text>
            <Text color={t.ui.muted}>has conflicts with</Text>
            <Text color={t.ui.selected} bold>{pr.baseRefName}</Text>
          </Box>

          <Text color={t.ui.dim}>
            To resolve: checkout the PR branch, merge the base branch to surface{'\n'}
            conflict markers, fix them in your editor, then commit + push.
          </Text>

          <Box flexDirection="column" paddingX={1} gap={0}>
            <Box gap={1}>
              <Text color={isOnBranch ? t.ci.pass : t.ui.dim}>{isOnBranch ? '✓' : '1.'}</Text>
              <Text color={isOnBranch ? t.ui.dim : t.ui.muted}>
                Checkout <Text color={t.ui.selected}>{pr.headRefName}</Text>
              </Text>
              {isOnBranch && <Text color={t.ui.dim}>(current branch)</Text>}
            </Box>
            <Box gap={1}>
              <Text color={t.ui.dim}>{isOnBranch ? '1.' : '2.'}</Text>
              <Text color={t.ui.muted}>
                Merge <Text color={t.ui.selected}>{pr.baseRefName}</Text> → surfaces conflicts locally
              </Text>
            </Box>
            <Box gap={1}>
              <Text color={t.ui.dim}>{isOnBranch ? '2.' : '3.'}</Text>
              <Text color={t.ui.muted}>Fix conflict markers, stage, commit + push</Text>
            </Box>
          </Box>

          {localBranch && !isOnBranch && (
            <Box gap={1}>
              <Text color={t.ui.dim}>Current branch:</Text>
              <Text color={t.ui.muted}>{localBranch}</Text>
            </Box>
          )}

          {busy
            ? <Spinner label={setupStep || 'Working…'} />
            : (
              <Box gap={3} marginTop={1}>
                <Box backgroundColor={t.ui.headerBg} paddingX={1}>
                  <Text color={t.ui.selected} bold>
                    [Enter/s] {isOnBranch ? `Merge ${pr.baseRefName} locally` : `Checkout + merge`}
                  </Text>
                </Box>
                <Text color={t.ui.dim}>[o] open in GitHub browser editor</Text>
                <Text color={t.ui.dim}>[Esc] back</Text>
              </Box>
            )
          }

          {statusMsg && (
            <Text color={statusMsg.isError ? t.ci.fail : t.ci.pass}>{statusMsg.msg}</Text>
          )}
        </Box>
      </Box>
    )
  }

  // ── Conflicts list ────────────────────────────────────────────────────────
  // (also used when all files are staged — shows commit editor at bottom)
  const allStaged    = files.length > 0 && files.every(f => f.staged)
  const remaining    = files.filter(f => !f.staged).length
  const visibleHeight = Math.max(2, termRows - (allStaged ? 14 : 9))
  const scrollOff    = Math.max(0, cursor - visibleHeight + 1)
  const visible      = files.slice(scrollOff, scrollOff + visibleHeight)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {header}

      {/* Progress bar */}
      <Box paddingX={2} gap={3}>
        {remaining > 0
          ? <Text color={t.pr.conflict || t.ci.pending} bold>{remaining} file{remaining !== 1 ? 's' : ''} with unresolved conflicts</Text>
          : <Text color={t.ci.pass} bold>✓ All conflicts resolved — ready to commit</Text>
        }
        <Text color={t.ui.dim}>
          {files.length - remaining}/{files.length} staged
        </Text>
      </Box>

      {/* File list */}
      <Box flexDirection="column" overflow="hidden"
        flexGrow={allStaged ? 0 : 1}
        paddingX={1}>
        {visible.map((file, i) => {
          const idx        = scrollOff + i
          const isCursor   = idx === cursor
          const { icon, color } = fileStatusIcon(file, t)
          return (
            <Box key={file.path}
              paddingX={1}
              backgroundColor={isCursor ? t.ui.headerBg : undefined}>
              <Text color={isCursor ? t.ui.selected : t.ui.muted}>{isCursor ? '▶ ' : '  '}</Text>
              <Text color={color} bold>{icon} </Text>
              <Box flexGrow={1}>
                <Text
                  color={isCursor ? t.ui.selected : (file.staged ? t.ui.dim : undefined)}
                  wrap="truncate">
                  {sanitize(file.path)}
                </Text>
              </Box>
              <Text color={t.ui.dim}>  </Text>
              {file.staged
                ? <Text color={t.ci.pass}>staged</Text>
                : <Text color={t.pr.conflict || t.ci.pending}>
                    {file.hunks} hunk{file.hunks !== 1 ? 's' : ''}
                  </Text>
              }
            </Box>
          )
        })}
      </Box>

      {/* Commit editor — shown when all staged */}
      {allStaged && (
        <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
          <Text color={t.ui.selected} bold>Commit message:</Text>
          <Box borderStyle="round" borderColor={t.ui.selected} paddingX={1}>
            <TextInput
              value={commitMsg}
              onChange={setCommitMsg}
              focus={true}
              onEnter={doCommitAndPush}
            />
          </Box>
          <Text color={t.ui.dim}>
            [Enter/c] Commit + push to GitHub  ·  [Esc] back
          </Text>
        </Box>
      )}

      {/* Hint / status bar */}
      <Box paddingX={1} flexDirection="column">
        {statusMsg
          ? <Text color={statusMsg.isError ? t.ci.fail : t.ci.pass}>{statusMsg.msg}</Text>
          : !allStaged
            ? <Text color={t.ui.dim}>
                [e/Enter] open editor  [Space] stage/unstage  [r] refresh  [c] commit  [A] abort  [o] browser
              </Text>
            : null
        }
      </Box>
    </Box>
  )
}
