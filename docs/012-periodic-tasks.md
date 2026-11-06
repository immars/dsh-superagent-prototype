# 012 Periodic tasks

**Status: proposal for review. This change contains documentation only. No runtime code changes until the design is accepted and implementation is scheduled.**

This document proposes native periodic tasks: a person asks for recurring work in an ordinary conversation, the main Session creates the task, and the agent performs it again on the requested schedule, delivering each result to the conversation that asked. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [003 Execution](003-execution.md), [004 Prompts](004-prompts.md) and [005 Panel](005-panel.md).

The work of a periodic task is ordinary agent work, and a run may use every tool its Ticket is allowed to use.

## What a periodic task is

A **periodic task** is a Ticket with a schedule.

- The person's explicit request creates the Ticket through the normal accept path, and that accept grants a Mandate for the recurring work.
- Each scheduled run is a durable Input on that Ticket. The existing Executor delivers it to the same worker Session, which does the work and reports the run's result.
- The Ticket stays open between runs. It ends when a person stops it, or when its worker reports that the task cannot continue.
- The list of periodic tasks is the list of open Tickets that carry a schedule, shown together in the Execution tab and readable by the main Session.

No new Source is introduced. A Source produces Triggers from the outside world and needs a receiving scope and a Policy part; a scheduled run is not a new external event, must not be re-assessed, and grants no new authority. The schedule is an attribute of the Ticket that already holds the authorization.

No new execution path is introduced either. The scheduled run uses the existing Assignment, worker Session, directory, Input delivery, reply, pause, restart and recovery machinery. The only new moving part is a small clock that turns a due time into an Input.

## Requirements

| Requirement | This design |
| --- | --- |
| Create, list and cancel through the main Session | The accept tool takes an optional `schedule`; `orchestrator_read` exposes the task list; a person's stop cancels |
| Several independent tasks | One Ticket each; each has its own schedule, Session, directory and results |
| Real agent work every run | Each run wakes the Ticket's worker, which uses its normal tools and reports a result |
| The requester receives the results | Replies use the original Trigger's Channel; no chat id is guessed |
| Survive restarts and crashes | The schedule and `nextAt` are stored on the Ticket; a run Input has a deterministic id |
| No duplicate runs | `nextAt` advances atomically with the Input; a restart never repeats a delivered run |
| Follow the processing pause | The clock does not fire while processing is paused |
| Stop cleanly | A person's stop ends the Ticket; the clock only considers open Tickets |
| No replay storm after downtime | At most one late run per task, then the next future boundary |
| One scheduler | One runtime, protected by the existing state-directory lock |

## Example

> Every day at 09:00, summarize progress in `acme/web` and Jira project `ABC`, and send it to this chat.

The main Session recognizes an explicit recurring request, accepts it with a daily schedule, and runs it once immediately. Later runs happen daily at 09:00 Asia/Shanghai. Each run's result replies in the same chat. Later the person can say "list my periodic tasks" and "cancel the daily progress task", and the main Session can list and stop the Ticket.

The schedule is created only when the request itself names a recurrence. A one-off request stays an ordinary Ticket, and the main Session never invents a period, a time or a time zone.

## Creation

An allowed person states the recurrence in their message. The message is an explicit candidate, as any other explicit request is. The main Session accepts it with `orchestrator_route` and an optional `schedule`:

```json
{
  "kind": "accept",
  "trigger_id": "…",
  "title": "Daily progress for acme/web and ABC",
  "worktree_name": "daily-progress",
  "acknowledgement": "Started now; then daily at 09:00 Asia/Shanghai.",
  "schedule": { "period": "daily", "at": "09:00", "time_zone": "Asia/Shanghai" }
}
```

Rules:

- Only an explicit accept may carry a schedule. An inferred candidate cannot create one, so the same authorization boundary as every other Ticket applies.
- The schedule is part of the accept outcome and is recorded on the Ticket together with the Mandate. It is not a settings block and not a Source instance.
- `title` and `scope` are the task's name and boundary. The original Trigger text is the standing instruction the worker reads every run.
- The first Assignment starts immediately, so the first run is the person's original request. `nextAt` is the first boundary strictly after the accept. The acknowledgement names both facts.
- If the request names no recurrence, the accept has no schedule. If it names an unsupported recurrence, the main Session does not substitute a supported one; it asks a concrete question, or accepts a one-off only when the message also asks for that one-off work.
- A schedule is validated before the Ticket is created: period, `at`, time zone and the computed first `nextAt`.

