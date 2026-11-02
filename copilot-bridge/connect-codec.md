# Private persistent Connect codec

`entry.ts` dispatches `connect-codec` to operations 1–9 and
`connect-bootstrap` to A1 operation 10. Both use the same binary stdin/stdout
MCF1 engine. The native owner chooses the profile. It rejects extra arguments and unknown `connect-*` modes before importing
Copilot. All historical arguments still import `index.ts`, including its
`unknown_command` response. The existing runtime build now targets `entry.ts`.
This adds no IPC command, HTTP client, provider call or public F capability.

The codec uses the existing authority/transit validators and their embedded
decision validator. It never calls `planDecision`. Its output establishes grammar
and correlation only. The native owner must supply independently authenticated
facts, perform fresh policy checks and own the common quota, process and pipes.

## Wire contract

All integers use big-endian byte order. Each header has 32 bytes: magic `MCF1`,
version u16 `1`, type u8, flags u8 `0`, job u64, lease u64, payload length u32,
sequence u32. IDs remain `bigint`. Jobs and grants increase strictly throughout
the process. Job zero is reserved for HELLO and STOP. Control sequences are zero;
page sequences start at zero in each direction and cannot wrap.

| Type | Direction | Payload |
| --- | --- | --- |
| 1 HELLO | Child to parent | Closed identity JSON, at most 4KiB |
| 2 BEGIN | Parent to child | Opcode u16, phase u8, reserved zero u8, total u32 |
| 3 GRANT | Parent to child | Units u64, class u32, raw limit u32 |
| 4 PAGE | Parent to child | Positive page, at most 65,536 bytes |
| 5 PAGE_CONSUMED | Child to parent | Empty, current raw lease and page sequence |
| 6 SCOPE_FINISHED | Child to parent | Mask u32, 1 expectations or 2 body, raw lease |
| 7 RESULT_PAGE | Child to parent | At most 65,536 bytes, control lease |
| 8 RESULT_CONSUMED | Parent to child | Empty, control lease and page sequence |
| 9 JOB_FINISHED | Child to parent | Status u32, control lease |
| 10 CANCEL | Parent to child | Empty, current job, lease zero |
| 11 STOP / 12 STOPPED | Parent / child | Empty, job and lease zero |
| 13 REJECT | Child to parent | Fixed code u32, terminal |

BEGIN carries lease zero. GRANT class 1 is raw, class 2 is control. Each amount
and raw limit must equal the opcode descriptor. Statuses are 0 validated,
1 canonical/admission rejection, 2 cancelled, 3 delegation to the v2 owner.
REJECT codes are 1 framing, 2 credit, 3 limit, 4 state, 5 identity. The child
publishes identities; the parent rejects an identity mismatch before BEGIN.
Every non-page payload is at most 4KiB and has the exact length above.

HELLO contains exactly `version`, `profile`, `source_set_sha256`, `content_sha256`,
`decision_resource_set_sha256`, `transit_resource_set_sha256` and
`authority_resource_set_sha256`. Only the bootstrap profile also includes
`a1_resource_set_sha256`. The canonical
digests come from canonical identities. Manifest digests hash the compact
JSON of each manifest's `resources`.
No resource paths or public capability announcement are transmitted.

There is one job, no queue and one page in flight per direction. Phase 1 accepts
at most 98,304 bytes of closed independent expectations. Only after its
SCOPE_FINISHED may the parent grant phase 2. Result JSON totals at most 98,304
bytes. Each result page needs both a completed fd write and RESULT_CONSUMED.
JOB_FINISHED follows the last ACK. The next BEGIN follows that terminal.

STOP is accepted only between jobs. CANCEL requires the granted control bank.
It retires the process after raw scopes and JOB_FINISHED status 2. A CANCEL
before any control grant is a terminal credit violation. Synchronous canonical
work cannot be interrupted. A cancelled blocked write keeps its borrow until
the write settles; the parent must drain it or kill and join the process.

