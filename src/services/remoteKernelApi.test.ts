import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  canUseRemoteKernel,
  executeRemoteWorkspaceTool,
  getRemoteToolModePolicy,
  validateRemoteToolExecution,
} from './remoteKernelApi';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const ENV_KEYS = [
  'VITE_BACKEND_TRANSPORT',
  'VITE_REMOTE_API_BASE_URL',
  'VITE_REMOTE_BACKEND_URL',
  'VITE_REMOTE_API_PREFIX',
  'VITE_REMOTE_AUTH_TOKEN',
  'VITE_REMOTE_TIMEOUT_MS',
];

const originalEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

const setEnv = (key: string, value?: string) => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

const jsonResponse = (payload: unknown, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
};

describe('remoteKernelApi', () => {
  beforeEach(() => {
    fetchCalls = [];
    ENV_KEYS.forEach((key) => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({});
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      setEnv(key, originalEnv[key]);
    });
    globalThis.fetch = originalFetch;
  });

  it('detects remote kernel capability from env', () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    expect(canUseRemoteKernel()).toBe(true);
  });

  it('calls the mode policy endpoint with apiPrefix and auth header', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/custom');
    setEnv('VITE_REMOTE_AUTH_TOKEN', 'token');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['read', 'grep'],
        enforce_macro_only_writes: false,
      });
    }) as unknown as typeof fetch;

    const result = await getRemoteToolModePolicy('Implement', 'project-1');
    expect(result.allowed_tool_ids).toEqual(['read', 'grep']);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/custom/tools/mode-policy?mode=Implement&projectId=project-1');
    expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('calls validate and execute endpoints with apiPrefix', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/remote/api');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/validate')) {
        return jsonResponse({ allowed: true, enforce_macro_only_writes: false });
      }
      if (String(url).includes('/mode-policy')) {
        return jsonResponse({
          allowed_tool_ids: ['read'],
          enforce_macro_only_writes: false,
          capabilities: ['bounded_tool_output_v1'],
        });
      }
      return jsonResponse({ result: '{"ok":true}' });
    }) as unknown as typeof fetch;

    const validation = await validateRemoteToolExecution({
      mode: 'Implement',
      toolId: 'read',
      path: 'src/App.tsx',
      projectId: 'project-1',
    });
    expect(validation.allowed).toBe(true);
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      projectId: 'project-1',
    });

    const result = await executeRemoteWorkspaceTool({
      mode: 'Implement',
      toolId: 'read',
      args: { path: 'src/App.tsx' },
      workspacePath: 'C:/dev/Smartcards',
    });
    expect(result).toBe('{"ok":true}');
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/remote/api/tools/validate');
    expect(fetchCalls[1].url).toBe('http://127.0.0.1:8787/remote/api/tools/mode-policy?mode=Implement');
    expect(fetchCalls[2].url).toBe('http://127.0.0.1:8787/remote/api/tools/execute');
    expect(JSON.parse(String(fetchCalls[2].init?.body))).toEqual({
      mode: 'Implement',
      tool_id: 'read',
      args: { path: 'src/App.tsx' },
      workspace_path: 'C:/dev/Smartcards',
      workspace_scope: null,
      project_mounts: [],
      virtual_root_enabled: null,
      focused_project_id: null,
    });
  });

  it('uses the routed project when checking execution capabilities', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/mode-policy')) {
        return jsonResponse({
          allowed_tool_ids: ['read'],
          enforce_macro_only_writes: false,
          capabilities: ['bounded_tool_output_v1'],
        });
      }
      return jsonResponse({ result: 'ok' });
    }) as unknown as typeof fetch;

    await executeRemoteWorkspaceTool({
      mode: 'Implement',
      toolId: 'read',
      args: { path: 'src/App.tsx' },
      projectId: 'project-routed',
    });

    expect(fetchCalls[0].url).toBe(
      'http://127.0.0.1:8787/api/v1/tools/mode-policy?mode=Implement&projectId=project-routed',
    );
    expect(fetchCalls[1].url).toBe('http://127.0.0.1:8787/api/v1/tools/execute');
  });

  it('rejects guarded mutations before contacting a revision-unaware remote kernel', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['write'],
        enforce_macro_only_writes: false,
      });
    }) as unknown as typeof fetch;

    await expect(
      executeRemoteWorkspaceTool({
        mode: 'Implement',
        toolId: 'write',
        args: {
          path: 'src/App.tsx',
          content: 'next',
          expected_revision: 'stale',
        },
      })
    ).rejects.toThrow('cannot enforce content revisions');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/tools/mode-policy');
  });

  it('requires revision support for implicit edit, delete, and patch guards', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['edit', 'delete', 'apply_patch'],
        enforce_macro_only_writes: false,
      });
    }) as unknown as typeof fetch;

    for (const [toolId, args] of [
      ['edit', { path: 'src/App.tsx', old_text: 'old', new_text: 'new' }],
      ['delete', { path: 'src/old.ts' }],
      ['apply_patch', { patch_text: '*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch' }],
    ] as const) {
      fetchCalls = [];
      await expect(
        executeRemoteWorkspaceTool({ mode: 'Implement', toolId, args }),
      ).rejects.toThrow('cannot enforce content revisions');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain('/tools/mode-policy');
    }
  });

  it('rejects read-only tools before contacting an output-unaware remote kernel', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['grep'],
        enforce_macro_only_writes: false,
        capabilities: ['content_revisions_v1'],
      });
    }) as unknown as typeof fetch;

    await expect(
      executeRemoteWorkspaceTool({
        mode: 'Implement',
        toolId: 'grep',
        args: { query: 'needle' },
      })
    ).rejects.toThrow('cannot guarantee bounded, resumable tool output');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/tools/mode-policy');
  });

  it('requires the dedicated bounded Git capability for remote repository inspection', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['git_diff'],
        enforce_macro_only_writes: false,
        capabilities: ['bounded_tool_output_v1'],
      });
    }) as unknown as typeof fetch;

    await expect(
      executeRemoteWorkspaceTool({
        mode: 'Implement',
        toolId: 'git_diff',
        args: { mode: 'stat' },
      })
    ).rejects.toThrow('cannot guarantee bounded Git tool output');
    expect(fetchCalls).toHaveLength(1);
  });

  it('requires the dedicated structural-search capability for remote ast_grep', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['ast_grep'],
        enforce_macro_only_writes: false,
        capabilities: ['bounded_tool_output_v1'],
      });
    }) as unknown as typeof fetch;

    await expect(
      executeRemoteWorkspaceTool({
        mode: 'Implement',
        toolId: 'ast_grep',
        args: { pattern: 'console.log($$$ARGS)' },
      })
    ).rejects.toThrow('does not support structural search');
    expect(fetchCalls).toHaveLength(1);
  });

  it('aborts requests when the configured timeout elapses', async () => {
    let abortObserved = false;

    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_TIMEOUT_MS', '5');

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    await expect(getRemoteToolModePolicy('Implement', 'project-1')).rejects.toMatchObject({
      code: 'REMOTE_TIMEOUT',
    });
    expect(abortObserved).toBe(true);
  });

  it('forwards caller cancellation through remote tool policy checks', async () => {
    let abortObserved = false;

    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const execution = executeRemoteWorkspaceTool({
      mode: 'Implement',
      toolId: 'grep',
      args: { query: 'needle' },
      signal: controller.signal,
    });
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortObserved).toBe(true);
  });
});
