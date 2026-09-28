# Goal audit adapters

`GoalAuditCoordinator` is independent from React, provider selection, and global stores. A caller supplies a `ChildTurnExecutor<GoalAuditChildInput, unknown>` and a compare-and-swap `GoalAuditVerdictPort`. The child input contains the `goal_auditor` profile, its system prompt, the serialized compact context, depth one, and the effective read-only capabilities approved by `subagentPolicy`.

`createGoalAuditProviderExecutor` uses the existing provider streaming pipeline through injected ports. Its required `resolveChildConversation` port must create or resume a durable conversation for `(runId, parentConversationId)` and return that conversation's id with the same run and parent ids. The executor checks this binding and uses the returned id for provider `conversationId`. It sends the system prompt and compact context, intersects read capabilities with the canonical `goal_auditor` tool allowlist, and rejects all other tool calls.

The executor passes the abort signal to provider resolution, child resolution, read tools, and streaming. Its own wait settles on abort even if a port stays pending, and it ignores later progress callbacks. Each port still owns cleanup of work it started, including network requests, database writes, and tool effects. Settling the executor cannot stop a port that ignores the signal.

`DurableGoalAuditJournal` records ordered `SubagentTransition` events through Tauri IPC. `registerRun` runs before the queued transition and supplies the metadata required by the Rust repository. Each transition and its `agent_runs` projection are committed in one SQLite transaction. Replaying the same `(runId, sequence)` and payload is idempotent; conflicting or skipped transitions fail. The mapping is:

The runtime waits for the durable `queued` claim before scheduling, for `running` before calling the child executor, and for the terminal transition before returning success to the coordinator. Journal failure or an unconfirmed write returns a local `SUBAGENT_CLAIM_FAILED` or `SUBAGENT_JOURNAL_FAILED`; it never authorizes a verdict. These waits use an abort signal and a 10-second default ceiling, configurable through `transitionTimeoutMs`. SQLite validates the parent's depth when inserting `queued`, before any child link. Cancelling a wait cannot roll back an IPC call already in flight: its port must stop or reconcile late effects, and an interrupted write may leave an indeterminate durable state requiring inspection by run id. The verdict port must likewise honor its abort signal and revision compare-and-swap; the coordinator will not report a late `applied` result after cancellation, but cannot undo an external side effect already committed by a non-cooperative port.

An asynchronous `registerRun` is also bounded to 10 seconds and stopped by audit cancellation. If registration is unconfirmed, the coordinator returns `JOURNAL_REGISTRATION_FAILED` without starting a child. A late registration may still complete in its port; the port owns cleanup of that preflight state. The durable Tauri journal registers synchronously.

| Runtime event | Rust repository call |
| --- | --- |
| `registerRun`, then `queued` sequence 0 | Insert the run with its registered id, parent conversation, `goal_auditor`, depth 1, prompt, and model metadata |
| `running` | Start the run; the child conversation is linked after resolution and before streaming |
| `completed` | Store structured output or text and copy metrics into usage |
| `failed` | Store the normalized code, message, details, and usage |
| `cancelled` | Preserve `parent_cancelled`, `child_cancelled`, or `runtime_disposed` as the reason |
| `timed_out` | Store `deadline_exceeded` and usage |

`createDurableGoalAuditCoordinator` composes the journal with the provider executor. It validates the resolved child conversation and links its id to `agent_runs` before provider streaming. The resolver remains responsible for creating or resuming the conversation and for cleaning up effects started before an abort. The UI trigger is still undecided; callers can construct the coordinator explicitly.
