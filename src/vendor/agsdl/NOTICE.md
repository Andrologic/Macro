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