### Schedule fields

```ts
interface Schedule {
  period: 'hourly' | 'daily' | 'weekly'
  /** Wall-clock `HH:mm` for daily and weekly; unused for hourly. */
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
```

`Ticket.schedule?: Schedule` is additive. Existing Tickets have none and behave as today.

## Schedule semantics

| Period | Runs |
| --- | --- |
| `hourly` | At the top of each hour in the task's zone; `at` is ignored |
| `daily` | Every day at `at` in the task's zone |
| `weekly` | Every Monday at `at` in the task's zone (a weekday choice is an open question) |

- The time zone is the one the request states. Without a stated zone, the runtime's local zone is recorded, and the acknowledgement says which zone was used.
- `nextAt` is computed from wall-clock boundaries in the zone, not by adding fixed milliseconds, so a daily 09:00 remains 09:00 across a DST change. A nonexistent local time moves to the first valid instant after it; an ambiguous local time uses the earlier offset.
- The first run is immediate and `nextAt` is the next boundary. A task created at 09:30 daily 09:00 first runs at 09:30 and then at 09:00 the next day.
- A run that is due while the previous run is still working does not queue a second one. The clock waits and fires the pending run when the Ticket is idle again; there is never more than one due run waiting.
- After downtime, a due `nextAt` is late, not lost: the first pass fires one late run and then sets `nextAt` to the next future boundary. Earlier missed boundaries are not replayed.
- A run is not fired while the Ticket waits for a person after a `blocked` or `failed` report. The schedule shows its blocked state; the next run waits for the person's answer or retry.
- A run is not fired while processing is paused or setup is not configured. After a pause, the same single-late-run rule applies.

## Firing a run

A new `Schedules` application service owns the clock. It is not a Source: it has no configuration, credentials or Policy part, and it reports one health entry.

- It starts after setup succeeds and the passes start, and stops with the runtime.
- It ticks about every 30 seconds.
- For each open Ticket with a schedule whose `nextAt` is not after now, in creation order:
  1. Skip while processing is paused, the runtime is closing, or setup is incomplete.
  2. Skip while the Ticket waits for a person after a `blocked` or `failed` report.
  3. Skip while a previous run is still working: an Input delivered after the latest report, a turn still running, or a pending run Input.
  4. Revalidate the Ticket's Mandate against the current Policy. If it no longer holds, mark the schedule paused with `policy` and fire nothing; a later pass that revalidates again clears the pause and may fire.
  5. Add one `scheduled-run` Input, set `lastRunAt`, and move `nextAt` to the next future boundary, in one transaction.
- The normal delivery effect hands the Input to the running Assignment or wakes the idle worker. A busy worker slot delays the run; it does not duplicate it.
- The deterministic Input id is built from the Ticket and the scheduled instant, so a crash between delivery attempts cannot double-run a period.

The clock does not create a Trigger, an Eval, a Decision or a Mandate. It cannot widen the Ticket's scope and does not use the Policy gate beyond the revalidation above.

The health entry `schedule` reports:

- `ready` with the earliest next due time, or that no task is due;
- `paused` while processing or setup is paused, or while no task has a schedule;
- `error` when a due run cannot be recorded, with the Ticket id and reason.

## A run

The Input the worker receives reads like this:

```text
Scheduled run for this task (daily at 09:00, Asia/Shanghai).
Scheduled for 2026-11-06T01:00:00.000Z; fired at 2026-11-06T01:00:03.000Z.
The task: Daily progress for acme/web and ABC. <the original instruction or scope>
Do this run's work and report ready with its result. This Ticket stays open for the next run.
```

- A run is an automatic Input, not a person's message. It neither resumes an ended Ticket nor grants new authority.
- The Ticket's schedule is part of the worker's context on the first Assignment too, so the first run also knows that the Ticket is a standing task and what follows it.
- The worker performs the task within the Ticket's existing Mandate and tools, then reports `ready` with a concise result for this run.
- The worker must not report `dropped` merely because a run found nothing new, and must not report `ready` when the task could not be done because of a missing access or a broken prerequisite; that is `blocked` or `failed`.
- The Task is a standing task. The worker's system prompt and the run Input tell it to expect the next run, not to treat this run's `ready` as the end of the Ticket.

### The result of a run

