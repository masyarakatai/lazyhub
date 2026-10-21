// @ts-nocheck
// TODO(#197): root app state/navigate callbacks need explicit typedefs after split.
/**
 * app.jsx — root Ink layout + renderApp() entry point.
 *
 * Layout (≥100 cols):
 *   ┌─ sidebar 18 ─┐┌─ list (flex) ──────────────────┐┌─ detail 40 ─┐
 *   │              ││                                 ││             │
 *   └──────────────┘└─────────────────────────────────┘└─────────────┘
 *     status bar (1 row)
 *     footer keys (1 row)
 *
 * Layout (<100 cols, ≥80):  sidebar + list only
 * Layout (<80 cols):        list only (sidebar replaced by tab header)
 */

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { render, useInput, useApp } from 'ink'
import { ThemeProvider, useTheme, readRawThemeCfg } from './theme.js'
import { KeyScopeProvider, useActiveScope, useKeyScope } from './keyscope.js'
import { loadConfig, CONFIG_PATH } from './config.js'
import { ConfigProvider } from './config/index.js'
import { migrateStateJsonToToml } from './config/migrate.js'
import { useLayout } from './hooks/useLayout.js'
import { AppContext } from './context.js'
import { logger } from './utils.js'
import { emitIPC, startIPC } from './ipc.js'
import { openInEditor } from './editor.js'
import { THEME_NAMES } from './theme.js'
import { matchesAction } from './config/actions.js'
import { writeDebugState } from './debug-state.js'
import { restoreTerminal } from './crash.js'
import { startTimer, recordMeasure, isPerfEnabled } from './perf.js'
import { useGhHealth } from './hooks/useGhHealth.js'


import { APP_CONFIG as _config, PANES } from './app-keys.js'
import { renderAppView } from './app-views.jsx'

// ─── Main App ─────────────────────────────────────────────────────────────────

