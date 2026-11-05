/** GitLab Source kind, configuration form, policy, polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { GitlabClient, type GitlabIssue, type GitlabMergeRequest, type GitlabWorkKind } from './gitlab-client.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import {
  gitlabRef, gitlabThreadId, gitlabThreadKey, gitlabWebUrl, issueTrigger, mergeRequestTrigger,
  noteTrigger, SOURCE, type GitlabRef,
} from './gitlab-trigger.ts'
import { health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { runInstances } from './runs.ts'

export { GITLAB_WORK_KINDS, GitlabClient, GitlabError, gitlabHuman, gitlabResource, gitlabTime, gitlabUserName } from './gitlab-client.ts'
export type { GitlabIssue, GitlabMergeRequest, GitlabNote, GitlabUser, GitlabWorkKind } from './gitlab-client.ts'
export { gitlabAgentAuthored, gitlabChannel, gitlabMentioned, gitlabRef, gitlabThreadId, gitlabThreadKey, gitlabWebUrl,
  issueTrigger, mergeRequestTrigger, noteTrigger } from './gitlab-trigger.ts'
export { gitlabLink, sendGitlab } from './gitlab-channel.ts'
export { gitlabThreadContext } from './gitlab-read.ts'

/**
 * One GitLab Source instance. An empty site, project or token keeps the kind's default instance valid and disabled; the
 * poll loop then reports what is missing rather than receiving anything. The token stays in this deployment's local settings.
 */
