# Performance baselines

These developer runners separate synthetic JavaScript work, in-memory SQLite,
native SQLx on disposable files, and production bundle output. Dated sections
identify the measured revisions and limitations. Fixtures contain generated
text only. No provider or ordinary application profile is opened. The bundle
runner also applies the existing size budgets; a completed build can fail that
gate.

## Reproduce the executed measurements

Use the repository's pinned Bun and already installed dependencies. From the
repository root:

```sh
bun --no-install dev/performance/run.ts > /tmp/macro-performance-baseline.json
bun --no-install test dev/performance/performance.test.ts
NODE_ENV=production bun --no-install dev/performance/build-bundles.mjs > /tmp/macro-bundle-baseline.json
```

The JSON reports belong outside Git. The runner records the source HEAD, dirty
flag, UTC timestamp, OS, CPU, memory, Bun/SQLite versions, SQL/schema hashes,
p50/p95/max and sample counts. Compare the same source, toolchain and fixture
sizes. The bundle command builds the real Vite configuration into a fresh
system temporary directory, limits Terser to two workers, reports raw and gzip-9
JS/CSS sizes and content hashes, then removes that directory. It captures the
final emitted chunk graph, deduplicated static JS closure and CSS links.
The report distinguishes pre-minification module lengths from emitted sizes.
It verifies every emitted locale default against its source JSON, records xterm
CSS rules and checks that Mermaid/xterm JavaScript stays outside the static
startup closure. Dynamic imports executed at startup and rendering are not
inferred from this graph. The existing budget checker runs against this same
temporary build; a budget or deferred-vendor failure returns exit code 1. It requires a clean worktree, including untracked
files, and refuses ignored environment/source/public inputs. Commit the tooling
before running this command. It does not build
Rust or a desktop release. A standalone scanner is available for existing
artifacts, but its source SHA is a caller attestation, not verified provenance:

```sh
bun --no-install dev/performance/bundles.ts <build-directory>/assets <40-character-source-SHA>
```

Run cases sequentially with other heavy work stopped for comparison. Each case
has 10 unreported warmups and 100 measured samples. Percentiles use nearest rank
on sorted samples, including outliers. Construction/seeding is outside timing;
allocation and GC during the operation remain inside. This first run used a
shared machine; it is not a stable regression threshold. Repeat in three fresh
processes before making an optimization decision. No forced GC or subtraction
of harness overhead is applied.

## Fixture and product linkage

| Metric | Actual executed path | Fixture and limits |
| --- | --- | --- |
| Chat history list | `src/components/chat/transcriptItems.ts::buildChatTranscriptItems` | 100/1,000/10,000 messages, 256 ASCII bytes each, alternating user/assistant, one completed compaction event per 100 messages. Includes item allocation and event grouping; excludes React, layout, markdown and virtualizer. |
| Terminal history search | `src/services/terminalSearch.ts::findTerminalSearchMatches`, called by `terminalRuntime` | 100/1,000/10,000 synthetic rows, 120 ASCII columns, one case-insensitive match per row. Buffer adapter supplies strings; excludes xterm rendering, ANSI parsing and real buffer extraction. These sizes are stress inputs, not a claim about configured scrollback. |
| SQLite read | First literal SQL in `src-tauri/src/db/repository.rs::list_messages`, extracted at run time | Canonical `001_initial.sql` at the recorded baseline, one conversation, 100/1,000/10,000 messages of 256 ASCII bytes, identical timestamps with distinct ordered IDs. Reads all rows via Bun SQLite. |
| SQLite insert | First literal SQL in `repository.rs::create_message`, extracted at run time | One new message, BEGIN/INSERT/ROLLBACK per sample to keep size fixed. Includes transaction overhead. Excludes conversation metadata refresh, Rust/SQLx conversion, pool contention, disk sync, later migrations and IPC. This is **not** a durable write or the complete `create_message` operation. |
| Architect instrumentation disabled | `createArchitectSwitchPerfRuntime({ enabled: false }).measureSwitchPhase` | 10,000 callback calls per batch, compared with direct calls. Injected clock/logger/mark throw if used; callback result and empty report list checked. |
| Performance hook disabled | Real `usePerformanceMonitor` rendered with React SSR | Compared with an empty SSR component. Bun has no Vite DEV flag, so mark/measure take the disabled path. Includes hook allocation, React and assertions; effects do not run. Does not prove browser mount overhead. |

The current statement runner also applies `006_generation_attempts.sql` before executing the current message queries. Its schema fingerprint includes both SQL files. The earlier measurements below retain their recorded schema; this maintenance change does not supply new performance measurements.

The SQL extractor fails when a named function or literal is absent. Hashes expose
query/schema drift; this is not a parser for arbitrary Rust. The focused tests
check fixture execution, percentile semantics and transport instrumentation
preservation, including errors and unfinished calls.

The existing `dev/architect-switch-perf.ts` remains a separate synthetic service
harness. Its injected storage and manually signalled visual readiness must not
be interpreted as measured Tauri navigation. It is not executed by this runner.
The runtime collector reuses `architectSwitchPerf` reports and
`usePerformanceMonitor`'s `getPerformanceReports`, instead of defining competing
product timers.

## Executed reference

Run UTC 2026-09-19 21:33, Darwin 27.0.0 arm64, Apple M5, 10 logical CPUs, 16 GiB,
Bun 1.3.14, SQLite 3.54.0. Product base
`e04166a436be45ec91836dbaa2ff3ca2e3b42e48`; worktree dirty only with this benchmark
addition. Values below are milliseconds, p50 / p95. These are **executed
synthetic microbenchmarks**, not desktop navigation results.

| Elements | Chat items | Terminal search | SQLite read | SQLite insert + rollback |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.029 / 0.179 | 0.272 / 0.712 | 0.087 / 0.112 | 0.015 / 0.038 |
| 1,000 | 0.175 / 1.197 | 2.648 / 12.013 | 0.935 / 4.095 | 0.013 / 0.016 |
| 10,000 | 1.802 / 22.043 | 40.113 / 85.971 | 15.205 / 30.817 | 0.014 / 0.021 |

For 10,000 calls, the direct batch measured 0.030 / 0.032 ms, disabled Architect
wrapper 0.036 / 0.104 ms. Empty SSR measured 0.022 / 0.150 ms and disabled hook
SSR 0.019 / 0.041 ms. The lower hook time demonstrates noise/order/JIT effects;
do not interpret it as negative overhead. This is a smoke measurement, not a
nanosecond estimate. New tooling is exclusively under `dev/performance`, with no
imports from the production graph, so an uninstalled probe adds no production
branch, allocation, serialization or timer. Existing monitor behavior is unchanged.

