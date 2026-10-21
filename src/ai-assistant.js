/**
 * src/ai-assistant.js — AI assistant brain
 *
 * Exposes a Claude tool-use loop that:
 *  - Executes read-only tools freely (up to MAX_TOOL_ROUNDS)
 *  - Intercepts mutating tools and returns them to the UI for confirmation
 *  - Parses <<NAVIGATE:pane[:key=val]*>> markers for app navigation
 *
 * Direct fetch pattern (same as ai.js). No SDK dependency.
 */

import {
  listPRs, getPR, getPRDiff, getPRChecks, listIssues, getIssue,
  listBranches, listRuns, getRepoInfo, listNotifications, listPRComments,
  mergePR, closePR, closeIssue, addPRComment, addLabels, reviewPR,
  rerunRun, cancelRun,
} from './executor.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

function fetchErrorMessage(err, baseUrl) {
  const cause = err.cause
  const code  = cause?.code || cause?.errno || ''
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    if (baseUrl && !baseUrl.includes('anthropic.com') && !baseUrl.includes('openai.com')) {
      return `Connection refused to ${baseUrl} — is your local server running?`
    }
    return 'Connection refused — check your network or provider URL in Settings'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'DNS lookup failed — check your internet connection'
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return 'Connection timed out — provider may be unreachable'
  }
  // Surface the underlying message if available, otherwise fall back to err.message
  return cause?.message || err.message
}
const DEFAULT_MODEL     = 'claude-sonnet-4-6'
const MAX_TOKENS        = 4096
const MAX_DIFF_CHARS    = 8000
const MAX_TOOL_ROUNDS   = 6

const MUTATING_TOOLS   = new Set(['merge_pr', 'close_pr', 'close_issue', 'add_pr_comment', 'add_labels', 'review_pr', 'rerun_run', 'cancel_run'])
const DESTRUCTIVE_TOOLS = new Set(['merge_pr', 'close_pr', 'close_issue', 'cancel_run'])

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  // ── Read-only ──
  {
    name: 'list_prs',
    description: 'List pull requests in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        state:    { type: 'string', enum: ['open', 'closed', 'merged', 'all'] },
        limit:    { type: 'number', description: 'Max results (default 30)' },
        author:   { type: 'string', description: 'Filter by author login' },
        label:    { type: 'string', description: 'Filter by label name' },
        assignee: { type: 'string', description: 'Filter by assignee login' },
      },
    },
  },
  {
    name: 'get_pr',
    description: 'Get full details for a pull request: body, labels, reviewers, CI status, mergeable.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number', description: 'PR number' },
      },
    },
  },
  {
    name: 'get_pr_diff',
    description: 'Get the unified diff for a pull request (truncated to 8000 chars).',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number', description: 'PR number' },
      },
    },
  },
  {
    name: 'get_pr_checks',
    description: 'Get CI check / status check results for a pull request.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number', description: 'PR number' },
      },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        state:    { type: 'string', enum: ['open', 'closed', 'all'] },
        limit:    { type: 'number' },
        author:   { type: 'string' },
        label:    { type: 'string' },
        assignee: { type: 'string' },
      },
    },
  },
  {
    name: 'get_issue',
    description: 'Get full details for a specific issue including comments.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number', description: 'Issue number' },
      },
    },
  },
  {
    name: 'list_branches',
    description: 'List branches in the repository.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_runs',
    description: 'List recent GitHub Actions workflow runs.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Filter by branch name' },
        status: { type: 'string', description: 'Filter by status: completed, in_progress, queued, etc.' },
      },
    },
  },
  {
    name: 'get_repo_info',
    description: 'Get repository metadata: name, owner, default branch, allowed merge methods.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_notifications',
    description: 'List GitHub notifications (mentions, review requests, etc.).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_pr_comments',
    description: 'List review comments (line-level threads) on a pull request.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number', description: 'PR number' },
      },
    },
  },
  // ── Mutating (intercepted — requires user confirmation) ──
  {
    name: 'merge_pr',
    description: 'Merge a pull request. The UI will ask for confirmation before executing.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number:   { type: 'number' },
        strategy: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy (default: merge)' },
        message:  { type: 'string', description: 'Optional commit message' },
      },
    },
  },
  {
    name: 'close_pr',
    description: 'Close a pull request without merging. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number' },
      },
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'number' },
      },
    },
  },
  {
    name: 'add_pr_comment',
    description: 'Post a comment on a pull request. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['number', 'body'],
      properties: {
        number: { type: 'number' },
        body:   { type: 'string', description: 'Comment text (Markdown)' },
      },
    },
  },
  {
    name: 'add_labels',
    description: 'Add labels to a PR or issue. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['number', 'labels'],
      properties: {
        number: { type: 'number' },
        labels: { type: 'array', items: { type: 'string' } },
        type:   { type: 'string', enum: ['pr', 'issue'], description: 'Target type (default: pr)' },
      },
    },
  },
  {
    name: 'review_pr',
    description: 'Submit a PR review (approve / request-changes / comment). Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['number', 'event'],
      properties: {
        number: { type: 'number' },
        event:  { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
        body:   { type: 'string' },
      },
    },
  },
  {
    name: 'rerun_run',
    description: 'Re-run failed jobs in a workflow run. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'number', description: 'Workflow run database ID' },
      },
    },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running workflow run. Requires confirmation.',
    input_schema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'number', description: 'Workflow run database ID' },
      },
    },
  },
]

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the AI assistant.
 * @param {object} [ctx]
 */
