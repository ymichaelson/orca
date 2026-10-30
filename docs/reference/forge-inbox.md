# GitLab inbox: historical implementation reference

> **Historical reference — not deployment or security guidance for the project-event redesign.**
> Except for the explicitly current RPC note below, this page describes an earlier implementation,
> including manual instance credentials, protected read-only analysis and approval flows. Those claims
> must not be used to deploy or assess the redesign. The redesign uses execution-host `glab`
> authentication, automatic project webhook registration and the selected Agent's existing
> permissions; it is not a read-only sandbox. Implementation and acceptance are still in progress.
> The local working documents `docs/project-event-agent-redesign.md`,
> `docs/project-event-agent-progress.md`, and `docs/reference/project-event-agent.md` describe the
> redesign and its remaining boundaries; they may be absent from a checkout.

The earlier inbox (`src/main/forge-inbox/`, shared types in `src/shared/forge-inbox-*.ts`) admitted
GitLab webhooks into a host-owned ledger and used a read-only analysis and approval workflow. The
following historical sections record that design; they do not describe current operating instructions.

## Current RPC retirement and owner discovery

`forgeInbox.getConfig`, `forgeInbox.updateConfig`, `forgeInbox.setCredential`, and
`forgeInbox.clearCredential` are removed from the current server. An otherwise authorized old caller
receives `method_not_found`; mobile callers remain subject to the mobile allowlist before method
lookup and receive `forbidden`. Do not use these methods to configure a host. Use the current
project-event settings UI for configuration and `forgeInbox.getStatus` to discover the selected
owner; route subsequent requests to that owner, without falling back to the local inbox.

Current `forgeInbox` read, stream, receiver, project-event policy and question handlers declare
`workspace` permission. Paired desktop callers have the standard runtime permissions; the mobile
allowlist contains no `forgeInbox.*` methods. These statements describe registered source methods,
not an acceptance claim for every client or platform.

## Historical design (not current deployment guidance)

All sections below record the earlier implementation and may describe removed APIs, outdated
capabilities or obsolete safety behavior. They are not a current operations or validation checklist.

### Where it ran

- One owner service per Orca profile. Its ledger is `<profile>/forge-inbox.db`, opened at runtime
  start when the file already exists, otherwise on the first config or credential write and then
  kept for the life of that runtime. A profile that never configured the feature never creates it.
- Until that first write the service is dormant (no listener, no timers, no file) and reads report
  `phase: 'running'` with `dormant: true`.
- Only the machine that owns the ledger runs the listener, the analysis and the GitLab writes. A
  paired client can read and act through RPC, but it never runs forge work for a remote host.
- The host advertises `forge-inbox.v1` plus granular ones (`forge-inbox.notifications.v1`,
  `forge-inbox.changes-stream.v1`, `forge-inbox.project-policy.v1`); an authenticated client
  advertises `forge-inbox.notifications-reader.v1` once its app-lifetime bridge can route notices.
  A client that does not see the host capability must not show the feature as available. Clients
  and hosts upgrade independently, and there is no implicit fallback to a local inbox.
- These markers describe implemented support, not storage health: `forgeInbox.getStatus` reports
  `phase`, `running`, `dormant`, listener state and pending work, and that is what tells a client
  whether the feature can actually be used right now.

## Registering the webhook in GitLab

1. The earlier implementation enabled the listener through inbox settings or the now-removed
   `forgeInbox.updateConfig` RPC. Its defaults were `enabled: false`, `bindAddress: 127.0.0.1`,
   and `port: 7421`; this is not a current setup procedure.
2. In the GitLab project, add a webhook with URL
   `http://<orca-host>:7421/webhooks/gitlab/<instanceId>`. `<instanceId>` is the id you configured
   (`^[a-z0-9][a-z0-9-]{0,62}$`); the route only accepts that shape and only `POST`.
3. Set the webhook **secret token** to the instance's `webhook` credential. That token is compared
   in constant time; it is not a GitLab API credential and grants nothing.
