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
  'VITE_REMOTE_AUTH_TOKEN',
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

  it('calls mode policy endpoint', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_AUTH_TOKEN', 'token');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        allowed_tool_ids: ['read', 'grep'],
        enforce_macro_only_writes: false,
      });
    }) as unknown as typeof fetch;

    const result = await getRemoteToolModePolicy('Implement');
    expect(result.allowed_tool_ids).toEqual(['read', 'grep']);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/api/v1/tools/mode-policy?mode=Implement');
    expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('calls validate and execute endpoints', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/validate')) {
        return jsonResponse({ allowed: true, enforce_macro_only_writes: false });
      }
      return jsonResponse({ result: '{"ok":true}' });
    }) as unknown as typeof fetch;

    const validation = await validateRemoteToolExecution({
      mode: 'Implement',
      toolId: 'read',
      path: 'src/App.tsx',
    });
    expect(validation.allowed).toBe(true);

    const result = await executeRemoteWorkspaceTool({
      mode: 'Implement',
      toolId: 'read',
      args: { path: 'src/App.tsx' },
    });
    expect(result).toBe('{"ok":true}');
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/api/v1/tools/validate');
    expect(fetchCalls[1].url).toBe('http://127.0.0.1:8787/api/v1/tools/execute');
  });
});
