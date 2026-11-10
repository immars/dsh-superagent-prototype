import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import {
  apply, claimMerge, gitlabKind, gitlabMentioned, gitlabRef, GitlabConfigSchema, gitlabThreadContext, gitlabThreadKey, gitlabWebUrl,
  issueTrigger, mergeRequestTrigger, noteTrigger, pollGitlab, sendGitlab, type GitlabConfig,
} from '../src/sources/gitlab.ts'
import type { GitlabIssue, GitlabMergeRequest, GitlabNote } from '../src/sources/gitlab-client.ts'
import { ticketMarkerLine } from '../src/sources/binding.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const PROD = 'group/widgets'
const API = `/api/v4/projects/${encodeURIComponent(PROD)}`
const CONFIG: GitlabConfig = GitlabConfigSchema.parse({
  site: 'https://gitlab.example.com', project: PROD, token: 't0ken', agentAccount: 'agent-bot',
  observeIssues: true, observeMrs: true, observeComments: true,
})
const at = (offset: number): string => new Date(Date.now() + offset).toISOString()
const agent = { id: 2, username: 'agent-bot', name: 'Agent Bot' }
const alice = { id: 1, username: 'alice', name: 'Alice' }
function issue(overrides: Partial<GitlabIssue> = {}): GitlabIssue {
  return { id: 1001, iid: 7, title: 'Fix the login page', description: '@agent-bot please fix the login page',
    state: 'opened', created_at: at(-3000), updated_at: at(-1000), labels: [], author: alice,
    web_url: `https://gitlab.example.com/${PROD}/-/issues/7`, ...overrides }
}
function merge(overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest {
  return { id: 2001, iid: 7, title: 'Fix the login page', description: 'The login page is broken',
    state: 'opened', created_at: at(-3000), updated_at: at(-1000), labels: [], author: alice,
    source_branch: 'agent/fix-login', target_branch: 'main', web_url: `https://gitlab.example.com/${PROD}/-/merge_requests/7`,
    ...overrides }
}
function note(overrides: Partial<GitlabNote> = {}): GitlabNote {
  return { id: 9001, body: 'Looks good', author: alice, created_at: at(-500), updated_at: null, system: false, ...overrides }
}
const ISSUE = issue()
const MERGE = merge()
const NOTE = note()
const FOLLOW = note({ id: 9004, body: '@agent-bot follow up', created_at: at(-1000) })
const MERGE_NOTE = note({ id: 9002, body: 'Merge request note', created_at: at(-400) })
type Route = (url: URL, init: RequestInit) => unknown
interface Call { url: URL; method: string; body?: string }
/** Replaces global fetch with routes keyed by `METHOD pathname`; an unhandled route answers 404. */
function serve(routes: Record<string, Route>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    calls.push({ url, method, ...(typeof init.body === 'string' ? { body: init.body } : {}) })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 })
    const value = route(url, init)
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function host(overrides: Partial<SourceContextDeps> = {}, register = true) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { gitlab: { enabled: true, config: CONFIG } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice', name: 'Alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (register) sources.register(gitlabKind)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Parameters<Engine['receive']>[0]) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, commitInWorktree: async () => true, ...overrides }
  const context = (target: string | { kind: string; health: readonly string[] }) => {
    const id = typeof target === 'string' ? target : target.kind
    const kind = sources.kindOf(id) ?? (typeof target === 'string' ? undefined : target)
    if (!kind) throw new Error(`Source instance not found: ${id}`)
    return sourceContextOf(parts, kind, id)
  }
  return { ...parts, context, ctx: sourceContextOf(parts, gitlabKind), engine, receive, health: board.all, board, store }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('gitlab translation', () => {
  it('maps an issue, a merge request, and notes to stable Triggers with separate Threads', () => {
    const created = issueTrigger(issue(), CONFIG)!
    expect(created).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:7' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention',
      channel: { source: 'gitlab', thread: 'gitlab:issue:7', address: { kind: 'issue', iid: '7', project: PROD } },
      meta: { kind: 'issue', workKind: 'issue', iid: 7, project: PROD, title: 'Fix the login page', state: 'opened' } })
    expect(created.id).toBe(key('gitlab-issue', PROD, '7'))

    const opened = mergeRequestTrigger(merge(), CONFIG)!
    expect(opened.threads).toEqual([{ source: 'gitlab', id: 'mr:7' }])
    expect(opened.meta).toMatchObject({ kind: 'mr', workKind: 'mr', iid: 7, sourceBranch: 'agent/fix-login', targetBranch: 'main' })
    expect(opened.id).toBe(key('gitlab-mr', PROD, '7'))
    // GitLab numbers issues and merge requests separately, so their Threads differ.
    expect(opened.threads[0]!.id).not.toBe(created.threads[0]!.id)

    const retry = note({ body: '@agent-bot please retry' })
    const said = noteTrigger('issue', ISSUE, retry, CONFIG)!
    expect(said).toMatchObject({ meta: { kind: 'comment', workKind: 'issue', iid: 7, commentId: 9001 }, addressed: 'mention',
      channel: { source: 'gitlab', thread: 'gitlab:issue:7' } })
    expect(said.url).toContain('#note_9001')
    expect(said.id).toBe(key('gitlab-note', 'issue', PROD, '7', '9001', retry.created_at))
  })
  it('drops system notes, empty notes, and the agent\'s own writes', () => {
    expect(noteTrigger('issue', issue(), note({ system: true }), CONFIG)).toBeUndefined()
    expect(noteTrigger('issue', issue(), note({ body: '   ' }), CONFIG)).toBeUndefined()
    expect(noteTrigger('issue', issue(), note({ author: agent }), CONFIG)).toBeUndefined()
    expect(issueTrigger(issue({ author: agent }), CONFIG)).toBeUndefined()
    expect(mergeRequestTrigger(merge({ author: agent }), CONFIG)).toBeUndefined()
  })
  it('recognises a mention only as the configured username', () => {
    expect(gitlabMentioned('@agent-bot please fix', 'agent-bot')).toBe(true)
    expect(gitlabMentioned('see @agent-bot2', 'agent-bot')).toBe(false)
    expect(gitlabMentioned('none', '')).toBe(false)
  })
})

