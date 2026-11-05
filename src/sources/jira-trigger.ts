/** Normalizes Jira issues, issue changes, and comments into domain Triggers. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { JiraChange, JiraComment, JiraHistory, JiraIssue, JiraUser } from './jira-client.ts'
import { jiraBodyText, jiraHuman, jiraTime, jiraUserId, jiraUserName } from './jira-client.ts'
import type { JiraConfig } from './jira.ts'

export const SOURCE = 'jira'
export const jiraThreadId = (issue: string): string => issue
export const jiraIssueUrl = (config: Pick<JiraConfig, 'site'>, issue: string): string => `${config.site}/browse/${issue}`
/** Reply address of an issue: the issue key, its project for the Source's allowed() check, and the page people open. */
export const jiraChannel = (config: Pick<JiraConfig, 'site' | 'project'>, issue: string, instance = SOURCE): ChannelRef =>
  ({ source: instance, thread: `${instance}:${jiraThreadId(issue)}`, address: { issue, project: config.project, url: jiraIssueUrl(config, issue) } })
/** True when `text` mentions the configured agent display name, as Jira renders a user mention. */
export function jiraMentioned(text: string, agentName: string): boolean {
  if (!agentName.trim()) return false
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])@${escapeRegExp(agentName.trim())}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}
/** True when Jira reports that this account made the change, so the Source keeps the agent's own writes out of the domain. */
export const jiraAgentAuthored = (user: JiraUser | undefined, config: Pick<JiraConfig, 'agentAccount'>): boolean =>
  !!config.agentAccount && !!jiraUserId(user) && sameName(jiraUserId(user), config.agentAccount)
function actor(user: JiraUser | undefined, instance = SOURCE): Pick<Trigger, 'actor' | 'human'> {
  return { actor: { source: instance, id: jiraUserId(user) }, human: jiraHuman(user) }
}
const issueType = (issue: JiraIssue): string => issue.fields.issuetype?.name ?? ''
const summary = (issue: JiraIssue): string => issue.fields.summary
const body = (issue: JiraIssue): string => jiraBodyText(issue.fields.description)
/** The common fields of every issue-scoped Trigger. */
function base(issue: JiraIssue, config: JiraConfig, change: JiraChange, at: string, text: string, user: JiraUser | undefined,
  meta: Record<string, unknown>, instance = SOURCE): Trigger {
  return { id: key(instance, issue.key, change, String(meta.version ?? at)), source: instance,
    threads: [{ source: instance, id: jiraThreadId(issue.key) }], ...actor(user, instance), at: jiraTime(at), text,
    ...(jiraMentioned(text, config.agentName) ? { addressed: 'mention' as const } : {}),
    channel: jiraChannel(config, issue.key, instance), url: jiraIssueUrl(config, issue.key),
    meta: { change, issue: issue.key, project: issue.fields.project?.key ?? config.project, issueType: issueType(issue),
      summary: summary(issue), ...meta } }
}
/** The Trigger for an issue that appeared since the cursor. */
export function createdTrigger(issue: JiraIssue, config: JiraConfig, instance = SOURCE): Trigger | undefined {
  if (jiraAgentAuthored(issue.fields.reporter, config)) return undefined
  const text = `${issue.key}: ${summary(issue)}${body(issue) ? `\n\n${body(issue)}` : ''}`
  return base(issue, config, 'created', issue.fields.created, text, issue.fields.reporter, { version: issue.fields.created }, instance)
}
const show = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
const own = (item: Record<string, unknown>, name: string): unknown => Object.hasOwn(item, name) ? item[name] : undefined
function changeLine(item: { field: string; fromString?: unknown; toString?: unknown; from?: unknown; to?: unknown }): string {
  const record = item as unknown as Record<string, unknown>
  const before = own(record, 'fromString') ?? item.from
  const after = own(record, 'toString') ?? item.to
  return `${item.field}: ${show(before) || '(empty)'} → ${show(after) || '(empty)'}`
}
/**
 * The Trigger for one changelog history. A status item is a transition; any other item is an update, so a history that
 * changes both reports only the transition when that kind is enabled.
 */
export function historyTrigger(issue: JiraIssue, history: JiraHistory, config: JiraConfig, instance = SOURCE): Trigger | undefined {
  if (jiraAgentAuthored(history.author, config)) return undefined
  const change: JiraChange = history.items.some(item => item.field === 'status') ? 'transitioned' : 'updated'
  if (!config.changes.some(item => item.change === change)) return undefined
  const lines = history.items.map(changeLine).filter(Boolean)
  const text = `${issue.key}: ${summary(issue)}${lines.length ? `\n\n${lines.join('\n')}` : ''}`
  return base(issue, config, change, history.created, text, history.author,
    { version: history.id, historyId: history.id, fields: history.items.map(item => item.field) }, instance)
}
/** The Trigger for a comment, including an edited comment as a new version. */
export function commentTrigger(issue: JiraIssue, comment: JiraComment, config: JiraConfig, instance = SOURCE): Trigger | undefined {
  if (jiraAgentAuthored(comment.author, config)) return undefined
  const author = jiraUserName(comment.author)
  // The worker sees the Trigger text, not the assessment's Thread window, so a comment carries the issue's description too.
  const description = body(issue)
  const text = `${issue.key}: ${summary(issue)}${description ? `\n\n${description}` : ''}\n\n${author ? `Comment by ${author}` : 'Comment'}: ${jiraBodyText(comment.body)}`
  return base(issue, config, 'commented', comment.updated ?? comment.created, text, comment.author,
    { version: `${comment.id}:${comment.updated ?? comment.created}`, commentId: comment.id, authorName: author }, instance)
}
/** Every Trigger one polled issue and its recent history produce, filtered by the configured change kinds. */
export function issueTriggers(issue: JiraIssue, histories: JiraHistory[], comments: JiraComment[], config: JiraConfig,
  since: string, instance = SOURCE): Trigger[] {
  const changes = new Set(config.changes.map(item => item.change))
  const at = (value: string): number => Date.parse(value)
  const triggers: Trigger[] = []
  if (changes.has('created') && at(issue.fields.created) >= at(since)) {
    const trigger = createdTrigger(issue, config, instance)
    if (trigger) triggers.push(trigger)
  }
  if (changes.has('updated') || changes.has('transitioned')) {
    for (const history of histories) {
      // A history written at creation describes the issue's initial values, which `created` already reports.
      if (at(history.created) < at(since) || at(history.created) <= at(issue.fields.created)) continue
      const trigger = historyTrigger(issue, history, config, instance)
      if (trigger) triggers.push(trigger)
    }
  }
  if (changes.has('commented')) {
    for (const comment of comments) {
      if (at(comment.updated ?? comment.created) < at(since)) continue
      const trigger = commentTrigger(issue, comment, config, instance)
      if (trigger) triggers.push(trigger)
    }
  }
  return triggers
}
