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
  apply, commentTrigger, createdTrigger, historyTrigger, jiraKind, jiraMentioned, JiraConfigSchema,
  issueTriggers, jiraIssueUrl, jiraJql, jiraThreadContext, pollJira, sendJira, type JiraConfig,
} from '../src/sources/jira.ts'
import { adfDocument, adfText, jiraBodyText, jiraTime, type JiraComment, type JiraHistory, type JiraIssue } from '../src/sources/jira-client.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const CONFIG: JiraConfig = JiraConfigSchema.parse({
  site: 'https://acme.atlassian.net', project: 'ABC', user: 'bot@example.com', token: 't0ken',
  agentAccount: 'agent-account', agentName: 'Agent',
})
const SERVER_CONFIG: JiraConfig = JiraConfigSchema.parse({ ...CONFIG, site: 'https://jira.example.com', platform: 'server' })
const at = (offset: number): string => new Date(Date.now() + offset).toISOString()
function issue(fields: Record<string, unknown> = {}, keyValue = 'ABC-1'): JiraIssue {
  return {
    id: '10001', key: keyValue,
    fields: {
      summary: 'Fix the login page',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph',
        content: [{ type: 'text', text: '@Agent please fix the login page' }] }] },
      status: { name: 'In Progress' }, issuetype: { name: 'Bug' }, priority: { name: 'High' },
      assignee: null, reporter: { accountId: 'u1', displayName: 'Alice', accountType: 'atlassian' },
      created: at(-3000), updated: at(-1000), labels: ['agent'], project: { key: 'ABC' },
      ...fields,
    },
  }
}
function history(items: JiraHistory['items'] = [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
  overrides: Partial<JiraHistory> = {}): JiraHistory {
  return { id: 'h1', author: { accountId: 'u1', displayName: 'Alice', accountType: 'atlassian' },
    created: at(-1500), items, ...overrides }
}
function comment(body: unknown = 'Looks good', overrides: Partial<JiraComment> = {}): JiraComment {
  return { id: 'c1', author: { accountId: 'u1', displayName: 'Alice', accountType: 'atlassian' },
    body, created: at(-500), updated: null, ...overrides }
}
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
    if (!route) return new Response(JSON.stringify({ errorMessages: ['not found'] }), { status: 404 })
    const value = route(url, init)
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function host(overrides: Partial<SourceContextDeps> = {}, register = true) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'jira-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { jira: { enabled: true, config: CONFIG } },
    policy: { sources: { jira: { allowed: [{ id: 'u1', name: 'Alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (register) sources.register(jiraKind)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Parameters<Engine['receive']>[0]) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const context = (target: string | { kind: string; health: readonly string[] }) => {
    const id = typeof target === 'string' ? target : target.kind
    const kind = sources.kindOf(id) ?? (typeof target === 'string' ? undefined : target)
    if (!kind) throw new Error(`Source instance not found: ${id}`)
    return sourceContextOf(parts, kind, id)
  }
  return { ...parts, context, ctx: sourceContextOf(parts, jiraKind), engine, receive, health: board.all, board, store }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('jira translation', () => {
  it('maps an issue, a status history, an update, and a comment to stable Triggers', () => {
    const value = issue()
    const created = createdTrigger(value, CONFIG)!
    expect(created).toMatchObject({ source: 'jira', threads: [{ source: 'jira', id: 'ABC-1' }],
      actor: { source: 'jira', id: 'u1' }, human: true, addressed: 'mention',
      channel: { source: 'jira', thread: 'jira:ABC-1', address: { issue: 'ABC-1', project: 'ABC', url: 'https://acme.atlassian.net/browse/ABC-1' } },
      url: 'https://acme.atlassian.net/browse/ABC-1',
      meta: { change: 'created', issue: 'ABC-1', project: 'ABC', issueType: 'Bug', summary: 'Fix the login page' } })
    expect(created.id).toBe(key('jira', 'ABC-1', 'created', value.fields.created))

    const transition = historyTrigger(value, history(), CONFIG)!
    expect(transition.meta.change).toBe('transitioned')
    expect(transition.text).toContain('status: To Do → In Progress')
    expect(transition.id).toBe(key('jira', 'ABC-1', 'transitioned', 'h1'))

    const update = historyTrigger(value, history([{ field: 'priority', fromString: 'Low', toString: 'High' }], { id: 'h2' }), CONFIG)!
    expect(update.meta.change).toBe('updated')
    expect(update.text).toContain('priority: Low → High')

    const saidComment = comment()
    const said = commentTrigger(value, saidComment, CONFIG)!
    expect(said).toMatchObject({ meta: { change: 'commented', issue: 'ABC-1', commentId: 'c1' } })
    expect(said.text).toContain('Comment by Alice: Looks good')
    expect(said.id).toBe(key('jira', 'ABC-1', 'commented', `${saidComment.id}:${saidComment.created}`))
  })
  it('uses the instance id in Triggers, Threads, Channels and cursors', () => {
    const triggers = issueTriggers(issue(), [], [], CONFIG, at(-5000), 'jira-ops')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ source: 'jira-ops', threads: [{ source: 'jira-ops', id: 'ABC-1' }],
      channel: { source: 'jira-ops', thread: 'jira-ops:ABC-1' } })
    expect(triggers[0]!.id).not.toBe(createdTrigger(issue(), CONFIG)!.id)
    expect(jiraKind.find!('ABC-123', { id: 'jira-ops', kind: 'jira', enabled: true, config: CONFIG }))
      .toEqual({ threads: ['jira-ops:ABC-123'], terms: [] })
    expect(KV.jira.cursor('jira')).toBe('jira-cursor')
    expect(KV.jira.cursor('jira-ops')).toBe('jira-cursor-jira-ops')
  })
  it('drops the agent\'s own writes and filters change kinds', () => {
    const value = issue({ reporter: { accountId: 'agent-account', displayName: 'Agent', accountType: 'atlassian' } })
    expect(createdTrigger(value, CONFIG)).toBeUndefined()
    const own = history([], { author: { accountId: 'agent-account', displayName: 'Agent', accountType: 'atlassian' } })
    expect(historyTrigger(value, own, CONFIG)).toBeUndefined()
    const ownComment = comment('from the agent', { author: { accountId: 'agent-account', displayName: 'Agent', accountType: 'atlassian' } })
    expect(commentTrigger(value, ownComment, CONFIG)).toBeUndefined()

    const createdOnly = JiraConfigSchema.parse({ ...CONFIG, changes: [{ change: 'created' }] })
    expect(issueTriggers(issue(), [history()], [comment()], createdOnly, at(-5000))).toHaveLength(1)
    expect(issueTriggers(issue(), [], [], createdOnly, at(-5000))[0]!.meta.change).toBe('created')
  })
  it('recognises a mention only as the configured display name', () => {
    expect(jiraMentioned('@Agent please fix', 'Agent')).toBe(true)
    expect(jiraMentioned('see @AgentSmith', 'Agent')).toBe(false)
    expect(jiraMentioned('none', '')).toBe(false)
  })
  it('renders ADF text and builds a minimal ADF reply', () => {
    const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: 'Agent' } }, { type: 'text', text: '!' }] }] }
    expect(adfText(doc)).toBe('Hello @Agent!\n')
    expect(jiraBodyText(doc)).toBe('Hello @Agent!')
    const reply = adfDocument('line one\nline two\n\nsecond paragraph') as { type: string; content: unknown[] }
    expect(reply).toMatchObject({ type: 'doc', version: 1 })
    expect(reply.content).toHaveLength(2)
    expect(jiraTime('2026-11-04T10:00:00.000+0000')).toBe('2026-11-04T10:00:00.000Z')
  })
  it('builds the JQL for the project, cursor, issue types and extra filter', () => {
    const jql = jiraJql({ project: 'ABC', issueTypes: 'Bug, Task', jql: 'labels = agent' }, '2026-11-04T10:05:30.000Z')
    expect(jql).toBe('project = "ABC" AND updated >= "2026-11-04 10:04 UTC" AND issuetype in ("Bug", "Task") AND (labels = agent) ORDER BY updated ASC')
  })
})

