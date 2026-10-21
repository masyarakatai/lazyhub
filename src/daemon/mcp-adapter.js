import * as readline from 'readline'
import {
  getIssue,
  getPR,
  getPRChecks,
  getPRDiff,
  listBranches,
  listIssues,
  listNotifications,
  listPRs,
} from '../executor.js'
import { isRepoSlug, isPositiveId } from '../input-validation.js'

const TOOL_ALIASES = {
  lazyhub_pr_list: 'list_prs',
  lazyhub_pr_view: 'get_pr',
  lazyhub_pr_diff: 'get_pr_diff',
  lazyhub_pr_approve: 'approve_pr',
  lazyhub_pr_merge: 'merge_pr',
  lazyhub_pr_comment: 'post_comment',
  lazyhub_pr_review_line: 'review_line',
  lazyhub_issue_list: 'list_issues',
  lazyhub_issue_view: 'get_issue',
  lazyhub_issue_comment: 'post_comment',
  lazyhub_query: 'query',
  lazyhub_watch_ci: 'get_checks',
}

const MUTATING_TOOLS = new Set([
  'approve_pr',
  'merge_pr',
  'post_comment',
  'close_issue',
  'review_line',
])

const MCP_MUTATIONS_DISABLED = 'MCP mutating tools are disabled until governed authorization is available'

const MAX_QUERY_LENGTH = 2000
const STATES = { list_prs: ['open', 'closed', 'merged', 'all'], list_issues: ['open', 'closed', 'all'] }
// Resource each read tool operates on; a caller-declared resource_type must match.
const RESOURCE_TYPES = { list_prs: 'pr', get_pr: 'pr', get_pr_diff: 'pr', get_checks: 'pr', list_issues: 'issue', get_issue: 'issue' }
const NUMBERED_TOOLS = new Set(['get_pr', 'get_pr_diff', 'get_checks', 'get_issue'])

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Runtime-validate tool arguments. Fails closed with stable error codes.
 * Only fields validated here are ever read; client-supplied scope/identity
 * metadata is ignored and never confers authority.
 * @param {string} canonical
 * @param {object} args
 */
function validateArgs(canonical, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw fail('MCP_INVALID_ARGUMENTS', 'Tool arguments must be an object')
  }
  const expected = RESOURCE_TYPES[canonical]
  if (args.resource_type !== undefined && args.resource_type !== expected) {
    throw fail('MCP_RESOURCE_MISMATCH', `Tool ${canonical} operates on ${expected || 'no'} resources, not ${JSON.stringify(args.resource_type)}`)
  }
  if (args.repo !== undefined && !isRepoSlug(args.repo)) {
    throw fail('MCP_INVALID_REPO', 'repo must be in owner/name form')
  }
  if (NUMBERED_TOOLS.has(canonical) && !isPositiveId(args.number)) {
    throw fail('MCP_INVALID_NUMBER', 'number must be a positive integer')
  }
  if (args.state !== undefined && !(STATES[canonical] || []).includes(args.state)) {
    throw fail('MCP_INVALID_STATE', `state is not valid for ${canonical}`)
  }
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 100)) {
    throw fail('MCP_INVALID_LIMIT', 'limit must be an integer between 1 and 100')
  }
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > MAX_QUERY_LENGTH)) {
    throw fail('MCP_INVALID_TEXT', `query must be a string of at most ${MAX_QUERY_LENGTH} characters`)
  }
}

const TOOLS = [
  ['lazyhub_pr_list', 'List pull requests'],
  ['lazyhub_pr_view', 'View a pull request'],
  ['lazyhub_pr_diff', 'Get a pull request diff'],
  ['lazyhub_issue_list', 'List issues'],
  ['lazyhub_issue_view', 'View an issue'],
  ['lazyhub_query', 'Query lazyhub context'],
  ['lazyhub_watch_ci', 'Get CI status for a PR'],
  ['list_prs', 'List pull requests'],
  ['get_pr', 'View a pull request'],
  ['get_pr_diff', 'Get a pull request diff'],
  ['get_checks', 'Get CI checks'],
  ['list_issues', 'List issues'],
  ['get_issue', 'View an issue'],
  ['list_notifications', 'List notifications'],
  ['list_branches', 'List branches'],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      number: { type: 'number' },
      state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] },
      limit: { type: 'number' },
      query: { type: 'string', maxLength: MAX_QUERY_LENGTH },
      resource_type: { type: 'string', enum: ['pr', 'issue'] },
    },
  },
}))

const repo = () => process.env.GHUI_REPO || null

/**
 * Execute one MCP tool by name.
 *
 * @param {string} name
 * @param {object} args
 */
async function callTool(name, args = {}) {
  if (typeof name !== 'string' || !name) throw fail('MCP_INVALID_TOOL', 'Tool name must be a non-empty string')
  const canonical = TOOL_ALIASES[name] || name
  if (MUTATING_TOOLS.has(canonical)) throw fail('MCP_MUTATIONS_DISABLED', MCP_MUTATIONS_DISABLED)
  validateArgs(canonical, args)

  const r = args.repo || repo()
  switch (canonical) {
    case 'list_prs': return listPRs(r, { state: args.state || 'open', limit: args.limit || 30 })
    case 'get_pr': return getPR(r, args.number)
    case 'get_pr_diff': return getPRDiff(r, args.number)
    case 'get_checks': return getPRChecks(r, args.number)
    case 'list_issues': return listIssues(r, { state: args.state || 'open', limit: args.limit || 30 })
    case 'get_issue': return getIssue(r, args.number)
    case 'list_notifications': return listNotifications()
    case 'list_branches': return listBranches(r)
    case 'query': return { answer: 'lazyhub_query is available; AI-backed answers are configured by provider in later phases.' }
    default: throw fail('MCP_UNKNOWN_TOOL', `Unknown tool: ${name}`)
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handleRequest(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    respond(id, { protocolVersion: '2024-11-05', serverInfo: { name: 'lazyhub', version: '1.0.0' }, capabilities: { tools: {} } })
    return
  }
  if (method === 'tools/list') {
    respond(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {})
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
    } catch (err) {
      respond(id, { content: [{ type: 'text', text: `Error${err.code ? ` [${err.code}]` : ''}: ${err.message}` }], isError: true })
    }
    return
  }
  if (method === 'notifications/initialized') return
  respondError(id, -32601, `Method not found: ${method}`)
}

/**
 * Run the MCP server over stdio.
 */
export async function runMCPServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      await handleRequest(JSON.parse(line))
    } catch (err) {
      respondError(null, -32700, err.message)
    }
  }
}

export { MCP_MUTATIONS_DISABLED, TOOLS, callTool }
