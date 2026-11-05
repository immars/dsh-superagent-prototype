/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** Resolves the kind of an instance; undefined for an orphaned or unknown instance. */
  kindOf(id: string, settings = this.settings()): SourceKind | undefined {
    const stored = settings.sources[id]
    return this.kinds.get(stored?.kind ?? id)
  }
  /** Every active instance: installed defaults, additional stored instances, then stored instances whose kind is not installed. */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const defaults = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind))
      .map(kind => ({ ...this.resolve(kind, settings.sources[kind.kind], kind.kind), installed: true }))
    const extras: (SourceInstance & { installed: boolean })[] = []
    const orphans: (SourceInstance & { installed: boolean })[] = []
    for (const [id, stored] of Object.entries(settings.sources).sort(([a], [b]) => a.localeCompare(b))) {
      if (this.kinds.has(id) || stored.removed) continue
      const kind = stored.kind ? this.kinds.get(stored.kind) : undefined
      if (kind) extras.push({ ...this.resolve(kind, stored, id), installed: true })
      else orphans.push({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config, installed: false })
    }
    return [...defaults, ...extras, ...orphans]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const stored = settings.sources[id]
    const kind = this.kindOf(id, settings)
    if (!stored) return kind ? this.resolve(kind, undefined, id) as SourceInstance<C> : undefined
    if (!kind) return { id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config } as SourceInstance<C>
    return this.resolve(kind, stored, id) as SourceInstance<C>
  }
  validate(id: string, value: { enabled: boolean; config: unknown; kind?: string; label?: string; removed?: boolean }): {
    kind?: string; label?: string; enabled: boolean; config: Record<string, unknown>; removed?: boolean
  } {
    const stored = this.settings().sources[id]
    const kindId = value.kind ?? stored?.kind ?? id
    const kind = this.kinds.get(kindId)
    if (!kind) throw new Error(`Source kind not installed: ${kindId}`)
    return { ...(kindId === id ? {} : { kind: kindId }), ...(value.label ? { label: value.label } : {}), enabled: value.enabled,
      config: kind.schema.parse(value.config), ...(value.removed ? { removed: true } : {}) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindOf(channel.source, settings)
    if (!kind) return false
    const instance = this.instance(channel.source, settings)
    return !!instance?.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kindOf(instance.id, settings)
      return kind?.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config, instance }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindOf(message.channel.source)
    if (!kind) return 'waiting'
    const instance = this.instance(message.channel.source)
    if (!instance) return 'waiting'
    // The Channel sees the same resolved configuration its kind publishes, so a reply uses the current account.
    return kind.channel ? kind.channel.send({ commands }, message, instance.config) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kindOf(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.instances().flatMap(instance => {
      const kind = this.kindOf(instance.id)
      return kind?.find ? [kind.find(query, instance)] : []
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindOf(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindOf(trigger.source, settings)
    const instance = this.instance(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !instance || !context) return undefined
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, instance.config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const instance = this.instance(input.source, settings)
    const kind = this.kindOf(input.source, settings)
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return this.settings().sources[input.source] ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    if (!instance?.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown>; label?: string } | undefined, id: string): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, ...(stored?.label ? { label: stored.label } : {}), enabled: parsed.success && (stored?.enabled ?? true),
      config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
