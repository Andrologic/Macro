# MCP tool results

MCP text, image and audio blocks remain ordered, typed and untrusted from the
native connector through conversation history. All adapters use the same
normalizer. It accepts 64 blocks and 8 MiB total, counting UTF-8 text and encoded
base64 bytes. Excess, malformed base64, unknown types and invalid MIME types
produce explicit unavailable blocks and mark the result as an error. No URI is
fetched and no file is opened. Validation covers the envelope, not media decoding.

Embedded `resource` text and `resource_link` metadata, including the URI, remain
bounded JSON text blocks. Their URI is data only: links are not downloaded or
opened, and a valid link alone does not make the tool result an error. Embedded
resource blobs remain unsupported and produce an explicit unavailable block.
When content is empty or contains only blank text, the original result is kept
as bounded JSON text, preserving `structuredContent`. These projections share
the same cumulative byte limit as other blocks; exceeding it is explicit.
A server-reported `isError: true` remains an error after text projection.

Images accept PNG, JPEG, WebP and GIF. Audio accepts WAV, x-WAV, MPEG, MP3, OGG,
FLAC, MP4 and WebM. IPC exposes typed blocks and a readable text fallback;
`rawResult` preserves bounded text responses or error metadata without duplicating media.

| Transport | Current result | Replay |
| --- | --- | --- |
| ChatGPT Responses | Image becomes `input_image` in function output. Audio gets an explicit unsupported notice. | Same image codec; audio remains stored with the notice. |
| Native Copilot | Allowed MCP schemas use the existing guarded frontend relay. Image/audio reach SDK `binaryResultsForLlm` with error status. | New SDK sessions use text prompts; retained media gets an explicit notice that it is not retransmitted. |
| Chat Completions | Explicit text fallback for image/audio. | Typed media stays stored; the fallback remains explicit. |
| Remote prototype | Existing MCP unsupported error. | No added remote support. |

Fixture tests inspect payloads and the concrete SDK handler without provider
calls. They do not prove model interpretation of every MIME type. Responses uses
[the official function output format](https://developers.openai.com/api/docs/guides/function-calling).
Copilot uses the installed SDK contract.

`provider_input_items_json` stores `macro_tool_result` version 1 with `blocks`
and `isError`. Existing content/output strings remain readable. No DB migration
is required. Codecs revalidate stored blocks and strip the extension on the wire.
Text spill replaces only text and retains media inline. Failed artifact writes
name unavailable full text and offer no recovery path. Failed conversation
writes propagate through existing persistence handling and leave data in memory
for retry; they are not durable saves.

Deterministic compaction keeps typed results and paired calls intact. Existing
summarization can remove whole turns from request context; source history stays
stored. Context overflow remains explicit. Stop cancels execution and discards
late results. Completed native call/result pairs remain cumulative across steering
and incomplete-response continuation, including an interrupted later turn.
Recovery retains executed pairs and excludes calls that have no result; older
conversation messages are not copied into the new completion.

Before downgrading, back up the local conversation database if media history must
survive. Older versions read fallback text but may discard the extension when
rewriting or compacting messages. Reopening the backup restores typed history;
a downgraded rewrite is not guaranteed to preserve it.
