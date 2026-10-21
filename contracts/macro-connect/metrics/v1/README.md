# Macro Connect measurement format v1

This is the canonical measurement contract owned by the desktop repository.
Mobile and relay adapters import this directory unchanged after its audited
integration, recording the desktop commit and Git tree/blob IDs. Wire contracts
under `macro-pilot` are separate and unchanged. This format does not enable a
product capability.

`schema.json` is JSON Schema 2020-12. `validate.mjs::validateReport` also checks
ordered percentiles, duplicate metrics, imported schema/profile hashes and
measurement boundaries. Consumers use both checks. The desktop declares exact development dependencies `ajv` 8.20.0 and
`ajv-formats` 3.0.1 in package.json and bun.lock. No remote schema resolution
occurs. A JavaScript consumer importing `validate.mjs` must also declare these
exact direct dependencies and lock them in its own toolchain. Transitive
hoisting is insufficient. The mobile adapter may validate emitted JSON in this
Bun/Node conformance helper; its Dart product runtime does not import Ajv.
The schema and fixture JSON themselves have no package dependencies. `fixtures.mjs`
and `profiles.json` supply deterministic generated messages and event schedules.
The catalogue of metric names, units and permissible methods lives in the schema.
Unknown properties are rejected throughout. Reports have no transcript, path,
account, URL, credential or arbitrary diagnostic field. Toolchain strings carry
only the runtime version. Aggregate reports still belong outside public Git.

Each metric declares its role and scope. Evidence is one of:

| Evidence | Meaning | Required fields |
| --- | --- | --- |
| `measured` | Instrument ran against the actual declared operation | Method and nonempty distribution |
| `simulated` | Deterministic fixture clock or model | `deterministic-clock` and distribution |
| `estimated` | UTF-8 serialized JSON size | `json-utf8` and distribution, only `serialized_bytes` |
| `not-measured` | No observation at this boundary | Reason and scenario recipe, no numeric value |

A serialized estimate cannot become RSS, heap, HTTP or IPC bytes. RSS requires
`native-process-rss`, native role and process scope. Heap uses `runtime-heap`
and process scope. Neither memory metric admits simulated or estimated evidence.
A schema can validate declarations, but cannot prove that an instrument ran.
Review the adapter and retain raw evidence and commands outside Git.

`summary` contains a positive sample count and nearest-rank p50, p95 and max.
Units belong to each metric and the schema fixes them. A zero is an observation
only when an instrument actually observed zero. Missing metrics are never zero.
The report records all three exact repository SHAs; `measured_repository`
identifies which one ran. Each fixture records its exact dimensions and definition SHA-256. The shared
profile sizes are the default comparison matrix; adapters may declare existing
fixture sizes without pretending they are the native 256-byte fixture.
The other SHAs identify the comparison cohort, not a
claim that its adapter ran. Source, lockfile and contract hashes are required;
a native SQLite measurement also requires its run's verified binary hash.

`process_index` identifies successive fresh executions. Keep their distributions
separate. Do not pool samples or sum phase percentiles. Full raw native reports
retain each binary hash, toolchain settings, schema and integrity checks.
Each run retains its process binary hash; retain all raw reports when comparing
several processes. Every run lists every metric, with explicit missing entries,
and a report covers all six scenario recipes. Per-target counters use `scope`
`target` and one of the three synthetic target names.

Use `compareMetric` only after validating reports and confirming the same
fixture, profile, platform, runtime, operation boundary, preparation and warmup.
It compares p95 against a supplied policy ratio and returns `not-comparable`
when either entry is absent, simulated or estimated. It establishes no causal
gain. Source revisions are expected to differ during a controlled comparison.

See [the protocol](../../../../docs/macro-connect-measurement-protocol.md) for the
six recipes, exclusions, budgets and remaining validation.
