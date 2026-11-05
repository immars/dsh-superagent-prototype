/** GitLab outbound Channel: posts a Ticket's reply as a note on its issue or merge request, once per message. */
import type { OutboundMessage } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { GitlabClient, GitlabError, type GitlabWorkKind } from './gitlab-client.ts'
import type { GitlabConfig } from './gitlab.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** A deleted work item, or one this account can no longer see, can never receive the reply. */
const gone = (error: unknown): boolean => error instanceof GitlabError && (error.status === 404 || error.status === 410)
/** Posts `message.text` as a note, embedding an HTML marker so a retry recognises the earlier post without a duplicate. */
export async function sendGitlab(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage,
  config: GitlabConfig): Promise<'sent' | 'gone'> {
  const kind: GitlabWorkKind = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  if (!config.site || !config.project || !config.token) throw new Error('The GitLab Source has no site, project or token')
  const client = new GitlabClient(config)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const mine = (body: string, user: string): boolean =>
      !!config.agentAccount && sameName(user, config.agentAccount) && body.includes(marker)
    const existing = (await client.allNotes(kind, iid)).some(note => mine(note.body, note.author?.username ?? ''))
    if (existing) return 'sent'
    await client.createNote(kind, iid, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  const iid = address.iid ?? ''
  return { url: address.url ?? '', label: kind === 'mr'
    ? { zh: `GitLab 合并请求 !${iid}`, en: `GitLab merge request !${iid}` }
    : { zh: `GitLab Issue #${iid}`, en: `GitLab issue #${iid}` } }
}
