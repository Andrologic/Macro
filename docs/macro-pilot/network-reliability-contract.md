# Negotiated network reliability

This document defines `network-reliability-1`, an additive instance capability
on content contract `2.0`. The schema registry and `validate.mjs` in
`contracts/macro-pilot/v2` are normative for wire shapes. Fixtures whose names
start with `reliability-` cover this extension. The desktop implements the
producer. A relay and mobile must implement the rules below before selecting
this capability. Installing the desktop alone does not enable it on old peers.

## Negotiation and rollout

1. The producer offers `network-reliability-1` in its v2 delivery poll alongside
   the existing task capabilities. A successful poll acknowledges the producer
   contract. On an initial HTTP 400/422 it retries with the two task capabilities,
   then without capabilities if those also fail. Other failures use normal
   backoff. After a successful advertisement there is no in-place downgrade.
2. The consumer offers the capability in `POST /pilot/extensions/negotiate`.
   The relay selects it only if the live producer and consumer both offer it.
   Its selection remains bound to account, session, instance, access revision
   and producer generation. ACCOUNT negotiation cannot select this capability.
3. Enhanced `projects.list`, `conversations.list`, `conversation.read`,
   `conversation.tools.list` and `conversation.tool.read` requests
   set `body.consistency: "network-reliability-1"`. The relay checks its stored
   selection, then attaches `capabilities: ["network-reliability-1"]` to the
   producer delivery. The desktop rejects an enhanced request without that
   attestation. Tool operations also require the existing `task-details-1`
   selection. Capabilities confer no authorization; the existing fresh
   authorization before emission still applies, including cached responses.
4. The producer returns extensions only on opted-in requests. Old requests keep
   their shapes, revision semantics and Chat/Implement catalog. Cursor ownership
   includes the consistency mode. Changing mode requires a new capture.

A capable relay serving old consumers must keep conservative legacy invalidation.
It must filter `conversation.resource_changed` from legacy event pages and
sequence each consumer stream **after filtering**. The accompanying
`conversations.changed` event supplies the legacy invalidation. Never leave gaps
in consumer sequence numbers. Changing selection, access or producer generation
expires the old stream, captures and outstanding reads. Roll out the schema and
relay rules before enabling selection on mobile. Older relays reject the new
producer offer and receive only legacy events after fallback.

## Revision domains and invalidation

| Value | Meaning |
| --- | --- |
| `conversations.list.result.page.revision` | Durable catalog clock. Advances when catalog metadata or a watched transcript changes. |
| Summary `revision` | Existing global clock used by v1 `conversation.send.expected_revision`. Preserved for compatibility. |
| Summary `content_revision` | Last durable clock value at which this conversation's identity, metadata, activity, diagnostic, policy or observed transcript changed. |
| Enhanced `conversation.read.result.page.revision` | This conversation's `content_revision`, independent of other conversations. |
| Legacy transcript page revision | Global catalog clock, unchanged legacy behavior. |
| Projects page/conditional revision | Separate durable projects clock. |

Per-conversation stamps need not be consecutive. They are not timestamps or
cross-instance ordering keys. A targeted read may discover a newer transcript
than its previous summary; refresh that summary when the revisions differ.
The catalog observes metadata only, except for transcripts with live captures.
An explicit read always validates its own transcript. Expiry and lifecycle
cleanup end background transcript observation.

The capable producer emits `conversations.changed` for the catalog, and
`conversation.resource_changed` with the exact conversation reference and its
new `content_revision` only for changed conversations. It does not fan out
`conversation.changed` for every reference. A producer using legacy fallback
retains the old event fanout. `conversation.removed` retains its existing shape;
its revision uses the global clock and marks a removed full reference.

For enhanced captures and in-flight reads, the relay and mobile must apply:

| Event | Invalidate |
| --- | --- |
| `conversations.changed` | Conversation catalog pages only. |
| `conversation.resource_changed` | Transcript and conversation tool captures for the exact full reference. |
| `conversation.removed` | Exact transcript/tool captures, catalog, selection and draft target. |
| `projects.changed` | Project metadata and project pages. |
| `tools.changed` | Exact conversation tool captures and transcript, as before. |
| `tasks.changed`, `task.changed`, `review.changed` | Their existing precise scopes. |
| Sequence gap/reset, authority loss, producer replacement | All captures and pending reads for the affected selection. |

Compare full references, including instance and Implement workspace/task, never
only conversation IDs. Revoke access independently of content caches. A capture
cannot grant permission, and a reconnect never creates a new command. Repeated
reads revalidate their cached capture before emitting it. Cached conditional
project replies are recomputed. Changed/deleted content cannot be returned from
an old request receipt.

The desktop journal migrates from version 2 to 3 by retaining its global and
projects clocks and adding per-reference fingerprints and stamps. It stores no
message text, diagnostic raw body, secret or path. Captures remain transient.
Every host lifecycle starts a fresh producer stream. Rollback to old desktop
code requires discarding only this capture journal with captures/streams closed;
never discard the separate v1 command journal or review/task action receipts.

