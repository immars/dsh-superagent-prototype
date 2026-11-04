/** Jira Thread context: an issue's description and its comments as the messages an assessment reads. */
import type { ContextMessage, ThreadContext } from './kind.ts'
import type { JiraConfig } from './jira.ts'
import { JiraClient, jiraBodyText, jiraHuman, jiraTime, jiraUserId, jiraUserName, type JiraComment, type JiraIssue } from './jira-client.ts'
import { jiraIssueUrl, SOURCE } from './jira-trigger.ts'

const PAGE_SIZE = 50
const issueMessage = (issue: JiraIssue): ContextMessage => ({
  id: 'issue', from: jiraUserId(issue.fields.reporter) || jiraUserName(issue.fields.reporter),
  at: jiraTime(issue.fields.created),
  text: [issue.fields.summary, jiraBodyText(issue.fields.description)].filter(Boolean).join('\n\n'),
})
const commentMessage = (comment: JiraComment): ContextMessage => ({
  id: comment.id, from: jiraUserId(comment.author) || jiraUserName(comment.author),
  at: jiraTime(comment.updated ?? comment.created), text: jiraBodyText(comment.body),
  ...jiraHuman(comment.author) ? {} : { bot: true as const },
})
/** Gives assessments the issue's own text and its comments; a Jira comment thread is flat, so both root and parent are the issue. */
export const jiraThreadContext: ThreadContext<JiraConfig> = {
  messageId: trigger => trigger.meta.change === 'commented' ? String(trigger.meta.commentId ?? '') : 'issue',
  async read(_commands, trigger, part, cursor, config) {
    const issueKey = String(trigger.meta.issue ?? trigger.threads[0]?.id ?? '')
    if (!config.site || !config.token || !issueKey) {
      return { messages: [], body: { status: 'jira_unconfigured', messages: [] }, status: 'jira_unconfigured' }
    }
    const client = new JiraClient(config)
    const issue = await client.issue(issueKey)
    const first = issueMessage(issue)
    if (part === 'root' || part === 'parent') {
      return { messages: [first], body: { status: 'jira_issue', issue: issueView(issue, config), messages: [first] }, status: 'jira_issue' }
    }
    const startAt = Number(cursor ?? '0')
    const page = await client.comments(issue.key, Number.isFinite(startAt) && startAt > 0 ? startAt : 0, PAGE_SIZE)
    const messages = [first, ...page.comments.map(comment => commentMessage(comment))]
    return { messages, ...(page.next === undefined ? {} : { next: String(page.next) }),
      body: { status: 'jira_issue', issue: issueView(issue, config), messages } }
  },
}
function issueView(issue: JiraIssue, config: JiraConfig): Record<string, unknown> {
  return { key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name ?? '',
    issueType: issue.fields.issuetype?.name ?? '', url: jiraIssueUrl(config, issue.key), source: SOURCE }
}