export function App({ repo }) {
  const { t, setTheme } = useTheme()
  const { exit } = useApp()
  const ghHealth = useGhHealth()
  const pendingInputPerf = useRef([])
  const activeScope = useActiveScope()
  const layout = useLayout()
  const { cols: columns, rows, sidebarWidth, previewWidth, borderStyle, compactFooter, showSidebar, showPreview, listHeight } = layout

  // ─── Mouse support ────────────────────────────────────────────────────────
  const [mouseEnabled, setMouseEnabled] = useState(
    _config.mouse === true || process.env.LAZYHUB_MOUSE === '1'
  )

  useEffect(() => {
    if (!mouseEnabled) return
    // Enable mouse button + scroll tracking (X10 + SGR mode)
    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h')
    // Parse mouse events from raw stdin data — runs before readline/Ink sees the bytes
    const handleData = (buf) => {
      const str = buf.toString()
      // SGR mouse: ESC [ < Cb ; Cx ; Cy M/m
      const sgr = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
      if (!sgr) return
      const btn = parseInt(sgr[1])
      // Scroll up = btn 64, scroll down = btn 65
      if (btn === 64) { process.stdin.emit('keypress', 'k', { name: 'k', sequence: 'k', ctrl: false, meta: false, shift: false }) }
      if (btn === 65) { process.stdin.emit('keypress', 'j', { name: 'j', sequence: 'j', ctrl: false, meta: false, shift: false }) }
    }
    process.stdin.prependListener('data', handleData)
    return () => {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1015l\x1b[?1006l')
      process.stdin.off('data', handleData)
    }
  }, [mouseEnabled])

  // GHUI_PR / GHUI_VIEW — set by nvim :LazyHubPR (or any external launcher)
  // to deep-link directly to a PR's diff view on startup.
  const _initPRNum  = process.env.GHUI_PR  ? parseInt(process.env.GHUI_PR,  10) : null
  const _initView   = process.env.GHUI_VIEW || 'list'
  const _validViews = ['list', 'detail', 'diff', 'comments']

  const [pane, setPane]             = useState(_initPRNum ? 'prs' : _config.defaultPane)
  const [view, setView]             = useState(
    _initPRNum && _validViews.includes(_initView) ? _initView : 'list'
  )
  const [selectedItem, setSelectedItem] = useState(
    _initPRNum && !isNaN(_initPRNum) ? { number: _initPRNum } : null
  )
  const [showHelp, setShowHelp]         = useState(false)
  const [showAI, setShowAI]             = useState(false)
  const [paneState, setPaneState]       = useState({})
  const [appMode, setAppMode]           = useState('NORMAL')
  const [toasts, setToasts]             = useState([])
  const [recentStatus, setRecentStatus] = useState([])
  const [showPalette, setShowPalette]   = useState(false)
  const [leaderActive, setLeaderActive] = useState(false)
  const leaderTimerRef = useRef(null)

  const addToast = useCallback(({ message, variant = 'info', durationMs }) => {
    const id = Date.now() + Math.random()
    setRecentStatus(prev => [...prev.slice(-4), { message, variant, at: new Date().toISOString() }])
    setToasts(prev => [...prev.slice(-2), { id, message, variant }])
    if (variant !== 'error') {
      const ttl = durationMs ?? (variant === 'success' ? 2500 : variant === 'warning' ? 4000 : 3000)
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ttl)
    }
  }, [])

  const dialogActiveRef    = useRef(false)
  const savedListPosition  = useRef({})
  const pendingNavigationRef = useRef(null)
  const paneStateMapRef    = useRef(new Map())
  const notifyDialog = useCallback((active) => { dialogActiveRef.current = active }, [])
  const openHelp     = useCallback(() => setShowHelp(true), [])
  const openAI       = useCallback(() => setShowAI(true), [])

  const appCtx = { notifyDialog, openHelp, openAI, setMouseEnabled, addToast, paneStateMap: paneStateMapRef.current }

  const dumpDebugState = useCallback(() => {
    try {
      const { path } = writeDebugState({
        activePane: pane,
        view,
        itemNumber: selectedItem?.number ?? null,
        filters: paneState.filters || paneState.filter || {},
        cursors: {
          selectedIndex: paneState.selectedIndex ?? null,
          cursor: paneState.cursor ?? null,
          count: paneState.count ?? null,
        },
        dialog: paneState.dialogHint || (dialogActiveRef.current ? 'active' : null),
        mode: appMode,
        recentStatus,
      })
      addToast({ message: `Debug state written: ${path}`, variant: 'success', durationMs: 5000 })
    } catch (err) {
      addToast({ message: `Debug state failed: ${err.message}`, variant: 'error' })
    }
  }, [addToast, appMode, pane, paneState, recentStatus, selectedItem, view])

  // ─── IPC state broadcast ──────────────────────────────────────────────────
  useEffect(() => {
    const ipcState = {
      repo:        process.env.GHUI_REPO || null,
      pane,
      view,
      prNumber:    (pane === 'prs' && selectedItem) ? selectedItem.number : null,
      issueNumber: (pane === 'issues' && selectedItem) ? selectedItem.number : null,
    }
    emitIPC('view-changed', ipcState)
  }, [pane, view, selectedItem])

  // ─── Layout (via useLayout hook) ─────────────────────────────────────────
  const showDetailPanel  = false
  const detailPanelWidth = 0

  // ─── AI navigate callback ─────────────────────────────────────────────────
  const handleAINavigate = useCallback(({ pane: tp, itemNumber, filter } = {}) => {
    setShowAI(false)
    const validPane = PANES.includes(tp) ? tp : null
    if (validPane) {
      setPane(validPane)
      setView('list')
      setSelectedItem(null)
      savedListPosition.current = {}
      pendingNavigationRef.current = { itemNumber, filter }
    }
  }, [PANES]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Global key handler ───────────────────────────────────────────────────
  useInput((input, key) => {
    if (isPerfEnabled()) pendingInputPerf.current.push(startTimer())
    if (process.env.LAZYHUB_CRASH_TEST === '1' && ((key.ctrl && input === '_') || input === '\x1f')) {
      throw new Error('LAZYHUB_CRASH_TEST crash')
    }
    // Ctrl+A: open AI assistant (always fires regardless of scope)
    if (matchesAction('app.ai-assistant', input, key, _config.toml)) { setShowAI(true); return }
    if (matchesAction('debug.dump-state', input, key, _config.toml)) { dumpDebugState(); return }

    // Dismiss sticky error toasts on any key
    if (toasts.some(t => t.variant === 'error')) {
      setToasts(prev => prev.filter(t => t.variant !== 'error'))
      return
    }

    // Only handle global keys when no higher-priority scope has captured input.
    // Scope stack: global(0) < pane(1) < view(2) < overlay(3) < dialog(4) < input(5)
    // At pane level, Tab/number/? are still valid (list pane doesn't block them).
    // At view/overlay/dialog/input, we must defer — EXCEPT for q/Esc when no
    // component at the active scope handles it (see below).
    const highScope = activeScope !== 'global' && activeScope !== 'pane' && activeScope !== 'list'
    if (highScope || dialogActiveRef.current) {
      // q/Esc from the list view (pane scope active) should always quit/back.
      // This is the lazygit convention.  We allow it through even at 'view' scope
      // only when the view is one of the static shell views (settings/logs) that
      // don't have their own useInput 'q' handlers and don't claim a scope — so
      // their activeScope falls back to whatever the last list pane pushed.
      // Concrete case: user is in list → presses S (opens settings) → presses q.
      // Settings mounts without claiming a scope, so activeScope is still 'pane'.
      // highScope is false for 'pane', so this block isn't even entered.
      // The only problematic case would be if some intermediate component
      // incorrectly pushes 'view' scope while settings/logs are shown.
      return
    }

    if (matchesAction('app.back', input, key, _config.toml)) {
      if (showHelp)              { setShowHelp(false); return }
      if (view === 'settings')   { setView('list'); return }
      if (view === 'logs')       { setView('list'); return }
      if (view === 'comments')   { setView('diff'); return }
      if (view === 'conflict')   { setView('detail'); return }
      if (view === 'diff')       { setView(selectedItem?._fromList ? 'list' : 'detail'); return }
      if (view === 'detail')     { setSelectedItem(null); setView('list'); return }
      // At the root only `q` quits; a stray Esc must never kill the app.
      if (!key.escape) exit()
      return
    }

    if (matchesAction('app.help', input, key, _config.toml)) { setShowHelp(v => !v); return }

    // Help overlay eats everything else
    if (showHelp) { setShowHelp(false); return }

    if (matchesAction('app.next-pane', input, key, _config.toml) || matchesAction('app.prev-pane', input, key, _config.toml)) {
      const idx = PANES.indexOf(pane)
      setPane(PANES[matchesAction('app.prev-pane', input, key, _config.toml)
        ? (idx - 1 + PANES.length) % PANES.length
        : (idx + 1) % PANES.length
      ])
      setSelectedItem(null); setView('list')
      setActionsBranch(null)
      return
    }

    // 1–9: jump directly to pane by position
    const numKey = parseInt(input, 10)
    if (!isNaN(numKey) && numKey >= 1 && numKey <= PANES.length) {
      const target = PANES[numKey - 1]
      if (target && target !== pane) {
        setPane(target)
        setSelectedItem(null); setView('list')
        setActionsBranch(null)
      }
      return
    }

    if (matchesAction('app.settings', input, key, _config.toml)) { setView('settings'); setSelectedItem(null); return }
    if (matchesAction('app.open-config', input, key, _config.toml)) { openInEditor(CONFIG_PATH, 1, _config.editor).catch(() => {}); return }
    if (matchesAction('app.logs', input, key, _config.toml) && process.env.LAZYHUB_DEBUG === '1') { setView('logs'); setSelectedItem(null); return }

    // V — toggle visual (batch-select) mode skeleton
    if (matchesAction('app.visual-toggle', input, key, _config.toml) && view === 'list') {
      setAppMode(m => m === 'VISUAL' ? 'NORMAL' : 'VISUAL')
      return
    }

    // : — command palette
    if (matchesAction('command-palette.open', input, key, _config.toml)) {
      setShowPalette(true)
      setAppMode('COMMAND')
      return
    }

    // Space — leader key (1500ms window)
    // Second space within the window opens the command palette (<space><space>)
    if (matchesAction('app.leader', input, key, _config.toml)) {
      if (leaderActive) {
        // Double-space: open command palette
        clearTimeout(leaderTimerRef.current)
        setLeaderActive(false)
        setShowPalette(true)
        setAppMode('COMMAND')
        return
      }
      setLeaderActive(true)
      clearTimeout(leaderTimerRef.current)
      leaderTimerRef.current = setTimeout(() => {
        setLeaderActive(false)
      }, 1500)
      return
    }

    // Leader chords (only when leaderActive)
    if (leaderActive) {
      clearTimeout(leaderTimerRef.current)
      setLeaderActive(false)
      if (matchesAction('app.leader-theme', input, key, _config.toml)) { setShowPalette(true); setAppMode('COMMAND'); return }
      if (matchesAction('app.leader-ai', input, key, _config.toml)) { setShowAI(true); return }
      if (matchesAction('app.leader-help', input, key, _config.toml)) { setShowHelp(true); return }
      if (matchesAction('app.leader-recent', input, key, _config.toml)) { /* recent PRs — future */ return }
      return
    }

  })

  useEffect(() => {
    if (!isPerfEnabled() || pendingInputPerf.current.length === 0) return
    const pending = pendingInputPerf.current.splice(0)
    for (const started of pending) recordMeasure('input', 'keypress-render', started)
  })

  // ─── Navigation callbacks ─────────────────────────────────────────────────
  const goToDetail   = useCallback((item) => {
    setSelectedItem(item); setView('detail')
  }, [])
  const goToDiff       = useCallback((item) => { setSelectedItem({ ...item, _fromList: view === 'list' }); setView('diff') }, [view])
  const goToComments   = useCallback(() => setView('comments'), [])
  const goToConflict   = useCallback(() => setView('conflict'), [])
  const [actionsBranch, setActionsBranch] = useState(null)
  const goToActions    = useCallback((branch) => {
    setActionsBranch(branch || null)
    setPane('actions')
    setSelectedItem(null)
    setView('list')
  }, [])
  const goBack         = useCallback(() => {
    if (view === 'comments') { setView('diff'); return }
    if (view === 'conflict') { setView('detail'); return }
    if (view === 'diff')     { setView(selectedItem?._fromList ? 'list' : 'detail'); return }
    setSelectedItem(null); setView('list')
  }, [view, selectedItem])

  const onPaneState = useCallback((s) => setPaneState(prev => ({ ...prev, ...s })), [])

  // Clear visual mode whenever we leave list view
  useEffect(() => {
    if (view !== 'list' && appMode === 'VISUAL') setAppMode('NORMAL')
  }, [view, appMode])

  return renderAppView({
    actionsBranch, activeScope, appCtx, appMode, borderStyle, columns, compactFooter,
    exit, ghHealth, goBack, goToActions, goToComments, goToConflict, goToDetail,
    goToDiff, handleAINavigate, leaderActive, listHeight, onPaneState, pane,
    paneState, repo, rows, selectedItem, setAppMode, setPane, setSelectedItem,
    setShowAI, setShowHelp, setShowPalette, setTheme, setView, showAI, showHelp,
    showPalette, showSidebar, sidebarWidth, t, toasts, view,
  })

}

export function renderApp() {
  const repo = process.env.GHUI_REPO || ''
  migrateStateJsonToToml()

  // Enter alternate screen buffer — terminal restores on exit (like lazygit / vim)
  process.stdout.write('\x1b[?1049h\x1b[H')

  process.on('exit', restoreTerminal)

  const initialTheme = readRawThemeCfg()
  try {
    const { unmount } = render(
      <ConfigProvider>
        <ThemeProvider initialTheme={initialTheme}>
          <KeyScopeProvider>
            <App repo={repo} />
          </KeyScopeProvider>
        </ThemeProvider>
      </ConfigProvider>
    )

    // When Ink exits (useApp().exit() called), also restore terminal
    // Ink emits its own cleanup; we hook the process 'exit' above which covers it.
    // Store unmount so bootstrap can use it if needed.
    process.env._GHUI_UNMOUNT = '1'
    return unmount
  } catch (err) {
    logger.error('Fatal App Crash', err)
    restoreTerminal()
    process.exit(1)
  }
}