## Safe provider diagnostics and conversation modes

Enhanced summaries additionally contain `mode` (`Chat`, `Architect`, `Implement`)
and `provider_error`, either null or the following closed object. `message` is a
localization key, never provider-authored text. Consumers translate these keys.

| category | message | recovery |
| --- | --- | --- |
| authentication | provider_authentication_required | desktop_action |
| quota | provider_quota_exceeded | desktop_action |
| rate_limit | provider_rate_limited | retry_later |
| unavailable | provider_unavailable | review_before_retry |
| context_limit | provider_context_limit | desktop_action |
| invalid_request | provider_invalid_request | desktop_action |
| unknown | provider_failed | review_before_retry |

Only structured error kind, status and exact known quota codes feed this mapping.
The producer exports no raw `lastError`, error stack, provider response, URL,
provider/model identity, prompt or path in diagnostics. The common stream error
lifecycle populates this value for Chat, Architect and Implement. If old runtime
state knows only that a provider failed, the safe category is `unknown`. A normal
or running activity exports null, so a resolved error does not remain visible.
Persisted local provider diagnostic messages carry `completion_reason: provider_error`
and are withheld from transcript exports, even if an older final-text receipt
exists. Their diagnostic is delivered through the structured summary.
Local Macro failures remain `activity: error` with a null provider diagnosis.

Architect is exposed only to enhanced clients, as `kind: "conversation"` with
`mode: "Architect"`. Its transcript and tool traces are readable only with the
consistency marker and
attested selection, including list continuations and detail chunks. Tool captures
also bind their consistency mode; changing mode requires a new capture.
The existing v1 send command
still requires actual Chat mode, no task association, fresh configuration,
no active run/question/approval, and a desktop preflight. Implement references
still require a unique task and project binding. Clients must show the composer
only for Chat. `activity: unknown` does not alone prohibit submission: desktop
runtime and hydrated transcript decide eligibility.

Keep these independent signals when presenting an action:

- A1 `accepted`/`duplicate` means the desktop accepted the command effect. It does
  not mean the provider finished successfully.
- `activity: busy` means the conversation is running.
- `activity: error` plus `provider_error` means a provider failure was observed.
- A lost result, interrupted effect or A1 indeterminate/conflict path remains
  uncertain until reconciled with the same original body and idempotency key.
  Never manufacture a successful completion or automatically resend as a new
  action. `recovery` is advice for a future explicit decision, not replay consent.

`summary.revision`, not `content_revision` or transcript page revision, remains
the expected revision for v1 sends. An unrelated edit can still make a **send
preflight** stale; it no longer invalidates an enhanced transcript capture.
This conservative command check intentionally preserves existing idempotence
and authorization deadlines. A later per-conversation command revision would
need its own explicitly tagged contract change.

## Conditional project metadata

After fully loading `projects.list`, retain its page revision. With the negotiated
consistency marker, an initial request may add `known_revision`. It is mutually
exclusive with continuation. On equality the result is exactly
`{not_modified: true, revision, observed_at}`; there is no page, cursor or item
array. On mismatch the ordinary first page is returned. Validators reject an
unconditional not-modified result or a mismatched revision. Pagination always
uses the ordinary snapshot/cursor path.

Use this v2 metadata source instead of repeatedly bootstrapping v1 projects when
the capability is selected. After initial loading, `projects.changed` triggers
the next project refresh; stable event cycles perform zero project list reads.
Use the conditional request to verify retained metadata when needed, for example
at its five-minute freshness boundary. `not_modified` renews metadata freshness,
not snapshot expiry or authorization. Before capability selection, retain the
existing v1 project refresh. On reset, revoked access, session change or producer
replacement discard retained metadata and bootstrap again.

Histories, traces, artifacts and files remain explicit on-demand reads. No
persistent conversation cache or mobile background subscription is introduced
by this desktop extension.

## Reproducible local evidence

Run `bun test src/services/macroPilot/networkReliability.test.ts` for two synthetic
chats with 101 messages each and 100 projects. It prints only counters, byte
sizes and elapsed time. The legacy path is the before reference; the enhanced
path is the after reference using identical data and actions. It measures JSON
and separately gzipped application bodies, logical exchanges, producer events,
source reads, B re-reads, capture resets and local elapsed time. It does not
measure HTTP framing, network RTT, phone battery or radio usage. Random opaque
IDs can cause small differences in gzip sizes.

Focused tests also cover cursor ownership, deletion/recreation, task membership,
policy changes, journal migration, cancelled lifecycle, expiry, lost read reply,
revocation, conditional project refresh, and the real shared provider error
lifecycle in all three modes. Runtime tests cover delivery retries past the
execution lease without extending effect authorization. Relay and mobile must
validate their own invalidation, subscriptions, background/foreground behavior
and real-device/network paths after integration.
