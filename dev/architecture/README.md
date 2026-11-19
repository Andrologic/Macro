# Architecture guards

`bun run architecture:check` runs the TypeScript graph ratchet and the bounded
extraction guards in `extracted-boundaries.mjs`. JSON reports expose violations
under `extractedBoundaries` and list the native files inspected. `--base <ref>`
reads both TypeScript and native files from that Git revision.

The named Chat runtime entries, including the lazy `chatToolExecutionRuntime`
implementation behind `chatToolExecution`, cannot import React, ReactDOM or Zustand
at runtime, including through local dependencies, reexports and lazy imports.
Their direct runtime imports also cannot target the concrete Tauri IPC façade
or domain wrappers (`services/ipc/*` except pure `*.types.ts` contracts), Tauri
runtime bridge, HTTP, browser transport, dialog/window adapters, streaming,
provider or composition adapters, or an `@tauri-apps/*` package.
Both the public `streamingChat` façade and its concrete `streamingChatExecution`
implementation are forbidden direct targets. The latter also retains the explicit
forbidden edge to `architectChat`, just like its façade.
The explicit `AI_ADAPTERS` list also covers concrete generation, transport,
cancellation, diagnostic and fallback-tool I/O modules under `services/ai`.
The directory itself is allowed, including runtime codecs and type contracts.
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

## Argentic extraction boundary

The Argentic guard records existing couplings; it does not claim the engine is
already independent. Its explicit Rust scope in `isArgenticFile` follows the
D15 destination map: engine host, permissions, content, confinement, harnesses,
flow and storage logic, plus the shared process, tool policy, stream task, MCP
and exact JSON files. The shared filesystem file `fs/operations.rs`, including
the confined reader and root identity, is checked in full until split, as are
the other mixed files. Capture, catalogue, task targets, mode tools, UI
intentions, product commands and the other UI-only database modules remain
Macro-only and are excluded. Macro resolves the engine through Cargo from the
Argentic repository. The guard still recognizes the former engine source paths
so their removal or reintroduction triggers a check.

Counts are per file and rule; missing entries allow zero. The guard reserves
`tauri`, `AppHandle`, `ts_rs`, `sqlx`, `rusqlite`, and the `crate::` roots db,
commands, config, git, workspace, ai, secrets, project_path, fs and core.
In future core directories `f64` and `as_f64` are always forbidden, including
`parse::<f64>`. A bounded textual scan counts qualified paths and grouped
`crate::{...}` imports, including renames. Comments and strings count too;
root identifiers inside a group are conservatively reserved. Glob imports,
macros, indirect aliases, reexports and transitive dependencies are not
resolved. The guard does not replace compilation or architectural review.

The TypeScript guard uses the existing resolved graph for direct importers of
the evaluation modules listed in `extracted-boundaries.mjs`. Runtime and type
edges are tracked separately, by importer and target. The graph excludes tests,
scenario files, declarations, and `dev/` sources; it is not a complete scan of
all TypeScript. The editor and shared modules retain their existing importers.

The baseline was captured from Git commit
`627ea641d8ab1439ca41e9cd68bb07454ea33c49` with `--base` and
`--capture-argentic`, to a nonexistent output. This one-time operation only
accepts that exact commit. To reproduce it without overwriting the tracked file:

```sh
bun dev/architecture/import-boundaries.mjs --base 627ea641d8ab1439ca41e9cd68bb07454ea33c49 --argentic-baseline /tmp/argentic-initial.json --capture-argentic
```

A check fails for both increases and reductions: remove any new coupling, then
run `bun dev/architecture/import-boundaries.mjs --tighten-argentic` to lower
existing limits after reductions and review the resulting diff. This command
never adds a limit or absorbs an increase; a remaining increase still fails.
Missing or malformed baselines fail closed. When moving or splitting a file in
a later lot, explicitly review any transfer of its limits, verify that the
per-rule total does not increase, and update the baseline with the move. A new
file otherwise receives no allowance. No transfer is automatic.
