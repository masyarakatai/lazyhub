import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeMutatingTool, runAssistantTurn } from './ai-assistant.js'

describe('runAssistantTurn provider routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('routes openai-compatible config through its configured chat completions endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello from local model' } }],
      }),
    })

    const result = await runAssistantTurn({
      messages: [],
      userMessage: 'hello',
      repo: 'owner/repo',
      ctx: { repo: 'owner/repo', pane: 'prs', selectedItem: null },
      aiConfig: {
        provider: 'openai-compatible',
        openai_compatible: {
          base_url: 'http://localhost:1234/v1',
          api_key: 'local-key',
          model: 'qwen2.5-coder:32b',
          timeout_ms: 60000,
        },
      },
    })

    expect(result).toMatchObject({ type: 'answer', text: 'hello from local model' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer local-key' }),
      })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('qwen2.5-coder:32b')
  })
})

describe('agent mutation containment', () => {
  it.each(['admin-merge', 'admin-squash', 'admin-rebase', 'admin-force'])(
    'rejects merge strategy %s before execution',
    async strategy => {
      await expect(executeMutatingTool('merge_pr', {
        number: 42,
        strategy,
      }, 'owner/repo')).rejects.toThrow(
        'Administrative and unsupported merge strategies are disabled for agent-callable paths'
      )
    }
  )

  it.each([
    ['merge_pr', { number: '42' }, 'owner/repo', 'AI_INVALID_ID'],
    ['close_issue', { number: -1 }, 'owner/repo', 'AI_INVALID_ID'],
    ['cancel_run', { number: 5 }, 'owner/repo', 'AI_INVALID_ID'],
    ['close_pr', { number: 1 }, 'owner/repo --admin', 'AI_INVALID_REPO'],
    ['add_pr_comment', { number: 1, body: 'x'.repeat(70000) }, 'owner/repo', 'AI_INVALID_TEXT'],
    ['add_labels', { number: 1, labels: ['bug'], type: 'discussion' }, 'owner/repo', 'AI_INVALID_RESOURCE_TYPE'],
    ['add_labels', { number: 1, labels: 'bug' }, 'owner/repo', 'AI_INVALID_LABELS'],
    ['review_pr', { number: 1, event: 'admin-approve' }, 'owner/repo', 'AI_INVALID_ENUM'],
    ['delete_repo', { number: 1 }, 'owner/repo', 'AI_UNKNOWN_TOOL'],
  ])('rejects malformed %s input with stable code %s', async (tool, input, repo, code) => {
    await expect(executeMutatingTool(tool, input, repo)).rejects.toMatchObject({ code })
  })
})
