# Macro Connect measurement protocol

This is the desktop-owned part of implementation-plan point 6. It defines the
shared format and fixtures before behavior changes. It does not establish the
complete three-runtime baseline. Mobile and relay adapters and physical-device
validation follow separately. No production observations or quotas change here.

## Reproduce the native component

Use the pinned Bun, local dependencies and an offline-compatible Cargo cache.
The public conformance helper requires the declared direct dev dependencies
`ajv` 8.20.0 and `ajv-formats` 3.0.1. JavaScript consumer adapters pin both
directly; Dart adapters run their emitted JSON through that helper as a separate
conformance check. An installation from cached packages must use the frozen
lockfile, disable lifecycle scripts, and run with network access denied.
A reused hoisted node_modules alone does not prove import reproducibility.
From a clean committed desktop worktree, write all reports outside Git:

```sh
bun --no-install test dev/performance/connect-metrics.test.ts dev/performance/native-sqlite.test.ts
bun --no-install dev/performance/native-sqlite.ts --self-test > /tmp/connect-native-self-test.json
bun --no-install dev/performance/native-sqlite.ts > /tmp/connect-native-1.json
bun --no-install dev/performance/native-sqlite.ts > /tmp/connect-native-2.json
bun --no-install dev/performance/native-sqlite.ts > /tmp/connect-native-3.json
bun --no-install dev/performance/connect-report.ts <mobile-SHA> <relay-SHA> /tmp/connect-native-1.json /tmp/connect-native-2.json /tmp/connect-native-3.json > /tmp/connect-desktop.json
```

Run only one Cargo build in the chantier at a time. Announce it before starting.
The existing runner builds locked/offline with one job and its reduced debug
settings, verifies source and nonce in a privately staged executable, and rejects
source drift. Reuse its path, integrity, persisted metadata, reopen and cleanup
checks. The native process opens only its own temporary SQLite files. It starts
no app, provider, account, OAuth, keyring or remote service. A missing offline
dependency is a failed validation, never a substituted fixture result.

Reads execute the current real `repository::list_messages` with SQLx and the
current migrations. Each fresh process seeds 100, 1,000 and 10,000 messages,
256 ASCII bytes each. Preparation is outside timing, followed by 10 warmups and
100 measured reads and writes per size. Writes include metadata and commit;
rows grow to N+110. The SQLx pool retains WAL/NORMAL and its existing settings.
Read timing includes row materialization and conversion. It excludes result
validation/destruction, capture building, bounded export admission, IPC, HTTP,
UI, pagination and memory. Warm operations do not imply a warm process, cold
disk, stable machine or production profile. Full-history reads of 10,000 rows
are diagnostic stress inputs; they are not a promise that the bounded Connect
export admits that history. A refused export remains a meaningful result.

The summary attaches those two real operation metrics only to the native
component of `history-pagination`. Every other requested phase is explicitly
`not-measured`, with its recipe. Listing six recipes is not six executed product
scenarios. The raw native reports retain exact source/binary provenance. Review
and publish measured values only after those commands actually succeed.

## Six scenario recipes

The canonical fixture sizes, timestamps, target names, steps and network values
are in `contracts/macro-connect/metrics/v1/profiles.json`. `fixtureMessages`
creates identical ordered data; `scenarioSchedule` supplies stable event order
and deterministic interruption events. It does not execute product code.
Target names are synthetic. A runner maps them to its isolated test instances.
Shared message IDs include the active/other conversation name and are unique
across both conversations. A focused test installs them simultaneously against
Macro's actual SQLite schema. The unchanged native benchmark uses a single
conversation and its own seed IDs, tracked by a separate fixture definition
hash. Its report projection requires an explicit `ms` unit on both native
summaries; missing or other units are rejected before any numbers are copied.