describe('gitlab source settings', () => {
  it('scopes by project and observed item kind, and exposes admission rows', () => {
    expect(gitlabKind.scope!({ meta: { kind: 'issue', project: PROD } }, CONFIG)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr', project: PROD } }, CONFIG)).toEqual({ listened: true, observed: true, row: 'pulls' })
    expect(gitlabKind.scope!({ meta: { kind: 'comment', project: PROD } }, CONFIG)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { kind: 'issue', project: 'other/project' } }, CONFIG))
      .toEqual({ listened: false, reason: 'gitlab_project_not_listened' })
    expect(gitlabKind.scope!({ meta: { kind: 'pipeline', project: PROD } }, CONFIG))
      .toEqual({ listened: false, reason: 'gitlab_kind_not_listened' })
    const off = GitlabConfigSchema.parse({ ...CONFIG, observeComments: false })
    expect(gitlabKind.scope!({ meta: { kind: 'comment', project: PROD } }, off)).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(gitlabKind.policy!.rows!(CONFIG).map(row => row.id)).toEqual(['issues', 'pulls', 'comments'])
    expect(gitlabKind.policy!.rows!(CONFIG)[0]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
  })
  it('finds work items by IID or page, and configures the Channel address', () => {
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12', 'gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('!12')).toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('https://gitlab.example.com/group/widgets/-/merge_requests/7'))
      .toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(gitlabKind.find!('nothing here')).toEqual({ threads: [], terms: [] })
    expect(gitlabKind.channel!.allowed!({ kind: 'issue', iid: '7', project: PROD }, CONFIG)).toBe(true)
    expect(gitlabKind.channel!.allowed!({ kind: 'mr', iid: '7', project: 'other/project' }, CONFIG)).toBe(false)
    expect(gitlabWebUrl(CONFIG, { kind: 'mr', iid: 7 })).toBe(`https://gitlab.example.com/${PROD}/-/merge_requests/7`)
    expect(gitlabRef('gitlab:mr:7')).toEqual({ kind: 'mr', iid: 7 })
    expect(gitlabRef('issue:7')).toEqual({ kind: 'issue', iid: 7 })
    expect(gitlabRef('pipeline:7')).toBeUndefined()
    expect(gitlabThreadKey({ kind: 'mr', iid: 7 })).toBe('gitlab:mr:7')
  })
  it('uses an additional instance id in Triggers, Threads, Channels, search and cursors', () => {
    const extra = issueTrigger(issue(), CONFIG, 'gitlab-ops')!
    expect(extra).toMatchObject({ source: 'gitlab-ops', threads: [{ source: 'gitlab-ops', id: 'issue:7' }],
      actor: { source: 'gitlab-ops', id: 'alice' }, channel: { source: 'gitlab-ops', thread: 'gitlab-ops:issue:7' } })
    expect(extra.id).not.toBe(issueTrigger(issue(), CONFIG)!.id)
    expect(mergeRequestTrigger(merge(), CONFIG, 'gitlab-ops')).toMatchObject({ source: 'gitlab-ops', threads: [{ source: 'gitlab-ops', id: 'mr:7' }] })
    expect(gitlabThreadKey({ kind: 'issue', iid: 7 })).toBe('gitlab:issue:7')
    expect(gitlabThreadKey({ kind: 'issue', iid: 7 }, 'gitlab-ops')).toBe('gitlab-ops:issue:7')
    expect(gitlabKind.find!('#12', { id: 'gitlab-ops', kind: 'gitlab', enabled: true, config: CONFIG }))
      .toEqual({ threads: ['gitlab-ops:issue:12', 'gitlab-ops:mr:12'], terms: [] })
    expect(KV.gitlab.cursor('gitlab')).toBe('gitlab-cursor')
    expect(KV.gitlab.cursor('gitlab-ops')).toBe('gitlab-cursor-gitlab-ops')
    expect(KV.gitlab.thread('gitlab:issue:7')).toBe('gitlab-thread:gitlab:issue:7')
  })
  it('drops the token from the execution environment and names the origin work item', () => {
    const origin = mergeRequestTrigger(merge(), CONFIG)!
    const values = gitlabKind.environment!.values({ deployment: testDeployment(), config: CONFIG,
      instance: { id: 'gitlab', kind: 'gitlab', enabled: true, config: CONFIG }, trigger: origin })
    expect(values).toEqual({ DSH_SUPERAGENT_GITLAB_SITE: 'https://gitlab.example.com', DSH_SUPERAGENT_GITLAB_PROJECT: PROD,
      DSH_SUPERAGENT_GITLAB_KIND: 'mr', DSH_SUPERAGENT_GITLAB_NUMBER: '7', DSH_SUPERAGENT_GITLAB_URL: `https://gitlab.example.com/${PROD}/-/merge_requests/7` })
    expect(Object.values(values)).not.toContain('t0ken')
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config: CONFIG,
      instance: { id: 'gitlab', kind: 'gitlab', enabled: true, config: CONFIG } }).DSH_SUPERAGENT_GITLAB_NUMBER).toBe('')
    const extra = mergeRequestTrigger(merge(), CONFIG, 'gitlab-ops')!
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config: CONFIG,
      instance: { id: 'gitlab-ops', kind: 'gitlab', enabled: true, config: CONFIG }, trigger: extra }).DSH_SUPERAGENT_GITLAB_KIND).toBe('mr')
  })
  it('offers the project as an execution target and takes the target project for the environment', () => {
    const instance = { id: 'gitlab', kind: 'gitlab', enabled: true, config: CONFIG }
    expect(gitlabKind.repository!(instance)).toEqual({ instance: 'gitlab', repository: PROD,
      url: `https://gitlab.example.com/${PROD}` })
    expect(gitlabKind.repository!({ ...instance, id: 'gitlab-ops' })).toMatchObject({ instance: 'gitlab-ops', repository: PROD })
    // An instance without a project is not a candidate.
    expect(gitlabKind.repository!({ ...instance, config: GitlabConfigSchema.parse({ ...CONFIG, project: '' }) })).toBeUndefined()
    // The recorded target repository wins over the instance's current project; the origin item still comes from the Trigger.
    const target = { source: 'gitlab', repository: 'group/other' }
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config: CONFIG, instance, target,
      trigger: mergeRequestTrigger(merge(), CONFIG) })).toMatchObject({ DSH_SUPERAGENT_GITLAB_SITE: 'https://gitlab.example.com',
      DSH_SUPERAGENT_GITLAB_PROJECT: 'group/other', DSH_SUPERAGENT_GITLAB_KIND: 'mr', DSH_SUPERAGENT_GITLAB_NUMBER: '7' })
  })
})