## Executed bundle reference

The frontend build completed on the same environment and product base. All
direct dependency versions in the reused installation matched `package.json`.
The build emitted 183 JS/CSS files: 9,194,298 bytes raw, 2,603,100 bytes summed
per-file gzip-9. This total includes lazy chunks and every emitted locale, not
initial-load transfer. Fonts, native binaries, source maps and framing are excluded.

| Emitted file | Raw bytes | Gzip-9 bytes |
| --- | ---: | ---: |
| `index-CUQKh7pG.js` | 1,452,987 | 380,078 |
| `index-BKJ8jfQz.css` | 105,516 | 18,914 |
| `ChatZone-BeOd-Obi.js` | 117,648 | 35,455 |
| `TaskQueue-CrV5j6nh.js` | 60,630 | 17,876 |
| `MarkdownRichContent-CnCMovbT.js` | 10,736 | 3,893 |

Vite warned about mixed static/dynamic imports of `tauriRuntimeBridge` and a
chunk above 1,200 kB. The measured largest `index` chunk exceeds the existing
1,425,000-byte entry budget in `dev/check-bundle-size.mjs` by 27,987 bytes.
This is an observation on the unchanged product base, not a new regression
introduced by this developer-only tooling. The temporary output was removed;
the bundle budget command itself was not run against `dist`. Investigate this
base/toolchain result before changing chunk boundaries or relaxing a budget.

## Runtime measurements still absent

| Metric | Status | Required experiment |
| --- | --- | --- |
| Workspace / chat / terminal visual navigation p50/p95 | Unavailable | Native desktop, isolated synthetic profile, readiness predicate per action, 10 warmups + 100 measured switches for each size and cold/warm state. |
| IPC volume and latency | Unavailable | Native probe below. Report call counts, command p50/p95, failures and JSON argument/result bytes. These bytes exclude IPC framing and events. |
| Catalog invalidation fanout and reload cost | Unavailable | Measure a single plan rename/save, count `workspace_architect_invalidate`, then measure first and second catalog opens separately. Record scope, plan/task counts, cache hit state and calls. Native invalidation count does not count frontend Map deletions or prove cache correctness. |
| Durable SQLite read/write | Unavailable | Execute native commands on a disposable database with the same schema/version; include metadata refresh, SQLx and disk commit. Record journaling/synchronous modes and storage. |
| React list rendering, chat RAF streaming, terminal attach/paint | Unavailable | Browser/native trace and real component tree. Synthetic item/search timings do not measure these. |

No desktop runtime or UI automation was used. A native isolated fixture profile
and visual-ready driver are still required; this lot does not provide an
end-to-end navigation seeder. Do not attach the probe to an ordinary user profile.
The browser bridge transport is deliberately unsupported by the native probe;
there is no fabricated IPC result or zero reported for a missing metric.

### Native capture protocol

Use a disposable native development profile with synthetic content only, no
configured providers and no user projects. Seed two synthetic workspaces,
conversations of the documented sizes and terminal tabs with generated text.
For catalog experiments use 10 and 100 plans with 10 tasks each; record that
these are a separate fixture from chat history. Keep project files in temporary
repositories and clear their data after the experiment. Isolation must be
established before launching the app; this protocol does not authorize opening
an existing user database. The QA browser launcher uses its configured ports 1422 and 1430. The current
collector requires native Tauri and does not measure that browser bridge.

In native development DevTools, manually import the module:

```js
const { installNativeProbe, existingMonitorSummary } =
  await import('/dev/performance/native-probe.ts');
const { distribution } = await import('/dev/performance/stats.ts');
const probe = installNativeProbe(window.__TAURI_INTERNALS__, true);
// Supply a driver that triggers the real UI action and resolves after readiness.
const sample = await probe.measure(async () => {
  await driver.switchConversationAndWaitForTranscript();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
// Aggregate 100 successful, same-scenario samples; retain failures separately.
// distribution(samples.map(sample => sample.actionMs))
probe.uninstall();
const monitorSummary = existingMonitorSummary();
```

`driver` is intentionally a required integration supplied by the UI experiment,
not an implemented API. Workspace readiness means selected project and panels
match the target; chat readiness means the target transcript is committed;
terminal readiness means the selected tab is attached and its expected final
line is present. Two RAFs alone are insufficient. Record failures/timeouts
rather than dropping them silently. Use distinct cold process and warm-repeat
series; do not clear production caches to manufacture a warm result.

Install before the scenario; avoid concurrent user actions. The probe counts
calls started inside the action, preserves return values and rejected errors,
and refuses overlapping samples, uninstall during pending calls, and samples
whose calls remain pending at the boundary. It excludes earlier in-flight IPC,
late calls scheduled after readiness, push events and the browser HTTP bridge.
Application background calls inside the window remain counted; run an idle
control window to quantify them without subtracting blindly. Per-command timing
ends before response sizing; action timing includes probe overhead. JSON sizing
can allocate substantially for large responses. Run latency-only UI traces with
the probe uninstalled as a control. Byte sizing accepts plain synthetic data descriptors only. Accessors, custom
`toJSON`, binary/circular values and class instances have
null byte counts, not zero, without invoking getters or custom serializers.
Proxy objects are outside this fixture-only contract; do not pass them to the
probe because descriptor inspection itself can invoke Proxy traps. Export only aggregate timings/counts; raw application
monitor reports can contain identifiers and URLs.

## Next experiments justified by this run

At 10,000 elements, terminal search has a 40.113 ms median and SQLite full-history
read 15.205 ms. First test realistic retained terminal rows and paged chat loads
in native runtime. Profile terminal case folding and allocation before choosing
an indexing or incremental search change. Measure whether chat item rebuilding
is material with the existing virtualizer before modifying it. The 22.043 ms
chat p95 versus 1.802 ms median calls for a quiet-machine repeat and GC trace.
Do not use these values to change batching RAF, terminal/history caps, Git
polling protection, virtualization or caches. Catalog cache/IPC optimizations
need the absent fanout measurements first.

## Native SQLite baseline, phase 16b

