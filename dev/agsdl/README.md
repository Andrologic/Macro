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
test and its variant with Bun removed from PATH. These checks run without a
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
