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

## AgSDL 0.2.0

Source: https://github.com/Andrologic/AgSDL/tree/v0.2.0
Tag commit: ae478d6203dd1571af064317238fd0a0f7dece75. Apache-2.0,
covered by the included LICENSE. Files under `v0.2/` contain the published
static reader, derived schema and lossless lexical scanner.

Browser adaptations are marked in reader.mjs, values.mjs, declarations.mjs and
json.mjs: CLI I/O is omitted, the schema is bundled locally, Uint8Array replaces
Buffer and ip.mjs supplies IPv6 syntax validation instead of node:net.
The declaration and flow checks are unchanged. No source URI is fetched.
Reports retain their official scope and executionSupport: not-assessed.

The historical 0.1.0 reader remains separate for existing documents. Its reports
are never presented as 0.2.0 reports.

Macro's inline conformance modules `src/services/agsdlExecution/content.ts` and
`constraints.ts` adapt the published 0.2.0 Python helpers `sources.py`,
`check_delivery.py` and `check_completion.py` under the same Apache-2.0 license.
Attribution is retained in those modules. They deliberately reject URI and
non-inline media for Macro's initial execution profile. The vendor reader's
semantics are unchanged; only TypeScript declarations are extended.

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

The 0.3 parser shares only the NumberToken class with the 0.2 scanner so exact
values remain compatible with Macro's execution helpers. Parsing and validation
rules remain edition-specific. The 0.1 report adapter keeps its historical
serializer.

The 0.3 browser parser returns null-prototype exact records with property
hooks that retain insertion order for numeric-looking names, including direct
deletion and reinsertion. These records use JavaScript property proxies and are not structured-cloneable.
Exact snapshots use the lossless serializer and parser, retaining numeric tokens. Iterative value-schema checks retain
the reference order of child and bound diagnostics. The parity gate compares
ordered diagnostic codes, severities, locations and joins; human-readable
messages may use JavaScript JSON formatting instead of Python repr.

## Shared lexical and exact-value helpers

`shared/json.mjs`, `shared/values.mjs`, and their declarations were moved
from Macro's browser-adapted 0.2 reader. Imports in both edition readers and
Macro controllers were adjusted locally. Their lexical and exact-number
behavior is retained, including a single shared NumberToken class. The
0.2 schema remains here temporarily for its static reader. These are local
adaptations, not byte-identical upstream files. Apache-2.0 attribution above
and the adjacent LICENSE continue to apply.
