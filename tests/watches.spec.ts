/** Completion watches on a running Runtime (docs/013): a marker or a process end wakes the worker, expiry, and the bounds. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accept one ticket and return it with its worker Session. */
async function ticketed(id = '1') {
  const { ticket } = await h.acceptedTicket(feishu(id, '@bot 启动一次长训练'))
  return { ticket, sessionId: `worker-${ticket.id}` }
}
const report = (sessionId: string, args: Record<string, unknown>) =>
  h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Training started.', ...args }) as Promise<{ watch_id?: string }>
const stored = (ticketId: string) => h.runtime.store.tickets.get(ticketId)!
const ends = (ticketId: string) => stored(ticketId).inputs.filter(input => input.kind === 'watch-ended')

it('turns an appeared marker into one watch-ended Input, removes the watch and wakes the worker with it', async () => {
  const { ticket, sessionId } = await ticketed()
  const marker = join(h.directory, 'train.done')
  const result = await report(sessionId, { watch: { label: 'training', file: marker, note: 'Read train.log for the exit status.' } })
  expect(result.watch_id).toBeTruthy()
  expect(stored(ticket.id).watches).toHaveLength(1)
  writeFileSync(marker, '0')
  h.runtime.watches.tick()
  const updated = stored(ticket.id)
  expect(updated.watches).toBeUndefined()
  expect(ends(ticket.id)).toHaveLength(1)
  expect(ends(ticket.id)[0]).toMatchObject({ kind: 'watch-ended', label: 'training', status: 'ended',
    condition: { kind: 'file', path: marker }, note: 'Read train.log for the exit status.' })
  await h.runtime.idle()
  const texts = h.deliveries.mock.calls.map(([call]) => call.text)
  expect(texts.some(text => text.includes('Completion watch "training" fired'))).toBe(true)
  expect(texts.some(text => text.includes('What to inspect: Read train.log for the exit status.'))).toBe(true)
  // A replayed tick records nothing more.
  h.runtime.watches.tick()
  expect(ends(ticket.id)).toHaveLength(1)
})

it('keeps waiting while the process lives and fires once its PID is gone', async () => {
  const { ticket, sessionId } = await ticketed()
  await report(sessionId, { watch: { label: 'live', pid: process.pid } })
  h.runtime.watches.tick()
  expect(stored(ticket.id).watches).toHaveLength(1)
  expect(ends(ticket.id)).toEqual([])
  await report(sessionId, { watch: { label: 'gone', pid: 2_000_000 } })
  h.runtime.watches.tick()
  expect(stored(ticket.id).watches).toHaveLength(1)
  expect(ends(ticket.id)).toHaveLength(1)
  expect(ends(ticket.id)[0]).toMatchObject({ label: 'gone', status: 'ended', condition: { kind: 'process', pid: 2_000_000 } })
})

it('reports an expired watch so the worker checks whether the work still runs', async () => {
  const { ticket, sessionId } = await ticketed()
  const marker = join(h.directory, 'slow.done')
  await report(sessionId, { watch: { label: 'slow', file: marker, expires_in_hours: 1 } })
  h.runtime.store.atomic(() => {
    const current = stored(ticket.id)
    current.watches![0]!.expiresAt = new Date(Date.now() - 1000).toISOString()
    h.runtime.store.tickets.save(current)
  })
  h.runtime.watches.tick()
  expect(stored(ticket.id).watches).toBeUndefined()
  expect(ends(ticket.id)).toHaveLength(1)
  expect(ends(ticket.id)[0]).toMatchObject({ label: 'slow', status: 'expired' })
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => call.text).some(text => text.includes('expired at'))).toBe(true)
})

it('deduplicates the same condition and label and refuses a ninth watch', async () => {
  const { ticket, sessionId } = await ticketed()
  await report(sessionId, { watch: { label: 'same', file: join(h.directory, 'same.done') } })
  await report(sessionId, { watch: { label: 'same', file: join(h.directory, 'same.done') } })
  expect(stored(ticket.id).watches).toHaveLength(1)
  for (let index = 0; index < 7; index++) await report(sessionId, { watch: { label: `run-${index}`, file: join(h.directory, `run-${index}.done`) } })
  expect(stored(ticket.id).watches).toHaveLength(8)
  await expect(report(sessionId, { watch: { label: 'ninth', file: join(h.directory, 'ninth.done') } })).rejects.toThrow('at most 8')
  await expect(report(sessionId, { watch: { label: 'both', pid: process.pid, file: join(h.directory, 'both.done') } })).rejects.toThrow('exactly one')
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', watch: { label: 'late', file: join(h.directory, 'late.done') } }))
    .rejects.toThrow('progress report')
})

it('holds the watch-ended Input while the Ticket waits for a person', async () => {
  const { ticket, sessionId } = await ticketed()
  const marker = join(h.directory, 'held.done')
  await report(sessionId, { watch: { label: 'held', file: marker } })
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need access' })
  writeFileSync(marker, '0')
  h.runtime.watches.tick()
  const input = ends(ticket.id)[0]!
  expect(input).toBeTruthy()
  expect(stored(ticket.id).undelivered).not.toContain(input.id)
  expect(h.runtime.health.watch).toMatchObject({ state: 'ready' })
})

it('does nothing while processing is paused and drops watches when the Ticket ends', async () => {
  const { ticket, sessionId } = await ticketed()
  const marker = join(h.directory, 'paused.done')
  await report(sessionId, { watch: { label: 'paused', file: marker } })
  await h.runtime.settings.pause(true, 'panel')
  writeFileSync(marker, '0')
  h.runtime.watches.tick()
  expect(stored(ticket.id).watches).toHaveLength(1)
  expect(h.runtime.health.watch).toMatchObject({ state: 'paused' })
  await h.runtime.settings.pause(false, 'panel')
  h.runtime.watches.tick()
  expect(ends(ticket.id)).toHaveLength(1)
  // A watch left on an ended Ticket is dropped and never fires.
  const other = await ticketed('2')
  await report(other.sessionId, { watch: { label: 'other', file: join(h.directory, 'other.done') } })
  h.runtime.engine.stopTicket(other.ticket.id)
  h.runtime.watches.tick()
  expect(stored(other.ticket.id).watches).toBeUndefined()
})

it('reports the watch clock in health', async () => {
  const { sessionId } = await ticketed()
  h.runtime.watches.tick()
  expect(h.runtime.health.watch).toMatchObject({ state: 'ready', detail: 'No completion watch is armed' })
  await report(sessionId, { watch: { label: 'health', file: join(h.directory, 'health.done') } })
  h.runtime.watches.tick()
  expect(h.runtime.health.watch).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 completion watch') })
})