| Scenario | Adapter actions and readiness boundary | Observe separately |
| --- | --- | --- |
| `idle-hidden` | Hide the content surface for the declared window, preserving its lifecycle. End at window expiry. | Producer and consumer requests/waits, wakeups, DB reads, bytes and retained resources, native RSS and heap. |
| `cold-open-return` | Fresh isolated process opens active chat, switches to other chat and returns. Resolve each action only when its final expected message is committed to the UI. | DB read, capture, transfer, UI apply and last-message latency, cold and warm series separately. |
| `visible-unrelated-update` | Keep active chat visible, append first to other chat, then active chat. Inject ordered error, interaction and finish events. | Read sources, rebuilt captures, useful/envelope bytes and the exact ordered terminal event sequence. |
| `foreground-reconnect` | Background/foreground around deterministic disconnect/reconnect events. Retain an uncertain synthetic intent until reconciliation. | Connection, negotiation, reconciliation, unavailability, cursor resets and pending intents. Lost ACK must not trigger a second effect. |
| `history-pagination` | Open long history, request two previous pages, return to recorded reading position. Record native admission refusals rather than increasing limits. | Predecode and IPC bytes, retained messages, JSON copies, DB reads, active position, capture/native latency and process memory. |
| `multiple-targets` | Open all three targets concurrently, with `pc-slow` delayed. Update/fail the slow target while active target remains readable. | Per-target subscriptions and wait distributions, cumulative process memory, retained objects, uncertain intents and isolation of failures. |

Execute each recipe against loopback, simulated RTT and deterministic
interruption profiles, for every fixture size. The schedule lasts ten seconds
so existing one-second retry loops have multiple opportunities to wake. RTT
100 ms, slow-target RTT 1,000 ms and the one-second interruption are declared
stress inputs, not observed network conditions or chosen optimal budgets.
Loopback uses an actual ephemeral local listener when a transport adapter is
available. Simulated delay and outage events must keep `simulated` evidence for
model timings; wall-clock operation durations remain measured only when the
actual runtime and observer ran. Never label a synthetic clock as SQLite cost.

For each adapter, retain a 10-warmup/100-observation warm series in three fresh
processes, and a separate cold-process series with preparation explicitly included
or excluded. Preserve failed/time-out observations and their structured outcome
in local evidence; do not silently remove them from successful latency summaries.
The shared aggregate format currently carries successful distributions and
missing phases, so its raw evidence must accompany failure-rate analysis.
Record timing boundaries and load, then compare the median of process p50 and
p95 separately. Do not sum phase percentiles or pool process samples.

Separate native/producer/consumer counters. Count HTTP compressed wire bytes,
decoded response bytes, useful payload bytes and IPC JSON bytes independently;
if an API hides compression, mark wire bytes non measured. Count copy operations
where performed; serialized size cannot reveal allocation count. RSS comes from
the native process observer; heap comes from the runtime heap API. A retained
serialized estimate remains an estimate and excludes shared-object identity,
decoded images and temporary copies. Physical-phone RSS/heap and foreground
behavior remain a later device recipe, not a fixture-derived number.

## Budgets and non-regression policy

Existing numeric guards are retained as product constraints, not measured memory
budgets or performance targets:

| Guard | Existing value and source | Interpretation |
| --- | --- | --- |
| Conversation capture serialized quota | 67,108,864 bytes, `conversationCaptures.ts::MAX_QUOTA` | Existing capture admission/accounting guard, not native RSS or cumulative mobile budget. |
| Native bounded transcript admission | 4,194,304 estimated bytes, `repository.rs::list_messages_bounded` | Conservative SQL estimate before loading rows. Refusal is recorded. |
| Kernel retained journal | 2,000 events per stream, 128 streams/pages, `macroPilot/README.md` | Existing retention limits, not a measured cumulative-memory bound. |

