import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { Box } from 'ink'
import { cleanup } from 'ink-testing-library'
import { renderWithProviders } from '../../test/test-helpers.jsx'
import { PRListView } from './list-view.jsx'
import { PRRow } from './list-row.jsx'
import { schemeToT } from './list.jsx'
import lazyhubDark from '../../theme/schemes/lazyhub-dark.js'

afterEach(cleanup)

const t = schemeToT(lazyhubDark)
const filler = 'x'.repeat(44)
const pr = (number, marker, login = 'maria-lopez') => ({
  number,
  title: `${filler}${marker}`,
  state: 'OPEN',
  updatedAt: new Date().toISOString(),
  author: { login },
  body: 'body',
})

function renderList(cols, items, cursor) {
  const { lastFrame } = renderWithProviders(
    <Box height={24} width={cols}><PRListView
      items={items} loading={false} error={null}
      filterStates={new Set(['open'])} scope="all" sortMode="newest" authorFilter={null}
      statusMsg={null} config={{ pageSize: 30 }}
      filterKeys={{ filterOpen: 'O', filterClosed: 'C', filterMerged: 'M' }}
      t={t} height={20} effectiveHeight={20}
      visiblePRs={items} scrollOffset={0} cursor={cursor}
      innerWidth={cols - 4} termCols={cols} termRows={40}
      selectedPR={items[cursor]} dialog={null}
      popoverDismissed={false} setPopoverDismissed={() => {}}
      expansionEnabled={false} scheme={lazyhubDark}
    /></Box>,
  )
  return lastFrame()
}

describe('PR list popover', () => {
  for (const cols of [80, 100]) {
    it(`leaves no orphan title fragments from rows it covers at ${cols} cols`, () => {
      const items = [
        pr(1, 'AAAAAA'), pr(2, 'SELECTED'), pr(3, 'BBBBBB'),
        pr(4, 'CCCCCC'), pr(5, 'DDDDDD'), pr(6, 'EEEEEE'),
      ]
      const frame = renderList(cols, items, 1)
      expect(frame).toContain('unresolved') // popover rendered
      for (const marker of ['BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE']) {
        expect(frame).not.toContain(marker)
      }
    })
  }
})

describe('PRRow author column', () => {
  const render = (login) => renderWithProviders(
    <PRRow pr={pr(7, 'T', login)} isSelected={false} t={t} titleWidth={20} expanded={false} />,
  ).lastFrame()

  it('drops the [bot] suffix instead of cutting it mid-bracket', () => {
    const frame = render('dev-agent[bot]')
    expect(frame).toContain('@dev-agent')
    expect(frame).not.toMatch(/\[b/)
    expect(render('dependabot[bot]')).not.toContain('dependabot[')
  })

  it('ends an over-long login with an ellipsis', () => {
    expect(render('a-very-long-login-name')).toContain('@a-very-lon…')
  })
})
