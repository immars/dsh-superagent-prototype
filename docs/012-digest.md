# 012 Periodic Digest

This document records the periodic Digest: how a report task is configured, how a window of Triggers becomes a message, and what it deliberately leaves out. It uses the terms of [001 Domain model](001-domain.md), the Source contract of [007 Architecture](007-architecture.md), and the counting input recorded in [009 JIRA Source](009-jira-source.md).

## What it is

A Digest is a background report, not a Source and not a Ticket. It reads the Triggers the Store already holds for one time window, counts them through a small optional Source descriptor, and queues one deterministic message through the Outbox. It never runs an Eval, creates a Ticket or asks the model anything.

The module is `src/app/digest.ts`; `Runtime` starts and stops it beside `Passes` and `Effects`.

## Configuration

The `digest` settings block holds independent tasks:

```json
{
  "tasks": [{
    "id": "j6aitc-hourly",
    "enabled": true,
    "period": "hourly",
    "at": "00:00",
    "timeZone": "Asia/Shanghai",
    "sources": ["jira"],
    "channel": { "source": "feishu", "triggerId": "om_request" },
    "language": "zh",
    "maxTriggers": 5000,
    "includeEmpty": true,
    "title": "J6AITC"
  }]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable task id; it names the `KV.digest.lastEnd` record and the Outbox message id |
| `period` | `hourly`, `daily` or `weekly`; weeks start on Monday |
| `at` | The send time (`HH:mm`) for `daily`, the anchor for `weekly`; `hourly` uses the top of the hour |
| `timeZone` | An IANA zone; the window boundaries are wall-clock times in it |
| `sources` | Source instance ids to read; empty means every installed, enabled instance |
| `channel` | The Source and a stored Trigger id whose own Channel receives the report |
| `language` | `zh` or `en`, choosing the labels and the summary sentence |
| `maxTriggers` | The most Triggers one window reads; more are reported as truncated |
| `includeEmpty` | Whether a window with no change still sends a "no changes" report |
| `title` | The report label; without it the project the Triggers name is used |

`channel.triggerId` is what makes delivery safe: the report replies in the Trigger's thread, so the person who asked receives it where they asked. The id is visible on the Ticket card and in the `trigger/<id>` resource. No chat id is guessed and no new recipient is introduced.

The block is saved like any other settings block, from the main Session with `orchestrator_settings_save` (block `digest`) or from the management API's `PUT settings/digest` with the block's revision. The panel has no dedicated Digest page in this change; a task is created or cancelled by saving the block.

## Schedule and window

A tick every 30 seconds reads the settings. For each enabled task it computes the most recent period boundary at or before now:

- `hourly`: the top of the local hour;
- `daily`: today's `at` if it has passed, else yesterday's;
- `weekly`: the most recent Monday's `at`.

The report covers `[boundary − period, boundary)`. If `KV.digest.lastEnd` already reaches the boundary, the task is skipped, so a restart never repeats a period. When the service starts after a long pause it reports only the latest completed period, not every missed one. Before writing `lastEnd` the message id is queued; the Outbox keys it by task, boundary and Channel, so a crash between queueing and recording the boundary replays the same id harmlessly.

A report therefore goes out shortly after the boundary: an hourly task reports the hour that just ended, a daily task at its `at`, and a weekly task on Monday at its `at`.

## Counting

Each Trigger contributes an entity, a group and one or more buckets, from `SourceKind.digest`:

| Source | Entity | Group | Buckets |
| --- | --- | --- | --- |
| JIRA | issue key | issue type (`Bug`) | change kind: created, updated, transitioned, commented |
| GitHub | Issue/PR number | Issue or pull request | kind: issue, pull, comment, review comment, review, CI |
| Any kind without a descriptor | `threads[0]` | none | one `Change` bucket |

A bucket counts distinct entities and all events. One issue commented three times is `1` entity and `3` events; two issues with one comment each is `2` entities and `2` events. The Source and overall totals count a Trigger once even if its descriptor names several buckets.

The message states the totals and one line per Source/group/bucket, and stays within the IM word limit: detail groups are added only while they fit, and a note names any that were left out. A truncated window is stated too.

## Reading and privacy

`store.read.triggerWindow` reads every stored Trigger in `[since, until)`, including Triggers that Source scope or admission filtered: a Digest reports what the Source observed, which is the point of a project-level report when the allowed list is empty. It reads no Trigger text into the message, only counts, group names and labels.

## Health

The `digest` health entry is:

- `ready` with the counts of the periods reported by the last tick, or that no period is due;
- `paused` while setup is pending, processing is paused, or no task is configured;
- `error` with the task id and reason when a window read, a missing Channel or a channel check fails. The boundary is not advanced, so the next tick retries the same period.

The Outbox keeps the delivery retry, ordering and drop rules of every other message.

## Limits

- One runtime schedules the tasks; there is no distributed lock beyond the state directory lock.
- A period boundary is computed in the configured zone with `Intl`; the wall-clock resolution handles DST and non-whole-hour offsets, but a zone database change can move a boundary.
- The report is deterministic counts, not a narrative written by the model. Free-form narration would need a scheduled Session and is a separate change.
- The panel has no Digest page; configuration is through the main Session's settings save or the management API.
- `sources` names instance ids, not kinds: an additional instance such as `jira-ops` must be named explicitly.
- The window is capped by `maxTriggers`; a busy project can therefore see a truncated report, which the message states.
- A Digest does not deduplicate entities across Source kinds: the same work item reached through two Sources counts under each.