describe('gitlab polling', () => {
  it('reads created issues, merge requests and notes once, advances the cursor, and replays as duplicates', async () => {
    const h = host()
    serve({
      [`GET ${API}/issues`]: () => [ISSUE],
      [`GET ${API}/issues/7/notes`]: () => [NOTE],
      [`GET ${API}/merge_requests`]: () => [MERGE],
      [`GET ${API}/merge_requests/7/notes`]: () => [MERGE_NOTE],
    })
    const result = await pollGitlab(h.ctx, CONFIG, new AbortController().signal)
    expect(result).toEqual({ read: 4, unreadable: 0 })
    expect(h.receive.mock.calls.map(call => call[0].meta.kind).sort()).toEqual(['comment', 'comment', 'issue', 'mr'])
    expect(h.store.get(KV.gitlab.cursor('gitlab'))?.scope).toContain(PROD)
    expect(await h.receive.mock.results[0]!.value).toBe('stored')

    await pollGitlab(h.ctx, CONFIG, new AbortController().signal)
    expect(await h.receive.mock.results.at(-1)!.value).toBe('duplicate')
  })
  it('binds an agent merge request by the ticket marker and its worktree commit', async () => {
    const h = host()
    h.store.tickets.save({ id: 't1', title: 'one', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '',
      basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: [] } })
    const mr = merge({ sha: 'abc', author: agent, description: `Fix the login page\n\n${ticketMarkerLine('t1')}` })
    serve({
      [`GET ${API}/issues`]: () => [],
      [`GET ${API}/merge_requests`]: () => [mr],
      [`GET ${API}/merge_requests/7/notes`]: () => [],
    })
    await pollGitlab(h.ctx, CONFIG, new AbortController().signal)
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: gitlabThreadKey({ kind: 'mr', iid: 7 }, 'gitlab'), own: true }])
  })
  it('binds a merge request an explicit report names without reading its source branch', () => {
    const h = host()
    h.store.tickets.save({ id: 't1', title: 'one', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '',
      basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: [] } })
    expect(claimMerge(h.ctx, 't1', merge({ author: agent, source_branch: 'anything' }))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: gitlabThreadKey({ kind: 'mr', iid: 7 }, 'gitlab'), own: true }])
    expect(claimMerge(h.ctx, 't1', merge({ iid: 8, author: alice }))).toContain('does not belong')
  })
  it('receives only addressed items while project-wide observation is off', async () => {
    const h = host()
    const config = GitlabConfigSchema.parse({ ...CONFIG, observeIssues: false, observeMrs: false, observeComments: false })
    serve({
      [`GET ${API}/issues`]: () => [ISSUE, issue({ iid: 8, title: 'Unasked', description: 'no mention', web_url: undefined })],
      [`GET ${API}/issues/7/notes`]: () => [note({ body: '@agent-bot look', created_at: at(-400) })],
      [`GET ${API}/issues/8/notes`]: () => [note({ id: 9003, body: 'unaddressed note' })],
      [`GET ${API}/merge_requests`]: () => [MERGE, merge({ iid: 8, title: 'Unasked', description: 'no mention', web_url: undefined })],
      [`GET ${API}/merge_requests/7/notes`]: () => [],
      [`GET ${API}/merge_requests/8/notes`]: () => [],
    })
    const result = await pollGitlab(h.ctx, config, new AbortController().signal)
    expect(result.read).toBe(2)
    expect(h.receive.mock.calls.map(call => call[0].meta.kind).sort()).toEqual(['comment', 'issue'])
    expect(h.receive.mock.calls.every(call => String(call[0].text).toLowerCase().includes('@agent-bot'))).toBe(true)
  })
  it('reads the notes of a subscribed Thread even when project-wide note observation is off', async () => {
    const h = host()
    const thread = gitlabThreadKey({ kind: 'issue', iid: 7 })
    const createdAt = at(-60_000)
    h.store.threads.save({ key: thread, ref: { source: 'gitlab', id: 'issue:7' }, createdAt, subscriptions: ['t1'], meta: {},
      lastAt: createdAt, correlated: [], pending: [] })
    const config = GitlabConfigSchema.parse({ ...CONFIG, observeIssues: false, observeMrs: false, observeComments: false })
    serve({
      [`GET ${API}/issues`]: () => [],
      [`GET ${API}/merge_requests`]: () => [],
      [`GET ${API}/issues/7`]: () => ISSUE,
      [`GET ${API}/issues/7/notes`]: () => [FOLLOW],
    })
    const result = await pollGitlab(h.ctx, config, new AbortController().signal)
    expect(result.read).toBe(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'gitlab', meta: { kind: 'comment', iid: 7 }, addressed: 'mention' })
    expect(h.store.get(KV.gitlab.thread(thread))).toBeTruthy()
  })
})

