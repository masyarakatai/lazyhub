import React, { memo } from 'react'
import { Box, Text } from 'ink'
import { sanitize, shortAge, authorColor, truncateToWidth, padEndWidth, padStartWidth } from '../../utils.js'

// ─── Theme adapter ────────────────────────────────────────────────────────────
// Maps the new token scheme (src/theme/index.js) to the legacy `t.*` shape
// consumed by every sub-component in this file.  All token values are 1:1
// with the lazyhub-dark scheme values that existed before this migration.
//
// Token map:
//   t.ui.muted    → scheme.fg.muted      (#768390 muted secondary text)
//   t.ui.dim      → scheme.fg.subtle     (#545d68 tertiary/separator text)
//   t.ui.selected → scheme.accent.primary (#539bf5 focused row / active)
//   t.pr.*        → scheme.pr.*          (open/draft/merged/closed indicators)
//   t.ci.*        → scheme.ci.*          (pass/fail/pending/skipped)
//   t.review.*    → mapped to ci.pass/ci.fail (same semantic)
//   t.pr.conflict → scheme.ci.pending    (amber; identical value in old theme)
/**
 * Maps a new-style token scheme object (src/theme/index.js) to the legacy
 * `t.*` shape consumed by PR list sub-components.
 *
 * @param {object} scheme - Active scheme from useTheme().scheme
 * @returns {{ ui: object, pr: object, ci: object, review: object }}
 */
export function schemeToT(scheme) {
  return {
    ui: {
      muted:    scheme.fg.muted,
      dim:      scheme.fg.subtle,
      selected: scheme.accent.primary,
    },
    pr: {
      open:     scheme.pr.open,
      draft:    scheme.pr.draft,
      merged:   scheme.pr.merged,
      closed:   scheme.pr.closed,
      // conflict had no token; old theme used ci.pending amber — keep that.
      conflict: scheme.ci.pending,
    },
    ci: {
      pass:    scheme.ci.pass,
      fail:    scheme.ci.fail,
      pending: scheme.ci.pending,
      skipped: scheme.ci.skipped,
    },
    review: {
      approved: scheme.ci.pass,
      changes:  scheme.ci.fail,
    },
  }
}

// ─── Age colour ───────────────────────────────────────────────────────────────

