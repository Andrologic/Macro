import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Project = {
  id: string;
  name: string;
  path: string;
};

type ProjectGroup = {
  id: string;
  name: string;
  projects: Project[];
};

type AppStoreState = {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: ProjectGroup[];
  metadataAutoPush: boolean;
  activeArchitectPlanId: string | null;
  activePlanContext: { targetBranch: string } | null;
  switchProjectContext: ReturnType<typeof mock>;
  getProjectById: (projectId: string) => Project | undefined;
};

type NotificationStoreState = {
  items: Array<{ id: string; readAt: string | null }>;
  isCenterOpen: boolean;
  setCenterOpen: (open: boolean) => void;
};

type GitStatusDto = {
  branch: string;
  head_commit: null;
  staged_files: [];
  unstaged_files: [];
  untracked_files: [];
  conflicted_files: string[];
  merge_in_progress: boolean;
  conflictedFiles: string[];
  mergeInProgress: boolean;
  is_clean: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
};

type MacroBranchSyncDto = {
  branch: string;
  state: 'clean' | 'pending' | 'failed' | 'conflict';
  worktree_path: string;
  is_dirty: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
  conflicted_files: string[];
  committed: boolean;
  commit_hash: string | null;
  reason:
    | 'clean'
    | 'dirty'
    | 'ahead'
    | 'behind'
    | 'diverged'
    | 'merge_conflict'
    | 'missing_origin'
    | 'missing_upstream'
    | 'auth_required'
    | 'network_error'
    | 'unknown_error'
    | null;
  next_action:
    | 'commit'
    | 'push'
    | 'pull'
    | 'resolve_conflict'
    | 'configure_remote'
    | 'configure_auth'
    | 'retry'
    | null;
  output: string | null;
  error: string | null;
};

let appState: AppStoreState;
let notificationState: NotificationStoreState;
let gitStatusByPath: Record<string, GitStatusDto>;
let macroStatusByPath: Record<string, MacroBranchSyncDto>;
let gitStatusMock: ReturnType<typeof mock>;
let gitFetchMock: ReturnType<typeof mock>;
let gitPullMock: ReturnType<typeof mock>;
let gitPushMock: ReturnType<typeof mock>;
let macroBranchEnsureMock: ReturnType<typeof mock>;
let macroBranchStatusMock: ReturnType<typeof mock>;
let macroBranchPullMock: ReturnType<typeof mock>;
let macroBranchPushMock: ReturnType<typeof mock>;
let macroBranchCommitIfDirtyMock: ReturnType<typeof mock>;
let importCounter = 0;
let originalConsoleError: typeof console.error;

const GROUP_ONE_PROJECTS: Project[] = [
  { id: 'project-a', name: 'API', path: '/repo/api' },
  { id: 'project-b', name: 'Web', path: '/repo/web' },
];
const GROUP_TWO_PROJECTS: Project[] = [
  { id: 'project-c', name: 'Docs', path: '/repo/docs' },
];

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    getState: () => T;
    setState: (patch: Partial<T>) => void;
    subscribe: () => () => void;
  };

  hook.getState = getSnapshot;
  hook.setState = (patch) => Object.assign(getSnapshot() as object, patch);
  hook.subscribe = () => () => undefined;
  return hook;
};

const cloneGitStatus = (status: GitStatusDto): GitStatusDto => ({
  ...status,
  staged_files: [...status.staged_files],
  unstaged_files: [...status.unstaged_files],
  untracked_files: [...status.untracked_files],
  conflicted_files: [...status.conflicted_files],
  conflictedFiles: [...status.conflictedFiles],
});

const cloneMacroStatus = (status: MacroBranchSyncDto): MacroBranchSyncDto => ({
  ...status,
  conflicted_files: [...status.conflicted_files],
});

const buildGitStatus = (branch: string, behind: number, ahead: number): GitStatusDto => ({
  branch,
  head_commit: null,
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  conflicted_files: [],
  merge_in_progress: false,
  conflictedFiles: [],
  mergeInProgress: false,
  is_clean: true,
  has_origin: true,
  has_upstream: true,
  ahead,
  behind,
});

const buildMacroStatus = (behind: number, ahead: number): MacroBranchSyncDto => ({
  branch: '@macro',
  state: 'clean',
  worktree_path: '',
  is_dirty: false,
  has_origin: true,
  has_upstream: true,
  ahead,
  behind,
  conflicted_files: [],
  committed: false,
  commit_hash: null,
  reason: 'clean',
  next_action: null,
  output: 'ok',
  error: null,
});

const buildDirtyMacroStatus = (): MacroBranchSyncDto => ({
  ...buildMacroStatus(0, 0),
  state: 'pending',
  is_dirty: true,
  reason: 'dirty',
  next_action: 'commit',
});

