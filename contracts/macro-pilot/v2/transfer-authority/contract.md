# transfer-authority-1

This inactive companion supplies the current transfer facts missing before a
challenge or producer poll can be checked independently. It changes neither
`transfer-decision-1`, portable history, nor `transfer-transit-1`. Shipping this
folder advertises no capability and enables no transfer or HTTP route. Load it
lazily at a future transport owner, outside startup and ordinary v2 traffic.

## Closed route and shapes

The only route is `POST /pilot/v2/transfer-authority/preflight`. No query,
redirect, compression or other verb is accepted. Send compact UTF-8 JSON with
`Cache-Control: no-store` on replies. Never cache a snapshot as durable authority.
`schema.json` is the closed shape owner. All keys are required, additional keys
are refused, and `strict-json.mjs` also refuses duplicate decoded keys.

A request has exactly `authority_contract: transfer-authority-1`,
`type: preflight`, a fresh UUID `request_id`, and `scope`. Its single
`X-Request-Id` header equals that UUID. Scope is either:

- `kind: controller`, `source_instance_id`, `target_instance_id`, with an
  explicit null target for source-only lineage creation. A pair has distinct
  source and target instances.
- `kind: producer`, `instance_id`.

A snapshot has `type: authority_snapshot`, the contract, request UUID and
identical scope, `authority_origin`, `issued_at`, and `expires_at`. Dates have
exactly 24 characters, `YYYY-MM-DDTHH:mm:ss.sssZ`, with valid calendar values,
four-digit years and a positive lifetime of at most 30 seconds. Origin uses
the existing canonical origin validator and additionally requires HTTPS.

Controller snapshots also contain exactly `actor: DecisionActor`,
`source_producer: DecisionProducer`, nullable `target_producer`,
`recovery_generation`, and `history: intact | restored`. Producers must be
active, in the actor's account, and match the requested instances. Null target
is permitted exactly for a null target in scope; then target access revision
must equal source access revision. Producer snapshots contain only their
active `producer`, whose instance matches scope. The producer's session is not
an actor session field and must never be inferred from the initiating actor.
All canonical IDs, UUIDs, i64 decimals and actor/producer validation come from
the unchanged decision owner and its generated browser derivative.

An error contains exactly the contract, `type: authority_error`, `request_id`,
`code`, and `retryable`. Codes reuse the relevant decision codes. Only
`unavailable` and `instance_offline` are retryable, exactly as in the decision
owner. No message, participant existence, scope, secret, partial snapshot,
receipt or terminal state is included. An error never proves abort, commit,
release of a freeze or permission to retry a mutation.

Authenticate the bearer before reading a server request body. A pre-body
refusal can correlate only to one syntactically valid, unique UUID
`X-Request-Id` received in the header. It must not claim to have checked a body
UUID or scope. Emit a closed error using that reliable header only when it is
available. A missing, duplicated or invalid header requires a generic HTTP
refusal without this correlated DTO. Do not fabricate a request UUID, scope or
authentication fact. After parsing, header/body mismatch is a refusal and no
snapshot is emitted. A receiver accepts an error only when both response header
and error UUID match its independently held in-flight request.

## Authority and receiving frontier

`validateObject` checks already admitted plain data. It authenticates nobody.
No field or boolean claims that a JavaScript object was authenticated.
`validateResponse(request, response, expected, time)` compares the independently
held request and both correlation headers, requested scope, known local account,
configured HTTPS origin, actual connection origin, snapshot origin and time.
Missing expected facts fail, including on errors. The snapshot cannot supply
its own expected account, origin, request or dispatch age.

The native transport owns TLS, authenticated session state, redirect refusal,
response headers, and current authorization. It provides `ExpectedTransport`
outside JSON. It also provides `TimeReading` with current wall-clock milliseconds
and nonnegative monotone age since that request's dispatch. Age must remain
below 30 seconds and, for a snapshot, below its actual issued/expires duration.
The wall clock must be at or after issue and strictly before expiry. A clock
moving backwards cannot extend the monotone lifetime; a future-issued snapshot
or one whose monotone lifetime elapsed is refused. These strict comparisons
refuse clocks that cannot establish freshness instead of guessing a skew.
`withResponse` calls the transport's `readTime` after awaited input and
immediately before its consuming callback. The caller rechecks freshness and
current authority before a later effect, especially after another await.

Controller requests require bearer authentication, the same account and both
supervise and respond on each requested instance. Source-only requires both on
that source. Producer requests require bearer, X-Instance-Key, the selected
active producer's own session and supervise on its instance. No producer on a
second PC is disclosed to the producer mode. Participant IDs are candidates
until the existing owners authorize them.

