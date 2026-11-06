/** Periodic task schedules: validation, wall-clock boundary math, and the words a worker and the panel read. */
import { UserError } from './errors.ts'
import { latestAssignment, type Ticket } from './model.ts'

/** The unit a periodic task repeats in. */
export type SchedulePeriod = 'minutely' | 'hourly' | 'daily' | 'weekly'
/** What an accept names for its schedule, before the first boundary is computed. */
export interface ScheduleRequest {
  period: SchedulePeriod
  /** How many period units between runs; a positive integer, 1 by default. */
  every?: number
  /** Wall-clock `HH:mm` for daily and weekly; absent for minutely and hourly. */
  at?: string
  /** IANA zone; the runtime's local zone by default. */
  timeZone?: string
}
/**
 * The schedule stored on a Ticket: its period and interval, the wall-clock time and zone, and where it goes next.
 * `nextAt` and `lastRunAt` are the clock's own facts, and `paused` marks a schedule whose Mandate no longer holds.
 */
export interface Schedule {
  period: SchedulePeriod
  every: number
  /** Wall-clock `HH:mm` for daily and weekly; absent for minutely and hourly. */
  at?: string
  /** IANA zone, such as Asia/Shanghai. */
  timeZone: string
  /** The next due instant, always after the accept or the last fired run. */
  nextAt: string
  /** The Trigger that created the task. */
  fromTriggerId: string
  /** When the clock last fired a run. */
  lastRunAt?: string
  /** Set while the schedule must not fire because the Mandate no longer holds. */
  paused?: 'policy'
}
/** A wall-clock reading in one zone, with seconds as a boundary needs them. */
interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const PERIODS: readonly SchedulePeriod[] = ['minutely', 'hourly', 'daily', 'weekly']
/** Formatters by zone, built once per process: creating one for every boundary would dominate a clock tick. */
const formatters = new Map<string, Intl.DateTimeFormat>()
/** The runtime's local zone, recorded when a request names no zone. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const invalid = (reason: string): UserError => new UserError('invalidSchedule', { reason })
/** A formatter for `zone`, refusing an unknown zone. */
function formatter(zone: string): Intl.DateTimeFormat {
  const known = formatters.get(zone)
  if (known) return known
  let built: Intl.DateTimeFormat
  try {
    built = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    throw invalid(`unknown time zone ${zone}`)
  }
  formatters.set(zone, built)
  return built
}
/** The wall-clock reading of an instant in `zone`. */
function wallAt(instant: number, zone: string): Wall {
  const parts: Record<string, string> = {}
  for (const part of formatter(zone).formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = part.value
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    minute: Number(parts.minute), second: Number(parts.second) }
}
/** The zone's offset from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const wall = wallAt(instant, zone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}
const compareWall = (a: Wall, b: Wall): number => a.year - b.year || a.month - b.month || a.day - b.day || a.hour - b.hour
  || a.minute - b.minute || a.second - b.second
const sameWall = (a: Wall, b: Wall): boolean => compareWall(a, b) === 0
/**
 * The instant of a wall-clock reading in `zone`: the earlier offset for an ambiguous time, and the first valid instant
 * after a nonexistent one, as docs/012 requires.
 */
