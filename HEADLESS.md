# Headless Kernel

Macro includes an early headless backend kernel for remote and no-GUI workflows.
In the 0.1 release line, the desktop app remains the primary supported product
surface. Headless and remote transport workflows are best-effort unless a
release note says otherwise.

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

## Remote Frontend Transport

The frontend can use the remote service provider with:

```env
VITE_BACKEND_TRANSPORT=remote
VITE_REMOTE_API_BASE_URL=http://localhost:8787
VITE_REMOTE_API_PREFIX=/api/v1
VITE_REMOTE_WORKSPACE_ID=
VITE_REMOTE_AUTH_TOKEN=
VITE_REMOTE_TIMEOUT_MS=15000
```

Remote mode currently supports workspace bootstrap, task catalog, Architect plan
listing and activation, Git tree and history, remote tool policy, remote tool
validation, remote tool execution, and local browser persistence for tool and
MCP preferences.

## Current Limits

The remote provider does not yet replace the full desktop IPC surface. In the
0.1 line, these remain desktop-only:

- project creation, import, rename, archive, and access changes;
- Git worktree creation and removal;
- file preview from the Git tree;
- provider configuration through the native desktop store;
- local implementation task mutations and task project commands.
