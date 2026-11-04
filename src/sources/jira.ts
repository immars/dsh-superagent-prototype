/** JIRA Source kind, configuration form, policy, polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { JIRA_CHANGES, JiraClient, jiraJql, type JiraChange } from './jira-client.ts'
import { jiraLink, sendJira } from './jira-channel.ts'
import { jiraThreadContext } from './jira-read.ts'
import { issueTriggers, jiraIssueUrl, SOURCE } from './jira-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'

export { JIRA_CHANGES, type JiraChange } from './jira-client.ts'
export { adfDocument, adfText, jiraBodyText, jiraJql, jiraTime, JiraError } from './jira-client.ts'
export { createdTrigger, commentTrigger, historyTrigger, issueTriggers, jiraChannel, jiraIssueUrl, jiraMentioned } from './jira-trigger.ts'
export { jiraLink, sendJira } from './jira-channel.ts'
export { jiraThreadContext } from './jira-read.ts'

const ChangeSchema = z.object({ change: z.enum(JIRA_CHANGES) }).strict()
export const DEFAULT_CHANGES: readonly { change: JiraChange }[] = JIRA_CHANGES.map(change => ({ change }))
/**
 * One Jira Source instance. An empty site or project keeps the kind's default instance valid and disabled; the poll loop
 * then reports what is missing rather than receiving anything. The token is stored in this deployment's local settings.
 */