## Closed expectations

Unknown private fields refuse. Each aggregate has compact UTF-8 JSON at most
98,304 bytes and cost `C = 256*N + 2*U` at most 196,608 units. N counts every
container and primitive occurrence. U counts UTF-16 string and key occurrences.
Aliases count again. Depth is at most 32. Accessors, cycles, active prototypes,
invalid Unicode and non-finite numbers refuse. This accounting does not parse
or normalize network messages. UTF-8 decoding and duplicate-key rejection use
fatal TextDecoder and the existing `parseStoredJsonStrict`.

| Opcode | Independent expectation fields | Canonical body path |
| --- | --- | --- |
| 1 authority.request | `request_id_header` | `withRequest` |
| 2 authority.response | `request`, `expected`, `time` | `withResponse` |
| 3 transit.request | `path`, `request_id`, `proof` | `withDecoded`, `parseRoute`, `validateRoute`, contextual received/attestation checks |
| 4 transit.metadata_reply | `kind`, `sent`, plus the matching independent facts | `withDecoded`, `validateDecisionReply` / `validateChallengeReply` / accepted correlation |
| 5 transit.poll | `context` | `withProducerDelivery` |
| 6 transit.chunk | `session`, `cursor` | `withChunk` |
| 7 transit.ack | `session`, complete `chunk`, `request_id` | `withDecoded`, `validateAck` |
| 8 transit.progress | `session`, `request_id` | `withDecoded`, `validateProgress` |
| 9 transit.session | `session`, `request_id` | `withDecoded`, `validateSession` |
| 10 private.me | Exact GET `/pilot/v1/me`, both request IDs, expected/connection origin, independently selected session, optional account/device, native time | Strict JSON and shared `validateA1` |

For opcode 2, `expected` has both request ID headers, expected/connection origins
and account ID. `time` has `now_ms` and `dispatch_age_ms`. Monotone elapsed time
since phase 1 BEGIN is added at validation, including pagination waits. The
parent still checks freshness after receiving the result.

For opcode 3, proof is null or `{kind,exchange}` for `received`, or
`{kind,exchange,producer,connection}` for `attestation`. For opcode 4 the same
kinds hold these facts beside `sent`; decision uses `expectation` instead.
Challenge holds `exchange` without the newly allocated delivery/challenge IDs.
Only those two IDs come from the received reply. A validated protocol `error`
is a protocol result, not success of the requested effect.

Opcode 5 requires the full canonical delivery context with non-null generation
and connection. An unconfirmed 200 returns status 3 before loading a body.
A 204 uses the canonical empty branch. Both have phase 2 total zero. Unexpected
legacy content ports throw; no v2 content is claimed validated here.

## Admission and live copies

The parent acquires real units before each grant. Phase 1 always costs
28,311,552 raw units. Authority bodies use the exact canonical admission with
external charges zero: 1,146,880 for request and 2,293,760 for response.
Other phase 2 operations use 28,311,552. The granted adapter accepts precisely
one canonical reserve and records its one release request. It never returns
quota to the parent by itself. A no-body poll makes no canonical reserve.

The separate control bank is fixed at 2,097,152 units: eight graph slots of
196,608, two encoded slots of 98,304, four pages of 65,536, and 65,536 for
controls/indexes. `ControlBank` acquires the actual simultaneous slots before
calling validators and rejects overcommit. The canonical raw tariff still owns
its decoded body, raw string, body-side rendering/encoding and cursor copies.
The table inventories the additional operations on retained independent facts.

