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

### Local Pilot integration compatibility build

The production build combining the current desktop with the Pilot transport
measures 1,525,486 bytes for the entry, 821,607 bytes for the native client and
643,898 bytes for the desktop composition. The latter two deferred transport
chunks now have dedicated budgets with approximately 1% headroom. Other lazy
chunks retain their 600,000-byte cap. The largest ordinary locale fragment is
153,341 bytes and Japanese is 169,841 bytes; their caps are 155,000 and 172,000
bytes. These measurements describe the combined scope, not a performance gain.


## Native SQLite stage diagnostics on the current schema

The native example now has a separate `--diagnostics` mode. Keep the ordinary
mode for timing the uninstrumented repository. The diagnostic mode replays the
current literal statements, extracted from the compiled repository source, on
fresh file-backed fixtures. It does not install production instrumentation.

```sh
bun --no-install dev/performance/native-sqlite.ts --self-test
bun --no-install dev/performance/native-sqlite.ts
bun --no-install dev/performance/native-sqlite.ts --diagnostics
```

Use the same explicit `PATH`, `RUSTC` and compatible `CARGO_TARGET_DIR` for every
compared revision. The reduced dev/test overrides, one Cargo job, offline/locked
resolution, compiled source/nonce handshake and private binary staging above
still apply. Build before measuring; never time an operation during a Cargo job.
The first build after a toolchain change can recompile dependencies. Its duration
is excluded from the series. Keep three successive fresh processes per mode and
revision, clean sources and the source/binary/lock fingerprints. Aggregate with
the median of process-level p50 and p95, not a percentile over pooled samples.

The fixture remains 100, 1,000 or 10,000 messages with 256 ASCII content bytes,
identical seed timestamps and ordered distinct IDs. Seeding is outside timing.
Both modes perform 10 warmups and 100 retained samples. Every append commits,
so final row counts are 210, 1,110 and 10,110. The example now requires the exact
current migration set `[1,3,4,5,6,7,8,9,10,11,12]`, with WAL, synchronous NORMAL,
foreign keys and the production pool configuration. No migration was added.

Read diagnostics report pool acquisition, `fetch_all` and conversion of the
complete 14-column projection into `Message`. Fetch includes SQLite execution,
SQLx worker dispatch, value copies, row-channel transfer and row allocation.
Conversion includes field decoding, strings, model allocation and destruction
of fetched SQLx rows. Every diagnostic output is compared field for field and
in order against the real repository outside timing. These phase percentiles
cannot be added or subtracted to reconstruct an operation percentile.

A separate engine diagnostic locks the actual SQLx SQLite handle, prepares and
binds the same SELECT, steps all rows and finalizes the statement. It records
exact returned rows and VM steps. This uses the same locked SQLite library and
file, with no SQLx row objects or Rust text/model copies. Pool/handle acquisition
is excluded; statement preparation is included, unlike a warmed SQLx statement
cache. It is an executed diagnostic with a different boundary, not an estimate
of the SQLite contribution inside an asynchronous repository call. The pinned
`libsqlite3-sys` dev dependency only exposes this existing library to the example.
It is not a second SQLite engine or a production dependency change.

Write diagnostics replay acquisition, `BEGIN IMMEDIATE`, the insert with FTS,
COUNT, latest-row query, preview conversion, metadata update, commit and result
construction. Statements come from the current source. Execution phases include
SQLx dispatch/scheduling and returned rows, so they are not pure engine timers.
The ordinary mode remains the measurement of actual `create_message`, including
metadata refresh and commit acknowledgement. Diagnostic replay maintenance is
required when the repository control flow changes; a source fingerprint does
not automatically instrument new branches.

The diagnostic also compares reads through a disposable second pool with the
same cloned connection options and only its bounded row channel changed to 512.
This is an exploratory throughput experiment. It does not change the production
pool's default capacity of 50 and cannot justify that global change without
assessing memory/backpressure on other queries and large payloads. Its series
runs after the default pool; order and shared-machine effects remain possible.

`--self-test` separately checks empty/missing histories, all 14 fields with null
and non-null values, reverse insertion with timestamp ties, a future latest
message, Unicode previews, duplicate/FK errors, rollback of the message and FTS
after a metadata failure, and a WAL reader while an append waits for a writer.
It closes and reopens the owned file and compares exact content, order, metadata
and FTS results. Contract checks stay outside comparison runs. Every measured
fixture also checks path ownership, final counts/content/metadata, committed
append IDs, integrity and reopening, then closes and removes its own directory.
Commit-to-file plus reopening is the tested durability boundary; process kill,
power failure and physical-storage guarantees are untested.


### Executed ordinal-decoding comparison

Product base `3ed3a91981ae6d8a5e9811469fe89582c878c1db` was compared with
`c08df292ba7a2db04f40de1e871676640b5c43c5` on clean sources. An intermediate
benchmark-only revision `f55d5558f67971f3a777c5eaa2427bfada4a60f3` supplied the
before-stage diagnostics and an unchanged-product control. All groups used
Rust/Cargo 1.97.1, native SQLite 3.46.0, the reduced debug settings above,
one offline locked Cargo job, and the same cache. Each series ran in three
successive fresh processes from a verified private binary, after Cargo exited.
Values are milliseconds, median of the three process-level p50 / p95 values.

| Seed messages | Base read | Candidate read | Base create + metadata + commit | Candidate create + metadata + commit | Final rows |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1.356 / 1.451 | 0.934 / 0.984 | 0.436 / 0.587 | 0.433 / 0.575 | 210 |
| 1,000 | 12.992 / 13.194 | 8.679 / 8.914 | 0.510 / 1.163 | 0.503 / 1.135 | 1,110 |
| 10,000 | 129.175 / 135.728 | 87.173 / 88.383 | 1.223 / 1.734 | 1.217 / 1.741 | 10,110 |