- A `ready` report on a scheduled Ticket does not end the Ticket. It records the run's report, clears attention and hands off the worker slot; the Ticket remains open and shows its next run.
- The main Session receives the report as usual and sends it to the conversation with `orchestrator_reply` purpose `result`. The existing rule permits a result for a live Ticket whose latest report is `ready`. The prompt tells the main Session that this is one run's result, not the task's completion.
- The reply id includes the run's report instant, so two runs that produce identical text are both sent. Without this, the Outbox would treat the second run as a duplicate.
- `progress` reports stay internal. `blocked` and `failed` hold the schedule until a person answers or retries. `dropped` ends the Ticket and the schedule, because the task itself cannot continue.
- The worker Session, directory and context persist across runs. Later runs can read what earlier runs did, and normal compaction applies. A fresh Session per run is not part of this design; it would lose that continuity and cost a new prepare step each time.

### No changes

A run with nothing new reports `ready` with a short "no changes" result, as the task's instruction asks. It does not report `dropped`, which would cancel the task. Whether a task may stay silent on an empty run is an open question; v1 always reports, so a person can tell that the schedule is alive.

## Ticket state and panel

A scheduled Ticket is an ordinary open Ticket with one extra scheduling state.

| Stage | Condition | Panel label |
| --- | --- | --- |
| `scheduled` | Open, has a schedule, no run in progress, latest report `ready` or `waiting`, Mandate holds | Scheduled · next run `<time>` |
| `scheduled`, paused | As above but the Mandate no longer holds, so the clock fires nothing | Scheduled · paused |

The existing stages keep their meaning: `working` while a run executes, `person/answer` for an open question, `person/blocked` and `person/failed` for a run that needs a person, and `ended` after a stop. A run that is blocked or failed therefore shows `person/blocked` or `person/failed`, not `scheduled`; the clock holds its next run until the person acts.

- The Ticket card and details include `schedule: { period, at, time_zone, next_at, last_run_at, paused }`.
- The Execution tab gains a **Scheduled** filter next to Open, Working and Waiting. It lists open scheduled Tickets with title, period and next run, requester, last run's result preview, and a stop action.
- There is no new top-level panel page. A periodic task is a Ticket, so it belongs where the other Tickets are; the filter is its list.
- The ticket detail shows the schedule and next run beside the existing authorization. A person can stop the task there, which cancels it.
- Locale strings (English and Chinese) are added with the UI.

## Cancelling, stopping and changing

- **Cancel by message.** A person says "cancel the daily progress task". If the message is an explicit request, the main Session routes `stop` to the Ticket; if it is a follow-up on the task's own Thread, the main Session may stop on it as it may for any Ticket. The Ticket ends `stopped`, a running turn is cancelled, and the clock ignores the Ticket afterwards.
- **Cancel in the panel.** The Scheduled list and the Ticket detail offer the existing stop action.
- **A worker that cannot continue.** A `dropped` report ends the Ticket and the schedule. The main Session tells the person why.
- **Change the schedule or the instruction.** In v1, a change is a cancellation followed by a new accept; the new Ticket gets a new worker Session, and its routing note can name the task it replaces. In-place editing of a schedule is an open question: it would either create a new Mandate or loosen the rule that a Mandate is immutable.
- A stopped Ticket receives no further runs. A reply already queued may still go out or be dropped by the Outbox as usual. Its schedule remains on the stored Ticket for history.

## Authorization and Policy

- The original accept is the only authorization event. It must be explicit, and the resulting Mandate covers the recurring work. Each run is within that Mandate, not a new request.
- Before every run, the clock revalidates the Mandate. A Mandate that no longer holds gets no run. The schedule is marked paused with `policy` and appears to a person; it resumes on a later pass if the Mandate holds again, without a new accept.
- A Policy change is delivered to the live scheduled Ticket as it is to any open Ticket. It does not stop the task by itself, but a run that would fall outside the current Policy does not fire.
- No cross-Source identity mapping is introduced. The result goes to the original Channel of the Trigger that created the task.
- The clock is subject to the processing pause and to setup readiness. It never bypasses the pause by firing Inputs that would wake a worker.

## Delivery

- A result goes to the conversation where the person asked for the task: the origin Trigger's Channel, through the existing Outbox. No recipient, chat id or repository is guessed.
- Replies wait while their Source is off and drop when the conversation is gone, exactly as other replies do. A dropped result does not silently retarget the task to another conversation; the Scheduled list shows the last delivery problem and the person can cancel or re-create the task.
- A task with no deliverable Channel cannot be created, because the accept needs a Channel for the acknowledgement and results. The main Session must refuse such an accept.

