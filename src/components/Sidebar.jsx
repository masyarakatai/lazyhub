/** Sidebar.jsx — Navigation sidebar for switching between feature views. */
import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../theme.js'
import { displayWidth, truncateEllipsis } from '../utils.js'

const BUILTIN_LABELS = {
  prs:           'Pull Requests',
  issues:        'Issues',
  branches:      'Branches',
  actions:       'Actions',
  notifications: 'Notifications',
}

const BUILTIN_ICONS = {
  prs:           '⎇',
  issues:        '⚑',
  branches:      '⌥',
  actions:       '↯',
  notifications: '✦',
}

export function Sidebar({ currentPane, onSelect, height, visiblePanes, paneLabels, paneIcons, repo, width = 24, borderStyle = 'round', borderRight = true, paneCounts = {} }) {
  const { t } = useTheme()
  const INNER = width - 4
  const labels = paneLabels || BUILTIN_LABELS
  const icons  = paneIcons  || BUILTIN_ICONS

  const parts = (repo || process.env.GHUI_REPO || '').split('/')
  const owner    = parts[0] || ''
  const repoName = parts[1] || ''
  const repoDisplay = owner && repoName ? `${owner}/${repoName}` : (owner || repoName)

  const allItems = (visiblePanes || Object.keys(BUILTIN_LABELS)).map((id, idx) => ({
    pane:  id,
    icon:  icons[id] || '✦',
    label: labels[id] || id,
    num:   idx + 1,
    count: paneCounts[id] || 0,
  }))

  // Row = marker(1) icon(w) space(1) label … [count] gap(1) num.  The label gets
  // whatever is left so it can never run into the count or the pane number.
  const labelWidth = (icon, num, showCount, count) =>
    Math.max(1, INNER - 1 - displayWidth(icon) - 1 - 1 - displayWidth(String(num))
      - (showCount ? displayWidth(` [${count}]`) : 0))

  const divider = <Box paddingX={1}><Text color={t.ui.divider}>{'─'.repeat(INNER)}</Text></Box>

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle={borderStyle || 'round'}
      borderColor={t.ui.border}
      borderRight={borderRight}
      height={height}
    >
      {/* Brand */}
      <Box paddingX={1} flexDirection="column">
        <Text color={t.ui.selected} bold wrap="truncate">⌂ lazyhub</Text>
        {repoDisplay && <Text color={t.ui.muted} wrap="truncate">{repoDisplay.slice(0, INNER)}</Text>}
      </Box>

      {divider}

      {/* Nav */}
      <Box flexDirection="column" flexGrow={1}>
        {allItems.map(({ pane, icon, label, num, count }) => {
          const active = pane === currentPane
          const countColor = pane === 'notifications' ? t.ui.selected : t.ui.dim
          const showCount = !active && count > 0
          const fitted = truncateEllipsis(label, labelWidth(icon, num, showCount, count))
          return (
            <Box key={pane} paddingX={1} backgroundColor={active ? t.ui.activeBg : undefined}>
              <Text color={active ? t.ui.selected : t.ui.dim} bold={active} wrap="truncate">
                {active ? '▎' : ' '}{icon} {fitted}
              </Text>
              {showCount && <Text color={countColor}> [{count}]</Text>}
              <Box flexGrow={1} />
              <Text color={active ? t.ui.selected : t.ui.dim}>{num}</Text>
            </Box>
          )
        })}
      </Box>

      {divider}

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={t.ui.dim} wrap="truncate">? help · S cfg · E edit</Text>
      </Box>
    </Box>
  )
}