function buildSystemPrompt(ctx = {}) {
  const { repo, pane, selectedItem } = ctx
  const today = new Date().toISOString().split('T')[0]

  const lines = [
    `You are an AI assistant embedded in lazyhub, a GitHub TUI (terminal UI). Today is ${today}.`,
    'You help users understand, navigate, and act on their GitHub repositories.',
    '',
  ]

  if (repo)  lines.push(`Current repository: ${repo}`)
  if (pane)  lines.push(`Current pane: ${pane}`)
  if (selectedItem?.number) {
    const kind = pane === 'issues' ? 'issue' : 'PR'
    lines.push(`Selected ${kind}: #${selectedItem.number} "${selectedItem.title || ''}" by ${selectedItem.author?.login || '?'} [${selectedItem.state || '?'}]`)
  }

  lines.push(
    '',
    '## Rules',
    '- NEVER fabricate data — always call a tool to fetch real information.',
    '- For mutating actions (merge, close, comment, label, review, rerun, cancel): call the relevant mutating tool. The UI will intercept it, show the user a confirmation prompt, and execute only if confirmed. You do NOT need to warn the user about confirmation — that happens automatically.',
    '- For navigation: embed a marker <<NAVIGATE:pane>> or <<NAVIGATE:pane:number=42>> anywhere in your text. Valid panes: prs, issues, branches, actions, notifications.',
    '  Example: "Here is PR #42. <<NAVIGATE:prs:number=42>>"',
    '- Keep responses concise and terminal-friendly — avoid heavy markdown formatting.',
    '- When explaining how to do things in lazyhub, refer to the keyboard shortcuts (j/k navigate, Enter opens, d opens diff, m merges, etc.).',
    '- You may chain multiple read-only tool calls to fully answer a question.',
  )

  return lines.join('\n')
}

// ─── Status label for tool calls (shown in UI while thinking) ─────────────────

function toolLabel(name, input) {
  switch (name) {
    case 'list_prs':          return `listing ${input.state || 'open'} PRs${input.author ? ` by @${input.author}` : ''}…`
    case 'get_pr':            return `fetching PR #${input.number}…`
    case 'get_pr_diff':       return `loading diff for PR #${input.number}…`
    case 'get_pr_checks':     return `checking CI status for PR #${input.number}…`
    case 'list_issues':       return `listing ${input.state || 'open'} issues…`
    case 'get_issue':         return `fetching issue #${input.number}…`
    case 'list_branches':     return 'listing branches…'
    case 'list_runs':         return `listing workflow runs${input.branch ? ` on ${input.branch}` : ''}…`
    case 'get_repo_info':     return 'fetching repo info…'
    case 'list_notifications':return 'listing notifications…'
    case 'list_pr_comments':  return `loading comments for PR #${input.number}…`
    case 'merge_pr':          return `merging PR #${input.number}…`
    case 'close_pr':          return `closing PR #${input.number}…`
    case 'close_issue':       return `closing issue #${input.number}…`
    case 'add_pr_comment':    return `posting comment on PR #${input.number}…`
    case 'add_labels':        return `adding labels to #${input.number}…`
    case 'review_pr':         return `submitting review on PR #${input.number}…`
    case 'rerun_run':         return `rerunning workflow #${input.runId}…`
    case 'cancel_run':        return `cancelling run #${input.runId}…`
    default:                  return `${name.replace(/_/g, ' ')}…`
  }
}