Proposed initial comparison policy fixes the p95 ratio ceiling at 1.0 for each
measured operation under the same fixture/profile/toolchain. This is a strict
no-increase policy, not a measured optimum or a flaky automatic merge gate.
If repeated fresh-process measurements cross it, investigate variance before
accepting a regression or claiming a gain. Keep the measured native reference
as the numeric ceiling for its exact configuration. Establish a later tolerance
only from repeated control runs, before the corresponding behavior changes.

For terminal events, missing/duplicate/reordered events have a proposed budget
of zero. An unrelated target failure must cause zero resets on the healthy
stream. Proposed subscription budget is one shared consumer feed per target,
matching plan point 7. These are correctness and architecture policies; they
are not results from this desktop runner. `compareMetric` refuses missing,
simulated and estimated observations as evidence for a real gain.

Cumulative RSS/heap, idle request/wakeup rates, HTTP/IPC transfer, reconnect and
UI latency have no measured numeric ceiling yet. They remain pending until
adapters produce their own references. Do not replace them with the capture
quota, allocate a fictional optimum, or announce gains in those costs. This
partial desktop delivery does not close point 6 for the three-runtime project.


## TypeScript producer library reference, A4a

From clean committed sources, run three sequential fresh processes:

```sh
bun --no-install test dev/performance/connect-producer.test.ts dev/performance/connect-metrics.test.ts
bun --no-install dev/performance/connect-producer.ts <mobile-SHA> <relay-SHA> > /tmp/connect-producer-1.json
bun --no-install dev/performance/connect-producer.ts <mobile-SHA> <relay-SHA> > /tmp/connect-producer-2.json
bun --no-install dev/performance/connect-producer.ts <mobile-SHA> <relay-SHA> > /tmp/connect-producer-3.json
```

Each process runs six recipes at 100/1,000/10,000 messages, 10 warmups and 100
retained samples per cell. Classes are the actual ConversationCaptures,
ContentHost and ConversationInteractions; source and CAS ports are synthetic
memory. No native IPC, SQLite, HTTP, UI, credentials or provider is used.
The source fingerprint covers tracked frontend sources, contracts, tooling and
lockfiles, with clean HEAD checks before and after. Every public response/event
uses actual product validation. The producer guard is called before recording
a conversation response. Unexpected failures abort with cell/sample context;
expected stale/expiry/source-failure refusals are retained in raw samples.
Each completed cell is checkpointed with its samples to stderr outside timed
windows, so a later failure preserves partial evidence without emitting a
completed full report.

The business clock follows the recipe schedule without waiting ten real
seconds. Idle uses ten manual observations, not runtime wakeups. History also
checks stale continuations and TTL expiry at 300001 ms. The 100-message history
fits one page and explicitly reports that condition. Slow-target isolation uses
a promise barrier and an explicit memory source failure, not a claimed network
RTT. Healthy continuations remain usable after that failure. Cold-open-return includes host
initialization, while fixture construction is always excluded. The measured
capture API timer includes source clone/observation and public API overhead,
but not output JSON observation after its return. Scenario wall time includes
the harness checks and byte observers. Do not subtract their percentiles.

Source calls, new returned captures, public text bytes and serialized JSON sizes
are measured/estimated under their declared boundaries. The serialized sum
includes request, result and event observations and repeated attempts; it is
not transport framing or allocated memory. The invalidation trace preserves
phase/kind/sequence and the error/interaction/final state assertions. It does
not claim to observe dedicated run terminal events; terminal_events remains
not-measured until A4b. No synthetic metric substitutes for A2 SQLite timings.

Proposed pre-C policy: zero increase in source calls or public snapshot creation
for an identical recipe, stable content/revisions, zero missing or reordered
observed invalidations, zero progress failure for healthy targets under the
slow barrier. For capture API timing retain the A1 p95 ratio 1.0 at the same
boundary and configuration, with process dispersion and investigation of
variance. Numeric ceilings are populated only from executed measurements.
Refusals and quotas are kept; no gain or end-to-end baseline is established.
