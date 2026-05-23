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
  metadataMissingUpstreamPolicy: 'ask' | 'ignore';
  setMetadataMissingUpstreamPolicy: ReturnType<typeof mock>;
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
let gitRemoteAddOriginMock: ReturnType<typeof mock>;
let macroBranchEnsureMock: ReturnType<typeof mock>;
let macroBranchStatusMock: ReturnType<typeof mock>;
let macroBranchPullMock: ReturnType<typeof mock>;
let macroBranchPushMock: ReturnType<typeof mock>;
let macroBranchCommitIfDirtyMock: ReturnType<typeof mock>;
let setMetadataMissingUpstreamPolicyMock: ReturnType<typeof mock>;
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

const buildGitStatusWithoutOrigin = (branch: string, ahead = 1): GitStatusDto => ({
  ...buildGitStatus(branch, 0, ahead),
  has_origin: false,
  has_upstream: false,
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

const buildMissingUpstreamMacroStatus = (): MacroBranchSyncDto => ({
  ...buildMacroStatus(0, 2),
  state: 'pending',
  has_upstream: false,
  reason: 'missing_upstream',
  next_action: 'push',
});

const buildMissingOriginMacroStatus = (): MacroBranchSyncDto => ({
  ...buildMacroStatus(0, 0),
  state: 'failed',
  has_origin: false,
  has_upstream: false,
  reason: 'missing_origin',
  next_action: 'configure_remote',
  error: 'Remote origin is not configured.',
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

const findButtonByText = (container: HTMLDivElement, text: string): HTMLButtonElement | null =>
  Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === text) ?? null;

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

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
    gitRemoteAddOrigin: (params: { repoPath: string; url: string }) =>
      gitRemoteAddOriginMock(params),
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
      React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }
    >(({ children, isLoading: _isLoading, ...props }, ref) => (
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
    ConflictResolutionPanel: ({
      title,
      description,
      retryLabel,
      dismissLabel,
      onRetry,
      onDismiss,
    }: {
      title: string;
      description: string;
      retryLabel?: string;
      dismissLabel?: string;
      onRetry?: () => void;
      onDismiss?: () => void;
    }) => (
      <div data-testid="conflict-panel">
        <h3>{title}</h3>
        <p>{description}</p>
        {onDismiss && <button onClick={onDismiss}>{dismissLabel || 'Close'}</button>}
        {onRetry && <button onClick={onRetry}>{retryLabel || 'Retry'}</button>}
      </div>
    ),
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
    setMetadataMissingUpstreamPolicyMock = mock((policy: 'ask' | 'ignore') => {
      appState.metadataMissingUpstreamPolicy = policy;
    });
    appState = {
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-a',
      projectGroups: [
        { id: 'group-1', name: 'Macro', projects: GROUP_ONE_PROJECTS },
        { id: 'group-2', name: 'Docs', projects: GROUP_TWO_PROJECTS },
      ],
      metadataAutoPush: false,
      metadataMissingUpstreamPolicy: 'ask',
      setMetadataMissingUpstreamPolicy: setMetadataMissingUpstreamPolicyMock,
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
    gitRemoteAddOriginMock = mock(async ({ url }: { repoPath: string; url: string }) => ({
      remote: 'origin',
      url,
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

  it('renders the global project label with enough line height for descenders', async () => {
    appState.projectGroups = [
      {
        id: 'group-1',
        name: 'andrologic.ai',
        projects: GROUP_ONE_PROJECTS,
      },
    ];
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    const projectLabel = Array.from(container.querySelectorAll('span'))
      .find((element) =>
        element.textContent === 'andrologic.ai' &&
        element.classList.contains('truncate')
      );
    expect(projectLabel).toBeDefined();
    expect(projectLabel?.classList.contains('leading-4')).toBe(true);
    expect(projectLabel?.classList.contains('leading-none')).toBe(false);
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

  it('opens a missing upstream choice modal before the first footer push', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMissingUpstreamMacroStatus(),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('@macro has no remote branch yet');
    expect(gitPushMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('opens a remote configuration modal before pushing code without origin', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');
    expect(container?.textContent ?? '').toContain('API');
    expect(gitPushMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('only lists the selected footer scope when that sub-project has no origin', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatusWithoutOrigin('feature-b'),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');
    const inputLabels = Array.from(container?.querySelectorAll('input') ?? [])
      .map((input) => input.closest('label')?.textContent ?? '');
    expect(inputLabels).toHaveLength(1);
    expect(inputLabels[0]).toContain('Web');
    expect(inputLabels[0]).not.toContain('API');
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it('pushes ready repositories while leaving missing-origin repositories local for this push', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push available repositories')?.click();
    });
    await flushAsyncWork();

    expect(gitRemoteAddOriginMock).not.toHaveBeenCalled();
    expect(gitPushMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repo/web' },
    ]);
  });

  it('rechecks origin state on each push so external remote changes are picked up', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-a');

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');

    act(() => {
      findButtonByText(container!, 'Cancel')?.click();
    });
    await flushAsyncWork();

    gitStatusByPath['/repo/api'] = {
      ...gitStatusByPath['/repo/api']!,
      has_origin: true,
      has_upstream: true,
    };

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(gitRemoteAddOriginMock).not.toHaveBeenCalled();
    expect(gitPushMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repo/api' },
    ]);
  });

  it('shows every missing-origin sub-project and requires at least one pushable repository', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatusWithoutOrigin('feature-b'),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('API');
    expect(container?.textContent ?? '').toContain('Web');
    expect(container?.querySelectorAll('input')).toHaveLength(2);

    act(() => {
      findButtonByText(container!, 'Push available repositories')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Enter at least one origin URL');
    expect(gitRemoteAddOriginMock).not.toHaveBeenCalled();
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it('configures one missing-origin sub-project and pushes only the configured subset', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatusWithoutOrigin('feature-b'),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    gitRemoteAddOriginMock.mockImplementation(async ({ repoPath, url }: { repoPath: string; url: string }) => {
      gitStatusByPath[repoPath] = {
        ...gitStatusByPath[repoPath]!,
        has_origin: true,
        has_upstream: true,
      };
      return { remote: 'origin', url };
    });

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    const inputs = Array.from(container?.querySelectorAll('input') ?? []);
    act(() => {
      setInputValue(inputs[0]!, 'https://github.com/example/api.git');
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push available repositories')?.click();
    });
    await flushAsyncWork();

    expect(gitRemoteAddOriginMock).toHaveBeenCalledWith({
      repoPath: '/repo/api',
      url: 'https://github.com/example/api.git',
    });
    expect(gitPushMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repo/api' },
    ]);
  });

  it('configures origin from the push modal before retrying push', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    gitRemoteAddOriginMock.mockImplementation(async ({ repoPath, url }: { repoPath: string; url: string }) => {
      gitStatusByPath[repoPath] = {
        ...gitStatusByPath[repoPath]!,
        has_origin: true,
        has_upstream: true,
      };
      return { remote: 'origin', url };
    });

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    const input = container?.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    act(() => {
      if (!input) return;
      setInputValue(input, 'https://github.com/example/api.git');
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push available repositories')?.click();
    });
    await flushAsyncWork();

    expect(gitRemoteAddOriginMock).toHaveBeenCalledWith({
      repoPath: '/repo/api',
      url: 'https://github.com/example/api.git',
    });
    expect(gitPushMock).toHaveBeenCalled();
  });

  it('opens remote configuration when @macro reports missing origin', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingOriginMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it('configures origin before asking about @macro missing upstream in mixed push preflight', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatusWithoutOrigin('main-a'),
      '/repo/web': buildGitStatus('feature-b', 0, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitRemoteAddOriginMock.mockImplementation(async ({ repoPath, url }: { repoPath: string; url: string }) => {
      gitStatusByPath[repoPath] = {
        ...gitStatusByPath[repoPath]!,
        has_origin: true,
        has_upstream: true,
      };
      return { remote: 'origin', url };
    });

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');

    const input = container?.querySelector('input') as HTMLInputElement | null;
    act(() => {
      if (!input) return;
      setInputValue(input, 'https://github.com/example/api.git');
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push available repositories')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('@macro has no remote branch yet');
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it('does not show Resolve for missing origin because push handles configuration', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingOriginMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    expect(container?.textContent ?? '').not.toContain('Resolve');

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Remote origin is missing');
  });

  it('pushes @macro when the missing upstream modal confirms publishing', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMissingUpstreamMacroStatus(),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push @macro')?.click();
    });
    await flushAsyncWork();

    expect(gitPushMock.mock.calls.map(([params]) => params)).toEqual([
      { repoPath: '/repo/api' },
      { repoPath: '/repo/web' },
    ]);
    expect(macroBranchPushMock).toHaveBeenCalled();
    expect(setMetadataMissingUpstreamPolicyMock).not.toHaveBeenCalled();
  });

  it('persists ignore when the missing upstream modal chooses not to ask again', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMissingUpstreamMacroStatus(),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, "Don't ask again")?.click();
    });
    await flushAsyncWork();

    expect(setMetadataMissingUpstreamPolicyMock).toHaveBeenCalledWith('ignore');
    expect(gitPushMock).toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('keeps asking later when the missing upstream modal chooses ask next time', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMissingUpstreamMacroStatus(),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByIcon(container!, 'arrow-up')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Ask next time')?.click();
    });
    await flushAsyncWork();

    expect(setMetadataMissingUpstreamPolicyMock).not.toHaveBeenCalled();
    expect(gitPushMock).toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('ignores existing missing upstream from Resolve without pushing code', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Resolve')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Push @macro');
    expect(container?.textContent ?? '').toContain('Ignore missing upstream');
    expect(container?.textContent ?? '').not.toContain('Ask next time');

    act(() => {
      findButtonByText(container!, 'Ignore missing upstream')?.click();
    });
    await flushAsyncWork();

    expect(setMetadataMissingUpstreamPolicyMock).toHaveBeenCalledWith('ignore');
    expect(gitPushMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
  });

  it('pushes @macro directly from Resolve for an existing missing upstream', async () => {
    macroStatusByPath = {
      '/repo/api': buildMissingUpstreamMacroStatus(),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Resolve')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Push @macro')?.click();
    });
    await flushAsyncWork();

    expect(gitPushMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).toHaveBeenCalledWith({ workspacePath: '/repo/api' });
  });
});