function instantOf(wall: Wall, zone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  // Probe around the reading so both offsets of a transition are known, then keep the exact solutions.
  const offsets = new Set<number>()
  for (const probe of [naive - 2 * DAY, naive - 6 * HOUR, naive, naive + 6 * HOUR, naive + 2 * DAY]) offsets.add(offsetAt(probe, zone))
  const candidates = [...offsets].map(offset => naive - offset)
  const exact = candidates.filter(instant => sameWall(wallAt(instant, zone), wall)).sort((a, b) => a - b)
  if (exact.length) return exact[0]!
  // A nonexistent local time: the first instant whose wall clock is at or after it.
  const start = Math.min(...candidates)
  const end = Math.max(...candidates) + 2 * DAY
  for (let instant = start; instant <= end; instant += MINUTE) if (compareWall(wallAt(instant, zone), wall) >= 0) return instant
  return naive - offsetAt(naive, zone)
}
/** The date `days` days after `wall`, keeping its time of day and resetting seconds. */
function addDays(wall: Wall, days: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: wall.hour, minute: wall.minute, second: 0 }
}
const weekday = (wall: Wall): number => new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
const wallText = (wall: Wall): string => `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`
const AT = /^([01]\d|2[0-3]):[0-5]\d$/
const atOf = (schedule: Pick<Schedule, 'at'>): string => {
  if (!schedule.at) throw invalid('daily and weekly schedules need at, such as 09:00')
  return schedule.at
}
/** The wall time `at` as hours and minutes. */
const atParts = (at: string): { hour: number; minute: number } => ({ hour: Number(at.slice(0, 2)), minute: Number(at.slice(3, 5)) })
const atWall = (date: Wall, at: string): Wall => ({ ...addDays({ ...date, second: 0 }, 0), ...atParts(at), second: 0 })
/** The next wall-clock boundary strictly after a wall reading, for a minutely or hourly schedule. */
function nextAlignedOnce(period: 'minutely' | 'hourly', every: number, wall: Wall, zone: string): number {
  if (period === 'minutely') {
    const minute = Math.floor(wall.minute / every) * every + every
    if (minute < 60) return instantOf({ ...wall, minute, second: 0 }, zone)
    // The last interval before the hour is shorter when `every` does not divide 60.
    return instantOf({ ...(wall.hour === 23 ? addDays(wall, 1) : wall), hour: wall.hour === 23 ? 0 : wall.hour + 1, minute: 0, second: 0 }, zone)
  }
  const hour = Math.floor(wall.hour / every) * every + every
  if (hour < 24) return instantOf({ ...wall, hour, minute: 0, second: 0 }, zone)
  // The last interval before the day is shorter when `every` does not divide 24.
  return instantOf({ ...addDays(wall, 1), hour: 0, minute: 0, second: 0 }, zone)
}
/** Add a number of minutes to a wall reading. */
function addMinutes(wall: Wall, minutes: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute + minutes))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(),
    minute: date.getUTCMinutes(), second: 0 }
}
/**
 * The first clock-aligned boundary strictly after `now`. An ambiguous wall time uses the earlier offset, so a boundary in
 * the repeated hour of a fall-back is already past; the search moves wall time forward until the boundary is future again.
 */