This extension preserves the Bun in-memory baseline above. It measures the real
Rust repository on disposable files, with SQLx, migrations 1/3/4/5, transactions,
FTS triggers and conversation metadata refresh. It does not measure Tauri IPC,
HTTP, the browser bridge, rendering, navigation, RAF or catalog invalidations.
Those captures remain phase 16c, after the shell/lifecycle work is integrated.

```sh
bun --no-install dev/performance/native-sqlite.ts > /tmp/macro-native-baseline.json
bun --no-install dev/performance/native-sqlite.ts --self-test > /tmp/macro-native-self-test.json
bun --no-install test dev/performance/native-sqlite.test.ts
```

The command runs `cargo build --manifest-path src-tauri/Cargo.toml --example
performance-sqlite --locked --offline -j 1`, with explicit overrides
`profile.dev.package.macro.debug=0`, `profile.test.package.macro.debug=0`,
`profile.dev.incremental=false` and `profile.test.incremental=false`, plus
`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`. Dependencies must already be
available offline. These are the current comparison settings; the original
16b numbers below used debug information and two build jobs. Compare only runs
with matching settings. It honors `CARGO_TARGET_DIR`; an existing compatible cache may
be shared with another local worktree. Cargo's lock is respected. Each build embeds a fresh invocation nonce and the source fingerprint via
compile-time environment variables. The measured executable is copied into a private temporary directory before execution, so a
later build using that cache cannot replace the running benchmark. Before
opening SQLite, the runner queries the copied binary with `--build-identity` and
rejects any different nonce/fingerprint, including replacement between Cargo
exit and the copy. A mismatch discards the run; it does not silently use a newer
binary. This recompiles the example for each invocation, while keeping dependency
caching. The replacement race is reproduced by a focused staging test. No source in
the cache owner is changed. A cache hit does not mean a release build or an
idle machine.

The repository's database module is private. The dedicated example compiles its
actual source files with `#[path]`, including the real migration/pool code,
models and repository, rather than adding public production APIs. Its AI/secrets
module dependencies are compiled from their source but never initialized or
called for provider access. The existing public config module is linked without
installing a manager. Default provider rows inserted by migrations stay within
the fixture database; no credentials or provider connections are used.

### Isolation and validation

The example accepts `--self-test` and a read-only `--build-identity` handshake; it accepts no database
path. Every case creates a new `TempDir` and injects its new `fixture.db` path
into the real `db::create_pool`. Before writing fixture rows, it compares
`PRAGMA database_list`'s canonical main path with that owned path. It also checks
that a wrong path is rejected. This is an in-process native example, not a Tauri
desktop launch, and does not use the application's data-directory resolver.

All operation failures propagate. The pool is explicitly closed before owned
files are removed; the same teardown is tested with a simulated failure after
opening SQLite and a sibling sentinel that must remain untouched. Reopened
pools are also closed if verification fails. The successful report is emitted
only after fixture cleanup. The process never cleans a caller-selected path.
Abrupt process termination or power loss can leave its temporary directories;
the command never scans or deletes directories from other runs.

After seeding, after writes and after closing/reopening the pool, checks verify
row count, deterministic 256-byte content, conversation `message_count`, the
100-character-plus-ellipsis `last_message`, `updated_at`, SQLite integrity and
foreign keys. Every committed append ID must survive reopen. The small
`--self-test` case executes the same path with three seed messages, in addition
to nearest-rank percentile and failure-cleanup assertions. The Bun test checks
that provenance hashes change for tracked/untracked sources and ignore Cargo
build outputs.

The report records HEAD, dirty state, a fingerprint of tracked and untracked
nonignored `src-tauri` and `dev/performance` files, executable SHA-256, Rust/Cargo
versions, OS/CPU/memory, profile and use of an explicit cache. It rejects source
changes during build/run. No fixture text, database path, conversation ID, user
name or cache path is exported. Logs and full JSON stay outside Git.

### Protocol and limits

Each size starts with one conversation and 100, 1,000 or 10,000 seed messages,
imported in one repository transaction outside timed samples. Seed content is
256 ASCII bytes, identical timestamps and distinct ordered IDs. Read samples
call `repository::list_messages`; timings include SQLx pool acquisition, SQL
execution, full row materialization and Rust model conversion, but exclude
result validation/destruction and all frontend/transport work.

Reads run before appends. `repository::create_message` timings include the real
transaction, insert, FTS trigger, count/latest-message queries, metadata update
and commit acknowledgement. Input preparation is outside timing, and IDs are
supplied explicitly, so UUID generation is not measured. Append content is
256 ASCII bytes with a distinct index at the beginning; verification can detect
stale last-message metadata. There are 10 warmups and 100 retained samples per
operation, nearest-rank p50/p95, with outliers included. Every warmup append is
also committed. Thus timed writes begin at N+10 rows and finish at N+110; the
100-row case grows proportionally more. No delete/rollback/reset is hidden in
the timing or used to claim a constant-size write benchmark.

The pool keeps its production settings: WAL, `synchronous=NORMAL` (1), foreign
keys enabled, maximum five connections, 30-second busy timeout. Operations are
sequential, with two Tokio workers and at most two Cargo build jobs. There is no
contention benchmark and no instrumentation installation/uninstallation cost:
only external `Instant` boundaries and sample vectors are added to this example.
Production code imports none of this tooling.

Durability here means acknowledged real SQLite commits to a file, checked after
all connections close and the database is reopened. It is **not** a power-loss,
process-kill or hardware-fsync guarantee: WAL/NORMAL does not promise every recent
commit survives power failure. Fresh-pool/migration and reopen durations are
single observations, separate from the p50/p95 series. The SQLite engine, OS
page cache and shared-machine load are warm/uncontrolled; no cold-disk claim or
performance improvement relative to Bun is justified. The debug Rust build and
Bun use different execution engines, SQLite builds and operation boundaries.

### Observed native reference

Observed UTC 2026-09-19 23:15:42 on Darwin 27.0.0 arm64, Apple M5, 10 logical CPUs,
16 GiB, Rust/Cargo 1.98.1, SQLite 3.46.0. Build profile was debug with the shared
Cargo cache. Source base was `70b56179d9ccc207d6f475a047d09bb54b61b8e3`, dirty with
this benchmark addition. The captured source fingerprint was
`fbf7c948a0a1322c8eeb32cd6bb06e4805f85aca7c5db3b7cee16b57eb077851`.
This run preceded the final existing-path negative check and build-identity
handshake; no measured repository operation changed. Frozen-candidate validation reports are retained
outside Git with their own HEAD and fingerprint.

Values are milliseconds, p50 / p95 for the 100 retained samples:

