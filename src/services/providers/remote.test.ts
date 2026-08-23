import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  getAppBootstrap,
  getGitTreeForProject,
  getMCPServerSettings,
  getToolSettings,
  getSkill,
  listCommits,
  listSkills,
  listTasks,
  readSkillResource,
  runSkillScript,
  resolveRemoteConfig,
  updateMCPServerSettings,
  updateToolSettings,
} from './remote';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

type LocalStorageMock = {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  length: number;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

const createLocalStorageMock = (): LocalStorageMock => {
  let store = new Map<string, string>();

  return {
    clear: () => {
      store = new Map<string, string>();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
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
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

let fetchCalls: FetchCall[] = [];
let localStorageMock: LocalStorageMock;
let tauriImportCounter = 0;

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
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });

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

    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
      });
    }
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

  it('maps Architect runtime endpoints through the remote backend when Tauri is unavailable', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');
    setEnv('VITE_REMOTE_WORKSPACE_ID', 'ws_main');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      const urlText = String(url);
      if (urlText.endsWith('/architect/plans/list')) {
        return jsonResponse({
          activePlanId: 'plan-1',
          plans: [],
        });
      }
      if (urlText.endsWith('/architect/plans/activate-head')) {
        return jsonResponse(null);
      }
      return jsonResponse({
        planId: 'plan-1',
        targetBranch: 'main',
        transcriptRevision: null,
        messageCount: 0,
        messages: [],
      });
    }) as unknown as typeof fetch;

    tauriImportCounter += 1;
    const {
      workspaceArchitectActivatePlanChat,
      workspaceArchitectActivatePlanHead,
      workspaceArchitectListPlans,
    } = await import(`../tauriIpc.ts?remote-provider-test=${tauriImportCounter}`);

    await workspaceArchitectListPlans({
      branchName: 'main',
      includeDeleted: true,
      includeArchived: true,
      scopedProjectIdsHint: ['project-octan-sales'],
    });
    await workspaceArchitectActivatePlanHead({
      branchName: 'main',
      planId: 'plan-1',
      scopedProjectIdsHint: ['project-octan-sales'],
    });
    await workspaceArchitectActivatePlanChat({
      branchName: 'main',
      planId: 'plan-1',
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/architect/plans/list',
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/architect/plans/activate-head',
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/architect/plans/activate-chat',
    ]);
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      branchName: 'main',
      includeDeleted: true,
      includeArchived: true,
      scopedProjectIdsHint: ['project-octan-sales'],
    });
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

  it('keeps the unconfigured remote fallback in memory without legacy localStorage', async () => {
    const initial = await getToolSettings();
    const initialTools = initial.tools as unknown as Record<
      string,
      { status: string; config?: { enabled?: boolean } }
    >;

    expect(initialTools.read?.status).toBe('enabled');
    await updateToolSettings({
      tools: {
        read: false,
      },
    });

    const updated = await getToolSettings();
    const updatedTools = updated.tools as unknown as Record<
      string,
      { status: string; config?: { enabled?: boolean } }
    >;

    expect(updatedTools.read?.status).toBe('disabled');
    expect(updatedTools.read?.config?.enabled).toBe(false);
    expect(localStorageMock.getItem('macro_tool_settings')).toBeNull();
  });

  it('keeps unconfigured MCP fallback settings in memory without legacy localStorage', async () => {
    await updateMCPServerSettings({
      servers: {
        example: true,
      } as never,
    });

    const result = await getMCPServerSettings();
    expect(result.servers.example).toMatchObject({
      id: 'example',
      status: 'unconfigured',
      config: { enabled: true },
    });
    expect(localStorageMock.getItem('macro_mcp_server_settings')).toBeNull();
  });

  it('calls remote skill lifecycle endpoints with workspace scope', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');
    setEnv('VITE_REMOTE_API_PREFIX', '/api/v1');
    setEnv('VITE_REMOTE_WORKSPACE_ID', 'ws_main');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      const path = String(url);
      if (path.endsWith('/skills/list')) {
        return jsonResponse({ skills: [] });
      }
      if (path.endsWith('/skills/get')) {
        return jsonResponse({
          skill: {
            id: 'remote:docs',
            name: 'docs',
            description: 'Remote docs',
            location: { kind: 'remote', uri: 'registry://docs' },
            source: { kind: 'global', namespace: 'agents', rootPath: 'registry://user' },
            resources: [],
            scripts: [],
            validationErrors: [],
            isValid: true,
          },
          body: 'Follow remote docs.',
        });
      }
      if (path.endsWith('/skills/read-resource')) {
        return jsonResponse({ skillId: 'remote:docs', path: 'references/a.md', content: 'A' });
      }
      return jsonResponse({
        skillId: 'remote:docs',
        scriptPath: 'scripts/check.sh',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      });
    }) as unknown as typeof fetch;

    await expect(listSkills({ projectRoots: [] })).resolves.toEqual({ skills: [] });
    await expect(getSkill({ skillId: 'remote:docs' })).resolves.toMatchObject({
      body: 'Follow remote docs.',
    });
    await expect(
      readSkillResource({ skillId: 'remote:docs', resourcePath: 'references/a.md' }),
    ).resolves.toMatchObject({ content: 'A' });
    await expect(
      runSkillScript({ skillId: 'remote:docs', scriptPath: 'scripts/check.sh' }),
    ).resolves.toMatchObject({ stdout: 'ok' });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/skills/list',
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/skills/get',
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/skills/read-resource',
      'http://127.0.0.1:8787/api/v1/workspaces/ws_main/skills/run-script',
    ]);
    expect(JSON.parse(String(fetchCalls[1].init?.body))).toMatchObject({
      skillId: 'remote:docs',
      projectRoots: [],
    });
  });

  it('maps a missing headless skill endpoint to a precise feature error', async () => {
    setEnv('VITE_REMOTE_API_BASE_URL', 'http://127.0.0.1:8787');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;

    await expect(listSkills()).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED_IN_REMOTE_MODE',
      message: 'The current remote runtime does not support Macro skills (listSkills).',
    });
  });
});
