/** Periodic Digest: time-window boundaries, Source aggregation, message formatting, and the service's idempotent scheduling. */
import { expect, it } from 'vitest'
import { Digest, FALLBACK_DIGEST, aggregate, formatReport, periodStart, titleOf, type DigestHost, type DigestSourceInfo } from '../src/app/digest.ts'
import { IM_WORDS, wordCount } from '../src/infra/text.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { DigestConfigSchema, SettingsSchema, type DigestTask } from '../src/policy.ts'
import { jiraKind } from '../src/sources/jira.ts'
import type { Health } from '../src/sources/host.ts'
import type { SourceDigest } from '../src/sources/kind.ts'

const at = (text: string): string => new Date(text).toISOString()
const task = (overrides: Partial<DigestTask> = {}): DigestTask => ({
  id: 'j6aitc-hourly', enabled: true, period: 'hourly', at: '00:00', timeZone: 'Asia/Shanghai', sources: ['jira'],
  channel: { source: 'feishu', triggerId: 'om_request' }, language: 'zh', maxTriggers: 5000, includeEmpty: true,
  ...overrides,
})
const trigger = (id: string, issue: string, change: string, time: string, issueType = 'Bug', project = 'J6AITC'): Trigger => ({
  id, source: 'jira', threads: [{ source: 'jira', id: issue }], actor: { source: 'jira', id: 'alice' }, human: true, at: at(time),
  text: `${issue}: summary`, meta: { issue, change, issueType, project },
})
const info = (trigger: Trigger): DigestSourceInfo => ({ id: trigger.source, title: { zh: 'JIRA', en: 'Jira' }, digest: jiraKind.digest! })

it('finds the most recent period boundary in a zone, for hourly, daily and weekly schedules', () => {
  // 2026-11-06T03:20Z is 11:20 in Asia/Shanghai; the hour started at 03:00Z.
  expect(periodStart(Date.parse('2026-11-06T03:20:00Z'), task())).toBe(Date.parse('2026-11-06T03:00:00Z'))
  // Daily at 09:30 in Asia/Shanghai: before 09:30 the previous day's boundary still applies.
  const daily = task({ period: 'daily', at: '09:30' })
  expect(periodStart(Date.parse('2026-11-06T01:29:00Z'), daily)).toBe(Date.parse('2026-11-05T01:30:00Z'))
  expect(periodStart(Date.parse('2026-11-06T01:30:00Z'), daily)).toBe(Date.parse('2026-11-06T01:30:00Z'))
  // Weekly weeks start on Monday: 2026-11-06 is a Friday, so the boundary is Monday 09:30 in the zone.
  const weekly = task({ period: 'weekly', at: '09:30' })
  expect(periodStart(Date.parse('2026-11-06T03:20:00Z'), weekly)).toBe(Date.parse('2026-11-02T01:30:00Z'))
  expect(periodStart(Date.parse('2026-11-02T01:00:00Z'), weekly)).toBe(Date.parse('2026-10-26T01:30:00Z'))
  // UTC keeps the same wall clock, and a half-hour zone keeps its own hour.
  const utc = task({ timeZone: 'UTC' })
  expect(periodStart(Date.parse('2026-11-06T03:20:00Z'), utc)).toBe(Date.parse('2026-11-06T03:00:00Z'))
  const kolkata = task({ timeZone: 'Asia/Kolkata' })
  expect(periodStart(Date.parse('2026-11-06T03:40:00Z'), kolkata)).toBe(Date.parse('2026-11-06T03:30:00Z'))
  // A daily boundary follows the zone's offset across DST: EDT in July, EST on the November fall-back day.
  const newYork = task({ period: 'daily', at: '09:30', timeZone: 'America/New_York' })
  expect(periodStart(Date.parse('2026-07-01T16:00:00Z'), newYork)).toBe(Date.parse('2026-07-01T13:30:00Z'))
  expect(periodStart(Date.parse('2026-11-01T16:00:00Z'), newYork)).toBe(Date.parse('2026-11-01T14:30:00Z'))
})

