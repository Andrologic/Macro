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
silently dropping it. Human input steps, presets, parallel composition, workflow
Task projections, creation of Git worktrees, and UI button wiring are outside
this backend lot.

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

These automated checks do not claim a new live-provider or UI qualification.
The backend can be integrated independently of the ongoing interface changes.
