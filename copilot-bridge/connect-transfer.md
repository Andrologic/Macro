# Private Bun portable-history work

`entry.ts connect-transfer` selects the E worker before importing the historical
Copilot bridge. It accepts no extra arguments. One process handles one work and
exits after retirement. The native composition must spawn it only for active
work, keep at most one heavy E child, and join the child and pipes before returning
work credit. The persistent `connect-codec` operations and fd implementation are
unchanged. Neither mode publishes a public F capability.

This worker calls the existing two-pass portable normalizer, canonical archive
validator, archive readback/projection owner, secretForms and shared Chat and
stream-launch preparers. It never sends a provider request. The only message DTO
mapping is the same `projectNativeMessages` function used by nativeTurnTransport.
Provider JSON serialization remains in the existing native builders.

## Closed protocol

The fd header is the existing MCF1 big-endian 32-byte header. Controls are at most
4096 bytes; pages are at most 65536 bytes. One request is outstanding. Every
header is checked before its payload fd read. All validators reject unknown
keys. Decimal handles preserve all u64 digits; working counters must fit safe JS
integers before conversion. E has no codec 98K aggregate or transcript limit.

HELLO has exactly `version: macro-connect-transfer-1`,
`portable_contract_sha256`, and `preparation_set_sha256`. The generated manifest
commits the actual runtime source graph and local dependency manifests. The
parent compares independent expected identities before START. Descriptors are
checked against the canonical content identity, never their own supplied hash.
The current content and portable contract hashes are checked separately by tests.

START is `{op:0,kind,handles,child_units,detection_units,native_units}`. Its closed
handles are source/policy/sink for normalize, staging/policy/sink for import,
archive/policy/target/draft for prepare, archive/policy/selector/sink for recover.
Handles are job-local native capabilities; JS cannot supply policy authority,
a path, URL, SQL query, command or arbitrary function.

GRANT is exactly 32 bytes: units u64, call u64, arena u64, limit u32, kind u8,
direction u8, two zero bytes. Kind 3 admits the preowned child/detection arena;
kind 1 admits one control response; kind 2 admits one data direction. The arena
and increasing lease IDs must match. Control grants require the exact
CONTROL_RESERVE and data grants require two 64K page slots. The local child and
detection budgets remain distinct sub-reservations of the native work lease.

| Op | Request and purpose |
| --- | --- |
| 1 | source-descriptor: root/field/relation/detection/target, closed cursor |
| 2 | read-field: handle, ordinal, offset, max_bytes up to 65536 |
| 3 | planE: begin descriptor, one canonical header, end validation counts |
| 4 | appendE: canonical header, offset, bytes up to 4093, SHA256, credited raw bytes |
| 5 | readE: inclusive cursor and limit 1..32, announced fragment/data pairs and end cursor |
| 6 | projection: begin, item, encoded, end, closed projection kind and counts |
| 7 | finish: normalized/imported/prepared_ts/recovered calculation data |

The exact unions and validators are in `src/connect-transfer-protocol.ts`. Large
target parameters use FieldSlice descriptors and read-field. The real maximal
fixed target/root control currently measures 1749 UTF-8 bytes with MAX_SAFE
counters and 20-digit handles. The normalized finish result contains
`{records, bytes, manifest, policy_handle}`. `policy_handle` must equal the
policy handle in START; both the child and parent validate this equality.
The original revision remains unbounded by the control size: read-field streams
it from the policy FieldSlice, and the real E metadata retains it. The handle is
only job correlation. The native parent retains its own policy authority and
checks freshness at each boundary. A real child test normalizes and reads back
an archive with a 4097-character revision and a bounded terminal control.

An item is measured under its existing input owner, reserved before stringify
and encodeInto, then sent alone over credited pages. The encoded stage belongs
to the same call and has exact length/SHA256. No whole transcript is stringified.
The diagnostic message and citation arrays are also sent item by item.

Responses are `{op,call,status,result}` on success or `{op,call,status}` on
failure. Call codes 1..8 mean resource, integrity, policy, indispensable context,
unavailable, compaction required, cancellation, unknown form. SCOPE_FINISHED
contains call u64 and status u32 under the current control lease. The separate
JOB_FINISHED statuses are 0 complete, 1 recoverable refusal, 2 cancelled. A
framing, identity or credit fault sends fixed REJECT and retires with nonzero
exit; it cannot create a reusable successful terminal. CANCEL has no payload,
uses the current job and zero lease/sequence. STOP is accepted at startup with
zero identities. There is no idle E job loop.

