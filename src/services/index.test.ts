import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { clearRemoteRuntimeCapabilityOverrides } from './serviceRuntime';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const ENV_KEYS = [
  'VITE_BACKEND_TRANSPORT',
  'VITE_REMOTE_API_BASE_URL',
  'VITE_REMOTE_BACKEND_URL',
  'VITE_REMOTE_API_PREFIX',
  'VITE_REMOTE_WORKSPACE_ID',
];

const originalEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];
let importCounter = 0;

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

const loadServicesModule = async () => {
  importCounter += 1;
  return import(`./index.ts?service-runtime-test=${importCounter}`);
};

describe('services index', () => {
  beforeEach(() => {
    fetchCalls = [];
    ENV_KEYS.forEach((key) => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        plan: null,
        projectGroups: [],
        planNodes: [],
        predictedBranches: [],
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      setEnv(key, originalEnv[key]);
    });
    globalThis.fetch = originalFetch;
    clearRemoteRuntimeCapabilityOverrides();
  });

  it('routes bootstrap through HTTP in remote mode', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/custom');

    const { services } = await loadServicesModule();
    await services.getAppBootstrap();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/custom/workspace/bootstrap');
  });

  it('keeps the remote provider active with desktop-only environment noise present', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v2');

    const { getServiceRuntime, services } = await loadServicesModule();
    const runtime = getServiceRuntime();
    await services.getAppBootstrap();

    expect(runtime).toMatchObject({
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
    });
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/api/v2/workspace/bootstrap');
  });

  it('records remote-declared runtime capabilities from bootstrap', async () => {
    setEnv('VITE_BACKEND_TRANSPORT', 'remote');
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        plan: null,
        projectGroups: [],
        planNodes: [],
        predictedBranches: [],
        runtimeCapabilities: {
          skills: false,
          skillScripts: true,
        },
      });
    }) as unknown as typeof fetch;

    const { getServiceRuntimeCapabilities, services } = await loadServicesModule();
    await services.getAppBootstrap();

    expect(getServiceRuntimeCapabilities()).toMatchObject({
      skills: false,
      skillScripts: true,
    });
  });
});
