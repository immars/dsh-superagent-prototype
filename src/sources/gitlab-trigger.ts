/** Normalizes GitLab issues, merge requests, and notes into domain Triggers. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { GitlabIssue, GitlabMergeRequest, GitlabNote, GitlabUser, GitlabWorkKind } from './gitlab-client.ts'
import { gitlabHuman, gitlabTime, gitlabUserId } from './gitlab-client.ts'
import type { GitlabConfig } from './gitlab.ts'

export const SOURCE = 'gitlab'
/** The fields of one project that every Trigger and address names. */
export type GitlabIdentity = Pick<GitlabConfig, 'site' | 'project' | 'agentAccount'>
export interface GitlabRef { kind: GitlabWorkKind; iid: number }
/** GitLab numbers issues and merge requests separately, so their Threads never collide. */
export const gitlabThreadId = (ref: GitlabRef): string => `${ref.kind}:${ref.iid}`
export const gitlabThreadKey = (ref: GitlabRef, instance = SOURCE): string => `${instance}:${gitlabThreadId(ref)}`
/** Parses the Thread id of a subscribed Thread, such as `mr:12`, or its key, such as `gitlab:mr:12`. */
export function gitlabRef(value: string): GitlabRef | undefined {
  const match = /^(?:gitlab:)?(issue|mr):([1-9]\d*)$/.exec(value)
  return match ? { kind: match[1] as GitlabWorkKind, iid: Number(match[2]) } : undefined
}
export const gitlabWebUrl = (config: Pick<GitlabConfig, 'site' | 'project'>, ref: GitlabRef): string =>
  `${config.site}/${config.project}/-/${ref.kind === 'mr' ? 'merge_requests' : 'issues'}/${ref.iid}`
/** Reply address of one issue or merge request: its kind, its IID, the project, and the page people open. */
export const gitlabChannel = (config: Pick<GitlabConfig, 'site' | 'project'>, ref: GitlabRef, instance = SOURCE, url?: string): ChannelRef =>
  ({ source: instance, thread: gitlabThreadKey(ref, instance), address: { kind: ref.kind, iid: String(ref.iid), project: config.project,
    url: url ?? gitlabWebUrl(config, ref) } })
/** True when `text` mentions the configured agent username, as GitLab renders a user mention. */
export function gitlabMentioned(text: string, username: string): boolean {
  if (!username.trim()) return false
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_.@-])@${escapeRegExp(username.trim())}(?![\\p{L}\\p{N}_.-])`, 'iu').test(text)
}
/** True when GitLab reports that this account made the change, so the Source keeps the agent's own writes out of the domain. */
export const gitlabAgentAuthored = (user: GitlabUser | undefined, config: Pick<GitlabConfig, 'agentAccount'>): boolean =>
  !!config.agentAccount && !!user && sameName(gitlabUserId(user), config.agentAccount)
function author(user: GitlabUser | undefined, agent: string, instance: string): Pick<Trigger, 'actor' | 'human'> {
  return { actor: { source: instance, id: gitlabUserId(user) }, human: gitlabHuman(user) && !sameName(gitlabUserId(user), agent) }
}
/** The first hash input of a Trigger; the default instance keeps the ids this Source used before instances were configurable. */
const prefix = (instance: string, kind: 'issue' | 'mr' | 'note'): string =>
  instance === SOURCE ? `gitlab-${kind}` : `${instance}:gitlab-${kind}`
const body = (item: Pick<GitlabIssue, 'title' | 'description'>): string =>
  `${item.title}${item.description?.trim() ? `\n\n${item.description.trim()}` : ''}`
function base(ref: GitlabRef, config: GitlabIdentity, at: string, text: string, user: GitlabUser | undefined,
  meta: Record<string, unknown>, instance = SOURCE): Trigger {
  const url = gitlabWebUrl(config, ref)
  return { id: key(prefix(instance, ref.kind), config.project, String(ref.iid)), source: instance,
    threads: [{ source: instance, id: gitlabThreadId(ref) }], ...author(user, config.agentAccount, instance), at: gitlabTime(at), text,
    ...(gitlabMentioned(text, config.agentAccount) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(config, ref, instance, url), url,
    meta: { kind: ref.kind, workKind: ref.kind, iid: ref.iid, project: config.project, ...meta } }
}
/** The Trigger for an Issue whose creation is at or after the cursor. */
export function issueTrigger(issue: GitlabIssue, config: GitlabIdentity, instance = SOURCE): Trigger | undefined {
  if (gitlabAgentAuthored(issue.author, config)) return undefined
  const ref = { kind: 'issue' as const, iid: issue.iid }
  return { ...base(ref, config, issue.created_at, body(issue), issue.author,
    { title: issue.title, state: issue.state, ...issue.web_url ? { url: issue.web_url } : {} }, instance),
    id: key(prefix(instance, 'issue'), config.project, String(issue.iid)) }
}
/** The Trigger for a merge request whose creation is at or after the cursor. */
export function mergeRequestTrigger(merge: GitlabMergeRequest, config: GitlabIdentity, instance = SOURCE): Trigger | undefined {
  if (gitlabAgentAuthored(merge.author, config)) return undefined
  const ref = { kind: 'mr' as const, iid: merge.iid }
  return { ...base(ref, config, merge.created_at, body(merge), merge.author,
    { title: merge.title, state: merge.state, sourceBranch: merge.source_branch, targetBranch: merge.target_branch,
      ...merge.draft || merge.work_in_progress ? { draft: true } : {}, ...merge.web_url ? { url: merge.web_url } : {} }, instance),
    id: key(prefix(instance, 'mr'), config.project, String(merge.iid)) }
}
/**
 * Builds a Trigger for a note, including an edited note as a new version. System notes and the agent's own notes are
 * dropped; the note's Thread is the issue or merge request it belongs to.
 */
export function noteTrigger(kind: GitlabWorkKind, item: GitlabIssue | GitlabMergeRequest, note: GitlabNote,
  config: GitlabIdentity, instance = SOURCE): Trigger | undefined {
  if (note.system || gitlabAgentAuthored(note.author, config)) return undefined
  if (!note.body.trim()) return undefined
  const ref = { kind, iid: item.iid }
  const at = note.updated_at ?? note.created_at
  const url = item.web_url ?? gitlabWebUrl(config, ref)
  const text = note.body.trim()
  const trigger = base(ref, config, at, text, note.author,
    { kind: 'comment', workKind: kind, title: item.title, state: item.state, commentId: note.id }, instance)
  return { ...trigger, id: key(prefix(instance, 'note'), kind, config.project, String(item.iid), String(note.id), at),
    ...note.updated_at ? { at: gitlabTime(note.updated_at) } : {}, channel: gitlabChannel(config, ref, instance, `${url}#note_${note.id}`),
    url: `${url}#note_${note.id}` }
}
