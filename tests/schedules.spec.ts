/** The schedule clock and a scheduled Ticket's lifecycle on a running Runtime (docs/012). */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { key, latestAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accept a scheduled task and wait for its first Assignment to launch. */
async function accepted(schedule: Record<string, unknown> = { period: 'minutely', every: 15, time_zone: 'UTC' }) {
  const trigger = feishu('1', '@bot 每 15 分钟汇报一次进度')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Periodic progress', worktree_name: 'periodic-progress',
    acknowledgement: '开始，之后每 15 分钟。', schedule })
  await h.runtime.idle()
  return { trigger, ticket: h.runtime.store.tickets.get(String((result.ticket as { ticket_id: string }).ticket_id))! }
}
/** Mark a scheduled ticket due, as a late clock tick after downtime would see it. */
function due(ticketId: string, at = new Date(Date.now() - 60_000).toISOString()): string {
  h.runtime.store.atomic(() => {
    const ticket = h.runtime.store.tickets.get(ticketId)!
    ticket.schedule!.nextAt = at
    h.runtime.store.tickets.save(ticket)
  })
  return at
}
const runs = (ticketId: string) => h.runtime.store.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'scheduled-run')
/** Report one run's ready result on the running Assignment. */
function ready(ticketId: string, summary: string) {
  h.runtime.engine.report(ticketId, { state: 'ready', summary })
}

it('stores the schedule with the accept, computes its next boundary and describes it to the worker', async () => {
  const { ticket } = await accepted({ period: 'daily', every: 3, at: '09:00', time_zone: 'Asia/Shanghai' })
  expect(ticket.schedule).toMatchObject({ period: 'daily', every: 3, at: '09:00', timeZone: 'Asia/Shanghai', fromTriggerId: ticket.origin.triggerId })
  expect(ticket.schedule!.nextAt > ticket.createdAt).toBe(true)
  expect(ticket.execution!.assignment).toContain('This is a standing periodic task')
  expect(ticket.execution!.assignment).toContain('every 3 days at 09:00, Asia/Shanghai')
})

it('records one due run, advances nextAt atomically, and delivers it to the same worker', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'first run')
  const dueAt = due(ticket.id)
  h.runtime.schedules.tick()
  const fired = h.runtime.store.tickets.get(ticket.id)!
  const run = runs(ticket.id)
  expect(run).toHaveLength(1)
  expect(run[0]).toMatchObject({ kind: 'scheduled-run', scheduledFor: dueAt, id: key('input', ticket.id, 'scheduled-run', dueAt) })
  expect(fired.schedule!.lastRunAt).toBeTruthy()
  expect(fired.schedule!.nextAt > new Date().toISOString()).toBe(true)
  // A second tick while the run waits is a busy Ticket, not a second run.
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(1)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).toEqual([])
  const delivered = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === `worker-${ticket.id}`)
  expect(delivered.some(call => call.text.includes('Scheduled run for this task'))).toBe(true)
  expect(delivered.some(call => call.text.includes('This Ticket stays open for the next run'))).toBe(true)
})

it('keeps a scheduled Ticket open after a ready report and sends each run\'s result once per report instant', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'no changes')
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)!.schedule).toBeDefined()
  const first = h.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'no changes' })
  // A later run with the same text is a new result, keyed by its report instant.
  await new Promise(resolve => setTimeout(resolve, 5))
  ready(ticket.id, 'no changes')
  const second = h.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'no changes' })
  expect(second.id).not.toBe(first.id)
})

it('holds while the worker is blocked or a previous run is still working, and fires after a person answers', async () => {
  const { ticket } = await accepted()
  // The first run is still working (no report): the due run waits.
  due(ticket.id)
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(0)
  ready(ticket.id, 'first run')
  // A blocked run holds until a person's message reaches the Ticket.
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need access' })
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(0)
  // A person's message reaches the Ticket and lifts the hold.
  const answeredAt = new Date(Date.now() + 1000).toISOString()
  h.runtime.store.atomic(() => {
    const stored = h.runtime.store.tickets.get(ticket.id)!
    stored.inputs.push({ id: 'human-answer', kind: 'trigger', triggerId: 'human-answer', at: answeredAt, human: true })
    stored.updatedAt = answeredAt
    h.runtime.store.tickets.save(stored)
  })
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(1)
})

