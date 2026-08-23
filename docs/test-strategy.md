# Test strategy

Macro's test suite should make local changes safe without turning every push into
a full release rehearsal. Tests are selected by risk and observable behavior,
not by a target count.

## Validation profiles

- During development, run the closest test file and the smallest relevant static
  check.
- Before pushing, run `bun run ci:pre-push`. Its differential selection is the
  repository gate for ordinary changes.
- Run `bun run test` when shared frontend infrastructure, test setup, or broad
  application behavior changes.
- Run `bun run test:coverage` for coverage audits. It is diagnostic and does not
  belong in the ordinary pre-push path.
- Run `bun run test:e2e:headless` when the headless HTTP boundary, authentication,
  configuration bootstrap, or workspace bootstrap changes. The smoke test uses
  temporary configuration and workspace directories.
- Run the Rust suite when native commands, persistence, Git, filesystem, or
  remote-kernel behavior changes.

## What belongs in the suite

Prefer the lowest level that proves the behavior:

1. Pure unit tests for parsing, normalization, policy, and state transitions.
2. Store and service tests that keep real domain code and mock only process,
   network, filesystem, database, or Tauri boundaries.
3. Component tests for user-visible state, interactions, accessibility, and
   coordination between already-tested domain modules.
4. A small future end-to-end layer for critical cross-process journeys that
   cannot be proved below the application boundary.

Do not add tests that only assert a mock was rendered, repeat a dependency's own
tests, mirror production logic inside a fake, or wait for arbitrary wall-clock
delays. Use explicit promises, observable state, or controlled clocks for
concurrency and timing.

## Coverage interpretation

`coverage/summary.json` is the source of truth for frontend line coverage. The
report distinguishes files that were instrumented from production files that no
test loaded, and it groups results by application domain. A filtered run only
describes its selected test subset.

Coverage is a triage signal, not a merge quota. Prioritize an uncovered module
when a regression would affect durable data, Git or workspace state, security,
provider selection, task lifecycle, or a critical user path. Do not add tests to
dead code or presentation-only wrappers merely to raise the percentage. Bun
1.3.14 does not provide function or branch identities in LCOV, so those metrics
remain unavailable until the instrumentation source changes.

## Maintenance rules

- A flaky test is a defect. Replace races and sleeps with deterministic signals;
  do not add retries to the assertion itself.
- Shared test utilities must model infrastructure, not business rules.
- Reset global mocks, environment variables, timers, DOM roots, and store state
  to their exact prior values.
- Delete or merge a test only when another test protects the same observable
  behavior and failure mode. Keep distinct boundary and recovery cases even when
  their setup looks similar.
- When a production bug is fixed, add the smallest regression test at the layer
  where the bug originated.
- Keep test files aligned with one domain. A large shared harness should expose a
  compact context API before the scenarios are split across files.

## Refactoring sequence

The current refactor follows these independent, reviewable stages:

1. Aggregate isolated Bun coverage reports, remove stale output, and publish
   exact application-line and per-domain diagnostics.
2. Stabilize `ChatZone` module loading, extract generic store-hook and deferred
   primitives, and restore leaked process environment state.
3. Add direct tests for high-risk services that were previously exercised only
   through mocks or large integration suites.
4. Convert `ChatZone.test.tsx` to a context-owned harness. Only then split the
   questionnaire, compaction, Architect, and Implement domains into separate
   files. The current cache-busted import per test is an intentional isolation
   boundary and a known runtime cost. Splitting first would duplicate global
   `mock.module` registrations and allow cross-file contamination.
5. Replace the broad `useChatStore.test.ts` harness with domain-specific service
   and store fixtures, then split its scenarios along the same domain boundaries.
6. Introduce controlled clocks for the remaining deliberate 400 ms UI delays,
   and add a minimal end-to-end smoke layer only for journeys that cross the
   frontend/native boundary.

Each stage must pass its focused tests, the full frontend suite, type checking,
linting, and an OX Alpha review before it is considered complete.
