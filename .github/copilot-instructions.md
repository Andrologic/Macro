# Macro Copilot Instructions

## Architecture & Frameworks
- **Hybrid Tauri v2**: React 19 frontend + Rust backend.
- **Package manager/runtime**: Bun is the supported JavaScript runtime for repo scripts.
- **State Management**: Zustand stores in [../src/stores/](../src/stores/). Avoid complex local state for persistent data.
- **Backend Persistence**: Rust uses `sqlx` (SQLite) for history/settings and `libgit2` for project logic.
- **AI Streaming**: Handled in [../src/services/streamingChat.ts](../src/services/streamingChat.ts), with desktop provider paths routed through Tauri services where needed.

## Workflows & Commands
- **Primary Dev Command**: `bun run tauri:dev`
- **Frontend Dev Command**: `bun run dev`
- **Data Providers**: Toggle desktop browser mocks and Tauri IPC with `VITE_DATA_PROVIDER`; use `VITE_BACKEND_TRANSPORT=remote` only for the remote provider path.
- **Backend Changes**: When adding a Rust command, update the command registration under [../src-tauri/src/commands.rs](../src-tauri/src/commands.rs) and the TS wrapper in [../src/services/tauriIpc.ts](../src/services/tauriIpc.ts).
- **Required Checks**: Prefer `bun run typecheck`, `bun run lint`, `bun run i18n:audit`, `bun run test`, and `cargo test --manifest-path src-tauri/Cargo.toml` for behavior changes.

## Patterns & Conventions
- **Architect-First**: Modifications are planned in "Architect" mode before being executed in "Implement" mode.
- **Service Pattern**: Business logic resides in [../src/services/](../src/services/). Components should primarily interact with stores or services.
- **Error Handling**: Use `toServiceError` from [../src/services/contracts/errors.ts](../src/services/contracts/errors.ts) to normalize errors in stores.
- **Window Decorations**: Uses `decorations: false`. Custom window controls are in [../src/components/layout/WindowControls.tsx](../src/components/layout/WindowControls.tsx) and handled by [../src/hooks/useTauriWindow.ts](../src/hooks/useTauriWindow.ts).
- **Project Metadata**: Plans, tasks, and workspace metadata are coordinated through the `.macro` metadata workflow rather than ad hoc files.
- **Theming**: Uses dynamic JSON themes from [../public/themes/](../public/themes/). CSS variables are injected via [../src/utils/themeUtils.ts](../src/utils/themeUtils.ts).
- **UI Components**: Built with Tailwind CSS and local primitives in [../src/components/ui/](../src/components/ui/).
- **Notifications**: Use `notify.*` from [../src/components/ui/toastService.tsx](../src/components/ui/toastService.tsx) for user-facing notifications. Do not call raw toast helpers from feature code.

## Key Integration Points
- **Tauri IPC**: Use the type-safe wrappers in [../src/services/tauriIpc.ts](../src/services/tauriIpc.ts).
- **Git Integration**: Libgit2 operations are exposed via Rust commands and managed by `useGitStore`.
- **Tool Execution**: Keep tool policies, approval UI, and backend validation aligned when changing agent-visible tools.

## Example: Adding a new Database Feature
1. Define the SQL/Repository logic in `src-tauri/src/db/`.
2. Create a `#[tauri::command]` and register it in [../src-tauri/src/commands.rs](../src-tauri/src/commands.rs).
3. Add the corresponding TS function in [../src/services/tauriIpc.ts](../src/services/tauriIpc.ts).
4. Integrate into a Zustand store in [../src/stores/](../src/stores/).
5. Add focused Rust and frontend tests for migrations, repository behavior, and store-facing flows.