// ─── Confirm message builder ──────────────────────────────────────────────────

/**
 * Build a human-readable confirmation message for a mutating tool call.
 * @param {string} toolName
 * @param {object} input
 */
function buildConfirmMessage(toolName, input) {
  switch (toolName) {
    case 'merge_pr':
      return `Merge PR #${input.number} using --${input.strategy || 'merge'}${input.message ? ` — "${input.message}"` : ''}`
    case 'close_pr':
      return `Close PR #${input.number} (without merging)`
    case 'close_issue':
      return `Close issue #${input.number}`
    case 'add_pr_comment': {
      const preview = (input.body || '').slice(0, 60)
      return `Post comment on PR #${input.number}: "${preview}${input.body?.length > 60 ? '…' : ''}"`
    }
    case 'add_labels':
      return `Add labels [${(input.labels || []).join(', ')}] to ${input.type || 'pr'} #${input.number}`
    case 'review_pr': {
      const preview = input.body ? ` — "${input.body.slice(0, 40)}${input.body.length > 40 ? '…' : ''}"` : ''
      return `Submit ${input.event} review on PR #${input.number}${preview}`
    }
    case 'rerun_run':
      return `Re-run failed jobs in workflow run #${input.runId}`
    case 'cancel_run':
      return `Cancel workflow run #${input.runId}`
    default:
      return `Execute ${toolName}`
  }
}

// ─── Read-only tool dispatch ──────────────────────────────────────────────────

async function callReadOnlyTool(toolName, toolInput, repo) {
  switch (toolName) {
    case 'list_prs':
      return listPRs(repo, {
        state:    toolInput.state    || 'open',
        limit:    toolInput.limit    || 30,
        author:   toolInput.author,
        label:    toolInput.label,
        assignee: toolInput.assignee,
      })
    case 'get_pr':       return getPR(repo, toolInput.number)
    case 'get_pr_diff': {
      const diff = await getPRDiff(repo, toolInput.number)
      return typeof diff === 'string' ? diff.slice(0, MAX_DIFF_CHARS) : diff
    }
    case 'get_pr_checks': return getPRChecks(repo, toolInput.number)
    case 'list_issues':
      return listIssues(repo, {
        state:    toolInput.state    || 'open',
        limit:    toolInput.limit    || 30,
        author:   toolInput.author,
        label:    toolInput.label,
        assignee: toolInput.assignee,
      })
    case 'get_issue':          return getIssue(repo, toolInput.number)
    case 'list_branches':      return listBranches(repo)
    case 'list_runs':          return listRuns(repo, { branch: toolInput.branch, status: toolInput.status })
    case 'get_repo_info':      return getRepoInfo(repo)
    case 'list_notifications': return listNotifications()
    case 'list_pr_comments':   return listPRComments(repo, toolInput.number)
    default:
      throw new Error(`Unknown read-only tool: ${toolName}`)
  }
}

// ─── Mutating tool executor (called by UI after confirmation) ─────────────────

