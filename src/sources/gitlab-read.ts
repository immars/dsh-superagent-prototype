/** GitLab Thread context: an issue's or merge request's description and its notes as the messages an assessment reads. */
import type { ContextMessage, ThreadContext } from './kind.ts'
import { GitlabClient, gitlabHuman, gitlabTime, gitlabUserName, type GitlabIssue, type GitlabMergeRequest, type GitlabNote,
  type GitlabWorkKind } from './gitlab-client.ts'
import { gitlabWebUrl, type GitlabRef } from './gitlab-trigger.ts'
import type { GitlabConfig } from './gitlab.ts'

const PAGE_SIZE = 50
const itemUrl = (ref: GitlabRef, item: GitlabIssue | GitlabMergeRequest, config: GitlabConfig): string =>
  item.web_url ?? gitlabWebUrl(config, ref)
const itemMessage = (ref: GitlabRef, item: GitlabIssue | GitlabMergeRequest, config: GitlabConfig): ContextMessage => ({
  id: ref.kind,
  from: gitlabUserName(item.author),
  at: gitlabTime(item.created_at),
  text: [item.title, item.description?.trim()].filter(Boolean).join('\n\n'),
  url: itemUrl(ref, item, config),
  ...gitlabHuman(item.author) ? {} : { bot: true as const },
})
const noteMessage = (note: GitlabNote, url: string): ContextMessage => ({
  id: String(note.id),
  from: gitlabUserName(note.author),
  at: gitlabTime(note.updated_at ?? note.created_at),
  text: note.body.trim(),
  url: `${url}#note_${note.id}`,
  ...gitlabHuman(note.author) ? {} : { bot: true as const },
})
function itemView(ref: GitlabRef, item: GitlabIssue | GitlabMergeRequest, config: GitlabConfig, instance: string): Record<string, unknown> {
  return { kind: ref.kind, iid: ref.iid, title: item.title, state: item.state,
    ...'source_branch' in item ? { sourceBranch: item.source_branch, targetBranch: item.target_branch } : {},
    url: itemUrl(ref, item, config), source: instance }
}
function refOf(meta: Record<string, unknown>): GitlabRef | undefined {
  const kind: GitlabWorkKind = meta.workKind === 'mr' || meta.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(meta.iid)
  return Number.isInteger(iid) && iid > 0 ? { kind, iid } : undefined
}
/** Gives assessments the work item's own text and its notes; GitLab notes are flat, so both root and parent are the item. */
export const gitlabThreadContext: ThreadContext<GitlabConfig> = {
  messageId: trigger => trigger.meta.kind === 'comment' ? String(trigger.meta.commentId ?? '') : String(trigger.meta.workKind ?? 'issue'),
  async read(_commands, trigger, part, cursor, config) {
    const ref = refOf(trigger.meta)
    if (!config.site || !config.project || !config.token || !ref) {
      return { messages: [], body: { status: 'gitlab_unconfigured', messages: [] }, status: 'gitlab_unconfigured' }
    }
    const client = new GitlabClient(config)
    const item = ref.kind === 'mr' ? await client.mergeRequest(ref.iid) : await client.issue(ref.iid)
    const first = itemMessage(ref, item, config)
    if (part === 'root' || part === 'parent') {
      return { messages: [first], body: { status: 'gitlab_item', item: itemView(ref, item, config, trigger.source), messages: [first] }, status: 'gitlab_item' }
    }
    const start = Number(cursor ?? '1')
    const page = await client.notes(ref.kind, ref.iid, Number.isFinite(start) && start > 0 ? start : 1, PAGE_SIZE)
    const url = itemUrl(ref, item, config)
    const messages = [first, ...page.notes.filter(note => !note.system).map(note => noteMessage(note, url))]
    return { messages, ...(page.next === undefined ? {} : { next: String(page.next) }),
      body: { status: 'gitlab_item', item: itemView(ref, item, config, trigger.source), messages } }
  },
}
