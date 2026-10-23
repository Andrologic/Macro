# Portable Chat history contract 1

This internal content contract describes an inactive recoverable global Chat
archive. It grants no native authority, transfer capability, session continuation,
permission, agreement or model invocation. A consumer supplies its own admission,
export policy and authenticated source/storage authority. Unknown representations
and missing indispensable context refuse; history length has no product cap.

The normative set is exactly the files listed by
portable-chat-history-contract.json in this directory. Its exact UTF-8 bytes,
including the final LF, are hashed by SHA256 to identify the contract. Entries
contain relative path and SHA256, sorted by path; they include every normative
resource and shared strict-json.mjs, exclude this root itself, tests and derived
local provenance. The generator verifies bytes without remote resolution. A hash
of implementation code or a private inventory is not this identity. F's normal
supported_context_contracts remains empty until verified endpoint composition.

validate.mjs and vocabulary.json define the closed scalar, header, origin, frame,
sequence and dependency rules. The declaration is normative for the public
module's interface and must agree with runtime vectors. A small JSON Schema
registers frame shape; synchronous validation supplies relational semantics.
No frontend dependency or second JSON parser belongs in this set. Strict JSON
uses JSON.parse for syntax and rejects decoded duplicate keys. JSON numbers do
not preserve arbitrary numeric precision: arguments_json remains exact original
text and is inspected decoded without reserialization. Structural counters are
nonnegative safe integers; overflow refuses, without truncation or rounding.
Before any new UTF-8 derivation reject lone UTF-16 surrogates. Valid UTF-8 text
retains BOM and all original code points. Payload hashes cover original bytes.

## Frame and counts

One descriptor line precedes contiguous fragment lines. UTF-8 NDJSON has no BOM,
requires LF and admits a line before assembly. FRAGMENT_BYTES=4093,
FRAME_BYTES=8192. Descriptor: kind=portable_archive,
format=portable-chat-history-1, content_contract_sha256, records, bytes,
manifest_sha256. A fragment has header, offset and canonical STANDARD base64 data.
The header is ordinal, entry, bytes, sha256 and optional origin. Explicit null
origin and unknown fields refuse. Entry roles are user/assistant, purposes
portable_metadata/original_text/historical_data, MIME and relations are closed
in vocabulary and validator. Empty records require one empty fragment.

records always counts distinct record headers, not fragments. bytes is the sum
of declared record payload bytes, including origin metadata and zero association
payloads. Fragments count actual frames; partitioning may vary without changing
the content manifest. A receiver may repartition for native append; report
portable input fragments and native append fragments separately. The native Begin.records counts those same headers;
Begin.bytes is the same total payload. A readback port may count returned
fragments separately and must not pass that count as record total. Native
readback target UUIDs/importKey are local and absent from portable frames.

Headers render with ordinal/entry/bytes/sha256/origin order. Entries render
kind then role/purpose/mime, or kind/from/to/position/relation. The renderer uses
ECMAScript JSON.stringify compact spelling, no whitespace or Unicode
normalization. The content manifest is SHA256 UTF-8 of
JSON.stringify([captureManifest, policyRevision, headerStrings]), where each
headerStrings element is the exact renderPortableHeader string in ordinal order.
A matching digest proves byte/sequence integrity, never trust in source policy.

The separate native source manifest starts with macro.raw.native.source.v1 NUL,
length-prefixed source binding JSON and source LIMITS JSON (u64 LE lengths), then
for each field ordinal,row,family,tag,sql_type,bytes as i64 LE and its raw SHA256;
then ordered relations from,kind,position,to-or-minus-one,status as i64 LE.
The normalized archive retains only its composite digest as source provenance;
excluded private source bindings cannot be independently reauthenticated from
the archive. This is an exporter attestation obligation, not self-proof.

The native storage manifest starts with macro-inactive-storage-manifest-v1 NUL,
length-prefixed native JSON identity, bindings, profile, version u8,
records/bytes u64 LE, then length-prefixed raw SHA256 of each native record header
JSON. It binds local import/actor/generations. It is not the portable manifest.
Native JSON field order is the declared Identity/Bindings/RecordHeader and
RecordKind Rust order, compact serde_json, optional origin absent when none.
Translating the portable digest to F's content manifest and local prepared pin
must retain both commitments distinctly, not substitute one homonymous hash.

## Admissible source and provenance

vocabulary.families fixes every native table/column ordinal, type and nullability.
Only global Chat is supported, no required task/group/project context. App settings
contains only assistant-visible provenance v1 for the selected messages. Native
capture versions/guards and schema attestation remain independent of received
values. Source limitation strings are exact and mandatory; a normalization does
not erase limitations of the raw capture. Remaining limits include not_F_admission
and not_provider_session_resumption. Unknown limitations refuse.

Every retained payload references its earlier retained_original origin metadata.
Reasons/classifications are closed. Redundant representations reference an
existing earlier retained record. Excluded operational state, opaque continuation,
local provider IDs and private checkpoint bindings have no value, isolated hash,
length or recoverable payload. Observable reasoning/reflection remains historical
data. Historical source IDs and admissible provenance are data, not authority.

