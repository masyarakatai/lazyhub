/** StatusBar.jsx — Application status bar showing context and global state. */

import React, { useState, useEffect } from 'react'
import { Box, Text, useStdout } from 'ink'
import { useTheme } from '../theme.js'
import { sanitize } from '../utils.js'

const PANE_META = {
  prs:           { icon: '⎇',  label: 'Pull Requests' },
  issues:        { icon: '⚑',  label: 'Issues'        },
  branches:      { icon: '⌥',  label: 'Branches'      },
  actions:       { icon: '↯', label: 'Actions'       },
  notifications: { icon: '✦',  label: 'Notifications' },
  settings:      { icon: '⌘',  label: 'Settings'      },
  logs:          { icon: '⌸',  label: 'Logs'          },
}

// Mode chip colors — uses semantic tokens if available, falls back to ci/ui tokens
function modeColor(mode, t) {
  const m = t.semantic?.mode
  if (m) {
    const map = { NORMAL: m.normal, SEARCH: m.search, COMMAND: m.command, VISUAL: m.visual, COMPOSE: m.compose }
    if (map[mode]) return map[mode]
  }
  const fallback = { NORMAL: t.ui.selected, SEARCH: t.ci.pending, COMMAND: t.ui.selected, VISUAL: t.ci.pass, COMPOSE: t.ci.pass }
  return fallback[mode] || t.ui.dim
}

function formatAge(ms) {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 5)    return 'just now'
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function StatusBar({ repo, pane, count, filterState, scopeIndicator, mode = 'NORMAL', ghHealth }) {
  const { t } = useTheme()
  const { stdout } = useStdout()
  const cols = stdout?.columns || 80
  const [mountTime] = useState(Date.now())
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const meta    = PANE_META[pane] || { icon: '✦', label: pane || '' }
  const dot     = <Text color={t.ui.dim}>  ·  </Text>
  const chipClr = modeColor(mode, t)
  const narrow  = cols < 100
  const degraded = ghHealth?.degraded
  const errorText = degraded
    ? sanitize(ghHealth.failingCount > 1
      ? `${ghHealth.failingCount} calls failing: ${ghHealth.error?.message || ghHealth.error || 'gh failed'}`
      : `${ghHealth.error?.message || ghHealth.error || 'gh failed'} - press r to retry`)
    : null

  return (
    <Box paddingX={1} justifyContent="space-between" backgroundColor={t.ui.headerBg}>
      {/* Left zone: pane · repo · count · filter */}
      <Box gap={0}>
        <Text color={t.ui.selected} bold>{meta.icon}  {meta.label}</Text>
        {repo && <>{dot}<Text color={t.ui.muted}>{repo}</Text></>}
        {count != null && <>{dot}<Text color={t.ui.dim}>{count} items</Text></>}
        {filterState && !narrow && <>{dot}<Text color={t.ui.muted}>{filterState}</Text></>}
      </Box>

      {/* Right zone: mode chip · refresh age · scope */}
      <Box gap={1}>
        {errorText && <Text color={t.ci?.fail || t.ui.selected} bold>{errorText}</Text>}
        {mode !== 'NORMAL' && (
          <Text color={chipClr} bold>{mode}</Text>
        )}
        {scopeIndicator && <Text color={t.ui.dim}>[{scopeIndicator}]</Text>}
        {!narrow && <Text color={t.ui.dim}>⟳ {formatAge(mountTime)}</Text>}
      </Box>
    </Box>
  )
}
