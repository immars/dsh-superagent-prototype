/** Periodic Digest: schedules per-task reports, reads Trigger windows from the Store, aggregates them through Source descriptors, and queues one message. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import { KV } from '../kv.ts'
import type { DigestTask } from '../policy.ts'
import type { Health } from '../sources/host.ts'
import type { DigestBucket, Localized, SourceDigest } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
/** How often the service looks for a due period; a report goes out within a minute of the boundary. */
const TICK_MS = 30_000

/** What `Digest` needs from the application; tests replace it with small fakes. */
export interface DigestHost {
  readonly store: Pick<Store, 'settings' | 'get' | 'set' | 'read'> & { readonly triggers: Pick<Store['triggers'], 'get'> }
  readonly sources: Pick<SourceRegistry, 'kindOf' | 'instance' | 'instances' | 'channelAllowed'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly health: Pick<HealthBoard, 'claim'>
  readonly lifetime: AbortSignal
  configured(): boolean
  paused(): boolean
}

/** The Source facts the aggregator needs for one Trigger. */
export interface DigestSourceInfo { id: string; title: Localized; digest: SourceDigest }
/** One display bucket: the distinct entities and all events that counted toward it. */
export interface BucketCount { label: Localized; entities: Set<string>; events: number }
interface GroupCount { group: string; buckets: Map<string, BucketCount> }
interface SourceCount { title: Localized; groups: Map<string, GroupCount>; entities: Set<string>; events: number }
export interface Aggregated { sources: Map<string, SourceCount>; entities: Set<string>; events: number }

/** The period length in milliseconds for a task's schedule. */
export const periodLength = (task: Pick<DigestTask, 'period'>): number =>
  task.period === 'hourly' ? HOUR : task.period === 'daily' ? DAY : WEEK

interface Wall { year: number; month: number; day: number; hour: number; minute: number }
const pad = (value: number): string => String(value).padStart(2, '0')
/** The wall-clock fields a zone shows at `ms`. */
function wallAt(ms: number, timeZone: string): Wall {
  const parts = new Map(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value] as const))
  return { year: Number(parts.get('year')), month: Number(parts.get('month')), day: Number(parts.get('day')),
    hour: Number(parts.get('hour')), minute: Number(parts.get('minute')) }
}
/**
 * The instant a zone shows as `wall`, resolved from its UTC offset in two passes so a DST transition still lands on the
 * requested wall-clock time. Zones with a non-whole-hour offset also work: only wall fields are used.
 */
function utcOf(wall: Wall, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  let guess = asUtc
  for (let pass = 0; pass < 2; pass++) {
    const local = wallAt(guess, timeZone)
    const asLocal = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0)
    guess = asUtc - (asLocal - guess)
  }
  return guess
}
function addDays(wall: Wall, days: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}
/**
 * The start of the most recent period at or before `now`: the top of the local hour for `hourly`, `at` on the local day
 * for `daily`, and Monday's `at` for `weekly`. The report covers the period that ended at this boundary.
 */
export function periodStart(now: number, task: Pick<DigestTask, 'period' | 'at' | 'timeZone'>): number {
  const current = wallAt(now, task.timeZone)
  if (task.period === 'hourly') return utcOf({ ...current, minute: 0 }, task.timeZone)
  const [hour, minute] = task.at.split(':').map(Number)
  if (task.period === 'daily') {
    let candidate = utcOf({ ...current, hour: hour!, minute: minute! }, task.timeZone)
    if (candidate > now) candidate = utcOf({ ...addDays(current, -1), hour: hour!, minute: minute! }, task.timeZone)
    return candidate
  }
  const weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay()
  const sinceMonday = (weekday + 6) % 7
  let candidate = utcOf({ ...addDays(current, -sinceMonday), hour: hour!, minute: minute! }, task.timeZone)
  if (candidate > now) candidate = utcOf({ ...addDays(current, -sinceMonday - 7), hour: hour!, minute: minute! }, task.timeZone)
  return candidate
}

/** The fallback descriptor for a Source kind without one: each Thread is an entity, counted under one bucket. */
export const FALLBACK_DIGEST: SourceDigest = {
  entity: trigger => trigger.threads[0]?.id ?? trigger.id,
  buckets: () => [{ id: 'all', label: { zh: '变更', en: 'Change' } }],
}

const counted = <K, V>(map: Map<K, V>, keyValue: K, create: () => V): V => {
  let value = map.get(keyValue)
  if (!value) { value = create(); map.set(keyValue, value) }
  return value
}
/**
 * Counts distinct entities per Source/group/bucket and all events. An entity counts once per bucket however many events
 * it produced; a Trigger that names several buckets counts in each, while the Source and overall totals count it once.
 */
