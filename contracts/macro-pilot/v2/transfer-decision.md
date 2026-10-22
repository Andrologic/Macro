# Macro Connect decision contract transfer-decision-1

This separate registry defines closed metadata for exclusive global Chat transfer.
It adds no route, capability, content operation, native authority or active
consumer. Existing v1 and v2 roots, validators and fixtures stay byte-identical.
The discriminator is `decision_contract: "transfer-decision-1"`; it does not
relabel any existing `contract_version`.

Load `transfer-decision-schema-set.json` explicitly, register its resources by
`$id`, then compile its root. There is no remote schema resolution. The JSON
Schema and synchronous rules in `transfer-decision-validate.mjs` are both
normative. Shape alone cannot validate bindings or authorize an actor. Generated
data declarations are in `transfer-decision.d.ts`; ESM helper declarations use
`.d.mts`. Conformance checks their rendering against the schema.

```sh
bun contracts/macro-pilot/test/validate-strict-json.mjs
bun contracts/macro-pilot/test/validate-transfer-decision.mjs
```

Node can run the same scripts. The decision module uses Node/Bun's standard
SHA-256 and local Ajv 2020 loader, with no asynchronous hashing or I/O in a plan.
The separate `strict-json.mjs` has no Node dependency and is reusable in browsers.
It lets JSON.parse own syntax, then rejects duplicate decoded object keys in one
structural pass. Syntax errors return `invalid_json`, duplicate keys return
`ambiguous_json`. Callers must admit the raw string, parsed graph and key sets
before calling it. It does not inspect a provider grammar or apply export policy.

## Identity and exact comparison

S is the tuple `relay_origin`, `account_id`, `source_instance_id`,
`source_conversation_id`. `account_id` is the existing `accounts.account_id`,
including its emitted prefix. It identifies an account incarnation. A GitHub
subject, login or account revocation counter cannot replace it. Deletion and
recreation of the same external identity creates another incarnation.

`relay_origin` comes from the relay authority's verified configuration. It never
comes from Host, Origin, Forwarded, a request URL or a body-selected namespace.
Two HTTP aliases pointing to the same DB must use the same configured authority
origin and ledger key. A body may quote that expected origin only for comparison.
Changing the authority origin requires explicit provenance migration and
reconciliation; an old source does not become available at a new URL.

Origins use exact canonical HTTPS origins with no path, query, userinfo, fragment
or explicit default port. Hostnames use their URL ASCII representation. HTTP is
allowed only for a canonical loopback origin explicitly provided through the
trusted test context. A normal adapter leaves `loopback_test_origin` null.

Existing Pilot IDs use bounded ASCII IDs without trimming or case folding. Local
conversation IDs use the same portable character set, 1 to 128 characters.
New transfer, lineage, installation, recovery, challenge, delivery and receipt
IDs use canonical lowercase UUID strings. SHA-256 is lowercase hexadecimal.
IDs compare exactly, without Unicode normalization or splitting an emitted ID.

All epochs, revisions and byte counters are canonical decimal strings in
`[0, 9223372036854775807]`. Positive fields exclude zero. Signs, leading zeros,
fractions, exponent notation and JSON numbers are rejected. Arithmetic uses
checked BigInt or exact native integers. Adapters may convert an existing Number
only after `Number.isSafeInteger`. Overflow refuses the operation. Generation
tokens from PilotContent remain opaque strings, not monotonic counters.

Canonical JSON sorts object keys by UTF-16 code unit order and preserves array
order. It rejects unsafe numbers, non-JSON values, cycles, sparse/extended arrays,
symbol keys, enumerable accessors and lone surrogates. Decoders reject duplicate
decoded keys before canonicalization. A decoded object cannot retain those
duplicates. `decodeDecision` supplies the bounded strict decode entry point for
this metadata; it does not admit transcript data.

`fingerprint(domain, value)` hashes canonical UTF-8 bytes after
`macro-connect-${domain}-1` plus a NUL byte. The closed domain list is exported
in the declarations. It separates source keys, provenance, binding, retry bodies,
semantic step bodies, birth, frozen, manifest, prepared, attestations, terminal
and activation. The relay's historical ASCII hash helper must not be reused.
The full source tuple remains in each ledger so a digest lookup also verifies
the original identity. Equal hashes without equal typed bindings are insufficient.

## Binding and trusted authority

Provenance contains S, lineage ID, installation ID and birth recovery generation.
It is non-secret and survives backup and Pilot credential detachment. Possessing
it grants no permission. A new target conversation receives new IDs once during
preparation. A later return is a new cession of that target conversation; the
original S remains ceded permanently.

