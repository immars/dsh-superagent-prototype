/** Jira REST transport for the Jira Source: credentials, JQL search, changelogs, comments, and reply posting. */
import { z } from 'zod'
import { validItems } from '../infra/commands.ts'

/** Change kinds the Jira Source can receive; a Trigger carries exactly one. */
export const JIRA_CHANGES = ['created', 'updated', 'transitioned', 'commented'] as const
export type JiraChange = typeof JIRA_CHANGES[number]
/** The connection fields a Jira request needs. */
export interface JiraConnection {
  site: string
  platform: 'cloud' | 'server'
  auth: 'basic' | 'bearer'
  user: string
  token: string
}
export interface JiraQuery { project: string; issueTypes: string; jql: string }
/** HTTP and payload failures of the Jira API; `status` is Jira's response code when it sent one. */
export class JiraError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
export const JiraUserSchema = z.looseObject({
  accountId: z.string().nullish(), name: z.string().nullish(), displayName: z.string().nullish(),
  emailAddress: z.string().nullish(), accountType: z.string().nullish(),
}).nullish()
export type JiraUser = z.infer<typeof JiraUserSchema>
const JiraIssueFieldsSchema = z.looseObject({
  summary: z.string().default(''), description: z.unknown().nullish(),
  status: z.looseObject({ name: z.string().default('') }).nullish(),
  issuetype: z.looseObject({ name: z.string().default('') }).nullish(),
  priority: z.looseObject({ name: z.string().default('') }).nullish(),
  assignee: JiraUserSchema, reporter: JiraUserSchema,
  created: z.string(), updated: z.string(),
  labels: z.array(z.string()).default([]),
  project: z.looseObject({ key: z.string().default('') }).nullish(),
})
export const JiraIssueSchema = z.looseObject({ id: z.string(), key: z.string(), fields: JiraIssueFieldsSchema })
export type JiraIssue = z.infer<typeof JiraIssueSchema>
export const JiraCommentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  author: JiraUserSchema, body: z.unknown().nullish(),
  created: z.string(), updated: z.string().nullish(),
})
export type JiraComment = z.infer<typeof JiraCommentSchema>
const JiraHistoryItemSchema = z.looseObject({
  field: z.string().default(''), fieldtype: z.string().nullish(),
  from: z.unknown().nullish(), to: z.unknown().nullish(), fromString: z.unknown().nullish(), toString: z.unknown().nullish(),
})
export const JiraHistorySchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  author: JiraUserSchema, created: z.string(), items: z.array(JiraHistoryItemSchema).default([]),
})
export type JiraHistory = z.infer<typeof JiraHistorySchema>
const SearchSchema = z.looseObject({ issues: z.array(z.unknown()).default([]), nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(), startAt: z.number().int().default(0), total: z.number().int().default(0) })
const ChangelogPageSchema = z.looseObject({ values: z.array(z.unknown()).default([]), startAt: z.number().int().default(0),
  total: z.number().int().default(0), isLast: z.boolean().nullish() })
const CommentPageSchema = z.looseObject({ comments: z.array(z.unknown()).default([]), startAt: z.number().int().default(0),
  maxResults: z.number().int().default(0), total: z.number().int().default(0) })
const PAGE_SIZE = 100
export interface CommentPage { comments: JiraComment[]; next?: number | undefined }
export interface SearchResult { issues: JiraIssue[]; skipped: number }
/** The Jira user id in the Source's identity space: the account id on Cloud, the username on Server/DC. */
export const jiraUserId = (user: JiraUser | undefined): string => user?.accountId ?? user?.name ?? ''
export const jiraUserName = (user: JiraUser | undefined): string =>
  user?.displayName ?? user?.emailAddress ?? user?.name ?? ''
