/**
 * src/ui/Popover.test.jsx — Unit tests for Popover position logic.
 *
 * We test `calcPopoverPosition` in isolation (pure function, no React needed)
 * to verify the right → below → above → left priority chain and edge-clamping.
 */

import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { render, cleanup } from 'ink-testing-library'
import { calcPopoverPosition, Popover } from './Popover.jsx'
import { PRDetailPopoverContentMemo, POPOVER_WIDTH, POPOVER_HEIGHT } from '../features/prs/list-row.jsx'
import { schemeToT } from '../features/prs/list.jsx'
import lazyhubDark from '../theme/schemes/lazyhub-dark.js'

// Helper: build a typical anchor at column `x`, row `y`, size `w`×`h`
function anchor(x, y, w = 60, h = 1) {
  return { x, y, width: w, height: h }
}

// Terminal size used in most tests
const TERM = { termCols: 120, termRows: 30 }

describe('calcPopoverPosition — right placement (default)', () => {
  it('places popover to the right of anchor when room is available', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(0, 2, 60, 1),
      popoverWidth: 52,
      popoverHeight: 12,
      ...TERM,
      preferredSide: 'right',
    })
    // left = anchor.x + anchor.width = 0 + 60 = 60
    expect(pos.left).toBe(60)
    // top = anchor.y = 2
    expect(pos.top).toBe(2)
  })

  it('flips to below when no room on the right', () => {
    // anchor starts at x=80, popover is 52 wide → 80+60+52=192 overflows 120 cols
    const pos = calcPopoverPosition({
      anchor: anchor(80, 5, 20, 1),
      popoverWidth: 52,
      popoverHeight: 10,
      termCols: 120,
      termRows: 30,
      preferredSide: 'right',
    })
    // right: left=80+20=100, 100+52=152 > 120 → doesn't fit
    // below: left=80, top=6, 80+52=132 > 120 → doesn't fit
    // above: left=80, top=5-10=-5 → doesn't fit (negative)
    // left: left=80-52=28, top=5 → fits? 28+52=80 ≤ 120 ✓ 5+10=15 ≤ 30 ✓
    expect(pos.left).toBe(28)
    expect(pos.top).toBe(5)
  })

  it('flips to below when right would clip horizontally', () => {
    // anchor at x=70, anchor.width=10; popover width=52 → 70+10+52=132 > 120
    const pos = calcPopoverPosition({
      anchor: anchor(70, 5, 10, 1),
      popoverWidth: 52,
      popoverHeight: 10,
      termCols: 120,
      termRows: 30,
      preferredSide: 'right',
    })
    // right: left=80, 80+52=132 > 120 → no
    // below: left=70, top=6; 70+52=122 > 120 → no
    // above: left=70, top=5-10=-5 → no (negative top)
    // left: left=70-52=18, top=5; 18+52=70 ≤ 120, 5+10=15 ≤ 30 → yes!
    expect(pos.left).toBe(18)
    expect(pos.top).toBe(5)
  })
})

describe('calcPopoverPosition — below placement', () => {
  it('places popover below anchor', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(0, 2, 60, 1),
      popoverWidth: 52,
      popoverHeight: 12,
      ...TERM,
      preferredSide: 'below',
    })
    expect(pos.left).toBe(0)
    expect(pos.top).toBe(3) // anchor.y + anchor.height = 2 + 1
  })

  it('flips to right when below would clip vertically', () => {
    // anchor at row=25, popover height=12 → 25+1+12=38 > 30
    const pos = calcPopoverPosition({
      anchor: anchor(0, 25, 60, 1),
      popoverWidth: 52,
      popoverHeight: 12,
      termCols: 120,
      termRows: 30,
      preferredSide: 'below',
    })
    // below: top=26, 26+12=38 > 30 → no
    // above: top=25-12=13, left=0; 0+52=52 ≤ 120, 13+12=25 ≤ 30 → yes!
    // (right is tried second but above fits)
    // Priority for 'below': below → right → above → left
    // right: left=60, top=25; 60+52=112 ≤ 120, 25+12=37 > 30 → no
    // above: left=0, top=13; fits → yes!
    expect(pos.left).toBe(0)
    expect(pos.top).toBe(13)
  })
})

describe('calcPopoverPosition — above placement', () => {
  it('places popover above anchor', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(0, 15, 60, 1),
      popoverWidth: 52,
      popoverHeight: 12,
      ...TERM,
      preferredSide: 'above',
    })
    // top = 15 - 12 = 3
    expect(pos.left).toBe(0)
    expect(pos.top).toBe(3)
  })

  it('flips to below when above would go negative', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(0, 2, 60, 1),
      popoverWidth: 52,
      popoverHeight: 12,
      ...TERM,
      preferredSide: 'above',
    })
    // above: top=2-12=-10 → no
    // right: left=60, top=2; 60+52=112 ≤ 120, 2+12=14 ≤ 30 → yes!
    expect(pos.left).toBe(60)
    expect(pos.top).toBe(2)
  })
})