it('counts distinct entities per bucket and all events, and a Trigger with several buckets in each', () => {
  const triggers = [trigger('1', 'J6AITC-1', 'created', '2026-11-06T02:10:00Z'), trigger('2', 'J6AITC-1', 'commented', '2026-11-06T02:20:00Z'),
    trigger('3', 'J6AITC-2', 'commented', '2026-11-06T02:30:00Z')]
  const result = aggregate(triggers, info)
  const source = result.sources.get('jira')!
  expect([result.entities.size, result.events]).toEqual([2, 3])
  expect([source.entities.size, source.events]).toEqual([2, 3])
  const bug = source.groups.get('Bug')!
  expect(bug.buckets.get('created')!.entities.size).toBe(1)
  expect([bug.buckets.get('commented')!.entities.size, bug.buckets.get('commented')!.events]).toEqual([2, 2])
  // A Trigger naming two buckets counts once as an entity but once in each bucket.
  const twice: SourceDigest = { entity: t => t.id, buckets: () => [{ id: 'a', label: { zh: 'A', en: 'A' } }, { id: 'b', label: { zh: 'B', en: 'B' } }] }
  const many = aggregate([trigger('4', 'J6AITC-4', 'updated', '2026-11-06T02:40:00Z')], t => ({ id: t.source, title: { zh: 'X', en: 'X' }, digest: twice }))
  expect([many.entities.size, many.events, many.sources.get('jira')!.groups.get('')!.buckets.get('a')!.entities.size]).toEqual([1, 1, 1])
  // A Source without a descriptor still counts each Thread.
  expect(aggregate([trigger('5', 'J6AITC-5', 'updated', '2026-11-06T02:50:00Z')], t => ({ id: t.source, title: { zh: 'X', en: 'X' },
    digest: FALLBACK_DIGEST })).entities.size).toBe(1)
})

it('formats a deterministic, localizable report that fits an IM message', () => {
  const triggers = [trigger('1', 'J6AITC-1', 'created', '2026-11-06T02:10:00Z'), trigger('2', 'J6AITC-2', 'commented', '2026-11-06T02:20:00Z')]
  const report = formatReport({ task: task(), start: Date.parse('2026-11-06T02:00:00Z'), end: Date.parse('2026-11-06T03:00:00Z'),
    triggers, truncated: false, title: 'J6AITC', info })
  expect(report).toMatchObject({ entities: 2, events: 2 })
  expect(report.text).toContain('J6AITC')
  expect(report.text).toContain('2026-11-06 10:00–2026-11-06 11:00')
  expect(report.text).toContain('新建 Issue')
  expect(report.text).toContain('评论')
  expect(wordCount(report.text)).toBeLessThanOrEqual(IM_WORDS)
  // A very long task title is shortened so the header and totals still fit an IM message.
  const long = formatReport({ task: task({ title: 'x'.repeat(300) }), start: Date.parse('2026-11-06T02:00:00Z'),
    end: Date.parse('2026-11-06T03:00:00Z'), triggers, truncated: false, title: 'x'.repeat(300), info })
  expect(wordCount(long.text)).toBeLessThanOrEqual(IM_WORDS)
  const empty = formatReport({ task: task(), start: Date.parse('2026-11-06T02:00:00Z'), end: Date.parse('2026-11-06T03:00:00Z'),
    triggers: [], truncated: false, title: 'J6AITC', info })
  expect(empty.text).toContain('没有变更')
  const english = formatReport({ task: task({ language: 'en', title: 'Widgets' }), start: Date.parse('2026-11-06T02:00:00Z'),
    end: Date.parse('2026-11-06T03:00:00Z'), triggers, truncated: true, title: 'Widgets', info })
  expect(english.text).toContain('Widgets digest')
  expect(english.text).toContain('too many changes')
  expect(titleOf(task(), [])).toBe('变更')
  expect(titleOf(task(), [], 'J6AITC')).toBe('J6AITC')
  expect(titleOf(task({ title: 'J6AITC' }), [])).toBe('J6AITC')
})

it('validates digest settings, including unknown zones and malformed times', () => {
  const settings = SettingsSchema.parse({ digest: { tasks: [task()] } })
  expect(settings.digest.tasks[0]!.id).toBe('j6aitc-hourly')
  expect(SettingsSchema.parse({}).digest.tasks).toEqual([])
  expect(() => DigestConfigSchema.parse({ tasks: [task({ timeZone: 'Mars/Olympus' })] })).toThrow()
  expect(() => DigestConfigSchema.parse({ tasks: [task({ at: '9:30' })] })).toThrow()
  expect(() => DigestConfigSchema.parse({ tasks: [task({ period: 'monthly' as never })] })).toThrow()
})