/** True unless Jira marks the account as an app, such as an automation or Connect user. */
export const jiraHuman = (user: JiraUser | undefined): boolean => !!user && user.accountType !== 'app'
/** Renders Jira's Atlassian Document Format, and plain-text fields of Server/DC, as text. */
export function adfText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(adfText).join('')
  if (!value || typeof value !== 'object') return ''
  const node = value as { type?: string; text?: unknown; content?: unknown; attrs?: Record<string, unknown> }
  if (node.type === 'text' && typeof node.text === 'string') return node.text
  if (node.type === 'mention') {
    const name = typeof node.attrs?.text === 'string' ? node.attrs.text : node.attrs?.displayName
    return typeof name === 'string' && name ? `@${name.replace(/^@/, '')}` : ''
  }
  if (node.type === 'hardBreak') return '\n'
  const children = Array.isArray(node.content) ? node.content.map(adfText).join('') : ''
  return node.type && /^(paragraph|heading|listItem|codeBlock|blockquote|tableRow|tableCell|tableHeader|bulletList|orderedList|table|panel|mediaSingle|rule)$/.test(node.type)
    ? `${children}\n` : children
}
/** Normalizes a Jira timestamp to ISO-8601 for Triggers and Thread facts. */
export function jiraTime(value: string): string {
  const time = Date.parse(value)
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
}
/** A Jira body as one trimmed block of text, with ADF blocks separated by a blank line. */
export const jiraBodyText = (value: unknown): string => adfText(value).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
/** Converts a reply's Markdown-ish text to a minimal ADF document; Jira Cloud only accepts ADF comment bodies. */
export function adfDocument(text: string): unknown {
  const paragraphs = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean).map(block => {
    const content: unknown[] = []
    block.split('\n').forEach((line, index) => {
      if (index) content.push({ type: 'hardBreak' })
      if (line) content.push({ type: 'text', text: line })
    })
    return { type: 'paragraph', content: content.length ? content : [{ type: 'text', text: ' ' }] }
  })
  return { type: 'doc', version: 1, content: paragraphs.length ? paragraphs : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] }
}
/** Formats a cursor as a JQL UTC literal; the minute floor and one-minute overlap make late writes safe because Trigger ids deduplicate. */
export function jqlTime(iso: string): string {
  const time = Date.parse(iso)
  const date = new Date(Number.isFinite(time) ? time - 60_000 : Date.now())
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}
const quote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
/** Builds the JQL for one poll: the project, the cursor, optional issue types and the operator's extra JQL. */
export function jiraJql(query: JiraQuery, since: string): string {
  const clauses = [`project = ${quote(query.project)}`, `updated >= "${jqlTime(since)}"`]
  const types = query.issueTypes.split(',').map(type => type.trim()).filter(Boolean)
  if (types.length) clauses.push(`issuetype in (${types.map(quote).join(', ')})`)
  if (query.jql) clauses.push(`(${query.jql})`)
  return `${clauses.join(' AND ')} ORDER BY updated ASC`
}
function failure(status: number, text: string): string {
  try {
    const value = JSON.parse(text) as { errorMessages?: unknown[]; errors?: Record<string, unknown> }
    const messages = [
      ...(Array.isArray(value.errorMessages) ? value.errorMessages.filter((item): item is string => typeof item === 'string') : []),
      ...Object.entries(value.errors ?? {}).map(([field, message]) => `${field}: ${String(message)}`),
    ]
    if (messages.length) return `Jira rejected the request: ${messages.join('; ')} (HTTP ${status})`
  } catch { /* Jira also answers with HTML or plain text. */ }
  return `Jira returned HTTP ${status}${text ? `: ${text.slice(0, 500)}` : ''}`
}
const FIELDS = 'summary,description,status,issuetype,priority,assignee,reporter,created,updated,labels,project'
/**
 * Jira REST client for one connection. Every request carries the configured credentials, a 30-second limit, and the
 * call's abort signal; failures carry Jira's HTTP status so a Channel can settle a deleted issue as gone.
 */
