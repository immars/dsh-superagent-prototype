# 013 Completion watches for detached work

**Status: proposal. This change contains documentation only. No runtime code changes until the design is accepted and implementation is scheduled.**

## Summary

A worker sometimes starts a process that must outlive its turn: an experiment, a long build, a model evaluation on a compute host. Such a process cannot stay a DSH shell job, so the worker detaches it and hands the Ticket back. When the process finishes, nothing wakes the worker, and the person who asked never hears the result until they ask again.

This proposal adds **completion watches**. A worker registers a watch on its Ticket before it hands back, naming a local process ID or a marker file. A small clock in the runtime checks the condition about every 30 seconds without a model turn. When the condition holds, it records a `watch-ended` Input on the Ticket; the existing delivery path wakes the idle worker, which reads the output and reports the result. The watch is durable across restarts, fires at most once, and does not hold a worker slot while waiting.

This builds on [003 Execution](003-execution.md), which describes background work and worker slots, and on [012 Periodic tasks](012-periodic-tasks.md), whose clock is the precedent for a condition-independent runtime timer.

## Problem

A worker's background work is visible to the runtime only while it is a DSH shell job or subagent:

- A completed job or subagent wakes the worker while the Ticket still holds its slot.
- After a turn ends, background work has at most 30 minutes to finish; then the runtime kills the shell jobs and reports the Ticket waiting.
- At handoff, subagents stop and shell jobs are left to the person but their endings are deliberately collected: they do not wake the worker or reserve a slot.
- A detached process (`nohup`, `setsid`, a process started on another host) is not a Session job at all.

A training run of several hours therefore cannot be a managed job. The worker launches it detached, reports `waiting`, and the Ticket becomes idle. When the process exits, no runtime event exists. The Ticket stays idle; the original conversation receives nothing. The only way to learn the result is for a person to ask, which is the failure this proposal fixes.

The fix cannot be "keep the job", because that would hold a worker slot, a concurrency position and a model context for the whole run, and the 30-minute limit would kill it anyway. It cannot be "wake on a left job's end" alone either: that only covers a job the Session still owns, not a process that was detached or started on another machine, and it does not survive a host restart.

## Requirements

| Requirement | Design |
| --- | --- |
| A worker can register a completion condition before it hands back | An optional `watch` on the waiting `orchestrator_report` call |
| Detect the end without a model turn or a held slot | Runtime clock checks a PID or a marker file about every 30 seconds |
| The person receives the result | The clock records an Input; the worker wakes, reports, and the existing reply path sends the result |
| Survive a restart | Watches are stored on the Ticket; a late result is delivered once after startup |
| No duplicate notification | The watch is removed and the Input recorded in one transaction, with a deterministic Input id |
| A job that outlives its stated duration is not silent | Expiry records a `watch-ended` Input with `expired`, so the worker reports a timeout |
| Respect the pause and a person's hold | The clock waits while processing is paused; a `watch-ended` Input is automatic and waits while the Ticket waits for a person |
| No new authority and no privilege escalation | Only a live Ticket's own worker can add a watch; conditions are existence checks, not commands |
| Bounded | At most eight watches per Ticket, a stated expiry, and watches are dropped when the Ticket ends |
| Observable | A `watch` health entry and the Input line in the Ticket record |

## Design

### A watch on the Ticket

`Ticket.watches?: CompletionWatch[]` is additive; existing Tickets have none.

```ts
interface CompletionWatch {
  id: string
  /** A short human-readable name, such as "training run on gpu-2". */
  label: string
  /** What becomes true when the work finishes. */
  condition:
    | { kind: 'process'; pid: number }
    | { kind: 'file'; path: string }
  /** What the future turn should inspect, such as the log and marker file. */
  note?: string
  createdAt: string
  /** When the clock stops waiting and reports a timeout. */
  expiresAt: string
}
```

- **`process`** is true once `kill(pid, 0)` fails with `ESRCH` (a permission error means the process still exists). It fits a local detached process.
- **`file`** is true once the path exists. It is the reliable form: the worker wraps the process so that it writes a marker when it exits, and can also use it for work on another host by running a local monitor that writes the marker. The `watch` field accepts an absolute path or one relative to the Ticket workspace and stores it absolute.
- A marker file is preferred for long or remote work: it can carry the exit status, and it avoids a reused process ID being read as the same run.
- A watch belongs to the Ticket, not the Assignment, so a restart, retry or new Assignment keeps it. It ends with the Ticket.

### Registering a watch

The waiting report that hands the Ticket back carries the watch. The existing worker-only `orchestrator_report` tool gains one optional `watch` field:

