# Closed recognition and evidence

provider.schema.json is normative for every permitted provider key, required
field, absent field, nested type, role/content combination and completed status.
The schema is loaded locally with existing Ajv2020; network schema resolution is
not used. The source recognizer calls this same owner before extracting parts.
The array is a stored history value, never an instruction to execute a call.

Responses message permits optional id:string, status:completed and channel:final.
User content permits input_text and input_image, assistant only output_text.
Text requires text:string; annotations/logprobs are absent or empty arrays.
Image requires image_url:string, subsequently restricted to owned canonical
PNG/JPEG/WebP base64 by export. Reasoning requires summary array of
{type:summary_text,text:string}; id/status are optional, encrypted_content is an
optional excluded string. Call requires call_id/name/arguments strings. Result
requires call_id/output strings, optional macro_tool_result. Unknown keys refuse.

Macro assistant requires content:string, permits visible_content/reasoning_content
strings, reasoning_details empty, tool_calls function array and optional tool_name
string. It forbids tool_call_id and macro_tool_result. Macro tool requires content
and tool_call_id strings, permits tool_name and macro_tool_result, forbids
visible/reasoning fields and tool_calls. Each function requires id:string,
type:function, function:{name:string,arguments:string}. Optional absence is not
explicit null. Any id at a Responses outer item is excluded local metadata.
Call IDs needed for correspondence are historical source facts, not live handles.

Typed tool result requires version1, isError:boolean and blocks array of at most
64 closed {type:text,text:string}. The block object rendering must exactly equal JSON.stringify({type:"text",text}),
with that key order, matching the existing normalization equality guard.
Sum of block UTF-8 bytes must not exceed the
existing tool-result 8 MiB normalizer allowance, and joining complete block texts
with LF must equal the plain output exactly. A normalizer truncation or fallback
is refusal, not an admissible derived result. This existing per-result codec
compatibility bound is not a new total history cap. Surrogates in any observable
text, name or arguments refuse before hashing or UTF-8 conversion. Excluded
opaque strings are type checked but neither exported nor fingerprinted alone.

All matching calls/results must exist and retain exact output. Same call ID with
a conflicting name/argument or result refuses. Trace IDs and complete results
must match calls; status done is required, recovery_state unknown refuses.
The trace key set is exactly vocabulary.providerKeys.toolTrace. tool_call_id and
tool_name are strings, optional detail is a string; other allowed diagnostic
fields are excluded and carry no restored authority. Duplicate trace IDs refuse.
A generation_attempts_json field must be absent/null or an empty array; a
nonempty attempt refuses as unclassified generation history. completion_reason
provider_error refuses; other known operational fields are excluded.
No incomplete call is made portable by dropping its trace. Hidden-only may not
claim an ID already represented by a call/result with missing trace.

The known hidden formatter is exactly:
<tool_context tool_call_id="ID" tool="NAME"[ detail="DETAIL"]> LF RESULT LF
</tool_context>. Attribute escape order is ampersand, quote, less-than,
greater-than to &amp; &quot; &lt; &gt;. Detail is omitted when empty and blank-only
results produce no block. Blocks join by two LF and trim only as the real
structured producer does. Hidden-only must roundtrip exactly with an unambiguous
closing delimiter; structured results prove full reconstruction instead and may
contain delimiters. Reinspection of known headers decodes only these entities;
it does not interpret arbitrary prose or infer execution from a header.

## Assistant attribution

A visible receipt is exactly version2, source:provider-output,
fingerprint:SHA256(UTF8(JSON.stringify([sourceMessageId,visibleContent]))), start,
end. start/end are UTF-16 safe integer indices, 0<=start<end<=content.length.
The attributed final is the exact content.slice(start,end). Receipt JSON uses
strict decoded duplicate rejection before this projection. A receipt alone is
not authority; it must be read with actual display content under the same source
snapshot. A nonempty assistant display with no matching receipt refuses.

Its final-output evidence comes from the last assistant item, final channel,
completed status, with no tool calls. Responses concatenates output_text parts;
Macro uses content, not visible_content or reasoning fields. The live producer
finds the last range of its trimmed final in the exact visible content. Macro
visible rendering may wrap one observable reflection in <think>...</think> and
the final; reconstruction must equal the original visible field and the reflection
must match an observable retained provider reflection. This does not promote
reflection or the receipt into a trusted system instruction.

The full original, derived message and provider copy each have explicit origins.
Matching final/display copies become original rather than additional prompt data;
distinct intermediate texts remain historical data. A projection contains one
assistant final, no user duplicate, while all admissible originals/reflections
remain recoverable under current policy.

## Refs, citations, assets and source evidence

Context refs are arrays of closed id/kind/title/snippet/sourceLabel/url/contentHash.
id:string required; kind must equal source; other present fields are strings.
Every referenced citation exists. Files/skills/browser/other-chat context not
captured as owned portable evidence refuses if indispensable. Citations have
exact captured columns in vocabulary, type web/file/document/source_passage,
scope context/source, nullable kind or interesting/used. Source/title/id and
content or snippet must support projection. Autonomous toolbox citations need no
message match; a relation claiming a message must have that message. External
path is refused except attachment:// owned references. URL/title remain inspected
historical data, never permission to fetch a resource.

Required owned asset bytes match total_bytes and SHA256. Only user-owned assets
are supported. Canonical inline data URLs must match known MIME and base64; there
is no network fallback. Duplicate identical bytes in a message may share their
retained target but their send order stays explicit. MIME text/plain, image/png,
image/jpeg,image/webp use the existing whole-content host inspector. Its current
secret/path policy, complete UTF-8/Latin-1 views, image container rules and current
file limits are host inspection obligations; arbitrary content cannot claim that
inspection was done by setting metadata or copying a receipt.

Checkpoint retained JSON shape is defined by validatePortableCompactionJson in
validate.mjs, including all footprint keys/number constraints/enums. The source
must authenticate complete evidence, beyond the normalized packet's type facts:
policy/version/fingerprint inputs version4; matching modelContextWindowTokens;
input messages exactly equal actual role/contentHash/providerInputHash evidence
for the complete compacted prefix ending at boundary. Sorted captured used and
interesting lists equal the input lists; IDs are unique nonempty strings.
Captured source hashes equal the input dictionary exactly, and its keys equal
the union of required source IDs whose current citation evidence matches.
Every pruned ID exists, including permissible retained-tail IDs.

The fingerprint accumulator starts at2166136261; for each UTF-16 code unit xor
then Math.imul by16777619; unsigned finish is lowercase hex padded to8. Checkpoint
fingerprint applies to JSON.stringify of the complete fingerprint input object.
Message content evidence feeds role+colon then actual DB-mapper presentation
content and raw hidden context; provider input evidence feeds JSON.stringify of
the parsed provider input array or [] if absent. The raw checkpoint fingerprint,
inputs and source hashes are private source-only bindings, excluded from the
exported packet. A target cannot recompute these excluded facts from the
normalized archive and must not accept an imported summary as their proof.

The archive has explicit source limitations and retained admitted originals.
A native source attestation under the current freeze must establish the evidence
above. The portable packet proves only its own structure/integrity and declared
admissible provenance under independent host policy. Preparation requires real
next-turn adapters, target readback dependencies and recovery, never only schema
success. A summary is historical user data through further target compactions.