export class JiraClient {
  constructor(private readonly connection: JiraConnection, private readonly signal?: AbortSignal) {}
  private get prefix(): string { return `/rest/api/${this.connection.platform === 'server' ? '2' : '3'}` }
  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') search.set(name, String(value))
    const suffix = search.size ? `?${search.toString()}` : ''
    return `${this.connection.site}${this.prefix}${path}${suffix}`
  }
  private authorization(): string {
    if (!this.connection.token) throw new JiraError('The Jira Source has no token')
    if (this.connection.auth === 'bearer') return `Bearer ${this.connection.token}`
    if (!this.connection.user) throw new JiraError('Basic Jira authentication needs a user')
    return `Basic ${Buffer.from(`${this.connection.user}:${this.connection.token}`).toString('base64')}`
  }
  private async request<T>(schema: z.ZodType<T>, method: 'GET' | 'POST' | 'PUT', path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(30_000)
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(this.url(path, options.query), { method, signal,
        headers: { accept: 'application/json', authorization: this.authorization(), ...options.body === undefined ? {} : { 'content-type': 'application/json' } },
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) } })
    } catch (error) {
      if (signal.aborted) throw error
      throw new JiraError(`Jira request failed: ${String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) throw new JiraError(failure(response.status, text), response.status)
    let value: unknown
    try { value = text ? JSON.parse(text) : {} }
    catch { throw new JiraError(`Jira returned unreadable JSON (HTTP ${response.status})`, response.status) }
    return schema.parse(value)
  }
  /** Reads every issue matching `jql`, oldest update first, skipping malformed items. */
  async search(jql: string): Promise<SearchResult> {
    const issues: JiraIssue[] = []
    let skipped = 0
    if (this.connection.platform === 'server') {
      let startAt = 0
      for (;;) {
        const page = await this.request(SearchSchema, 'GET', '/search', { query: { jql, startAt, maxResults: PAGE_SIZE, fields: FIELDS } })
        const parsed = validItems(JiraIssueSchema, page.issues)
        skipped += page.issues.length - parsed.length
        issues.push(...parsed)
        startAt += page.issues.length
        if (!page.issues.length || startAt >= page.total) break
      }
      return { issues, skipped }
    }
    let next: string | undefined
    for (;;) {
      const page = await this.request(SearchSchema, 'GET', '/search/jql', { query: { jql, maxResults: PAGE_SIZE, fields: FIELDS, nextPageToken: next } })
      const parsed = validItems(JiraIssueSchema, page.issues)
      skipped += page.issues.length - parsed.length
      issues.push(...parsed)
      if (page.isLast || !page.nextPageToken) break
      next = page.nextPageToken
    }
    return { issues, skipped }
  }
  async issue(issue: string): Promise<JiraIssue> {
    const value = await this.request(JiraIssueSchema, 'GET', `/issue/${encodeURIComponent(issue)}`, { query: { fields: FIELDS } })
    return value
  }
  async changelog(issue: string): Promise<JiraHistory[]> {
    const histories: JiraHistory[] = []
    let startAt = 0
    for (;;) {
      const page = await this.request(ChangelogPageSchema, 'GET', `/issue/${encodeURIComponent(issue)}/changelog`, { query: { startAt, maxResults: PAGE_SIZE } })
      histories.push(...validItems(JiraHistorySchema, page.values))
      startAt += page.values.length
      if (page.isLast === true || !page.values.length || startAt >= page.total || page.values.length < PAGE_SIZE) break
    }
    return histories
  }
  async comments(issue: string, startAt = 0, maxResults = PAGE_SIZE): Promise<CommentPage> {
    const page = await this.request(CommentPageSchema, 'GET', `/issue/${encodeURIComponent(issue)}/comment`, { query: { startAt, maxResults } })
    const comments = validItems(JiraCommentSchema, page.comments)
    const consumed = page.startAt + page.comments.length
    return { comments, ...(consumed < page.total ? { next: consumed } : {}) }
  }
  /** Every comment of an issue, in Jira's order; polling compares each one with its cursor. */
  async allComments(issue: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = []
    let startAt = 0
    for (;;) {
      const page = await this.comments(issue, startAt)
      comments.push(...page.comments)
      if (page.next === undefined || page.next <= startAt) break
      startAt = page.next
    }
    return comments
  }
  /** Reads one hidden issue property; `undefined` when the issue has no such property. */
  async property(issue: string, name: string): Promise<unknown> {
    try {
      const value = await this.request(z.looseObject({ value: z.unknown() }), 'GET',
        `/issue/${encodeURIComponent(issue)}/properties/${encodeURIComponent(name)}`)
      return value.value
    } catch (error) {
      if (error instanceof JiraError && error.status === 404) return undefined
      throw error
    }
  }
  /** Writes a hidden issue property, used to remember a reply this Outbox already posted. */
  async setProperty(issue: string, name: string, value: unknown): Promise<void> {
    await this.request(z.unknown(), 'PUT', `/issue/${encodeURIComponent(issue)}/properties/${encodeURIComponent(name)}`, { body: { value } })
  }
  /** Posts a reply; Cloud takes an ADF document, while Server/DC takes the plain-text body. */
  async createComment(issue: string, text: string): Promise<JiraComment> {
    const body = this.connection.platform === 'server' ? { body: text } : { body: adfDocument(text) }
    return this.request(JiraCommentSchema, 'POST', `/issue/${encodeURIComponent(issue)}/comment`, { body })
  }
}
