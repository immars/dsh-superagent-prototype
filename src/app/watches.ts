/** The clock of completion watches: turns a finished detached process or an appeared marker into a wake-up Input. */
import { existsSync } from 'node:fs'
import type { CompletionWatch, Ticket } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

/** Host dependencies of the completion-watch clock. */
export interface WatchesHost {
  readonly store: Pick<Store, 'tickets'>
  /** Records a fired or expired watch on the Engine, which removes it and adds the Input in one transaction. */
  readonly engine: { fireWatch(ticketId: string, watchId: string, status: 'ended' | 'expired'): boolean }
  /** The `watch` health entry, which this service alone writes. */
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  /** Whether setup resolved the deployment; the clock waits while it has not. */
  configured(): boolean
  /** Whether processing is paused; the clock records nothing while it is. */
  paused(): boolean
  closing(): boolean
  /** The clock reading in milliseconds; the tests set it. */
  now?(): number
}
/** How often the clock looks for a finished process or an appeared marker. */
export const WATCH_TICK_MS = 30_000
const iso = (at: number): string => new Date(at).toISOString()

/** Whether a process still exists: a permission error means it does, and only ESRCH means it ended. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether one watch's condition holds now. A file watch is true once the path exists; a process watch once the PID is gone. */
function conditionMet(watch: CompletionWatch): boolean {
  return watch.condition.kind === 'file' ? existsSync(watch.condition.path) : !alive(watch.condition.pid)
}

/**
 * The only clock of completion watches. It is not a Source: it has no configuration, credentials or Policy part, and it
 * creates no Trigger, Eval, Decision or Mandate. Each tick fires every due or expired watch of every open Ticket in creation
 * order; `Engine.fireWatch` removes it and records the `watch-ended` Input atomically. The Runtime starts it after setup and
 * the passes start, and stops it with the runtime. Its failures show in the `watch` health entry with the Ticket and reason.
 */
export class Watches {
  private timer?: ReturnType<typeof setInterval>
  private started = false
  constructor(private readonly host: WatchesHost) {}
  /** Start the clock: look once at once, then about every 30 seconds. */
  start(): void {
    if (this.started) return
    this.started = true
    this.tick()
    this.timer = setInterval(() => { this.tick() }, WATCH_TICK_MS)
    this.timer.unref?.()
  }
  /** Stop the clock; a watch it already fired stays recorded. */
  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  /** Look at every open Ticket's watches and fire the ended or expired ones. */
  tick(): void {
    if (!this.host.configured()) { this.report('paused', 'Waiting for setup'); return }
    if (this.host.closing() || this.host.lifetime.aborted) return
    if (this.host.paused()) { this.report('paused', 'Processing is paused'); return }
    const at = this.host.now?.() ?? Date.now()
    const tickets = this.host.store.tickets.open()
      .filter((ticket): ticket is Ticket & Required<Pick<Ticket, 'watches'>> => !!ticket.watches?.length)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let failure: string | undefined
    for (const ticket of tickets) {
      for (const watch of [...ticket.watches]) {
        const expired = Date.parse(watch.expiresAt) <= at
        let status: 'ended' | 'expired' | undefined = expired ? 'expired' : undefined
        try {
          if (!status && conditionMet(watch)) status = 'ended'
        } catch (error) {
          failure ??= `Could not check watch ${watch.id} of ticket ${ticket.id}: ${error instanceof Error ? error.message : String(error)}`
          continue
        }
        if (!status) continue
        try { this.host.engine.fireWatch(ticket.id, watch.id, status) }
        catch (error) {
          // One bad watch must not stop the others; the health entry names the Ticket whose watch could not be recorded.
          failure ??= `Could not record watch ${watch.id} of ticket ${ticket.id}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    if (failure) { this.report('error', failure); return }
    const watches = this.host.store.tickets.open().flatMap(ticket => ticket.watches ?? [])
    const next = watches.map(watch => watch.expiresAt).sort()[0]
    this.report('ready', watches.length ? `${watches.length} completion watch${watches.length === 1 ? '' : 'es'}; next expiry at ${next}` : 'No completion watch is armed')
  }
  private report(state: 'ready' | 'paused' | 'error', detail: string): void {
    this.host.health.set({ state, detail, at: iso(this.host.now?.() ?? Date.now()) })
  }
}
