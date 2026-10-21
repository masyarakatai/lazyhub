/**
 * Onboarding.jsx — zero-configuration watch-only first run (#70, mockup variant A:
 * docs/mockups/onboarding-first-run-a-stepper.md).
 *
 * Two steps (repository, report) in one bordered panel. Read-only end to end:
 * it uses the user's existing gh login, never logs in, installs, creates or
 * writes anything. Quitting at any point leaves nothing behind.
 */

import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { ThemeProvider, useTheme, readRawThemeCfg } from '../../theme.js'
import { FooterKeys } from '../../components/FooterKeys.jsx'
import { Spinner } from '../../components/Spinner.jsx'
import { sanitize } from '../../utils.js'
import { detectHostFromRemote } from '../../bootstrap.js'
import { classifyFailure, explainGap, loadOnboardingReport, loadSession } from './flow.js'

const ERROR_COPY = {
  no_gh: ['GitHub CLI (gh) was not found.', 'Install it from https://cli.github.com, run `gh auth login`, then start lazyhub again.'],
  auth: ['Not signed in to GitHub through gh.', 'Run `gh auth login` (add `--hostname <host>` for Enterprise), then start lazyhub again. lazyhub did not log in for you.'],
  rate_limit: ['GitHub API rate limit reached.', 'Nothing was lost. Wait for the limit to reset, then retry.'],
  permission: ['Your gh login cannot read what lazyhub needs.', 'Check the account and token scopes with `gh auth status`, then retry.'],
  error: ['GitHub could not be reached.', 'Check your network and `gh auth status`, then retry.'],
}

const SLICE2_NOTE = [
  'Enforcement (coming, not available yet; #245): optional approval-only setup, a separate step.',
  'Expect solo/pilot limits: you approve your own agents\' merges, on repos you administer.',
]

/**
 * One truncated text row.
 *
 * @param {{children?: any, color?: string, bold?: boolean}} props
 * @returns {React.ReactElement}
 */
function Line({ children, color, bold = false }) {
  const { t } = useTheme()
  return <Text color={color ?? t.ui.muted} bold={bold} wrap="truncate-end">{children}</Text>
}

function coverageColor(t, coverage) {
  return coverage === 'advisory' ? t.ci.pending : t.ci.fail
}

function Report({ data }) {
  const { t } = useTheme()
  const { coverage, activity } = data
  const gaps = [...new Set(coverage.observation.gap_codes)]
  const explained = gaps.map(explainGap).filter(Boolean)
  const a = activity?.by_attribution
  return (
    <Box flexDirection="column">
      <Line>
        {activity
          ? `Observed ${activity.pull_requests} PR(s) in ${activity.pages} page(s). Nothing was enforced, installed or written.`
          : 'Activity could not be read. Nothing was enforced, installed or written.'}
      </Line>
      <Line>{`identity: ${coverage.identity.status}${coverage.identity.reason ? ` (${sanitize(coverage.identity.reason)})` : ''} · rulesets: ${coverage.rulesets.status}${coverage.rulesets.count === null ? '' : ` (${coverage.rulesets.count})`}`}</Line>
      <Line bold>{`Coverage (${coverage.coverage_states.join(' | ')})`}</Line>
      {coverage.operations.map(op => (
        <Box key={op.operation}><Text wrap="truncate-end">
          <Text color={t.ui.muted}>{`  ${op.operation.padEnd(28)} `}</Text>
          <Text color={coverageColor(t, op.coverage)}>{op.coverage}</Text>
          <Text color={t.ui.dim}>{op.downgrade_reasons.length ? ` [downgraded: ${op.downgrade_reasons.map(sanitize).join(', ')}]` : ''}</Text>
        </Text></Box>
      ))}
      {gaps.length > 0 && <Line color={t.ci.pending}>{`Gaps: ${gaps.join(', ')}${explained.length ? ` - ${explained[0]}` : ''}`}</Line>}
      {a && <Line>{`Activity: agent ${a.agent} · automation ${a.automation} · human ${a.human} · shared ${a.shared} · unknown ${a.unknown}`}</Line>}
      {a && a.unknown > 0 && <Line color={t.ci.pending}>{`  ${a.unknown} unattributed event(s): unknown is not safe, and counts as ungoverned.`}</Line>}
      {SLICE2_NOTE.map(line => <Box key={line}><Line color={t.ui.dim}>{line}</Line></Box>)}
    </Box>
  )
}

