# Task details and actions, revision 1

This extension uses the existing authenticated v2 delivery routes and envelopes.
The normative schema is `contracts/macro-pilot/v2/schema.json`; generated desktop
types are in `src/services/macroPilot/contentTypes.generated.ts`.

## Negotiation

Consumers offer `capabilities: ["task-details-1", "task-actions-1"]` in instance
negotiation. Producers advertise only supported capabilities in their v2 poll.
Relays select the intersection and dispatch these operations only after selection.
ACCOUNT negotiation never selects these instance capabilities. Legacy peers omit
this field and continue using the original v2 operations and v1 commands. On HTTP 400/422 rejection of the extended poll, the desktop retries without
capabilities for that producer lifecycle. Existing v2 reads continue; the relay
must be upgraded before this extension is enabled.

`task-details-1` enables `task.get`, `task.artifacts.list`, `task.artifact.read`,
`conversation.tools.list`, and `conversation.tool.read`. `task-actions-1` enables
`task.action` and requires `task-details-1`.

## References and reads

Pilot artifact reads use an existing plan snapshot without replaying pending
mutation journals or automatically repairing plan replicas. Recovery and repair
remain desktop workflows; a read permission cannot authorize these writes.
Snapshots load plan and manifest metadata, without reading conversation transcripts
or artifact bodies. Guarded task actions update their own catalog entry instead
of running global refresh/recovery workflows.

Task references contain `instance_id`, `workspace_id`, and the existing opaque
Pilot `task_id`. Conversation references reuse v2 `conversationRef`. Desktop
selection never substitutes for a supplied reference.

- `task.get {ref}` returns `taskDetails`: description, title, source, status,
  draft, plan title, feature, task kind, archive/merge/finalization state,
  currently available actions, configured project commands, revision, snapshot
  ID and expiry. Text fields use `exportText`, including explicit withholding.
- `task.artifacts.list {ref, continuation?}` returns a v2 page of `artifact`.
  Only the existing desktop artifact service's own/inherited visibility applies.
- `conversation.tools.list {ref, continuation?}` returns a v2 page of `tool`.
  Each item identifies its message and trace; details are excluded from the list.
  Only structured public `tool_traces` fields are eligible. Provider replay,
  hidden context, reasoning, arbitrary tool arguments and private results are
  never used as fallbacks.
- `task.artifact.read` and `conversation.tool.read` take
  `{ref, snapshot_id, item_id, offset_bytes}`. They return a bounded UTF-8 chunk,
  `total_bytes` and `next_offset_bytes`. `item_id` comes from the corresponding
  list. Clients render text as untrusted content, never executable markup.

Every text is inspected in full before slicing using Pilot's secret/path policy.
Unsafe or unproven content is explicitly withheld. List metadata never contains
local filesystem paths. Metadata text is limited to 16 KiB; long bodies are read
in chunks of at most 16 KiB. Pages contain at most 50 items and fit the existing
256 KiB envelope. Each source is limited to 1 MiB per body, 2,000 entries and a
shared 8 MiB capture budget. Exceeding a bound returns `resource_limit` rather
than presenting an incomplete list as complete.

Captures expire after at most five minutes and belong to the account, requesting
session, instance, exact reference, policy and source revision. Cursors are opaque
and bound to their operation and capture. Reads revalidate the source. An update
returns `stale_revision`; expiry or policy/lifecycle replacement returns
`snapshot_expired`. Clients discard captures on session/account changes,
`task.changed`, `tools.changed`, `conversation.changed`, removals and stream reset.
The host observes only active captures and emits invalidation when their source
changes; a fresh read always validates independently of events.

## Actions

`task.action` takes `{ref, snapshot_id, expected_revision, idempotency_key,
action, confirmation: "confirm_task_action", title?}`. `title` is required only
for `rename`, must be nonblank and is limited to 512 characters. Other actions
are `archive`, `delete`, and `run_commands`. The client displays the exact task,
action and captured configured commands before submitting confirmation. Archive
and delete retain the desktop eligibility rules and cleanup safety checks.
`run_commands` runs only the already configured commands against the captured
task execution targets. This operation cannot edit command configuration.

The host reserves the exact task and rechecks authorization, revision, context
and eligibility before effects. Durable idempotency records consume a key before
execution; replay never executes an action twice. A successful receipt returns
`{outcome: "applied", revision: expected_revision + 1}`; identical successful
replay returns `duplicate`. A consumed but incomplete receipt returns `conflict`
and requires desktop inspection, never automatic execution retry. Changed payload
with the same key is also a conflict. Receipt scope includes account and session.

