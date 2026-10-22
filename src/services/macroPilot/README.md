# Pilot native credentials

The typed `pilotSecretRead`, `pilotSecretWrite`, and `pilotSecretDelete` wrappers
in `tauriIpc.ts` access only the OS credential store. They reject browser-only
runtimes. `null` means no entry; `vault_unavailable` is an error, never absence.
Deletion is idempotent. Invalid stored token data returns `invalid_secret` and
can still be deleted. Native error details and secret values are never logged
by these commands.

Use a stable, non-secret `configuration_id` unique to each desktop profile and
the configured HTTPS `relay_origin`. Origins are normalized, including default
ports. Paths, credentials, queries and fragments are rejected. The OS service
namespace is `ai.andrologic.macro.pilot.v1`; the entry name hashes the structured
configuration/origin/kind/resource tuple. This hash names entries; the OS vault
provides confidentiality. It is not application-level encryption.

Choose and retain the non-secret `resource_id` as follows:

- `session_token`: server session ID.
- `instance_key`: original client `creation_id`, retained alongside the assigned
  instance ID. Keeping this lookup key avoids moving a secret during a creation
  retry or renewed session. Different instances use different creation IDs.
- `claim_secret` and `poll_secret`: one client-generated attempt key, created
  before the first auth request and retained alongside the server attempt ID.

All values must decode to exactly 32 bytes using canonical unpadded base64url.
This verifies encoding, not entropy. Generate client secrets with a CSPRNG;
never derive them from these non-secret identifiers. The native auth client
saves secrets before network effects, deletes attempt secrets after claim,
expiry or cancellation, and deletes session tokens on logout. It awaits
writes/deletes before dependent operations. Keep returned values only in
transient memory, outside stores, persistence, diagnostics and notifications.
No authentication route or lifecycle is implemented by this storage module.

`keyring` 4.2.0 with its `v1` feature selects Keychain Services on macOS,
Credential Manager on Windows, and Secret Service on Linux. Linux requires an
available, unlocked Secret Service; there is no file fallback. Calls run on a
blocking worker and are serialized in this process. The library initializes
its store once: a failed initial setup may require restarting Macro after the
OS service becomes available. An OS prompt can keep an operation pending.

