/** The clock of periodic tasks: turns a due `nextAt` into a scheduled run, one per task per tick. */
import type { EngineForSchedules, Ticket } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

/** Host dependencies of the Schedules clock. */
export interface SchedulesHost {
  readonly store: Pick<Store, 'tickets'>
  /** Records a due run on the Engine, which revalidates the Mandate and advances the schedule in one transaction. */
  readonly engine: EngineForSchedules
  /** The `schedule` health entry, which this service alone writes. */
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  /** Whether setup resolved the deployment; the clock waits while it has not. */
  configured(): boolean
  /** Whether processing is paused; the clock records runs only while it is not. */
  paused(): boolean
  closing(): boolean
}
/** How often the clock looks for a due run. */
export const SCHEDULE_TICK_MS = 30_000
const now = (): string => new Date().toISOString()

/**
 * The only clock of periodic tasks. It is not a Source: it has no configuration, credentials or Policy part, and it creates
 * no Trigger, Eval, Decision or Mandate. Each tick fires at most one late run per open scheduled Ticket, in creation order,
 * and leaves the next boundary on the Ticket; `Engine.fireScheduled` revalidates the Mandate and records the run atomically.
 * The Runtime starts it after setup and the passes start, and stops it with the runtime. Its failures show in the `schedule`
 * health entry with the Ticket and the reason.
 */
export class Schedules {
  private timer?: ReturnType<typeof setInterval>
  private started = false
  constructor(private readonly host: SchedulesHost) {}
  /** Start the clock: look once at once, then about every 30 seconds. */
  start(): void {
    if (this.started) return
    this.started = true
    this.tick()
    this.timer = setInterval(() => { this.tick() }, SCHEDULE_TICK_MS)
    this.timer.unref?.()
  }
  /** Stop the clock; a run it already recorded stays recorded. */
  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  /** Look at every open scheduled Ticket, in creation order, and fire the due ones that are ready. */
  tick(): void {
    if (!this.host.configured()) { this.report('paused', 'Waiting for setup'); return }
    if (this.host.closing() || this.host.lifetime.aborted) return
    if (this.host.paused()) { this.report('paused', 'Processing is paused'); return }
    const at = now()
    const due = this.host.store.tickets.open().filter((ticket): ticket is Ticket & Required<Pick<Ticket, 'schedule'>> =>
      !!ticket.schedule && Date.parse(ticket.schedule.nextAt) <= Date.parse(at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let failure: string | undefined
    for (const ticket of due) {
      try { this.host.engine.fireScheduled(ticket.id) }
      catch (error) {
        // One bad schedule must not stop the others; the health entry names the Ticket whose run could not be recorded.
        failure ??= `Could not record the run of ticket ${ticket.id}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (failure) { this.report('error', failure); return }
    const next = this.host.store.tickets.open().flatMap(ticket => ticket.schedule ? [ticket.schedule.nextAt] : []).sort()[0]
    this.report('ready', next ? `Next scheduled run at ${next}` : 'No task is due')
  }
  private report(state: 'ready' | 'paused' | 'error', detail: string): void {
    this.host.health.set({ state, detail, at: now() })
  }
}
