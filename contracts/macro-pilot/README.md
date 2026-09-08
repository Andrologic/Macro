# Macro Pilot contract

## Content/account extension

The opt-in `2.0` extension is defined by [v2/schema-set.json](v2/schema-set.json)
and the [normative specification](../../docs/macro-pilot/content-contract-v2.md).
It adds separate Implement and global Conversation catalogs, immutable diff
pagination and native account/session management. Version 1.0 remains frozen.
This is a consumable contract, not a claim of integrated runtime support.
Run `bun contracts/macro-pilot/test/validate-content.mjs`; follow the
[C/D/E guide](../../docs/macro-pilot/content-consumer-guide.md) for integration.


This directory contains the portable wire contract shared by Macro, its relay,
and the Flutter companion. It does not implement the service or the relay.

## Stable contract

Version `1.0` uses JSON Schema 2020-12. Load the registry in
[`v1/schema-set.json`](v1/schema-set.json), register every listed resource by
its `$id`, then compile the root identifier declared by the registry.
[`v1/schema.json`](v1/schema.json) is the root inside that set; it is not a
standalone bundle. This explicit loading sequence is the same for Rust,
TypeScript and Dart validators. The root rejects unknown message types and
contract versions. Domain schemas keep identity, supervision and transport
rules separate while sharing the identifiers in
[`v1/common.schema.json`](v1/common.schema.json).

Fixtures under `v1/fixtures/valid` are language-neutral inputs for future Rust,
TypeScript, and Dart consumer tests. Files under `v1/fixtures/invalid` describe
messages that a consumer must reject. This lot runs the fixtures with Ajv under
Bun. Consumer-specific validators belong to their implementation lots.

Fixtures are synthetic, offline examples, not production exports. Numeric
GitHub subjects and avatar URLs are illustrative values; validation does not
contact GitHub. Negative fixtures deliberately contain dummy token signatures
and fictional paths to prove rejection.

Run the focused conformance check from the repository root:

```sh
bun contracts/macro-pilot/test/validate-contract.mjs
```

The check validates every schema and fixture. It also enforces the relational
rules listed in `x-semantic-rules`, which standard JSON Schema cannot express.

The [native transport specification](../../docs/macro-pilot/native-transport.md)
defines authentication, association and relay routes for the desktop, server
and mobile implementations. Its separate `transport/schema.json` registers
alongside the A1 registry and validates relay envelopes without changing A1.
Run `bun contracts/macro-pilot/test/validate-transport.mjs` for its shape checks.
Authentication, authorization and replay scenarios still require consumer tests.

## Contract boundaries

The mobile payloads contain opaque identifiers, display labels, Git object
IDs and state. No stable field represents a provider token, session secret,
repository credential or machine path. Producers must redact sensitive text
before constructing an envelope, and relay or mobile consumers must never log
unredacted input. The `safeText` patterns reject common secret and machine-path
signatures as defence in depth; passing the schema is not proof that arbitrary
sensitive text is absent. A relay can forward the same envelopes without
becoming the canonical store.

Read [`docs/macro-pilot/compatibility.md`](../../docs/macro-pilot/compatibility.md)
before implementing a consumer. The confirmed desktop execution architecture,
native sign-in flow, public/private repository boundary and remaining product
decisions are recorded in
[`docs/macro-pilot/open-decisions.md`](../../docs/macro-pilot/open-decisions.md).
The mapping to Macro's current task, project, and questionnaire types is in
[`docs/macro-pilot/macro-type-mapping.md`](../../docs/macro-pilot/macro-type-mapping.md).
Before updating C, D or E, apply the unpublished A1 migration checklist in
[`consumer-update.md`](../../docs/macro-pilot/consumer-update.md).
