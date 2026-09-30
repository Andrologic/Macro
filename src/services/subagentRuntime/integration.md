# Durable transition mapping

`SubagentTransitionRecorder` receives one serialized stream per accepted child
run. Each transition includes `runId`, `parentConversationId`, a zero-based
`sequence`, the previous and current runtime states, the occurrence time, and
the full snapshot. An adapter should use `(runId, sequence)` as its idempotency
key and store transitions in sequence order.

The initial `queued` transition is a durable claim. The runtime waits for it
before starting the executor. Adapters that need a dedicated insert or claim
operation should implement `claimRun`; older adapters may keep handling this
transition in `recordTransition`. A rejected claim, including a duplicate
durable `runId`, produces an in-memory `SUBAGENT_CLAIM_FAILED` result and never
starts the executor. The runtime does not try to persist a terminal transition
for a run it failed to claim.

Depth, parent id, timeout, and concurrency policy validations happen before the
claim. Invalid requests return a local failed result and do not emit a durable
`queued` transition.

Terminal transitions also carry the discriminated `result`. This is where an
adapter reads completed output, cancellation reasons, timeout data, normalized
errors, and final metrics.

The expected durable status mapping is:

| Runtime state                                            | Durable status                                      | Adapter notes                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `queued`                                                 | `queued`                                            | Create or upsert the run and attach it to `parentConversationId`.                                               |
| `running`                                                | `running`                                           | Record `startedAt`.                                                                                             |
| `completed`                                              | `completed`                                         | Persist optional output and metrics.                                                                            |
| `failed`                                                 | `failed`                                            | Persist the normalized error.                                                                                   |
| `cancelled` with `parent_cancelled` or `child_cancelled` | `cancelled`                                         | Persist the cancellation reason.                                                                                |
| `cancelled` with `runtime_disposed`                      | `cancelled`                                         | Graceful disposal aborts active work, waits for executor cleanup, and records `runtime_disposed` as the reason. |
| `timed_out`                                              | `timed_out` when supported, otherwise `interrupted` | Preserve `timeoutMs` so a later schema migration can distinguish timeouts.                                      |

If a claimed run times out before reaching the executor, the runtime records a
`running` transition immediately before `timed_out`. This preserves the durable
state-machine invariant that a timed-out run has a start timestamp and attempt,
without invoking the child executor.

The runtime deliberately does not import a persistence adapter. It waits for
`running` to be confirmed before calling the executor and for the terminal
transition before returning a successful result. A rejected, aborted, or
unconfirmed post-claim write returns a local `SUBAGENT_JOURNAL_FAILED` result;
`onTransitionError` is diagnostic only. These waits are cancellable and bounded
to ten seconds by default. An IPC write may still finish after its local wait
ends, so callers must inspect the durable state by `runId` before retrying.

Completed output contains either `text` or `structured`, never both. The runtime
also checks this at runtime and converts an invalid adapter response to
`AMBIGUOUS_CHILD_OUTPUT`. Final executor metrics are retained on completed,
failed, cancelled, and timed-out results and snapshots.
