# Workspace and shell contributions

## Responsibilities

`src/domains/shell/workspace.ts` separates the static workspace definition from
its session identity, UI view ID, agent profile and execution target reference.
`AppMode` remains the closed Architect/Implement/Chat policy contract. Registering
an internal view does not add a mode to tool or agent policies.

A workspace session identifies an existing plan, task or Chat conversation. When
no entity is selected, Architect and Implement use the exact project/group
selection. Free Chat does not inherit the selected project. Changing project
focus inside a task or plan does not create a different session. Execution
references point to those domain identities; the task/plan domains still resolve
project identities, repository paths and worktrees. The shell neither reconstructs
those paths nor assumes that a selected identity has finished loading.

`useWorkspaceSessionsStore` holds only the selected UI view per session. Existing
stores continue to own transcripts, drafts, plan/task activation, project
selection and durable metadata. `useWorkspaceShell` composes these identities
without mirroring their mutable domain records. Agent type changes update the
profile without replacing the session. The remote-reference target variant is
only a contract for future composition. No remote workspace is registered or
made executable by this change.

## Views and lifetime

`src/composition/workspaceViews.ts` registers the integrated panels using the
existing cached async loaders. Header, App and ModeRouter read this registry.
The compatibility exports in `modePanelLoaders.ts` resolve the default registered
view for callers that still address a semantic mode, including bootstrap
preloading. Loader imports remain deferred, and Architect/Chat retain the same
ChatZone loader object. AsyncPanel checks loader identity before rendering and
ignores an obsolete asynchronous completion.

To add a trusted internal view, register one `WorkspaceViewContribution` with a
stable `view.*` ID, workspace ID, owner, order, translated label, icon and panel
loaders. The Header and router consume it without another switch branch.
`available(session)` controls contextual visibility and routing. The registry's
`setActive` controls activation; registration returns an idempotent disposer and
`removeOwner` withdraws that owner's entries. IDs collide even when inactive.
Ordering uses numeric order then lexical ID. The active shell reacts to changes.
If a selected view disappears, it resolves the available default for that
workspace, then its first available contribution. With no available view, no
panel is mounted and panel controls disappear.

New views isolate local React state by session. Two views in the same session
can deliberately reuse the same loader to preserve their mounted panel. The
integrated views declare `stateScope: 'domain'`: their existing domain and
component rules determine when state resets, including Chat archive
multi-selection and conversation drafts. This preserves the mounted ChatZone
between Architect and Chat. Contributions that need durable state should use
the owning domain rather than a second workflow store. A removed session's
optional UI selection can be discarded with `removeSession`; this store is
memory-only and does not delete domain data.

Git remains the existing footer/review workflow. It is not a fourth agent mode.
Its context resolution, worktree selection and mutation rules are unchanged.

## Commands, shortcuts and settings

`src/shortcuts/runtime.ts` registers internal command handlers with their shortcut
metadata and activation constraints. The global keyboard listener, shortcut
preferences and shortcut settings view consult this registry. Built-in handlers
continue to call the existing app/chat/provider commands. The streaming-stop
callback keeps goal pausing in its current owner. Existing shortcut IDs and
translation keys remain stable; contribution IDs are independent from agent
modes. Removing or deactivating a command prevents its dispatch. Constraint
checks still apply to editable elements, settings, composer focus and streaming.

`src/composition/settings/registry.ts` owns settings entries and deferred content
loaders. SettingsModal renders their navigation and content without tab-specific
branches. SettingsContent contains import/render failures so navigation and close
remain usable, and retry creates a fresh lazy loader after a rejected import.
Availability and activation affect both navigation and content. An unavailable
selection falls back to the first available entry without changing the stored
selection. The SettingsTab type remains exported from useAppStore for callers,
but its identity is now independent from store and agent contracts.

## Preferences

No persisted workspace, project or shortcut preference format changes. Shortcut
bindings for temporarily absent contributions, including explicit null bindings,
are retained for later registration. Existing
last-mode, group/project selection, agent type, panel widths, filters and
conversation preferences retain their keys and domain hydration. Legacy last-mode
values are checked against the static workspace definitions and retain the
Implement fallback. New session view choices are transient; restarting opens the
existing default view for the restored semantic mode. View IDs are never written
over a persisted mode or project/worktree ID.

## Boundaries for future work

The internal contribution lifecycle provides the registration, activation and
withdrawal points for future contribution discovery and management. Future
points 19–21 must provide their own trusted composition, persistence and
capability review before exposing external contributions. This registry is not
a public plugin API, downloader, marketplace or arbitrary-code host. A remote
execution reference would require a domain adapter and capability checks before
it could become operational.

This extraction leaves the existing domain orchestration inside useAppStore and
other stores. It does not claim that the historical dependency exceptions and
strongly connected components have been eliminated. The import-boundary baseline
must not grow to accommodate shell contributions.