## Prompts

Three built-in prompt parts change in the implementation:

- `prompts/dispatch.md` (main Session): recognize an explicit recurrence in the original message; add `schedule` only then; never invent a period or time zone; name the first run and the next run in the acknowledgement; leave a request without a recurrence as an ordinary accept.
- `prompts/orchestrator.md` (main Session): a `ready` report from a scheduled Ticket is **this run's** result, not the task's completion. Send it as a result and keep tracking the Ticket. A stop cancels the task. List scheduled tasks from the Scheduled resource when a person asks. A blocked run's question is asked as usual.
- `prompts/work.md` (worker): a `scheduled-run` Input is one run of a standing task. Do the run's work, report `ready` with its result, and expect the next run. Do not report `dropped` because nothing changed; do report `dropped` if the task itself cannot continue. Stay within the original Mandate.

The prompt must not make the worker responsible for the schedule itself. The host fires runs; the worker never sleeps, polls a clock or creates a task.

## Tools and resources

| Entry point | Change |
| --- | --- |
| `orchestrator_route` accept | Optional `schedule` object; validated; refused for an inferred candidate and when no Channel can receive results |
| `orchestrator_read ticket/<id>` | Ticket card and details include `schedule` |
| `orchestrator_read scheduled` | New list resource: open scheduled Tickets with title, period, next run, last run and requester |
| `orchestrator_reply` | No new purpose; a scheduled run's result uses `result` as an ordinary ready report does, with a per-run reply id |
| Panel HTTP | Scheduled filter reads the existing execution data plus the schedule; no new management endpoint is required |
| Settings | No new block; a task is not deployment configuration |

`orchestrator_read scheduled` is what makes "list my periodic tasks" and "cancel the daily one" reliable without the main Session inventing an identifier. It is a projection over open Tickets, not a second store.

## Limits

- One runtime schedules; the state-directory lock is the only mutual exclusion. There is no distributed scheduler.
- v1 supports hourly, daily and weekly periods. Sub-hour intervals and arbitrary cron expressions are out of scope.
- Worker concurrency still bounds execution. A run waits for a free worker slot; a long run delays later runs, and missed boundaries are not backfilled beyond the one late run.
- A task holds a worker Session and a directory for its life. The operator should expect each open scheduled Ticket to consume the same resources as any open Ticket between runs.
- The task list has no fixed count limit beyond worker concurrency and the operator's attention; the Scheduled filter shows every open scheduled Ticket.
- A time-zone database change can move a boundary. The stored `nextAt` is authoritative until the next computation.
- The schedule belongs to one Ticket. Deleting the Ticket is not supported; a person stops it, and history stays.

## Failure and recovery

| Situation | Behavior |
| --- | --- |
| Host restarts with runs due | Stored `nextAt` fires at most one late run after startup; then the next future boundary |
| Crash between adding the run Input and advancing `nextAt` | They are one transaction: either both happen or neither does |
| Crash after the run Input is stored, before delivery | The Input remains undelivered; the existing delivery retry delivers it once |
| Worker slot full | The run Input waits; the clock does not queue another |
| Run reports `blocked` or `failed` | The schedule holds; a person's answer or retry resumes it |
| Mandate no longer revalidates | No run; the schedule pauses with `policy`; it may resume if the Mandate holds again |
| Processing paused | No runs; after resume, at most one late run |
| Setup incomplete or Source off | No runs; the clock reports paused |
| Original conversation gone | Results drop as usual; the Scheduled list shows the delivery problem; no new recipient is invented |
| Clock fails to record a run | The `schedule` health entry reports the error; the run is not marked as fired |

## Migration

`Ticket.schedule` and the `scheduled-run` Input are additive optional records. Existing Tickets and Inputs are unchanged; there is no ticket mutation and no user-visible migration. The schedule and its `nextAt` live in the existing Ticket record, so the existing backup and restore procedure covers them.

## Tests