describe('jira source settings', () => {
  it('scopes by project, change kind and issue type, and exposes admission rows for each change kind', () => {
    expect(jiraKind.scope!({ meta: { change: 'created', project: 'ABC', issueType: 'Bug' } }, CONFIG))
      .toEqual({ listened: true, observed: true, row: 'created' })
    expect(jiraKind.scope!({ meta: { change: 'created', project: 'XYZ', issueType: 'Bug' } }, CONFIG))
      .toEqual({ listened: false, reason: 'project_not_listened' })
    expect(jiraKind.scope!({ meta: { change: 'commented', project: 'ABC', issueType: 'Bug' } },
      JiraConfigSchema.parse({ ...CONFIG, changes: [{ change: 'created' }] })))
      .toEqual({ listened: false, reason: 'change_not_listened' })
    const typed = JiraConfigSchema.parse({ ...CONFIG, issueTypes: 'Bug, Task' })
    expect(jiraKind.scope!({ meta: { change: 'created', project: 'ABC', issueType: 'Task' } }, typed).listened).toBe(true)
    expect(jiraKind.scope!({ meta: { change: 'created', project: 'ABC', issueType: 'Story' } }, typed))
      .toEqual({ listened: false, reason: 'issue_type_not_listened' })
    expect(jiraKind.policy!.rows!(CONFIG).map(row => row.id)).toEqual(['created', 'updated', 'transitioned', 'commented'])
    expect(jiraKind.policy!.rows!(CONFIG)[0]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
  })
  it('finds an issue by its key and configures its Channel address', () => {
    expect(jiraKind.find!('ABC-123')).toEqual({ threads: ['jira:ABC-123'], terms: [] })
    expect(jiraKind.find!('https://acme.atlassian.net/browse/abc-7')).toEqual({ threads: ['jira:ABC-7'], terms: [] })
    expect(jiraKind.find!('nothing here')).toEqual({ threads: [], terms: [] })
    expect(jiraKind.channel!.allowed!({ issue: 'ABC-1', project: 'ABC' }, CONFIG)).toBe(true)
    expect(jiraKind.channel!.allowed!({ issue: 'ABC-1', project: 'XYZ' }, CONFIG)).toBe(false)
    expect(jiraIssueUrl(CONFIG, 'ABC-1')).toBe('https://acme.atlassian.net/browse/ABC-1')
  })
})

describe('jira polling', () => {
  it('reads created, transitioned and commented changes once, advances the cursor, and replays as duplicates', async () => {
    const h = host()
    const value = issue(), historyValue = history(), commentValue = comment()
    serve({
      'GET /rest/api/3/search/jql': () => ({ issues: [value], isLast: true }),
      'GET /rest/api/3/issue/ABC-1/changelog': () => ({ values: [historyValue], isLast: true, total: 1 }),
      'GET /rest/api/3/issue/ABC-1/comment': () => ({ comments: [commentValue], startAt: 0, maxResults: 100, total: 1 }),
    })
    const result = await pollJira(h.ctx, CONFIG, new AbortController().signal)
    expect(result).toEqual({ read: 3, unreadable: 0 })
    expect(h.receive.mock.calls.map(call => call[0].meta.change).sort()).toEqual(['commented', 'created', 'transitioned'])
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    // The created issue mentions the agent and its reporter is on the allowed list, so it is explicit.
    expect(h.engine.candidate(key('jira', 'ABC-1', 'created', value.fields.created))?.strength).toBe('explicit')
    expect(h.store.get(KV.jira.cursor('jira'))?.scope).toContain('ABC')

    await pollJira(h.ctx, CONFIG, new AbortController().signal)
    expect(await h.receive.mock.results.at(-1)!.value).toBe('duplicate')
  })
  it('reads a Server changelog through the issue expansion, not the Cloud-only changelog resource', async () => {
    const h = host()
    const value = issue(), historyValue = history()
    const calls = serve({
      'GET /rest/api/2/search': () => ({ issues: [value], startAt: 0, total: 1 }),
      'GET /rest/api/2/issue/ABC-1': () => ({ ...value, changelog: { startAt: 0, maxResults: 1, total: 1, histories: [historyValue] } }),
    })
    const config = JiraConfigSchema.parse({ ...SERVER_CONFIG, changes: [{ change: 'created' }, { change: 'updated' }, { change: 'transitioned' }] })
    const result = await pollJira(h.ctx, config, new AbortController().signal)
    expect(result).toEqual({ read: 2, unreadable: 0 })
    expect(h.receive.mock.calls.map(call => call[0].meta.change).sort()).toEqual(['created', 'transitioned'])
    expect(calls.map(call => call.url.pathname)).toEqual(['/rest/api/2/search', '/rest/api/2/issue/ABC-1'])
    expect(calls[1]!.url.searchParams.get('expand')).toBe('changelog')
    expect(calls.some(call => call.url.pathname.endsWith('/changelog'))).toBe(false)
  })
  it('does not read the changelog or comments when only new issues are listened to', async () => {
    const h = host()
    const value = issue()
    const calls = serve({ 'GET /rest/api/3/search/jql': () => ({ issues: [value], isLast: true }) })
    const config = JiraConfigSchema.parse({ ...CONFIG, changes: [{ change: 'created' }] })
    expect((await pollJira(h.ctx, config, new AbortController().signal)).read).toBe(1)
    expect(calls.map(call => call.url.pathname)).toEqual(['/rest/api/3/search/jql'])
  })
  it('drops a comment written by the agent account', async () => {
    const h = host()
    const value = issue()
    serve({
      'GET /rest/api/3/search/jql': () => ({ issues: [value], isLast: true }),
      'GET /rest/api/3/issue/ABC-1/comment': () => ({ comments: [comment('mine', { author: { accountId: 'agent-account', displayName: 'Agent', accountType: 'app' } })], startAt: 0, maxResults: 100, total: 1 }),
    })
    const config = JiraConfigSchema.parse({ ...CONFIG, changes: [{ change: 'commented' }] })
    expect((await pollJira(h.ctx, config, new AbortController().signal)).read).toBe(0)
    expect(h.receive).not.toHaveBeenCalled()
  })
})

describe('jira thread context and channel', () => {
  it('reads the issue and its comments by page', async () => {
    const h = host()
    const value = issue()
    serve({
      'GET /rest/api/3/issue/ABC-1': () => value,
      'GET /rest/api/3/issue/ABC-1/comment': () => ({ comments: [comment()], startAt: 0, maxResults: 50, total: 2 }),
    })
    const trigger = createdTrigger(value, CONFIG)!
    const part = await jiraThreadContext.read(h.commands, trigger, 'thread', undefined, CONFIG)
    expect(part.messages[0]).toMatchObject({ id: 'issue', from: 'u1', at: value.fields.created })
    expect(part.messages[0]!.text).toContain('Fix the login page')
    expect(part.messages[1]).toMatchObject({ id: 'c1', from: 'u1', text: 'Looks good' })
    expect(part.next).toBe('1')
    const root = await jiraThreadContext.read(h.commands, trigger, 'root', undefined, CONFIG)
    expect(root.messages).toHaveLength(1)
  })
  it('posts a reply once, records a hidden property, and settles a deleted issue as gone', async () => {
    const h = host()
    const message = { id: 'm1', channel: { source: 'jira', thread: 'jira:ABC-1', address: { issue: 'ABC-1', project: 'ABC' } },
      text: 'Working on it', kind: 'reply' as const, ticketId: 't1' }
    let posted: string | undefined, property: string | undefined
    serve({
      'POST /rest/api/3/issue/ABC-1/comment': (_url, init) => { posted = String(init.body); return comment('posted') },
      'PUT /rest/api/3/issue/ABC-1/properties/dsh-superagent-m1': (_url, init) => { property = String(init.body); return {} },
    })
    expect(await sendJira({ commands: h.commands }, message, CONFIG)).toBe('sent')
    expect(posted).toContain('Working on it')
    expect(posted).not.toContain('dsh-superagent')
    expect(posted).toContain('"type":"doc"')
    expect(JSON.parse(property!)).toMatchObject({ value: { message: 'm1' } })

    const postedBefore = host()
    serve({ 'GET /rest/api/3/issue/ABC-1/properties/dsh-superagent-m1': () => ({ value: { message: 'm1' } }) })
    expect(await sendJira({ commands: postedBefore.commands }, message, CONFIG)).toBe('sent')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)

    const missing = host()
    serve({ 'POST /rest/api/3/issue/ABC-1/comment': () => new Response(JSON.stringify({ errorMessages: ['Issue does not exist'] }), { status: 404 }) })
    expect(await sendJira({ commands: missing.commands }, message, CONFIG)).toBe('gone')
  })
})

describe('jira plugin', () => {
  it('registers the kind and reports setup, then unregisters on disposal', async () => {
    const h = host({}, false)
    serve({ 'GET /rest/api/3/search/jql': () => ({ issues: [], isLast: true }) })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: { ...h, context: h.context }, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(h.sources.kind('jira')).toBe(jiraKind)
    await vi.waitFor(() => expect(h.health.jira?.state).toBe('ready'))
    for (const dispose of disposers) await dispose()
    expect(h.sources.kind('jira')).toBeUndefined()
    expect(h.health.jira).toBeUndefined()
  })
})
