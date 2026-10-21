import React from 'react'
import { Text, useInput } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __sendInput } from 'ink'
import { App } from './app.jsx'
import { renderWithProviders, flush, cleanup, waitForExpectation } from './test/test-helpers.jsx'

const inputHandlers = vi.hoisted(() => new Set())
const exitSpy = vi.hoisted(() => vi.fn())

vi.mock('ink', async () => {
  const React = await import('react')
  const actual = await vi.importActual('ink')
  return {
    ...actual,
    useApp: () => ({ exit: exitSpy }),
    useInput: (handler) => {
      React.useEffect(() => {
        inputHandlers.add(handler)
        return () => inputHandlers.delete(handler)
      }, [handler])
    },
    __sendInput: (input, key = {}) => {
      for (const handler of [...inputHandlers]) handler(input, key)
    },
  }
})

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js')
  const base = actual.loadConfig()
  return {
    ...actual,
    loadConfig: () => ({
      ...base,
      panes: ['prs', 'issues', 'branches', 'actions', 'notifications'],
      defaultPane: 'prs',
    }),
  }
})

vi.mock('./hooks/useLayout.js', () => ({
  useLayout: () => ({
    cols: 120,
    rows: 30,
    sidebarWidth: 18,
    previewWidth: 40,
    borderStyle: 'round',
    compactFooter: false,
    showSidebar: false,
    showPreview: false,
    listHeight: 12,
  }),
}))

vi.mock('./ipc.js', () => ({
  emitIPC: () => {},
  startIPC: () => '/tmp/lazyhub.sock',
}))

vi.mock('./components/Sidebar.jsx', () => ({ Sidebar: () => <Text>SIDEBAR</Text> }))
vi.mock('./components/TabStrip.jsx', () => ({ TabStrip: () => <Text>TABS</Text> }))
vi.mock('./components/Toaster.jsx', () => ({ Toaster: () => null }))
vi.mock('./components/StatusBar.jsx', () => ({ StatusBar: ({ pane, mode }) => <Text>{`STATUS ${pane} ${mode}`}</Text> }))
vi.mock('./components/FooterKeys.jsx', () => ({ FooterKeys: () => null }))
vi.mock('./components/ErrorBoundary.jsx', () => ({ ErrorBoundary: ({ children }) => children }))
vi.mock('./components/AIAssistant.jsx', () => ({ AIAssistant: () => <Text>AI</Text> }))
vi.mock('./components/CommandPalette.jsx', () => ({ CommandPalette: () => <Text>PALETTE</Text> }))
vi.mock('./components/CustomPane.jsx', () => ({ CustomPane: () => <Text>CUSTOM</Text> }))
vi.mock('./features/tabs/view.jsx', () => ({ TabView: () => <Text>TAB VIEW</Text> }))
vi.mock('./features/issues/list.jsx', () => ({ IssueList: () => <Text>ISSUES LIST</Text> }))
vi.mock('./features/issues/detail.jsx', () => ({ IssueDetail: ({ issueNumber }) => <Text>{`ISSUE DETAIL ${issueNumber}`}</Text> }))
vi.mock('./features/branches/index.jsx', () => ({ BranchList: () => <Text>BRANCHES LIST</Text> }))
vi.mock('./features/actions/index.jsx', () => ({ ActionList: () => <Text>ACTIONS LIST</Text> }))
vi.mock('./features/settings/index.jsx', () => ({ SettingsPane: () => <Text>SETTINGS PANE</Text> }))
vi.mock('./features/logs/index.jsx', () => ({ LogPane: () => <Text>LOGS</Text> }))
vi.mock('./features/notifications/index.jsx', () => ({ NotificationList: () => <Text>NOTIFICATIONS LIST</Text> }))
vi.mock('./features/prs/comments.jsx', () => ({ PRComments: ({ prNumber }) => <Text>{`COMMENTS ${prNumber}`}</Text> }))
vi.mock('./features/prs/ConflictView.jsx', () => ({ ConflictView: ({ pr }) => <Text>{`CONFLICT ${pr.number}`}</Text> }))
vi.mock('./features/prs/list.jsx', () => ({
  PRList: ({ onSelectPR, onOpenDiff }) => {
    useInput((input) => {
      if (input === 'o') onSelectPR({ number: 7, title: 'Open detail' })
      if (input === 'd') onOpenDiff({ number: 9, title: 'Open diff' })
    })
    return <Text>PRS LIST</Text>
  },
}))
vi.mock('./features/prs/detail.jsx', () => ({
  PRDetail: ({ prNumber }) => <Text>{`PR DETAIL ${prNumber}`}</Text>,
}))
vi.mock('./features/prs/diff.jsx', () => ({
  PRDiff: ({ prNumber }) => <Text>{`PR DIFF ${prNumber}`}</Text>,
}))

function InputDriver({ events }) {
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      for (const event of events) {
        if (!alive) return
        __sendInput(event.input || '', event.key || {})
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })()
    return () => { alive = false }
  }, [events])

  return null
}

describe('App shell user flows', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens PR detail from the list', async () => {
    const view = renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: 'o' }]} />
      </>
    )

    await flush(20)
    expect(view.lastFrame()).toContain('PR DETAIL 7')
  })

  it('opens PR diff from the list', async () => {
    const view = renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: 'd' }]} />
      </>
    )

    await flush(20)
    expect(view.lastFrame()).toContain('PR DIFF 9')
  })

  it('opens the help overlay from the shell', async () => {
    const view = renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: '?' }]} />
      </>
    )

    await flush(20)
    expect(view.lastFrame()).toContain('Keyboard Reference')
  })

  it('Esc on a top-level list does not quit; q does', async () => {
    exitSpy.mockClear()
    renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: '', key: { escape: true } }]} />
      </>
    )
    await flush(20)
    expect(exitSpy).not.toHaveBeenCalled()
    cleanup()

    renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: 'q' }]} />
      </>
    )
    await flush(20)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('Esc still steps back from detail to the list', async () => {
    const view = renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: 'o' }]} />
      </>
    )
    // Wait for the detail view (and its re-registered input handler) before
    // sending Esc; a fixed timer between the two keys races on slow runners.
    await waitForExpectation(() => expect(view.lastFrame()).toContain('PR DETAIL 7'))
    await flush(30)
    __sendInput('', { escape: true })
    await waitForExpectation(() => expect(view.lastFrame()).toContain('PRS LIST'))
  })

  it('opens settings from the shell', async () => {
    const view = renderWithProviders(
      <>
        <App repo="owner/repo" />
        <InputDriver events={[{ input: 'S' }]} />
      </>
    )

    await flush(20)
    expect(view.lastFrame()).toContain('SETTINGS PANE')
  })
})