| Diagnostic, 10,000 rows | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| Direct SQLite prepare/bind/step/finalize | 5.969 / 6.184 | 6.126 / 6.261 |
| Pool acquisition | 0.088 / 0.125 | 0.091 / 0.119 |
| SQLx fetch_all | 61.505 / 63.254 | 61.390 / 62.514 |
| SQLx rows to Message | 67.850 / 68.550 | 25.826 / 26.735 |

The 10,000-row actual repository read decreased by 32.5% at p50 and
34.9% at p95 in this debug fixture. The conversion diagnostic decreased
by 61.9% at p50. The only product change decodes the existing explicit
14-column projection by ordinal rather than looking up every column name. The
diagnostic now calls that actual mapper. An independent named-decode test with
distinct field values, nullable fields, Unicode and timestamp/ID ties protects
the projection contract. Statement contents, ordering, result volume, pool,
transactions, metadata refresh and migrations are unchanged. Source comparison
confirmed the complete create/metadata functions were identical. No write gain
is established.

Query plans used `idx_messages_conversation_created_at_id` for ordered reads
and latest-row selection, and the covering `idx_messages_conversation` for
COUNT, with no temporary sorting tree. The schema fingerprint was
`a0719d4aeb484b4293317cfe6b95a8d6c15b72a9be12f0fdd5af6cc1315df283` in all diagnostic processes, and VM-step counts matched
before/after. The exploratory 512-row channel did not yield a stable fetch gain;
the default remains 50. COUNT cost scales with history size, but replacing it
with a cached increment would change the metadata recomputation contract and
was not justified by these observations.

All 29 repository tests, native self-tests and the two staging/provenance tests
passed. Every measured fixture passed its count, content, metadata, integrity,
reopen and cleanup checks. Shared-machine load and OS caches were uncontrolled,
outliers were retained, and no cold-disk, release-profile, large optional-payload,
JavaScript, transport, production or UI speedup is established. The old Bun
in-memory and historical 128 ms values are separate references. Full aggregate
reports, process timestamps/load, manifests, source/binary fingerprints and
superseded build failures remain outside Git.

### Content protocol 4 after native admission

`bun --no-install dev/performance/native-sqlite.ts --content-baseline --pilot`
runs the current SQLite content pilot with one warmup and three retained samples
at 100, 1,000 and 10,000 messages. It is not reference eligible. After independent
adapter review, the same command without `--pilot` uses ten warmups and 100
samples. A reference requires three fresh sequential processes on clean committed
sources, with each process verified before starting the next.

Protocol 4 requires exact migrations `[1,3,4,5,6,7,8,9,10,11,12,13]` and the
production WAL/NORMAL/FK pool. Its distinct `content-v3-native` fixture retains
the mixed-256 inputs, fourteen-field assistant, provenance v2 receipt,
stream update schedule and batch/tail100 inputs of content-v2. Its definition
and complete Rust content module produce a new SHA-256; content-v2 reports and
hashes remain historical schema-12 evidence. The validator still reads protocol
3 with its original runtime/cell checks, but a current run must publish protocol
4 and the hash of its current fixture source. The older ordinary/diagnostic
modes retain their schema-12 runtime guard and refuse the current bootstrap.

The 38 existing content cells retain their boundaries and admission outcomes.
Four additional cells at each size call the real native repository ports:

| Cell | Timed work | Untimed input and result checks |
| --- | --- | --- |
| `native_version` | Content token transaction and commit | Exact incarnation and decimal revision against the stamp table |
| `native_metadata_open100` | First metadata page, opening, descriptors and commit | First 100 ordered descriptors, exact totals/opening and next anchor |
| `native_metadata_after50` | Continuation from descriptor 49, limit 100 | 50 rows at N=100, otherwise 100; opening absent and next anchor exact |
| `native_window50` | Admission and joined body/receipt/revision fetch for the final 50 IDs, mapping and commit | Exact projected fields, requested order, consumed count and decimal revisions |

These 50 cells retain 150 observations in the pilot or 5,000 per reference
process. Native JSON byte counts are computed outside timing and checked against
the existing 4 MiB admission estimate. They are not IPC or memory measurements.
No new serialization timing cells are added. The N=10,000 bounded full-read
refusal remains a refusal; the successful 50-body window has a different result
volume and cannot be compared as the same operation.

Fixture-derived fields and positions, independent legacy/SQL observations,
FTS, metadata and row counts are checked before mutation resets. Each write and
reset advances the native token without assuming an increment of one, and the
final token and projected fields survive reopen. Native public controls cover a
large receipt refusal, exact admitted prefix, invalid suffix and stale token.
Existing native database tests provide the audited pre-fetch trace witnesses;
the benchmark adds no trace instrumentation. The original legacy payload/fetch
controls remain in place.

The new fixture is a fresh file bootstrapped with migration 13. It does not time
migration of an existing file. DML timings include the production triggers,
metadata/FTS and commit, without isolating the causal cost of triggers. Validation
and reset work stay outside timers but can affect cache and WAL state. Keep
machine sharing, debug profile and OS cache limits in each report. No threshold
or resource limit is raised for this protocol. Source/nonce handshake, private
binary staging, complete stdout/stderr, cleanup and source stability checks stay
required.

This runner measures in-process Rust/SQLx/SQLite on disk. Capture construction,
Tauri IPC, transport, displayed UI, RSS and heap remain unmeasured. A2 SQLite
percentiles and A4 memory-port percentiles cannot be added to claim a complete
path or global gain. This section defines the protocol; it does not announce a
new accepted reference or a performance improvement.
