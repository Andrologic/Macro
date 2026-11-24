# AgSDL execution conformance

Run from the repository root, with Bun and the normal native build dependencies:

```sh
bun dev/ci/argentic.mjs macro test --locked --jobs 2 \
  --lib conformance030_tests -- --nocapture --test-threads=1
bun dev/ci/argentic.mjs argentic-runtime test --locked --jobs 2 \
  --lib conformance030_tests -- --nocapture --test-threads=1
```

The first command compares the locked Argentic compiler, work controller,
routes, call-data and clock evaluators with the retained TypeScript evaluators
through a Bun JSON-lines subprocess. The second command runs Argentic's native
conformance tests using temporary SQLite databases. It includes the 37-scenario
test, its variant with Bun removed from PATH, and the 0.4 published
scenarios. These checks run without a
display or a provider account. Missing Bun fails the differential. A missing
scenario, unsupported timeline event, unfinished run or contract mismatch fails
conformance. Numeric tokens remain exact.

`agsdl030_conformance_error_route` checks the initial integration separately.
`agsdl030_conformance_all_37_scenarios` replays every pinned timeline and compares
`run`, `starts`, `messages`, `joins`, `failures`, `cancelled` and `answers` using
the upstream partial-object, exact-list and unordered-failure/cancellation
rules. Expectations are read only after execution and projection.

Agent-only timelines use `supervise_with_emitter030`, the production supervisor,
with scripted agent executors. Calls, human interactions, time and steering use
the existing scripted driver with the production `drain_effects030` dispatcher
until those executors are connected to the full supervisor. These are explicit
coverage limitations, not product qualification. The final report distinguishes:

- `N`: production supervisor, within the current product feature slice;
- `M`: scripted coverage outside that slice, reporting the exact path and reason;
- `K`: failures, which also fail Cargo.

For this classification only, the fictional `example` harness name is replaced
with `codex` before calling the real `product_slice030` check. The executed
document is unchanged. Captures and provider observations are local fixtures;
these tests do not qualify Codex, process confinement or UI integration.

The two compose expectations use the declared upstream erratum
`f5551b8af9e099787a85e391b3ce458927f3ccd2`, recorded in
[`fixtures/v0.3/provenance.json`](fixtures/v0.3/provenance.json).

`bun run ci` runs both suites without a QA feature. `ci:pre-push` selects the
runtime suite for relevant engine, fixture, helper and CI changes.

The optional `agsdl-engine-qa` Cargo feature selects additional native executor
regression tests. Scripted executors compile only under `cfg(test)`; this feature
no longer enables a separate QA application or launch configuration.

## AgSDL 0.4.0 authoring and package checks

Run `bun dev/agsdl/check-reader-parity-040.mjs` to compare browser validator
reports with the pinned Python reference, and
`bun dev/agsdl/check-browser-reader-040.mjs` to check the browser bundle in
a separate JavaScript realm. The fixtures and their hashes are under
[`fixtures/v0.4`](fixtures/v0.4/provenance.json). The 0.3 scenario fixtures
above still cover historical execution.

Run the native `agsdl040_project_and_archive_open_and_run_with_scripted_codex`
test in Macro's library to open a project and a matching archive through
Argentic and run each assembled JSON document through Macro with a scripted
Codex executor. The test uses temporary storage. The normal Macro launch path
still takes a JSON document. Argentic's
[standalone host](https://github.com/Andrologic/argentic/blob/826170f56ec13885c205de347fe2750c84253ec2/crates/argentic-runtime/HOST.md)
can launch from a retained project or archive and can use a qualified Codex
profile for a real provider test.
