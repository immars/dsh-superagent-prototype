/** Boundary math, validation and wording of periodic schedules (docs/012). */
import { describe, expect, it } from 'vitest'
import { nextScheduleAt, scheduleOf, scheduleText, scheduledBusy, type Schedule, type ScheduleRequest, type Ticket } from '../src/core/index.ts'

const at = (request: ScheduleRequest, now: string): Schedule => scheduleOf(request, now, 'trigger-1')
const next = (request: ScheduleRequest, now: string): string => at(request, now).nextAt
const moved = (schedule: Schedule, now: string): string => nextScheduleAt(schedule, now)

describe('schedule validation', () => {
  it.each([
    ['an unknown period', { period: 'monthly' }],
    ['every 0', { period: 'minutely', every: 0 }],
    ['a negative every', { period: 'hourly', every: -1 }],
    ['a fractional every', { period: 'hourly', every: 1.5 }],
    ['a minutely every beyond the hour', { period: 'minutely', every: 61 }],
    ['an hourly every beyond the day', { period: 'hourly', every: 25 }],
    ['at on minutely', { period: 'minutely', at: '09:00' }],
    ['at on hourly', { period: 'hourly', at: '09:00' }],
    ['an invalid at', { period: 'daily', at: '9:00' }],
    ['a time that does not exist', { period: 'daily', at: '24:00' }],
    ['an unknown zone', { period: 'daily', at: '09:00', timeZone: 'Mars/Olympus' }],
  ] as const)('refuses %s', (_name, request) => {
    expect(() => at(request as ScheduleRequest, '2026-11-06T00:00:00.000Z')).toThrow('Invalid schedule')
  })
  it('records the zone and defaults at to the accept local time for daily and weekly', () => {
    expect(at({ period: 'daily', timeZone: 'Asia/Shanghai' }, '2026-11-06T07:32:00.000Z'))
      .toMatchObject({ period: 'daily', every: 1, at: '15:32', timeZone: 'Asia/Shanghai', fromTriggerId: 'trigger-1' })
    expect(at({ period: 'weekly', timeZone: 'UTC' }, '2026-11-04T02:07:00.000Z')).toMatchObject({ every: 1, at: '02:07' })
    expect(at({ period: 'minutely', every: 15, timeZone: 'UTC' }, '2026-11-06T02:07:00.000Z'))
      .toMatchObject({ period: 'minutely', every: 15, timeZone: 'UTC' })
  })
})

describe('minutely and hourly boundaries', () => {
  it('are clock aligned, with a short last interval before the hour or day', () => {
    expect(next({ period: 'minutely', every: 15, timeZone: 'Asia/Shanghai' }, '2026-11-06T02:07:00.000Z')).toBe('2026-11-06T02:15:00.000Z')
    expect(next({ period: 'minutely', every: 7, timeZone: 'Asia/Shanghai' }, '2026-11-06T02:49:00.000Z')).toBe('2026-11-06T02:56:00.000Z')
    expect(next({ period: 'minutely', every: 7, timeZone: 'Asia/Shanghai' }, '2026-11-06T02:56:00.000Z')).toBe('2026-11-06T03:00:00.000Z')
    expect(next({ period: 'minutely', every: 60, timeZone: 'UTC' }, '2026-11-06T02:07:00.000Z')).toBe('2026-11-06T03:00:00.000Z')
    expect(next({ period: 'hourly', every: 2, timeZone: 'Asia/Shanghai' }, '2026-11-06T02:07:00.000Z')).toBe('2026-11-06T04:00:00.000Z')
    expect(next({ period: 'hourly', every: 5, timeZone: 'Asia/Shanghai' }, '2026-11-06T14:07:00.000Z')).toBe('2026-11-06T16:00:00.000Z')
    expect(next({ period: 'hourly', every: 24, timeZone: 'Asia/Shanghai' }, '2026-11-06T02:07:00.000Z')).toBe('2026-11-06T16:00:00.000Z')
    expect(next({ period: 'minutely', every: 15, timeZone: 'UTC' }, '2026-11-06T02:15:00.000Z')).toBe('2026-11-06T02:30:00.000Z')
    expect(next({ period: 'hourly', every: 2, timeZone: 'UTC' }, '2026-11-06T02:00:00.000Z')).toBe('2026-11-06T04:00:00.000Z')
  })
  it('computes in a half-hour zone', () => {
    expect(next({ period: 'minutely', every: 15, timeZone: 'Asia/Kolkata' }, '2026-11-06T04:37:00.000Z')).toBe('2026-11-06T04:45:00.000Z')
    expect(next({ period: 'daily', every: 1, at: '09:00', timeZone: 'Asia/Kolkata' }, '2026-11-06T04:37:00.000Z'))
      .toBe('2026-11-07T03:30:00.000Z')
  })
  it('skips the repeated hour of a fall-back instead of returning a boundary in the past', () => {
    // 01:05 EST is the second 01:05; the earlier-offset 01:15, 01:30 and 01:45 are already past, so the next boundary is 02:00 EST.
    expect(next({ period: 'minutely', every: 15, timeZone: 'America/New_York' }, '2026-11-01T06:05:00.000Z'))
      .toBe('2026-11-01T07:00:00.000Z')
    const schedule: Schedule = { period: 'minutely', every: 15, timeZone: 'America/New_York', nextAt: '2026-11-01T05:15:00.000Z',
      fromTriggerId: 't' }
    expect(moved(schedule, '2026-11-01T06:05:00.000Z')).toBe('2026-11-01T07:00:00.000Z')
  })
})

