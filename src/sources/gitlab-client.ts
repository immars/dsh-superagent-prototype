/** GitLab REST transport for the GitLab Source: credentials, issue and merge request lists, notes, and reply posting. */
import { z } from 'zod'
import { validItems } from '../infra/commands.ts'

/** The two work item kinds a GitLab project's Thread can hold; GitLab numbers issues and merge requests separately. */
export const GITLAB_WORK_KINDS = ['issue', 'mr'] as const
export type GitlabWorkKind = typeof GITLAB_WORK_KINDS[number]
/** The connection fields a GitLab request needs. */
export interface GitlabConnection { site: string; project: string; token: string }
/** HTTP and payload failures of the GitLab API; `status` is GitLab's response code when it sent one. */
export class GitlabError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
export const GitlabUserSchema = z.looseObject({
  id: z.number().nullish(), username: z.string().default(''), name: z.string().nullish(),
  bot: z.boolean().nullish(), state: z.string().nullish(), user_type: z.string().nullish(),
}).nullish()
export type GitlabUser = z.infer<typeof GitlabUserSchema>
/** GitLab's own work item path, which differs from the Thread kind only for merge requests. */
export const gitlabResource = (kind: GitlabWorkKind): 'issues' | 'merge_requests' => kind === 'mr' ? 'merge_requests' : 'issues'
export const GitlabIssueSchema = z.looseObject({
  id: z.number(), iid: z.number(), project_id: z.number().nullish(),
  title: z.string().default(''), description: z.string().nullish(), state: z.string().default('opened'),
  created_at: z.string(), updated_at: z.string(), closed_at: z.string().nullish(),
  labels: z.array(z.string()).default([]), author: GitlabUserSchema, web_url: z.string().nullish(),
})
export type GitlabIssue = z.infer<typeof GitlabIssueSchema>
export const GitlabMergeRequestSchema = GitlabIssueSchema.extend({
  merged_at: z.string().nullish(), source_branch: z.string().default(''), target_branch: z.string().default(''),
  sha: z.string().nullish(), draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
  merge_status: z.string().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof GitlabMergeRequestSchema>
export const GitlabNoteSchema = z.looseObject({
  id: z.number(), body: z.string().default(''), author: GitlabUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean().default(false),
  noteable_type: z.string().nullish(), type: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
const PAGE_SIZE = 100
const NOTE_PAGE_SIZE = 50
export interface NotePage { notes: GitlabNote[]; next?: number | undefined }
export interface Listed<T> { items: T[]; skipped: number }
/** The GitLab username in the Source's identity space; a deleted account keeps GitLab's `ghost` name. */
export const gitlabUserId = (user: GitlabUser | undefined): string => user?.username || 'ghost'
/** The display name GitLab shows for an account, falling back to its username. */
export const gitlabUserName = (user: GitlabUser | undefined): string => user?.name || user?.username || 'ghost'
const MACHINE_TYPES = new Set(['project_bot', 'service_account', 'alert_bot', 'support_bot', 'ghost'])
/** True unless GitLab marks the account as a bot or service account, whose messages can never authorize work. */
export const gitlabHuman = (user: GitlabUser | undefined): boolean =>
  !!user && user.bot !== true && user.username !== 'ghost' && !MACHINE_TYPES.has(user.user_type ?? '')
/** Normalizes a GitLab timestamp to ISO-8601 for Triggers and Thread facts. */
export function gitlabTime(value: string): string {
  const time = Date.parse(value)
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
}
function failure(status: number, text: string): string {
  try {
    const value = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown }
    if (typeof value.message === 'string') return `GitLab rejected the request: ${value.message} (HTTP ${status})`
    if (value.message && typeof value.message === 'object') {
      const messages = Object.entries(value.message).flatMap(([field, list]) =>
        Array.isArray(list) ? list.map(item => `${field}: ${String(item)}`) : [])
      if (messages.length) return `GitLab rejected the request: ${messages.join('; ')} (HTTP ${status})`
    }
    const error = typeof value.error === 'string' ? value.error : ''
    const description = typeof value.error_description === 'string' ? value.error_description : ''
    if (error || description) return `GitLab rejected the request: ${[error, description].filter(Boolean).join(': ')} (HTTP ${status})`
  } catch { /* GitLab may answer with HTML or plain text. */ }
  return `GitLab returned HTTP ${status}${text ? `: ${text.slice(0, 500)}` : ''}`
}
/**
 * GitLab REST client for one project. Every request carries the configured personal access token, a 30-second limit,
 * and the call's abort signal; failures carry GitLab's HTTP status so a Channel can settle a deleted work item as gone.
 */
export class GitlabClient {
  constructor(private readonly connection: GitlabConnection, private readonly signal?: AbortSignal) {}
  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') search.set(name, String(value))
    const suffix = search.size ? `?${search.toString()}` : ''
    return `${this.connection.site}/api/v4/projects/${encodeURIComponent(this.connection.project)}${path}${suffix}`
  }
  private async send(method: 'GET' | 'POST', path: string, query: Record<string, string | number | undefined>,
    body?: unknown): Promise<Response> {
    if (!this.connection.token) throw new GitlabError('The GitLab Source has no token')
    const timeout = AbortSignal.timeout(30_000)
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(this.url(path, query), { method, signal,
        headers: { accept: 'application/json', 'private-token': this.connection.token,
          ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) } })
    } catch (error) {
      if (signal.aborted) throw error
      throw new GitlabError(`GitLab request failed: ${String(error)}`)
    }
    if (!response.ok) throw new GitlabError(failure(response.status, await response.text()), response.status)
    return response
  }
  private async request<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const response = await this.send(method, path, options.query ?? {}, options.body)
    const text = await response.text()
    let value: unknown
    try { value = text ? JSON.parse(text) : {} }
    catch { throw new GitlabError(`GitLab returned unreadable JSON (HTTP ${response.status})`, response.status) }
    return schema.parse(value)
  }
  /** Reads one page and follows GitLab's `X-Next-Page` header, or a full page when the header is absent. */
  private async page<T>(schema: z.ZodType<T>, path: string, query: Record<string, string | number | undefined>,
    page: number, size = PAGE_SIZE): Promise<{ items: T[]; skipped: number; next?: number }> {
    const response = await this.send('GET', path, { ...query, page, per_page: size })
    const text = await response.text()
    let listed: unknown[]
    try { listed = z.array(z.unknown()).parse(text ? JSON.parse(text) : []) }
    catch { throw new GitlabError(`GitLab returned unreadable JSON (HTTP ${response.status})`, response.status) }
    const items = validItems(schema, listed)
    const header = Number(response.headers.get('x-next-page') ?? '')
    const next = Number.isInteger(header) && header > page ? header : listed.length === size ? page + 1 : undefined
    return { items, skipped: listed.length - items.length, ...next ? { next } : {} }
  }
  private async all<T>(schema: z.ZodType<T>, path: string, query: Record<string, string | number | undefined>): Promise<Listed<T>> {
    const items: T[] = []
    let skipped = 0
    let page = 1
    for (;;) {
      const result = await this.page(schema, path, query, page)
      items.push(...result.items)
      skipped += result.skipped
      if (result.next === undefined) break
      if (result.next > 1000) throw new GitlabError('GitLab returned more than 1000 pages for one read')
      page = result.next
    }
    return { items, skipped }
  }
  /** Issues changed at or after `since`, oldest update first, including closed ones. */
  async issues(since: string): Promise<Listed<GitlabIssue>> {
    return this.all(GitlabIssueSchema, '/issues',
      { state: 'all', scope: 'all', order_by: 'updated_at', sort: 'asc', updated_after: since })
  }
  /** Merge requests changed at or after `since`, oldest update first, including merged and closed ones. */
  async mergeRequests(since: string): Promise<Listed<GitlabMergeRequest>> {
    return this.all(GitlabMergeRequestSchema, '/merge_requests',
      { state: 'all', scope: 'all', order_by: 'updated_at', sort: 'asc', updated_after: since })
  }
  async issue(iid: number): Promise<GitlabIssue> {
    return this.request(GitlabIssueSchema, 'GET', `/issues/${iid}`)
  }
  async mergeRequest(iid: number): Promise<GitlabMergeRequest> {
    return this.request(GitlabMergeRequestSchema, 'GET', `/merge_requests/${iid}`)
  }
  /** One page of an issue's or merge request's notes, in creation order. */
  async notes(kind: GitlabWorkKind, iid: number, page = 1, size = NOTE_PAGE_SIZE): Promise<NotePage> {
    const result = await this.page(GitlabNoteSchema, `/${gitlabResource(kind)}/${iid}/notes`,
      { order_by: 'created_at', sort: 'asc' }, page, size)
    return { notes: result.items, ...result.next === undefined ? {} : { next: result.next } }
  }
  /** Every note of an issue or merge request; polling compares each one with its cursor. */
  async allNotes(kind: GitlabWorkKind, iid: number): Promise<GitlabNote[]> {
    const result = await this.all(GitlabNoteSchema, `/${gitlabResource(kind)}/${iid}/notes`,
      { order_by: 'created_at', sort: 'asc' })
    return result.items
  }
  /** Posts a note; the Channel embeds an HTML marker so a retry recognises an earlier post. */
  async createNote(kind: GitlabWorkKind, iid: number, body: string): Promise<GitlabNote> {
    return this.request(GitlabNoteSchema, 'POST', `/${gitlabResource(kind)}/${iid}/notes`, { body: { body } })
  }
}