T fixes transfer ID, provenance, epoch, unique target instance, recovery generation,
initiator account/session/device, session and account revisions, both access
revisions, and both producer generations. The target is a different instance of
the same account. Requests have no `issued_by`, bearer, credential, permission
claim or authentication boolean. The adapter constructs the initiator from the
authenticated bearer before reserve and compares it with the proposed binding.

Every nonterminal progression and commit requires supervise AND respond on BOTH
instances, with the same initiator and all bound revisions current. Source and
target producers are separate actors. Their instance credentials and selected
generations authenticate their own constats; their permissions do not replace
the initiator's. A future target fetch must bind to T and these current recorded
initiator rights, not merely the target producer session's own permissions.

The adapter reauthenticates before entry, inside its decision transaction and
before sensitive emission. After any await it must verify that the selected
producer connection/object and generation still match. The helper compares the
provided trusted snapshots; it cannot authenticate them. Never populate context
from a caller-supplied JSON object or treat a successful validator as native proof.

A new initiator/session cannot take over a nonterminal by retry. Changed session,
access, permission, account or producer generation prevents progression. An intact
nonterminal can be durably aborted by trusted maintenance, then a new attempt
uses a larger epoch. A terminal is immutable. A currently authenticated actor
with supervise access on the concerned instance, or an explicit current recovery
grant scoped to it, may read the minimal known terminal without reviving the
original session. Recovery grants authorize metadata reads only.

## Native commitments and producer attestations

The three closed commitments use `format_version: "1"` and bind to T:

| Commitment | Producer obligation before attestation |
| --- | --- |
| `frozen` | Native ownership transaction durably froze the source, closed all admissions and resolved in-flight/unknown work. Binds ownership revision, content incarnation/revision and freeze SHA-256. |
| `manifest` | Capture, complete export-policy inspection and E sealing ran under that same freeze. Binds frozen digest, source revision, manifest SHA-256 and exact content-contract SHA-256. |
| `prepared` | Target durably validated and pinned E, mappings, dependencies and real next-turn preparation without calling a provider. Binds manifest digest, import ID, target conversation/lineage IDs and mapping/preparation hashes. |

The relay does not interpret E messages. It only accepts content-contract hashes
in its trusted set of integrated, supported contracts. An empty set refuses
seal, ready and commit. A syntactically valid digest does not register support.
No text, title, path, filename, transcript, asset, provider body or credential
belongs in these metadata objects or their error/log representation.

Attestations have closed kinds for lineage creation/enrollment, source freeze,
source seal, target pin, source/target maintenance and target activation. They
contain the subject digest, binding digest, selected producer instance/generation,
delivery and challenge IDs, exact request fingerprint and prior receipt/commitment
digest. The adapter supplies the outstanding correlated exchange, authenticated
connection ID and current selected producer. Every value must match. A consumer
cannot submit an attestation JSON to acquire that status. The adapter consumes
the challenge atomically with accepting the result or returns the original receipt
for an exact replay. Attestation storage and authentication are adapter duties.

Seal cites the frozen commitment digest. Ready cites the manifest commitment.
Commit obtains two fresh correlated maintained attestations over the exact commit
request, the source frozen commitment and target prepared commitment. The source
confirmation cites the manifest; the target confirmation cites prepared. These
are binding comparisons, not distributed signatures or leases. A producer loss
before commit prevents commit. It never reopens the already frozen source.

Source and target native journals, E interpretation, pin durability and activation
are future activation prerequisites. A synthetic channel fact in conformance
tests proves only the helper's comparisons, never those native obligations.

## Birth and first enrollment

`lineage.create` writes a ledger at epoch zero before any reserve. It requires
current source authority and a correlated authenticated native attestation.
`mode: "created"` attests actual creation of new IDs in the current recovery
generation. The native owner must refuse to issue this event for a restored,
imported or renamed source carrying earlier provenance.

`mode: "initial_existing"` supports a genuinely never-transferred global Chat
that already existed when F tracking was installed. It is allowed only against
an intact relay history. The native enrollment attestation must establish the
existing ownership, lack of earlier transfer provenance and absence of any
restore/uncertainty barrier. A missing relay row alone establishes none of that.
The enrollment fixes provenance once; it is not a way to rename an earlier source
or retry a cession. After relay restore, only actual new creation can enroll.

This distinction preserves old global Chats while allowing new work after a
server restore. No login, new instance ID, UUID or self-asserted timestamp proves
newness. Native attestation generation must enforce these semantics before the
feature can be enabled.

## State, CAS and retries