export function aggregate(triggers: readonly Trigger[], info: (trigger: Trigger) => DigestSourceInfo): Aggregated {
  const aggregated: Aggregated = { sources: new Map(), entities: new Set(), events: 0 }
  for (const trigger of triggers) {
    const { id, title, digest } = info(trigger)
    const entity = digest.entity(trigger) || trigger.id
    const source = counted(aggregated.sources, id, () => ({ title, groups: new Map(), entities: new Set<string>(), events: 0 }))
    source.entities.add(entity)
    source.events += 1
    aggregated.entities.add(`${id}\n${entity}`)
    aggregated.events += 1
    const groupName = digest.group?.(trigger)?.trim() ?? ''
    const group = counted(source.groups, groupName, () => ({ group: groupName, buckets: new Map() }))
    for (const bucket of digest.buckets(trigger)) {
      const count = counted(group.buckets, bucket.id, () => ({ label: bucket.label, entities: new Set<string>(), events: 0 }))
      count.entities.add(entity)
      count.events += 1
    }
  }
  return aggregated
}

const periodName = (task: DigestTask): { zh: string; en: string } => task.period === 'hourly' ? { zh: '一小时', en: 'hour' }
  : task.period === 'daily' ? { zh: '一天', en: 'day' } : { zh: '一周', en: 'week' }