The runtime must advertise an action only when its real desktop path is guarded.
Missing plans, absent configured commands, unsupported runtime, unavailable
provenance, and unsupported task kinds return explicit unavailability or omit
an ineligible action. No placeholder action reports success.

## Synthetic exchange

```json
{"contract_version":"2.0","type":"request","request_id":"request:task-1","account_id":"account:demo","operation":"task.get","body":{"ref":{"instance_id":"instance:demo","workspace_id":"workspace:demo","task_id":"task:sample"}}}
```

After rendering and confirming a successful task capture:

```json
{"contract_version":"2.0","type":"request","request_id":"request:rename-1","account_id":"account:demo","operation":"task.action","body":{"ref":{"instance_id":"instance:demo","workspace_id":"workspace:demo","task_id":"task:sample"},"snapshot_id":"snapshot:sample","expected_revision":4,"idempotency_key":"action:sample","action":"rename","confirmation":"confirm_task_action","title":"Add synthetic fixture"}}
```

The relay authorizes the delivery using the existing execute-before handshake.
Relays and clients validate request/response correlation with `validateExchange`.

## Addendum 1: cards and action authorization

`task.cards.list {instance_id, continuation?}` belongs to `task-details-1` and
returns a bounded page of `taskCard`. A card contains all descriptive fields of
`taskDetails` plus its task reference, but excludes snapshot ID, revision,
expiry, action availability and configured commands. Mobile uses this operation
for its task list, including description, plan/feature badges, draft and
finalization/merge state. It does not call `task.get` per row. One desktop catalog
read produces each page; no per-task plan, history or command-configuration read
is required. `tasks.changed` invalidates these pages for the instance. Bodies,
command preparation and mutations still require explicit detail reads.

Permissions are operation-specific and checked twice by the relay: at submission
and at every producer execute-before authorization. Reads require `supervise`.
Rename, archive and delete require `respond`. Running configured commands requires
both `respond` and `approve_tools`. `supervise` alone cannot mutate a task.

For task.action, the desktop sends `required_permissions` in the existing
authorize envelope. The relay independently derives the required set from the
stored immutable request, checks the live grant, and returns `granted_permissions`
in the authorized envelope. The desktop refuses effects unless that response
contains every required permission. A legacy relay that omits these fields cannot
execute task actions. Client-supplied permission claims are never authority.

## Runtime recovery limits

Interrupted Pilot actions leave consumed receipts and guarded recovery journals.
A desktop restart does not replay their deletion or plan-replication effects.
They require desktop inspection. Conversation deletion with pending code replay
is unavailable until that replay is resolved locally. The local journals retain
that pending state; no action reports success for partial cleanup. Revision and
receipt metadata are bounded to 2,000 records each and 1 MiB combined. At that
limit the host rejects new records explicitly instead of forgetting idempotency.

`commands` is an ordered confirmation list, including all configured setup commands in execution-target order, followed
by all run commands in the same order. A project can appear more than once; clients must display
all entries rather than deduplicate by project ID. Setup entries use a readable
`(setup)` suffix in `project_name`. If any command is withheld or truncated,
`run_commands` is unavailable. There are at most 32 total command entries.

The shared capture budget counts the cumulative full byte lengths of bodies read
across captures even though desktop retains their hashes rather than their text.
A successful action advances the persisted task revision even when it leaves task
metadata unchanged. Cancelling the producer lifecycle settles setup waits and
releases their subscriptions; an already launched native command is not replayed.

Once the desktop persists a pending action intent, every failure is returned as
`conflict`, including a later authorization or stale-revision error. Clients must
keep the uncertain intent and require desktop inspection; they must not retry
the partial action under a new idempotency key.

Native metadata reads use the `metadata_existing` filesystem scope. It resolves
only an existing metadata location and never initializes, repairs or migrates
`@macro`. Direct-project reads retain their existing `.macro` scope. Tool history
uses bounded native metadata projections and reads one requested detail; message
content, hidden context and provider replay are not selected into IPC.
The native trace projection rejects a message whose trace JSON exceeds 16 MiB
before JSON parsing. It returns at most 2,000 metadata entries with a 1 MiB
aggregate field budget. Each requested detail is limited to 1 MiB. A persisted
conversation revision changes with trace content, identity, ordering or ownership,
so equal-length edits invalidate earlier detail requests.

Project catalog and review resolution read the loaded desktop project store;
Pilot reads never call workspace bootstrap. Command reads request an
observation-only configuration snapshot. A newly discovered project document
must be loaded by the ordinary desktop lifecycle before Pilot can use it;
Pilot never creates or repairs approved configuration files during observation.
An existing action receipt also preserves `conflict` when a subsequent
request fails authorization or policy validation before reaching its effect.