const MAX_TEXT_LENGTH = 65536
const REPO_RE = /^([A-Za-z0-9.-]{1,253}\/)?[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const REVIEW_EVENTS = ['approve', 'request-changes', 'comment']

function invalid(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Runtime-validate model-supplied mutation input before dispatch. Fails closed
 * with stable error codes; model output is untrusted.
 * @param {string} toolName
 * @param {object} input
 * @param {string} repo
 */
function validateMutationInput(toolName, input, repo) {
  if (!MUTATING_TOOLS.has(toolName)) throw invalid('AI_UNKNOWN_TOOL', `Unknown mutating tool: ${toolName}`)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('AI_INVALID_INPUT', 'Tool input must be an object')
  }
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw invalid('AI_INVALID_REPO', 'repo must be in owner/name form')
  const isId = v => Number.isSafeInteger(v) && v > 0
  if (toolName === 'rerun_run' || toolName === 'cancel_run') {
    if (!isId(input.runId)) throw invalid('AI_INVALID_ID', 'runId must be a positive integer')
  } else if (!isId(input.number)) {
    throw invalid('AI_INVALID_ID', 'number must be a positive integer')
  }
  for (const field of ['body', 'message']) {
    const v = input[field]
    if (v !== undefined && (typeof v !== 'string' || v.length > MAX_TEXT_LENGTH)) {
      throw invalid('AI_INVALID_TEXT', `${field} must be a string of at most ${MAX_TEXT_LENGTH} characters`)
    }
  }
  if (toolName === 'add_labels') {
    // Issue/PR confusion: the resource type is an enum, never free-form.
    if (input.type !== undefined && !['pr', 'issue'].includes(input.type)) {
      throw invalid('AI_INVALID_RESOURCE_TYPE', 'type must be "pr" or "issue"')
    }
    if (!Array.isArray(input.labels) || input.labels.length === 0 || input.labels.length > 50 ||
        input.labels.some(l => typeof l !== 'string' || !l || l.length > 100)) {
      throw invalid('AI_INVALID_LABELS', 'labels must be 1-50 non-empty strings')
    }
  }
  if (toolName === 'review_pr' && !REVIEW_EVENTS.includes(input.event)) {
    throw invalid('AI_INVALID_ENUM', `event must be one of ${REVIEW_EVENTS.join(', ')}`)
  }
}

/**
 * Execute a mutating tool after user confirmation.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} repo
 */
export async function executeMutatingTool(toolName, toolInput, repo) {
  validateMutationInput(toolName, toolInput, repo)
  switch (toolName) {
    case 'merge_pr': {
      const strategy = toolInput.strategy || 'merge'
      if (!['merge', 'squash', 'rebase'].includes(strategy)) {
        throw new Error('Administrative and unsupported merge strategies are disabled for agent-callable paths')
      }
      return mergePR(repo, toolInput.number, strategy, toolInput.message)
    }
    case 'close_pr':       return closePR(repo, toolInput.number)
    case 'close_issue':    return closeIssue(repo, toolInput.number)
    case 'add_pr_comment': return addPRComment(repo, toolInput.number, toolInput.body)
    case 'add_labels':     return addLabels(repo, toolInput.number, toolInput.labels, toolInput.type || 'pr')
    case 'review_pr':      return reviewPR(repo, toolInput.number, toolInput.event, toolInput.body || '')
    case 'rerun_run':      return rerunRun(repo, toolInput.runId)
    case 'cancel_run':     return cancelRun(repo, toolInput.runId)
    default:
      throw new Error(`Unknown mutating tool: ${toolName}`)
  }
}

// ─── Navigation marker parser ─────────────────────────────────────────────────

function parseNavigate(text) {
  const m = text.match(/<<NAVIGATE:([^>]+)>>/)
  if (!m) return null
  const parts  = m[1].split(':')
  const result = { pane: parts[0] }
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf('=')
    if (eqIdx < 0) continue
    const k = parts[i].slice(0, eqIdx)
    const v = parts[i].slice(eqIdx + 1)
    if (k === 'number') result.itemNumber = parseInt(v, 10)
    else result[k] = v
  }
  return result
}

function findNavInText(text) {
  // scan all <<NAVIGATE:...>> markers, return first valid one
  let navData = null
  const re = /<<NAVIGATE:([^>]+)>>/g
  let m
  while ((m = re.exec(text)) !== null) {
    navData = parseNavigate(m[0])
    if (navData) break
  }
  return navData
}

// ─── Tool result builder (provider-aware) — used by AIAssistant.jsx ──────────

/**
 * Build the provider-specific message object for a tool result.
 * Push this into conversationRef.current after confirm/cancel.
 * @param {string} provider
 * @param {string} toolUseId
 * @param {string} content
 * @param {boolean} [isError]
 */
export function buildToolResultMessage(provider, toolUseId, content, isError = false) {
  if (provider === 'openai') {
    return { role: 'tool', tool_call_id: toolUseId, content }
  }
  // Anthropic
  const block = { type: 'tool_result', tool_use_id: toolUseId, content }
  if (isError) block.is_error = true
  return { role: 'user', content: [block] }
}

// ─── OpenAI tool definitions (converted from Anthropic input_schema format) ───

const OPENAI_TOOL_DEFINITIONS = TOOL_DEFINITIONS.map(d => ({
  type: 'function',
  function: {
    name:        d.name,
    description: d.description,
    parameters:  d.input_schema,
  },
}))

// ─── Anthropic adapter ────────────────────────────────────────────────────────

