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
never derive them from these non-secret identifiers. The future auth client
must save secrets before network effects, delete attempt secrets after claim,
expiry or cancellation, and delete session tokens on logout. It must await
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