const stamp = (ms: number, timeZone: string): string => {
  const wall = wallAt(ms, timeZone)
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`
}
/** The report's leading label: the task's title, else the project a Trigger names, else the configured project, else a neutral label. */
export function titleOf(task: DigestTask, triggers: readonly Trigger[], fallback?: string): string {
  if (task.title) return task.title
  for (const trigger of triggers) {
    const project = String(trigger.meta.project ?? '').trim()
    if (project) return project
    const repository = String(trigger.meta.repository ?? '').trim()
    if (repository) return repository
  }
  if (fallback) return fallback
  return task.language === 'zh' ? '变更' : 'Changes'
}

/** One formatted report and the totals its header states. */
export interface DigestReport { text: string; entities: number; events: number }

/**
 * Formats a deterministic report for one window, in the task's language. It keeps the whole message within the IM word
 * limit by adding detail lines only while they fit and noting that more remain; the header and totals always stay.
 */
export function formatReport(input: { task: DigestTask; start: number; end: number; triggers: readonly Trigger[]; truncated: boolean;
  title: string; info: (trigger: Trigger) => DigestSourceInfo }): DigestReport {
  const { task, start, end, triggers, truncated, info } = input
  const zh = task.language === 'zh'
  // A long title must not eat the IM word budget; the Task schema limits it, and the message shortens it further.
  const title = input.title.length > 20 ? `${input.title.slice(0, 20)}…` : input.title
  const aggregated = aggregate(triggers, info)
  const period = periodName(task)
  const heading = zh
    ? `📊 ${title} 周期摘要（${stamp(start, task.timeZone)}–${stamp(end, task.timeZone)}，${task.timeZone}）`
    : `📊 ${title} digest (${stamp(start, task.timeZone)}–${stamp(end, task.timeZone)}, ${task.timeZone})`
  const summary = aggregated.events === 0
    ? (zh ? `过去${period.zh}，${title} 没有变更。` : `No changes in ${title} in the past ${period.en}.`)
    : (zh ? `过去${period.zh}，${title} 有 ${aggregated.entities.size} 个对象发生 ${aggregated.events} 次变更。`
      : `${title} had ${aggregated.entities.size} entities and ${aggregated.events} events in the past ${period.en}.`)
  const lines = [heading, '', summary]
  let omitted = 0
  for (const source of aggregated.sources.values()) {
    for (const group of source.groups.values()) {
      const block = [zh ? `${source.title.zh}${group.group ? ` · ${group.group}` : ''}` : `${source.title.en}${group.group ? ` · ${group.group}` : ''}`]
      for (const bucket of group.buckets.values()) {
        block.push(zh ? `· ${bucket.label.zh}：${bucket.entities.size} 个对象 / ${bucket.events} 次`
          : `· ${bucket.label.en}: ${bucket.entities.size} entities / ${bucket.events} events`)
      }
      if (wordCount([...lines, '', ...block].join('\n')) > IM_WORDS - 3) { omitted += 1; continue }
      lines.push('', ...block)
    }
  }
  if (truncated) lines.push('', zh ? '（窗口内变更过多，只统计了最近的变更。）' : '(The window had too many changes; only the latest are counted.)')
  if (omitted) lines.push(zh ? `（还有 ${omitted} 组未显示。）` : `(${omitted} more groups are not shown.)`)
  let text = lines.join('\n')
  // The header and totals always stay; drop every detail when even a shortened report would overflow.
  if (wordCount(text) > IM_WORDS) text = [...lines.slice(0, 3), '', zh ? '（内容过多，只显示部分。）' : '(Too much to show; only part is listed.)'].join('\n')
  return { text, entities: aggregated.entities.size, events: aggregated.events }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Owns periodic report tasks: on a short tick it reads `settings.digest`, reports the period that ended for each due task,
 * and records the boundary in KV after queueing the message, so a restart never repeats a period and a failed period retries.
 * It reads every stored Trigger, including filtered and unassessed ones, because a Digest reports what the Source observed.
 */
export class Digest {
  private readonly entry: HealthEntry
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  constructor(private readonly host: DigestHost, private readonly now: () => number = () => Date.now()) {
    this.entry = host.health.claim('digest', { state: 'starting', detail: '' })
    host.lifetime.addEventListener('abort', () => this.clear(), { once: true })
  }
  /** Begins the periodic tick and attempts one run immediately, so a missed period is reported after a restart. */
  start(): void {
    this.clear()
    this.timer = setInterval(() => { this.tick() }, TICK_MS)
    this.timer.unref?.()
    this.tick()
  }
  /** Stops the tick and waits for an in-flight run to finish; queued effects keep running under their own service. */
  async stop(): Promise<void> {
    this.clear()
    await this.pending
  }
  /** Runs one tick now; exposed for tests and for a settings save that wants an immediate check. */
  tick(): void {
    if (this.pending) return
    this.pending = this.run().catch((error: unknown) => {
      this.report({ state: 'error', detail: `Digest failed: ${message(error)}` })
    }).finally(() => { this.pending = undefined })
  }
  /** Runs every enabled task that has a completed period not yet reported. */
  async run(): Promise<void> {
    const { store } = this.host
    if (!this.host.configured()) { this.report({ state: 'paused', detail: 'Waiting for the deployment check' }); return }
    if (this.host.paused()) { this.report({ state: 'paused', detail: 'Processing is paused' }); return }
    const tasks = store.settings().digest.tasks
    if (!tasks.length) { this.report({ state: 'paused', detail: 'No digest task is configured' }); return }
    const done: string[] = [], failed: string[] = []
    for (const task of tasks) {
      if (!task.enabled) continue
      try {
        const result = await this.runTask(task)
        if (result) done.push(result)
      } catch (error) { failed.push(`${task.id}: ${message(error)}`) }
    }
    if (failed.length) this.report({ state: 'error', detail: failed.join('; ') })
    else this.report({ state: 'ready', detail: done.length ? done.join('; ') : 'No digest period is due' })
  }
  private report(value: Health): void { this.entry.set({ ...value, at: new Date(this.now()).toISOString() }) }
  private clear(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined } }
  private async runTask(task: DigestTask): Promise<string | undefined> {
    const { store, sources } = this.host
    const boundary = periodStart(this.now(), task)
    const previous = store.get(KV.digest.lastEnd(task.id)) ?? 0
    if (previous >= boundary) return undefined
    const start = boundary - periodLength(task)
    const limit = task.maxTriggers + 1
    const window = store.read.triggerWindow({ since: new Date(start).toISOString(), until: new Date(boundary).toISOString(),
      sources: task.sources.length ? task.sources : this.enabledSources(), limit })
    const truncated = window.length > task.maxTriggers
    const triggers = truncated ? window.slice(0, task.maxTriggers) : window
    // A window with no Trigger still names the task's project, so a zero-change report is recognizable.
    const fallback = (field: string): string | undefined => task.sources
      .map(id => String(this.host.sources.instance(id)?.config[field] ?? '').trim()).find(Boolean)
    const title = titleOf(task, triggers, fallback('project') ?? fallback('repository'))
    const report = formatReport({ task, start, end: boundary, triggers, truncated, title, info: trigger => this.describe(trigger) })
    if (triggers.length || task.includeEmpty) {
      const channel = this.channelOf(task)
      if (!sources.channelAllowed({ source: channel.source, address: channel.address }))
        throw new Error(`The ${channel.source} channel of trigger ${task.channel.triggerId} is not available`)
      this.host.outbox.send({ id: key('digest', task.id, String(boundary), channel.source, channel.thread), channel,
        text: report.text, kind: 'notice' })
    }
    store.set(KV.digest.lastEnd(task.id), boundary)
    return `${task.id}: ${report.entities} entities, ${report.events} events`
  }
  private enabledSources(): string[] {
    return this.host.sources.instances().filter(instance => instance.installed && instance.enabled).map(instance => instance.id)
  }
  private channelOf(task: DigestTask): ChannelRef {
    const trigger = this.host.store.triggers.get(task.channel.triggerId)
    if (!trigger) throw new Error(`The digest trigger ${task.channel.triggerId} is not in the Store`)
    if (!trigger.channel) throw new Error(`The digest trigger ${task.channel.triggerId} has no reply channel`)
    if (trigger.channel.source !== task.channel.source)
      throw new Error(`The digest trigger ${task.channel.triggerId} is on ${trigger.channel.source}, not ${task.channel.source}`)
    return trigger.channel
  }
  private describe(trigger: Trigger): DigestSourceInfo {
    const { sources } = this.host
    const kind = sources.kindOf(trigger.source)
    const instance = sources.instance(trigger.source)
    const base = kind?.title ?? { zh: trigger.source, en: trigger.source }
    const label = instance && instance.kind !== instance.id ? instance.label ?? instance.id : undefined
    return { id: trigger.source, title: label ? { zh: `${base.zh} · ${label}`, en: `${base.en} · ${label}` } : base,
      digest: kind?.digest ?? FALLBACK_DIGEST }
  }
}