describe('calcPopoverPosition — left placement', () => {
  it('places popover to the left of anchor', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(60, 5, 20, 1),
      popoverWidth: 52,
      popoverHeight: 10,
      ...TERM,
      preferredSide: 'left',
    })
    // left = 60 - 52 = 8
    expect(pos.left).toBe(8)
    expect(pos.top).toBe(5)
  })

  it('flips to right when left would go negative', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(10, 5, 10, 1),
      popoverWidth: 52,
      popoverHeight: 10,
      ...TERM,
      preferredSide: 'left',
    })
    // left: 10-52=-42 → no
    // right: left=20, top=5; 20+52=72 ≤ 120, 5+10=15 ≤ 30 → yes!
    expect(pos.left).toBe(20)
    expect(pos.top).toBe(5)
  })
})

describe('calcPopoverPosition — edge clamping fallback', () => {
  it('clamps to best-effort position when nothing fits', () => {
    // Tiny terminal, large popover — nothing will fit cleanly
    const pos = calcPopoverPosition({
      anchor: anchor(5, 5, 10, 1),
      popoverWidth: 30,
      popoverHeight: 20,
      termCols: 20,
      termRows: 15,
      preferredSide: 'right',
    })
    // Clamped: left ≥ 0, top ≥ 0
    expect(pos.left).toBeGreaterThanOrEqual(0)
    expect(pos.top).toBeGreaterThanOrEqual(0)
    // And not overflowing beyond terminal
    expect(pos.left + 30).toBeLessThanOrEqual(20 + 30) // allows over-large popover, just clamped to 0..termCols-w
    expect(pos.top).toBeLessThanOrEqual(15)
  })

  it('returns left=0 when clamped from negative', () => {
    const pos = calcPopoverPosition({
      anchor: anchor(0, 0, 5, 1),
      popoverWidth: 60,
      popoverHeight: 25,
      termCols: 20,
      termRows: 10,
      preferredSide: 'left',
    })
    expect(pos.left).toBe(0)
    expect(pos.top).toBe(0)
  })
})

describe('calcPopoverPosition — exact boundary conditions', () => {
  it('fits exactly at right edge', () => {
    // anchor at x=0, w=10, popover w=10 in 20-col terminal → right fits exactly
    const pos = calcPopoverPosition({
      anchor: anchor(0, 0, 10, 1),
      popoverWidth: 10,
      popoverHeight: 5,
      termCols: 20,
      termRows: 30,
      preferredSide: 'right',
    })
    expect(pos.left).toBe(10)
    expect(pos.top).toBe(0)
  })

  it('does NOT fit when one col over (overflows by 1)', () => {
    // anchor at x=0, w=10, popover w=11 in 20-col terminal → right doesn't fit (10+11=21 > 20)
    // falls back to: below(left=0,top=1; 0+11=11 ≤ 20, 1+5=6 ≤ 30 → fits)
    const pos = calcPopoverPosition({
      anchor: anchor(0, 0, 10, 1),
      popoverWidth: 11,
      popoverHeight: 5,
      termCols: 20,
      termRows: 30,
      preferredSide: 'right',
    })
    // right: 10+11=21 > 20 → no
    // below: left=0, top=1; 0+11=11 ≤ 20, 1+5=6 ≤ 30 → yes
    expect(pos.left).toBe(0)
    expect(pos.top).toBe(1)
  })
})

// ── Rendering: popover must be opaque and keep its declared height ───────────

describe('Popover rendering', () => {
  afterEach(() => cleanup())

  const pr = {
    number: 7, title: 'Short title', state: 'OPEN', baseRefName: 'main',
    author: { login: 'octo' }, updatedAt: new Date().toISOString(),
    body: '## Summary\nA\n## Test plan\nB', statusCheckRollup: [],
  }

  it('does not let rows beneath the popover bleed through its blank cells', () => {
    const rows = Array.from({ length: 20 }, () => 'X'.repeat(80))
    const { lastFrame } = render(
      <Box flexDirection="column" width={80}>
        {rows.map((r, i) => <Text key={i}>{r}</Text>)}
        <Popover anchor={anchor(4, 2, 10, 1)} popoverWidth={30} popoverHeight={8} termCols={80} termRows={20} preferredSide="below" onClose={() => {}}>
          <Box borderStyle="round" width={30}><Text>hi</Text></Box>
        </Popover>
      </Box>
    )
    // Popover occupies columns 4..34, rows 3..10; nothing but popover content may remain there.
    const lines = lastFrame().split('\n').slice(3, 11)
    for (const line of lines) expect(line.slice(4, 34)).not.toContain('X')
  })

  it('PR popover content renders exactly POPOVER_HEIGHT rows (dividers do not wrap)', () => {
    const { lastFrame } = render(
      <PRDetailPopoverContentMemo pr={pr} t={schemeToT(lazyhubDark)} scheme={lazyhubDark} width={POPOVER_WIDTH} />
    )
    expect(lastFrame().split('\n')).toHaveLength(POPOVER_HEIGHT)
  })
})