| Seed messages | Full repository read | Repository create + metadata + commit | Final persisted messages |
| ---: | ---: | ---: | ---: |
| 100 | 1.722 / 2.088 | 0.784 / 1.999 | 210 |
| 1,000 | 16.884 / 20.421 | 0.969 / 1.899 | 1,110 |
| 10,000 | 245.780 / 450.339 | 3.994 / 15.527 | 10,110 |

Fresh-pool/migration observations were 25.237, 25.651 and 25.723 ms respectively;
reopen-pool/migration observations were 4.609, 4.891 and 63.575 ms. These are
single values, not distributions. All cases observed migrations `[1,3,4,5]`,
WAL, synchronous 1 and foreign keys 1; path, integrity, persisted contents,
metadata, append IDs and cleanup checks passed.

The 10,000-message full read is the first operation to profile after extraction:
replay exactly this command on the new source, then distinguish SQL execution,
SQLx row conversion and full-history materialization before changing the query
or introducing paging. The insert includes the current count/latest-message
metadata queries, so its scaling warrants a query-plan trace on the same fixture.
No native transport was captured here. The headless example/smoke launcher were
reviewed, but running HTTP would not establish Tauri IPC performance. There was
no browser/Chrome automation available or computer use. A future desktop capture
must use the separate `com.macro.desktop.qa.*` identifier and
`MACRO_TAURI_BROWSER_CONFIG` isolation from `DEVELOPMENT.md`; `MACRO_CONFIG_DIR`
alone is insufficient. Existing browser bridge ports remain 1422/1430.

## Integrated comparison, phase 16c

Measured 2026-09-20 on the same Darwin 27 arm64/M5 machine, Bun 1.3.14,
Rust/Cargo 1.98.1. All installed direct dependencies matched their pinned
versions. The worktree used a private copy of dependencies and Vite caches.
The historical reference is `2d41e57e`, with only the new measurement adapter
committed as `4622f45c`. The integrated product base is `1715979a`.
The JS, native and diagnostics series below ran at `57986ada`.

Each timing cell is the median of the three process-level p50 / p95 values,
in milliseconds. It is not a percentile over pooled samples. Every process
used 10 warmups and 100 observations per case. No samples or outliers were
removed. The native candidate's second process overlapped a 0.268-second CSS
verification; its report was retained as non-comparable and the entire process
was repeated before inspecting its values. The replacement is used below.
No clock discrepancy above one second occurred. These were sequential jobs on
a shared machine, with load averages recorded; they are not idle-machine or
cold-disk measurements.

| Elements | Historical chat items | Integrated chat items | Historical search | Integrated search |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.020 / 0.037 | 0.017 / 0.030 | 0.209 / 0.422 | 0.137 / 0.352 |
| 1,000 | 0.145 / 0.169 | 0.101 / 0.115 | 2.017 / 2.618 | 1.663 / 2.355 |
| 10,000 | 1.150 / 2.176 | 0.973 / 1.871 | 19.183 / 21.282 | 15.520 / 20.009 |

| Elements | Historical Bun read | Integrated Bun read | Historical insert/rollback | Integrated insert/rollback |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.088 / 0.101 | 0.061 / 0.071 | 0.012 / 0.016 | 0.008 / 0.013 |
| 1,000 | 0.821 / 0.944 | 0.573 / 0.757 | 0.012 / 0.014 | 0.010 / 0.012 |
| 10,000 | 7.835 / 9.276 | 5.904 / 7.549 | 0.012 / 0.013 | 0.008 / 0.019 |

These JavaScript paths were not optimized by the chunk corrections. The lower
values are observations under varying scheduling/JIT/GC conditions, not an
attributed product speedup. Bun SQLite remained version 3.54.0.

Both native revisions were rebuilt with the explicit reduced profile above,
one Cargo job, locked offline dependencies and the same shared target cache.
Their executables passed the compiled source/nonce handshake before measuring
owned databases. SQLite remained 3.46.0, WAL, synchronous NORMAL, foreign keys
on, migrations 1/3/4/5. Both self-tests passed. Every process verified counts,
content, metadata, integrity, reopened appends and fixture cleanup.

| Elements | Historical SQLx read | Integrated SQLx read | Historical commit | Integrated commit |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1.137 / 1.227 | 1.268 / 1.419 | 0.380 / 0.506 | 0.440 / 0.594 |
| 1,000 | 12.482 / 17.223 | 12.319 / 16.133 | 0.549 / 0.959 | 0.543 / 0.800 |
| 10,000 | 129.238 / 158.624 | 128.489 / 157.722 | 1.357 / 1.663 | 1.341 / 1.888 |

The 10,000-row native read medians span 127.730–129.765 ms historically and
127.332–129.343 ms in the integrated series. No large read improvement is
established. Small-input commit/read differences and tail variation need
controlled follow-up before defining a regression threshold. These values
include repository work, not IPC or UI latency.

### Diagnostic snapshot cost

Run `bun --no-install dev/performance/chat-diagnostics.ts` on a clean tree.
This calls the real `createAssistantStreamRuntime` and `createChatTurnRuntime`.
Synthetic ports return an already ordered array. The first diagnostics callback
records its time and throws a sentinel synchronously, before any transport,
persistence or provider operation. All unused ports throw if reached.

The total sizes include one empty assistant placeholder; the other messages
contain 256 ASCII content bytes. Nested cases add one tool trace, one provider
input item with nested text/metadata, and nested provider turn output per history
message. Fixture creation and ownership setup are outside timing. Allocation
and GC during the product call remain inside. Mutation checks after timing
verify that content, tool traces and nested provider data are independent of
the source. The separate TypeScript check includes this developer file because
the ordinary frontend typecheck covers only `src`.

| Total messages | Simple copy p50 / p95 | Nested copy p50 / p95 | Nested start-to-record p50 / p95 |
| ---: | ---: | ---: | ---: |
| 100 | 0.095 / 0.109 | 0.929 / 1.101 | 0.939 / 1.126 |
| 1,000 | 0.936 / 1.139 | 9.471 / 10.782 | 9.488 / 10.795 |
| 10,000 | 9.370 / 12.495 | 98.958 / 124.055 | 98.994 / 124.086 |

Copy timing runs from the `ordered` port to the first `record` callback;
start-to-record also includes the authority snapshots. The long nested history
is costly in this Bun experiment. It does not establish WebView interaction
latency, and no snapshot was weakened to improve these numbers.

