# 009 JIRA Source

This document records why this repository had no JIRA Source, how JIRA could deliver its changes, and what the JIRA Source added here does. It uses the terms of [001 Domain model](001-domain.md), the rules of [002 Authorization](002-authorization.md), and the Source contract of [007 Architecture](007-architecture.md).

## What already existed

Before this change the bundle shipped two Source kinds, `github` and `feishu` (`src/sources/github.ts`, `src/sources/feishu.ts`), and the extension recipe in [008 Cookbook](008-cookbook.md). No JIRA kind, client, Channel or configuration existed in `src/`, and the installed DeepSeek Harness packages contain no JIRA integration.

## Webhooks or polling

JIRA can notify an integration of changes in two ways:

- **Administrator webhooks.** A JIRA administrator registers a URL under **Settings → System → WebHooks** and chooses events such as `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `comment_created`, `comment_updated` and `comment_deleted`. The payload carries the issue, the changelog entry and the comment.
- **Dynamic webhooks.** JIRA Cloud exposes `/rest/api/3/webhook` for an app to register a webhook filtered by JQL. Atlassian limits this API to Connect and OAuth 2.0 apps, so an email-and-API-token integration cannot register one.

Both forms need a URL JIRA's servers can reach. The dsh-superagent management server is deliberately loopback-only: `registerHttp` in `src/app/http.ts` refuses a Web server whose host is not `127.0.0.1`, and the routes require a same-origin header. Exposing a webhook receiver would therefore require a deployment-specific public tunnel or reverse proxy plus a route outside the management origin, and dynamic registration would still need a Connect/OAuth app. That is not available from this bundle's configuration, so a webhook receiver is not part of this change.

Polling is available to any JIRA account with REST access, works on Cloud and Server/Data Center, and needs no inbound connectivity. The Source therefore polls with JQL. The recipe in [008 Cookbook](008-cookbook.md) describes the same loop: wait for setup, follow the Source switch, move a cursor only after storing every Trigger, and report health.

## The change kinds

Polling cannot observe the administrator's event stream, so the Source derives the change kind from the issue's current state and its changelog:

| Change kind | Read from | Trigger id inputs |
| --- | --- | --- |
| `created` | An issue whose `created` time is at or after the cursor | issue key, `created` |
| `transitioned` | A changelog history since the cursor that changes the `status` field | issue key, history id |
| `updated` | A changelog history since the cursor that changes another field | issue key, history id |
| `commented` | A comment whose `created` or `updated` time is at or after the cursor | issue key, comment id, comment version |

The changelog and comment reads happen only when their change kind is configured, so listening to new issues alone costs one search request per poll. A history that changes both status and another field is reported as a transition; a creation-time history is ignored because `created` already reports it. On Server/DC the changelog is read from the issue's `changelog` expansion, because Jira Server has no `/issue/{key}/changelog` resource; Cloud reads the paged changelog resource instead.

The cursor is an ISO timestamp stored under `KV.jira.cursor`, together with a fingerprint of the site, project, issue-type filter and extra JQL. A changed fingerprint starts a new cursor, so a new query never resumes inside an old one. The JQL literal is formatted in UTC and rounded down a minute with an overlap; a replay produces the same stable Trigger ids and therefore only duplicates.

The actor of a change is the reporter for `created`, the changelog author for `updated` and `transitioned`, and the comment author for `commented`. JIRA's `accountType: "app"` marks an automation account as non-human. The configured agent account is filtered out, so the agent's own comments and transitions never start new work. A text mention of the configured agent display name makes the Trigger addressed; the Policy's `allowed` list still decides whether the sender may originate work.

## Configuration

The Source settings card asks for:

| Setting | Meaning |
| --- | --- |
| Site | `https://<site>.atlassian.net`, or a Server/DC URL, optionally with a path prefix |
| Project | The project key, such as `ABC` |
| Change kinds | Any of `created`, `updated`, `transitioned`, `commented` |
| Issue types | Optional comma-separated names, such as `Bug, Task`; empty receives all |
| User | Email on Cloud for Basic authentication, or a Server/DC username |
| Token | An API token on Cloud, or a personal access token on Server/DC |
| Platform / authentication | Cloud with API v3 and Basic, or Server/DC with API v2; Bearer for a PAT |
| Agent account / display name | The account whose writes are ignored, and the display name that counts as a mention |
| Extra JQL | Optional, for example `labels = agent` |
| Polling interval | 30–3600 seconds, avoiding JIRA's rate limits |
| Failed polls before reporting an error | A single network interruption is retried quietly |

The token stays in this deployment's local settings database and is sent only to the configured site. It is never written to a Trigger, a Ticket, the execution environment or a prompt. A JIRA Cloud API token with a read scope for issues is enough for polling; posting replies needs a scope that may add comments. The panel field is masked while editing, but the settings API still returns the token to the panel, and anyone who can read the deployment's settings database can read it.

## Threads, replies and context

One issue is one Thread: `jira:ABC-123`. Triggers of different change kinds on the same issue therefore share a Thread and an Eval. Assessments read the issue's summary and description followed by its comments through `jiraThreadContext`; `root` and `parent` are the issue itself, because JIRA comments are flat.

The Channel posts a reply as an issue comment. Cloud takes an Atlassian Document Format body built from the reply text; Server/DC takes plain text. Before posting, the Channel checks a hidden Jira issue property keyed by the Outbox message id; after the comment exists it writes that property. A retry therefore recognises the earlier post without adding anything visible to the comment. A deleted issue, or one the account can no longer see, settles the message as gone.

## Enabling it

The bundle inserts the plugin disabled, like Feishu:

```yaml
- id: dsh-superagent-jira
  name: dsh-superagent/jira-watch
  disabled: true
```

Enable it in a profile's `cordis.patch.yml` with `disabled: false`, build, restart dsh-superagent, then fill in the Source settings and switch the Source on. `tests/jira.spec.ts` covers the translation, JQL, polling, cursor, context, Channel and health.

## Limits

- Polling has no `issue_deleted` or `comment_deleted` event, so deletions do not produce Triggers. A deleted issue stops producing changes and its replies settle as gone.
- An edited comment is one Trigger per observed version; several edits between two polls collapse into the latest body.
- The Source observes the whole configured project scope. There is no per-issue subscription; the admission table decides whether an observed change becomes a candidate.
- Polling is subject to JIRA's rate limits. The default interval is 60 seconds, and the loop reports failures after the configured number of consecutive rounds.
- A webhook receiver would need a public endpoint and, for dynamic registration, a Connect/OAuth app. If a deployment adds one, the same trigger translation and Thread mapping can consume the `jira:issue_created`, `jira:issue_updated` and `comment_*` payloads instead of polling.