describe('daily and weekly boundaries', () => {
  it('advances by the stated interval at the wall-clock time', () => {
    // Accepted at 09:30 local with a 09:00 daily time: the next run is tomorrow at 09:00.
    expect(next({ period: 'daily', every: 1, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-06T01:30:00.000Z'))
      .toBe('2026-11-07T01:00:00.000Z')
    // Accepted at 15:00 on 6 November with a 3-day interval: the next run is 09:00 on 9 November.
    expect(next({ period: 'daily', every: 3, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-06T07:00:00.000Z'))
      .toBe('2026-11-09T01:00:00.000Z')
    // Accepted before 09:00: the current boundary is yesterday's, so the next is today's.
    expect(next({ period: 'daily', every: 1, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-06T00:00:00.000Z'))
      .toBe('2026-11-06T01:00:00.000Z')
    // Accepted on Wednesday for Monday 09:00; every 2 weeks skips the next Monday.
    expect(next({ period: 'weekly', every: 1, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-04T02:00:00.000Z'))
      .toBe('2026-11-09T01:00:00.000Z')
    expect(next({ period: 'weekly', every: 2, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-04T02:00:00.000Z'))
      .toBe('2026-11-16T01:00:00.000Z')
    // Accepted on Monday before 09:00: the next Monday at 09:00 is this morning's boundary plus one week for every 1.
    expect(next({ period: 'weekly', every: 1, at: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-08T22:00:00.000Z'))
      .toBe('2026-11-09T01:00:00.000Z')
    expect(next({ period: 'daily', every: 1, at: '09:00', timeZone: 'UTC' }, '2026-12-31T10:00:00.000Z'))
      .toBe('2027-01-01T09:00:00.000Z')
  })
  it('keeps the wall-clock time across DST changes, moving a nonexistent time forward and taking the earlier ambiguous one', () => {
    // Spring forward: 02:30 does not exist on 8 March 2026 in New York, so the run is at the first valid instant, 03:00 EDT.
    const spring = at({ period: 'daily', every: 1, at: '02:30', timeZone: 'America/New_York' }, '2026-03-07T15:00:00.000Z')
    expect(spring.nextAt).toBe('2026-03-08T07:00:00.000Z')
    // The following day returns to 02:30, now EDT.
    expect(moved(spring, '2026-03-08T08:00:00.000Z')).toBe('2026-03-09T06:30:00.000Z')
    // Fall back: 01:30 is ambiguous on 1 November 2026; the earlier offset (EDT) is used.
    const fall = at({ period: 'daily', every: 1, at: '01:30', timeZone: 'America/New_York' }, '2026-10-31T14:00:00.000Z')
    expect(fall.nextAt).toBe('2026-11-01T05:30:00.000Z')
    expect(moved(fall, '2026-11-01T08:00:00.000Z')).toBe('2026-11-02T06:30:00.000Z')
  })
})

describe('nextScheduleAt', () => {
  it('returns the next future boundary along the cadence after a late run, not every missed boundary', () => {
    const schedule: Schedule = { period: 'minutely', every: 15, timeZone: 'UTC', nextAt: '2026-11-06T02:00:00.000Z', fromTriggerId: 't' }
    expect(moved(schedule, '2026-11-06T02:07:03.000Z')).toBe('2026-11-06T02:15:00.000Z')
    const hourly: Schedule = { ...schedule, period: 'hourly', every: 2, nextAt: '2026-11-06T00:00:00.000Z' }
    expect(moved(hourly, '2026-11-06T09:13:00.000Z')).toBe('2026-11-06T10:00:00.000Z')
    const daily: Schedule = { period: 'daily', every: 3, at: '09:00', timeZone: 'UTC', nextAt: '2026-01-01T09:00:00.000Z', fromTriggerId: 't' }
    const after = moved(daily, '2026-11-06T00:00:00.000Z')
    expect(after > '2026-11-06T00:00:00.000Z').toBe(true)
    expect(after.slice(11)).toBe('09:00:00.000Z')
    expect((Date.parse(after) - Date.parse('2026-01-01T09:00:00.000Z')) % (3 * 86_400_000)).toBe(0)
    expect(moved(schedule, '2026-11-06T01:59:00.000Z')).toBe('2026-11-06T02:00:00.000Z')
  })
})

describe('scheduleText', () => {
  it('reads as the person asked it', () => {
    const text = (request: ScheduleRequest) => scheduleText(at(request, '2026-11-06T02:07:00.000Z'))
    expect(text({ period: 'minutely', every: 15, timeZone: 'Asia/Shanghai' })).toBe('every 15 minutes, Asia/Shanghai')
    expect(text({ period: 'minutely', timeZone: 'Asia/Shanghai' })).toBe('every minute, Asia/Shanghai')
    expect(text({ period: 'hourly', every: 2, timeZone: 'Asia/Shanghai' })).toBe('every 2 hours, Asia/Shanghai')
    expect(text({ period: 'hourly', timeZone: 'Asia/Shanghai' })).toBe('hourly, Asia/Shanghai')
    expect(text({ period: 'daily', every: 3, at: '09:00', timeZone: 'Asia/Shanghai' })).toBe('every 3 days at 09:00, Asia/Shanghai')
    expect(text({ period: 'daily', at: '09:00', timeZone: 'Asia/Shanghai' })).toBe('daily at 09:00, Asia/Shanghai')
    expect(text({ period: 'weekly', at: '09:00', timeZone: 'Asia/Shanghai' })).toBe('every Monday at 09:00, Asia/Shanghai')
    expect(text({ period: 'weekly', every: 2, at: '09:00', timeZone: 'Asia/Shanghai' }))
      .toBe('every 2 weeks on Monday at 09:00, Asia/Shanghai')
  })
})

describe('scheduledBusy', () => {
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd', mandate: { strength: 'explicit',
    policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' }, channels: [], assignments: [
    { id: 'a', state: 'ended', createdAt: '' }], inputs: [], undelivered: [],
  createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: ['x'] }, schedule: { period: 'daily', every: 1, at: '09:00',
    timeZone: 'UTC', nextAt: '2026-11-07T09:00:00.000Z', fromTriggerId: 'x' }, ...overrides })
  it('waits for a pending run Input or a worker that did not report since its last Input', () => {
    const input = { id: 'i', kind: 'scheduled-run' as const, scheduledFor: '2026-11-07T09:00:00.000Z', at: '' }
    expect(scheduledBusy(ticket({ inputs: [input], undelivered: ['i'] }))).toBe(true)
    expect(scheduledBusy(ticket({ assignments: [{ id: 'a', state: 'running', createdAt: '' }] }))).toBe(true)
    expect(scheduledBusy(ticket({ assignments: [{ id: 'a', state: 'running', createdAt: '', deliveredAt: '2026-11-07T09:00:01.000Z',
      report: { state: 'ready', summary: '', at: '2026-11-07T09:00:00.000Z' } }] }))).toBe(true)
    expect(scheduledBusy(ticket({ assignments: [{ id: 'a', state: 'running', createdAt: '', deliveredAt: '2026-11-07T09:00:01.000Z',
      report: { state: 'ready', summary: '', at: '2026-11-07T09:05:00.000Z' } }] }))).toBe(false)
    expect(scheduledBusy(ticket({ assignments: [{ id: 'a', state: 'ended', createdAt: '' }] }))).toBe(false)
    expect(scheduledBusy(ticket())).toBe(false)
  })
})
