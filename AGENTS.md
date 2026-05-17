# AGENTS.md

Macro is a local-first desktop environment for agentic software work. Use this
file as a compact map, not as a full manual. Prefer the repository's source code
and linked docs when a task needs detail.

## Project Map

- Frontend: React 19, TypeScript, Vite, Tailwind CSS, Zustand, Jotai.
- Desktop backend: Tauri v2 and Rust in `src-tauri/`.
- Package manager and repo script runtime: Bun.
- UI code lives under `src/components/`.
- Client state lives under `src/stores/`.
- Frontend service and orchestration code lives under `src/services/`.
- Shared types live under `src/types/`.
- Static assets and themes live under `public/`.
- Product behavior source of truth: `docs/functional-spec.md`.
- Technical architecture source of truth: `docs/technical-architecture.md`.
- Setup, release, and script overview: `README.md`.
- Contribution and PR checks: `CONTRIBUTING.md`.

## Working Rules

- Read nearby code before editing. Follow existing service, store, hook, and
  component patterns instead of inventing a parallel style.
- Keep changes scoped to the user's request. Do not refactor unrelated code while
  solving a narrow task.
- Treat a dirty worktree as user-owned unless you made the change in this task.
  Do not revert unrelated changes.
- Prefer structured APIs, typed contracts, and existing helpers over ad hoc
  string parsing or one-off utilities.
- For behavior changes, update or add focused tests near the affected code.
- For UI changes, preserve Macro's dense desktop-app feel. Avoid marketing-page
  layout patterns inside the product shell.
- Keep user-facing strings routed through the existing i18n patterns when the
  surrounding code already does so.
- Never commit secrets, local provider keys, build artifacts, local databases,
  signing material, or generated release bundles.

## Commands

Use the smallest validation set that proves the change.

- Install dependencies: `bun install`.
- Run the desktop app in development: `bun run tauri:dev`.
- Run the frontend dev server only: `bun run dev`.
- Type-check TypeScript: `bun run typecheck`.
- Lint TypeScript and React code: `bun run lint`.
- Audit translations: `bun run i18n:audit`.
- Run frontend tests: `bun run test`.
- Run Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Build the frontend: `bun run build`.
- Check version manifests: `bun run version:check`.
- Full local CI: `bun run ci`.

For documentation-only changes, do not run the full application test suite unless
the edited docs affect generated artifacts or commands.

## Architecture Guardrails

- Components should render UI and capture user intent. Put reusable behavior in
  stores, services, hooks, or local UI primitives as appropriate.
- Zustand stores coordinate durable client state and cross-surface workflow
  decisions. Avoid duplicating orchestration logic inside components.
- Frontend services isolate transport details. Keep Tauri IPC, remote transport,
  and DTO mapping out of presentation components.
- Use the type-safe Tauri IPC wrappers in `src/services/tauriIpc.ts` when
  frontend code needs native backend capabilities.
- When adding a Rust command, register it in the backend command registry and
  expose the matching TypeScript wrapper before using it in UI or stores.
- Keep tool execution policy, approval UI, and backend validation aligned when
  changing agent-visible tools.
- Plans, tasks, and workspace metadata belong in Macro's metadata workflow. Do
  not create ad hoc sidecar files for durable product state.
- Use `docs/technical-architecture.md` for layer boundaries and
  `docs/functional-spec.md` for product workflow intent before changing core
  Architect, Implement, Chat, Git, metadata, or remote-kernel behavior.

## Notifications

- Use `notify.*` from `src/components/ui/toastService` for user-facing
  notifications emitted by feature code.
- Use `notify.info`, `notify.success`, `notify.warning`, or `notify.error` for
  simple status notifications.
- Use `notify.actionRequired` when the notification asks the user to decide,
  retry, review, or follow up. Keep it to at most two actions.
- Do not call raw `toast.success`, `toast.info`, `toast.warning`, or
  `toast.error` from feature code.
- Do not build notification JSX locally in feature code. Reuse or extend the
  shared notification system under `src/components/ui/notifications/`.
- Pass desktop title/body overrides through shared helper inputs rather than
  inventing local payload shapes.

## When Unsure

- Start with `README.md`, then move to the specific code area and the linked docs
  above.
- Search before asking for project facts. Ask only when product intent or a
  tradeoff is genuinely ambiguous.
- If a rule here conflicts with code reality, trust the code for the immediate
  fix and update the relevant documentation as part of the same scoped change
  when appropriate.