Ledger states are available, reserved, ceded and recovery_hold. The ledger stores
provenance, birth receipt, revision, high epoch, active T and committed terminal
when ceded. It never expires. Journal phases are reserved, sealed, target_ready,
committed, aborted and recovery_hold. The hold preserves its inherited phase.
The schema rejects extra fields throughout; relational checks also tie each
step receipt to its commitment and each terminal to the exact frozen digest.

| Operation | Durable adapter action after a valid synchronous plan |
| --- | --- |
| `reserve` | Require registered available S, current source freeze, both producer generations and initiator rights. Atomically write journal reserved and ledger high epoch/active T. |
| `seal` | CAS reserved to sealed, fixing one source manifest. |
| `ready` | CAS sealed to target_ready, fixing one prepared pin and target IDs. |
| `commit` | CAS target_ready to committed with both current maintained attestations; atomically mark ledger ceded. |
| `abort` | CAS an intact nonterminal to aborted; ledger becomes available while retaining high epoch. |
| `reconcile` | Read status under current authority. The explicit abort_missing variant can create an absent-reservation tombstone in intact history only. |
| `activation.record` | Record the authenticated target's already durable application receipt after committed. It changes application revision, never the terminal. |

Every mutation checks expected revision and state. New journals start at revision
one; successful mutations increment by exactly one. Step receipts include
previous/current revision, binding digest and subject digest. Terminal receipts
include S/T/epoch, frozen and binding digests, decision revision and committed
preparation/manifest when present. Decision and activation receipts are distinct.
Timestamps and TTLs cannot substitute for these states.

Retry identity is account incarnation, T, operation and operation_id. Fingerprints
cover the complete validated request, including expected revision and commitment.
Same identity/body returns its stored receipt and current status; another body is
a conflict. A new operation_id for the same semantic successful step returns the
same receipt rather than adding storage. Rejected requests create no durable retry
entry. The journal has at most one entry per accepted step and five total entries.
Changing an operation ID cannot circumvent the source ledger or acquire another
target. Retry output remains subject to current authorization. New sessions use
reconciliation rather than replacing the initiator.

Commit and abort compete on the same journal revision. A terminal winner never
changes. The loser receives that terminal if currently authorized to read it.
A source becomes permanently ceded on committed. An aborted receipt only resolves
its exact reservation; other restore/unknown barriers can still prevent opening.
The target remains inactive until native reconciliation of committed. It publishes
the already allocated IDs, conversation and activation receipt atomically and
calls no provider. An activation retry returns those same IDs and receipt.
Recording a new activation requires the current actor's supervise AND respond
rights on the target, current supported E contract and authenticated target
producer attestation. It does not require reviving the original initiator.
A read-only recovery grant can retrieve an existing receipt but cannot record
or authorize a new application.

After ready, the target pin has no destructive TTL. Timeout, quota pressure or
cancellation requires an authentic aborted terminal before removal. If committed
won, lost target data or disk failure remains a target recovery error. No rollback
or compensation reopens the source.

## Absence, restart, restore and maintenance

Transfer reconciliation returns terminal, in_progress, not_found or recovery_hold.
Its current recovery generation and source_recovery state are separate from the
immutable historical terminal. An old T1 aborted may remain readable after a
restore whose backup predates a later T2 committed. That historical aborted is
returned with the current source recovery_hold; it cannot reopen S. The source
status reply also carries the current recovery generation. Native reconciliation
must enforce these current ownership barriers even when a terminal receipt is
valid for its original T and epoch.
An absent reservation in an intact history can be closed only by an authenticated
abort_missing request with the frozen binding and no other active T for S. Its
transaction writes aborted and advances high epoch before any source unfreeze.
A delayed reserve then returns aborted. Another T with an old/equal epoch is
rejected even if payload detail was compacted. With another active T, this path
refuses to cancel it. A not_found response alone gives no permission.

The source_status variant accepts provenance S alone, without inventing T. It lets
a backup taken before reserve retrieve the known ceded ledger and its terminal.
It returns known, not_found or recovery_hold under current source read/recovery
authority. It cannot reserve, abort or activate anything. A missing row remains
non-authoritative, and a restored history's absence is recovery_hold.

An intact restart preserves the recovery generation and terminals. Producer
generations can change; intact nonterminals can then be aborted by maintenance.
An official server restore installs a new persistent recovery generation BEFORE
publication and revokes all restored credentials. Known terminals remain readable
and immutable. Inherited nonterminals and absent/available old filiations remain
recovery_hold because a commit issued after backup may have been lost. A persistent
global restore marker enforces this even for old ledgers whose stored state was
available. Fresh created filiations in the new generation can still register.

No client-supplied receipt JSON reconstructs a lost terminal, and no new login
clears this uncertainty. This contract introduces no signature or replication
scheme. An explicit branch with new IDs and no inherited intentions is a new
conversation, not resumption of the old owner.

