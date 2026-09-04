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
| `bun run tauri:dev:browser` | Run the Tauri backend and expose its UI to a local browser for debugging. |
| `bun run build` | Build the frontend for production. |
| `bun run tauri:build` | Build the Tauri desktop app. |
| `bun run tauri:build:dmg` | Build a native macOS DMG. |
| `bun run tauri:build:dmg:mac-universal:test` | Build a universal macOS DMG for Apple Silicon and Intel Macs. |
| `bun run typecheck` | Run TypeScript type checking. |
| `bun run lint` | Run ESLint. |
| `bun run i18n:audit` | Audit locale coverage. |
| `bun run test` | Run frontend and service tests with bounded parallelism. |
| `bun run test:coverage` | Run the same tests with per-file coverage reports under `coverage/tests/`. |
| `bun run ci:pre-push` | Run the fast changed-file gate used by the pre-push hook. |
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

## Browser UI with the Tauri runtime

Use the browser runtime bridge when UI inspection or browser automation needs
the real local database, workspace, terminal, Git, and AI command handlers:

```bash
bun run tauri:dev:browser
```

Then open `http://127.0.0.1:1422/`. Vite still provides hot module replacement,
while Tauri runs as a hidden host and executes IPC commands for the browser.
Backend events used by configuration, terminals, authentication, downloads, and
streaming chat are relayed to the browser as well.

This bridge is intentionally unavailable in production builds: enabling its
Cargo feature in a release build is a compile-time error. The dedicated launcher
creates a new 256-bit token for every run and gives it to the Tauri host and Vite,
which injects it into the local browser page. The token is therefore visible in
that page's DevTools; it protects against unrelated browser origins, not against
a hostile process already running on the machine. The WebSocket server also
requires the exact `http://127.0.0.1:1422` browser origin and binds only to
`127.0.0.1:1430`. Always use `bun run tauri:dev:browser`; do not expose either
local port through a proxy.

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

Local validation and release publication are separate steps. Passing local
checks does not validate installers for every supported platform or publish a
release. Windows and Linux release packages are built in GitHub Actions;
local macOS universal builds remain available for smoke testing.

## Validation

Run the smallest check that proves the change during development. The focused
commands available for that work are:

```bash
bun run version:check
bun run repo:check-binaries
bun run typecheck
bun run lint
bun run i18n:audit
bun run test
cargo test --manifest-path src-tauri/Cargo.toml
```

The pull request workflow runs the required exhaustive profiles before merge.
When the risk justifies reproducing those profiles locally, the full local CI
command also builds the frontend and checks bundle size:

```bash
bun run ci
```

Notes on validation cost and behavior:

- Tests run one `bun test` process per file for isolation, with a bounded
  concurrency (6 by default, overridable with `--concurrency=<n>` or
  `MACRO_TEST_CONCURRENCY`). Pass a filter such as `bun run test composer` to
  run a subset, or `--list` to print the selected files.
- Coverage is opt-in through `bun run test:coverage`; plain runs skip
  instrumentation entirely. Each run clears stale data, keeps isolated raw
  reports in `coverage/tests/<file>/`, and writes the merged application-line
  report to `coverage/lcov.info` plus a domain summary in
  `coverage/summary.json`. The summary lists application files that no test
  loaded. On a filtered coverage run, that list describes only the selected
  subset and the console summary labels it accordingly. Bun 1.3.14 does not
  expose function or branch identities in LCOV, so
  those metrics remain explicitly unavailable instead of being approximated.
- `bun run build` type-checks then bundles; it is meant for humans and release
  packaging (`tauri:build`). Local CI profiles typecheck once and then build
  with Vite only (`build:vite`), so tsc never runs twice.
- Native profiles run Rust tests with `--all-targets`, then reuse the same Cargo
  artifacts for documentation tests instead of recompiling examples through a
  separate `cargo check` pass.

Before pushing, prefer the differential gate:

```bash
bun run ci:pre-push
```

It compares the whole proposed integration range and runs only cheap global
policies plus lint, related tests, Rust formatting, or repository policy checks
selected from changed paths. It does not install, build, type-check the whole
application, or run complete suites. GitHub performs those exhaustive checks
before merge; use `bun run ci` for the same full validation locally when needed.
The successful fast plan is cached for the exact range and platform.

The tracked `pre-push` hook enforces the same command. Install it with
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
