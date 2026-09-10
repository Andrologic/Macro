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

The implemented scope is the accepted A1 core. Per-project permissions,
conversation reading, actual diff content and global account/session lifecycle
remain contract complements. Reviews contain commit references and a verdict;
they do not merge or publish changes.

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
page fixture. Relay D at `81f7828b` rejects that valid result with HTTP 400
`invalid_reference`; the opt-in check fails until D accepts task membership via
`project_ids`. C preserves this contract behavior. Reviews with an explicit
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
