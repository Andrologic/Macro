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
under `shared/` because the flow document reader and controllers use them.

`shared/json.mjs` uses Uint8Array and TextDecoder instead of Buffer.
`shared/values.mjs` retains exact numeric equality and decimal comparisons;
the retired 0.2 value-shape validator and schema were removed. Imports were
adapted locally. These files are not byte-identical upstream files. No source
URI is fetched by these helpers.

## AgSDL 0.4.0

Source: https://github.com/Andrologic/AgSDL/tree/v0.4.0
Annotated tag object: fbe06efb1e0568ad0f6d2fbe5a134ec9e09a37c6.
Commit: 65e6529b0af3d1adba1dd9a1419e03c0ec347f21.
License: Apache-2.0, included in `v0.4/LICENSE`.
Copyright 2026 Andrologic SAS and the AgSDL contributors

The JavaScript modules under `v0.4/` port the Python validator for browser
use, including the 0.4 checks for approval comments and fan-out selections
from joins. The shared exact JSON reader keeps number lexemes and member order.
Macro selects validation rules by the document marker to support both
editions. Harness modules 2.0.0 retain the capabilities of module 1.0.0.

Schemas and harness modules retain the published bytes. The 0.4 corpus,
examples, specification and development-only Python oracle are pinned under
`dev/agsdl/fixtures/v0.4/`, with hashes in `provenance.json`. The Python
oracle compares ordered diagnostic codes, severities, locations and joins.
Macro never runs Python to validate a document in the editor.

## AgSDL 0.3.0 compatibility

Source: https://github.com/Andrologic/AgSDL/tree/v0.3.0
Annotated tag object: 4dd9b647cd9d477e5d07e089f23f3a1e7728ea39.
Commit: bd9f8a5b16923476fd20ac2650bd1729ee151917.
License: Apache-2.0, included in `v0.4/LICENSE`.

The browser port originated at this tag. The two schemas in `v0.3/schema/`
are used by the legacy schema differential. The 0.3 execution replay keeps
its fixtures and provenance under `dev/agsdl/fixtures/v0.3/`.
