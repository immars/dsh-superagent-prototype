/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { ticketMarker } from './binding.ts'
import type { SourceContext } from './host.ts'
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** The Source instance whose Threads a ticket follows for its pull requests: its target, or the default for a legacy ticket. */
const targetSource = (ticket: Pick<Ticket, 'target'>): string => ticket.target?.source ?? SOURCE
const pullNumber = (ticket: Pick<Ticket, 'target'>, thread: string): number | undefined =>
  thread.startsWith(`${targetSource(ticket)}:`) ? Number(thread.slice(targetSource(ticket).length + 1)) : undefined
export const pullsOf = (ticket: Pick<Ticket, 'follows' | 'target'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(ticket, item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows' | 'target'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** The repository a Source instance polls: its own configuration, else the deployment's default for the default instance. */
const repositoryOf = (ctx: SourceContext): string => String(ctx.config<{ repository?: string }>()?.repository || ctx.deployment.repository)
/** True when the PR was opened by the agent account from a branch in the ticket's repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>, repository = deployment.repository): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', repository)
/** True when `pr` is the pull request the ticket started from. */
const originPull = (ctx: SourceContext, ticket: Pick<Ticket, 'origin' | 'target'>, number: number): boolean => {
  const source = ctx.triggers.get(ticket.origin.triggerId)
  return source?.source === targetSource(ticket) && source.meta.isPr === true && source.meta.number === number
}
/** Whether an open ticket other than `ticketId` already follows `number`. */
const ownedElsewhere = (ctx: SourceContext, ticketId: string, number: number): boolean =>
  ctx.tickets.open().some(ticket => ticket.id !== ticketId && pullsOf(ticket, true).includes(number))
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or a PR the agent account opened
 * in the ticket's target repository, enforcing that one PR binds to at most one open ticket. The branch name is not read:
 * a worker's report is the ticket's claim on its own PR, and the Source's automatic binding uses the hidden ticket marker
 * plus the commit history instead.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is
 * not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const started = originPull(ctx, ticket, pr.number)
  const opened = agentPull(pr, ctx.deployment, ticket.target?.repository ?? repositoryOf(ctx))
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} in the ticket's target repository; omit pr_number when no PR exists`
  }
  if (ownedElsewhere(ctx, ticketId, pr.number)) return 'PR already belongs to another active ticket'
  const instance = targetSource(ticket)
  const follow = ticket.follows?.find(item => item.thread === `${instance}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (!started && !follow.own))) bind(ctx, ticketId, pr, !started)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with the ticket that follows it. A PR the ticket
 * followed until it closed is followed again when it reopens. An open agent PR with no binding auto-binds only when its body
 * carries the marker of one live ticket, that ticket targets this repository, and the PR's head commit is in that ticket's
 * worktree; otherwise only the Executor's report binds it.
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const instance = ctx.instance.id
    const thread = `${instance}:${pr.number}`
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ctx.tickets.open().find(ticket => ticket.follows?.some(item => item.thread === thread && item.closed))
    if (reopened) {
      const follow = reopened.follows!.find(item => item.thread === thread)!
      bind(ctx, reopened.id, pr, follow.own)
    } else {
      const marker = ticketMarker(pr.body)
      const ticket = marker ? ctx.tickets.get(marker) : undefined
      if (ticket && liveTicket(ticket)) {
        const repository = repositoryOf(ctx)
        const target = ticket.target
        const sameInstance = (target?.source ?? instance) === instance
        const sameRepository = !target || sameName(target.repository, repository)
        const verified = sameInstance && sameRepository && agentPull(pr, ctx.deployment, target?.repository ?? repository)
          && (ctx.commitInWorktree ? await ctx.commitInWorktree(ticket.id, pr.head.sha) : false)
        if (verified && pullsOf(ticket, true).every(number => number === pr.number) && !ownedElsewhere(ctx, ticket.id, pr.number)) {
          bind(ctx, ticket.id, pr, !originPull(ctx, ticket, pr.number))
        }
      }
    }
  }
  ctx.threads.describe(`${ctx.instance.id}:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  const instance = targetSource(ctx.tickets.get(ticketId) ?? { target: undefined })
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: instance, id: String(pr.number) }, own)
    ctx.threads.patch(`${instance}:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  const target = { source: ctx.instance.id, id: String(pr.number) }
  const follows = (ticket: Ticket) => (ticket.target?.source ?? ctx.instance.id) === ctx.instance.id && pullsOf(ticket, true).includes(pr.number)
  if (!ctx.tickets.open().some(follows)) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed(target, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English. `isGithub` identifies every GitHub-kind channel to skip, not only the
 * default instance, and `repository` is the ticket's target repository.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string,
  isGithub: (source: string) => boolean = source => source === SOURCE): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(ticket, item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(ticket, follow.thread)!
  const url = githubPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => !isGithub(channel.source)).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