function ageColor(updatedAt, t) {
  if (!updatedAt) return t.ui.dim
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000
  if (days < 0.167) return t.ci.pass   // < 4h — fresh, green
  if (days < 3)     return undefined    // 4h–3d — recent, default
  if (days < 7)     return t.ci.pending // 3–7d — aging, yellow
  if (days < 21)    return t.ci.fail    // 7–21d — stale, red
  return t.ui.dim                        // > 21d — frozen, dim
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function PRStateBadge({ pr, t }) {
  const conflicting = pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING'
  if (pr.isDraft)   return <Text color={t.pr.draft}>◐</Text>
  if (conflicting)  return <Text color={t.pr.conflict || t.ci.pending}>▲</Text>
  switch (pr.state) {
    case 'OPEN':
      if (pr.autoMergeRequest) return <Text color={t.pr.merged}>⟳</Text>
      return <Text color={t.pr.open}>●</Text>
    case 'MERGED': return <Text color={t.pr.merged}>●</Text>
    case 'CLOSED': return <Text color={t.pr.closed}>●</Text>
    default:       return <Text color={t.ui.muted}>●</Text>
  }
}

function CIBadge({ pr, t }) {
  const checks = pr.statusCheckRollup
  if (!checks || checks.length === 0) return null
  const total   = checks.length
  const states  = checks.map(c => c.state || c.conclusion || c.status || '')
  const failing = states.filter(s => /failure|error/i.test(s)).length
  const pending = states.filter(s => /pending|in_progress|queued/i.test(s)).length
  if (failing > 0) return <Text color={t.ci.fail}> ✗ {failing}/{total}</Text>
  if (pending > 0) return <Text color={t.ci.pending}> ● {pending}/{total}</Text>
  return <Text color={t.ci.pass}> ✓</Text>
}

function ReviewBadge({ pr, t }) {
  const rd = pr.reviewDecision
  if (!rd || rd === 'REVIEW_REQUIRED') return <Text> </Text>
  if (rd === 'APPROVED')          return <Text color={t.review?.approved || t.ci.pass}> ✓</Text>
  if (rd === 'CHANGES_REQUESTED') return <Text color={t.review?.changes  || t.ci.fail}> ✗</Text>
  return <Text> </Text>
}

// Fixed columns: paddingX(2) + cursor(1) + badge(2) + num(7) + review(2) + CI_max(8) + author(13) + age(5) = 40; +4 buffer
export const PR_ROW_FIXED_COLS = 44

// ─── Expanded detail shown below selected PR ─────────────────────────────────

function PRExpandedDetail({ pr, t }) {
  const checks   = pr.statusCheckRollup || []
  const labels   = (pr.labels || []).slice(0, 5)
  const reviewers = (pr.reviewRequests || []).slice(0, 4)
  const bodyLine = (pr.body || '').trim().split('\n').find(l => l.trim()) || ''

  const failing = checks.filter(c => /failure|error/i.test(c.state || c.conclusion || '')).length
  const pending = checks.filter(c => /pending|in_progress|queued/i.test(c.state || c.conclusion || c.status || '')).length
  const passing = checks.length - failing - pending
  const ciColor = failing ? t.ci.fail : pending ? t.ci.pending : checks.length ? t.ci.pass : t.ui.dim
  const ciParts = []
  if (passing) ciParts.push(`✓ ${passing}`)
  if (pending) ciParts.push(`● ${pending}`)
  if (failing) ciParts.push(`✗ ${failing}`)
  if (checks.length) ciParts.push(`/ ${checks.length}`)

  const branch = [pr.headRefName, pr.baseRefName].filter(Boolean).join(' → ')

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {branch ? (
        <Text color={t.ui.muted} wrap="truncate">⌥  {branch}</Text>
      ) : null}
      {checks.length > 0 && (
        <Text color={ciColor} wrap="truncate">   {ciParts.join('  ')}</Text>
      )}
      {labels.length > 0 && (
        <Text color={t.ui.dim} wrap="truncate">
          {'◆  ' + labels.map(l => l.name).join('  ·  ')}
        </Text>
      )}
      {reviewers.length > 0 && (
        <Text color={t.ui.dim} wrap="truncate">
          {'◇  ' + reviewers.map(r => '@' + (r.login || r.name || '')).join('  ')}
        </Text>
      )}
      {bodyLine ? (
        <Text color={t.ui.dim} dimColor italic wrap="truncate">
          {"   " + sanitize(bodyLine).slice(0, 120)}
        </Text>
      ) : null}
    </Box>
  )
}

export const PRRow = memo(({ pr, isSelected, t, titleWidth, expanded }) => {
  // Use display-width-aware helpers so CJK/emoji authors don't break borders
  const rawLogin    = String(pr.author?.login || '')
  const authorLogin = padEndWidth(truncateToWidth(rawLogin, 11), 11)
  const authorClr   = authorColor(pr.author?.login)
  const ageStr      = padStartWidth(shortAge(pr.updatedAt), 4)
  const timeColor   = ageColor(pr.updatedAt, t)
  const tw          = Math.max(8, titleWidth || 20)

  return (
    <Box flexDirection="column">
      <Box paddingX={1} height={1}>
        <Text color={isSelected ? t.ui.selected : t.ui.dim}>{isSelected ? '▎' : ' '}</Text>
        <PRStateBadge pr={pr} t={t} />
        <Text color={t.ui.dim}> {'#' + String(pr.number).padEnd(5)}</Text>
        <Box width={tw} overflow="hidden">
          <Text
            color={isSelected ? t.ui.selected : undefined}
            bold={isSelected}
            italic={pr.isDraft}
            wrap="truncate"
          >
            {sanitize(pr.title)}
          </Text>
        </Box>
        <CIBadge pr={pr} t={t} />
        <ReviewBadge pr={pr} t={t} />
        <Text color={authorClr || t.ui.muted}> @{authorLogin}</Text>
        <Text color={timeColor}> {ageStr}</Text>
      </Box>
      {expanded && <PRExpandedDetail pr={pr} t={t} />}
    </Box>
  )
})

export const MERGE_OPTIONS = [
  { value: 'merge',  label: '--merge',  description: 'Create a merge commit' },
  { value: 'squash', label: '--squash', description: 'Squash all commits into one' },
  { value: 'rebase', label: '--rebase', description: 'Rebase onto base branch' },
]

export function canToggleAutoMergeFromList(pr) {
  return pr?.state === 'OPEN' && !pr?.isDraft
}

// ─── PR detail popover content ────────────────────────────────────────────────

/** Default popover width in columns; clamped to terminal width at runtime. */
export const POPOVER_WIDTH = 52
/** Height in rows: title(1) + meta(1) + divider(1) + body(6) + divider(1) + summary(1) + divider(1) + hint(1) + border(2) = 15 */
export const POPOVER_HEIGHT = 15