### Remaining measurement boundaries

Navigation, visual readiness, React/RAF streaming, terminal painting and real
frontend catalog invalidation fanout were not exercised. No authorized browser
driver was available. No native browser bridge was launched for this comparison;
its WebSocket/WebView/RPC path would be a separate transport experiment, not a
replacement for visual measurements. The native SQLite results above do not
fill those gaps. The raw reports, command logs, exit codes, clock/load records,
source/binary/lockfile fingerprints and superseded experiments are kept outside
Git, without ordinary user data.

### Final bundle correction

The final production bundle was measured at `661f3fa5`. The integrated baseline
bundle at `9451ddc6` has the product sources of `1715979a`; its intervening
commits add measurement tooling only. All values below are emitted bytes.

| Metric | Historical `4622f45c` | Integrated before correction `9451ddc6` | Corrected `661f3fa5` |
| --- | ---: | ---: | ---: |
| Entry JavaScript | 1,453,296 | 1,502,512 | 1,421,689 |
| Static JavaScript closure | 2,766,814 | 2,816,030 | 1,769,333 |
| Static JavaScript closure, gzip | 718,013 | 733,518 | 479,164 |
| All emitted JS/CSS | 9,194,607 | 9,257,128 | 9,129,770 |
| All emitted JS/CSS, gzip | 2,603,171 | 2,633,615 | 2,596,077 |
| Existing budget failures | Entry, fr, ko, ja | Entry, fr, ko, ja | None |

The entry limit remains 1,425,000 bytes, leaving 3,311 bytes of margin. Every
other existing budget is unchanged and passes. This margin is small; subsequent
work must keep checking the fixed gate. The entry shrank by 80,823 bytes and its
static JS closure by 1,046,697 bytes against the integrated baseline. The closure
is deduplicated, includes shared chunks, and excludes dynamic imports. It is
not a browser waterfall or a navigation latency measurement.

The Vite preload helper now lives in the existing eager utility chunk instead
of pulling Mermaid into startup. The xterm CSS import remains in `main.tsx`,
but CSS no longer assigns the terminal JS vendor to the startup closure.
Comparison through the same CSS transforms found all 33 canonical xterm rules
unchanged among 36 emitted rules, including three application overrides. This
checks declarations, not visual layout or cascade order in the WebView.

Locale JSON is emitted as default object literals without named exports. All
12 compiled default objects were deep-compared with their source JSON. French,
Japanese and Korean chunks now measure 130,427, 145,514 and 131,089 bytes.

Application code is deferred at calls that already return promises:
`chatToolExecutionRuntime` loads on the first tool execution,
`architectToolRuntime` on the first call to the Architect handler, and
`streamingChatExecution` on the first streaming or non-streaming provider call.
The latter emits a 37,564-byte chunk. These modules are absent from the emitted
static startup closure; their imports are invoked by those operations, not by
application initialization. No new always-eager application chunk hides entry
bytes. The build guard checks these three modules as well as Mermaid and xterm.
The transport facade retains synchronous estimators, captures provider mode and
callbacks before loading, and reserves cancellation in the existing session
registry. The detailed lifetime contract is in `technical-architecture.md`.

The JS/native/diagnostics timing series above remain tied to `57986ada`.
Their measured product paths did not change with these lazy-loading corrections;
the timing values are not measurements of first-send module loading. That latency
requires a browser measurement. Focused transport tests cover delayed loading,
cancellation without an external signal, reentrant and same-session successors,
reasoning capture, retry after module failure, HTTP readers and native listeners.


## Bundle budgets for the 0.1.8 feature set

A clean production build of `473a5caece81e805fe46fe47d7b29001a471cd46`
used Bun 1.3.14 and the locked dependencies with
`NODE_ENV=production bun dev/performance/build-bundles.mjs`.
The existing guard rejected the deferred ChatZone chunk and three locale chunks.
The emitted measurements are:

| Chunk | Emitted bytes | Gzip bytes, level 9 | Budget bytes |
| --- | ---: | ---: | ---: |
| Application entry | 1,460,181 | 383,142 | 1,465,000, unchanged |
| ChatZone | 198,707 | 57,550 | 201,000 |
| French locale | 136,396 | 40,607 | 138,500 |
| Korean locale | 136,978 | 40,891 | 138,500 |
| Japanese locale | 151,451 | 42,633 | 153,000 |

The ChatZone graph now includes the Goal product flow, its evaluator coordinator,
provider executor, review artifacts and subagent runtime, alongside conversation
sources and recovery controls. These are application modules in the deferred
chat chunk. Its growth is accepted for these features; it is not a measured
performance improvement. The entry, vendor, task-queue and rich-markdown caps
remain fixed. The adjusted caps leave approximately 1% above the measured chat
and largest locale outputs.

The emitted static entry closure contains 1,808,736 bytes, or 490,648 gzip bytes.
ChatZone remains outside that closure. The guard found no forbidden deferred
transport, tool handler, Mermaid or xterm module in startup, and all 12 emitted
locale objects matched their source JSON. These checks cover emitted imports
and data, not first-open latency, WebView rendering or a native startup timing.
The earlier performance series in this document remain tied to their recorded
commits and are not re-measured by this build.

## Bundle budgets for the local stabilization scope

Fresh production builds compared `develop` at
`65fffca4ca486ecb1efe45f0b24cd7f25e63644a` with the stabilization candidate
`3e31241085ef389c12485a15e7a88445731920b0`, using Bun 1.3.14, the same locked
dependencies and `NODE_ENV=production bun dev/performance/build-bundles.mjs`.
The old guard already rejected the base entry, Korean and Japanese chunks.
The candidate also exceeded the task-queue, French and German caps.

| Output | Base bytes | Candidate bytes | Candidate gzip bytes, level 9 | Budget bytes |
| --- | ---: | ---: | ---: | ---: |
| Application entry | 1,468,818 | 1,487,044 | 390,994 | 1,505,000 |
| TaskQueue | 61,285 | 62,167 | 18,393 | 63,000 |
| ChatZone | 198,692 | 199,494 | 57,853 | 201,000, unchanged |
| French locale | 138,429 | 143,205 | 42,490 | 145,500 |
| Korean locale | 138,974 | 143,769 | 42,586 | 145,500 |
| Japanese locale | 153,710 | 159,064 | 44,374 | 161,000 |