export function Onboarding({ onDone, loadSessionFn = loadSession, loadReportFn = loadOnboardingReport }) {
  const { t } = useTheme()
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [phase, setPhase] = useState('session') // session | repos | report | error
  const [session, setSession] = useState(null)
  const [cursor, setCursor] = useState(0)
  const [repo, setRepo] = useState(null)
  const [data, setData] = useState(null)
  const [failure, setFailure] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const request = useRef(0)

  const finish = result => { onDone(result); exit() }

  useEffect(() => {
    const id = ++request.current
    setPhase('session')
    loadSessionFn()
      .then(s => { if (request.current === id) { setSession(s); setPhase('repos') } })
      .catch(err => { if (request.current === id) { setFailure(classifyFailure(err)); setPhase('error') } })
  }, [attempt, loadSessionFn])

  const observe = name => {
    const id = ++request.current
    setRepo(name)
    setData(null)
    setPhase('report')
    loadReportFn(name)
      .then(d => { if (request.current === id) setData(d) })
      .catch(err => { if (request.current === id) { setFailure(classifyFailure(err)); setPhase('error') } })
  }

  const repos = session?.repos ?? []
  useInput((input, key) => {
    if (input === 'q') return finish({ status: 'cancelled' })
    if (phase === 'error' && input === 'r') {
      if (repo) observe(repo)
      else setAttempt(n => n + 1)
    } else if (phase === 'repos') {
      if (input === 'j' || key.downArrow) setCursor(c => Math.max(0, Math.min(c + 1, repos.length - 1)))
      else if (input === 'k' || key.upArrow) setCursor(c => Math.max(c - 1, 0))
      else if (key.return && repos.length > 0) observe(repos[cursor].name)
    } else if (phase === 'report') {
      if (key.escape || input === 'b') { request.current += 1; setPhase('repos') }
      else if (key.return && data) finish({ status: 'completed', repo })
    }
  })

  const keys = {
    session: [{ key: 'q', label: 'quit (nothing is written)' }],
    repos: [{ key: 'j/k', label: 'move' }, { key: 'Enter', label: 'observe' }, { key: 'q', label: 'quit (nothing is written)' }],
    report: [{ key: 'Enter', label: 'open lazyhub' }, { key: 'Esc/b', label: 'change repo' }, { key: 'q', label: 'quit (nothing is written)' }],
    error: [{ key: 'r', label: 'retry' }, { key: 'q', label: 'quit (nothing is written)' }],
  }[phase]

  const active = phase === 'report' ? 2 : 1
  const step = n => <Text color={n === active ? t.ui.selected : t.ui.dim} bold={n === active}>{n === 1 ? '1 Repository' : '2 Report'}</Text>

  return (
    <Box flexDirection="column" width={Math.min(stdout?.columns || 80, 100)}>
      <Box flexDirection="column" borderStyle="round" borderColor={t.ui.border} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={t.ui.selected} wrap="truncate-end">{`lazyhub · first run${session?.login ? ` · ${sanitize(session.login)}` : ''}${phase === 'report' && repo ? ` · ${sanitize(repo)}` : ''}`}</Text>
          <Text color={t.ui.muted}>watch-only · read-only</Text>
        </Box>
        <Text>{step(1)}<Text color={t.ui.dim}> › </Text>{step(2)}</Text>
        {phase === 'session' && <Spinner label="Checking your gh login..." />}
        {phase === 'error' && (
          <Box flexDirection="column">
            <Text color={t.ci.fail} bold>{ERROR_COPY[failure][0]}</Text>
            <Text color={t.ui.muted}>{ERROR_COPY[failure][1]}</Text>
            <Text color={t.ui.dim}>lazyhub changed nothing on GitHub or on this machine.</Text>
          </Box>
        )}
        {phase === 'repos' && (
          <Box flexDirection="column">
            <Line>lazyhub will only READ through your existing gh login. It installs nothing,</Line>
            <Line>creates no checks, changes no rulesets and writes nothing to GitHub.</Line>
            {session.listError && <Line color={t.ci.pending}>{`Repository list unavailable (${session.listError}); showing the current directory's repository only.`}</Line>}
            <Line bold>Pick a repository to observe:</Line>
            {repos.slice(0, 12).map((r, i) => (
              <Box key={r.name}>
                <Text color={i === cursor ? t.ui.selected : t.ui.muted} bold={i === cursor} wrap="truncate-end">
                  {`${i === cursor ? '▶' : ' '} ${sanitize(r.name)}${r.current ? '  (current directory)' : ''}`}
                </Text>
              </Box>
            ))}
            {repos.length === 0 && <Line color={t.ui.dim}>No repositories found for this account.</Line>}
          </Box>
        )}
        {phase === 'report' && (data ? <Report data={data} /> : <Spinner label={`Reading ${sanitize(repo)} (read-only)...`} />)}
      </Box>
      <FooterKeys keys={keys} />
    </Box>
  )
}

/**
 * Show the first-run flow before the main app starts.
 *
 * @returns {Promise<{status: 'completed', repo: string}|{status: 'cancelled'}>}
 */
export async function runOnboarding() {
  /** @type {{status: 'completed', repo: string}|{status: 'cancelled'}} */
  let result = { status: 'cancelled' }
  // Same Enterprise-host auto-detect as bootstrap (git remote only; no gh call).
  if (!process.env.GH_HOST) {
    const host = await detectHostFromRemote()
    if (host && host !== 'github.com') process.env.GH_HOST = host
  }
  process.stdout.write('\x1b[?1049h\x1b[H')
  try {
    const app = render(
      <ThemeProvider initialTheme={/** @type {any} */ (readRawThemeCfg())}>
        <Onboarding onDone={r => { result = r }} />
      </ThemeProvider>,
    )
    await app.waitUntilExit()
  } finally {
    process.stdout.write('\x1b[?1049l')
  }
  return result
}