async function runAnthropicTurn({ messages, userMessage, repo, ctx, aiConfig, onStatus }) {
  const apiKey = aiConfig?.anthropicApiKey
  if (!apiKey) {
    return { type: 'error', text: 'No Anthropic API key set. Open Settings → AI Provider to configure.' }
  }

  const emit = onStatus || (() => {})
  const model  = aiConfig?.model || DEFAULT_MODEL
  const system = buildSystemPrompt(ctx)
  const apiMessages = [...messages, { role: 'user', content: userMessage }]
  let rounds = 0

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++
    emit(rounds > 1 ? `thinking (round ${rounds})…` : 'thinking…')

    let response
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools:    TOOL_DEFINITIONS,
          messages: apiMessages,
        }),
      })
    } catch (err) {
      return { type: 'error', text: `Network error: ${fetchErrorMessage(err, ANTHROPIC_API_URL)}` }
    }

    if (!response.ok) {
      const status = response.status
      if (status === 401) return { type: 'error', text: 'Invalid Anthropic API key' }
      if (status === 429) return { type: 'error', text: 'Rate limit exceeded — try again shortly' }
      if (status >= 500) return { type: 'error', text: 'Anthropic service error — try again' }
      return { type: 'error', text: `API error ${status}` }
    }

    let body
    try { body = await response.json() } catch {
      return { type: 'error', text: 'Could not parse API response' }
    }

    apiMessages.push({ role: 'assistant', content: body.content })

    const textBlocks   = (body.content || []).filter(b => b.type === 'text')
    const toolUseBlock = (body.content || []).find(b => b.type === 'tool_use')
    const textContent  = textBlocks.map(b => b.text).join('\n').trim()

    if (toolUseBlock) {
      emit(toolLabel(toolUseBlock.name, toolUseBlock.input))

      if (MUTATING_TOOLS.has(toolUseBlock.name)) {
        return {
          type:           'pending_action',
          text:           textContent,
          confirmMessage: buildConfirmMessage(toolUseBlock.name, toolUseBlock.input),
          toolName:       toolUseBlock.name,
          toolInput:      toolUseBlock.input,
          toolUseId:      toolUseBlock.id,
          isDestructive:  DESTRUCTIVE_TOOLS.has(toolUseBlock.name),
          messages:       apiMessages,
        }
      }

      let toolResult
      try { toolResult = await callReadOnlyTool(toolUseBlock.name, toolUseBlock.input, repo) }
      catch (err) { toolResult = { error: err.message } }

      apiMessages.push({
        role:    'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(toolResult) }],
      })
      continue
    }

    let navData = null
    for (const b of textBlocks) {
      navData = findNavInText(b.text)
      if (navData) break
    }

    if (navData) return { type: 'navigate', text: textContent, navigate: navData, messages: apiMessages }
    return { type: 'answer', text: textContent || '(no response)', messages: apiMessages }
  }

  return { type: 'error', text: 'Reached maximum tool-call rounds — please try a simpler question' }
}

// ─── OpenAI-compatible adapter ────────────────────────────────────────────────

