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
- [Node.js](https://nodejs.org/) (optional, Bun is preferred)

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
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start Vite development server |
| `bun run build` | Build frontend for production |
| `bun run preview` | Preview production build |
| `bun run tauri:dev` | Run Tauri in development mode |
| `bun run tauri:build` | Build Tauri application |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run lint` | Run ESLint |
| `bun run clean` | Clean build artifacts |
| `bun run update` | Update dependencies |
| `bun run test` | Run tests with Bun test runner |
| `bun run ci` | CI pipeline (install + typecheck + build) |

## Bun Configuration

This project uses Bun with optimized settings:

- **Isolated Installs**: Strict dependency isolation (pnpm-like) via `linker = "isolated"`
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

- **Faster installs**: Up to 30x faster than npm with isolated installs
- **Strict dependency isolation**: Prevents phantom dependencies
- **Built-in test runner**: Jest-compatible API with built-in coverage
- **Native TypeScript support**: No additional configuration needed
- **Auto-install**: Dependencies installed automatically when missing
- **Hardlinks**: Disk space optimization on Windows/Linux

### Environment Variables

Create a `.env` file in the project root:

```env
VITE_DATA_PROVIDER=mock  # or 'ipc' for production
VITE_BACKEND_TRANSPORT=desktop  # 'desktop' (default) or 'remote'

# Remote backend (used when VITE_BACKEND_TRANSPORT=remote)
VITE_REMOTE_API_BASE_URL=http://localhost:3000
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

### Local API Keys for Dev

To avoid re-entering provider API keys in Settings on every dev restart, create a local keys file:

```bash
cp public/ai-keys.local.example.json public/ai-keys.local.json
```

Then edit `public/ai-keys.local.json` with your real keys.

- File format supports provider IDs (`openai`, `anthropic`, `openrouter`, `zai`, etc.)
- Provider keys are matched flexibly (`zai` and `z.ai` both work)
- `apiKey` is enough in most cases
- `baseUrl` is optional and only needed for custom/proxy endpoints
- This file is ignored by git (`public/ai-keys.local.json`)

Example:

```json
{
  "providers": {
    "openai": {
      "apiKey": "sk-..."
    },
    "openrouter": {
      "apiKey": "test-api-key..."
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
No additional dependencies required.

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
```

Built applications will be in `src-tauri/target/release/bundle/`.

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
- `GET /v1/tools/mode-policy?mode=Architect|Chat|Implement|Debug`
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
