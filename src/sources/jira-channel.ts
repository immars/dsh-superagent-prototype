/** Jira outbound Channel: posts a Ticket's reply as a comment on its issue, once per message. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { JiraClient, JiraError } from './jira-client.ts'
import type { JiraConfig } from './jira.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

const property = (id: string): string => `dsh-superagent-${id}`
/** Posts `message.text` to its issue as a comment; a hidden issue property makes a retry recognise the earlier post. */
export async function sendJira(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage, config: JiraConfig): Promise<'sent' | 'gone'> {
  const issue = message.channel.address.issue
  if (!issue) throw new Error('Missing Jira reply target')
  if (!config.site || !config.token) throw new Error('The Jira Source has no site or token')
  const client = new JiraClient(config)
  const name = property(message.id)
  try {
    // The property is set only after the comment exists, so a retry that finds it knows the comment was posted.
    if (await client.property(issue, name) !== undefined) return 'sent'
    await client.createComment(issue, message.text)
    await client.setProperty(issue, name, { message: message.id })
    return 'sent'
  } catch (error) {
    // A deleted issue, or one this account can no longer see, can never receive the reply.
    if (error instanceof JiraError && (error.status === 404 || error.status === 410)) return 'gone'
    throw error
  }
}
export function jiraLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const issue = address.issue ?? ''
  return { url: address.url ?? '', label: { zh: `JIRA ${issue}`, en: `Jira ${issue}` } }
}