async function runOpenAITurn({ messages, userMessage, repo, ctx, aiConfig, onStatus }) {
  const apiKey  = aiConfig?.openaiApiKey
  const baseUrl = (aiConfig?.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model   = aiConfig?.model || 'gpt-4o'

  const emit = onStatus || (() => {})

  // Key is optional — local endpoints (Ollama, vLLM, etc.) don't need one.
  // If the server rejects the request with 401 we surface the error then.

  const system = buildSystemPrompt(ctx)

  // OpenAI keeps system prompt as first message (not in history)
  // History messages are user/assistant/tool turns only
  const apiMessages = [
    { role: 'system', content: system },
    ...messages,
    { role: 'user', content: userMessage },
  ]
  let rounds = 0

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++
    emit(rounds > 1 ? `thinking (round ${rounds})…` : 'thinking…')

    let response
    try {
      const headers = { 'content-type': 'application/json' }
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`

      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens:  MAX_TOKENS,
          tools:       OPENAI_TOOL_DEFINITIONS,
          tool_choice: 'auto',
          messages:    apiMessages,
        }),
      })
    } catch (err) {
      return { type: 'error', text: `Network error: ${fetchErrorMessage(err, baseUrl)}` }
    }

    if (!response.ok) {
      const status = response.status
      if (status === 401) return { type: 'error', text: 'Invalid API key' }
      if (status === 429) return { type: 'error', text: 'Rate limit exceeded — try again shortly' }
      if (status >= 500) return { type: 'error', text: 'Provider service error — try again' }
      // Surface provider error details (model not found, etc.)
      let detail = ''
      try { const b = await response.json(); detail = b?.error?.message || '' } catch { /* ignore */ }
      return { type: 'error', text: `API error ${status}${detail ? `: ${detail}` : ''}` }
    }

    let body
    try { body = await response.json() } catch {
      return { type: 'error', text: 'Could not parse API response' }
    }

    const msg        = body?.choices?.[0]?.message
    const textContent = (msg?.content || '').trim()
    const toolCalls  = msg?.tool_calls || []

    // Append assistant turn to history (without the system message prefix)
    apiMessages.push(msg)

    if (toolCalls.length > 0) {
      const tc = toolCalls[0]
      const toolName = tc.function.name
      let toolInput
      try { toolInput = JSON.parse(tc.function.arguments) } catch { toolInput = {} }

      emit(toolLabel(toolName, toolInput))

      if (MUTATING_TOOLS.has(toolName)) {
        // Strip system message from stored history (it's re-injected on every call)
        const history = apiMessages.filter(m => m.role !== 'system')
        return {
          type:           'pending_action',
          text:           textContent,
          confirmMessage: buildConfirmMessage(toolName, toolInput),
          toolName,
          toolInput,
          toolUseId:      tc.id,
          isDestructive:  DESTRUCTIVE_TOOLS.has(toolName),
          messages:       history,
        }
      }

      let toolResult
      try { toolResult = await callReadOnlyTool(toolName, toolInput, repo) }
      catch (err) { toolResult = { error: err.message } }

      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) })
      continue
    }

    const navData = findNavInText(textContent)
    // Strip system message from returned history
    const history = apiMessages.filter(m => m.role !== 'system')

    if (navData) return { type: 'navigate', text: textContent, navigate: navData, messages: history }
    return { type: 'answer', text: textContent || '(no response)', messages: history }
  }

  return { type: 'error', text: 'Reached maximum tool-call rounds — please try a simpler question' }
}

// ─── Public turn runner — dispatches by provider ─────────────────────────────

/**
 * @typedef {object} AssistantResult
 * @property {string} type
 * @property {string} text
 * @property {object} [navigate]
 * @property {Array} [messages]
 * @property {object} [usage]
 * @property {string} [error]
 * @property {string} [confirmMessage]
 * @property {string} [toolName]
 * @property {object} [toolInput]
 * @property {string} [toolUseId]
 * @property {boolean} [isDestructive]
 */

/**
 * Run one user turn through the tool-use loop.
 *
 * @param {object} opts
 * @param {Array}  opts.messages     - Prior messages in provider-specific format
 * @param {string} opts.userMessage  - New user text
 * @param {string} opts.repo         - owner/repo
 * @param {object} opts.ctx          - { repo, pane, selectedItem }
 * @param {object} opts.aiConfig     - From config.ai
 * @param {Function} [opts.onStatus] - Called with a status string during tool execution
 * @returns {Promise<AssistantResult>}
 */
export async function runAssistantTurn({ messages, userMessage, repo, ctx, aiConfig, onStatus }) {
  const provider = aiConfig?.provider || 'anthropic'
  if (provider === 'openai' || provider === 'ollama' || provider === 'openai-compatible') {
    // For ollama: use openai-compatible adapter with its baseUrl; no key needed
    const cfg = provider === 'ollama'
      ? {
          ...aiConfig,
          provider:      'openai',
          openaiBaseUrl: aiConfig?.openaiBaseUrl || 'http://localhost:11434/v1',
          model:         aiConfig?.model         || 'llama3',
        }
      : provider === 'openai-compatible'
        ? {
            ...aiConfig,
            provider:      'openai',
            openaiApiKey:  (aiConfig?.openai_compatible || aiConfig?.openaiCompatible)?.api_key,
            openaiBaseUrl: (aiConfig?.openai_compatible || aiConfig?.openaiCompatible)?.base_url,
            model:         (aiConfig?.openai_compatible || aiConfig?.openaiCompatible)?.model,
          }
      : aiConfig
    return runOpenAITurn({ messages, userMessage, repo, ctx, aiConfig: cfg, onStatus })
  }
  return runAnthropicTurn({ messages, userMessage, repo, ctx, aiConfig, onStatus })
}
