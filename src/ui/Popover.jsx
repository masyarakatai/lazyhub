/**
 * src/ui/Popover.jsx — Floating popover primitive for lazyhub.
 *
 * Renders children in an absolutely-positioned overlay that does NOT
 * cause layout shift in the parent flow.  The popover is taken out of
 * normal Flex flow via `position: 'absolute'`, so the PR list (or any
 * other host) keeps its dimensions intact.
 *
 * Position priority chain (DESIGN_REVAMP.md §12.1):
 *   right → below → above → left
 * Auto-flips when the preferred side doesn't have enough room.
 *
 * Usage:
 *   <Popover
 *     anchor={{ x: 0, y: 2, width: 60, height: 1 }}
 *     popoverWidth={52}
 *     popoverHeight={12}
 *     termCols={120}
 *     termRows={30}
 *     preferredSide="right"
 *     onClose={() => setOpen(false)}
 *   >
 *     <MyContent />
 *   </Popover>
 *
 * The outer <Box> is `position: 'absolute'` with marginLeft/marginTop
 * computed from the anchor.  It never contributes to parent flow.
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'

// ─── Position calculator (pure — testable without React) ──────────────────────

/**
 * Calculate the top-left corner `{left, top}` for the popover box given
 * constraints.  Implements the right → below → above → left priority chain
 * with automatic edge-flipping so the popover is never clipped.
 *
 * @param {object} opts
 * @param {{ x: number, y: number, width: number, height: number }} opts.anchor
 *   Anchor element's position and size in terminal columns/rows.
 * @param {number} opts.popoverWidth   Desired popover width in columns.
 * @param {number} opts.popoverHeight  Desired popover height in rows.
 * @param {number} opts.termCols       Terminal width in columns.
 * @param {number} opts.termRows       Terminal height in rows.
 * @param {'right'|'below'|'above'|'left'} [opts.preferredSide]
 *   Preferred placement side.  Defaults to 'right'.
 * @returns {{ left: number, top: number }}
 */
export function calcPopoverPosition({
  anchor,
  popoverWidth,
  popoverHeight,
  termCols,
  termRows,
  preferredSide = 'right',
}) {
  const { x, y, width: anchorW, height: anchorH } = anchor

  // Candidate positions for each side (un-clamped)
  const candidates = {
    right: {
      left: x + anchorW,
      top:  y,
    },
    below: {
      left: x,
      top:  y + anchorH,
    },
    above: {
      left: x,
      top:  y - popoverHeight,
    },
    left: {
      left: x - popoverWidth,
      top:  y,
    },
  }

  // Does a candidate fit without overflowing terminal bounds?
  const fits = (pos) =>
    pos.left >= 0 &&
    pos.top  >= 0 &&
    pos.left + popoverWidth  <= termCols &&
    pos.top  + popoverHeight <= termRows

  // Priority order starting from the preferred side
  const order = ['right', 'below', 'above', 'left']
  const sorted = [
    preferredSide,
    ...order.filter((s) => s !== preferredSide),
  ]

  for (const side of sorted) {
    const pos = candidates[side]
    if (fits(pos)) return { left: pos.left, top: pos.top }
  }

  // Nothing fits cleanly — clamp to best effort (prefer right/below)
  const fallback = candidates[preferredSide]
  return {
    left: Math.max(0, Math.min(fallback.left, termCols - popoverWidth)),
    top:  Math.max(0, Math.min(fallback.top,  termRows - popoverHeight)),
  }
}

// ─── Popover component ────────────────────────────────────────────────────────

/**
 * Floating overlay component rendered with `position: 'absolute'` so that
 * the surrounding layout is never reflowed when the popover opens or closes.
 *
 * ESC key calls `onClose`; focus returns to the host component automatically
 * because the popover does not steal focus from `useInput`.
 *
 * @param {object} props
 * @param {{ x: number, y: number, width: number, height: number }} props.anchor
 *   Anchor position/size (terminal columns/rows).
 * @param {number} props.popoverWidth    Target width for the popover box.
 * @param {number} props.popoverHeight   Target height for the popover box.
 * @param {number} props.termCols        Terminal width (from useStdout).
 * @param {number} props.termRows        Terminal height (from useStdout).
 * @param {React.ReactNode} props.children  Popover content.
 * @param {() => void} props.onClose     Called when ESC is pressed.
 * @param {'right'|'below'|'above'|'left'} [props.preferredSide]
 *   Preferred placement side.  Defaults to 'right'.
 */
export function Popover({
  anchor,
  popoverWidth,
  popoverHeight,
  termCols,
  termRows,
  children,
  onClose,
  preferredSide = 'right',
}) {
  const { left, top } = calcPopoverPosition({
    anchor,
    popoverWidth,
    popoverHeight,
    termCols,
    termRows,
    preferredSide,
  })

  // ESC closes the popover; note we use isActive:true so this fires even
  // while other useInput handlers are active in the host.
  useInput((_input, key) => {
    if (key.escape) {
      onClose()
    }
  })

  return (
    <Box
      position="absolute"
      marginLeft={left}
      marginTop={top}
      width={popoverWidth}
      height={popoverHeight}
      flexDirection="column"
      overflow="hidden"
    >
      {/* Ink only writes the cells a Text occupies, so without an opaque fill the
          host's rows show through every blank cell of the popover. */}
      <Box position="absolute">
        <Text>{Array(popoverHeight).fill(' '.repeat(popoverWidth)).join('\n')}</Text>
      </Box>
      {children}
    </Box>
  )
}
