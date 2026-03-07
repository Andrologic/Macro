import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  getAppBootstrap,
  getGitTreeForProject,
  listCommits,
  listTasks,
  resolveRemoteConfig,
} from './remote';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const ENV_KEYS = [
  'VITE_REMOTE_API_BASE_URL',
  'VITE_REMOTE_BACKEND_URL',
  'VITE_REMOTE_API_PREFIX',
  'VITE_REMOTE_WORKSPACE_ID',
  'VITE_REMOTE_AUTH_TOKEN',
  'VITE_REMOTE_TIMEOUT_MS',
];

const originalEnv: Record<string, string | undefined> = {};

let fetchCalls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

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

describe('remote provider', () => {
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

  it('returns null config when remote base url is not set', () => {
    expect(resolveRemoteConfig()).toBeNull();
  });

  it('calls workspace bootstrap endpoint with auth header', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://localhost:3000/');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');
    setEnv('VITE_REMOTE_WORKSPACE_ID', 'ws_main');
    setEnv('VITE_REMOTE_AUTH_TOKEN', 'secret-token');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        plan: null,
        projectGroups: [],
        planNodes: [],
        predictedBranches: [],
      });
    }) as unknown as typeof fetch;

    const result = await getAppBootstrap();
    expect(result.projectGroups).toEqual([]);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('http://localhost:3000/api/v1/workspaces/ws_main/bootstrap');
    expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('maps tasks endpoint and parses payload', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({
        tasks: [
          {
            id: 'task-1',
            plan_id: 'plan-1',
            project_id: 'project-1',
            title: 'Task',
            description: 'Desc',
            status: 'Pending',
            dependencies: [],
            estimated_changes: [],
          },
        ],
        plans: [],
        hasStandaloneTasks: true,
        source: 'fallback',
      });
    }) as unknown as typeof fetch;

    const result = await listTasks();
    expect(result.tasks.length).toBe(1);
    expect(result.source).toBe('fallback');
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8787/api/v1/workspace/tasks');
  });

  it('encodes project id for git tree and commit endpoints', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://localhost:4000');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/git/tree')) {
        return jsonResponse({ tree: null });
      }
      return jsonResponse({ commits: [] });
    }) as unknown as typeof fetch;

    await getGitTreeForProject('proj/alpha');
    await listCommits('proj/alpha');

    expect(fetchCalls[0].url).toBe('http://localhost:4000/api/v1/projects/proj%2Falpha/git/tree');
    expect(fetchCalls[1].url).toBe('http://localhost:4000/api/v1/projects/proj%2Falpha/git/commits');
  });

  it('throws REMOTE_REQUEST_FAILED on non-2xx response', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://localhost:3000');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ error: 'boom' }, 500);
    }) as unknown as typeof fetch;

    await expect(listCommits('project-1')).rejects.toMatchObject({
      code: 'REMOTE_REQUEST_FAILED',
    });
  });
});
