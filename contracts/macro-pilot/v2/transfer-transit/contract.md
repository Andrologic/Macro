# Transfer transit contract 1

This separate closed contract defines wire metadata and bounded opaque content
transit for a future PC-to-PC composition. It authenticates nobody, starts no
poll, changes no quota, persists no bytes and enables no capability. Normal
supported_context_contracts stays empty. Native F freeze, source capture/policy,
durable inactive E staging, target validation/preparation/pin, unique committed
and activation remain required adapters. No secret, active agreement, permission,
provider session or queued intent is inherited.

The exact UTF-8 bytes and final LF of transfer-transit-contract.json identify
this contract by SHA256. Its sorted resources include every normative component,
the unchanged F dependencies and their browser derivative, strict JSON and the
exact E root identity. It excludes itself, tests and desktop development tools.
The E root is an exact external content dependency identity, not a second E
normalizer bundled by transit. Its referenced E resources remain owned and
validated by the endpoint E composition. An importer copies every listed relative path at the same layout, verifies its
hash and then the root bytes; a source-code SHA is not support. The generator
checks the original F imports/loader/hash boundary exactly, compiles its exact
schema once outside runtime, and keeps its factory and all semantic rules.
It changes only the Node loader and SHA256 implementation to the existing MIT
@noble/hashes. No second F schema or provider normalizer is defined here.
NOTICE.txt preserves the licenses for bundled Ajv runtime helpers and hashes.

## Byte framing and counts

Only encoding identity is supported. A capsule is closed JSON with
transit_contract=transfer-transit-1. data_utf 8 contains consecutive exact UTF-8
bytes of an E stream, including LF, expressed as a JSON string. No outer base64
or gzip. All strings reject isolated UTF-16 surrogates before UTF-8; byte inputs
use fatal decoding and preserve a BOM so invalid JSON refuses rather than being
silently changed. JSON.parse owns syntax; the shared strict helper rejects
same decoded keys before shape validation. There is no Unicode normalization,
trimming, number conversion or parsing of provider text in transit.

A block has at most 65536 raw UTF-8 bytes. Its JSON string including quotes is at
most 94208 bytes. Every complete new body, including producer.delivery and its
nested chunk, has at most 98304 bytes. All controls and wrappers accompanying a
chunk, excluding only the JSON string value, have at most 4096 bytes. A single
prefix counter stops at both limits, between Unicode scalars, before slicing or
serializing. It counts JSON.stringify compact escape costs, without a second
JSON parser. Input to that counter is an already admitted current producer
buffer, not an unadmitted record or entire archive. It stops at the chosen prefix
and does not rescan the unconsumed tail. Reaching a limit starts the next block;
it never excludes required history or imposes a total-history cap.

Blocks may contain many E lines or end within an E line. They do not identify
records or fragments. The existing E owner subsequently assembles one line up
to 8192 bytes and validates E fragments up to 4093 bytes under its own admission.
The relay does not inspect E/provider grammar or decode E's inner base64.

Session counters portable_records, portable_fragments and portable_payload_bytes
name respectively E headers, actual input E fragment lines and summed record
payload bytes. stream_bytes includes every E descriptor/header/encoded payload
and LF byte. It is not portable_payload_bytes or a native Begin total. Native
append/readback may repartition and count fragments separately. The portable,
native source and local native storage manifests remain three distinct facts.

sequence, offset, length, next_sequence, next_offset and every session counter
are exact canonical decimal i64 strings in 0..9223372036854775807. Positive fields
exclude zero. Every addition/increment is checked; no counter travels through
Number. Blocks are nonempty, start at sequence 0/offset 0 and advance by exact
length. SHA256 covers raw data_utf 8 UTF-8 bytes, including LF when present. EOF
must be true exactly when offset+length=stream_bytes. The nonempty E descriptor
ensures an empty transfer is unnecessary. EOF is not seal/ready/admission.

## Closed messages

schema.json and types.generated.d.mts define all fields. validate.mjs supplies
relational semantics after the generated shape. Unknown keys/forms refuse.
request_id uses the existing bounded F ASCII ID type, preserving opaque v2 poll
request IDs; it is distinct from F operation_id and UUID delivery/challenge IDs.

| Message | Meaning and required independent correlation |
| --- | --- |
| decision.request | Canonical F request, never a decision context/plan or self-supplied authority. |
| decision.challenge / decision.exchange | Canonical request+kind and the resulting exact F exchange. Challenge kinds must match the requested operation. |
| decision.reply | Public closed retry/terminal receipt+status, status, source_status, or F error only. No ledger/record/arbitrary DecisionPlan. |
| proof.received | Exact exchange accepted durably and idempotently by the native owner. Transport acceptance only, never an attestation. |
| proof.result | Canonical F attestation delivered later on the same exchange and authenticated producer connection. |
| producer.delivery | Same poll request_id plus delivery_id, producer instance/generation/connection; body is proof.challenge, transit.pull or transit.chunk. |
| transit.open / transit.opened | Exact session tied to T, transit_id, binding/frozen/manifest digests, exact E identity and separately counted lengths. opened also quotes the durable cursor. |
| transit.pull | Expected sequence/offset for the same session. Pull is target initiated; the selected source produces content. |
| transit.chunk | Exact bytes/hash/offset/sequence/EOF for that session. |
| transit.ack | Exact descriptor of the durably staged prefix and next_offset. It is not E validation, a pin or ready. |
| transit.status / transit.progress | Read the existing durable cursor; no second ownership state. |
| transit.close | Close transport only, never abort, commit, unpin or unfreeze F. |
| accepted / error | Request correlation and fixed canonical error codes only. No private diagnostic or arbitrary text. |