A page ACK releases the pipe page only. It never releases the assembled field,
retained projection, work lease, SQLite transaction or transit credit. A blocked
write keeps its borrow until the write settles, including when CANCEL arrives.
The native owner needs deadlines and kill/join for a nonresponsive peer.

## Real owner boundaries

Normalize completes pass 1 before beforeEmission can plan the export. Policy is
checked on both sides of that await. A failed pass 1 appends nothing. A changed
second pass aborts the inactive attempt. Source rows are grouped one at a time.
Whole fields retain the existing E admissions, even though fd chunks are small.

Import reads the actual canonical descriptor and records, inspects under the
captured detector snapshot, and builds the native preflight plan. A stale first
descriptor refuses before the first plan call. After complete pass 1 the parent
must perform the real inactive-storage begin or return unavailable. Pass 2 uses
the real canonical validator again and can only accept a real native AppendAck.
The synthetic tests refuse at the missing native begin. They create no SQLite
receipt, pin, activation or transit ACK.

Archive readback uses the existing E binding, UUID mapping and inclusive cursor.
The adapter requests one fragment per page to avoid reading neighboring records
for a single-record consumer. Native exclusive-cursor conversion, revision and
UUID binding remain the native owner's responsibility. `PortableHistoryArchive`
validates and owns the complete metadata index, individual readback and O(N)
projection. Archived tool calls/results remain historical user data. Their
original exact records stay recoverable, including before compaction.

Reference preparation is explicitly Global Chat with no project, task, group or
folder. It adds one identified synthetic local user instruction without
persisting it. Tools, MCP, web search and skills are empty for this reference;
this imposes no restriction on a later ordinary send. Any indispensable
unavailable dependency refuses. Effects belong to an ephemeral draft: feedback,
status, event, checkpoint and provider-items copies are retained and transmitted,
not written to a store or settings. All unexpected external ports throw.

Captured context metadata is used locally. Existing-only compaction can reuse a
valid local checkpoint and the ordinary deterministic pruning. If a fresh
provider summary is necessary it refuses before summary/fallback creation.
Ordinary callers preserve their existing default behavior. The reference is not
a guarantee for an arbitrary future user message.

The `prepared_ts` result contains only archive/storage/mapping/target identities.
It is not native-prepared. The native composition must call the real Codex or
Macro AI builder with the captured local configuration, inspect that final body
and perform the required policy checks. Missing native owners remain unavailable.

## Admissions and qualification

PortableWorkBudget consumes synchronously from the preacquired child lease.
The detector expansion lease is separate. secretForms uses the proposed
65536+4096*(input UTF-8 bytes+count) reservation before reading or expansion;
its existing final form counter is not the admission proof. The preparation
scope reserves 65536+16*C+8*J+4096*M before invoking the real preparers. C counts
256 units per node occurrence plus twice the UTF-16 key/value characters; J is
exact compact-JSON UTF-16 length. Output JSON/bytes and the SHA clone have
additional reservations retained through the consumer await. This is declared
logical working accounting, not a heap or RSS measurement.

Tests use a real source Bun child, named pipes and a parent PortableWorkBudget.
The parent acquires fixtures/oracles before constructing them, owns work credit
before GRANT, and owns parsed output after page ACK. Code/module constants are
not a measured heap. The large case fixes a synthetic parent work budget before
execution, rather than copying an earlier 1GiB fixture budget. A 128MiB archive
arena refuses 265388800 metadata units for 300 messages plus a 4.9MB field. The
full source normalizes; this refusal does not establish recovery/preparation of
that large case under the future native default budget.

Run `bun dev/generate-connect-transfer-identities.mjs --check`,
`bun run typecheck:copilot`, and
`bun test copilot-bridge/src/connect-transfer.test.ts`.
Generate identities with the same script without --check after changing a
committed owner. Do not edit sources or regenerate identities while a multi-child
source test is running: its parent pins the initial set and rejects later children
with a different HELLO.

Named-pipe child tests currently run on POSIX and skip on Windows; pure protocol
checks remain portable. No host binary or cross-platform binary is qualified here.

These tests establish TS computation, fd borrowing, local admissions and refusal
behavior. They do not establish native HTTP/SQLite ownership, policy freshness,
WorkLease acquisition, native process singleton or final F admission.