4. Select the events you want: merge request events and issue events. The project policy decides
   which of them reach the inbox (`reviewRequests`, `participatingMergeRequestUpdates`,
   `pipelineFailures`, `issueMentions`, `issueAssignments`), so an event you do not switch on is
   acknowledged and dropped.
5. GitLab administrators must allow the Orca host as a webhook destination. GitLab blocks requests
   to loopback, private and link-local addresses by default; allow only the Orca host, not a whole
   private range.
6. If the GitLab instance is served over plain HTTP, the matching instance must set
   `allowInsecureHttpApi: true`; otherwise config validation rejects its `baseUrl`.

`X-Gitlab-Token` is the only authentication. There is no request signature check and no replay
window beyond the idempotency key, so treat the token like any other shared secret.

### Delivery ids and older GitLab

`webhook-id` (with `Idempotency-Key` as its legacy alias) is the retry-stable message id and is what
the inbox deduplicates on. If the header is absent, admission is refused with `400
missing-delivery-id` unless the instance sets `allowLegacyPayloadDigestDedupe: true`; with it, the
key becomes `digest:<project>:<event>:<sha256(raw body)>`. That fallback collapses two genuinely
different deliveries whose bodies are identical, which is why it is off by default.
`X-Gitlab-Webhook-UUID` and `X-Gitlab-Event-UUID` are recorded as correlation only — they can be
shared across recursive events and are never the dedupe key.

## Credentials

Three kinds per instance, stored in the host-private ledger, never returned by any read:

| Kind        | Used for                                                     | Notes                                                          |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `webhook`   | Inbound token check                                          | The GitLab webhook secret.                                     |
| `api-read`  | Snapshots, relevance, head re-checks, publish reconciliation | Needs `read_api` scope.                                        |
| `api-write` | Posting an approved comment                                  | Needs `api` scope. Optional: without it approvals fail closed. |

- Writes are refused with `unprotected-storage` unless the host can seal them, unless the caller
  passes `allowUnprotectedStorage: true`. An accepted plaintext credential reports
  `protection: 'plaintext'` plus the gap so the UI can warn; it is never silently degraded.
- The analysis agent never receives any of these secrets. Only the trusted ingress and the comment
  broker read them, inside the main process.
- `api-read` writes requeue the instance's `needs-auth` deliveries in the same transaction, so
  installing a token cannot leave work parked behind an old one.
- Removing an instance from the config deletes its credentials.

## Accepting traffic

- Loopback bind is the default. A non-loopback bind additionally requires
  `acknowledgeExternalPlaintextHttp: true`. That flag is an acknowledgement, not a protection:
  webhook bodies travel in cleartext, so use it only inside a trusted network.
- The ingress is not reachable through the agent hook endpoints and shares no route with them.
- Limits: 1 MiB body (`413 body-too-large`), 16 KiB / 64 headers, JSON content type only, a request
  deadline, and queue limits of 1000 pending deliveries / 16 MiB of bodies (`503 queue-full`).
- Rejections are explicit: `404 not-found`, `405 method-not-allowed`, `415 unsupported-media-type`,
  `401 unauthorized`, `400 invalid-headers`/`missing-delivery-id`, `422 project-not-configured`/
  `project-disabled`, `503 unavailable`/`config-changed`/`queue-full`.
- After the body is committed to the ledger the request is answered `202`, and only then is the
  worker woken. A crash between commit and analysis loses nothing.

## What happens to an admitted event

1. The delivery row is pending. A worker claims it, parses the payload, decides relevance from the
   configured usernames plus an authenticated GitLab snapshot, and creates or updates the item.
2. Failures retry with exponential backoff from 30s up to 15 minutes, at most 5 attempts; a GitLab
   `Retry-After` is honoured only when longer (capped at 5 minutes). Past the bound the delivery is
   marked `failed` with a coded reason, never with payload text.
3. A missing or unusable API token parks the delivery as `needs-auth` until the credential changes.
   Parked rows do not keep a managed host alive.
4. Disabling or removing a project settles its open deliveries — pending and parked — as done. Only
   the dedupe key is kept; the body is cleared. Re-enabling the project does not resurrect them.

