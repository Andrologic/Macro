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
