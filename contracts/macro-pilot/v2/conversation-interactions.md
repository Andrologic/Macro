# Conversation interactions extension

`conversation-interactions-1` is optional and requires `conversations-1`.
It must be selected by both consumer and producer. Older consumers never receive
`conversation.interactions_changed` events. Version 1 remains unchanged.

`conversation.interactions` reads one exact conversation reference. The response
contains a five-minute capture, revision, optional native questionnaire, optional
opaque generation identity, and the available `answer` and `stop` actions.
Questionnaire steps carry native step IDs, bounded prompts and choices. Reads do
not alter selection, provider configuration or questionnaire drafts.

`conversation.interact` requires `respond`. It binds the full reference, capture,
expected revision and idempotency key. Answers include every step exactly once;
stop includes the generation identity. A stale stop cannot stop a later turn.
Authorization is checked at emission and again immediately before native effects.

The desktop persists only hashes, revisions and receipts in its metadata store.
A lost response can return the same applied receipt after restart. An uncertain
receipt cannot replay an effect or accept a new intent for the same native target.
When the desktop proves that exact question or generation no longer exists, the
uncertain receipt can be retired to allow a later target. Retirement never replays
or asserts success for the original action. No transcript history is retained by
the relay. Captures and transient exchanges remain bounded by the existing limits.

The interactions event invalidates only that conversation's interaction capture.
Transcript and tool reads retain their separate revision and expiry rules.
This extension does not add file/audio transport, model configuration, message
editing, regeneration, queue management or questionnaire cancellation.

## Native model selection

`conversation-models-1` requires `conversation-interactions-1`. A selected client receives an optional bounded `model_catalog` containing only enabled, already cached models from usable providers, their opaque provider/model identities, supported reasoning efforts and the conversation’s valid selection. Reading this catalogue must not refresh providers or access native credentials. Older clients receive neither this field nor the `select_model` action.

`select_model` uses the interaction capture, expected revision and idempotency key. It requires `respond`, an idle conversation without a pending question or approval, and a model/effort still present in the native catalogue. The desktop rechecks its reservation and selection before writing the conversation’s native AI selection. A selected desktop composer adopts the same cached choice. An uncertain result is never replayed automatically.

## Target model discovery before transfer

The opt-in `instance-models-1` capability exposes `instance.models` under
`supervise`. It needs no existing conversation. The desktop reads cached enabled
models and usable providers only, without a provider refresh or credential read.
For this first transfer path, the catalog includes supported Macro AI and Codex
providers only. A response contains at most 1000 models and 256 KiB, expires
within 30 seconds, and refuses overflow rather than returning a partial catalog.
Its policy and cached configuration are rechecked before each emission. The
chosen identifiers are intent; the target checks native configuration again.
