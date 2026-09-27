# Content and account extension 2.0

This is the public contract for the next C/D/E integration, not a declaration
of shipped runtime support. The normative shape registry is
[`v2/schema-set.json`](../../contracts/macro-pilot/v2/schema-set.json).
Its JSON Schema 2020-12 resources, positive/negative fixtures and
[`validate.mjs`](../../contracts/macro-pilot/v2/validate.mjs) define shape and
stateless relational checks. The stateful requirements below are equally
normative. Consumers must enable date-time assertions. Unknown fields, types,
versions and operations fail closed. This document supersedes the earlier
conversation/review draft and historical product questions for this extension.

## Negotiation and transport

Keep the existing `/pilot/v1` authentication, association and supervision
protocol and its frozen `contract_version: "1.0"` messages. Never relabel a v1
message as 2.0 or inject v2 fields into v1. Version 2.0 is a separate extension
for content and account operations. The existing generated v1 runtime validator
is intentionally unchanged. Supporting v1 says nothing about v2 support.

After authentication, the client sends `negotiate` to
`POST /pilot/extensions/negotiate`, with `X-Request-Id` equal to `request_id`.
Without instance_id this negotiates account operations between the client and
D only. With instance_id it negotiates content for that instance and D also
checks granted association and the current C producer's support. It returns
`negotiated`, echoing the request ID and the exact presence/value of instance_id.
D selects 2.0 only when offered and implemented by every required participant.
It records C capability after the first authenticated v2 producer poll on that
instance; capability expires when producer presence is lost. Otherwise the
selection is null. A missing endpoint means unavailable extension.

Negotiation grants no authority. Re-negotiate after session replacement, loss
of capability or producer reconnect for instance content. Selection is bound
to the authenticated session and optional instance. Every v2 request rechecks
its matching selection. Account management works without an associated or
online instance. No field is added to a v1 instance or transport envelope.

`POST /pilot/v2/account/requests` accepts only account.get, sessions.list,
session.revoke, sessions.revoke_all, session.logout and account.delete.
D handles these directly and returns a terminal v2 response/error. Account
reads use request IDs for correlation; mutations also use their durable
idempotency keys. Replaying a completed mutation uses a new request ID and
the same body/key, after current authentication. No producer delivery or key
is involved. A request must use its documented route; wrong-route operations
return validation_failed before effects.

`POST /pilot/v2/instances/{instance_id}/requests` accepts only content requests
and review.verdict, delivered to C. The client receives an A2 `accepted`
envelope or terminal v2 error. Polling
`GET /pilot/v2/instances/{instance_id}/requests/{exchange_id}` returns 202 while
pending or the exact terminal message. request_id is the exchange identity,
scoped to account incarnation, session and route instance. Same ID/body
returns the same pending/terminal exchange; changed body conflicts. Clients
retain the original request for correlation, then use a fresh ID for a new read.