const useAppStore = createStoreHook(() => appState);
const useNotificationCenterStore = createStoreHook(() => notificationState);

const getProjectById = (projectId: string): Project | undefined =>
  appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId);

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
};

const findButtonByIcon = (container: HTMLDivElement, iconName: string): HTMLButtonElement | null =>
  (container.querySelector(`[data-icon="${iconName}"]`)?.closest('button') as HTMLButtonElement | null) ?? null;

const selectGitScope = async (container: HTMLDivElement, value: string) => {
  const select = container.querySelector('select') as HTMLSelectElement | null;
  expect(select).not.toBeNull();

  act(() => {
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flushAsyncWork();
};

const loadFooter = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        key: string,
        fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown },
        maybeOptions?: { defaultValue?: string; [key: string]: unknown }
      ) => {
        if (typeof fallbackOrOptions === 'string') {
          return fallbackOrOptions;
        }
        return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
      },
    }),
  }));

  mock.module('../../stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('../../stores/useNotificationCenterStore', () => ({
    useNotificationCenterStore,
    hasUnreadNotifications: (items: Array<{ readAt: string | null }>) =>
      items.some((item) => !item.readAt),
  }));

  mock.module('../../services/tauriIpc', () => ({
    isTauriAvailable: () => true,
    gitStatus: (repoPath: string) => gitStatusMock(repoPath),
    gitFetch: (params: { repoPath: string }) => gitFetchMock(params),
    gitPull: (params: { repoPath: string }) => gitPullMock(params),
    gitPush: (params: { repoPath: string }) => gitPushMock(params),
    macroBranchEnsure: (params?: { workspacePath?: string | null }) =>
      macroBranchEnsureMock(params),
    macroBranchStatus: (params?: { workspacePath?: string | null }) =>
      macroBranchStatusMock(params),
    macroBranchPull: (params?: { workspacePath?: string | null }) =>
      macroBranchPullMock(params),
    macroBranchPush: (params?: { workspacePath?: string | null }) =>
      macroBranchPushMock(params),
    macroBranchCommitIfDirty: (params?: { workspacePath?: string | null; message?: string }) =>
      macroBranchCommitIfDirtyMock(params),
  }));

  mock.module('../ui/Button', () => ({
    Button: React.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement>
    >(({ children, ...props }, ref) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    )),
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      error: mock(() => undefined),
      success: mock(() => undefined),
      info: mock(() => undefined),
      actionRequired: mock(() => undefined),
    },
  }));

  mock.module('../../services/conflictResolution', () => ({
    buildMacroConflictAssistantPrompt: () => 'prompt',
    toMacroConflictResolutionEntries: (repositories: unknown[]) => repositories,
  }));

  mock.module('../../services/conflictAssistantService', () => ({
    openConflictAssistant: mock(async () => undefined),
  }));

  mock.module('../conflicts/ConflictResolutionPanel', () => ({
    ConflictResolutionPanel: () => <div data-testid="conflict-panel" />,
  }));

  mock.module('./NotificationCenterPopover', () => ({
    NotificationCenterPopover: () => null,
  }));

  importCounter += 1;
  return import(`./Footer.tsx?test=${importCounter}`);
};

