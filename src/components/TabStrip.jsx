/**
 * TabStrip.jsx — horizontal pane tabs for compact mode (<80 cols).
 * Props: panes (string[]), currentPane, paneLabels, paneIcons, onSelect
 */

import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../theme.js'

export function TabStrip({ panes = [], currentPane, paneLabels = {}, paneIcons = {}, onSelect }) {
  const { t } = useTheme()

  return (
    <Box flexDirection="row" paddingX={1}>
      {panes.map((pane, i) => {
        const active = pane === currentPane
        const icon   = paneIcons[pane]  || '✦'
        const label  = paneLabels[pane] || pane
        return (
          <Box key={pane}>
            {i > 0 && <Text color={t.ui.dim}> │ </Text>}
            <Box gap={1}>
              {active && <Text color={t.ui.selected}>▎</Text>}
              <Text
                color={active ? t.ui.selected : t.ui.muted}
                bold={active}
              >
                {icon} {active ? label : icon}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