**There is no polling.** The inbox sees only what GitLab delivers and what the host can read when it
is awake. A host that was off, a webhook GitLab gave up on, or an event dropped after the project was
disabled is gone — GitLab does not guarantee replay of failed webhook deliveries. The UI must not
promise an offline-complete history.

## Automatic analysis: the only supported safety profile

Analysis runs as a protected Claude session, profile `claude-native-data-only-2.1.302-v1`, and only
against a binary whose SHA-256 is one of the reviewed ones in
`src/shared/agent-session-protected-claude-launch.ts` (`darwin-arm64`, `linux-x64`, `win32-x64`).
Anything else — another version, another architecture, a modified binary — fails closed rather than
running with weaker settings; there is no prompt-only "please don't write" mode.

With the profile in force the session has no tools, no settings sources, no MCP servers, no plugins
and no hooks, a feature-private home and config directory, and an inert working directory. The model
auth it uses is extracted into its own sealed env; the project's own config and credentials are never
inherited. Project `rules` are untrusted text and are never executed.

Policy fields that matter:

- `enabled` — whether the project accepts events at all.
- `automaticAnalysis` — opt-in to spending a model call per relevant event; requires `agentId` and
  `model`, and those are resolved at launch, not at enqueue time. Turning either off aborts queued
  and in-flight analyses without deleting the item or its history.
- `budgets` — `timeoutSeconds` (10–3600), `maxInputTokens`, `maxOutputTokens`, `maxRunsPerHour`,
  `maxConcurrentRuns` (fixed at 1 per project). Results over the output budget are refused, not
  truncated.
- `rules` — bounded to 16 KiB of UTF-8, no NUL.

Only Claude has a protected adapter. A project pointed at another agent or model fails while the
protected session is being founded — it does not silently fall back to an ordinary CLI session, and
it does not fall back to a non-protected Claude launch. An `automaticAnalysis` project without both
`agentId` and `model` cannot be saved at all.

## Changing a project's policy while an agent is dispatched

Changing a project's rules, Agent or model, or disabling it, revokes the dispatches those settings
produced. The change and the request to stop a still-running dispatch commit in one transaction, so
a crash cannot keep one without the other. Event and budget edits do not stop a running agent.

- A launch that is still resolving a workspace, creating a session or preparing a terminal re-checks
  the policy generation, the run and its own lifetime before each effect. A revoked launch sends no
  prompt and starts no terminal; a session it already created stays recorded on the run.
- A request to stop is delivered to the host that owns the session as that host's own Stop, naming
  the run's exact dispatched turn, at the session's current fence, under a durable operation id.
  The host accepting the request is a receipt, not proof: the run stays `running` (shown as
  "Stopping") until that turn's own proof settles it as cancelled, failed or succeeded. A refused or
  unreachable stop is shown as "Stop not confirmed"; nothing a stopped agent already did on GitLab is
  undone.
- After a restart or a host replacement the stop is re-asked of the current host. Nothing is
  relaunched or re-sent.
- A terminal-launched agent has no turn to name. Its launch records the exact PTY (handle, PTY id,
  incarnation, execution host) and Orca waits on that PTY's exit through the runtime's own wait. A
  stop closes it through the runtime's own close, after the wait exists and only on a terminal that
  a non-spawning listing still shows with the same PTY, incarnation and host; anything else is
  reported as not confirmed and nothing is closed. Only an `exited` wait is an exit, and the exit
  code or signal is kept as a process fact: the run stays unverifiable and its GitLab effects are
  closed as unconfirmable, because a process ending says nothing about what the agent did.
- Each dispatch also keeps the Agent and requested model (or "Agent default") it was dispatched
  with. They never follow a later policy change. The actual model is stored only when the runtime
  itself had already reported one for a structured session; it is never read from a catalog or
  probed for, and a terminal dispatch has none.

## Approvals and writes

- A pending proposal is bound to the exact draft hash, the proposal revision, the policy generation
  and the head SHA the analysis saw. The generated text is never included in list or detail
  projections; `forgeInbox.getProposal` is the only read that returns it.