interface Fake { sent: OutboundMessage[]; health: { state: string; detail: string }; kv: Map<string, unknown>; allowed: boolean }
function host(triggers: Trigger[], options: { allowed?: boolean; paused?: boolean; configured?: boolean; task?: DigestTask } = {}): { host: DigestHost; fake: Fake } {
  const fake: Fake = { sent: [], health: { state: '', detail: '' }, kv: new Map(), allowed: options.allowed ?? true }
  const settings = { digest: { tasks: options.task ? [options.task] : [task()] } }
  const entry = { get: () => undefined, set: (health: Health) => { fake.health = health }, release: () => {} }
  const request = { ...trigger('request', 'J6AITC-0', 'commented', '2026-11-06T02:00:00Z'),
    channel: { source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_request' } } }
  const host: DigestHost = {
    store: { settings: () => settings as never, get: (key: string) => fake.kv.get(key) as never,
      set: (key: string, value: unknown) => { fake.kv.set(key, value) }, triggers: { get: (id: string) => id === 'om_request' ? request as never : undefined },
      read: { triggerWindow: (window: { since: string; until: string; limit: number }) =>
        triggers.filter(item => item.at >= window.since && item.at < window.until).slice(0, window.limit) } as never },
    sources: { kindOf: () => ({ title: { zh: 'JIRA', en: 'Jira' }, digest: jiraKind.digest }) as never,
      instance: () => ({ id: 'jira', kind: 'jira', enabled: true, config: {} }) as never,
      instances: () => [{ id: 'jira', kind: 'jira', enabled: true, installed: true, config: {} }] as never,
      channelAllowed: () => fake.allowed },
    outbox: { send: message => { fake.sent.push(message) } },
    health: { claim: () => entry },
    lifetime: new AbortController().signal,
    configured: () => options.configured ?? true,
    paused: () => options.paused ?? false,
  }
  return { host, fake }
}
const clock = Date.parse('2026-11-06T03:20:00Z')
// Keep the KV key used by the service visible to the assertions below.
const lastEnd = KV.digest.lastEnd('j6aitc-hourly')

it('runs a due task once, queues its report, and advances the recorded boundary', async () => {
  const digest = host([trigger('1', 'J6AITC-1', 'created', '2026-11-06T02:10:00Z')])
  const service = new Digest(digest.host, () => clock)
  await service.run()
  expect(digest.fake.sent).toHaveLength(1)
  expect(digest.fake.sent[0]!.channel).toEqual({ source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_request' } })
  expect(digest.fake.sent[0]!.text).toContain('J6AITC')
  expect(digest.fake.kv.get(lastEnd)).toBe(Date.parse('2026-11-06T03:00:00Z'))
  expect(digest.fake.health).toMatchObject({ state: 'ready' })
  await service.run()
  expect(digest.fake.sent).toHaveLength(1)
})

it('reports an unavailable channel without advancing the boundary, and retries the period later', async () => {
  const digest = host([trigger('1', 'J6AITC-1', 'created', '2026-11-06T02:10:00Z')], { allowed: false })
  const service = new Digest(digest.host, () => clock)
  await service.run()
  expect(digest.fake.sent).toHaveLength(0)
  expect(digest.fake.kv.has(lastEnd)).toBe(false)
  expect(digest.fake.health).toMatchObject({ state: 'error' })
  digest.fake.allowed = true
  await service.run()
  expect(digest.fake.sent).toHaveLength(1)
  expect(digest.fake.kv.get(lastEnd)).toBe(Date.parse('2026-11-06T03:00:00Z'))
})

it('can skip an empty window, pauses without due work, and stalls while processing is paused', async () => {
  const silent = host([], { task: task({ includeEmpty: false }) })
  await new Digest(silent.host, () => clock).run()
  expect(silent.fake.sent).toHaveLength(0)
  expect(silent.fake.kv.get(lastEnd)).toBe(Date.parse('2026-11-06T03:00:00Z'))
  const empty = host([])
  await new Digest(empty.host, () => clock).run()
  expect(empty.fake.sent).toHaveLength(1)
  expect(empty.fake.sent[0]!.text).toContain('没有变更')
  const paused = host([], { paused: true })
  await new Digest(paused.host, () => clock).run()
  expect(paused.fake.health).toMatchObject({ state: 'paused' })
  const unconfigured = host([], { configured: false })
  await new Digest(unconfigured.host, () => clock).run()
  expect(unconfigured.fake.health).toMatchObject({ state: 'paused' })
})

// A malformed task never reaches the service because settings validation rejects it, so no boundary is ever half-written.
it('keeps the boundary numeric and monotonic across runs', async () => {
  const digest = host([trigger('1', 'J6AITC-1', 'created', '2026-11-06T02:10:00Z')])
  let now = Date.parse('2026-11-06T03:20:00Z')
  const service = new Digest(digest.host, () => now)
  await service.run()
  now = Date.parse('2026-11-06T04:05:00Z')
  await service.run()
  expect(digest.fake.sent).toHaveLength(2)
  expect(digest.fake.kv.get(lastEnd)).toBe(Date.parse('2026-11-06T04:00:00Z'))
})
