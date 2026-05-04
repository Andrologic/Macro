# Macro

A modern, high-performance desktop application built with React, TypeScript, Tauri, and Bun.

## Features

- ⚡ **Lightning Fast**: Built with Bun for optimal performance
- 🎨 **Beautiful UI**: Modern interface with Tailwind CSS
- 🔒 **Secure**: Rust-powered backend with Tauri
- 🚀 **Optimized**: Code splitting and lazy loading for fast startup
- 🌙 **Theming**: Multiple themes with instant switching
- 💻 **Cross-Platform**: Windows, macOS, and Linux support

## Prerequisites

- [Bun](https://bun.sh) >= 1.1.0
- [Rust](https://rustup.rs/) (for Tauri)
- [Python](https://www.python.org/) only if you need to run `bun run i18n:generate`

## Quick Start

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Build for production
bun run build

# Run Tauri development
bun run tauri:dev

# Build Tauri app
bun run tauri:build

# Build a macOS DMG
bun run tauri:build:dmg
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start Vite development server |
| `bun run build` | Build frontend for production |
| `bun run preview` | Preview production build |
| `bun run tauri:dev` | Run Tauri in development mode |
| `bun run tauri:build` | Build Tauri application |
| `bun run tauri:build:dmg` | Build a native macOS DMG installer |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run lint` | Run ESLint |
| `bun run clean` | Clean build artifacts |
| `bun run update` | Update dependencies |
| `bun run test` | Run tests with Bun test runner |
| `bun run version:sync` | Sync secondary version manifests from `package.json` |
| `bun run version:check` | Verify version consistency across app manifests |
| `bun run version:bump` | Bump `package.json` version and sync dependent files |
| `bun run ci` | CI pipeline (install + typecheck + lint + i18n audit + cargo check + build) |

## Versioning

`package.json` is the single source of truth for the application version.

- `src-tauri/tauri.conf.json` reads the version from `../package.json`
- `src-tauri/Cargo.toml` is synchronized from `package.json`
- `src-tauri/Cargo.lock` keeps the root package version synchronized from `package.json`
- `flake.nix` derives its package version from `package.json`
- the desktop UI reads the runtime app version from Tauri, with a Vite fallback sourced from `package.json`

Use these commands for version management:

```bash
bun run version:check
bun run version:sync
bun run version:bump patch
bun run version:bump rc
bun run version:bump weekly
bun run version:bump weekly 20260325
```

Release channels:

- stable releases use `major`, `minor`, and `patch`
- release candidates use `bun run version:bump rc` and produce versions like `0.2.1-rc.0`
- weekly releases use `bun run version:bump weekly` and produce versions like `0.2.1-weekly.20260325.0`

## Weekly Releases

Weekly releases are automated through [`.github/workflows/weekly-release.yml`](.github/workflows/weekly-release.yml).

- schedule-driven releases only run from the repository default branch on GitHub
- the current cron is Monday at 08:17 UTC (`17 8 * * 1`)
- the workflow bumps the app to the next `weekly` prerelease, commits the version files, tags `v<version>`, and publishes a signed Apple Silicon GitHub prerelease
- release candidates stay manual and should be cut locally with `bun run version:bump rc`

## Stable macOS Releases

Stable macOS releases are published through [`.github/workflows/release-macos.yml`](.github/workflows/release-macos.yml).

- target architecture is Apple Silicon only (`aarch64-apple-darwin`)
- output bundles are notarized `.app` and `.dmg` artifacts
- auto-update is intentionally disabled for now; users update by downloading a newer release manually
- the workflow expects Apple signing and notarization secrets to be configured in GitHub Actions

## Bun Configuration

This project uses Bun with optimized settings:

- **Hoisted Installs**: Compatibility-first installs via `linker = "hoisted"`
- **Auto-install**: Automatic dependency installation when `node_modules` is missing
- **Exact Versions**: Exact versions saved to `package.json`
- **Text Lockfile**: Human-readable `bun.lock` for better git diffs

See [`bunfig.toml`](bunfig.toml) for complete configuration.

## Project Structure

```
macro/
├── src/                    # Frontend source code
│   ├── components/         # React components
│   ├── hooks/             # Custom React hooks
│   ├── services/          # API and service layer
│   ├── stores/            # Zustand state management
│   ├── types/             # TypeScript type definitions
│   └── utils/             # Utility functions
├── src-tauri/             # Rust backend code
├── public/                # Static assets
├── dist/                  # Build output
├── bunfig.toml           # Bun configuration
├── package.json          # Project dependencies
├── tsconfig.json         # TypeScript configuration
└── vite.config.ts        # Vite configuration
```

## Technology Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS
- **Backend**: Rust, Tauri
- **Build Tool**: Vite
- **Package Manager**: Bun
- **State Management**: Zustand, Jotai
- **UI Components**: Custom + Lucide icons

## Performance Optimizations

This project includes several performance optimizations:

- **Code Splitting**: Lazy-loaded components by mode
- **Bundle Optimization**: Manual chunks for vendors
- **Theme Caching**: Instant theme switching with localStorage
- **Lazy Loading**: CodeMirror loaded on demand
- **Optimized Init**: Priority-based store initialization

## Development

### Using Bun

Bun is the recommended package manager and runtime for this project. It provides:

- **Faster installs**: Up to 30x faster than npm
- **Single runtime for repo scripts**: Internal `.mjs` scripts run with Bun, so Node.js is not required for normal development
- **Hoisted compatibility**: Matches the repository's `linker = "hoisted"` setup
- **Built-in test runner**: Jest-compatible API with built-in coverage
- **Native TypeScript support**: No additional configuration needed
- **Auto-install**: Dependencies installed automatically when missing
- **Hardlinks**: Disk space optimization on Windows/Linux

### Environment Variables

Create a `.env` file in the project root:

```env
VITE_BACKEND_TRANSPORT=desktop  # 'desktop' (default) or 'remote'
VITE_DATA_PROVIDER=mock         # desktop only: 'mock' in browser, 'ipc' in Tauri

# Remote backend (used when VITE_BACKEND_TRANSPORT=remote)
VITE_REMOTE_API_BASE_URL=http://localhost:3000
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

Remote transport contract:

- `VITE_BACKEND_TRANSPORT=remote` is sufficient to switch the `services` layer to the remote provider.
- `VITE_DATA_PROVIDER` is only used for desktop transport. If it is set while `VITE_BACKEND_TRANSPORT=remote`, it is ignored.
- The current remote mode is intentionally minimal. It supports workspace bootstrap, task catalog, Git tree/history, remote tool policy/validation/execution, and local browser persistence for tool/MCP preferences.
- Project creation/import/edit flows, Git worktree flows, file preview from the Git tree, and local implementation actions remain desktop-only in this pass.

### Local AI Provider Config for Tauri Dev

Recommended for day-to-day macOS development: to avoid repeated keychain prompts and re-entering provider API keys on every `bun run tauri:dev` restart, create a local provider config file:

```bash
cp dev/ai-keys.local.example.json dev/ai-keys.local.json
```

Then edit `dev/ai-keys.local.json` with your real keys and any dev-only provider definitions.

- File format supports legacy key-only overrides for existing provider IDs (`openai`, `anthropic`, `openrouter`, `zai`, etc.)
- Declarative entries can define a dev-managed provider with `name`, `providerType`, `baseUrl`, and optional `apiKey`/`isLocal`
- For declarative entries, the JSON object key becomes the canonical provider ID
- Provider keys are matched flexibly (`zai` and `z.ai` both work)
- `apiKey` is enough in most cases
- `baseUrl` is optional and only needed for custom/proxy endpoints
- In `bun run tauri:dev`, declarative entries sync their `name`, `providerType`, `baseUrl`, and `isLocal` into the local provider database
- Providers not declared in this file remain user-managed in the app
- This file is ignored by git (`dev/ai-keys.local.json`)
- The preload only works in `bun run tauri:dev`
- `bun run dev`, `bun run build`, and `bun run tauri:build` do not load this file
- Remove any legacy `public/ai-keys.local.json`; the build now fails if a secret file remains in `public`

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
    },
    "opencode-go": {
      "name": "OpenCode Go",
      "providerType": "openai",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "apiKey": "OPENCODE_GO_API_KEY_HERE"
    }
  }
}
```

### Tauri Development

For Tauri development, ensure you have the required system dependencies:

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install libgtk-3-dev libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf
```

