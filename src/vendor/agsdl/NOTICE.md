# AgSDL reference reader

Source: https://github.com/Andrologic/AgSDL/tree/v0.1.0
Tag commit: 7a6ad32. License: Apache-2.0, included in LICENSE.

The official reader reuses the experimental directories listed here. They are
included only as dependencies of the adopted 0.1.0 validators. Macro does not
adopt any experimental contract.

Browser adaptations are marked in the three changed upstream modules:

- Web Crypto computes input hashes before synchronous validation.
- Uint8Array and TextDecoder replace Buffer in parsing and byte exchange.
- The wrapper reports its own processor identity, macro/agsdl-browser-reader.

The validation rules and lossless number scanner are unchanged. The example is
the official, non-normative general-purpose-system.json at the same tag.
Validation reports concern their named operations, not execution readiness.

## Shared helpers originating in AgSDL 0.2.0

Source: https://github.com/Andrologic/AgSDL/tree/v0.2.0
Tag commit: ae478d6203dd1571af064317238fd0a0f7dece75. Apache-2.0,
covered by the included LICENSE. Macro retired the 0.2 reader and execution
adapters. Its browser-adapted lexical scanner and exact-value helpers remain
under `shared/` because the 0.3 reader and controllers use them.

`shared/json.mjs` uses Uint8Array and TextDecoder instead of Buffer.
`shared/values.mjs` retains exact numeric equality and decimal comparisons;
the retired 0.2 value-shape validator and schema were removed. Imports were
adapted locally. These files are not byte-identical upstream files. No source
URI is fetched by these helpers.

## AgSDL 0.3.0

Source: https://github.com/Andrologic/AgSDL/tree/v0.3.0
Annotated tag object: 4dd9b647cd9d477e5d07e089f23f3a1e7728ea39.
Commit: bd9f8a5b16923476fd20ac2650bd1729ee151917.
License: Apache-2.0, copied from that commit into `v0.3/LICENSE`.

The modules under `v0.3/` port the reference Python validator to browser
JavaScript. Schemas and harness modules retain the published bytes. The
conformance corpus, examples, specification and development-only Python oracle
are pinned under `dev/agsdl/fixtures/v0.3/`, with file hashes in provenance.json.
Python is used only by development parity checks, never by the product reader.

The 0.3 parser uses the single NumberToken class from `shared/json.mjs`,
also used by Macro's exact-value helpers. Parsing and validation
rules remain edition-specific. The 0.1 report adapter keeps its historical
serializer.

The 0.3 browser parser returns null-prototype exact records with property
hooks that retain insertion order for numeric-looking names, including direct
deletion and reinsertion. These records use JavaScript property proxies and are not structured-cloneable.
Exact snapshots use the lossless serializer and parser, retaining numeric tokens. Iterative value-schema checks retain
the reference order of child and bound diagnostics. The parity gate compares
ordered diagnostic codes, severities, locations and joins; human-readable
messages may use JavaScript JSON formatting instead of Python repr.

The imports from the shared helpers were adjusted locally during retirement.
The 0.3 JavaScript modules are Macro adaptations, not unchanged upstream files.
The pinned schemas, harness modules and official corpus retain their recorded
bytes and attribution.
