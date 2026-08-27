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
  mode: 'Architect' | 'Implement' | 'Chat';
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  metadataAutoPush: boolean;
  metadataMissingUpstreamPolicy: 'ask' | 'ignore';
  setMetadataMissingUpstreamPolicy: ReturnType<typeof mock>;
  activeArchitectPlanId: string | null;
  activePlanContext: { targetBranch: string } | null;
  visibleArchitectPlans: Array<{ id: string; projectIds: string[] }>;
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

type GitMergeCheckDto = {
  mergeable: boolean;
  conflictFiles: string[];
  hasChanges: boolean;
  ahead?: number;
  behind?: number;
};

type GitRebaseCheckDto = {
  rebaseable: boolean;
  conflictFiles: string[];
  output: string;
};

let appState: AppStoreState;
let taskState: { tasks: unknown[] };
let chatState: { conversations: unknown[]; selectedConversationId: string | null };
let notificationState: NotificationStoreState;
let gitStatusByPath: Record<string, GitStatusDto>;
let macroStatusByPath: Record<string, MacroBranchSyncDto>;
let gitStatusMock: ReturnType<typeof mock>;
let gitFetchMock: ReturnType<typeof mock>;
let gitPullMock: ReturnType<typeof mock>;
let gitPushMock: ReturnType<typeof mock>;
let gitMergeCheckMock: ReturnType<typeof mock>;
let gitRebaseCheckMock: ReturnType<typeof mock>;
let gitMergeMock: ReturnType<typeof mock>;
let gitRebaseBranchMock: ReturnType<typeof mock>;
let gitStashMock: ReturnType<typeof mock>;
let gitAbortMergeMock: ReturnType<typeof mock>;
let gitRemoteAddOriginMock: ReturnType<typeof mock>;
let gitFastForwardMock: ReturnType<typeof mock>;
let gitRestorePathsMock: ReturnType<typeof mock>;
let gitResetMock: ReturnType<typeof mock>;
let openConflictAssistantMock: ReturnType<typeof mock>;
let openFolderMock: ReturnType<typeof mock>;
let windowConfirmSpy: ReturnType<typeof mock> | null = null;
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

const buildDirtyGitStatus = (branch: string, behind: number, ahead: number): GitStatusDto => ({
  ...buildGitStatus(branch, behind, ahead),
  is_clean: false,
});

const buildMergeInProgressGitStatus = (branch: string, behind: number, ahead: number): GitStatusDto => ({
  ...buildDirtyGitStatus(branch, behind, ahead),
  conflicted_files: ['README.md'],
  merge_in_progress: true,
  conflictedFiles: ['README.md'],
  mergeInProgress: true,
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
const useTaskStore = createStoreHook(() => taskState);
const useChatStore = createStoreHook(() => chatState);
const useNotificationCenterStore = createStoreHook(() => notificationState);

const getProjectById = (projectId: string): Project | undefined =>
  appState.projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId);

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
};