Sources: [keyring API](https://docs.rs/keyring/4.2.0/keyring/) and the crate's
`src/v1.rs` documentation. Unit tests inject an in-memory vault and never touch
user credentials. macOS compilation is the local platform check; Windows and
Linux vault integration require testing on those platforms before publication.


## Desktop supervision

`runtime.ts` starts after the application bootstrap and stops before shutdown.
The native client owns Device Flow, explicit account confirmation, instance
registration, access grants and OS credentials. The producer loop retries
network failures and submits canonical A1 results through the native transport.
Macro must remain open.

`kernel.ts` persists revisions, the event cursor, observed run bindings and the
idempotency journal in Macro's existing metadata database with compare-and-swap.
It writes an executing entry before dispatch. An uncertain interrupted effect
becomes indeterminate and blocks automatic replay. Settings exposes local
reconciliation only after the user confirms that the effect did not occur.

`desktopActions.ts` uses the existing task and chat actions, including their
provider dispatch. Reservations coordinate local actions with remote preparation.
The relay authorization is checked again at effect boundaries; a reservation
alone does not authorize a provider or tool effect. Historical snapshots remain
partial when Macro has no durable evidence for their actor, time or run.

The v1 supervision core and the negotiated v2 desktop content and account
clients are implemented here. The desktop can read conversation captures and
bounded diff content, and can manage account sessions. Per-project permissions,
relay support and mobile presentation require separate integration and
validation. Reviews record a verdict; they do not merge or publish changes.

For an opt-in cross-check, independently start a synthetic relay fixture and run
`bun dev/pilot-relay-cross-check.ts http://127.0.0.1:PORT`. The script accepts only
loopback, maps its test transport from a fixed HTTPS origin, and uses in-memory
credentials and task effects. The production HTTPS rule stays unchanged. It
exercises native authentication, association, scoped bootstrap/resume, commands,
replay after reconnect and disconnect through the real HTTP relay. It imports
no relay implementation and requires no external account.

Resume streams are scoped before sequencing: instance and workspace bootstraps
have different stream IDs, and unrelated events do not create sequence gaps.
Removal or departure from a scope expires its old stream and frozen pages, so
clients must bootstrap again instead of retaining deleted resources. Storage
version 2 preserves the command journal while expiring version 1 mixed-scope
cursors. The cache bounds are 128 streams, 2,000 events per stream and 128 pages.

Vite generates standalone schema validators on the build machine for both dev
and production. The WebView imports that module, never the Ajv compiler. The
production CSP remains unchanged; tests execute generated validators with
`Function` blocked and verify the Vite development import, including HMR URLs.

Add `--project-scope` to the cross-check to exercise the public task-by-project
page fixture. A participating relay must accept task membership through
`project_ids` as defined by the public contract. Reviews with an explicit
`ref.project_id` never inherit another project from their task.


## Sending to an existing Chat

The additive `conversation.send` command uses the v1 exchange and durable
command journal. Its target is the v2 Chat reference
`{instance_id, kind: "conversation", conversation_id}`, its payload is
`{content}` with 1 to 4000 characters, and `expected_revision` is the latest
`conversations.list` item revision. The content host checks that reference and
catalog revision before authorization can admit an effect.

Clients opt into `commands: ["conversation.send"]` during v2 negotiation and
show the composer only if the live producer returns that capability. The desktop
requires an existing idle Chat without a pending question or tool approval.
Activity `unknown` may be submitted because the desktop checks its actual runtime
and hydrated transcript. It preserves the conversation's project scope, provider,
model and reasoning effort. Active desktop selections do not retarget the send.
Retries retain the complete original command and idempotency key; an uncertain
execution remains blocked until local reconciliation.

## Network reliability extension

The [network reliability contract](../../../docs/macro-pilot/network-reliability-contract.md)
defines negotiated per-conversation captures, safe provider diagnostics for Chat,
Architect and Implement, conditional projects, migration and legacy behavior.
Relay and mobile consumers must implement its selection and invalidation rules
before enabling `network-reliability-1`.

Conversation, catalog, search and conditional project read results revalidate
policy and source after native credential waits, before each transport emission.
V2 authorization is one-shot per delivery; runtime guards share its original
execute_before. The native client reports dispatch only after invoking fetch,
after credentials, integrity, context and the emission guard. A conversation
capture invalidated before any result dispatch returns a content-free terminal
stale_revision or snapshot_expired with the original grant, without recapture.
Once fetch has been invoked, retries keep the canonical response because the
relay may already have accepted it despite a lost acknowledgement. The relay
rechecks live access at result acceptance and return. Each attempt still checks
source, policy, context and expiration. No retry renews a mutation's effect lease
or dispatches a command again.

For the negotiated mobile conversation catalog, search, observed reading and Chat
management operations, see [mobile conversations contract](../../../docs/mobile-conversations-contract.md).


## D1 desktop consumer transport

`MacroPilotNativeClient.consumerTransport()` provides a separate, typed consumer
port. `PilotTargetClient` owns an explicit target handle with one read slot and
one event slot. Concurrent reads on the same handle return `conflict`; different
handles remain independent. There is no process-wide target registry, background
polling, UI integration, automatic target discovery or service-provider switch.
The local producer and desktop service composition keep their existing owners.
This infrastructure does not complete the desktop multi-PC product workflow.

The closed D1 read set is `projects.list`, `conversations.list`,
`conversation.read`, `conversations.catalog` and `conversation.window`.
The only offered capabilities are `network-reliability-1`, `conversations-1`
and `conversation-history-1`. History requires conversations; catalog and window
reads require conversations, and backward windows also require history.
Consistency and conditional project reads require the selected reliability
capability. The caller opts into consistency in its typed request body.
Files, reflections, interactions, model selection, telemetry, commands and
mutations are unavailable through this port. Capability selection never grants
permission; the relay still checks current authority for every exchange.

Create a target with the native transport, await `negotiate()`, then call
`read(operation, body)` or `events()`. An optional directory access record must
match the native account/session and the target instance. `setAccess()` fences
reads when its revision changes, rejects older/conflicting revisions and blocks
revoked access. Absence of a directory record supplies no authorization shortcut.
Call `reset()` to cancel and renegotiate a target, and `dispose()` when its owner
closes. A disposed handle cannot reopen. D2 must provide sharing between views
and lifecycle integration before exposing a desktop workflow.

A returned read contains its non-secret scope, original request and validated
response. Scope includes configuration/profile ID, normalized relay origin,
account incarnation, emitter session, native epoch, target instance, unique connection ID, local target
generation and observed access revision when supplied. Remote conversation IDs
remain nested in this scope. There is no claim that the current protocol exposes
a remote producer generation. The relay's selection checks, errors and stream
resets fence remote changes; negotiation retires the old local generation.

For continuation, pass the previous returned read as `previous`, and all earlier
item IDs as `seenIdentities`. Both are required for a continuation. The client validates target generation,
request resource, immutable capture fields, cursor, adjacent offsets and duplicate
identities. The caller owns the returned pages and any full-capture identity set.
The target keeps no response, transcript or page registry after returning it.
A replacement handle has a fresh connection ID, so even equal numeric generations
cannot readmit the retired handle's pages.
There is no automatic page accumulation or prefetch.

`events()` performs one demand-driven event request. Apply its returned page, then
call `acknowledgeEvents(batch)` before requesting another. Until acknowledgement,
the target keeps only the receipt identity and next stream/sequence, not the event
body. Caller edits cannot change that cursor. The client checks sequence continuity
and event instance/account membership. A reset retires this target's active read
and prior capture scopes. Other targets remain active. D2 must coordinate capture
loading with event application and provide any bounded buffering it needs.

Native sends use only the emitter bearer. They never read or attach an instance
key. They reuse native origin checks, credential fences, bounded body reading,
request correlation, redirect refusal, deadlines and late-response cancellation.
An accepted exchange must match the original request and retain the same expiry
through its GET polls. Polling cannot renew the original 60-second deadline.
No request, mutation or provider effect is automatically replayed.

A consumer network failure does not publish global offline/connected state.
A target access error retires that target's selection. A remote producer can also
report `session_revoked`; this code alone does not revoke the emitter. The native
owner makes a narrow guarded `/me` check, without provisioning an instance or
restarting a producer. Only confirmed failure of our current authentication uses
the existing global session cleanup. A late check cannot restore a replaced
context. Native vault failures retain their existing global authority behavior.
The local producer's Windows/WSL preparation guards are unchanged and do not imply
a consumer permission or a validated consumer platform release.

D1 retains only connection metadata, active request state and an optional pending
event receipt. There is no transcript persistence, offline content cache or global
heap budget. The existing 256 KiB extension body limit, relay event wait of at most
25 seconds, native 30-second transport deadline and 60-second exchange lifetime
remain distinct contract limits. JSON buffers, strings and decoded objects can
coexist transiently; serialized bytes are not a heap measurement. D2 and B8 must
define admission and retention before adding a shared process cache or retained
multi-view content. No performance or memory gain is claimed by D1.


### Host catalog observations

ContentHost preparation and observation share one verified pair of complete
catalog source reads. The projects fingerprint is projected exactly as the
standalone projects observation, with its own durable revision. A stable host
pass calls the projects source twice instead of four times. Conversation source
reads and the two-read consistency check remain unchanged. This counts source
calls, not IPC traffic, network bytes, heap or display latency.

If the conversation observation fails, a separate projects-only observation may
still report a valid project change. A partial catalog is never published. Reads
and delivery validation keep their fresh checks; this adds no timed cache or
read authority. Sequenced outbox events and acknowledgement retries are unchanged.
