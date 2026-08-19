# Development

Macro uses Bun for frontend scripts and Rust/Tauri for the desktop backend.

## Quick Start

```bash
bun install
bun run hooks:install
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
| `bun run ci:pre-push` | Run the differential local gate used by the pre-push hook. |
| `bun run ci:workflows` | Validate workflow YAML and repository Actions policy. |
| `bun run version:check` | Verify synchronized version manifests. |
| `bun run ci` | Run the full local CI pipeline. |
| `bun run release:preflight` | Validate `main`, the release tag, full CI, and local native packaging. |

## Environment Variables

Create a local `.env` file only when you need to override defaults.

```env
VITE_BACKEND_TRANSPORT=desktop

# Remote backend, used when VITE_BACKEND_TRANSPORT=remote
VITE_REMOTE_API_BASE_URL=http://localhost:8787
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

Transport notes:

- `desktop` is the default and requires the Tauri IPC runtime.
- `remote` switches the frontend service layer to the remote provider.
- Remote mode is intentionally minimal in the 0.1 line.

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

GitHub releases are created by `.github/workflows/release.yml`. The workflow
runs only from a newly created annotated `vX.Y.Z` tag whose commit belongs to
`main`. It validates that `package.json` contains the same stable `x.y.z`
version, builds macOS, Windows, and Linux packages, then creates a GitHub
Release draft for manual review.

The current `0.1.0` version is eligible for an official release once its
matching `v0.1.0` tag is created. Windows and Linux release packages are built
in GitHub Actions; local macOS universal builds remain available for smoke
testing.

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

Before pushing, prefer the differential gate:

```bash
bun run ci:pre-push
```

It compares the whole proposed integration range, selects the smallest safe
profile, and caches a successful result for that exact range and platform. The
tracked `pre-push` hook enforces the same command. Install it with
`bun run hooks:install`; bypassing it with `--no-verify` is reserved for an
explicitly authorized emergency.

## Project Map

- `src/` - React and TypeScript frontend.
- `src/components/` - UI surfaces.
- `src/stores/` - Zustand client state.
- `src/services/` - service layer and orchestration.
- `src/types/` - shared TypeScript types.
- `src-tauri/` - Rust/Tauri backend.
- `public/` - static assets and themes.
- `docs/` - product, architecture, and roadmap references.