**macOS:**
No additional dependencies required for day-to-day development.

For local signed or notarized release builds, install full Xcode in addition to the Command Line Tools.

**Windows:**
No additional dependencies required.

## Building

### Frontend Only

```bash
bun run build
```

### Tauri Application

```bash
# Development
bun run tauri:dev

# Production build
bun run tauri:build

# Native macOS DMG
bun run tauri:build:dmg
```

Built applications will be in `src-tauri/target/release/bundle/`.

On macOS, the DMG is generated at `src-tauri/target/release/bundle/dmg/`.
The Finder presentation intentionally stays minimal and native: app on the left, `Applications` shortcut on the right, no custom background image.

### Apple Silicon Runtime Sidecar

The desktop app compiles an auxiliary AI runtime sidecar into `src-tauri/binaries/` before desktop builds.

- local macOS Apple Silicon builds emit `macro-ai-runtime-aarch64-apple-darwin`
- Tauri embeds the final packaged sidecar as `macro-ai-runtime` inside the app bundle
- the sidecar uses macOS entitlements compatible with Bun's JavaScript runtime

### macOS Release Runbook

1. Ensure `bun run ci` passes locally.
2. Bump and sync the version in `package.json`.
3. Confirm the Apple signing secrets are configured in GitHub Actions:
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`.
4. Trigger [`.github/workflows/release-macos.yml`](.github/workflows/release-macos.yml).
5. Wait for the workflow to build, sign, notarize, staple, and validate the Apple Silicon `.app` and `.dmg`.
6. Download the release artifact on a clean Apple Silicon Mac and smoke test:
   app launch from Finder, terminal commands, Git access, AI runtime startup, keychain access, and notifications.

### Headless Kernel (No GUI)

You can run the backend kernel without the desktop interface:

```bash
cd src-tauri
cargo run --bin macro-headless
```

Optional environment variables:

- `MACRO_HEADLESS_HOST` (default: `127.0.0.1`)
- `MACRO_HEADLESS_PORT` (default: `8787`)
- `MACRO_HEADLESS_BEARER_TOKEN` (if set, required as `Authorization: Bearer <token>`)

Available endpoints (initial implementation):

- `GET /health`
- `GET /v1/tools/mode-policy?mode=Architect|Chat|Implement`
- `POST /v1/tools/validate`
- `GET /api/v1/workspace/bootstrap`
- `GET /api/v1/workspace/tasks`
- `GET /api/v1/projects/:projectId/git/tree`
- `GET /api/v1/projects/:projectId/git/commits`

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Macro is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

You may use the software for free. If you modify Macro, redistribute it, or use a modified version to provide a network service, the corresponding source code must be made available under the same license.

## Acknowledgments

- Built with [Tauri](https://tauri.app/)
- Powered by [Bun](https://bun.sh/)
- UI with [Tailwind CSS](https://tailwindcss.com/)