```json
{ "state": "waiting", "summary": "Training started; a completion watch is armed.",
  "watch": { "label": "training run", "file": ".dsh/train.done",
    "note": "Read train.log and .dsh/train.done; the exit status is in the marker.", "expires_in_hours": 168 } }
```

Rules:

- Exactly one of `pid` and `file` is required; a relative `file` resolves against the Ticket workspace and is stored absolute.
- The report state is `waiting` or `progress`: a `ready`, `blocked`, `failed` or `dropped` report cannot arm a watch, because the Ticket may end or wait for a person instead.
- `label` is 1–80 characters and `note` at most 500.
- `expires_in_hours` is 1–720, default 168 (seven days).
- A Ticket has at most eight live watches; the report refuses a ninth with a clear error.
- The same condition registered twice returns the existing watch instead of duplicating it.
- The watch is armed in the same transaction as the report, so a report that is refused registers nothing. The report's response names the `watch_id`.
- The report tool is available only to a worker, only while its Ticket is live. It changes no Mandate and grants no new work.
- There is no separate remove tool in v1: a watch fires once and is then removed, and its expiry bounds a forgotten one.

The `watch` field description tells the worker how to launch a detached job so that the watch is meaningful:

```sh
mkdir -p .dsh
nohup sh -c 'python train.py > train.log 2>&1; echo $? > .dsh/train.done' >/dev/null 2>&1 &
```

then register the `file` condition on `.dsh/train.done` (resolved against the workspace), and report `waiting` with a short summary. Reporting `waiting` is deliberate: an ordinary `ready` report ends the Ticket, and a `blocked` report says a person must act. A worker must not poll the process itself, and must not leave a watch when it has already read the result.

### The clock

A new application service, `Watches`, mirrors `Schedules`:

- It starts after setup and the passes, and stops with the runtime.
- It ticks about every 30 seconds.
- It skips while setup is incomplete, processing is paused, or the runtime is closing.
- For each open Ticket with watches, in creation order, it evaluates each condition:
  - `process`: the PID no longer exists, or the watch is expired;
  - `file`: the path exists, or the watch is expired.
- A due or expired watch is handed to the Engine, which, in one transaction, removes the watch and adds a `watch-ended` Input. The normal `addInput` delivery path wakes the idle worker or steers the running Assignment.
- A failed check (for example, an unreadable path) leaves the watch in place, is reported in the `watch` health entry with the Ticket id, and is retried on the next tick. It does not stop the other watches.
- A watch whose Ticket ended is ignored and dropped when the Ticket ends.

The `watch` health entry reports `ready` with the number of live watches and the earliest expiry, `paused` while setup or processing is paused, and `error` with the Ticket and reason when a check cannot be recorded.

### The Input

```ts
| { id: string; kind: 'watch-ended'; watchId: string; label: string; status: 'ended' | 'expired'
    condition: CompletionWatch['condition']; note?: string; at: string }
```

The id is derived from the Ticket and the watch id, so a replayed check cannot record it twice. `watch-ended` is an **automatic** Input, like a `scheduled-run`: it is held while the Ticket waits for a person after a `blocked` or `failed` report, and it is not a person's message that grants or resumes authority.

The worker reads:

```text
Completion watch "training run" fired at 2026-11-16T18:20:03.000Z: process 48121 is no longer running.
Read the job's output and report the result. The watch is removed.
What to inspect: Read train.log and .dsh/train.done; the exit status is in the marker.
```

An expired watch says so and asks the worker to check whether the process still runs; the worker can register another watch with a later expiry. It must not report an expired watch as a successful result.

### Persistence, restarts and pause

| Situation | Behaviour |
| --- | --- |
| The process ends while the worker is idle | The next tick records the Input; delivery wakes the worker in a normal slot |
| The process ends while a turn runs | The Input is steered to the running Assignment, which reports when it is done |
| The host restarts before the process ends | The watch is stored on the Ticket and is evaluated after startup |
| The process ended during downtime | The first pass after startup records one late Input, then removes the watch |
| Processing is paused | No check records anything; the watch is evaluated after the pause |
| The Ticket waits for a person after `blocked` or `failed` | The Input is held until a person replies, like a scheduled run |
| The Ticket ends | Its watches are dropped and can no longer fire |

### Remote work

The runtime checks conditions on the machine that runs dsh-superagent. When the experiment runs elsewhere, the worker starts a small local monitor that writes a marker when the remote job finishes, and registers a `file` watch on that marker:

```sh
nohup sh -c 'until ssh gpu-2 test -f /runs/42/DONE; do sleep 60; done; echo done > .dsh/remote-42.done' >/dev/null 2>&1 &
```

