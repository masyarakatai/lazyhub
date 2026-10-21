import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { renderWithProviders } from '../test/test-helpers.jsx'
import { Sidebar } from './Sidebar.jsx'

afterEach(cleanup)

const PANES = ['focus', 'prs', 'issues', 'branches', 'actions', 'notifications']
const LABELS = { focus: 'Focus', prs: 'Pull Requests', issues: 'Issues', branches: 'Branches', actions: 'Actions', notifications: 'Notifications' }
const ICONS = { focus: '▣', prs: '⎇', issues: '⚑', branches: '⌥', actions: '↯', notifications: '✦' }

function navLines(width, paneCounts = {}) {
  const { lastFrame } = renderWithProviders(
    <Sidebar currentPane="focus" visiblePanes={PANES} paneLabels={LABELS} paneIcons={ICONS}
      repo="acme/rocket" width={width} height={14} paneCounts={paneCounts} />,
  )
  return lastFrame().split('\n')
}

describe('Sidebar label fit', () => {
  for (const width of [18, 20, 24]) {
    it(`never lets a label touch the pane number at width ${width}`, () => {
      const lines = navLines(width, { notifications: 12, prs: 3 })
      for (const [prefix, num] of [['Pull', 2], ['Not', 6]]) {
        const line = lines.find(l => l.includes(prefix))
        expect(line, `row starting ${prefix}`).toBeDefined()
        // strip the right border, then the number must be preceded by whitespace
        const body = line.replace(/[│┃]\s*$/, '').trimEnd()
        expect(body).toMatch(new RegExp(`\\s${num}$`))
      }
    })
  }

  it('marks a cut label with an ellipsis at the narrow standard width', () => {
    const lines = navLines(18, {})
    expect(lines.some(l => l.includes('Pull') && l.includes('…'))).toBe(true)
    expect(lines.some(l => l.includes('Not') && l.includes('…'))).toBe(true)
  })
})

describe('Sidebar width under a wide sibling', () => {
  it('keeps its configured width (does not flex-shrink) beside a wide pane', () => {
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <Sidebar currentPane="focus" visiblePanes={PANES} paneLabels={LABELS} paneIcons={ICONS}
          repo="acme/rocket" width={18} height={14} />
        <Box width={80}><Text>{'w'.repeat(80)}</Text></Box>
      </Box>,
    )
    const line = lastFrame().split('\n').find(l => l.includes('Pull'))
    expect(line).toContain('Pull Req…')
  })
})