| Opcode | Extra graph slots before call | Additional live work |
| --- | ---: | --- |
| 1 | 0 | Expected UUID is compared directly |
| 2 | 3 | Expected request validation/render, retained comparison string, expected scope rendering; one encoded slot |
| 3 | 3 | Route/proof wrapper, expected exchange rendering and retained comparison/fingerprint string; one encoded slot |
| 4 | 5 | Sent render, independent expectation clone, retained comparison string, current render/parts, request-derived wrapper; one encoded slot |
| 5 | 0 | Independent delivery IDs compared directly; body render and copies stay in canonical tariff |
| 6 | 3 | Session/cursor validation and render; one of the three slots holds the returned cursor plan through canonical return |
| 7 | `ceil((8*J+256*N)/196608)+2` | Full expected chunk render, retained render string, metadata clone with emptied data; one encoded slot and one hash-input page |
| 8 | 3 | Expected session render, retained comparison and wrapper work |
| 9 | 3 | Expected session render, retained comparison and wrapper work |

For opcode 7, J is the compact JSON UTF-16 length of the independently held
chunk, and N its occurrences. `canonicalJson` recursively holds disjoint render
parts, a join, the enclosing returned string and the current child/key render.
Four UTF-16 render volumes cost at most `8*J`, plus the per-node structures.
`same` can retain the completed left render during the right render. The extra
two slots cover that retained string and `structuredClone(chunk)` during
metadata-size validation. The encoded slot holds canonical UTF-8 metadata;
the page holds the at-most-65,536-byte hash input. Chunk metadata is at most
4KiB; chunk data JSON is at most 94,208 bytes. These bounds give render at most
five slots, seven extra slots including retained string/clone, and eight with
the expectation. The raw-byte maximum uses five extra slots; the escaped-data
maximum uses six. Neither input is substituted for the other in the tests.

For the fixed paths, schema bounds fit the claimed simultaneous slots.
A conservative expectation bound is N=75, U=9,343 and J=26,322, allowing
escaping and UTF-16 pairs even where identifier alphabets forbid them. Its
render bound is 229,776 units, two slots; its clone costs 37,886, one slot.
A retained comparison string costs at most 52,644, one more slot. The fifth
slot covers the request-derived wrapper. Sent decision/challenge render bounds
are 120,640/121,128 and do not overlap expectation rendering. Exchange,
producer, session and cursor render bounds are 42,192, 22,400, 23,928 and
11,152. Authority request render bounds are 17,328. These conservative bounds
use all schema properties and the largest alternative for each metric.
Validation is sequential. `receptionExpectation` makes one
clone, updates its manifest/prepared references, then performs comparisons and
fingerprints sequentially. There is no journal mutation or second admission.
The reply metadata paths include birth, reserve, seal, ready, commit,
activation, source status and status. Contextual proof paths include challenge,
received and attestation. The same sent object is held once in the private
wrapper. Every occurrence still contributes to rendering cost.

One slot owns the closed expectation throughout validation. Validator slots
are returned before the callback copies the closed result, except the chunk
cursor plan slot, which lasts through `withChunk` return. Thus that callback
has expectation + plan + result, at most three slots. After raw scope exit,
encoding has expectation + result + JSON string, also three. A synchronous
encoding scope returns only the encoded bytes; graph and string references
leave that scope before output waits. The encoded result slot lasts through
all write completions and ACKs. The Child's claims are empty before JOB_FINISHED.
The native result can still own BANK after that frame.

The native admission reserves BANK before assigning either encoded slot. Slot A
holds native expectations until their completed phase1 scope; BEGIN phase2 is
sent only after that backing is destroyed. Child validator bytes and encoded
result then use A successively. Slot B holds the native body until its completed
phase2 scope, then the native result reservoir. The Child may encode its result
before the parent reads SCOPE_FINISHED: A remains separate from the body in B.
The parent destroys B's body before allocating B's result, including for an
empty body. No third encoded slot is available to the Child.

`CodecHandle::admit` returns recoverable `codec_busy` while an admitted job or
its last Output owns BANK. The complete reservation stays with the last owner;
there is no refund/reacquisition between backings. A result shared with Hyper
keeps that reservation through the last backing reference. Failed work keeps
the codec's BANK reference until joined retirement, or quarantine. Native
bootstrap consumes finished facts before waiting for the codec; retained
session/authority facts keep their separate 196,608-unit reservation.