A committed mutation is presented on the wire as F's existing retry receipt plus
a status read from that same durable journal. validateDecisionReply invokes the
unchanged F validateExchange against the sent request and independently held
native expectation. A reply cannot supply that expectation. The adapter must
obtain receipt/status consistently after durable commit; this module does not
convert a mutable plan into an ACK. Errors retain their canonical F operation_id
and fixed retryability. A terminal winner is not relabeled as a successful retry.

A proof delivery's envelope matches exchange delivery/instance/generation and
connection IDs and its request fingerprint/kind. The native owner must also
compare the exchange subject/binding/prior receipts with its current journal,
current authority and requested operation before accepting durable work. An
exchange is a challenge, not proof. Proof results use F's unchanged selected
producer/connection reception rules. Native proofs are never incoming booleans.

## One existing poll

The request remains POST /pilot/v2/instances/:instance/deliveries/poll with the
EXACT existing v2 poll body and ordinary capabilities. No new register/poll DTO,
second poll, OAuth, producer election or authority registry is added. Generation
and connectionId are created server-side by the existing first poll. The new
envelope may quote them; first-use null expectations mean those citations are
not independently known yet, never that they are native authority.

An offer is exactly one X-Macro-Transfer-Transit: transfer-transit-1 header.
Confirmation with that exact header is allowed only on a response carrying the
new F envelope, for this poll and the same current selected Producer. It is a
version offer, not authorization. Missing/multiple/comma-joined/unknown headers
cannot authorize F. A stale connection, restart or silent older relay cannot
carry the opt-in into a later response. No persistent negotiated boolean exists.

Before reading/parsing, select the new strict 98304-byte path only for an exactly
confirmed offered response. Without confirmation, delegate loading, admission,
parsing and validation to the existing v2 owner. That owner must reject F as an
unknown grammar. A confirmed response cannot fall back to v2 after error.
withProducerDelivery requires both host ports withContent and validateContent;
the latter is the exact existing canonical relay validator or frontend generated
contentProtocol validator, never a permissive predicate or copied schema. These
ports are private code dependencies, not values received from the network.
The content callback must complete successfully once; a port that catches its
callback exception and returns a validation result cannot turn that refusal
into a successful union decode. No v2 parsing logic is copied here.

A v2 delivery keeps its historical X-Request-Id equal to its delivery request_id.
A new producer.delivery uses the poll's request_id, with delivery_id separate.
A 204 response has no confirmation and correlates to the poll request ID; it
continues the existing empty poll behavior without reading a body. Content,
files and ordinary conversation deliveries remain available between F deliveries.
Future real HTTP/Tauri transports must explicitly admit the offer/confirmation
header and any CORS allow/expose lists they require. These pure ports do not
prove that routing/header acceptance is implemented.
The union must be discriminated before ContentDelivery cast or host.handle.

Long normalization/pin work must not block the unique poll until completion.
The native owner accepts the exact F exchange durably/idempotently, replies
proof.received, and lets the poll continue. The relay can stop delivering that
same challenge while awaiting proof.result on the separate route. The existing
F proof exchange/journal are the identity, not a new generic job engine. A
received ACK never makes a challenge attested. After cancellation/restart, native
pending/unknown work reconciles from its journal and current generation; a
self-supplied received message cannot resume it. Slow staging requires the same
ownership discipline; its final ACK still requires durable raw staging commit.
No timing guarantee or ready TTL is inferred from the transport acknowledgment.

## Routes before body

Routes below are closed candidate selectors, not authority. Parse exact path
segments with no query/fragment/trailing slash/percent normalization. True relay
origin, account incarnation, bearer/session, access and selected producer guards
come from config/store/journal. Authenticate and admit only the real participants
before reading any body, then compare the decoded quotes before mutation.

All use POST under /pilot/v2/transfers/:

| Route suffix | Candidates resolvable before body |
| --- | --- |
| sources/:source_instance/:conversation/decisions or challenges | Birth/source_status S includes conversation. Native attestation, never the path, proves conversation existence. |
| sources/:source_instance/:conversation/targets/:target/reservations/:T/decisions or challenges | Both participants even before reserve creates T; compare full binding after decode. Also covers exact missing-reservation reconciliation with full binding. |
| known/:T/decisions or challenges or transit | Existing F journal supplies S/target. Missing journal does not authorize reading an arbitrary body to find them. |
| transits/:transit_id/pull or chunk or ack or status or close | Ephemeral already admitted transport slot resolves the real existing T/journal and both participants. |
| instances/:instance/received or attestations | Current producer instance/key, then exact durable exchange/request correlation. |

