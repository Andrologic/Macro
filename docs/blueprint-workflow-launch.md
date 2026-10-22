# Blueprint workflow launch

`src/services/blueprintWorkflowService.ts` connects canonical blueprint metadata
to the existing native Macro execution engine. It contains no UI, demo adapter,
provider implementation or independent scheduler.

## Calling contract

The application creates a project conversation through the existing conversation
API, then allocates a globally unique workflow plan ID once. Retain that scope
across retries. The conversation must belong to the selected project. The
blueprint reference includes the canonical **plan revision**, not the AgSDL
editor revision.

```ts
import { blueprintWorkflowService } from '../services/blueprintWorkflowService';

const scope = {
  owner: { projectId, planId: crypto.randomUUID(), branch: targetBranch },
  conversationId: conversation.id,
};
const request = {
  scope,
  blueprint: {
    branchName: blueprintBranch,
    planId: blueprintPlan.id,
    revision: blueprintPlan.revision,
  },
  prompt: 'Inspect the synthetic project and report the result.',
};

const result = await blueprintWorkflowService.launch(request);
// Only result.snapshot proves a Start was admitted. Inspect result.intent.state
// for a pending submission, refusal, or previously discarded request.

// After a lost response or application restart, recover the retained scope from
// the workflow plan metadata. Never allocate a replacement plan ID to retry.
const recovered = await blueprintWorkflowService.resume(scope);
```

`prepare(request)` persists the independent copy without starting an Agent. This
is an application service method, not a required user-facing preparation step.
The copy can be completed through normal versioned metadata mutations before
calling `launch` with the same scope and blueprint reference. No workflow name
is required; the blueprint label is reused.

The service accepts a blueprint scoped to the selected project or an unscoped
shared library blueprint. Copies use the existing metadata creation transaction,
with `setActive: false`. The reusable blueprint and active Architect plan remain
unchanged. Exact AgSDL source bytes, annexes and presentation are copied.
Historical Task identities and statuses are removed from the copied display
metadata. `design.origin` records the original branch, plan and revision.

## Admission and recovery

1. Validate the retained workflow plan, project and conversation scope. Reuse a
   matching copy after a lost metadata acknowledgement or concurrent creation.
2. Read the native intent before compiling a new request. A retained request
   retains its source and input, even if the blueprint has since changed.
3. For a first Start, run native preflight against the copy's exact source SHA
   and canonical plan revision. Missing configuration or unsupported language
   constructs cannot stage an execution.
4. Persist and submit an intent through `execution_stage_intent` and
   `execution_submit_intent`. Its deterministic ID is
   `blueprint-start:<workflow-plan-id>`. The existing native coordinator owns
   admission and survives loss of its caller.
5. Verify the admitted historical snapshot and projection before acknowledging
   the intent. A read failure leaves the admission recoverable. Closed intents
   retain their admission, so a lost Close acknowledgement is recoverable too.

`resume(scope)` reads the retained native request, not today's form or blueprint.
It explicitly attempts a pending submission once. There is no background retry
loop. Pending, refused and discarded states are returned without claiming an
execution started. Reusing the identity with a different prompt is rejected.

## Supported execution scope

The service does not extend `macro-serial-inline-v1`. Providers, models, permissions
and external tool scopes remain subject to the native catalogue and compiler.
It does not infer missing provider settings or copy credentials.

A flow with an entry currently needs its initial text prompt. A graphless system
can be captured without an initial delivery; subsequent input uses the existing
delivery API. Passing a prompt to a graphless Start is rejected rather than
silently dropping it. Human input steps, presets, parallel composition,
creation of Git worktrees, and UI button wiring remain outside this backend lot.

## Native Agents in the Operate task catalogue

`workflowAgentTasks.ts` projects native Agent instances into the existing Task
contract. A copied system is identified by `design.kind: system` and its retained
blueprint origin. Library blueprints produce no execution Tasks. Discovery includes
draft copies because the native journal, not the editable plan status, proves
execution. An unreadable AgSDL plan rejects a catalogue refresh instead of silently
removing its Tasks. Known workflow branches remain discovery candidates through
discovery outages; an unreadable index on such a branch rejects the refresh too.
Existing rows remain available in the store.

Each Task has `task_source: agsdl` and a `workflow_execution` reference containing
the exact source revision, system Start ID, Agent instance ID, activation IDs and
native cursor. Its ID is `task:agsdl:v1:<encoded-start-id>:<encoded-instance-id>`.
Repeated visits, retries and deliveries to the same instance reuse that Task.
Different executions remain separate. Pure, Call and Condition steps create no
Agent Tasks. No duplicate database record or independent Task status is written.

| Native Agent state | Task status | Requires attention |
| --- | --- | --- |
| Idle without a delivery | Blocked | No |
| Queued | Pending | No |
| Active | InProgress | No |
| Pending approval | AwaitingResponse | Yes |
| Uncertain | Blocked | Yes |
| Stop requested or confirmed | Blocked | No |
| Last visit completed | Completed | No |
| Last visit failed | Failed | Yes |

Unresolved work takes precedence over previous completed visits. Queue sequences
are compared as exact decimal strings. All native projection pages and approvals
must be read before deriving absence or completion. A stale cursor, mismatched
source or incomplete approval read cannot publish a new Task projection.

`useTaskStore.refreshWorkflowTasks()` refreshes only executions already present
in the catalogue. Its lifecycle-owned monitor runs read-only checks every three
seconds in Operate with a native runtime. Checks never overlap or submit work.
A failed read preserves the last native reference, marks it stale and exposes
the Task as Blocked with attention required. The next verified read restores its
state. Responses from a previous project, older refresh or disposed lifecycle
cannot replace current Tasks. New executions are discovered through the normal
catalogue refresh.

`loadTaskExecutionGraph()` opens that Task's exact captured run. Agent declarations
and every matching flat flow step resolve to the same Task identity, without
guessing from display names or the latest blueprint revision.

These Tasks are supervision projections. They have no independent conversation
or Git worktree. Legacy chat dispatch, startup, status mutation, review and merge
paths reject them with `NATIVE_WORKFLOW_OWNED` before side effects. Selection does
not block deferred messages belonging to another Chat conversation. Input,
approval and Stop still belong to the existing native execution API; this lot
does not add per-Agent UI controls or conversations.

## Validation

- `blueprintWorkflowService.test.ts` combines the real AgSDL compiler with
  controlled native transport. It covers exact source, capability refusal,
  completing a prepared copy, concurrent identity reuse, lost Stage/Start/Close
  acknowledgements, mismatched receipts and historical recovery.
- `architectPlanService.test.ts` exercises the real metadata creation, cache
  reload and mutation services. Editing the blueprint after creation cannot
  change the workflow copy or create an extra copy on retry.
- The existing Rust `db::agsdl_execution::tests::intent_*` tests cover real SQLite
  atomic admission, reservations, file reopening and acknowledgement loss.
- `workflowAgentTasks.test.ts`, `loadImplementTaskCatalog.test.ts` and
  `workflowTaskMonitor.test.ts` cover identity reuse, distinct runs, pagination,
  exact sequence ordering, native states and read-only refresh lifecycle.
- Store, graph, startup and file review tests cover integration with Task
  selection, failures, scope changes, deferred Chat messages and legacy guards.

These automated checks do not claim a new live-provider or UI qualification.
The backend can be integrated independently of the ongoing interface changes.