const waitForText = async (container: HTMLDivElement, text: string) => {
  const deadline = Date.now() + 2_000;
  while (!(container.textContent ?? '').includes(text)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for footer text: ${text}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
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

const translateMock = (
  key: string,
  fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown },
  maybeOptions?: { defaultValue?: string; [key: string]: unknown }
) => {
  if (typeof fallbackOrOptions === 'string') return fallbackOrOptions;
  return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
};

const loadFooter = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: translateMock,
    }),
  }));

  mock.module('@tauri-apps/plugin-dialog', () => ({
    open: (options: { directory?: boolean; multiple?: boolean; title?: string }) =>
      openFolderMock(options),
  }));

  mock.module('../../stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('../../stores/useTaskStore', () => ({ useTaskStore }));
  mock.module('../../stores/useChatStore', () => ({ useChatStore }));

  mock.module('../../stores/useNotificationCenterStore', () => ({
    useNotificationCenterStore,
    hasUnreadNotifications: (items: Array<{ readAt: string | null }>) =>
      items.some((item) => !item.readAt),
  }));

  mock.module('../../services/tauriIpc', () => ({
    isTauriAvailable: () => true,
    updaterTarget: async () => 'linux-x86_64',
    gitStatus: (repoPath: string) => gitStatusMock(repoPath),
    gitFetch: (params: { repoPath: string }) => gitFetchMock(params),
    gitPull: (params: { repoPath: string }) => gitPullMock(params),
    gitPush: (params: { repoPath: string }) => gitPushMock(params),
    gitMergeCheck: (params: { repoPath: string; branchName: string; intoBranch: string }) =>
      gitMergeCheckMock(params),
    gitRebaseCheck: (params: { repoPath: string; branchName: string; ontoBranch: string }) =>
      gitRebaseCheckMock(params),
    gitMerge: (params: { repoPath: string; branchName: string; intoBranch: string }) =>
      gitMergeMock(params),
    gitRebaseBranch: (params: {
      repoPath: string;
      branchName: string;
      ontoBranch: string;
      confirm: boolean;
    }) => gitRebaseBranchMock(params),
    gitStash: (params: { repoPath: string; message?: string }) => gitStashMock(params),
    gitAbortMerge: (params: { repoPath: string; confirm: boolean }) =>
      gitAbortMergeMock(params),
    gitRemoteAddOrigin: (params: { repoPath: string; url: string }) =>
      gitRemoteAddOriginMock(params),
    gitRestorePaths: (params: {
      repoPath: string;
      paths: string[];
      target?: 'worktree' | 'staged' | 'staged_and_worktree';
    }) => gitRestorePathsMock(params),
    gitReset: (params: {
      repoPath: string;
      mode: 'soft' | 'mixed' | 'hard';
      commit?: string;
      confirm?: boolean;
    }) => gitResetMock(params),
    gitFastForward: (params: {
      repoPath: string;
      sourceBranch: string;
      targetBranch: string;
    }) => gitFastForwardMock(params),
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
    Icon: ({ name, className }: { name: string; className?: string }) => (
      <span data-icon={name} className={className} />
    ),
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
    openConflictAssistant: (options: { prompt: string }) =>
      openConflictAssistantMock(options),
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
      mode: 'Architect',
      selectedGroupId: 'group-1',
      selectedProjectId: 'project-a',
      selectedTaskId: null,
      standaloneProjects: [],
      projectGroups: [
        { id: 'group-1', name: 'Macro', projects: GROUP_ONE_PROJECTS },
        { id: 'group-2', name: 'Docs', projects: GROUP_TWO_PROJECTS },
      ],
      metadataAutoPush: false,
      metadataMissingUpstreamPolicy: 'ask',
      setMetadataMissingUpstreamPolicy: setMetadataMissingUpstreamPolicyMock,
      activeArchitectPlanId: 'plan-group-1',
      activePlanContext: { targetBranch: 'develop' },
      visibleArchitectPlans: [{ id: 'plan-group-1', projectIds: ['project-a', 'project-b'] }],
      switchProjectContext: mock(async () => undefined),
      getProjectById,
    };
    taskState = { tasks: [] };
    chatState = { conversations: [], selectedConversationId: null };
    notificationState = {
      items: [],
      isCenterOpen: false,
      setCenterOpen: (open: boolean) => {
        notificationState.isCenterOpen = open;
      },
    };
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 2, 0),
      '/repo/web': buildGitStatus('feature-b', 0, 3),
      '/repo/docs': buildGitStatus('release-c', 1, 0),
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
    gitMergeCheckMock = mock(async (): Promise<GitMergeCheckDto> => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 0,
      behind: 0,
    }));
    gitRebaseCheckMock = mock(async (): Promise<GitRebaseCheckDto> => ({
      rebaseable: true,
      conflictFiles: [],
      output: '',
    }));
    gitMergeMock = mock(async ({ branchName, intoBranch }: { branchName: string; intoBranch: string }) =>
      `Merged ${branchName} into ${intoBranch}`
    );
    gitRebaseBranchMock = mock(async ({ branchName, ontoBranch }: { branchName: string; ontoBranch: string }) =>
      `Rebased ${branchName} onto ${ontoBranch}`
    );
    gitStashMock = mock(async ({ repoPath }: { repoPath: string; message?: string }) => {
      gitStatusByPath[repoPath] = {
        ...gitStatusByPath[repoPath]!,
        is_clean: true,
      };
      return 'stash123';
    });
    gitAbortMergeMock = mock(async ({ repoPath }: { repoPath: string; confirm: boolean }) => {
      gitStatusByPath[repoPath] = {
        ...gitStatusByPath[repoPath]!,
        conflicted_files: [],
        merge_in_progress: false,
        conflictedFiles: [],
        mergeInProgress: false,
        is_clean: true,
      };
    });
    gitRemoteAddOriginMock = mock(async ({ url }: { repoPath: string; url: string }) => ({
      remote: 'origin',
      url,
    }));
    gitFastForwardMock = mock(async () => 'Fast-forwarded');
    gitRestorePathsMock = mock(async () => undefined);
    gitResetMock = mock(async () => undefined);
    openConflictAssistantMock = mock(async () => 'conversation-id');
    openFolderMock = mock(async () => null);
    windowConfirmSpy = null;
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

  it('exposes the notification center relationship to assistive technology', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();

    const button = container.querySelector<HTMLButtonElement>('[aria-controls="notification-center-popover"]');
    expect(button?.getAttribute('aria-label')).toBe('Notifications');
    expect(button?.getAttribute('title')).toBe('Notifications');
  });

  it('uses the selected Implement task repository for the label and Git commands', async () => {
    appState.mode = 'Implement';
    appState.selectedTaskId = 'task-web';
    appState.selectedProjectId = 'project-a';
    taskState.tasks = [{
      id: 'task-web',
      project_id: 'project-b',
      project_ids: ['project-b'],
      execution_targets: [],
    }];
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();

    expect(container.textContent ?? '').toContain('Web');
    expect(container.textContent ?? '').not.toContain('API');

    act(() => findButtonByIcon(container!, 'arrow-down')?.click());
    await flushAsyncWork();

    expect(gitPullMock).toHaveBeenCalledWith({ repoPath: '/repo/web' });
  });

  it('uses the project selected in Architect when no plan is selected', async () => {
    appState.mode = 'Architect';
    appState.activeArchitectPlanId = null;
    appState.visibleArchitectPlans = [];
    appState.selectedProjectId = 'project-b';
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await waitForText(container, 'feature-b');

    expect(container.textContent ?? '').toContain('Web');
    expect(container.textContent ?? '').not.toContain('Aucun projet');

    act(() => findButtonByIcon(container!, 'refresh-cw')?.click());
    await flushAsyncWork();

    expect(gitFetchMock).toHaveBeenCalledWith({ repoPath: '/repo/web' });
  });

  it('disables Git actions and executes no fallback command without an active Chat project', async () => {
    appState.mode = 'Chat';
    appState.selectedProjectId = 'project-a';
    chatState.selectedConversationId = 'chat-empty';
    chatState.conversations = [{ id: 'chat-empty', task_id: null, project_id: null }];
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();

    expect(container.textContent ?? '').toContain('Aucun projet');
    expect(findButtonByIcon(container!, 'refresh-cw')?.disabled).toBe(true);
    expect(findButtonByIcon(container!, 'arrow-down')).toBeNull();
    expect(findButtonByIcon(container!, 'arrow-up')).toBeNull();
    expect(gitPullMock).not.toHaveBeenCalled();
    expect(gitPushMock).not.toHaveBeenCalled();
  });

  it('lets Architect use an explicitly selected Git folder when no project exists', async () => {
    appState.mode = 'Architect';
    appState.selectedProjectId = null;
    appState.activeArchitectPlanId = null;
    appState.visibleArchitectPlans = [];
    appState.projectGroups = [];
    appState.standaloneProjects = [];
    gitStatusByPath['/repo/sandbox'] = buildGitStatus('feature/sandbox', 2, 0);
    openFolderMock = mock(async () => '/repo/sandbox');

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();

    const folderButton = container.querySelector(
      '[data-tour-id="footer-folder-scope"]'
    ) as HTMLButtonElement | null;
    expect(folderButton?.textContent).toContain('Sélectionner un dossier Git');

    act(() => folderButton?.click());
    await waitForText(container, 'feature/sandbox');

    expect(openFolderMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Sélectionner un dossier Git',
    });
    expect(container.textContent ?? '').toContain('sandbox');
    expect(findButtonByIcon(container, 'arrow-down')?.textContent?.trim()).toBe('2');
    expect(findButtonByIcon(container, 'arrow-up')?.textContent?.trim()).toBe('0');

    act(() => findButtonByIcon(container!, 'arrow-down')?.click());
    await flushAsyncWork();
    act(() => findButtonByIcon(container!, 'arrow-up')?.click());
    await flushAsyncWork();

    expect(gitPullMock).toHaveBeenCalledWith({ repoPath: '/repo/sandbox' });
    expect(gitPushMock).toHaveBeenCalledWith({ repoPath: '/repo/sandbox' });
    expect(macroBranchEnsureMock).not.toHaveBeenCalled();
    expect(macroBranchPullMock).not.toHaveBeenCalled();
    expect(macroBranchPushMock).not.toHaveBeenCalled();
    expect(macroBranchCommitIfDirtyMock).not.toHaveBeenCalled();
  });

  it('keeps the group focus stable while the footer git scope changes', async () => {
    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();

    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('2@5');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('0@4');

    await selectGitScope(container!, 'project-b');

    expect(appState.switchProjectContext).not.toHaveBeenCalled();
    expect(appState.selectedProjectId).toBe('project-a');
    expect((container?.querySelector('select') as HTMLSelectElement | null)?.value).toBe('project-b');
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('0@8');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('3@6');
  });

  it('renders the contextual project label with enough line height for descenders', async () => {
    appState.projectGroups = [
      {
        id: 'group-1',
        name: 'Group',
        projects: [{ ...GROUP_ONE_PROJECTS[0]!, name: 'andrologic.ai' }, GROUP_ONE_PROJECTS[1]!],
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

  it('keeps footer Git animations in fixed frames and gives each action its own motion', async () => {
    let resolveFetch!: (value: { branch: string; remote: string; output: string }) => void;
    let resolvePull!: (value: { branch: string; remote: string; output: string }) => void;
    let resolvePush!: (value: { branch: string; remote: string; output: string }) => void;
    gitFetchMock = mock(() => new Promise<{ branch: string; remote: string; output: string }>((resolve) => { resolveFetch = resolve; }));
    gitPullMock = mock(() => new Promise<{ branch: string; remote: string; output: string }>((resolve) => { resolvePull = resolve; }));
    gitPushMock = mock(() => new Promise<{ branch: string; remote: string; output: string }>((resolve) => { resolvePush = resolve; }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await flushAsyncWork();

    const fetchButton = findButtonByIcon(container, 'refresh-cw');
    const pullButton = findButtonByIcon(container, 'arrow-down');
    const pushButton = findButtonByIcon(container, 'arrow-up');
    expect(fetchButton?.title).toContain('main-a');
    expect(pullButton?.title).toContain('main-a');
    expect(pushButton?.title).toContain('main-a');
    expect(container.querySelectorAll('.footer-git-action-icon-frame')).toHaveLength(3);
    expect(container.querySelector('.animate-bounce')).toBeNull();

    act(() => fetchButton?.click());
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-icon="refresh-cw"]')?.classList)
      .toContain('footer-git-action-icon--fetching');
    resolveFetch({ branch: 'main-a', remote: 'origin', output: 'ok' });
    await flushAsyncWork();

    act(() => pullButton?.click());
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-icon="arrow-down"]')?.classList)
      .toContain('footer-git-action-icon--pulling');
    resolvePull({ branch: 'main-a', remote: 'origin', output: 'ok' });
    await flushAsyncWork();

    act(() => pushButton?.click());
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-icon="arrow-up"]')?.classList)
      .toContain('footer-git-action-icon--pushing');
    resolvePush({ branch: 'main-a', remote: 'origin', output: 'ok' });
    await flushAsyncWork();
  });

  it('targets footer git actions to the selected contextual repository and never aggregates repositories', async () => {
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

    await selectGitScope(container!, 'project-a');

    const fetchCallsBeforeAllProjects = gitFetchMock.mock.calls.length;
    act(() => {
      findButtonByIcon(container!, 'refresh-cw')?.click();
    });
    await flushAsyncWork();

    expect(gitFetchMock.mock.calls.slice(fetchCallsBeforeAllProjects)).toEqual([
      [{ repoPath: '/repo/api' }],
    ]);
  });

  it('opens a divergence modal and runs preflights before mutating a divergent branch', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Branch has diverged from remote');
    expect(container?.textContent ?? '').toContain('origin/feature-b');
    expect(container?.textContent ?? '').toContain('Available');
    expect(gitFetchMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branch: 'feature-b',
    });
    expect(gitMergeCheckMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branchName: 'origin/feature-b',
      intoBranch: 'feature-b',
    });
    expect(gitRebaseCheckMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branchName: 'feature-b',
      ontoBranch: 'origin/feature-b',
    });
    expect(gitPullMock).not.toHaveBeenCalled();
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(gitRebaseBranchMock).not.toHaveBeenCalled();

    act(() => {
      findButtonByText(container!, 'Rebase')?.click();
    });
    await flushAsyncWork();

    expect(gitFetchMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branch: 'feature-b',
    });
    expect(gitRebaseBranchMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branchName: 'feature-b',
      ontoBranch: 'origin/feature-b',
      confirm: true,
    });
    expect(gitMergeMock).not.toHaveBeenCalled();
  });

  it('can stash local changes before resolving a divergent branch', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildDirtyGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementationOnce(async (): Promise<GitMergeCheckDto> => ({
      mergeable: false,
      conflictFiles: ['docs/cli.md'],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await waitForText(container!, 'local changes');

    expect(findButtonByText(container!, 'Stash, then merge')).toBeNull();
    expect(container?.textContent ?? '').toContain('Stash, then rebase');

    act(() => {
      findButtonByText(container!, 'Stash, then rebase')?.click();
    });
    await flushAsyncWork();

    expect(gitStashMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      message: 'Macro: stash before rebase feature-b',
    });
    expect(gitRebaseBranchMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      branchName: 'feature-b',
      ontoBranch: 'origin/feature-b',
      confirm: true,
    });
    expect(gitPullMock).not.toHaveBeenCalled();
  });

  it('hides merge when the merge preflight detects conflicts', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementationOnce(async (): Promise<GitMergeCheckDto> => ({
      mergeable: false,
      conflictFiles: ['docs/cli.md', 'src/project.ml', 'tests/test_cli.ml'],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    const text = container?.textContent ?? '';
    expect(text).toContain('Conflicts detected');
    expect(text).toContain('Conflicts');
    expect(text).toContain('docs/cli.md');
    expect(text).toContain('src/project.ml');
    expect(text).not.toContain('Latest attempt failed');
    expect(findButtonByText(container!, 'Merge')).toBeNull();
    expect(findButtonByText(container!, 'Rebase')).not.toBeNull();
    expect(gitMergeMock).not.toHaveBeenCalled();
  });

  it('hides rebase when the rebase preflight detects conflicts', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitRebaseCheckMock.mockImplementationOnce(async (): Promise<GitRebaseCheckDto> => ({
      rebaseable: false,
      conflictFiles: ['src/cascade.ml', 'tests/test_project_manifest.ml'],
      output: 'conflict',
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    const text = container?.textContent ?? '';
    expect(text).toContain('Conflicts detected');
    expect(text).toContain('src/cascade.ml');
    expect(text).toContain('tests/test_project_manifest.ml');
    expect(findButtonByText(container!, 'Merge')).not.toBeNull();
    expect(findButtonByText(container!, 'Rebase')).toBeNull();
    expect(gitRebaseBranchMock).not.toHaveBeenCalled();
  });

  it('offers only close when merge and rebase preflights both conflict', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementationOnce(async (): Promise<GitMergeCheckDto> => ({
      mergeable: false,
      conflictFiles: ['docs/maintenance-plan.md'],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));
    gitRebaseCheckMock.mockImplementationOnce(async (): Promise<GitRebaseCheckDto> => ({
      rebaseable: false,
      conflictFiles: ['src/project_interface.ml'],
      output: 'conflict',
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    const text = container?.textContent ?? '';
    expect(text).toContain('docs/maintenance-plan.md');
    expect(text).toContain('src/project_interface.ml');
    expect(findButtonByText(container!, 'Merge')).toBeNull();
    expect(findButtonByText(container!, 'Rebase')).toBeNull();
    expect(findButtonByText(container!, 'Close')).not.toBeNull();
    expect(findButtonByText(container!, 'Cancel')).toBeNull();
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(gitRebaseBranchMock).not.toHaveBeenCalled();
  });

  it('shows only abort merge when divergence resolution finds an unmerged index', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildMergeInProgressGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root?.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Merge in progress');
    expect(container?.textContent ?? '').toContain('README.md');
    expect(findButtonByText(container!, 'Stash, then rebase')).toBeNull();
    expect(findButtonByText(container!, 'Merge')).toBeNull();
    expect(gitMergeCheckMock).not.toHaveBeenCalled();
    expect(gitRebaseCheckMock).not.toHaveBeenCalled();

    act(() => {
      findButtonByText(container!, 'Abort merge')?.click();
    });
    await flushAsyncWork();

    expect(gitAbortMergeMock).toHaveBeenCalledWith({
      repoPath: '/repo/web',
      confirm: true,
    });
    expect(gitPullMock).not.toHaveBeenCalled();
  });

  it('opens the resolution modal when a pull fails with a divergence error', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitPullMock.mockImplementationOnce(async () => {
      throw new Error('Pulling diverged branches is not possible. Fetch first.');
    });

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Branch has diverged from remote');
  });

  it('exposes stash, discard, and conflict assistant actions when divergence meets local changes', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildDirtyGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementation(async (): Promise<GitMergeCheckDto> => ({
      mergeable: false,
      conflictFiles: ['docs/cli.md'],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));
    gitRebaseCheckMock.mockImplementation(async (): Promise<GitRebaseCheckDto> => ({
      rebaseable: false,
      conflictFiles: ['src/cascade.ml'],
      output: 'conflict',
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').toContain('Conflicts detected');
    expect(findButtonByText(container!, 'Stash and retry')).not.toBeNull();
    expect(findButtonByText(container!, 'Discard local changes')).not.toBeNull();
    expect(findButtonByText(container!, 'Open conflict assistant')).not.toBeNull();
  });

  it('opens the conflict assistant when the corresponding modal action is clicked', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildDirtyGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementation(async (): Promise<GitMergeCheckDto> => ({
      mergeable: false,
      conflictFiles: ['docs/cli.md'],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));
    gitRebaseCheckMock.mockImplementation(async (): Promise<GitRebaseCheckDto> => ({
      rebaseable: false,
      conflictFiles: ['src/cascade.ml'],
      output: 'conflict',
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    act(() => {
      findButtonByText(container!, 'Open conflict assistant')?.click();
    });
    await flushAsyncWork();

    expect(openConflictAssistantMock).toHaveBeenCalledTimes(1);
    const [options] = openConflictAssistantMock.mock.calls[0] ?? [];
    expect(options).toBeDefined();
    expect(typeof options?.prompt).toBe('string');
    expect(options.prompt.length).toBeGreaterThan(0);
    expect(container?.textContent ?? '').not.toContain('Conflicts detected');
  });

  it('discards local changes through gitRestorePaths when the user confirms', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildDirtyGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementation(async (): Promise<GitMergeCheckDto> => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));
    gitStatusMock.mockImplementation(async (repoPath: string) => ({
      ...(await cloneGitStatus(gitStatusByPath[repoPath]!)),
      staged_files: [{ path: 'lib/foo.ml', old_path: 'lib/old-foo.ml', status: 'R' } as never],
      unstaged_files: [{ path: 'lib/bar.ml', status: 'M' } as never],
      untracked_files: [{ path: 'lib/new.ml', status: '??' } as never],
    }));
    windowConfirmSpy = mock(() => true);
    const originalConfirm = window.confirm;
    window.confirm = windowConfirmSpy as never;

    try {
      const { Footer } = await loadFooter();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      root.render(<Footer />);
      await flushAsyncWork();
      await selectGitScope(container!, 'project-b');

      act(() => {
        findButtonByIcon(container!, 'arrow-down')?.click();
      });
      await flushAsyncWork();

      act(() => {
        findButtonByText(container!, 'Discard local changes')?.click();
      });
      await flushAsyncWork();

      expect(windowConfirmSpy).toHaveBeenCalledTimes(1);
      expect(gitRestorePathsMock).toHaveBeenCalledWith({
        repoPath: '/repo/web',
        paths: ['lib/old-foo.ml', 'lib/foo.ml', 'lib/bar.ml', 'lib/new.ml'],
        target: 'staged_and_worktree',
      });
      expect(gitResetMock).not.toHaveBeenCalled();
      expect(container?.textContent ?? '').not.toContain('Branch has diverged from remote');
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('hides stash and discard when no local changes are present', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 3),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };
    gitMergeCheckMock.mockImplementation(async (): Promise<GitMergeCheckDto> => ({
      mergeable: true,
      conflictFiles: [],
      hasChanges: true,
      ahead: 3,
      behind: 4,
    }));

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(findButtonByText(container!, 'Stash and retry')).toBeNull();
    expect(findButtonByText(container!, 'Discard local changes')).toBeNull();
    expect(findButtonByText(container!, 'Merge')).not.toBeNull();
    expect(findButtonByText(container!, 'Rebase')).not.toBeNull();
  });

  it('does not open the resolution modal when a pull succeeds', async () => {
    gitStatusByPath = {
      '/repo/api': buildGitStatus('main-a', 0, 0),
      '/repo/web': buildGitStatus('feature-b', 4, 0),
      '/repo/docs': buildGitStatus('release-c', 0, 0),
    };
    macroStatusByPath = {
      '/repo/api': buildMacroStatus(0, 0),
      '/repo/web': buildMacroStatus(0, 0),
      '/repo/docs': buildMacroStatus(0, 0),
    };

    const { Footer } = await loadFooter();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(<Footer />);
    await flushAsyncWork();
    await selectGitScope(container!, 'project-b');

    act(() => {
      findButtonByIcon(container!, 'arrow-down')?.click();
    });
    await flushAsyncWork();

    expect(container?.textContent ?? '').not.toContain('Branch has diverged from remote');
    expect(gitPullMock).toHaveBeenCalledWith({ repoPath: '/repo/web' });
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
    appState.activeArchitectPlanId = 'plan-group-2';
    appState.visibleArchitectPlans = [{ id: 'plan-group-2', projectIds: ['project-c'] }];

    root?.render(<Footer />);
    await flushAsyncWork();

    expect(container?.querySelector('select')).toBeNull();
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('1@2');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('0@9');
    expect(container?.textContent ?? '').toContain('release-c');
  });

  it('invalidates a disappeared manual scope and resolves the only remaining plan repository', async () => {
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

    expect(container?.querySelector('select')).toBeNull();
    expect(findButtonByIcon(container!, 'arrow-down')?.textContent?.trim()).toBe('2@5');
    expect(findButtonByIcon(container!, 'arrow-up')?.textContent?.trim()).toBe('0@4');
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

  it('does not push an out-of-context repository while the contextual repository has no origin', async () => {
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
    expect(gitPushMock).not.toHaveBeenCalled();
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

  it('shows only the contextual missing-origin repository and requires it to be configured', async () => {
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
    expect(container?.querySelectorAll('input')).toHaveLength(1);

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
