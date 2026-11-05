# 011 GitLab Source

This document records what the GitLab Source adds, how it polls one project, and what it deliberately leaves out. It uses the terms of [001 Domain model](001-domain.md), the authorization rules of [002 Authorization](002-authorization.md), the Source contract of [007 Architecture](007-architecture.md), and the polling pattern recorded in [009 JIRA Source](009-jira-source.md).

## What already existed

Before this change the bundle had GitHub, Feishu and JIRA Source kinds (`src/sources/github.ts`, `feishu.ts`, `jira.ts`) and the extension recipe in [008 Cookbook](008-cookbook.md). None of them read GitLab, and the installed DeepSeek Harness packages contain no GitLab integration.

## Polling, not webhooks

GitLab project and group webhooks need a URL GitLab's servers can reach. The dsh-superagent management server is loopback-only: `registerHttp` in `src/app/http.ts` refuses a Web server whose host is not `127.0.0.1`, and its routes require a same-origin header. A webhook receiver would therefore need a deployment-specific tunnel or reverse proxy. The Source instead polls the GitLab REST API v4 with a personal access token.

Polling needs no inbound connectivity and works on gitlab.com and a self-hosted instance. It uses the project endpoints only:

| Read | Endpoint |
| --- | --- |
| Issues changed since the cursor | `GET /projects/:id/issues?updated_after=…&state=all&order_by=updated_at&sort=asc` |
| Merge requests changed since the cursor | `GET /projects/:id/merge_requests?updated_after=…&state=all&order_by=updated_at&sort=asc` |
| The notes of one issue or merge request | `GET /projects/:id/issues/:iid/notes`, `GET /projects/:id/merge_requests/:iid/notes` |
| Posting a reply | `POST /projects/:id/issues/:iid/notes`, `POST /projects/:id/merge_requests/:iid/notes` |

`updated_after` needs GitLab 15.10 or later. The project is written `group/project` or `group/subgroup/project`; the client URL-encodes it once.

## The change kinds

| Change | Read from | Trigger id inputs |
| --- | --- | --- |
| A new Issue | An issue whose `created_at` is at or after the cursor | project, IID |
| A new merge request | A merge request whose `created_at` is at or after the cursor | project, IID |
| A note | A note whose `created_at` or `updated_at` is at or after the cursor | work kind, project, IID, note id, note version |

GitLab numbers issues and merge requests in separate sequences, so their Threads are distinct: issue 12 is `gitlab:issue:12` and merge request 12 is `gitlab:mr:12`. GitHub shares one sequence for both, which is why its Thread keys need no kind prefix. An additional instance, such as `gitlab-ops`, prefixes its Threads with its own id (`gitlab-ops:issue:12`); the default `gitlab` instance keeps the unprefixed keys.

Issues and merge requests are read every round, even when project-wide observation is off, because there is no notification endpoint that would otherwise deliver a mention in a new item or note. The three observe switches only widen what is received: with a switch off, an item without a mention is not received at all; with it on, unaddressed items reach the Policy's admission table.

System notes (`system: true`) and empty notes are dropped. The configured agent account's issues, merge requests and notes are filtered out, so the agent's own writes never start new work. GitLab's `bot` flag and service-account `user_type` mark non-human senders; such a sender's note can at most become an inferred candidate. A mention of the configured agent username makes a Trigger addressed.

## Cursor

`KV.gitlab.cursor(<instance id>)` holds an ISO timestamp and a fingerprint of the site, project and three observe switches, so each configured instance has its own cursor. A changed fingerprint starts a new cursor, so switching observation on begins at that moment rather than replaying old items. The cursor moves only after every Trigger of the round was stored, from five seconds before the round started; a replay produces the same Trigger ids and therefore only duplicates.

Subscribed Threads keep their own note cursor under `KV.gitlab.thread(threadKey)`, where the Thread key already names the instance. That is what makes a mention in a note on an issue or merge request the agent already follows arrive even when project-wide note observation is off.

## Threads, replies and context

One issue and one merge request are each one Thread. The Channel posts a reply as a note on that work item, with an HTML marker containing the Outbox message id; a retry searches the notes for the marker before posting. A missing work item settles the message as `gone`.

Assessments read the work item's title and description followed by its notes, through `gitlabThreadContext`. Both `root` and `parent` are the work item, because GitLab notes are flat.

When the agent's own merge request has a source branch whose last path segment is a Ticket's short name, or when a Ticket started from that merge request, the Source binds the merge request Thread to the Ticket. A merge or close then reports the Thread closed to the Engine, which ends the Ticket once no other Thread of its own remains open.

## Configuration

Each configured instance has its own settings and token, and its own Trigger ids, Threads, cursor, Policy part and health. The default instance is `gitlab`; an operator adds further instances, such as `gitlab-ops`, in the Sources settings.

| Setting | Meaning |
| --- | --- |
| Site | `https://gitlab.com`, or a self-hosted instance address |
| Project | `group/project` or `group/subgroup/project` |
| Access token | A GitLab personal access token with the `api` scope; `read_api` is enough to read, but not to reply |
| Agent account | The GitLab username whose issues, merge requests and notes are ignored; also the username a mention must name |
| Receive new issues / merge requests / notes | Widen observation from mentions to every such item in the project |
| Polling interval | 60–3600 seconds, avoiding GitLab's rate limits |
| Failed polls before reporting an error | A single network interruption is retried on the next poll |

The token stays in this deployment's local settings and is sent only to the configured site. It is never written to a Trigger, a Ticket, a prompt or the execution environment. The settings API still returns it to the panel, and anyone who can read the deployment's settings database can read it.

The Source registers `DSH_SUPERAGENT_GITLAB_SITE`, `DSH_SUPERAGENT_GITLAB_PROJECT`, `DSH_SUPERAGENT_GITLAB_KIND`, `DSH_SUPERAGENT_GITLAB_NUMBER` and `DSH_SUPERAGENT_GITLAB_URL` for the Executor. They name the origin work item so a worker knows where the request came from; they do not grant GitLab API access. A Ticket that needs to push a branch or open a merge request needs its own credential outside this Source.

## Enabling it

The bundle inserts the plugin disabled:

```yaml
- id: dsh-superagent-gitlab
  name: dsh-superagent/gitlab-watch
  disabled: true
```

Enable it in a profile's `cordis.patch.yml` with `disabled: false`, build, restart dsh-superagent, then fill in the default instance's settings and switch it on. Add more instances from the Sources settings. `tests/gitlab.spec.ts` covers translation, scoping, instance ids, polling and its cursors, Thread context, the note Channel and health.

## Limits

- Polling has no deletion event, so a deleted issue or merge request produces no Trigger; replies there settle as gone.
- Only issues, merge requests and their flat notes are read. Diff discussions, pipelines and CI status, releases, wikis and snippets are not.
- An edited note is one Trigger per observed version; several edits between two polls collapse into the latest body.
- The Source observes the whole configured project. There is no per-item subscription; the admission table decides whether an observed item becomes a candidate.
- Each instance polls one project; watch one project twice or watch two projects with two instances.
- The session needs a GitLab personal access token. There is no `glab` worker shim and no git credential helper for GitLab in this change, so a worker that must push or open a merge request needs a separate credential.