| Area | Cases |
| --- | --- |
| Boundary math | Hourly, daily and weekly boundaries in `Asia/Shanghai`, `UTC`, `Asia/Kolkata` and `America/New_York`; DST spring-forward and fall-back; month and year boundaries; invalid `at`, zone and period refused |
| Accept | A schedule on an explicit accept creates one scheduled Ticket; no schedule on an ordinary accept; an inferred candidate cannot create one; the first `nextAt` is after the accept; an accept without a Channel is refused |
| Clock | Due run adds exactly one Input, advances `nextAt` and is idempotent on replay; not due does nothing; paused processing and setup do nothing; a busy Ticket waits; a blocked Ticket waits; revalidation failure pauses; a restart fires at most one late run |
| Ticket lifecycle | A `ready` report keeps a scheduled Ticket open; the same report ends an ordinary Ticket; `dropped` ends and stops the schedule; `blocked` holds; a person's stop ends the Ticket; the stored schedule remains for history |
| Delivery | A scheduled run's result is sent through the origin Channel; identical text in two runs is sent twice; a dropped Channel does not retarget |
| Resources and prompts | The Scheduled list shows open scheduled Tickets only; the card includes the next run; the main Session and worker prompts contain the behavior above |
| Panel | The Scheduled filter, next-run label, last result, stop action, English and Chinese strings; no before/after is required for this proposal, the implementation PR provides it |

## Implementation plan

This is a cross-cutting feature and should not be one unreviewed edit. After this proposal is accepted:

1. **Domain and Engine:** `Schedule` on `Ticket`, the accept outcome and validation, the `scheduled-run` Input and its rendering, the ready/`dropped` lifecycle for scheduled Tickets, the per-run result reply id, the `scheduled` stage and card fields.
2. **Clock:** the `Schedules` service, next-boundary computation, pause and revalidation, the `schedule` health entry, runtime start/stop.
3. **Main Session:** the accept `schedule`, the `scheduled` resource, prompt changes, and refusal rules for inferred or Channel-less tasks.
4. **Panel:** the Scheduled filter, next-run display, stop action and locales; before/after screenshots in the implementation PR.
5. **Tests and documentation:** the table above, `pnpm check`, the architecture module and test tables, and this document kept current.

Phases 1 and 2 are the generic capability. Phases 3 and 4 can follow in the same implementation PR or as two reviewable PRs.

## Alternatives considered

| Alternative | Why it is not the proposal |
| --- | --- |
| A new Source kind that emits a Trigger at each boundary | Every run would enter Eval and need an assessment and a new Decision, although the recurring work was already authorized. It would also add a Source, a Policy part and a receiving scope for a clock |
| The clock creates a new Ticket for each run, outside Eval | There would be two ticket-creation paths and a second Mandate basis, and the recurring task would lose its continuous worker Session and history |
| An external scheduler such as a system cron or `launchd` | Not native: it cannot reuse the Mandate, Input delivery, replies, pause and panel, and it would duplicate credentials and failure handling outside the agent |
| A separate task store or settings block | The Ticket already holds the authorization, worker, directory, replies and history; a second store would duplicate lifecycle and drift from the Ticket it describes |

## Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Does the first run happen immediately, or at the first boundary? | Immediate: the request also asks for the work now, proves the task, and the acknowledgement names the next run. The person can stop a task created by mistake |
| 2 | Which periods in v1? | Hourly, daily and weekly. Add interval and weekday options only when a real request needs them |
| 3 | Which time zone by default? | The runtime's local zone, recorded on the Ticket and stated in the acknowledgement. A stated zone always wins |
| 4 | May an empty run stay silent? | No in v1: every run reports, so the person can tell the schedule is alive. A per-task "silent when empty" option would be a later change |
| 5 | How is a schedule changed? | Cancel and create a new task in v1. In-place editing would need a new Mandate or a mutable schedule; that is a separate design decision |
| 6 | What happens to a missed run after downtime? | One late run, then the next future boundary. Do not replay every missed period |
| 7 | What if the original conversation is gone? | Results drop as usual and the Scheduled list shows it; do not retarget. The person cancels or creates a new task |
| 8 | Should a blocked task pause its schedule automatically? | Yes: no runs while a person is needed; the next run fires after the answer or retry |
| 9 | Should the task be listed in a separate top-level panel tab? | No: scheduled Tickets are Tickets. Use the Execution filter; a separate tab would split one concept across two places |

## Decision requested

The design is ready for review on these points in particular:

1. The task is a Ticket with a schedule, not a new Source, service or settings block.
2. A run is a durable Input to the same worker Session; the Ticket stays open between runs.
3. Creation is an explicit accept with a `schedule`; the main Session never invents one.
4. The first run is immediate; later runs follow the schedule.
5. The panel lists scheduled Tickets in the Execution tab; a person stops a Ticket to cancel the task.

If these hold, the implementation can start with phases 1 and 2.