describe('Footer', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const firstArg = typeof args[0] === 'string' ? args[0] : '';
      if (firstArg.includes('not wrapped in act')) {
        return;
      }
      originalConsoleError(...args);
    };
    appState = {
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-a',
      projectGroups: [
        { id: 'group-1', name: 'Macro', projects: GROUP_ONE_PROJECTS },
        { id: 'group-2', name: 'Docs', projects: GROUP_TWO_PROJECTS },
      ],
      metadataAutoPush: false,
      activeArchitectPlanId: null,
      activePlanContext: null,
      switchProjectContext: mock(async () => undefined),
      getProjectById,
    };
    notificationState = {
      items: [],
      isCenterOpen: false,
      setCenterOpen: (open: boolean) => {
        notificationState.isCenterOpen = open;
      },
    };
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 2, 1),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 1, 7),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(5, 4),
      '/repo/web': buildMacroStatus(8, 6),
      '/repo/docs': buildMacroStatus(2, 9),
    };

    gitStatusMock = mock(async (repoPath: string) => cloneGitStatus(gitStatusByPath[repoPath]!));
    gitFetchMock = mock(async ({ repoPath }: { repoPath: string }) => ({
      branch: 'main',
      remote: 'origin',
      output: `fetch ${repoPath}`,
    }));
    gitPullMock = mock(async ({ repoPath }: { repoPath: string }) => ({
      branch: 'main',
      remote: 'origin',
      output: `pull ${repoPath}`,
    }));
    gitPushMock = mock(async ({ repoPath }: { repoPath: string }) => ({
      branch: 'main',
      remote: 'origin',
      output: `push ${repoPath}`,
    }));
    macroBranchEnsureMock = mock(async (params?: { workspacePath?: string | null }) =>
      cloneMacroStatus(macroStatusByPath[params?.workspacePath ?? '']!)
    );
    macroBranchStatusMock = mock(async (params?: { workspacePath?: string | null }) =>
      cloneMacroStatus(macroStatusByPath[params?.workspacePath ?? '']!)
    );
    macroBranchPullMock = mock(async (params?: { workspacePath?: string | null }) =>
      cloneMacroStatus(macroStatusByPath[params?.workspacePath ?? '']!)
    );
    macroBranchPushMock = mock(async (params?: { workspacePath?: string | null }) =>
      cloneMacroStatus(macroStatusByPath[params?.workspacePath ?? '']!)
    );
    macroBranchCommitIfDirtyMock = mock(async (params?: { workspacePath?: string | null }) =>
      cloneMacroStatus(macroStatusByPath[params?.workspacePath ?? '']!)
    );
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    console.error = originalConsoleError;
    container?.remove();
    container = null;
    root = null;
    mock.restore();
  });

  it('keeps the global project focus stable while the footer git scope changes', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('6@13');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('4@10');

    await selectGitScope(container!, 'project-b');

    expect(appState.switchProjectContext).not.toHaveBeenCalled();
    expect(appState.selectedProjectId).toBe('project-a');
    expect((container?.querySelector('select') as HTMLSelectElement | null)?.value).toBe('project-b');
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('4@8');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('3@6');
  });

  it('targets footer git actions to the selected local scope and aggregates all projects when reset', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    await selectGitScope(container!, 'project-b');

    const fetchCallsBeforeScoped = gitFetchMock.mock.calls.length;
    const pullCallsBeforeScoped = gitPullMock.mock.calls.length;
    const pushCallsBeforeScoped = gitPushMock.mock.calls.length;

    act(() => {
      findButtonByIcon(container!, 'refresh-cw')?.click();
    });
    await flushAsyncWork();

    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(gitFetchMock.mock.calls.slice(fetchCallsBeforeScoped)).toEqual([
      [{ repoPath: '/repo/web' }],
    ]);
    expect(gitPullMock.mock.calls.slice(pullCallsBeforeScoped)).toEqual([
      [{ repoPath: '/repo/web' }],
    ]);
    expect(gitPushMock.mock.calls.slice(pushCallsBeforeScoped)).toEqual([
      [{ repoPath: '/repo/web' }],
    ]);

    await selectGitScope(container!, '__all__');

    const fetchCallsBeforeAllProjects = gitFetchMock.mock.calls.length;
    act(() => {
      findButtonByIcon(container!, 'refresh-cw')?.click();
    });
    await flushAsyncWork();

    expect(gitFetchMock.mock.calls.slice(fetchCallsBeforeAllProjects)).toEqual([
      [{ repoPath: '/repo/api' }],
      [{ repoPath: '/repo/web' }],
    ]);
  });

  it('resets the local footer git scope when the selected group changes', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    await selectGitScope(container!, 'project-b');

    appState.selectedGroupId = 'group-2';
    appState.selectedProjectId = 'project-c';

    root?.render(<Footer />);
    await flushAsyncWork();

    expect((container?.querySelector('select') as HTMLSelectElement | null)?.value).toBe('__all__');
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('1@2');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('7@9');
    expect(container?.textContent ?? '').toContain('release-c');
  });

  it('falls back to all projects when the scoped footer project disappears', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    await selectGitScope(container!, 'project-b');

    appState.projectGroups = [
      { id: 'group-1', name: 'Macro', projects: [GROUP_ONE_PROJECTS[0]!] },
      { id: 'group-2', name: 'Docs', projects: GROUP_TWO_PROJECTS },
    ];

    root?.render(<Footer />);
    await flushAsyncWork();

    const select = container?.querySelector('select') as HTMLSelectElement | null;
    expect(select?.value).toBe('__all__');
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      '__all__',
      'project-a',
    ]);
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('2@5');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('1@4');
  });

  it('marks macro-only pull and push counts without adding them to code counts', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(2, 3),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    const pullButton = findButtonByIcon(container!, 'arrow-down');
    const pushButton = findButtonByIcon(container!, 'arrow-up');
    expect(pullButton?.textContent?.trim()).toBe('0@2');
    expect(pushButton?.textContent?.trim()).toBe('0@3');
    expect(pullButton?.className).toContain('text-amber-400');
    expect(pushButton?.className).toContain('text-emerald-400');
  });

  it('keeps plain code counts when macro has no commits or is dirty only', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 3),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildDirtyMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('0');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('3');
    expect(container?.textContent ?? '').not.toContain('Review');
    expect(container?.textContent ?? '').not.toContain('Resolve');
  });
});