The stabilization scope adds task and archive guards, project validation, Git
diagnostics and conflict inspection, shared-dialog integration and their
translations. The entry grows by 18,226 bytes, or 1.24%, against the current
base. The new ceilings allow approximately 1% above these measured outputs.
The vendor, deferred-chat and rich-markdown limits remain unchanged. These
adjustments account for the retained behavior and copy; they do not establish
a performance improvement.

The deduplicated static entry closure grows from 1,817,373 to 1,835,599 bytes,
and from 492,778 to 498,500 gzip bytes. Its six chunks are unchanged in
composition. Both builds report zero forbidden deferred modules in startup,
deep-compare all 12 emitted locale objects with their source JSON, and retain
terminal CSS rules. Total emitted JS/CSS grows from 9,371,068 to 9,425,567
bytes. The raw reports and failed old-budget results are retained outside Git.

This is a local candidate measurement, not a published version. Subsequent
candidate corrections must still pass the fixed gate. Browser startup,
first-open latency, rendering and native timing were not measured here.


### Native refusal translation follow-up

The production build of `afdfaa7beacbf09c4740c23e4531c611febb6869`
measures TaskQueue at 63,040 bytes. Its native SQLite lock refusal now uses the
existing translated message, with an additional exact backend diagnostic
recognized by the presentation helper. The build exceeds the 63,000-byte cap
by 40 bytes. The TaskQueue cap moves to 63,200 bytes, leaving 160 bytes above
this measured output. All other caps remain unchanged. The raw measurement
and failed old-budget result are retained with the local QA proofs.

This adjustment accounts for the retained refusal translation. It does not
establish a performance improvement or change the previously recorded startup
and first-open measurements. Subsequent builds still use the budget guard.


### AgSDL 0.2 and bounded develop integration

The combined worktree starts from the integrated Chat candidate
`cc0edb66bca867eba7a04ba3015a42b998fba8e6` and merges develop only through
`0dad2a36a651d75d77e5d9da86f62fc03ad90374`. A local production build with
Bun 1.3.14 and the final frozen lock measures the outputs below. These are
working-tree measurements used to resolve the conflicting budgets. A fresh
build of the committed candidate must pass the same guard before integration.

| Output | Bytes | Gzip bytes, level 9 | Budget bytes |
| --- | ---: | ---: | ---: |
| Application entry | 1,633,013 | 432,579 | 1,650,000 |
| ChatZone | 202,043 | 58,797 | 204,000, unchanged |
| TaskQueue | 60,357 | 17,915 | 62,000, unchanged |
| German locale | 141,613 | 43,674 | 143,200 |
| Spanish locale | 138,417 | 42,500 | 138,500, unchanged |
| French locale | 144,447 | 42,771 | 146,600 |
| Korean locale | 145,081 | 43,061 | 146,600 |
| Japanese locale | 160,587 | 44,864 | 162,300 |

The entry retains the AgSDL compiler and revisioned editing contracts together
with develop's plan hydration, conflict validation, approval and diagnostics
changes. Its ceiling and the expanded locale ceilings leave about 1% above the
measured combined output. German and Spanish now have separate ceilings so the
Spanish limit remains unchanged. Deferred Chat, task queue, vendor and rich
Markdown limits keep their existing values.

The Vite build still reports its large-entry warning. This measurement does
not establish a startup, rendering or native performance improvement. The
fresh candidate measurement separately checks the static startup closure,
emitted locale values and terminal styles.

## History loading and long-session resource protocol

The developer runner below separates JSON decoding, the production
`loadConversationMessages` mapping, `buildMessageState` indexing and transcript
item construction. It does not install instrumentation in production or change
storage, pagination, eviction or UI behavior.

```sh
bun --no-install test dev/performance/history-resources.test.ts
bun --no-install x tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --jsx react-jsx --allowImportingTsExtensions --resolveJsonModule --types bun-types,vite/client dev/performance/history-resources.ts dev/performance/history-resources.test.ts
bun --no-install dev/performance/history-resources.ts --self-test > /tmp/macro-history-resources-smoke.json
bun --no-install dev/performance/history-resources.ts > /tmp/macro-history-resources.json
```

Commit source changes before the two runner commands. They require a clean
worktree and check its HEAD again at completion. Reports record timestamp,
HEAD, Bun, lockfile hash, OS, CPU, memory and start/end load averages. Repeat the
full runner in three fresh processes with other heavy work stopped. Each timing
case uses 10 warmups and 100 observations, nearest-rank percentiles, without
outlier removal or forced GC. The smoke uses three messages and six resource
cycles and supplies no performance baseline.

History fixtures contain 100, 1,000 or 10,000 messages. Plain fixtures match the
native example's 256 ASCII content bytes, user roles, null optional fields and
ordered seed IDs. Conversation IDs differ and payload byte totals therefore
need not match. Nested fixtures alternate roles and add valid tool traces,
provider input JSON and assistant provider turn JSON. They exercise the actual
parsers rather than a substitute mapping loop. Fixtures, JSON preparation and
assertions are outside timed sections. The mapping includes the immediate
synthetic Promise adapter, conversation-map creation and the production mapper;
there are no conversations in that map, so project/task lookup and bootstrap
loading are not represented. Index and transcript timings reuse already mapped
messages. They exclude store publication, recovery merging, React, layout and
Markdown rendering. Indexes point to the same message objects; the separate
arrays add references, not content copies.

The native example additionally reports `serialize_messages_json` and
`serialized_messages_json_bytes`. Its existing `read` boundary remains the real
repository/SQLx call, including pool acquisition, SQL, row materialization and
model conversion. Serialization times only `serde_json::to_vec` of the returned
models, after the read boundary. A JSON roundtrip count/content check follows
outside timing. No SQL execution-only subdivision or Tauri IPC is claimed.
Serialization and its untimed validation allocate between read samples; this
extended protocol therefore also changes inter-sample allocator/cache state.
Separate stage percentiles cannot be added to infer an end-to-end percentile.
The native and Bun fixtures/engines are separate experiments.

### Resources exercised and retained

