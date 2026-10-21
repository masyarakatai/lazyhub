import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const FAKE_PAT = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'
const FAKE_BEARER = 'FAKEBEARERVALUE12345'
const FAKE_BODY = 'FAKE-COMMENT-BODY-do-not-leak'
const FAKE_REPO = 'fake-owner/fake-private-repo'

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('./executor.js')
})

async function loadWithHistory(history, home) {
  vi.resetModules()
  if (home) process.env.HOME = home
  vi.doMock('./executor.js', () => ({ getGhCallHistory: () => history }))
  return import('./debug-state.js')
}

describe('collectDebugState', () => {
  it('captures app shape and redacts secret-shaped values', async () => {
    const { collectDebugState } = await loadWithHistory([])
    const state = collectDebugState({
      activePane: 'prs',
      view: 'list',
      itemNumber: 42,
      filters: { state: 'open' },
      cursors: { selectedIndex: 2 },
      dialog: 'merge',
      mode: 'NORMAL',
      recentStatus: [{ message: 'wrote ghp_abcdefghijklmnopqrstuvwxyz1234567890', variant: 'info' }],
      authToken: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    })

    expect(state.app).toMatchObject({
      activePane: 'prs',
      view: 'list',
      itemNumber: 42,
      filters: { state: 'open' },
      cursors: { selectedIndex: 2 },
      dialog: 'merge',
    })
    const json = JSON.stringify(state)
    expect(json).not.toMatch(/ghp_[A-Za-z0-9_]+/)
    expect(json).not.toMatch(/authToken/)
  })

  it('strips tokens, auth headers, comment bodies, urls and repo identifiers from state and gh call history', async () => {
    const { collectDebugState } = await loadWithHistory([
      {
        args: ['api', `repos/${FAKE_REPO}/pulls/7/comments`, '-f', `body=${FAKE_BODY}`, '-H', `Authorization: Bearer ${FAKE_BEARER}`, '--repo', FAKE_REPO],
        durationMs: 12,
        exitCode: 1,
        error: `HTTP 403 for https://api.github.com/repos/${FAKE_REPO} token ${FAKE_PAT}`,
      },
      { args: ['pr', 'view', '7', '--json', 'title,body', '--jq', FAKE_BODY], durationMs: 3, exitCode: 0 },
    ])
    const state = collectDebugState({
      activePane: 'prs',
      repo: FAKE_REPO,
      filters: { repository: FAKE_REPO, state: 'open' },
      comment: { body: FAKE_BODY },
      reviewBody: FAKE_BODY,
      recentStatus: [{ message: `Authorization: Bearer ${FAKE_BEARER} see https://github.com/${FAKE_REPO}/pull/7`, variant: 'error' }],
    })
    const json = JSON.stringify(state)
    for (const secret of [FAKE_PAT, FAKE_BEARER, FAKE_BODY, FAKE_REPO, 'fake-private-repo', 'github.com']) {
      expect(json).not.toContain(secret)
    }
    expect(state.ghCalls[0].args.slice(0, 2)).toEqual(['api', 'repos/[repo]/pulls/[id]/comments'])
    expect(state.ghCalls[1]).toMatchObject({ args: ['pr', 'view', '7', '--json', '[redacted]', '--jq', '[redacted]'], exitCode: 0 })
  })
})

describe.skipIf(process.platform === 'win32')('writeDebugState', () => {
  it('writes the export 0600 in a 0700 dir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lh-dbg-'))
    const prev = process.env.HOME
    try {
      const { writeDebugState } = await loadWithHistory([], home)
      const { path } = writeDebugState({ activePane: 'prs', authToken: FAKE_PAT })
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      expect(lstatSync(join(path, '..')).mode & 0o777).toBe(0o700)
      expect(readFileSync(path, 'utf8')).not.toContain(FAKE_PAT)
    } finally {
      process.env.HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})