function nextAligned(period: 'minutely' | 'hourly', every: number, now: number, zone: string): number {
  let wall = wallAt(now, zone)
  for (let guard = 0; guard < 24 * 60; guard++) {
    const candidate = nextAlignedOnce(period, every, wall, zone)
    if (candidate > now) return candidate
    wall = addMinutes(wallAt(candidate, zone), 1)
  }
  return nextAlignedOnce(period, every, wall, zone)
}
/** The most recent daily boundary at or before `now`: today's `at`, or yesterday's when it has not come yet. */
function lastDaily(at: string, now: number, zone: string): Wall {
  const today = wallAt(now, zone), candidate = atWall(today, at)
  return instantOf(candidate, zone) <= now ? candidate : atWall(addDays(today, -1), at)
}
/** The most recent weekly boundary, a Monday at `at`, at or before `now`. */
function lastWeekly(at: string, now: number, zone: string): Wall {
  const today = wallAt(now, zone)
  const monday = addDays(today, -((weekday(today) + 6) % 7))
  const candidate = atWall(monday, at)
  return instantOf(candidate, zone) <= now ? candidate : atWall(addDays(monday, -7), at)
}
/** Validate a requested schedule and compute its first `nextAt` from the accept instant. */
export function scheduleOf(request: ScheduleRequest, nowIso: string, fromTriggerId: string): Schedule {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) throw invalid('the accept time is not a timestamp')
  const period = request.period
  if (!PERIODS.includes(period)) throw invalid(`unknown period ${String(period)}; use minutely, hourly, daily or weekly`)
  const zone = request.timeZone?.trim() || localTimeZone()
  formatter(zone)
  const every = request.every ?? 1
  if (!Number.isInteger(every) || every < 1) throw invalid('every must be a positive integer')
  if (period === 'minutely' && every > 60) throw invalid('minutely every must be from 1 to 60; use hourly for longer intervals')
  if (period === 'hourly' && every > 24) throw invalid('hourly every must be from 1 to 24; use daily for longer intervals')
  let at = request.at?.trim() || undefined
  if (period === 'minutely' || period === 'hourly') {
    if (at !== undefined) throw invalid('at is only for daily and weekly schedules')
  } else {
    at ??= wallText(wallAt(now, zone))
    if (!AT.test(at)) throw invalid(`at must be a wall-clock time from 00:00 to 23:59, such as 09:00; got ${at}`)
  }
  const schedule: Schedule = { period, every, ...(at ? { at } : {}), timeZone: zone, nextAt: '', fromTriggerId }
  const next = period === 'minutely' || period === 'hourly' ? nextAligned(period, every, now, zone)
    : period === 'daily' ? instantOf(addDays(lastDaily(atOf(schedule), now, zone), every), zone)
    : instantOf(addDays(lastWeekly(atOf(schedule), now, zone), every * 7), zone)
  return { ...schedule, nextAt: new Date(next).toISOString() }
}
/**
 * The next boundary after a due `nextAt` along the schedule's cadence, and the first one after `now`. Minutely and hourly
 * boundaries are clock-aligned, so the next one is computed from `now`; daily and weekly stay on the cadence anchored at
 * the stored boundary, and a missed interval jumps over every boundary but one.
 */
export function nextScheduleAt(schedule: Schedule, nowIso: string): string {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) throw invalid('the clock time is not a timestamp')
  if (Date.parse(schedule.nextAt) > now) return schedule.nextAt
  if (schedule.period === 'minutely' || schedule.period === 'hourly') {
    return new Date(nextAligned(schedule.period, schedule.every, now, schedule.timeZone)).toISOString()
  }
  const step = schedule.every * (schedule.period === 'weekly' ? 7 : 1)
  const at = atOf(schedule)
  let date = addDays(atWall(wallAt(Date.parse(schedule.nextAt), schedule.timeZone), at), step)
  let next = instantOf(date, schedule.timeZone)
  // At most one late run: jump over every missed boundary to the first future one.
  for (let guard = 0; next <= now && guard < 100_000; guard++) {
    date = addDays(date, step)
    next = instantOf(date, schedule.timeZone)
  }
  return new Date(next).toISOString()
}
/** Whether a scheduled run is still working on the ticket: an Input waits, or the worker has not reported since its last Input. */
export function scheduledBusy(ticket: Ticket): boolean {
  if (ticket.undelivered.some(id => ticket.inputs.find(input => input.id === id)?.kind === 'scheduled-run')) return true
  const assignment = latestAssignment(ticket)
  if (!assignment || assignment.state === 'ended') return false
  const report = assignment.report
  return !report || (assignment.deliveredAt ?? '') >= report.at
}
/** The schedule as a worker and an acknowledgement read it: `every 15 minutes, Asia/Shanghai`. */
export function scheduleText(schedule: Pick<Schedule, 'period' | 'every' | 'at' | 'timeZone'>): string {
  const every = schedule.every
  const interval = schedule.period === 'minutely' ? every === 1 ? 'every minute' : `every ${every} minutes`
    : schedule.period === 'hourly' ? every === 1 ? 'hourly' : `every ${every} hours`
    : schedule.period === 'daily' ? every === 1 ? `daily at ${schedule.at}` : `every ${every} days at ${schedule.at}`
    : every === 1 ? `every Monday at ${schedule.at}` : `every ${every} weeks on Monday at ${schedule.at}`
  return `${interval}, ${schedule.timeZone}`
}
