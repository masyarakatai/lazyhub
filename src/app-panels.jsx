import React from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { useTheme } from './theme.js'
import { useKeyScope } from './keyscope.js'
import { matchesAction } from './config/actions.js'
import { APP_CONFIG as _config, GLOBAL_KEYS, PANE_ICONS, PANE_KEYS, PANE_LABELS, VIEW_KEYS } from './app-keys.js'

// ─── Help overlay — shown on ? from any view ─────────────────────────────────

export function HelpOverlay({ pane, view, onClose }) {
  useKeyScope('overlay')
  const { t } = useTheme()
  const { stdout } = useStdout()
  const cols = stdout?.columns || 80
  useInput((input, key) => {
    if (matchesAction('dialog.cancel', input, key, _config.toml) ||
        matchesAction('dialog.confirm', input, key, _config.toml) ||
        matchesAction('app.help', input, key, _config.toml)) onClose()
  })

  const isListView = view === 'list'
  const contextKeys = isListView ? (PANE_KEYS[pane] || []) : (VIEW_KEYS[view] || [])
  const contextLabel = isListView
    ? `${PANE_ICONS[pane] || '○'}  ${PANE_LABELS[pane] || pane} list`
    : `${view.charAt(0).toUpperCase()}${view.slice(1)} view`

  const narrow = cols < 90

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor={t.ui.selected}>
      {/* ── Header ── */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color={t.ui.selected} bold>⌨  Keyboard Reference</Text>
          <Text color={t.ui.dim}>— {contextLabel}</Text>
        </Box>
        <Text color={t.ui.dim}>[Esc/Enter/?] close</Text>
      </Box>

      <Box flexDirection="row" gap={4}>
        {/* Context-specific keys */}
        <Box flexDirection="column" width={40}>
          <Box marginBottom={0} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderBottom={true} borderColor={t.ui.dim}>
            <Text color={t.ui.muted} bold>{contextLabel}</Text>
          </Box>
	          <Box flexDirection="column" marginTop={1}>
	            {contextKeys.length > 0 ? contextKeys.map(k => (
	              <Box key={k.key} gap={2}>
	                <Box width={18}>
	                  <Text color={t.ui.selected} bold>{k.key}</Text>
	                </Box>
	                <Text color={t.ui.muted}>{k.label}</Text>
	              </Box>
	            )) : <Text color={t.ui.dim}>No specific keys</Text>}
          </Box>
        </Box>

        {/* Global keys — hidden on narrow terminals */}
        {!narrow && (
          <Box flexDirection="column" width={38}>
            <Box marginBottom={0} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderBottom={true} borderColor={t.ui.dim}>
              <Text color={t.ui.muted} bold>Global (any view)</Text>
            </Box>
	            <Box flexDirection="column" marginTop={1}>
	              {GLOBAL_KEYS.map(k => (
	                <Box key={k.key} gap={2}>
	                  <Box width={18}>
	                    <Text color={t.ui.selected} bold>{k.key}</Text>
	                  </Box>
	                  <Text color={t.ui.muted}>{k.label}</Text>
	                </Box>
	              ))}
            </Box>
          </Box>
        )}
      </Box>

      {/* ── Config + docs hint ── */}
      <Box marginTop={1} flexDirection="column" paddingTop={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={t.ui.border}>
        <Box gap={1}>
          <Text color={t.ui.dim}>Config:</Text>
          <Text color={t.ui.selected}>~/.config/lazyhub/lazyhub.toml</Text>
          {!narrow && <Box flexGrow={1} />}
          {!narrow && <Text color={t.ui.dim}>Docs:</Text>}
          {!narrow && <Text color={t.ui.selected}>https://saketh-kowtha.github.io/lgh</Text>}
        </Box>
      </Box>
    </Box>
  )
}

// ─── PR summary panel (right side) ───────────────────────────────────────────

// ─── Pane header ──────────────────────────────────────────────────────────────

export function PaneHeader({ pane, count, loading, error, isStale }) {
  const { t } = useTheme()
  return (
    <Box paddingX={1} paddingY={0} gap={1}
         borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}
         borderColor={t.ui.divider}>
      <Text color={t.ui.selected} bold>{PANE_ICONS[pane] || '✦'}  {PANE_LABELS[pane] || pane}</Text>
      {count != null && !loading && <Text color={t.ui.dim}>{count}</Text>}
      {isStale && <Text color={t.ui.muted}>⟳ refreshing</Text>}
      {loading && <Text color={t.ui.muted}>loading…</Text>}
      {error   && <Text color={t.ci.fail}>⚠  {error?.message || 'fetch error'} · r retry</Text>}
    </Box>
  )
}