C uses `POST /pilot/v2/instances/{instance_id}/deliveries/poll`,
`POST .../deliveries/{request_id}/authorize` and
`POST .../deliveries/{request_id}/result`. The typed A2 transport envelopes are
in the same schema registry. Producer proof, queue bounds, 25-second polling,
60-second exchange expiry, single-use authorization and result replay follow
[the native transport](native-transport.md#acheminement-http-des-messages-a1).
These are new versioned routes, not extensions of the closed v1 envelope.
D binds each delivery to its source session. C checks that trusted delivery
actor against the request account, never a client-supplied display identity.
D checks access before queueing, delivery, authorization and result return.
C checks authorization immediately before any effect. Stale or revoked
requests cannot obtain a cached result. Expired exchanges require a new
request ID, retaining the mutation idempotency key when reconciling an effect.

All routes retain bearer authentication, HTTPS in production, configured
origin checks, no redirects, `Cache-Control: no-store` and body-free logs.
Secrets are exclusively headers or existing native authentication payloads.
X-Instance-Key is a client installation credential, never an OAuth/server
secret. HTTP 400 covers validation/unsupported version, 401 authentication or
revocation, 403 forbidden, 404 not found, 409 stale revision/conflict,
410 expired snapshot, 413 resource limit, 429/503 unavailable. Error bodies
are closed v2 `error` messages without raw Git/provider details. Retryable is
true only for unavailable/instance_offline. Authentication failures before a
trusted account/request can be established use the existing transport error
form; never echo a claimed account ID as authenticated identity.

## Scope and access

An authenticated, associated mobile session can browse every project in the
instance. There is no phone/project ACL, project selector or project grant.
Instance association, account isolation and the existing operation permissions
remain mandatory. Read operations require `supervise`; review.verdict requires
`review`. Execution and tool policies remain those of v1 and the local engine.
Every reference must resolve inside the route instance and authenticated
account. C resolves paths locally from IDs. A path, SHA or device ID is never
authority. Cross-account IDs produce not_found/forbidden without private data.

`projects.list` lists all instance projects. `conversations.list` has two
separate instance-wide catalogs, selected by `kind`. `implement` references
carry the real workspace, task and conversation IDs. `conversation` references
carry only instance and conversation IDs. They map to Macro's `scope_mode:
"Chat"`, whose normal records have null task/project/group IDs. No fake task,
project or empty task ID crosses the wire. Architect, attachments, conversation
creation/editing and archive preference synchronization are outside this lot.

Source mapping at the integration base:

- `Conversation`/`DbConversation` in `src/types/index.ts` and
  `src/services/tauriIpc.ts` provide identity and nullable task relation.
  `createConversationRecord` in `useChatStore` creates global Chat records.
- `listConversations`, `getConversation`, `listMessages` provide persisted
  content. Catalog order is `is_pinned DESC, updated_at DESC, id ASC` and
  messages use `created_at ASC, id ASC`. Preserve these orders within captures.
  A late insertion changes the capture even when its date is old.
- `ensureMessagesLoaded(id)`/`getConversationMessages(id)` can read a chosen
  conversation without changing the UI selection. An empty cache is not proof
  of an empty persisted transcript. `useConversationArchiveStore` is a local
  preference, not a Conversation field and not a reason to silently omit data.
- Db mappers and `visibleContent` help form display text but are not safe wire
  serializers. Never spread ChatMessage or DbMessage into a response.

## Visible text policy visible-1

Export starts automatically after valid association. Only display titles,
sent user text, identified final assistant text and controlled diff content
are eligible. Export neither hidden_context, provider_input_items,
provider_turn_state, tool_traces, context_refs, citations, attachments, drafts,
compaction summaries, system/tool messages nor private reasoning. No per-message
approval or per-file consent is introduced.

C must distinguish provider final output from reasoning before export. For
historical mixed content it uses the adapter's strict grammar, withholding on
unknown provenance, malformed or unclosed reasoning markers. A regex deleting
one `<think>` block is insufficient. Active assistant text remains pending,
without a text field. Stabilized text still requires provenance validation;
completion_reason alone cannot certify safety. `complete` and `excerpt` carry
only controlled text; withheld/pending carry only a bounded reason. Completion
is independent: recognized completed/recovered endings map to complete,
length/incomplete/tool-limit endings to incomplete, absent/open values to
unknown. Pending requires assistant, generating and unknown completion.

Before splitting any text or diff, inspect the whole candidate and both whole
file sides plus both paths. Withhold the entire candidate/file on detected
secret, ambiguous parsing or exhausted inspection budget. At minimum apply
v1 safeText signatures, configured secret values in raw and configured encoded
forms, PEM private keys and credential-file categories: any `.env` or `.env.*`
basename, `.git` path component, `.ssh` path component, `credentials.json`,
`id_rsa`, `id_ed25519` and files ending `.key` or `.p12`. Categories apply to
either old or new path and are case-insensitive for protection. Producers may
withhold more, not export forbidden fields. Fixtures demonstrate rejection
and withholding, not a guarantee that every arbitrary secret can be detected.
Secret/path detection is defense in depth; schema success alone is insufficient.

Display only inert text. No HTML execution, automatic URL/image fetch, file
access, patch application or raw-body logging in D/E. A withheld path uses null
on both sides and a file_id, without exposing the original name or its hash.

## Captures and pagination

C owns content and revisions; D owns account/session revisions. Capture IDs and
cursors are opaque, unguessable and bound to account incarnation, session,
instance, operation, reference/filter, revision and export policy. A guessed
cursor cannot switch scope. First list/read has no continuation and starts at
zero; subsequent pages require the returned snapshot_id and next_cursor.
C/D validate cursor position, not just its shape. `page.total` is the exact
number of projected items, never the current live list count. Positions are
zero-based and contiguous; next_cursor is null exactly at the end. Consumers
check stable page metadata, uniqueness across pages and continuity. Empty
catalogs are valid only when a successful authoritative read proves emptiness.

A capture expires at most five minutes after observed_at. Every page repeats
its fixed metadata; all content is read from the same immutable projection.
No response exceeds 256 KiB serialized UTF-8, including the transport wrapper;
no page exceeds 100 items; text, title and diff fragments are at most 16 KiB
UTF-8. Producers reduce page size to fit, never truncate an envelope. A message
above the text limit is explicitly excerpt; withheld/pending never carry text.
Diff fragments continue across UTF-8 character boundaries without dropping
bytes. Aggregate transient capture storage is at most 64 MiB per instance,
with resource_limit on exhaustion. These are transport bounds, not backups or
an archival policy.

Conversation/title/activity changes, membership changes, deletions and policy
changes increment durable revisions and invalidate affected catalogs and
transcripts. Observation alone does not increment a revision. Each new capture
has a new ID. On expired, lost or invalidated captures, return snapshot_expired
or stale_revision. Never reconstruct live content under an old capture ID.
Offline or failed loading returns an explicit error, not an empty transcript.

## Review and complete diff

`review.get` resolves a review_ref to a capture, source, revision, state,
availability and exact file_count. Missing Git/source/capture or failed
freshness verification returns content_unavailable; size/budget exhaustion
returns resource_limit. A valid zero-file capture differs from unavailable.
No fake run or commit is introduced. The source union is commits with explicit
base/head OIDs, or staged/unstaged/local_total with observed HEAD or null for
an unborn repository. Commits compare the selected trees directly. Staged is
HEAD to index, unstaged index to worktree plus nonignored untracked files,
local_total HEAD to worktree over the union of staged/unstaged/untracked paths.

`gitDiff` with explicit OIDs and requireComplete can supply short commit
patches. `gitReviewSnapshot` and file hydration are separate mutable reads;
neither proves an immutable local capture. A producer must capture content before
advertising 2.0. Serialize Macro mutations, read selected sides without following
symlinks or invoking external diff/textconv, record HEAD/index/catalog/modes
and bytes, then independently verify them. Retry once within ten seconds,
otherwise fail. External writes after verification remain possible; the
contract promises verified captured bytes, not a filesystem transaction.
Store the controlled copy and a private freshness fingerprint, including
withheld file fingerprints and relevant submodule dirty state. Never transmit
that fingerprint or private bytes. WSL support must pass the same criteria or
return explicit unavailability.

`diff.files` paginates the complete immutable file catalog. `diff.read` selects
only snapshot/file IDs and a UTF-8 byte offset. The concatenation of its patch
fragments is the entire controlled per-file unified diff, with Git modes,
rename metadata, hunks and no-newline markers retained. Use three context lines,
no whitespace suppression, rename threshold 50%, no copy detection. Patch
headers use controlled relative paths; omit free-form function-name suffixes
from hunk headers. Parse paths with Git quoting rules, not newline splitting.
Unrepresentable names/encodings are unsupported, never silently dropped.

File IDs are stable only within their capture. Old/new modes represent
existing sides when safe. A mode-only change must remain visible. `unchanged`
is permitted for a local_total catalog entry whose final sides match. Binary,
submodule, withheld, too_large and unsupported entries stay in the catalog
with patch_bytes zero; diff.read on them returns content_unavailable. Symlinks
are unsupported for text export and are never followed. Availability is partial
if any entry is not fully representable; complete requires all catalog entries
to be text with all patch bytes available. Never call a bounded/excerpted patch
complete. A file may span arbitrarily many bounded pages within capture limits.

A verdict carries snapshot_id and expected_revision, with approve or
request_changes. C rechecks source selection, target and current fingerprint
at effect time, including HEAD/index/catalog/modes/bytes relevant to the source
and export policy. Branch-following comparisons track their resolved OIDs;
fixed historical OIDs are unaffected by unrelated worktree edits. Any relevant
change invalidates the review and returns stale_revision. Lost capture returns
snapshot_expired. A partial capture remains reviewable with its limitations
visible. Unavailable capture cannot be reviewed because no identified content
exists. Never require page traversal, scroll position, a read receipt, file
checkboxes or a "read all" flag. No stage, commit, merge, push or execution is
performed by a verdict. An applied verdict updates state and revision; a
second different verdict needs a new current capture/revision.

## Native account and session lifecycle

D derives the account from the bearer, then compares account_id. Account IDs
are unique per incarnation, including recreation for the same GitHub subject.
`account.get` returns the verified GitHub identity and current session. List
sessions uses an account-scoped immutable catalog and account revision.

Account operations require the authenticated native session of the owning
account. D derives this identity from the validated bearer and checks it at
effect time; client_kind, labels and submitted device IDs are display data,
never authority. The desktop is the chosen management UI, not a cryptographic
administrator class. No new desktop/mobile role or management instance key is
introduced. The mobile provides at least connection status and self-logout.
No web account UI is introduced. Existing X-Instance-Key producer proof remains
mandatory only for instance producer routes, independently of account operations.

`session.revoke` targets exactly one session in the same account. Global
revocation includes the caller and every session, and revokes every associated
access. Logout targets only the authenticated caller. All three prevent queued,
authorized-but-unexecuted and cached content delivery, cancel pending reads and
clear account-scoped client caches. Already completed effects cannot be undone.
A new session requires explicit GitHub reconnection and association; silent
renewal is outside this extension.

D makes lifecycle invalidation and native auth claim atomic against each
other. Global revocation and deletion invalidate all already-started account
auth attempts, including in-flight GitHub polling and claim computations.
A result identifying its GitHub subject only after invalidation is compared
against the subject's lifecycle cutoff and attempt creation time before any
account/session write. It cannot recreate a deleted account, issue a session,
or use a previously cached claim result. Individual revoke/logout also make
any claim receipt that produced the targeted session unusable; they leave
unrelated sessions and independent new sign-ins intact. Concurrent claim versus
revoke/delete has a defined transaction order: either claim wins and its new
session is revoked by the later global operation, or invalidation wins and
claim fails. A fresh auth attempt started after the cutoff can recreate the
account with a new incarnation and new associations. Store only the bounded
lifecycle metadata needed to reject these stale attempts, not their secrets.

Recheck active session, account incarnation and current access immediately
before emitting every HTTP result, including already computed reads, cached
receipts, native poll/claim results and producer deliveries. Use a lifecycle
version check at the emission boundary so an intervening revoke/delete drops
the body and returns an authentication error. The terminal acknowledgement
of a caller's own logout/revoke-all/delete may consequently be lost. Do not
exempt it from authentication replay rules. Bytes emitted before invalidation
cannot be recalled; this does not authorize any new post-invalidation delivery.


`account.delete` requires an explicit desktop confirmation showing the verified
identity. The fixed confirmation field encodes that intent, not proof that a
human clicked a dialog; C must enforce the actual confirmation. D atomically
disables the account, sessions, associations, outstanding auth attempts,
instance credentials, pending exchanges and transient content. Preserve local
project, task, conversation and local identity data in Macro. Clear local
relay credentials/caches. A later recreation receives a new account ID and new
instance credentials/association; stale keys, attempts and idempotency receipts
cannot attach automatically. Retained local conversation IDs grant no access.

Every mutation uses an unpredictable idempotency key of at least 16 characters.
D/C bind it to account incarnation, authenticated session, operation, target
and canonical body. Same key/body returns duplicate with the original resulting
revision; changed body/target returns conflict. Receipts are committed atomically
with the effect, retained for the active session lifetime, and checked before
expected_revision for an authenticated duplicate. Authorization/revocation is
checked before replay. New effects compare expected_revision atomically against
the current review or account revision and increment it by exactly one. Logout has no revision
precondition. Revocation/deletion of the caller may lose its success response;
a revoked token gets session_revoked, never an authenticated receipt exception.
The client clears local credentials and reconciles only through a new sign-in.
Deletion does not retain a receipt accessible to the recreated account.

## Events and non-schema invariants

`events.request` goes to `POST /pilot/v2/instances/{instance_id}/events` for
instance content, or `POST /pilot/v2/account/events` for account-only changes.
Each route requires its corresponding negotiation and authentication; only the
instance route requires association. The account route needs no desktop
presence and includes only sessions/account invalidations. Event failures use
v2 error with operation events.read and the original request/account IDs.
D exposes an account/session/instance-scoped stream combining its account
invalidations and C's content invalidations. It emits `events.page`; null stream
requires reset with a fresh stream ID and sequence zero. Lost journal, gaps or
wrong stream also reset; clients discard caches and bootstrap. After reset,
clients poll from zero while loading captures, then apply buffered changes.
This avoids missing changes between capture and subscription. Maximum 100
events per page, strictly contiguous sequence and next_sequence. Poll again
until empty; long polling is at most 25 seconds. Producer invalidations use
`POST .../deliveries/events` with producer proof and a v2 event. D checks account,
instance, reference and monotonic revision, deduplicates producer stream/sequence,
then assigns the downstream sequence. D alone emits sessions/account events.

Content changes invalidate catalogs and detail caches; deletion is a tombstone
with the same conversation identity. Revisions advance durably with mutation
and outbox insertion, or the producer rotates its stream and requires reset
if persistence cannot prove continuity. Ignore an already observed revision;
never turn stale data into current data by updating a displayed timestamp.
Access loss clears the local account cache. Account/session notifications go
only to still-authorized sessions. The revoked/deleted caller observes 401,
not a final private event. account.deleted is a tombstone for trusted internal
coordination, never delivered to a revoked user session.

The conformance helper checks envelopes and exact request/response correlation.
Consumers must additionally prove authenticated identity, producer proof,
negotiation state, reference membership, cursor ownership and continuation,
aggregate limits, whole-candidate export safety, capture completeness,
freshness at effect time, durable revisions, idempotency transactions and
revocation racing delivery. JSON Schema cannot certify these properties.

## Transport envelope lookup

| Route/action | Request / response |
| --- | --- |
| Submit a request | `request` / `accepted` or terminal `response`/`error` |
| Poll a submitted request | no body / `accepted` or terminal `response`/`error` |
| Producer poll | `poll` / `delivery` or HTTP 204 |
| Producer authorization | `authorize` / `authorized` |
| Producer result | `delivery.result` / HTTP 204 |
| Event query | `events.request` / `events.page` |

These transport envelopes use transport_version 2.0. A delivery embeds the
original v2 request, the D-derived account and source session, route instance
and expiry. request_id matches the route ID, header and embedded request;
accepted.exchange_id equals request_id. A result wraps the terminal v2 message
and repeats request and instance IDs. D validates it against its saved request,
source session, delivery and authorization before accepting or forwarding it.
An authorization lasts at most ten seconds, expires no later than the exchange,
and is single-use for a new effect. Retrying result submission with identical
content is safe; changed content conflicts. Read responses still require live
access when returned. None of these new envelopes is valid on a v1 route.

For the current completion_reason mapping, `completed`, `length_recovered` and
`incomplete_recovered` mean complete; `length`, `incomplete`, `tool_turn_limit`
and `post_tool_empty_fallback` mean incomplete; absent or other values mean
unknown. Runtime preparing/overflow_recovery/streaming maps to busy, idle to
idle, error to error and missing runtime to unknown. Neither mapping bypasses
export safety. The helper's `validatePageContinuation` checks adjacent pages;
consumers also retain all earlier identities and the outstanding cursor.