Source family1 tags9/10 are recognized only through the real Codex/Macro AI
producer forms: Responses user input_text/input_image, assistant output_text,
reasoning summary_text, function_call and function_call_output; or
chat_completion_message assistant/tool with content, visible_content,
reasoning_content and function tool_calls. Keys/status/role combinations are closed in provider.schema.json and recognition.md; the producer recognizer consumes the same schema. Extra annotations/logprobs, reasoning details,
non-text typed results, incomplete outputs, unknown forms and lost indispensable
context refuse. encrypted_content and response/session identifiers are excluded.
Original arguments_json preserves numeric lexemes. Typed tool-result v1 text
blocks must equal their full plain output, with no truncating fallback.

Visible assistant text must be attributed by actual provenance and codec
reconstruction. A provider final or display matching the visible final is stored
as original, not repeated as user data. Distinct intermediate text stays data.
Reflection is recoverable but is not automatically promoted into the next prompt.
Tool calls/results are historical facts, never queued execution or approvals.

Hidden-only uses the complete unambiguous real tool_context formatter framing.
Structured hidden must equal the entire reconstruction of calls/results/traces,
including names, detail, order and delimiter-bearing results. It does not require
an ambiguous inverse on result text. Reinspection decodes only known formatter
attributes, including recognizable embedded headers conservatively, not arbitrary
user prose. These attributes and all JSON retained under known origin grammars
are inspected decoded under current host policy at source and before consumption.

Checkpoint JSON tags3/4/5/10/12/13 have the closed compaction owner shapes.
Captured boundary/complete prefix, used/interesting/pruned lists, source hashes,
fingerprint inputs, versions and actual messages/citations must agree. The private
bindings8/20/21 are checked at source then excluded. Unknown required context
cannot become excluded_local_metadata as a fallback. Citation types/scopes/kinds
are closed; autonomous toolbox citations need no message owner but must exist.
External paths refuse except owned attachment:// references. Required assets
are text/plain, PNG/JPEG/WebP owned bytes, exact digest/length and send order.
Assistant assets remain unsupported and required ones refuse.

## Consumption and two passes

The first pass validates the same sealed source and full host policy without
append. The second emits into inactive storage; headers, totals and portable
manifest must match. A failure in pass1 causes zero append. A failure/change in
pass2 requires abandoning the receiving attempt; append alone is not a seal.
The portable validator can write only to an explicitly inactive sink. It checks
all frames, hashes, origins and associations and calls host inspect before every
payload callback. A late manifest/dependency refusal aborts the inactive sink;
no callback from this API proves final admission or publication.

Admission precedes raw strings, parsed graphs, inspection views, indexes and
copies. reserve is mandatory and failing it causes no load/append. The host owns
current private policy, not imported policyRevision or an isolated credential
hash. Native E/source/staging/copy charges and attachment quotas remain unchanged.
Working units are logical declared tariffs, not heap/RSS. Reader/projection may
materialize O(N) under admission; block size never implies constant global memory.

Source and target inspect raw text plus decoded keys/strings for known JSON,
inner argument JSON, actual hidden attributes and asset UTF-8/Latin-1 views/MIME.
The host must reject excluded private data before emission. Stronger same-visible-
revision policy applies on every record/UUID/projection callback and metadata open.
A source policy claim cannot waive current target policy. Fixed diagnostics contain
no private input, property paths, filenames, provider messages or payload.

Associations come after referenced message/target, payload empty, closed relation
and position. A from/relation/position tuple is unique, matching native storage;
an asset target has one owning association. Membership is indexed, without a
per-asset scan of all links. Target mapping UUIDs are stable per import and not source IDs.
Ordering uses records and association positions, never target UUID sort. All
selected dependencies must be recovered from target records/associations/mapping.
Original/reflection records excluded from projection remain independently
recoverable under the same current inspection. They are not read solely to
re-expose them in a prompt.

Imported checkpoint bodies and future target compaction summaries remain
historical user data. Only local trusted instructions become system/developer.
After constrained target compaction, a deliberately omitted indispensable fact
must be absent from the first entire body, recovered from target archive paging,
and present in the next body while absent from systems. Four Codex/Macro AI pairs
use real preparers/serializers with forbidden transport sentinels. Archive support
is distinct from native provider-session continuation or universal semantics.

## Responsibility of F and transport

F decision metadata accepts only exact integrated content-contract identities
from independently configured trusted support. It never includes titles, paths,
transcripts, provider bodies or assets. Source freeze, stable ownership, native
pin, prepared mapping/preparation commitments, cession, activation, restore and
maintenance belong to native F and authenticated producer composition. A portable
validator does not attest those events. Transit may carry content under separate
admitted/chunked accounting, but relay metadata journals do not store it. This
contract adds no relay archive storage, route, capability or active offer.
