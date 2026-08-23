# Durable transition mapping

`SubagentTransitionRecorder` receives one serialized stream per child run. Each
transition includes `runId`, `parentConversationId`, a zero-based `sequence`,
the previous and current runtime states, the occurrence time, and the full
snapshot. An adapter should use `(runId, sequence)` as its idempotency key and
store transitions in sequence order.

Terminal transitions also carry the discriminated `result`. This is where an
adapter reads completed output, cancellation reasons, timeout data, normalized
errors, and final metrics.

The expected durable status mapping is:

| Runtime state | Durable status | Adapter notes |
| --- | --- | --- |
| `queued` | `queued` | Create or upsert the run and attach it to `parentConversationId`. |
| `running` | `running` | Record `startedAt`. |
| `completed` | `completed` | Persist optional output and metrics. |
| `failed` | `failed` | Persist the normalized error. |
| `cancelled` with `parent_cancelled` or `child_cancelled` | `cancelled` | Persist the cancellation reason. |
| `cancelled` with `runtime_disposed` | `interrupted` | The runtime stopped before normal completion. |
| `timed_out` | `timed_out` when supported, otherwise `interrupted` | Preserve `timeoutMs` so a later schema migration can distinguish timeouts. |

The runtime deliberately does not import a persistence adapter. Recorder
failures call `onTransitionError` and do not replace the child's terminal
result. Recorder promises are still awaited in sequence before the public
result settles, so rejected writes cannot become unobserved promises.