export const JiraConfigSchema = z.object({
  site: z.string().trim().default('').transform(value => value.replace(/\/+$/, '')),
  platform: z.enum(['cloud', 'server']).default('cloud'),
  auth: z.enum(['basic', 'bearer']).default('basic'),
  user: z.string().trim().default(''),
  token: z.string().trim().default(''),
  project: z.string().trim().default(''),
  issueTypes: z.string().trim().default(''),
  jql: z.string().trim().max(2000).default(''),
  agentAccount: z.string().trim().default(''),
  agentName: z.string().trim().default(''),
  changes: z.array(ChangeSchema).default([...DEFAULT_CHANGES])
    .refine(items => new Set(items.map(item => item.change)).size === items.length, 'Duplicate change types'),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
  .refine(config => !config.site || /^https?:\/\/[^\s]+$/i.test(config.site), { message: 'The site must be an http(s) URL', path: ['site'] })
  .refine(config => !config.project || /^[A-Za-z][A-Za-z0-9_-]*$/.test(config.project), { message: 'A project key starts with a letter', path: ['project'] })
  .refine(config => config.auth !== 'basic' || !config.token || !!config.user, { message: 'Basic authentication needs a user', path: ['user'] })
export type JiraConfig = z.infer<typeof JiraConfigSchema>
/** Whether the instance names everything a poll needs; until it does, the loop reports `jiraUnset`. */
export const jiraReady = (config: JiraConfig): boolean =>
  !!config.site && !!config.project && !!config.token && (config.auth === 'bearer' || !!config.user)
const CHANGE_LABELS: Record<JiraChange, Localized> = {
  created: { zh: '新建 Issue', en: 'New issue' },
  updated: { zh: '字段更新', en: 'Field update' },
  transitioned: { zh: '状态流转', en: 'Status transition' },
  commented: { zh: '评论', en: 'Comment' },
}
const OBSERVED: Localized = { zh: '接收', en: 'Received' }
const TYPES = (config: JiraConfig): string[] => config.issueTypes.split(',').map(type => type.trim()).filter(Boolean)
const ENABLED = (config: JiraConfig): Set<JiraChange> => new Set(config.changes.map(item => item.change))

export const jiraKind: SourceKind<JiraConfig> = {
  kind: SOURCE,
  title: { zh: 'JIRA', en: 'Jira' },
  description: { zh: '轮询指定 JIRA 项目里被改动的 Issue，按变更类型接收新建、字段更新、状态流转和评论。',
    en: 'Polls changed issues in one Jira project and receives new issues, field updates, status transitions, and comments by change kind.' },
  schema: JiraConfigSchema,
  fields: [
    { key: 'site', type: 'text', pattern: 'https?://[^\\s]+', label: { zh: 'JIRA 站点', en: 'Jira site' },
      hint: { zh: '例如 https://acme.atlassian.net；Server/DC 也可以带路径前缀。只读这个站点。',
        en: 'For example https://acme.atlassian.net; a Server/DC site may include a path prefix. The Source reads only this site.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z][A-Za-z0-9_-]*', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '项目 key，例如 ABC。只接收这个项目的 Issue。', en: 'A project key such as ABC. Only issues of this project are received.' } },
    { key: 'changes', type: 'rows', label: { zh: '接收的变更', en: 'Change kinds' },
      hint: { zh: '对应字段或状态的变化从 Issue 的变更记录读取；评论单独读取。',
        en: 'Field and status changes are read from the issue changelog; comments are read separately.' },
      columns: [{ key: 'change', type: 'select', label: { zh: '变更类型', en: 'Change kind' },
        options: JIRA_CHANGES.map(change => ({ value: change, label: CHANGE_LABELS[change] })) }] },
    { key: 'issueTypes', type: 'text', label: { zh: 'Issue 类型', en: 'Issue types' },
      hint: { zh: '逗号分隔，例如 Bug, Task；留空表示这个项目的全部类型。',
        en: 'Comma-separated, such as Bug, Task; empty receives every type in the project.' } },
    { key: 'user', type: 'text', label: { zh: '账号邮箱 / 用户名', en: 'Account email or username' },
      hint: { zh: 'Basic 认证时填写 JIRA Cloud 账号邮箱，或 Server/DC 的用户名；Bearer 认证可以留空。',
        en: 'For Basic authentication, the Jira Cloud account email or the Server/DC username; Bearer authentication may leave it empty.' } },
    { key: 'token', type: 'text', secret: true, label: { zh: 'API token / PAT', en: 'API token / PAT' },
      hint: { zh: 'JIRA Cloud 用 API token（建议只读作用域）；Server/DC 用 personal access token。令牌保存在本机设置里，不写入 Trigger 或执行环境。',
        en: 'An API token on Jira Cloud (read-only scope is enough) or a personal access token on Server/DC. The token stays in local settings and is never written to Triggers or the execution environment.' } },
    { key: 'platform', type: 'select', advanced: true, label: { zh: 'JIRA 平台', en: 'Jira platform' },
      options: [{ value: 'cloud', label: { zh: 'Cloud', en: 'Cloud' } }, { value: 'server', label: { zh: 'Server / Data Center', en: 'Server / Data Center' } }],
      hint: { zh: 'Cloud 用 REST API v3，Server/DC 用 v2。', en: 'Cloud uses REST API v3; Server/DC uses v2.' } },
    { key: 'auth', type: 'select', advanced: true, label: { zh: '认证方式', en: 'Authentication' },
      options: [{ value: 'basic', label: { zh: 'Basic（邮箱 + token）', en: 'Basic (user + token)' } }, { value: 'bearer', label: { zh: 'Bearer（PAT）', en: 'Bearer (PAT)' } }] },
    { key: 'agentAccount', type: 'text', advanced: true, label: { zh: '智能体的 JIRA 账号', en: 'Agent Jira account' },
      hint: { zh: '这个账号做出的变更不接收，避免把智能体自己的评论变成新的请求。Cloud 填 accountId，Server/DC 填用户名。',
        en: 'Changes by this account are not received, so the agent\'s own comments never start new work. Use the account id on Cloud, the username on Server/DC.' } },
    { key: 'agentName', type: 'text', advanced: true, label: { zh: '智能体的显示名', en: 'Agent display name' },
      hint: { zh: '名单里的用户在正文里 @ 这个名字时，变更成为明确的请求。填 JIRA 里显示的名字，不填斜杠。',
        en: 'An allowed user who mentions this name in the text makes the change an explicit request. Use the display name Jira shows, without the at sign.' } },
    { key: 'jql', type: 'text', advanced: true, label: { zh: '额外的 JQL', en: 'Extra JQL' },
      hint: { zh: '例如 labels = agent。会和项目、Issue 类型和更新时间一起组成查询。',
        en: 'For example labels = agent. It is combined with the project, issue types, and update cursor.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'JIRA 的 REST API 有速率限制；项目活跃时不要设得太小。', en: 'The Jira REST API is rate-limited; do not poll too often on a busy project.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['jira'],
  scope({ meta }, config) {
    const change = String(meta.change ?? '')
    if (!ENABLED(config).has(change as JiraChange)) return { listened: false, reason: 'change_not_listened' }
    if (!sameName(String(meta.project ?? ''), config.project)) return { listened: false, reason: 'project_not_listened' }
    const type = String(meta.issueType ?? '')
    const types = TYPES(config)
    if (types.length && !types.some(item => sameName(item, type))) return { listened: false, reason: 'issue_type_not_listened' }
    return { listened: true, observed: true, row: change }
  },
  channel: {
    allowed: (address, config) => !!address.issue && sameName(address.project ?? '', config.project),
    send: sendJira,
    link: jiraLink,
  },
  threadContext: jiraThreadContext,
  find(query) {
    const issue = /(?:^|\/browse\/|\b)([A-Za-z][A-Za-z0-9]+-\d+)\b/.exec(query)?.[1]
    return { threads: issue ? [`${SOURCE}:${issue.toUpperCase()}`] : [], terms: [] }
  },
  policy: {
    unnamed: { person: { zh: 'JIRA 用户', en: 'Jira user' }, bot: { zh: 'JIRA 自动化账号', en: 'Jira automation account' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 JIRA 用户', en: 'Jira users who may originate work' },
        hint: { zh: '填写 Cloud 的 accountId 或 Server/DC 的用户名；比较不区分大小写。',
          en: 'Use the Cloud account id or the Server/DC username; comparison is case-insensitive.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '变更可以成为候选的自动化账号', en: 'Automation accounts whose changes may become candidates' },
        hint: { zh: '名单里的账号（accountType 为 app）的变更成为推断的候选；它们不能发起明确的请求，也不能停止工单。',
          en: 'Changes by an account on this list (accountType app) become inferred candidates; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的用户做出变更，并在 Issue 或评论正文里 @ 智能体的 JIRA 显示名。',
      en: 'A listed user makes the change and mentions the agent\'s Jira display name in the issue or comment text.' },
    rows(stored) {
      const config = JiraConfigSchema.parse(stored)
      return config.changes.map(item => ({ id: item.change, label: CHANGE_LABELS[item.change], note: OBSERVED,
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_JIRA_SITE', description: { zh: '这个来源监听的 JIRA 站点', en: 'The Jira site this Source reads' } },
      { key: 'DSH_SUPERAGENT_JIRA_PROJECT', description: { zh: '这个来源监听的项目 key', en: 'The project key this Source reads' } },
      { key: 'DSH_SUPERAGENT_JIRA_ISSUE', description: { zh: '接下工单的 JIRA Issue key；工单不是从 JIRA 来的时为空',
        en: 'The Jira issue key that started the ticket; empty when the ticket did not start on Jira' } },
    ],
    values: ({ config, trigger }) => ({
      DSH_SUPERAGENT_JIRA_SITE: config.site,
      DSH_SUPERAGENT_JIRA_PROJECT: config.project,
      DSH_SUPERAGENT_JIRA_ISSUE: trigger?.source === SOURCE ? String(trigger.meta.issue ?? '') : '',
    }),
  },
}

export const name = 'dsh-superagent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(jiraKind), 'jira: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, jiraKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure escaping the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('jira', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('jira', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<JiraConfig>(SOURCE)
    if (!config) ctx.report('jira', health('paused', 'sourceOff'))
    else if (!jiraReady(config)) ctx.report('jira', health('paused', 'jiraUnset'))
    else {
      const at = new Date().toISOString()
      try {
        const result = await pollJira(ctx, config, signal)
        failures = 0
        ctx.report('jira', { state: 'ready', detail: `${result.read} changes, ${result.unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; `failuresBeforeError` in a row need a person.
        if (!signal.aborted && failures >= config.failuresBeforeError) {
          ctx.report('jira', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
export interface PollResult { read: number; unreadable: number }
/**
 * One poll: search the project for issues updated since the cursor, read the changes of each, and hand every
 * configured change kind to the Engine. The cursor moves only after every issue was stored, so an interrupted round
 * replays from a minute earlier; deterministic Trigger ids make that replay harmless.
 */
export async function pollJira(ctx: SourceContext, config: JiraConfig, signal: AbortSignal): Promise<PollResult> {
  const started = new Date().toISOString()
  const scope = [config.site, config.project, config.issueTypes, config.jql].join('\n')
  const previous = ctx.state.get(KV.jira.cursor)
  const since = previous?.scope === scope ? previous.since : cursorAt(started)
  const client = new JiraClient(config, signal)
  const found = await client.search(jiraJql(config, since))
  const changes = ENABLED(config)
  const types = TYPES(config)
  let read = 0
  for (const issue of found.issues) {
    if (signal.aborted) throw new Error('The Jira Source stopped during the read')
    if (!issue.fields.project?.key || !sameName(issue.fields.project.key, config.project)) continue
    if (types.length && !types.some(type => sameName(type, issue.fields.issuetype?.name ?? ''))) continue
    const histories = changes.has('updated') || changes.has('transitioned') ? await client.changelog(issue.key) : []
    const comments = changes.has('commented') ? await client.allComments(issue.key) : []
    for (const trigger of issueTriggers(issue, histories, comments, config, since)) {
      if (signal.aborted) throw new Error('The Jira Source stopped during the read')
      await ctx.receive(trigger)
      read += 1
    }
    ctx.threads.describe(`jira:${issue.key}`, { label: `${issue.key} ${issue.fields.summary}`.trim(), url: jiraIssueUrl(config, issue.key),
      facts: {
        project: { label: { zh: '项目', en: 'Project' }, value: issue.fields.project?.key ?? config.project },
        type: { label: { zh: '类型', en: 'Type' }, value: issue.fields.issuetype?.name ?? '' },
        status: { label: { zh: '状态', en: 'Status' }, value: issue.fields.status?.name ?? '' },
      } })
  }
  ctx.atomic(() => ctx.state.set(KV.jira.cursor, { scope, since: cursorAt(started) }))
  return { read, unreadable: found.skipped }
}