The runner executes 10,000 sequential cycles of real production helpers. Each
cycle reopens the same 100-message history through production mapping and index
helpers, replacing the prior synthetic owner state. Checkpoints report its
retained message count, which should stay at 100; this is not a mounted
useChatStore or an eviction policy test. It
completes and cancels alternating chat turns, tracks/drains settled stream
promises, consumes steers, forgets session identities and clears the synthetic
state port. It creates and cancels real Web Streams through the production
stream registry. Each lifecycle scope owns a real EventTarget subscription and
a real timer, then stops twice and drains admitted work. A real SubagentRuntime
uses a synthetic immediate executor and a clock adapter around real timers;
its completed snapshots accumulate deliberately until `releaseRun` is called.
The run checks callback delivery, stream cancellation, projected-state counts,
owned timer counts, subagent timer counts and stream-registry size. After idle,
unsubscribe and a further completed run that verifies listener removal, then
dispose, it explicitly releases all settled runs and checks
that public snapshots reach zero. It does not inspect private Maps or claim
that an empty public API proves garbage collection of every internal object.

Memory checkpoints record `process.memoryUsage()` before and after full Bun GC
at 0 and every 1,000 cycles, then after dispose and after explicit run release.
They are whole-process observations with allocator, JIT, sampling allocations
and intentionally retained records mixed in. Snapshot counting itself allocates
copies. The runtime variable remains reachable at the final checkpoint inside the
helper. Empty parent pools are removed by `SubagentRuntime.#pump` once active
and queued work reach zero; the helper does not measure private pool counts. RSS is not retained-object size, and Bun GC is not WebView GC.
These checkpoints can reveal a direction to investigate, not establish a leak
or prove its absence. They do not launch child processes or open any profile.

| Owner | Intended retention and release | Evidence boundary |
| --- | --- | --- |
| `useChatStore` history | Loaded messages and ready status remain for revisits; concurrent load promises are removed in `finally`. Replacing one conversation rebuilds indexes over all loaded messages. | Source inspection of `ensureMessagesLoadedForConversation` and `replaceLoadedConversationMessages`; runner measures mapping/index helpers, not the mounted store. |
| `chatMessageState` | Two arrays reference each message, plus an ID-to-index entry. | Identity assertions in the runner; no duplicate content payload in these indexes. |
| `chatTurnRuntime` | Sessions persist until forget/reset; completion ownership releases explicitly; tracked streams remove themselves on settlement. | Real helper cycles, cancellation, completion, drain and forget. |
| `streamResources` | Registry holds active readers/streams/request IDs; prune removes only an empty entry owned by that invocation. | Real Web Stream cancellation; no HTTP reader, native request or provider is opened. |
| `lifecycleScope` / configuration effects | Scope owns unsubscribe/dispose functions and admitted promises; stop revokes then releases, drain waits. Config effects own store and preference subscriptions. | Scope cycles with EventTarget/timer; configuration subscriptions inspected, not mounted. |
| `SubagentRuntime` / Goal audit | Runtime keeps settled snapshots until `releaseRun`; dispose cancels work and removes listeners. GoalAuditCoordinator calls releaseRun after observing results, and the durable journal releases transient data. | Real runtime completion/dispose/release cycles, synthetic executor; coordinator release path inspected, not a provider-driven audit. |
| `terminalRuntime` | Detach retains at most six detached renderers; attached tabs remain. Disposal clears queued writes, RAF/retry timers, observers, links, input/global listeners and xterm. | Source inspection only; helper cycles do not instantiate xterm or measure WebView rendering. |
| Native terminal store | PTYs/process groups and output tasks have native close paths; snapshots cap at 1,000,000 bytes per terminal. | Source inspection only; no native process lifetime measured by this runner. |
| `useGitStore` | Tree/commit data retained per project; request identity Maps clear in finally; invalidateProject clears results and invalidates requests. Project registry owns invalidation. | Source inspection of store and gitCacheComposition; no repository polling experiment. |
| `modelContextCatalog` | Catalog snapshot and status listeners have application lifetimes; persisted catalog is intentional cache data. | Source inspection only; no network refresh or user cache is accessed. |

A Map alone is not evidence of a leak. A positive leak conclusion needs an
unexpected retaining owner after the relevant release boundary, preferably a
heap retaining path and repeatable growth across equal settled cycles.

### Missing native and WebView portions

Run these only in an isolated disposable synthetic profile, with providers
absent and no user projects. Follow the identifier/config isolation described
in `DEVELOPMENT.md`; a config directory override alone is insufficient.

1. Seed the same fixture sizes in a disposable database. Run 10 warmups and 100
   full-history opens per size in a native Tauri WebView. Wrap its actual
   `__TAURI_INTERNALS__.invoke` with `installNativeProbe` from
   `dev/performance/native-probe.ts`; measure the actual open action until its
   message count is correct and the virtualized first/last target has painted
   after two animation frames. Export aggregate call/JSON-byte distributions
   and uninstall the probe. JSON bytes exclude framing and native events.
2. Capture a WebView performance trace for those opens. Correlate the command
   span with mapping/index work and React/paint. Native invoke duration includes
   repository and transport work; subtracting percentiles from separate runners
   does not isolate IPC overhead. An exact native transport split requires
   command-level trace correlation; no synthetic JSON result fills that gap.
3. For resource retention, repeat a fixed batch of 100 open/switch/close actions
   ten times, then wait for stream settlement, terminal close acknowledgements,
   RAF/retry queues and idle work. Record app/backend and WebView process-tree
   RSS, open file descriptors and live child PIDs before/after each batch. In
   WebView DevTools take heap snapshots at matching settled boundaries. Compare
   retained paths for messages, detached DOM, xterm renderers and subscriptions,
   distinguishing six cached detached terminals from closed ones. Keep selected
   entities and fixture sizes fixed so intentional loaded-history growth is
   separated from repeated same-entity retention.
4. Close every created terminal, verify child/descendant PIDs disappear and
   check that output tasks stop. Dispose the app runtime, close the app, verify
   the isolated process tree exits, then remove only owned fixtures. Record
   browser/WebView/toolchain versions, source SHA, lifecycle action counts and
   boundaries. Repeat in three fresh processes. This protocol requires an
   authorized browser/native driver and has not been executed by the Bun runner.

### Executed history stages, 2026-10-22

Three fresh processes per runner measured clean source
`f4b1dd00cd4d7f453fcd0ee07bd578e37839386a`, based on product revision
`57ca43aeaf79e66732667e564ea4af8b3410261c`. This lot adds developer tooling only.
Environment was Linux 7.0.0-1019-nvidia arm64, 20 logical CPUs, 121.625 GiB,
Bun 1.3.14, Rust/Cargo 1.95.0. The OS did not expose a CPU model. The lockfile
SHA-256 was `1e49b5eaeebc035002a02f5367bc01bcea6dc0aa64c3f3b81ebed1b229408e4c`.
Runs were sequential with other chantier benchmarks/builds paused, but shared
host load was uncontrolled. These are observations, not regression thresholds.
Raw JSON, logs and the external capture wrapper remain outside Git.

