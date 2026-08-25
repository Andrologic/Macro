# Experimental Headless Kernel

This document describes internal foundations for remote and no-GUI development.
None of them is exposed as a Macro 0.1 product feature or belongs to the
supported release surface. They may change without compatibility guarantees.

Three separate surfaces coexist in the repository:

- The desktop **tool host** is an internal HTTP server started automatically by
  the Tauri runtime for trusted local integrations such as the Copilot bridge.
  It binds only to an ephemeral `127.0.0.1` port and uses an automatically
  generated bearer token. It is not the headless kernel or a remote API.
- The **headless kernel** is the experimental `macro-headless` executable
  documented below. It owns the prototype HTTP API and can bind beyond loopback
  only when explicitly configured with a bearer token.
- The frontend **remote transport** is an internal development adapter that can
  target a compatible headless API. Its presence in `serviceRuntime` is not a
  supported mode selector or a promise that the desktop UI works end to end
  without Tauri IPC.

## Run The Kernel

From the repository root:

```bash
bun run tauri:headless
```

By default, the kernel listens on:

```text
127.0.0.1:8787
```

## Environment Variables

- `MACRO_HEADLESS_HOST` - bind host, default `127.0.0.1`.
- `MACRO_HEADLESS_PORT` - bind port, default `8787`.
- `MACRO_HEADLESS_BEARER_TOKEN` - bearer token. It is optional for the default
  loopback listener, but required for any non-loopback listener. Requests must
  include `Authorization: Bearer <token>` when authentication is enabled.
- `MACRO_HEADLESS_ALLOWED_ROOTS` - optional path-list of additional directory
  roots that headless project mounts may use. The configured Macro workspace
  directory is always allowed; mount paths must resolve to existing directories
  below one of these roots.
- `MACRO_HEADLESS_CORS_ORIGINS` - optional comma-separated list of additional
  exact browser origins allowed by CORS. Wildcard origins are rejected. Common
  local Vite and Tauri origins are allowed by default.
- `MACRO_CONFIG_DIR` - absolute path to the JSON configuration directory. It is
  intended for headless, portable, and test installations. `MACRO_CONFIG`
  remains a deprecated bootstrap alias for the legacy headless settings file.

## Available Endpoints

Current endpoints include:

- `GET /health`
- `GET /v1/tools/mode-policy?mode=Architect|Chat|Implement`
- `POST /v1/tools/validate`
- `POST /v1/tools/execute`
- `GET /api/v1/tools/mode-policy?mode=Architect|Chat|Implement`
- `POST /api/v1/tools/validate`
- `POST /api/v1/tools/execute`
- `GET /api/v1/workspace/bootstrap`
- `GET /api/v1/workspaces/{workspace_id}/bootstrap`
- `GET /api/v1/workspace/tasks`
- `GET /api/v1/workspaces/{workspace_id}/tasks`
- `POST /api/v1/workspace/architect/plans/list`
- `POST /api/v1/workspaces/{workspace_id}/architect/plans/list`
- `POST /api/v1/workspace/architect/plans/activate-head`
- `POST /api/v1/workspaces/{workspace_id}/architect/plans/activate-head`
- `POST /api/v1/workspace/architect/plans/activate-chat`
- `POST /api/v1/workspaces/{workspace_id}/architect/plans/activate-chat`
- `GET /api/v1/projects/{project_id}/git/tree`
- `GET /api/v1/projects/{project_id}/git/commits`
- `POST /api/v1/config/snapshot`
- `POST /api/v1/config/document`
- `POST /api/v1/config/schema`
- `POST /api/v1/config/validate`
- `POST /api/v1/config/patch`
- `POST /api/v1/config/reload`
- `GET /api/v1/config/pending`
- `POST /api/v1/config/pending/accept`
- `POST /api/v1/config/pending/reject`
- `GET /api/v1/config/orphan-secrets`
- `POST /api/v1/config/orphan-secrets/delete`

When `MACRO_HEADLESS_BEARER_TOKEN` is set, authentication applies to `/health`
as well as every API endpoint. On the default loopback listener without a token,
`/health` is intentionally public because the whole experimental server is
local and unauthenticated in that configuration.

The separate desktop tool host also leaves its non-sensitive `/health` response
unauthenticated. This is intentional and acceptable only because that server is
hard-coded to an ephemeral `127.0.0.1` listener; all tool endpoints still
require its generated bearer token.

## Internal Frontend Remote Transport

For repository development and contract testing, the frontend adapter can be
selected explicitly with:

```env
VITE_BACKEND_TRANSPORT=remote
VITE_REMOTE_API_BASE_URL=http://localhost:8787
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

The adapter currently implements workspace bootstrap, task catalog, Architect
plan listing and activation, Git tree and history, remote tool policy, remote
tool validation, remote tool execution, and the shared JSON configuration API.
This inventory describes implemented prototype paths; it does not make
`VITE_BACKEND_TRANSPORT=remote` a supported Macro 0.1 capability.

## Current Limits

The adapter does not replace the full desktop IPC surface. In the 0.1 line,
these remain desktop-only:

- project creation, import, rename, archive, and access changes;
- Git worktree creation and removal;
- file preview from the Git tree;
- provider authentication flows that still require native desktop integration;
- local implementation task mutations and task project commands.
