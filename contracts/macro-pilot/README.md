# Macro Pilot contract

This directory contains the portable wire contract shared by Macro, its relay,
and the Flutter companion. It does not implement the service or the relay.

## Stable contract

Version `1.0` uses JSON Schema 2020-12. Start validation with
[`v1/schema.json`](v1/schema.json). The root schema rejects unknown message
types and contract versions. Domain schemas keep identity, supervision, and
transport rules separate while sharing the identifiers in
[`v1/common.schema.json`](v1/common.schema.json).

Fixtures under `v1/fixtures/valid` are language-neutral inputs for future Rust,
TypeScript, and Dart consumer tests. Files under `v1/fixtures/invalid` describe
messages that a consumer must reject. This lot runs the fixtures with Ajv under
Bun. Consumer-specific validators belong to their implementation lots.

Run the focused conformance check from the repository root:

```sh
bun contracts/macro-pilot/test/validate-contract.mjs
```

The check validates every schema and fixture. It also enforces the relational
rules listed in `x-semantic-rules`, which standard JSON Schema cannot express.

## Contract boundaries

The mobile payloads contain opaque identifiers, display labels, Git object
IDs, and state. No stable field represents a provider token, session secret,
repository credential, or machine path. The schemas reject common secret and
machine-path signatures in free text. Producers still redact sensitive text
before validation. A relay can forward the same envelopes without becoming the
canonical store.

Read [`docs/macro-pilot/compatibility.md`](../../docs/macro-pilot/compatibility.md)
before implementing a consumer. Product choices that are not part of version
`1.0` are recorded in
[`docs/macro-pilot/open-decisions.md`](../../docs/macro-pilot/open-decisions.md).