describe('gitlab thread context and channel', () => {
  it('reads the work item and its notes by page', async () => {
    const h = host()
    serve({
      [`GET ${API}/issues/7`]: () => ISSUE,
      [`GET ${API}/issues/7/notes`]: () => [NOTE, note({ id: 9002, system: true, body: 'changed the milestone' })],
    })
    const trigger = issueTrigger(ISSUE, CONFIG)!
    const part = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, CONFIG)
    expect(part.messages[0]).toMatchObject({ id: 'issue', from: 'Alice', at: ISSUE.created_at })
    expect(part.messages[0]!.text).toContain('Fix the login page')
    expect(part.messages[1]).toMatchObject({ id: '9001', from: 'Alice', text: 'Looks good' })
    expect(part.messages).toHaveLength(2)
    const root = await gitlabThreadContext.read(h.commands, trigger, 'root', undefined, CONFIG)
    expect(root.messages).toHaveLength(1)
  })
  it('posts a reply once with a marker, recognises an earlier post, and settles a deleted item as gone', async () => {
    const h = host()
    const message = { id: 'm1', channel: { source: 'gitlab', thread: 'gitlab:issue:7', address: { kind: 'issue', iid: '7', project: PROD } },
      text: 'Working on it', kind: 'reply' as const, ticketId: 't1' }
    let posted: string | undefined
    serve({
      [`GET ${API}/issues/7/notes`]: () => [],
      [`POST ${API}/issues/7/notes`]: (_url, init) => { posted = String(init.body); return note() },
    })
    expect(await sendGitlab({ commands: h.commands }, message, CONFIG)).toBe('sent')
    expect(posted).toContain('Working on it')
    expect(posted).toContain('dsh-superagent:m1')

    const postedBefore = host()
    serve({ [`GET ${API}/issues/7/notes`]: () => [note({ body: 'Working on it\n\n<!-- dsh-superagent:m1 -->', author: agent })] })
    expect(await sendGitlab({ commands: postedBefore.commands }, message, CONFIG)).toBe('sent')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)

    const missing = host()
    serve({ [`GET ${API}/issues/7/notes`]: () => new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 }) })
    expect(await sendGitlab({ commands: missing.commands }, message, CONFIG)).toBe('gone')
  })
})

describe('gitlab plugin', () => {
  it('registers the kind and reports setup, then unregisters on disposal', async () => {
    const h = host({}, false)
    serve({ [`GET ${API}/issues`]: () => [], [`GET ${API}/merge_requests`]: () => [] })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: { ...h, context: h.context }, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(h.sources.kind('gitlab')).toBe(gitlabKind)
    await vi.waitFor(() => expect(h.health.gitlab?.state).toBe('ready'))
    for (const dispose of disposers) await dispose()
    expect(h.sources.kind('gitlab')).toBeUndefined()
    expect(h.health.gitlab).toBeUndefined()
  })
})
