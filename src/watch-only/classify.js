/**
 * watch-only/classify.js — attribute observed actors, with evidence.
 *
 * SECURITY: classification is audit METADATA ONLY (ARCHITECT_DECISIONS D1/D3,
 * THREAT_MODEL T10/T12). Nothing in report.js reads a class to decide coverage,
 * and no caller may use it to grant or bypass authority.
 *
 * Classes:
 *   agent       identity is in the local registry as a known coding/review agent
 *   automation  identity is in the registry as non-AI automation (CI, dependency bots)
 *   human       GitHub `User` account with no registry match. This is "no agent
 *               evidence", NOT proof of a human: an agent using a personal token
 *               is indistinguishable from here.
 *   unknown     anything ambiguous (unregistered Bot/App, deleted account, git-only
 *               identity, login/type mismatch). Never guessed.
 * Event-level attribution additionally has `shared` (human + agent on one event).
 */

/**
 * Local registry of known App/bot identities. Matching is exact on login (with
 * any `[bot]` suffix stripped) or App slug; there is no fuzzy matching.
 * Bot-style logins only match accounts GitHub itself types as `Bot`/`App`, so a
 * `User` registered as "claude" is not attributed (it becomes `unknown`).
 */
const KNOWN_IDENTITIES = Object.freeze([
  { id: 'github-copilot-agent', kind: 'agent', label: 'GitHub Copilot coding agent', logins: ['copilot-swe-agent', 'copilot'], slugs: ['copilot-swe-agent'] },
  { id: 'github-copilot-reviewer', kind: 'agent', label: 'GitHub Copilot code review', logins: ['copilot-pull-request-reviewer'], slugs: ['copilot-pull-request-reviewer'] },
  { id: 'claude-code-action', kind: 'agent', label: 'Claude (GitHub App)', logins: ['claude'], slugs: ['claude'] },
  { id: 'devin', kind: 'agent', label: 'Devin', logins: ['devin-ai-integration'], slugs: ['devin-ai-integration'] },
  { id: 'dependabot', kind: 'automation', label: 'Dependabot', logins: ['dependabot'], slugs: ['dependabot'] },
  { id: 'renovate', kind: 'automation', label: 'Renovate', logins: ['renovate'], slugs: ['renovate'] },
  { id: 'github-actions', kind: 'automation', label: 'GitHub Actions', logins: ['github-actions'], slugs: ['github-actions'] },
])

const BOT_TYPES = new Set(['Bot', 'App'])

function normLogin(login) {
  return String(login || '').toLowerCase().replace(/\[bot\]$/, '')
}

/**
 * Classify one observed actor.
 *
 * @param {{login?: string|null, type?: string|null, slug?: string|null, email?: string|null, source: string}} actor
 *   `source` is where the identity came from: `github_actor` (event actor/author
 *   as typed by GitHub), `check_app` (the App that owns a check suite), or
 *   `git_author` (commit metadata; only trusted when GitHub linked an account).
 * @returns {{login: string|null, type: string|null, source: string, class: string, registry_id: string|null, label: string|null, evidence: object[]}}
 */
function classifyActor(actor) {
  const { login = null, type = null, slug = null, email = null, source } = actor
  const base = { login, type, source, registry_id: null, label: null }
  const unknown = evidence => ({ ...base, class: 'unknown', evidence })

  if (source === 'git_author' && !login) {
    const hint = email ? [{ kind: 'self_declared_git_identity', value: email, note: 'commit author metadata is spoofable; not used for attribution' }] : []
    return unknown([{ kind: 'no_github_account_linked' }, ...hint])
  }
  if (!login && !slug) return unknown([{ kind: 'no_actor', note: 'deleted account or missing actor' }])

  const key = normLogin(slug || login)
  const botLike = BOT_TYPES.has(type) || source === 'check_app'
  const match = KNOWN_IDENTITIES.find(i => (source === 'check_app' ? i.slugs : i.logins).includes(key))

  if (match && botLike) {
    return {
      ...base,
      class: match.kind,
      registry_id: match.id,
      label: match.label,
      evidence: [
        { kind: 'registry_match', registry_id: match.id, matched: source === 'check_app' ? 'app_slug' : 'login', value: key },
        { kind: 'github_actor_type', value: type || 'App' },
      ],
    }
  }
  if (match) {
    // Login claims a registry identity but GitHub says it is a user account.
    return unknown([{ kind: 'registry_login_type_mismatch', registry_id: match.id, value: key, github_type: type }])
  }
  if (type === 'User') return { ...base, class: 'human', evidence: [{ kind: 'github_actor_type', value: 'User' }, { kind: 'no_agent_evidence' }] }
  if (botLike) return unknown([{ kind: 'bot_not_in_registry', value: key, github_type: type || 'App' }])
  return unknown([{ kind: 'unrecognized_actor_type', value: type }])
}

function attribute(actors) {
  const classes = new Set(actors.map(a => a.class))
  if (classes.size === 0 || classes.has('unknown')) return 'unknown'
  if (classes.has('human') && (classes.has('agent') || classes.has('automation'))) return 'shared'
  return [...classes][0]
}

/**
 * Attach classified actors and an event-level attribution to every observed
 * event and PR author. Pure; does not mutate the observation.
 *
 * @param {object} observation  result of observeRepo()
 * @returns {object} observation with `events[].actors` classified, `events[].attribution`, `pull_requests[].author` classified
 */
export function classifyObservation(observation) {
  const events = observation.events.map(event => {
    const actors = event.actors.map(classifyActor)
    return { ...event, actors, attribution: attribute(actors) }
  })
  const pull_requests = observation.pull_requests.map(pr => ({ ...pr, author: classifyActor(pr.author) }))
  return { ...observation, events, pull_requests }
}