/**
 * Popover content component: shows PR title, meta, body excerpt, CI summary,
 * unresolved thread count, and action hints.
 *
 * @param {object} props
 * @param {object} props.pr  - PR object from the list (includes body, statusCheckRollup, etc.)
 * @param {object} props.t   - Theme adapter object (schemeToT output).
 * @param {object} props.scheme - Raw theme scheme from useTheme().
 * @param {number} props.width  - Effective popover inner width (box width - 2 for borders).
 */
function PRDetailPopoverContent({ pr, t, scheme, width }) {
  const innerW = Math.max(10, width - 2)  // subtract left+right border

  // ── Meta line: state · @author → base · age
  const stateLabel = pr.isDraft ? 'draft' : (pr.state || '').toLowerCase()
  const stateColor = pr.isDraft ? t.pr.draft
    : pr.state === 'OPEN'   ? t.pr.open
    : pr.state === 'MERGED' ? t.pr.merged
    : t.pr.closed
  const author     = pr.author?.login || ''
  const base       = pr.baseRefName || 'main'
  const age        = shortAge(pr.updatedAt)

  // ── Body excerpt: first ~6 non-empty lines, truncated
  const bodyLines = (pr.body || '')
    .split('\n')
    .map(l => sanitize(l.trimEnd()))
    .filter(l => l.length > 0)
    .slice(0, 6)
  while (bodyLines.length < 6) bodyLines.push('')

  // ── CI summary
  const checks   = pr.statusCheckRollup || []
  const failing  = checks.filter(c => /failure|error/i.test(c.state || c.conclusion || '')).length
  const pending  = checks.filter(c => /pending|in_progress|queued/i.test(c.state || c.conclusion || c.status || '')).length
  const ciColor  = failing ? t.ci.fail : pending ? t.ci.pending : checks.length ? t.ci.pass : t.ui.dim
  const ciLabel  = checks.length === 0 ? 'no checks'
    : failing ? `✗ ${failing} failing`
    : pending ? `● ${pending} pending`
    : `✓ ci-pass`

  // ── Unresolved threads (reviewThreads not in list payload; default 0)
  const unresolvedCount = 0

  const borderColor  = scheme.border.focused

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      width={width}
    >
      {/* Title */}
      <Box paddingX={1}>
        <Text color={scheme.fg.default} bold wrap="truncate">
          {'#' + pr.number + ' ' + sanitize(pr.title || '')}
        </Text>
      </Box>
      {/* Meta */}
      <Box paddingX={1}>
        <Text color={stateColor}>{stateLabel}</Text>
        <Text color={t.ui.dim}> · </Text>
        <Text color={t.ui.muted}>@{truncateToWidth(author, 12)}</Text>
        <Text color={t.ui.dim}> → </Text>
        <Text color={t.ui.muted}>{truncateToWidth(base, 16)}</Text>
        <Text color={t.ui.dim}> · </Text>
        <Text color={t.ui.dim}>{age}</Text>
      </Box>
      {/* Divider */}
      <Box><Text color={t.ui.dim}>{'─'.repeat(innerW)}</Text></Box>
      {/* Body excerpt */}
      {bodyLines.map((line, idx) => (
        <Box key={idx} paddingX={1}>
          <Text color={scheme.fg.default} wrap="truncate">
            {line || ' '}
          </Text>
        </Box>
      ))}
      {/* Divider */}
      <Box><Text color={t.ui.dim}>{'─'.repeat(innerW)}</Text></Box>
      {/* Summary */}
      <Box paddingX={1}>
        <Text color={ciColor}>{ciLabel}</Text>
        <Text color={t.ui.dim}> · </Text>
        <Text color={unresolvedCount > 0 ? t.ci.pending : t.ui.dim}>
          {unresolvedCount} unresolved
        </Text>
      </Box>
      {/* Divider */}
      <Box><Text color={t.ui.dim}>{'─'.repeat(innerW)}</Text></Box>
      {/* Hint bar */}
      <Box paddingX={1}>
        <Text color={t.ui.dim} wrap="truncate">
          {truncateToWidth('↩ open · a approve · m merge · [p] close', innerW)}
        </Text>
      </Box>
    </Box>
  )
}

// Prevent rerenders when other rows change focus (only rerender on PR data change)
export const PRDetailPopoverContentMemo = memo(PRDetailPopoverContent)

// ─── PRList ───────────────────────────────────────────────────────────────────