All eight graph slots remain available to the Child, including opcode 7's
maximum. This change does not finance another lane's retained expectations or
response. Selected journal reads and admission of concurrent HTTP reservoirs
remain separate composition prerequisites. The lane/startup buffer coverage
also remains unqualified; logical transit accounting is not a heap/RSS bound.

The fd reader has a preallocated 32-byte header and 65,536-byte scratch. Its
single outstanding `node:fs.read` specifies the caller buffer, offset and
remaining length. It creates no stream, readline queue or emitter-selected
chunk. It validates magic, version, direction, IDs, sequence, size, state and
credit before issuing payload reads. It allocates the phase buffer only after
a matching raw grant. Pages are copied then zeroed before PAGE_CONSUMED.
Hostile headers and EOF close without draining an unadmitted payload.

Startup buffers and actual kernel pipes belong to the parent's pre-spawn
reservation and last through process/pipe join. They must not be inferred from
JS GC or counted twice as distinct physical copies. The fixed bank's unused
page/encoding capacity remains reserved headroom.

## Reproducible qualification

Run the focused tests with installed dependencies:

```sh
bun dev/run-tests.mjs --concurrency=2 --only copilot-bridge/src/connect-codec.test.ts --only copilot-bridge/src/entry.test.ts
bun run typecheck:copilot
```

The POSIX synthetic parent owns a bounded 32MiB counter, startup/pipes and
input graph/serialization charges before spawn or fixture construction. It
admits encoded inputs before serialization and output storage before body
processing. Raw scopes never overlap. Each raw charge lasts until
SCOPE_FINISHED and local writes/copies finish; the bank lasts until terminal
consumption. Cleanup joins the child and closes fds before returning remaining
charges. The scenario `runs all nine canonical operations and maximum metadata
paths in the same PID with real credits` in `src/connect-codec.test.ts` emits
`codec_maximum_vectors.parentPeak` and checks it against 32 MiB. Read the value
from the log of the exact candidate under test; it is not an HTTP/TLS margin.

The vectors use 128-character IDs, near-limit origins, 19-digit decimals,
65,536-byte chunk data and a separate 94,208-byte escaped-data JSON case.
Tests cover all nine operations in one PID, independent mismatches, hostile
lengths/EOF, fragmented headers, replayed grants/jobs, delayed ACK, cancellation
while reading and while output is blocked, diagnostics cleanup, closed value
limits, expired authority, and v2 delegation. An import guard rejects SDK,
credentials, IPC, stores and transport imports in the real codec child.
A bundled SDK sentinel proves deferred evaluation. Historical Copilot tests
remain provider-free.

These are logical ownership units, not an RSS or garbage-collection claim.
The POSIX FIFO tests do not qualify Windows pipes. An authorized host-only
compiled binary can qualify its routing separately using the installed Bun
executable via `--compile-executable-path`, without cross-compilation or
runtime downloads. Native HTTP/TLS buffers, authenticated expectations, common
atomic quota admission, v2 delegation and process retirement remain the native
owner's work. This codec alone does not establish operational F under 32MiB.

## Private authenticated bootstrap

Opcode 10 accepts only the closed `/me` envelope and returns account, session,
device, revision and optional expiry facts. The selected secret scope must match
the authenticated session, even when a different valid token belongs to the same
account. Producer rights still come from canonical authority preflight; controller
rights retain their separate `respond` requirement. Intent from configuration is
not authenticated identity. No product poll or public F path calls this facade.

The 98,304-byte capacity is a transport admission limit, not an A1 schema limit.
A1 permits arbitrarily long valid fractional timestamps. HTTP exceeding capacity
returns recoverable `resource_limit` before UTF-8 or JSON, retires IO without
draining and never creates verified facts. Within capacity, the complete 27 MiB
graph reservation precedes decoding under the exclusive TLS/codec turn.

