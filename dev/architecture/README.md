# Architecture guards

`bun run architecture:check` runs the TypeScript graph ratchet and the bounded
extraction guards in `extracted-boundaries.mjs`. JSON reports expose violations
under `extractedBoundaries` and list the native files inspected. `--base <ref>`
reads both TypeScript and native files from that Git revision.

The eight named Chat runtime entries cannot import React, ReactDOM or Zustand
at runtime, including through local dependencies, reexports and lazy imports.
Their direct runtime imports also cannot target the concrete Tauri IPC façade
or domain wrappers (`services/ipc/*` except pure `*.types.ts` contracts), Tauri
runtime bridge, HTTP, browser transport, dialog/window adapters, streaming,
provider or composition adapters, or an `@tauri-apps/*` package.
The existing TypeScript parser, transpiler and alias resolver determine these
edges; type-only imports remain allowed. This is not a claim that every Chat
dependency is transport-free: tool execution still reaches configuration
transports through `configurationClient`. Package internals are not traversed.

The native guard scans only the extracted command-error, DB-state, MCP-ID,
workspace-execution, filesystem-operation and Git-operation modules listed in
`extracted-boundaries.mjs`, including their nested Rust files and tests. It is a
textual identifier check, reserving `commands`, `tauri`, `AppHandle`, `State` and
`Window` in that scope. It catches qualified paths, grouped imports and renames
without a Rust parser. Comments and string literals are deliberately included;
an occurrence there requires review too. It does not resolve module aliases,
glob imports, macros, reexports or transitive dependencies. Real adapter modules,
including diagnostics, are outside this scope. Rust compilation remains necessary.

Neither guard has baseline exceptions. Regenerating the historical graph baseline
cannot accept a regression in these boundaries. Existing SCC budgets and service
exceptions are unchanged.

The frontend and all native profiles, including native-core and Windows, run
`architecture:check`. The fast changed-file gate also selects it for changes or
deletions in the extracted native scope, using the same scope predicate as the
guard. Revalidate the guards on the final integrated revision before the full
audit.