it('marks the schedule paused when the Mandate no longer holds, and resumes it when it holds again', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'first run')
  const policy = h.runtime.store.settings().policy
  const revision = h.runtime.store.blockRevision('policy')
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [] } } },
    revision, 'panel')
  // The policy-change Input reached the worker; its next report ends that turn.
  ready(ticket.id, 'first run')
  due(ticket.id)
  h.runtime.schedules.tick()
  const paused = h.runtime.store.tickets.get(ticket.id)!
  expect(paused.schedule!.paused).toBe('policy')
  expect(runs(ticket.id)).toHaveLength(0)
  await h.runtime.settings.save('policy', policy, h.runtime.store.blockRevision('policy'), 'panel')
  ready(ticket.id, 'first run')
  h.runtime.schedules.tick()
  expect(h.runtime.store.tickets.get(ticket.id)!.schedule!.paused).toBeUndefined()
  expect(runs(ticket.id)).toHaveLength(1)
})

it('does nothing while processing is paused or the task stopped, and reports the clock in health', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'first run')
  await h.runtime.settings.pause(true, 'panel')
  due(ticket.id)
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(0)
  expect(h.runtime.health.schedule).toMatchObject({ state: 'paused', detail: 'Processing is paused' })
  await h.runtime.settings.pause(false, 'panel')
  h.runtime.schedules.tick()
  expect(h.runtime.health.schedule).toMatchObject({ state: 'ready', detail: expect.stringContaining('Next scheduled run at') })
  h.runtime.engine.stopTicket(ticket.id)
  due(ticket.id)
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(1)
})

it('fires at most one late run after a long downtime and moves nextAt to the next future boundary', async () => {
  const { ticket } = await accepted({ period: 'minutely', every: 15, time_zone: 'UTC' })
  ready(ticket.id, 'first run')
  due(ticket.id, '2026-01-01T00:00:00.000Z')
  h.runtime.schedules.tick()
  expect(runs(ticket.id)).toHaveLength(1)
  expect(h.runtime.store.tickets.get(ticket.id)!.schedule!.nextAt > new Date().toISOString()).toBe(true)
})

it('reports a run it cannot record with the Ticket and the reason', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'first run')
  h.runtime.store.atomic(() => {
    const stored = h.runtime.store.tickets.get(ticket.id)!
    stored.schedule!.timeZone = 'Mars/Olympus'
    stored.schedule!.nextAt = new Date(Date.now() - 60_000).toISOString()
    h.runtime.store.tickets.save(stored)
  })
  h.runtime.schedules.tick()
  expect(h.runtime.health.schedule).toMatchObject({ state: 'error', detail: expect.stringContaining(ticket.id) })
  expect(latestAssignment(h.runtime.store.tickets.get(ticket.id)!)?.report?.state).toBe('ready')
})

it('lists open periodic tasks for the main Session and puts the schedule on the Ticket card and details', async () => {
  const { ticket } = await accepted({ period: 'hourly', every: 2, time_zone: 'UTC' })
  ready(ticket.id, 'first run')
  const listed = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'scheduled' }) as {
    items: { ticket_id: string; state: string; requested_by: string; schedule: Record<string, unknown>; preview: string }[] }
  expect(listed.items).toHaveLength(1)
  expect(listed.items[0]).toMatchObject({ ticket_id: ticket.id, state: 'scheduled', requested_by: 'ou_alice',
    schedule: { period: 'hourly', every: 2, time_zone: 'UTC' }, preview: 'first run' })
  const card = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticket.id}` }) as { schedule: Record<string, unknown> }
  expect(card.schedule).toMatchObject({ period: 'hourly', every: 2, time_zone: 'UTC' })
  // An ended Ticket is not a periodic task any more.
  h.runtime.engine.stopTicket(ticket.id)
  const after = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'scheduled' }) as { items: unknown[] }
  expect(after.items).toEqual([])
})

it('refuses an invalid schedule before creating a Ticket', async () => {
  const trigger = feishu('7', '@bot 每天九点汇报')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
    title: 'Daily', worktree_name: 'daily', acknowledgement: '每天九点。', schedule: { period: 'daily', at: '9:00' } }] }) as {
    results: { refused?: string }[] }
  expect(result.results[0]!.refused).toContain('HH:mm')
  expect(h.runtime.store.tickets.list().some(ticket => ticket.origin.triggerId === trigger.id)).toBe(false)
})

it('shows the last delivery problem in the Scheduled view', async () => {
  const { ticket } = await accepted()
  ready(ticket.id, 'first run')
  const reply = h.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'no changes' })
  h.runtime.store.receipts.settle(h.runtime.store.receipts.get(reply.id)!, 'channelGone')
  const page = await h.api('GET', 'tickets?state=scheduled')
  const row = (page.body.items as { deliveryProblem?: Record<string, unknown> }[])[0]!
  expect(row.deliveryProblem).toMatchObject({ kind: 'dropped', reason: 'channelGone' })
})