The shared validators are generated by `dev/generate-macro-pilot-validators.ts`,
with the historical runtime compiler retained only as a development oracle.
The private boundary clears all 126 generated diagnostic slots in `finally`.
Ordinary validator callers retain the same signatures and semantic A1 rules.
The bootstrap generated module has a separate 1,835,008-unit reservation acquired
before spawning its Child and retained through that Child’s retirement. The identity inventories
source UTF-16 units, schema occurrences, strings and diagnostics. These logical
charges do not establish JSC bytecode, JIT, allocator or RSS bounds. Startup remains
524,288 units, the control bank 2 MiB, and the instance/process quotas 32/64 MiB.
Opcodes 1 and 2 retain their specialized admission.

Native HTTP preparation owns TCP/TLS before the real manager acquires its policy
and store scope. Emission ends only after the final request frame and successful
outer IO flush. Reception owns bounded opaque bytes and no policy/store lock.
Cancellation or revocation destroys the lane before releasing its reservations.
The bootstrap retires each connection before codec validation and does not retry
ambiguous POSTs. Tests cover synthetic TLS separately from the real relay HTTP
recipe; they do not establish exhaustive TLS allocation bounds.

Public activation still requires the complete poll/v2 copy inventory, scheduling,
SQL, builders and pin composition. The private bootstrap is not that composition.


## Private native HTTP ownership

The native HTTP wrappers delegate vectored writes to the real TCP/TLS stream.
Hyper can retain the admitted body backing in its queue instead of flattening it
into its header buffer. Shared backing remains charged until its last reference;
this does not eliminate Rustls encryption buffers or establish their capacities.
The write fence still requires the final body frame and successful outer flush.

A response can transfer its complete byte reservoir and reservation to codec
input without copying or temporarily returning credit. The retained capacity is
checked against its original admission. Independent expectations are serialized
into an admitted bounded writer and transferred with that reservation.

The private `Completed` result owns the response and lane after full consumption.
Explicit restoration checks the original owner, lane slot, cancellation and fresh
policy before returning a healthy driver. A complete connection-close response
remains valid but its lane cannot be restored. Failure or abandonment drops IO;
there is no automatic POST retry. Runtime revoke/shutdown closes shared idle slots
synchronously; checked-out lanes retain their cancellation and completion owners.
The bootstrap keeps its per-response retirement path and adds no product poll.

These changes do not qualify the persistent HTTP/TLS memory inequality. The
connection and handshake reservations, RAW_TURN scope, canonical graph tariff,
bank and 32/64 MiB quotas remain unchanged. Physical regression tests are required
before considering this private transport stage verified.

## Native profile lifetime

The bootstrap Child is launched only after the bounded opaque `/me` response
arrives. Its closed native facts remain charged while its stdin/stdout are
closed, Child is reaped and stderr joined. Only successful retirement permits
launching the persistent profile for the authority preflight operations 1/2.
Retirement failure retains the Codec in quarantine, including its charges,
and refuses replacement. The retained private bootstrap owns the persistent
handle; explicit close joins it, and caller disappearance cancels it while the
runtime retains the join.

The persistent profile has no idle timeout. It can wait beyond a 25-second poll
without synthetic keepalive jobs. HELLO still has its 10-second deadline and
active jobs their 30-second deadline. Shutdown and generation revocation cancel
and join the same owner. The bootstrap profile retains its bounded idle wait.

The persistent import graph excludes `protocol.ts` and the generated A1 module.
The existing identity generator checks that separation and emits distinct
profile/source identities. A cross-profile BEGIN refuses before raw/bank grants.
The same compiled executable may still contain bootstrap code; no code mapping,
VM or RSS release is inferred from dropping a module reference.

Only the bootstrap Child holds the 1,835,008-unit A1 module reservation. Removing
it from the persistent phase leaves the canonical 27 MiB graph and 2 MiB bank
unchanged. This does not prove that persistent HTTP/TLS connections and all v2
copies fit within 32/64 MiB. Public F remains closed pending that separate work.
