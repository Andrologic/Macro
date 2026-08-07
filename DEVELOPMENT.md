# Development

Macro uses Bun for frontend scripts and Rust/Tauri for the desktop backend.

## Quick Start

```bash
bun install
bun run tauri:dev
```

The Tauri dev command builds the auxiliary AI runtime first, starts the Vite dev
server, then opens the desktop shell.

## Bun

Bun is the repository package manager and script runtime. Normal development
does not require a separate Node.js install.

The repo uses:

- hoisted installs through `bunfig.toml`;
- exact dependency versions in `package.json`;
- a text lockfile, `bun.lock`, for readable diffs;
- Bun's test runner through `bun run test`.

## Common Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Start the Vite frontend dev server only. |
| `bun run tauri:dev` | Run Macro as a desktop app in development mode. |
| `bun run build` | Build the frontend for production. |
| `bun run tauri:build` | Build the Tauri desktop app. |
| `bun run tauri:build:dmg` | Build a native macOS DMG. |
| `bun run tauri:build:dmg:mac-universal:test` | Build a universal macOS DMG for Apple Silicon and Intel Macs. |
| `bun run typecheck` | Run TypeScript type checking. |
| `bun run lint` | Run ESLint. |
| `bun run i18n:audit` | Audit locale coverage. |
| `bun run test` | Run frontend and service tests. |
| `bun run version:check` | Verify synchronized version manifests. |
| `bun run ci` | Run the full local CI pipeline. |

## Environment Variables

Create a local `.env` file only when you need to override defaults.

```env
VITE_BACKEND_TRANSPORT=desktop

# Experimental internal prototype; not a Macro 0.1 product mode
VITE_REMOTE_API_BASE_URL=http://localhost:8787
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

Transport notes:

- `desktop` is the default and requires the Tauri IPC runtime.
- `remote` is an internal experimental transport used to exercise future-facing code.
- It is not exposed, available, or supported as a Macro 0.1 product mode.

## Local Provider Configuration

For Tauri development, you can preload provider definitions and avoid re-entering
development API keys after every restart:

```bash
cp dev/ai-keys.local.example.json dev/ai-keys.local.json
```

Then edit `dev/ai-keys.local.json`.

Example:

```json
{
  "providers": {
    "openai": {
      "apiKey": "OPENAI_API_KEY_HERE"
    },
    "minimax": {
      "name": "MiniMax",
      "providerType": "openai",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKey": "MINIMAX_API_KEY_HERE"
    }
  }
}
```

Notes:

- The file is ignored by Git.
- The preload only works in `bun run tauri:dev`.
- `bun run dev`, `bun run build`, and `bun run tauri:build` do not load it.
- Remove any legacy `public/ai-keys.local.json`; builds fail if secret files are
  left in `public/`.

## macOS Universal Builds

Use `bun run tauri:build:dmg:mac-universal:test` to produce a DMG that runs on
Apple Silicon and Intel Macs. The build requires both Rust targets,
`aarch64-apple-darwin` and `x86_64-apple-darwin`, and Apple's `lipo` tool from
Xcode Command Line Tools. With rustup:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

## Release Workflow

GitHub Actions release automation is currently suspended; the repository does
not contain an active release workflow. Prepare an official release manually:

1. bump `package.json` to a stable `x.y.z` version;
2. run the validation commands above, `bun run build`, and
   `bun run bundle:check`;
3. build desktop packages on each supported platform with the Tauri commands;
4. create the matching `v<version>` tag and GitHub Release manually, then
   review the artifacts before publishing.

The current `0.1.0-rc.8` version must be bumped to a stable version such as
`0.1.0` before the next official release.

## Validation

Run the smallest check that proves the change. Before opening a pull request,
the expected checks are:

```bash
bun run version:check
bun run repo:check-binaries
bun run typecheck
bun run lint
bun run i18n:audit
bun run test
cargo test --manifest-path src-tauri/Cargo.toml
```

The full local CI command also builds the frontend and checks bundle size:

```bash
bun run ci
```

## Project Map

- `src/` - React and TypeScript frontend.
- `src/components/` - UI surfaces.
- `src/stores/` - Zustand client state.
- `src/services/` - service layer and orchestration.
- `src/types/` - shared TypeScript types.
- `src-tauri/` - Rust/Tauri backend.
- `public/` - static assets and themes.
- `docs/` - product, architecture, and roadmap references.