The existing poll route is unchanged and outside this parser. Transit_id is
only an ephemeral correlation to the existing F T. It never survives generation
change as an independent authority. Source-only birth does not charge unrelated
selected PCs. Initial reserve cannot use known/:T before that journal exists.
Initiators receive only metadata. Content is delivered only to the authenticated
source/target roles, never a generic consumer result downloaded by the initiator.
The final chunk may be delivered through the target's unique poll as an envelope;
this is the single content-delivery option in this version, not an alternative
raw response format on transit.pull.

## Cursor, retry and durability

Window 1 permits one unacknowledged block. A cursor contains next_sequence,
next_offset, eof and only the last block descriptor. The pure inspectChunk
function returns append/retry validation; it does not store, ACK or authorize
anything. Gap/overlap/hash/length/EOF/session/overflow errors refuse before
adapter mutation. withChunk combines the admitted byte decoder with that
independent session/cursor check before its consuming callback. A generic
withDecoded callback must run its relevant F/transit correlation checks before
any mutation; a shape-only success is not context validation. Exact retry of the last descriptor and bytes returns the same
cursor. Prior arbitrary blocks are not retained in a Map or accepted as retries.
Each new request/ACK response also compares its request_id independently.

The native target transaction must persist bytes+cursor+hash before producing
transit.ack. ACK loss reads that exact durable prefix. The source cursor belongs
to native F and references its frozen source capture and manifest, not relay
memory. Preflight runs existing E two-pass normalization once; one emission
traversal then fills backpressured blocks. No full normalization per block and no
transport copy of all E headers/hashes. A restart may require one deterministic
O(prefix) traversal from the same immutable source, never silent rebind. EOF
length and hashes still require full E validation of the target staging.

Raw staging remains private/inactive and billed under the common E domain.
Target validates E fully, imports with the distinct native storage manifest,
reads back/prepares/maps and durably pins before true target_pinned and ready.
Ready has no destructive TTL. Unique committed precedes activation. Relay memory
retention/close never releases freeze/pin or rewrites terminal authority. Producer
rollover, current policy change, restore, revoked rights or unknown native work
require F reconciliation and fresh guards, not a retry that changes content.

## Admission and physical ownership

Every new raw body, including a rejected graph of tiny nodes, reserves the
conservative 256×98304 tariff before load/parse. withDecoded acquires 25165824
logical graph units +1048576 working +2097152 copies/cursor =28311552,27 Mio.
The per-instance 32 Mio and process 64 Mio remain unchanged. This arithmetic leaves
5 Mio before existing usage; it does not guarantee admission on an occupied host.
Both selected PCs are charged fully, the process's actual copy once. Admission
must remain atomic across overlapping work and existing files/content requests.

The 2 Mio copy allowance declares 16 slots of 96 Kio,4 slots of 64 Kio and 256 Kio
control/index. Real adapters must inventory the actual live copies and prove
this allowance before use, otherwise refuse before allocation. It is a logical
allowance, not measured physical heap/RSS. A second simultaneous graph cannot
share its charge. Ownership transfer of the same body is distinguished from a
new copy. ACK/small controls and late cleanup obtain their own remaining budget.
Reservations survive until the final HTTP/socket/worker copy ends, including
finish/close/cancellation. No Future/Map deletion alone proves physical release.

All views in a withDecoded callback remain charged until its awaited completion.
A retaining consumer must acquire its own owner charge before retaining; the
helper cannot prevent a caller from keeping references. Source/current policy,
capture generation/schema/versions and target policy must still be checked at
the real emission/consumption boundaries. Private policy is never imported trust.
Host E admission/disk/preparation comes from real runtime configuration, not the
fixture budgets. Existing E materialization O(N), some reader scans O(N²), and
provider preparation are unchanged and remain composition risks.

## Verification and activation boundary

Run the scripts under contracts/macro-pilot/test with Node or Bun. Browser tests
also run with Node --disallow-code-generation-from-strings. Freshness is checked
by node dev/generate-transfer-transit.mjs --check. The bounds script derives
maxima from the real closed schemas; generated runtime has no Ajv compiler, Node
builtins, eval or Function construction. All generated sub-validator diagnostics
are cleared in finally after success, refusal and exception. The diagnosticsEmpty
probe reports only absence of retained diagnostics, never authority.

Synthetic vectors cover every new DTO, exact bytes/LF/UTF-8/hash, malformed and
ambiguous JSON, scopes, i64, retry, gaps, EOF and headers/poll fallback. Real v2
and F owners are confronted without rewriting their rules. Fixtures and pure
cursor tests prove no network, filesystem durability, native proof or physical
quota release. Four Codex/Macro AI pairs and compaction context remain E's
existing audited content support, to replay through actual transit/native
composition later. No capability is advertised by this contract alone.
