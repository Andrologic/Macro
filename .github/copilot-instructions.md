# Macro Copilot Instructions

## Architecture & Frameworks
- **Hybrid Tauri v2**: React 18 frontend + Rust backend.
- **State Management**: Zustand stores in [src/stores/](src/stores/). Avoid complex local state for persistent data.
- **Backend Persistence**: Rust uses `sqlx` (SQLite) for history/settings and `libgit2` for project logic.
- **AI Streaming**: Handled in [src/services/streamingChat.ts](src/services/streamingChat.ts) using `@tauri-apps/plugin-http` to bypass CORS.

## Workflows & Commands
- **Primary Dev Command**: `pnpm tauri dev`
- **Data Providers**: Toggle between `mock` and `ipc` (Tauri) using `VITE_DATA_PROVIDER` in `.env`.
- **Backend Changes**: When adding a Rust command, update [src-tauri/src/commands.rs](src-tauri/src/commands.rs) and the TS wrapper in [src/services/tauriIpc.ts](src/services/tauriIpc.ts).

## Patterns & Conventions
- **Architect-First**: Modifications are planned in "Architect" mode before being executed in "Implement" mode.
- **Service Pattern**: Business logic resides in [src/services/](src/services/). Components should primarily interact with stores or services.
- **Error Handling**: Use `toServiceError` from [src/services/contracts/errors.ts](src/services/contracts/errors.ts) to normalize errors in stores.
- **Window Decorations**: Uses `decorations: false`. Custom window controls are in [src/components/layout/WindowControls.tsx](src/components/layout/WindowControls.tsx) and handled by [src/hooks/useTauriWindow.ts](src/hooks/useTauriWindow.ts).
- **Persistent Plans**: Plans and tasks are stored in the `.macro-plans` branch of the target repository.
- **Theming**: Uses dynamic JSON themes from [public/themes/](public/themes/). CSS variables are injected via [src/utils/themeUtils.ts](src/utils/themeUtils.ts).
- **UI Components**: Built with Tailwind CSS + Shadcn/ui. See [src/components/ui/](src/components/ui/) for primitives.

## Key Integration Points
- **Tauri IPC**: Use the type-safe wrappers in [src/services/tauriIpc.ts](src/services/tauriIpc.ts).
- **Git Integration**: Libgit2 operations are exposed via Rust commands and managed by `useGitStore`.
- **Dynamic Icons**: App icon colors are updated dynamically to match the theme via [src/hooks/useDynamicAppIcon.ts](src/hooks/useDynamicAppIcon.ts).

## Example: Adding a new Database Feature
1. Define the SQL/Repository logic in `src-tauri/src/db/`.
2. Create a `#[tauri::command]` in [src-tauri/src/commands.rs](src-tauri/src/commands.rs).
3. Add the corresponding TS function in [src/services/tauriIpc.ts](src/services/tauriIpc.ts).
4. Integrate into a Zustand store in [src/stores/](src/stores/).