`planMaintenance` is an adapter-only entry point, never selected by request JSON.
Session invalidation, access change, producer change, account revocation and
operator cancellation can abort intact nonterminals. Restore uncertainty writes
a hold and never fabricates aborted. The adapter applies the plans with the
invalidation/restore marker in one durable transaction. Known terminals stay
unchanged, including after revocation.

Relay adapters must update the closed kind ownership checks in account lifecycle
and backup together. Global revocation preserves journals/ledgers and closes
admissible nonterminals. Account deletion may remove every record of that account
incarnation in its transaction; deletion is not an aborted receipt for offline
copies. A recreated account cannot access the old incarnation. Backups distinguish
their F guarantees from legacy bundles and preserve non-secret provenance and
terminals while invalidating sessions, rights and old producer keys. The intended
storage uses existing pilot_records and schema version 2, without a new table.

Official desktop restoration installs restore_hold before Ready, queue drain or
admission, including legacy archives and interrupted rollback. Credential
reassociation cannot clear it. Reconciliation of aborted alone cannot prove that
a restored copy exclusively replaces an old offline installation. Without native
exclusive replacement proof or normal cession from the live owner, keep readonly.
The protocol cannot remotely stop an old PC already admitting work offline.

## Bounds and accounting

These limits apply only to closed metadata, with no transcript length limit.

| Object | Admission cap in canonical JSON UTF-8 bytes | Complete schema upper bound |
| --- | ---: | ---: |
| Request | 16,384 | 2,832 |
| Attestation | 16,384 | 877 |
| Trusted context | 16,384 | 8,751 |
| Terminal | 8,192 | 2,073 |
| Ledger | 8,192 | 3,885 |
| Journal | 131,072 | 9,184 |

Conformance computes the maximum of every alternative from closed string widths,
object properties and array cardinalities. It also exercises maximum-width valid
profiles. It fails if schema changes exceed a cap. The caps leave room for the
fixed receipt slots without permitting arbitrary content or unbounded retries.

Before new ledger admission, reserve 8,192 logical metadata bytes. Before a new
journal or missing-reservation tombstone, reserve 131,072. Admission checks
used + reserved + new allocation with exact overflow-checked arithmetic against a
mandatory finite adapter capacity. Existing reserved space covers the terminal;
progression does not need a new allocation. Never evict old terminals or epoch
proofs to make room. Compact only while retaining terminal/binding and high epoch.

The capacity is a measured storage policy of the relay adapter; this closed
contract supplies no invented production default. Logical reservations differ
from heap, encrypted bytes and SQLite disk usage. Adapters measure AES-GCM,
base64url, IDs/index and SQLite overhead and label those separately. The existing
shared PilotContent/PilotFiles 32 MiB per-instance and 64 MiB process limits stay
unchanged. Temporary metadata and future transfer buffers must join that shared
accounting, charging both instances for their reserved participation and each
actual process copy once before allocation. No unaccounted side Map is allowed.
This module defines no transit block or E text grammar and raises no existing cap.

Errors use only the closed code, correlation and retryable flag. Unknown fields
and validator exceptions produce fixed diagnostics, without paths, property
names, JSON or provider errors. Only unavailable and instance_offline are retryable;
retry means the same operation after reconciliation, never automatic unfreeze.

## Adapter integration and verification

`planDecision` and `planMaintenance` return pure mutation plans, historical
receipts or read statuses. They do not lock, write or claim a durable commit. The
relay must load its authenticated snapshots and ledger/journal, check the actual
SQL key revisions, validate the plan, consume challenges, update accounting and
write both records within one SQLite transaction. Emit ACK only after durable
commit. Do not place an await between those checks and writes.

Import the exact integrated desktop files into the relay's existing
`vendor/contracts/macro-pilot/v2` mechanism, with source commit/tree/blob and byte
hash provenance and the existing AGPL attribution. Import this schema, registry,
helper, strict parser, declarations, normative document and conformance vectors
without editing the imported bytes. Any later contract correction starts in the
desktop and requires a new verified exact import. No provider grammar belongs
in the relay.

Contract tests cover both roots' refusal of these objects, exact counters and
UTF-8, closed shapes, correlation/auth snapshots, state/CAS/retry, terminal races,
missing reserve and delayed arrival, initial enrollment, server restore, recovery
reads under a different session, pin/application separation and resource bounds.
They prove neither native freeze nor real SQLite concurrency, durable pin,
backup maintenance or final activation. Those require the real desktop journals,
E implementation and PilotStore composition before enabling a transfer feature.