- Approval re-fetches the merge request head first. A newer head, a policy change (rules, agent,
  model, projects, credentials) or a second approval answers `head-moved`, `stale` or `not-pending`,
  and posts nothing. Reading an item is not approval and never marks anything done.
- A changed draft is a new proposal. Rejecting a proposal is local state only: no network, no
  credential, no effect on the project switch.
- The host, not the agent, holds the write credential. Every comment carries a unique marker of
  (proposal id, draft hash); if the POST response is lost, the broker reconciles by searching for
  that marker instead of posting again. A publish that cannot be confirmed is reported as such, not
  retried blindly.

## Historical permissions

The earlier implementation exposed configuration and credential management and an approval RPC.
Those management methods and the proposal, discussion and approval RPCs described above are retired;
they are not current deployment interfaces. For current caller permissions and admission order, see
[Current RPC retirement and owner discovery](#current-rpc-retirement-and-owner-discovery).

## Upgrade, downgrade and data safety

- The forge config is strict: unknown fields and unknown `schemaVersion` fail instead of being
  stripped, so a newer config is never quietly downgraded by an older build. Config size is capped at
  256 KiB.
- Instance origin is bound on first use. Reusing an instance id with a different `baseUrl` is
  rejected (`instance-origin-conflict`), including after the instance was deleted — old events and
  approvals can never be sent to a new destination.
- The host-scoped ledger uses schema version 2. Version 1 is migrated transactionally without
  rebuilding existing tables; version 2 adds durable explicit patch-request records. Older builds
  reject version 2 rather than downgrading it. An unreadable or future-schema file is left on disk;
  nothing is recreated over it.
- A protected analysis session raises the local chat journal database to version 5 the first time it
  is written. An older Orca build caps at 4, sees a newer schema, opens the journal read-only and
  refuses structured-chat replay/subscribe — so that build cannot use structured chats on this
  profile until it is updated. Nothing is destroyed, and updating again restores normal operation.

## Historical validation record

These results concern the earlier implementation and do not establish acceptance of the current
project-event redesign. The described old UI evidence spec and screenshot locations may no longer
exist or cover those workflows.

| Area                                                        | Status                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (darwin-arm64), real runtime + SQLite + loopback HTTP | exercised in development                                                                                                                                                                                                                                                                                                                                                                                      |
| Ubuntu, Windows                                             | **not run**. Cross-platform code passes type-checking and unit tests only.                                                                                                                                                                                                                                                                                                                                    |
| Dedicated local GitLab API reads                            | Production reader exercised against GitLab 19.5.1 on loopback: project repository, branch heads, complete tree, exact plain/BOM/CRLF files, merge request, commit and current-user identity. Production patch source also verified both files against pinned tree blob OIDs and proved a missing path from the complete tree. Disposable private project seeded through the API; no schema mismatch observed. |
| Real GitLab webhook, comment publish and Git push           | Direct local GitLab 19.5.1 MR Webhook → production owner/SQLite → deterministic fake analysis → approved real comment passed. Repeated approval returned not-pending; independent readback found one exact draft/marker and one applied receipt. Listener stayed on loopback via host.orb.internal; temporary hook/allowlist were removed. No real model, RPC/UI end-to-end or Git push was exercised.        |
| Paid model calls                                            | **not run**. Analysis turns are faked in tests; the protected launch path is exercised with fake child processes.                                                                                                                                                                                                                                                                                             |
| Rendered UI (inbox page, approval dialog, settings panels)  | Headless Electron/CDP spec `tests/e2e/forge-inbox-ui-evidence.spec.ts` passed (1 test); six screenshots in `validation-screenshots/forge-inbox-ui/` (git-ignored). Real webhook + fake GitLab; analysis/proposal rows seeded; Discuss opens its entry only (no real model turn or send).                                                                                                                      |
| Mobile                                                      | protocol-compatible only; no `forgeInbox` methods, no inbox UI.                                                                                                                                                                                                                                                                                                                                               |
| Remote host (`orcad`)                                       | wired (profile directory, cleanup, idle), not run on real hardware.                                                                                                                                                                                                                                                                                                                                           |

Treat a green test suite as evidence about the code, not as a platform or product acceptance.
