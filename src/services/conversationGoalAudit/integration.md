# Goal audit adapters

`GoalAuditCoordinator` is independent from React, provider selection, and global stores. A caller supplies a `ChildTurnExecutor<GoalAuditChildInput, unknown>` and a compare-and-swap `GoalAuditVerdictPort`. The child input contains the `goal_auditor` profile, its system prompt, the serialized compact context, depth one, and the effective read-only capabilities approved by `subagentPolicy`.

`createGoalAuditProviderExecutor` uses the existing provider streaming pipeline through injected ports. Its required `resolveChildConversation` port must create or resume a durable conversation for `(runId, parentConversationId)`, honor the abort signal, and return that conversation's id with the same run and parent ids. The executor checks this binding and uses the returned id for provider `conversationId`. It sends the system prompt and compact context, intersects read capabilities with the canonical `goal_auditor` tool allowlist, and rejects all other tool calls. No caller or durable journal is wired yet; the journal integration must record the resolved child conversation id in `agent_runs`.

`GoalAuditJournal` matches the ordered `SubagentTransition` lifecycle. `registerRun` runs before the queued transition and supplies the metadata required by the Rust repository. The future IPC adapter should map transitions as follows:

| Runtime event | Rust repository call |
| --- | --- |
| `registerRun`, then `queued` sequence 0 | `create_agent_run` with the registered id, parent conversation, `goal_auditor`, depth 1, prompt, and model metadata |
| `running` | `start_agent_run` with the optional provider child conversation id |
| `completed` | `complete_agent_run`, using `result_json` for structured output or `result_text` for text and copying metrics into usage |
| `failed` | `fail_agent_run` with the normalized code, message, details, and usage |
| `cancelled` | `cancel_agent_run`, preserving `parent_cancelled`, `child_cancelled`, or `runtime_disposed` as the reason |
| `timed_out` | `timeout_agent_run` with `deadline_exceeded` and usage |

The adapter must serialize calls per run, reject a transition whose sequence is not the next expected value, and make `(runId, sequence)` idempotent at the IPC boundary. No Tauri command exposes these repository functions yet, so `InMemoryGoalAuditJournal` is the current implementation and durability is not end to end.