A future server projection must read auth/access, lifecycle, recovery and
selected producers synchronously under the existing transaction, without an
intervening await. Its expiration is the earliest of issue plus 30 seconds,
session expiration and observed producer expirations. Missing or changed
producers yield a structured refusal, never a partial snapshot. Guard every
await and immediately before emission with the current owners. This contract
cannot verify absent server records and does not replace those guards.

Fetch immediately before use. Bootstrap the producer with its single existing
v2 poll without offering F; read this producer preflight on the control
connection. Offline permits a bounded reread, never an invented generation or
second poll. Offer F only on subsequent polls whose independent expectations
exist. Keep capabilities unchanged across this header change. A poll must end
within the snapshot lifetime. After expiry, finish its owner, reread and
reconcile. Fresh facts cannot validate past effects retroactively.

For a controller, source-only preflight supplies the facts for lineage creation.
Before reserve, fetch both producers and authenticated source status; its
recovery generation must match preflight and its ledger provides CAS revision
and next epoch. Native provenance, frozen content and digests remain at their
existing owners. Later preflights supply current facts without rewriting a
durable transfer binding. Generation/connection changes discard affected
expectations and require existing reconciliation. A restore follows existing
recovery holds. Ambiguous network results keep original journal expectations
and read source/transfer status. Expiration never restores rights or unfreezes
content. `supported_context_contracts` stays empty; this adds no E support.

## Admission and ownership

The request limit is 4096 JSON body bytes, the response limit 8192. A host must
reserve from the existing common process/instance quota before invoking a
loader, not after parsing. `withDecoded` is specific to this DTO, without
extending the closed transit union. `admissionUnits` inventories logical units:

| Owner within the decoding lease | Units for body limit L |
| --- | ---: |
| Hostile graph and strict-parser key sets | L × 256 |
| Decoder work, canonical JSON, byte counting and schema diagnostics | L × 16 |
| Input view, UTF-16 decoded text and UTF-8/canonical temporary copies | L × 8 |
| Additional live caller work and copies | Explicit `ports.charges.working + copies` |
| Total request with zero external charges | 1,146,880 |
| Total response with zero external charges | 2,293,760 |

These conservative logical units are quota policy, not a heap or RSS bound.
`ports.reserve(total)` is synchronous, either returning a release function or
refusing immediately. No private counter exists here. External charges are
mandatory even when zero. The host inventories its actual HTTP/TLS, queued
frames, buffers, backing allocations and additional work; a small view onto a
large buffer does not remove its backing allocation's charge. Charges already
held by another owner remain held there and are not double-counted by this
lease. Retaining or copying parsed values needs a separate charge before
retention. Consumers keep no uncharged references after the callback.

Loaders count incoming bytes and reject before copying beyond L, including
chunked bodies. Content-Length is not the bound. Do not decompress. A malicious
loader allocating outside this policy is outside the contract's guarantee.
Decoder cleanup runs on loader, parse, validation, consumer or release errors.
All generated AJV error slots are cleared, including when a validator throws.
Callback views remain under the full lease until consumption ends.

Before the server knows scope, acquire a global lease. Under the common quota
lock, atomically attach that live lease to the deduplicated candidate instances
without a second process charge. Test all instance/process ceilings together;
refuse immediately if an instance is absent or lacks headroom. Do not create a
durable counter for an arbitrary ID or await with an unattached graph. This
step grants no rights. Perform authorization next and reserve response work
before projection. Client scope is already known and can be charged before
reading. HTTP frames keep their own charge through frame completion and
socket finish/close; returning a graph lease does not release those copies.

A schema-derived compact-wire bound is 450 bytes for the largest request and
3836 for the largest controller snapshot. The origin allowance uses up to six
JSON bytes per character, not an ASCII assumption. Active producers only,
bounded IDs and canonical date lengths keep snapshots inside the 8192-byte
limit. These are JSON bounds, not memory measurements.

## Reproduction and portable import

Run `node dev/generate-transfer-authority.mjs --check` or Bun with the same
arguments. The generator reuses `standalone` from the transit generator and
the installed Ajv/esbuild versions; it does not rewrite any existing canonical
file. Generated code imports no Node API, Ajv compiler, eval or dynamic Function
at runtime. Tests run under Node, Bun and Node's
`--disallow-code-generation-from-strings` mode. No native runtime is needed.

`transfer-authority-contract.json` lists every own normative file and every
external dependency with exact SHA-256. Preserve their relative paths when
importing into a future relay, including the browser derivative's MIT notices,
strict JSON parser and type dependencies. The manifest also lists both
generator sources as reproducibility inputs. Generated `IDENTITIES` pins the
schema and dependency set. Neither hash is an authentication or capability
claim. Existing E/F/transit manifests and roots are preserved byte for byte.
