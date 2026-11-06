/** Ticket stage classification and retry eligibility (docs/003). */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/**
 * High-level execution stage of a ticket: waiting on a person, actively working or queued, idle between turns, scheduled
 * between runs of a periodic task, or ended.
 */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'scheduled' } | { stage: 'ended' }

/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  // A ready report on a periodic task is one run's result, and the Ticket stays open for the next run.
  if (report === 'ready') return ticket.schedule ? scheduled() : { stage: 'person', action: 'review' }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  // A scheduled Ticket with no run in progress is scheduled, not idle: the clock will wake it.
  if (report === 'waiting' || assignment.state === 'ended') return ticket.schedule ? scheduled() : { stage: 'idle' }
  return { stage: 'working' }
}
const scheduled = (): TicketStage => ({ stage: 'scheduled' })

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}
