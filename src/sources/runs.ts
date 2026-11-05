/** Starts and reconciles one Source watch run per enabled instance. */
import { setTimeout as delay } from 'node:timers/promises'
import { health, type SourceContext, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'

const SYNC_MS = 5000

/**
 * Runs `watch` once for every enabled instance of `kind`, starting and stopping runs as instances are added,
 * enabled or disabled. The instance's watch owns its polling loop; a failure that escapes it is reported on the
 * kind's first health entry, as the plugins did themselves before this helper.
 */
export async function runInstances(host: SourceHost, kind: SourceKind, watch: (ctx: SourceContext, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal): Promise<void> {
  const runs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  const stop = (id: string): void => {
    const run = runs.get(id)
    if (!run) return
    run.controller.abort()
    runs.delete(id)
  }
  const sync = (): void => {
    const active = new Map<string, { id: string }>()
    for (const instance of host.sources.instances()) {
      if (!instance.installed || instance.kind !== kind.kind) continue
      if (instance.enabled) { active.set(instance.id, instance); continue }
      // Keep the existing “off” health status even though a disabled instance has no run.
      const entry = kind.health[0]
      if (entry) host.context(instance.id).report(entry, health('paused', 'sourceOff'))
    }
    for (const id of runs.keys()) if (!active.has(id)) stop(id)
    for (const id of active.keys()) {
      if (runs.has(id)) continue
      const controller = new AbortController()
      const ctx = host.context(id)
      const promise = watch(ctx, controller.signal)
        .catch((error: unknown) => {
          const entry = kind.health[0]
          if (entry) ctx.report(entry, { state: 'error', detail: String(error) })
        })
        .finally(() => { runs.delete(id) })
      runs.set(id, { controller, promise })
    }
  }
  sync()
  try {
    while (!signal.aborted) {
      await delay(SYNC_MS, undefined, { signal }).catch(() => {})
      if (signal.aborted) break
      sync()
    }
  } finally {
    const pending = [...runs.values()].map(run => run.promise)
    for (const id of [...runs.keys()]) stop(id)
    await Promise.allSettled(pending)
  }
}
