# Macro Copilot Instructions

Use the repository-level [AGENTS.md](../AGENTS.md) as the canonical agent guide.
This file only keeps GitHub Copilot-specific routing notes so the two instruction
surfaces do not drift.

## Current Project Facts

- Macro is a React 19, TypeScript, Vite, Tailwind CSS desktop app with a Tauri v2
  Rust backend.
- Bun is the supported JavaScript runtime for repository scripts.
- Frontend state is primarily coordinated through Zustand stores in
  [../src/stores/](../src/stores/).
- Frontend transport and orchestration code lives in
  [../src/services/](../src/services/).
- Native backend code lives in [../src-tauri/](../src-tauri/).

## Copilot-Specific Notes

- Use `VITE_BACKEND_TRANSPORT=remote` only when exercising the remote provider
  path. The default desktop path requires the Tauri IPC runtime.
- When adding a Rust command, update the backend command registration and the
  TypeScript wrapper in [../src/services/tauriIpc.ts](../src/services/tauriIpc.ts)
  before using it from stores or UI code.
- For user-facing notifications, follow the shared `notify.*` rules in
  [../AGENTS.md](../AGENTS.md) and avoid raw toast helpers in feature code.
- Keep tool policies, approval UI, and backend validation aligned when changing
  agent-visible tools.

## Checks

Prefer the smallest relevant subset:

- `bun run typecheck`
- `bun run lint`
- `bun run i18n:audit`
- `bun run test`
- `cargo test --manifest-path src-tauri/Cargo.toml`