const GitlabConfigShape = z.object({
  site: z.string().trim().default('https://gitlab.com').transform(value => value.replace(/\/+$/, '')),
  project: z.string().trim().default(''),
  token: z.string().trim().default(''),
  agentAccount: z.string().trim().default(''),
  observeIssues: z.boolean().default(false),
  observeMrs: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export const GitlabConfigSchema = GitlabConfigShape
  .refine(config => !config.site || /^https?:\/\/[^\s]+$/i.test(config.site), { message: 'The site must be an http(s) URL', path: ['site'] })
  .refine(config => !config.project || /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(config.project),
    { message: 'The project is written as namespace/project', path: ['project'] })
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
/** Whether the instance names everything a poll needs; until it does, the loop reports `gitlabUnset`. */
export const gitlabReady = (config: GitlabConfig): boolean => !!config.site && !!config.project && !!config.token
const OBSERVED = { issues: 'observeIssues', pulls: 'observeMrs', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
const ROW_LABELS: Record<Scope, Localized> = {
  issues: { zh: '新 Issue', en: 'New issues' },
  pulls: { zh: '新合并请求', en: 'New merge requests' },
  comments: { zh: '评论', en: 'Notes' },
}
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'comment') return 'comments'
  if (meta.kind === 'mr') return 'pulls'
  return meta.kind === 'issue' ? 'issues' : undefined
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '轮询一个 GitLab 项目，接收新 Issue、新合并请求、评论以及合并请求的合并或关闭。',
    en: 'Polls one GitLab project and receives new issues, new merge requests, notes, and merge request merges or closes.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'site', type: 'text', pattern: 'https?://[^\\s]+', label: { zh: 'GitLab 站点', en: 'GitLab site' },
      hint: { zh: '例如 https://gitlab.com，或自建实例的地址；只读这个站点上的一个项目。',
        en: 'For example https://gitlab.com, or a self-hosted instance address; the Source reads one project on this site.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-/]+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project 或 group/subgroup/project；只接收这个项目的内容。',
        en: 'Written group/project or group/subgroup/project; only this project is received.' } },
    { key: 'token', type: 'text', secret: true, label: { zh: '访问令牌', en: 'Access token' },
      hint: { zh: '一个 GitLab personal access token，作用域 api（或 read_api 只读；回复评论需要 api）。令牌保存在本机设置里，不写入 Trigger 或执行环境。',
        en: 'A GitLab personal access token with the api scope (read_api is enough to read; api is needed to post notes). The token stays in local settings and is never written to Triggers or the execution environment.' } },
    { key: 'agentAccount', type: 'text', label: { zh: '智能体的 GitLab 账号', en: 'Agent GitLab account' },
      hint: { zh: '这个账号做出的 Issue、合并请求和评论不接收；名单里的用户 @ 这个用户名时，变更成为明确的请求。',
        en: 'Issues, merge requests and notes by this account are not received; a listed user who mentions this username makes the change an explicit request.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。',
        en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive notes in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。',
        en: 'Notes on issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'GitLab 对 API 有速率限制；项目活跃时不要设得太小。', en: 'The GitLab API is rate-limited; do not poll too often on a busy project.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['gitlab'],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope({ meta }, config) {
    if (!sameName(String(meta.project ?? ''), config.project)) return { listened: false, reason: 'gitlab_project_not_listened' }
    const row = scopeOf(meta)
    if (!row) return { listened: false, reason: 'gitlab_kind_not_listened' }
    return { listened: true, observed: config[OBSERVED[row]], row }
  },
  channel: {
    allowed: (address, config) => (address.kind === 'issue' || address.kind === 'mr') && sameName(address.project ?? '', config.project),
    send: sendGitlab,
    link: gitlabLink,
  },
  threadContext: gitlabThreadContext,
  // A project page names its work item; `#12` and `12` may name an issue or a merge request because GitLab numbers them apart.
  find(query, instance) {
    const id = instance?.id ?? SOURCE
    const text = query.trim()
    const issue = /^#(\d+)$/.exec(text)?.[1] ?? /\/issues\/(\d+)/.exec(text)?.[1]
    const merge = /^!\s?(\d+)$/.exec(text)?.[1] ?? /\/merge_requests\/(\d+)/.exec(text)?.[1]
    const bare = /^#?(\d+)$/.exec(text)?.[1]
    return { threads: [...new Set([
      ...issue ? [`${id}:issue:${issue}`] : [], ...merge ? [`${id}:mr:${merge}`] : [],
      ...bare ? [`${id}:issue:${bare}`, `${id}:mr:${bare}`] : [],
    ])], terms: [] }
  },
  policy: {
    unnamed: { person: { zh: 'GitLab 用户', en: 'GitLab user' }, bot: { zh: 'GitLab 机器人', en: 'GitLab bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 用户', en: 'GitLab users who may originate work' },
        hint: { zh: '填写 GitLab 用户名（@ 后面的部分）；比较不区分大小写。',
          en: 'Use the GitLab username after the at sign; comparison is case-insensitive.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose notes may become candidates' },
        hint: { zh: '名单里的机器人账号的评论成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的评论不接收。',
          en: 'A note by a bot account on this list becomes an inferred candidate for an assessment; such a note never makes an explicit request or stops a ticket. Other bots\' notes are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    ],
    explicit: { zh: '名单里的用户在 Issue、合并请求或评论里 @ 智能体的 GitLab 用户名。',
      en: 'A listed user mentions the agent\'s GitLab username in an issue, a merge request or a note.' },
    rows(stored) {
      const config = GitlabConfigShape.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      return (Object.keys(OBSERVED) as Scope[]).map(id => ({ id, label: ROW_LABELS[id], note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_SITE', description: { zh: '这个来源监听的 GitLab 站点', en: 'The GitLab site this Source reads' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/project',
        en: 'The project this Source reads, as group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的 GitLab 工作项种类：issue 或 mr；工单不是从 GitLab 来的时为空',
        en: 'The GitLab work item kind that started the ticket, issue or mr; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或合并请求的 IID；不是来自 GitLab 时为空',
        en: 'The IID of the issue or merge request that started the ticket; empty when it did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '接下工单的 Issue 或合并请求的页面地址；不是来自 GitLab 时为空',
        en: 'The page of the issue or merge request that started the ticket; empty when it did not start on GitLab' } },
    ],
    values: ({ config, instance, trigger }) => {
      const fromGitlab = trigger?.source === instance.id ? trigger : undefined
      const meta = fromGitlab?.meta ?? {}
      const ref = fromGitlab && Number.isInteger(Number(meta.iid)) && Number(meta.iid) > 0
        ? { kind: meta.workKind === 'mr' ? 'mr' as const : 'issue' as const, iid: Number(meta.iid) } : undefined
      return { DSH_SUPERAGENT_GITLAB_SITE: config.site, DSH_SUPERAGENT_GITLAB_PROJECT: config.project,
        DSH_SUPERAGENT_GITLAB_KIND: ref?.kind ?? '', DSH_SUPERAGENT_GITLAB_NUMBER: ref ? String(ref.iid) : '',
        DSH_SUPERAGENT_GITLAB_URL: ref ? gitlabWebUrl(config, ref) : '' }
    },
  },
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    // One polling run per enabled GitLab instance; runInstances starts and stops them as settings change.
    const running = runInstances(ctx.orchestrator, gitlabKind, watch, controller.signal)
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>()
    if (!config) ctx.report('gitlab', health('paused', 'sourceOff'))
    else if (!gitlabReady(config)) ctx.report('gitlab', health('paused', 'gitlabUnset'))
    else {
      const at = new Date().toISOString()
      try {
        const result = await pollGitlab(ctx, config, signal)
        failures = 0
        ctx.report('gitlab', { state: 'ready', detail: `${result.read} changes, ${result.unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; `failuresBeforeError` in a row need a person.
        if (!signal.aborted && failures >= config.failuresBeforeError) {
          ctx.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
export interface GitlabPollResult { read: number; unreadable: number }
/**
 * One poll: read the project's issues and merge requests changed since the cursor together with their notes, then the
 * Threads of open Tickets. The cursor moves only after every Trigger was stored, so an interrupted round replays from a
 * few seconds earlier; deterministic Trigger ids make that replay harmless.
 */
export async function pollGitlab(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<GitlabPollResult> {
  const started = new Date().toISOString()
  const scope = [config.site, config.project, config.observeIssues, config.observeMrs, config.observeComments].join('\n')
  const previous = ctx.state.get(KV.gitlab.cursor(ctx.instance.id))
  const since = previous?.scope === scope ? previous.since : cursorAt(started)
  const client = new GitlabClient(config, signal)
  const result: GitlabPollResult = { read: 0, unreadable: 0 }
  // Issues and merge requests are polled even when project-wide observation is off, because a mention in a new item
  // or note must still reach the agent; observation only widens what is received beyond those addressed to it.
  await pollIssues(ctx, client, config, since, result, signal)
  await pollMergeRequests(ctx, client, config, since, result, signal)
  await pollSubscribed(ctx, client, config, signal, result)
  ctx.atomic(() => ctx.state.set(KV.gitlab.cursor(ctx.instance.id), { scope, since: cursorAt(started) }))
  return result
}
async function pollIssues(ctx: SourceContext, client: GitlabClient, config: GitlabConfig, since: string,
  result: GitlabPollResult, signal: AbortSignal): Promise<void> {
  const listed = await client.issues(since)
  result.unreadable += listed.skipped
  for (const issue of listed.items) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the read')
    if (Date.parse(issue.created_at) >= Date.parse(since)) {
      const trigger = issueTrigger(issue, config, ctx.instance.id)
      if (trigger && (config.observeIssues || trigger.addressed)) { await ctx.receive(trigger); result.read += 1 }
    }
    await intakeNotes(ctx, client, config, 'issue', issue, since, result, signal)
    describe(ctx, config, 'issue', issue)
  }
}
async function pollMergeRequests(ctx: SourceContext, client: GitlabClient, config: GitlabConfig, since: string,
  result: GitlabPollResult, signal: AbortSignal): Promise<void> {
  const listed = await client.mergeRequests(since)
  result.unreadable += listed.skipped
  for (const merge of listed.items) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the read')
    if (Date.parse(merge.created_at) >= Date.parse(since)) {
      const trigger = mergeRequestTrigger(merge, config, ctx.instance.id)
      if (trigger && (config.observeMrs || trigger.addressed)) { await ctx.receive(trigger); result.read += 1 }
    }
    await intakeNotes(ctx, client, config, 'mr', merge, since, result, signal)
    observeMerge(ctx, config, merge)
    describe(ctx, config, 'mr', merge)
  }
}
async function intakeNotes(ctx: SourceContext, client: GitlabClient, config: GitlabConfig, kind: GitlabWorkKind,
  item: GitlabIssue | GitlabMergeRequest, since: string, result: GitlabPollResult, signal: AbortSignal): Promise<void> {
  const notes = await client.allNotes(kind, item.iid)
  for (const note of notes) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the read')
    if (Date.parse(note.updated_at ?? note.created_at) < Date.parse(since)) continue
    const trigger = noteTrigger(kind, item, note, config, ctx.instance.id)
    if (!trigger || (!config.observeComments && !trigger.addressed)) continue
    await ctx.receive(trigger)
    result.read += 1
  }
}
/** Polls each subscribed GitLab Thread within the horizon, so a mention on a Thread the agent already follows is read even when project-wide comment observation is off. */
async function pollSubscribed(ctx: SourceContext, client: GitlabClient, config: GitlabConfig, signal: AbortSignal,
  result: GitlabPollResult): Promise<void> {
  await pollEach(ctx, ctx.instance.id, () => signal.aborted, async thread => {
    const ref = gitlabRef(thread.ref.id)
    if (!ref) throw new Error('Subscribed thread has no GitLab issue or merge request number')
    const since = ctx.state.get(KV.gitlab.thread(thread.key)) ?? thread.createdAt
    if (ref.kind === 'mr') {
      const merge = await client.mergeRequest(ref.iid)
      observeMerge(ctx, config, merge)
      await intakeNotes(ctx, client, config, 'mr', merge, since, result, signal)
      describe(ctx, config, 'mr', merge)
    } else {
      const issue = await client.issue(ref.iid)
      await intakeNotes(ctx, client, config, 'issue', issue, since, result, signal)
      describe(ctx, config, 'issue', issue)
    }
    ctx.state.set(KV.gitlab.thread(thread.key), cursorAt(new Date().toISOString()))
  })
}
function describe(ctx: SourceContext, config: GitlabConfig, kind: GitlabWorkKind, item: GitlabIssue | GitlabMergeRequest): void {
  const ref: GitlabRef = { kind, iid: item.iid }
  ctx.threads.describe(gitlabThreadKey(ref, ctx.instance.id), { label: `${kind === 'mr' ? '!' : '#'}${item.iid} ${item.title}`.trim(),
    url: item.web_url ?? gitlabWebUrl(config, ref),
    facts: { project: { label: { zh: '项目', en: 'Project' }, value: config.project },
      state: { label: { zh: '状态', en: 'State' }, value: item.state } } })
}
const branchNamed = (ticket: { execution?: { name?: string } }, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
function originMerge(ctx: SourceContext, ticketId: string, iid: number): boolean {
  const ticket = ctx.tickets.get(ticketId)
  const origin = ticket && ctx.triggers.get(ticket.origin.triggerId)
  return origin?.source === ctx.instance.id && origin.meta.workKind === 'mr' && Number(origin.meta.iid) === iid
}
/**
 * Binds an open merge request to the one open Ticket it belongs to: the Ticket that started from it, or the agent's
 * own merge request whose source branch names that Ticket. A merged or closed request closes the Thread those Tickets follow.
 */
function observeMerge(ctx: SourceContext, config: GitlabConfig, merge: GitlabMergeRequest): void {
  const ref: GitlabRef = { kind: 'mr', iid: merge.iid }
  const thread = gitlabThreadKey(ref, ctx.instance.id)
  const follows = (ticketId: string): boolean =>
    !!ctx.tickets.get(ticketId)?.follows?.some(follow => follow.thread === thread)
  if (merge.state === 'merged' || merge.state === 'closed') {
    if (!ctx.tickets.open().some(ticket => follows(ticket.id))) return
    ctx.tickets.threadClosed({ source: ctx.instance.id, id: gitlabThreadId(ref) }, merge.state === 'merged' ? 'merged' : 'closed',
      merge.merged_at ?? merge.closed_at ?? merge.updated_at)
    return
  }
  const owner = ctx.tickets.open().find(ticket => follows(ticket.id))
  if (owner && !owner.follows?.some(follow => follow.thread === thread && follow.closed)) return
  const started = ctx.tickets.open().filter(ticket => originMerge(ctx, ticket.id, merge.iid))
  const branch = !!config.agentAccount && sameName(merge.author?.username ?? '', config.agentAccount)
    ? ctx.tickets.open().filter(ticket => branchNamed(ticket, merge.source_branch)) : []
  const candidates = [...new Map([...started, ...branch].map(ticket => [ticket.id, ticket])).values()]
  // A merge request belongs to at most one Ticket; ambiguous branch names wait for the Executor to say which one it opened.
  if (candidates.length !== 1) return
  const ticket = candidates[0]!
  if (owner && owner.id !== ticket.id) return
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticket.id, { source: ctx.instance.id, id: gitlabThreadId(ref) }, branch.includes(ticket))
    ctx.threads.patch(thread, { kind: 'mr', iid: merge.iid, project: config.project, title: merge.title,
      url: merge.web_url ?? gitlabWebUrl(config, ref) })
  })
}