This keeps arbitrary remote commands in the worker's own shell, where the existing execution permissions already apply. The watch itself only checks that a local file exists.

## Alternatives considered

| Alternative | Why it is not the design |
| --- | --- |
| Keep the process as a managed DSH job and let the job end wake the worker | Holds a worker slot and model context for hours, and the 30-minute limit kills the job after the turn ends. It also cannot represent work on another host. |
| Wake the worker when a job left at handoff ends | Covers only a job the Session still owns; a detached process has no job. It would also wake outside a slot, which the slot accounting deliberately avoids, and it does not survive a host restart. |
| Create a periodic task that checks progress every 15 minutes | Wakes a model and spends a full turn per interval, keeps the Ticket in scheduled runs, and produces either noise or silence; a completion watch costs no model turn until the work is done. Periodic tasks are also created by an accept, not by a worker. |
| Have the process call the bot directly when it finishes | Bypasses the worker's interpretation of logs and results, duplicates Channel authorization and reply bookkeeping, and cannot report a failed or partial run properly. A wrapper could notify a person, but the Ticket would still not report. |
| An inbound completion callback over HTTP | The management server is loopback-only by design; remote compute would need a tunnel and authentication. A marker file plus local polling needs no inbound connectivity. |

## Limits and open questions

- **PID reuse.** A local process check can mistake a reused PID for the original run. The design prefers marker files and documents this limitation. A later version could store the process start time and compare it.
- **File condition only for remote work.** A generic command condition would cover more cases but would execute worker-supplied commands outside the Session. It is deliberately left out of v1; the local monitor pattern covers remote jobs with existing permissions.
- **No per-watch panel list in v1.** The Ticket record, the `watch-ended` Input line and the `watch` health entry are enough to observe it. A Ticket-detail list can be added later without changing the model.
- **A watch outlives a worker's intent.** If a worker registers a watch and later reads the result itself, the watch fires once when the process ends; the worker sees that it is already handled and reports. A forgotten watch is also bounded by its expiry.
- **Ready reports end the Ticket.** The design relies on the worker prompt telling it to report `waiting` after launching detached work. A Ticket that reports `ready` has completed and correctly receives no later watch. This is an instruction, not an enforced state; enforcement would change the meaning of `ready` for every Ticket and is out of scope.

## Implementation plan

1. **Domain and Engine.** Add `CompletionWatch`, `Ticket.watches`, `watch-ended` inputs, and `Tickets.addWatch`, `removeWatch`, `fireWatch`. Extend `automatic`, input rendering, input lines and the Engine's executor/schedule-facing types. Drop watches when a Ticket ends.
2. **Watch clock.** Add `src/app/watches.ts` with the 30-second tick, condition checks, pause and closing handling, health reporting, and runtime start/stop wiring. Register a `watch` health entry.
3. **Worker report.** Extend `orchestrator_report` with the optional `watch` object, validate it before the report transaction, and record the watch in that transaction. Keep the schema compact: `tests/model-surface.spec.ts` holds the worker prompt plus tool schemas to a 40,500-character budget, so trim or measure if the addition exceeds it.
4. **Delivery and prompts.** Render the `watch-ended` Input text and card line, add the locale string, and tell workers in `prompts/work.md` to register a watch and report `waiting` after launching detached work, rather than polling or reporting `ready`.
5. **Tests.** A `tests/watches.spec.ts` with a fake clock for: a file appearing; a process ending; expiry; deduplication; the eight-watch limit; pause; ticket end; restart-late delivery; held automatic Input while waiting for a person; one Input and one wake per watch. Update the module and test tables in [007 Architecture](007-architecture.md), which `tests/docs.spec.ts` checks.
6. **Documentation.** Update 003's background-work paragraph and 007's module and test tables; mark this document accepted when the implementation lands.

## Acceptance checks

| Check | How it is verified |
| --- | --- |
| A detached process' completion wakes an idle Ticket and the person receives a result | End-to-end test: report `waiting`, end the fake process, tick the clock, assert the Input is delivered and the worker's `ready` report is relayed |
| No model turn while waiting | Only a clock tick and an Input exist between launch and completion |
| One notification per watch | Tick repeatedly after firing; assert one `watch-ended` Input and no watch |
| A restart loses no completion | Store a live watch, recreate the runtime, tick; assert one Input |
| A blocked Ticket does not wake on a watch | Report `blocked`, tick, assert the Input is held and no turn starts |
| The Ticket end stops the watch | End the Ticket, tick, assert no Input |
| A failure is visible | Make a condition check fail and assert the `watch` health entry names the Ticket |