All timing cells are medians of three process-level p50 / p95 values in
milliseconds. They are not percentiles of pooled observations. Each process
used 10 warmups and 100 retained observations per case; none were discarded.

| Messages | Native repository/SQLx read | Rust JSON serialization | Serialized bytes |
| ---: | ---: | ---: | ---: |
| 100 | 1.622 / 1.965 | 1.857 / 1.870 | 62,401 |
| 1,000 | 14.324 / 16.353 | 18.556 / 18.663 | 624,001 |
| 10,000 | 124.367 / 133.677 | 185.665 / 187.159 | 6,240,001 |

The native build used the documented dev profile, one Cargo job and shared
cache, locked/offline dependencies and a verified private executable per run.
The source fingerprint was
`6610d8a22aaeb327e2302229d53032d959c1696eb0aa4b4a2e3c2dff4f7b2b87`.
SQLite was 3.46.0 with migrations `[1,3,4,5,6,7,8,9,10]`, WAL, synchronous 1
and foreign keys on. All path/content/metadata/integrity/reopen/cleanup checks
passed. One preparatory smoke was rejected because developer source changed
during its build; its output was excluded. The frozen-source smoke and all
three final runs passed.

The 185.665 ms serialization median is for an **unoptimized dev example**,
not a release Tauri command or an observed native IPC encode duration. Both full
repository materialization and serialization scale with payload in this build.
An optimized-build reproduction and a native trace are required before deciding
whether either explains product latency. These data do not isolate SQL execution
from SQLx decoding, and cannot justify pagination or a storage change.

| Messages | Fixture | Bun JSON decode | Production persistence mapping | Message indexing | Transcript items |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100 | Plain | 0.049 / 0.055 | 0.016 / 0.023 | 0.014 / 0.022 | 0.014 / 0.022 |
| 1,000 | Plain | 0.420 / 0.604 | 0.053 / 0.104 | 0.112 / 0.137 | 0.044 / 0.072 |
| 10,000 | Plain | 3.743 / 5.592 | 0.297 / 0.627 | 1.012 / 1.952 | 0.305 / 0.647 |
| 100 | Nested | 0.170 / 0.179 | 0.140 / 0.169 | 0.010 / 0.014 | 0.007 / 0.013 |
| 1,000 | Nested | 1.431 / 1.786 | 1.010 / 1.463 | 0.095 / 0.113 | 0.050 / 0.058 |
| 10,000 | Nested | 14.384 / 17.470 | 10.780 / 15.596 | 1.182 / 1.873 | 0.448 / 0.592 |

At 10,000 messages, plain/nested JSON contained 6,100,001 / 15,383,891 bytes.
Nested parsers add visible work to real frontend mapping in Bun. Their cost is
separate from transport and from the diagnostics copy measured elsewhere. These
fixtures do not establish real-user payload distributions or WebView latency.
No stage percentile is added to a different stage, engine or process.

### Executed resource cycles, 2026-10-22

Each of the three complete JS runs passed 10,000 cycles. Each ended with 10,000
settled stream promises, 10,000 cancelled Web Streams, 10,000 delivered
EventTarget events and 5,000 cancelled chat turns. Projected runtime states,
active-stream registry entries, owned timers and subagent timers all reached
zero. Reopening the same history retained 100 messages. Subagent snapshots
reached 10,000 and stayed at 10,000 after dispose, then reached zero after
explicit releaseRun. A further completed run after unsubscribe delivered no
notification to the removed listener.

Memory in those complete runs included prior history timing allocations.
Separate fresh processes therefore called the same exported `resourceCycles`
helper without the preceding history benchmark. To reproduce the additional
returned-owner boundary from a clean repository root:

```sh
bun --no-install --eval '
import { resourceCycles } from "./dev/performance/history-resources.ts";
import { assertCleanBuildSource } from "./dev/performance/build-provenance.ts";
const head = assertCleanBuildSource(process.cwd());
const retention = await resourceCycles(10_000, 1_000);
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
Bun.gc(true);
const afterReturnedOwnerAndIdle = process.memoryUsage();
if (assertCleanBuildSource(process.cwd()) !== head) throw new Error("Source changed");
console.log(JSON.stringify({ head, bun: Bun.version, retention, afterReturnedOwnerAndIdle }));
' > /tmp/macro-resources-isolated.json
```

The retained data returned by the helper contains numeric checkpoints, not the
runtime owner. Two macrotask turns allow host cleanup to progress after the
helper returns. The executed external wrapper also recorded environment,
lockfile and its own source hashes, and rechecked HEAD/cleanliness. This boundary
is stronger than reading process memory immediately inside the loop, but is
still not a heap retaining-path inspection.

| Fresh process | Initial heap / RSS MiB | At 10,000 cycles heap / RSS MiB | After releaseRun, owner still live | After helper return, two turns and GC |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.062 / 58.488 | 11.111 / 159.945 | 11.111 / 147.312 | 5.005 / 135.887 |
| 2 | 1.065 / 59.719 | 11.133 / 160.215 | 11.133 / 161.465 | 5.004 / 161.652 |
| 3 | 1.062 / 59.004 | 11.108 / 159.496 | 11.108 / 160.590 | 5.001 / 160.777 |

These whole-process values mix module/JIT initialization, allocation pools,
cleared timer handles and intentional history/run data. In particular, immediate
heap accounting did not drop after releaseRun, although public snapshot count
became zero; after returning and yielding it fell to about 5 MiB. RSS did not
return to its initial value. Neither observation identifies a retaining owner
or establishes a leak. The executed evidence confirms the tested release
contracts and explicit data retention only. WebView heaps, DOM/listeners,
xterm/RAF, native PTYs/process groups and app shutdown remain unmeasured; use
the separate native/WebView protocol above before making claims about them.


The original JSON captures at `f4b1dd00` contain an incorrect sentence in their
`retained` narrative field stating that an empty parent pool persists until
runtime collection. Preserve those raw captures and their original SHA/hashes.
That sentence is corrected here and in future runner output.
[`SubagentRuntime.#pump`](../src/services/subagentRuntime/SubagentRuntime.ts#L539)
deletes an empty pool, and `#startExecution` decrements its active count and
pumps again in `finally`. This correction changes no timings, numeric resource
counts or memory readings; it removes an unsupported attribution of retention.
