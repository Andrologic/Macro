import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileChangesPanel as FileChangesPanelComponent } from './FileChangesPanel';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type { useTaskStore as UseTaskStoreHook } from '../../stores/useTaskStore';
import type { useChatStore as UseChatStoreHook } from '../../stores/useChatStore';
import type { useProviderStore as UseProviderStoreHook } from '../../stores/useProviderStore';
import {
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import type { useFileChangesStore as UseFileChangesStoreHook } from '../../stores/useFileChangesStore';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import type { VisiblePlanTaskArtifactReviewEntry } from '../../services/architectPlanArtifactService';
import type { MetadataModelConfig } from '../../services/metadataModelConfig';
import { buildReviewTaskSummary } from '../../services/implementMultiRepoSummary';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';
import { installTauriRuntimeMock } from '../../test-utils/tauriRuntime';

let FileChangesPanel!: typeof FileChangesPanelComponent;
let useAppStore!: typeof UseAppStoreHook;
let useTaskStore!: typeof UseTaskStoreHook;
let useChatStore!: typeof UseChatStoreHook;
let useProviderStore!: typeof UseProviderStoreHook;
let useFileChangesStore!: typeof UseFileChangesStoreHook;
let clearPreferencesForTest!: typeof import('../../services/preferences').clearPreferences;
let initialAppState: ReturnType<typeof useAppStore.getState> | null = null;
let initialTaskState: ReturnType<typeof useTaskStore.getState> | null = null;
let initialChatState: ReturnType<typeof useChatStore.getState> | null = null;
let initialProviderState: ReturnType<typeof useProviderStore.getState> | null = null;
let initialFileChangesState: ReturnType<typeof useFileChangesStore.getState> | null = null;
let notifySuccessMock: ReturnType<typeof mock>;
let notifyErrorMock: ReturnType<typeof mock>;
let notifyActionRequiredMock: ReturnType<typeof mock>;
let getArchitectPlanMock: ReturnType<typeof mock>;
let listArtifactEntriesMock: ReturnType<typeof mock>;
let validateArtifactMock: ReturnType<typeof mock>;
let unvalidateArtifactMock: ReturnType<typeof mock>;
let importCounter = 0;
let resizeObserverWidth = 640;
let metadataModelConfigForTest: MetadataModelConfig | null = { mode: 'conversation' };
const readMetadataModelConfigForTest = (): MetadataModelConfig | null => metadataModelConfigForTest;
const metadataModelConfigListeners = new Set<(value: MetadataModelConfig | null) => void>();
const hadInitialBackendTransport = Object.prototype.hasOwnProperty.call(
  process.env,
  'VITE_BACKEND_TRANSPORT',
);
const initialBackendTransport = process.env.VITE_BACKEND_TRANSPORT;
const translationMock = createTranslationMock({
  'errors.degraded.fallback.dynamic': '{{message}}',
  'errors.degraded.worktree.checkedOut.title': 'Macro could not prepare the task workspace',
  'errors.degraded.worktree.checkedOut.body':
    'The branch needed for this task is still open in the main repository with local changes.',
  'errors.degraded.worktree.checkedOut.nextStep':
    'Commit, stash, or discard those local changes, then retry the task.',
  'errors.degraded.worktree.fallback.title': 'Macro could not prepare the task workspace',
  'errors.degraded.worktree.fallback.body':
    'The task workspace is not ready yet, so Macro cannot safely review or edit files.',
  'errors.degraded.worktree.fallback.nextStep':
    'Retry the task. If it still fails, open the project Git settings and check the repository state.',
  'errors.degraded.gitFlow.conflict.title': 'Resolve these conflicts before finishing',
  'errors.degraded.gitFlow.conflict.body': 'The plan cannot be merged cleanly yet.',
  'errors.degraded.gitFlow.conflict.filesNextStep':
    'Resolve the listed files, then retry the merge.',
  'errors.degraded.gitFlow.conflict.blockersNextStep':
    'Resolve the merge blockers, then retry.',
  'errors.degraded.service.resourcePressure.title': 'Macro is temporarily overloaded',
  'errors.degraded.service.resourcePressure.body':
    'The system has too many files open, so Macro paused automatic repository refreshes before retrying.',
  'errors.degraded.service.resourcePressure.nextStep':
    'Wait a moment, then retry. If this keeps happening, close extra project windows or terminals.',
  'errors.degraded.service.gitObjectMissing.title': 'Git review is paused',
  'errors.degraded.service.gitObjectMissing.body':
    'A Git object needed for this review is unavailable. Macro did not modify any working files.',
  'errors.degraded.service.gitObjectMissing.nextStep':
    'Retry to ask Git for the object again. Open the technical details to inspect the repository, object ID, and Git output.',
  'errors.degraded.service.directCheckpointCorrupt.title': "Macro's review checkpoint is damaged",
  'errors.degraded.service.directCheckpointCorrupt.body':
    "The internal checkpoint for this non-Git project's review is incomplete. Macro preserved it and did not modify any working files.",
  'errors.degraded.service.directCheckpointCorrupt.nextStep':
    'Retry once, then open the technical details for diagnosis.',
  'errors.degraded.service.directModeConfigurationRequired.title':
    'Direct review needs configuration',
  'errors.degraded.service.directModeConfigurationRequired.body':
    'This project is not a Git repository, and direct editing is not enabled.',
  'errors.degraded.service.directModeConfigurationRequired.nextStep':
    'Enable direct editing for the project.',
  'errors.degraded.service.directCheckpointProjectMismatch.title':
    "Macro's review checkpoint belongs to another project path",
  'errors.degraded.service.directCheckpointProjectMismatch.body':
    'The saved checkpoint identity does not match this project path.',
  'errors.degraded.service.directCheckpointProjectMismatch.nextStep':
    'Check the saved project path before changing its metadata.',
});

const installFileChangesRuntimeMock = () => {
  const documentKinds = ['runtime', 'settings', 'agents', 'providers', 'tools', 'skills', 'git'] as const;
  const documents = new Map(documentKinds.map((kind) => [kind, {
    kind,
    scope: { type: 'user' },
    value: { $schema: `./schemas/v1/${kind}.schema.json`, schemaVersion: 1 } as Record<string, unknown>,
    etag: `${kind}-etag-0`,
    readOnly: false,
    invalid: false,
    filePath: `${kind}.json`,
    diagnostics: [],
  }]));
  let etagRevision = 0;

  installTauriRuntimeMock(mock(async (command: string, payload?: Record<string, unknown>) => {
    if (command === 'plugin:store|load') return 1;
    if (command === 'plugin:store|get') return [undefined, false];
    if (command === 'config_get_snapshot') {
      return {
        schemaVersion: 1,
        effective: {
          runtime: {},
          settings: {},
          agents: {},
          providers: {},
          tools: {},
          skills: {},
          git: {},
        },
        documents: [...documents.values()],
        provenance: [],
        diagnostics: [],
        pendingRestartPaths: [],
      };
    }
    if (command === 'config_get_document') {
      return documents.get(String(payload?.kind) as typeof documentKinds[number]);
    }
    if (command === 'config_apply_patch') {
      const request = payload?.request as {
        kind: typeof documentKinds[number];
        patch: Array<{ op: string; path: string; value?: unknown }>;
      };
      const current = documents.get(request.kind);
      if (!current) return undefined;
      const value = { ...current.value };
      for (const operation of request.patch) {
        const key = operation.path.replace(/^\//, '').replaceAll('~1', '/').replaceAll('~0', '~');
        if (operation.op === 'remove') delete value[key];
        else value[key] = operation.value;
      }
      etagRevision += 1;
      const document = { ...current, value, etag: `${request.kind}-etag-${etagRevision}` };
      documents.set(request.kind, document);
      return {
        status: 'applied',
        document,
        pendingChange: null,
        restartRequired: false,
      };
    }
    if (command === 'state_get_snapshot' || command === 'state_clear') {
      return { schemaVersion: 1, values: {} };
    }
    if (command === 'state_set_value') {
      return { schemaVersion: 1, values: { [String(payload?.key)]: payload?.value } };
    }
    return undefined;
  }));
};

class ResizeObserverTestMock {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    Object.defineProperty(target, 'clientWidth', {
      configurable: true,
      value: resizeObserverWidth,
    });
    Object.defineProperty(target, 'clientHeight', {
      configurable: true,
      value: 720,
    });
    this.callback([
      {
        target,
        contentRect: {
          width: resizeObserverWidth,
          height: 720,
        },
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

const loadFileChangesPanelModules = async () => {
  importCounter += 1;
  installReactI18nextMock(translationMock);

  const tauriWindowModule = await import(
    `../../services/tauriWindow.ts?file-changes-panel-tauri-window-test=${importCounter}`
  );
  mock.module('../../services/tauriWindow', () => ({
    ...tauriWindowModule,
  }));
  mock.module('../../services/tauriWindow.ts', () => ({
    ...tauriWindowModule,
  }));

  const preferencesModule = await import(
    `../../services/preferences.ts?file-changes-panel-preferences-test=${importCounter}`
  );
  clearPreferencesForTest = preferencesModule.clearPreferences;
  mock.module('../../services/preferences', () => ({
    ...preferencesModule,
  }));

  mock.module('../../services/metadataModelPreference', () => ({
    loadMetadataModelConfig: async () => metadataModelConfigForTest,
    saveMetadataModelConfig: async (config: MetadataModelConfig | null) => {
      metadataModelConfigForTest = config;
      metadataModelConfigListeners.forEach((listener) => listener(config));
      return config;
    },
    subscribeMetadataModelConfig: (listener: (value: MetadataModelConfig | null) => void) => {
      metadataModelConfigListeners.add(listener);
      return () => metadataModelConfigListeners.delete(listener);
    },
  }));

  const architectPlanServiceModule = await import(
    `../../services/architectPlanService.ts?file-changes-panel-plan-service-test=${importCounter}`
  );
  mock.module('../../services/architectPlanService', () => ({
    ...architectPlanServiceModule,
    getArchitectPlan: (...args: unknown[]) => getArchitectPlanMock(...args),
  }));

  const architectPlanArtifactServiceModule = await import(
    `../../services/architectPlanArtifactService.ts?file-changes-panel-artifact-service-test=${importCounter}`
  );
  mock.module('../../services/architectPlanArtifactService', () => ({
    ...architectPlanArtifactServiceModule,
    listVisibleTaskArtifactReviewEntries: (...args: unknown[]) => listArtifactEntriesMock(...args),
    normalizeArtifactContracts: (node: { artifactContracts?: unknown[] }) => node.artifactContracts || [],
    validateVisibleTaskArtifact: (...args: unknown[]) => validateArtifactMock(...args),
    unvalidateVisibleTaskArtifact: (...args: unknown[]) => unvalidateArtifactMock(...args),
    loadMissingRequiredArtifactsForCompletion: mock(async () => []),
    loadUnvalidatedCurrentTaskArtifactsForCompletion: mock(async () => []),
    readVisibleTaskArtifactDiff: mock(async () => ({
      artifact: null,
      content: '',
      previousArtifact: null,
      previousContent: '',
      status: 'added',
    })),
  }));

  const appStoreModule = await import(
    `../../stores/useAppStore.ts?file-changes-panel-app-store-test=${importCounter}`
  );
  mock.module('../../stores/useAppStore', () => ({
    ...appStoreModule,
  }));

  const taskStoreModule = await import(
    `../../stores/useTaskStore.ts?file-changes-panel-task-store-test=${importCounter}`
  );
  mock.module('../../stores/useTaskStore', () => ({
    ...taskStoreModule,
  }));

  const chatStoreModule = await import(
    `../../stores/useChatStore.ts?file-changes-panel-chat-store-test=${importCounter}`
  );
  mock.module('../../stores/useChatStore', () => ({
    ...chatStoreModule,
  }));

  const providerStoreModule = await import(
    `../../stores/useProviderStore.ts?file-changes-panel-provider-store-test=${importCounter}`
  );
  mock.module('../../stores/useProviderStore', () => ({
    ...providerStoreModule,
    providerHasCredentials: (provider: {
      isEnabled?: boolean;
      isLocal?: boolean;
      apiKey?: string;
      hasStoredApiKey?: boolean;
      authStatus?: string;
    }) =>
      !!provider.isEnabled &&
      (!!provider.isLocal ||
        !!provider.apiKey ||
        !!provider.hasStoredApiKey ||
        provider.authStatus === 'connected' ||
        provider.authStatus === 'authenticated'),
  }));

  const fileChangesStoreModule = await import(
    `../../stores/useFileChangesStore.ts?file-changes-panel-store-test=${importCounter}`
  );
  mock.module('../../stores/useFileChangesStore', () => ({
    ...fileChangesStoreModule,
  }));

  const fileChangesDiffModalModule = await import(
    `../modals/FileChangesDiffModal.tsx?file-changes-panel-diff-modal-test=${importCounter}`
  );
  mock.module('../modals/FileChangesDiffModal', () => ({
    ...fileChangesDiffModalModule,
  }));

  const reactModule = await import('react');
  mock.module('../modals/ArtifactDiffModal', () => ({
    ArtifactDiffModal: ({
      artifactId,
      onArtifactSaved,
    }: {
      artifactId: string;
      onArtifactSaved: (artifactId: string) => Promise<void> | void;
    }) =>
      reactModule.createElement(
        'div',
        {
          'data-artifact-diff-modal': 'true',
          'data-artifact-id': artifactId,
        },
        reactModule.createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              void onArtifactSaved('audit-findings-task-1');
            },
          },
          'Mock artifact saved'
        )
      ),
  }));

  mock.module('../modals/MergeWorkflowConflictResolverModal', () => ({
    MergeWorkflowConflictResolverModal: ({
      repository,
      onClose,
    }: {
      repository: { id: string; conflictFiles: string[] };
      onClose: () => void;
    }) =>
      reactModule.createElement(
        'div',
        {
          'data-merge-conflict-resolver-modal': 'true',
          'data-repository-id': repository.id,
        },
        repository.conflictFiles.join('\n'),
        reactModule.createElement('button', { onClick: onClose }, 'Close resolver')
      ),
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      success: (...args: unknown[]) => notifySuccessMock(...args),
      error: (...args: unknown[]) => notifyErrorMock(...args),
      info: mock(() => undefined),
      warning: mock(() => undefined),
      actionRequired: (...args: unknown[]) => notifyActionRequiredMock(...args),
    },
  }));

  ({ FileChangesPanel } = await import(`./FileChangesPanel.tsx?file-changes-panel-test=${importCounter}`));
  ({ useAppStore } = appStoreModule);
  ({ useTaskStore } = taskStoreModule);
  ({ useChatStore } = chatStoreModule);
  ({ useProviderStore } = providerStoreModule);
  ({ useFileChangesStore } = fileChangesStoreModule);
  initialAppState = useAppStore.getState();
  initialTaskState = useTaskStore.getState();
  initialChatState = useChatStore.getState();
  initialProviderState = useProviderStore.getState();
  initialFileChangesState = useFileChangesStore.getState();
};

const buildRepository = (reviewedMain: boolean): ReviewRepositoryState => ({
  id: 'repo-1',
  projectId: 'project-1',
  repoPath: '/tmp/repo-1',
  worktreePath: '/tmp/worktree-1',
  branchName: 'feature/review-actions',
  planBranchName: null,
  changes: [
    {
      id: 'change-1',
      path: 'src/main.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      originalContent: 'before();',
      indexContent: reviewedMain ? 'validated();' : 'before();',
      modifiedContent: 'after();',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
      hasPendingVisibleChange: true,
      hasValidatedStage: reviewedMain,
      validatedRemovedLineNumbers: reviewedMain ? [1] : [],
      validatedAddedLineNumbers: reviewedMain ? [1] : [],
    },
    {
      id: 'change-2',
      path: 'src/nested/child.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      originalContent: '',
      indexContent: '',
      modifiedContent: 'export const child = true;',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
      hasPendingVisibleChange: true,
      hasValidatedStage: false,
      validatedRemovedLineNumbers: [],
      validatedAddedLineNumbers: [],
    },
  ],
  stagedPaths: reviewedMain ? ['src/main.ts'] : [],
  selectedChangeId: 'change-1',
  stats: {
    pendingVisibleFileCount: 2,
    validatedStagedFileCount: reviewedMain ? 1 : 0,
    additions: 7,
    deletions: 1,
  },
  commitMessageDraft: 'feat: review actions',
  commitState: 'idle',
  loadingChangeId: null,
  savingChangeId: null,
  lastError: null,
  lastCommitHash: null,
});

const reviewAllPendingFileDiffs = async () => {
  for (const fileName of ['main.ts', 'child.ts']) {
    const fileButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes(fileName));
    expect(fileButton).toBeDefined();
    act(() => {
      fileButton?.click();
    });
    await flushRender();
  }
};

const buildArtifactPlan = (): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'Plan 1',
  status: 'active',
  targetBranch: 'feature/artifacts',
  storageBranch: 'feature/artifacts',
  projectId: 'project-1',
  projectIds: ['project-1'],
  nodes: [
    {
      id: 'audit',
      title: 'Audit task',
      type: 'task',
      status: 'completed',
      dependencies: [],
    },
    {
      id: 'task-1',
      title: 'Review panel actions',
      type: 'task',
      status: 'pending',
      dependencies: ['audit'],
      artifactContracts: [
        {
          id: 'api-contract',
          title: 'API contract',
          kind: 'api_contract',
          required: true,
        },
      ],
    },
  ],
} as unknown as ArchitectPlanRecord);

const buildArtifactEntries = (): VisiblePlanTaskArtifactReviewEntry[] => [
  {
    artifact: {
      id: 'api-contract',
      planId: 'plan-1',
      taskId: 'task-1',
      kind: 'api_contract',
      title: 'API contract',
      summary: 'Routes and payloads',
      contentType: 'markdown',
      path: 'branches/feature/artifacts/plans/plan-1/artifacts/tasks/task-1/api-contract.md',
      contentHash: 'own',
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'agent',
      contractId: 'api-contract',
      visibility: 'own',
    },
    review: null,
    hasValidatedReview: false,
    hasPendingReview: true,
  },
  {
    artifact: {
      id: 'audit-findings',
      planId: 'plan-1',
      taskId: 'audit',
      kind: 'audit',
      title: 'Audit findings',
      summary: 'Security and migration notes',
      contentType: 'markdown',
      path: 'branches/feature/artifacts/plans/plan-1/artifacts/tasks/audit/audit-findings.md',
      contentHash: 'inherited',
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'agent',
      visibility: 'inherited',
    },
    review: {
      artifactId: 'audit-findings',
      taskId: 'task-1',
      validatedAt: '2026-05-26T00:00:00.000Z',
      validatedBy: 'user',
    },
    hasValidatedReview: true,
    hasPendingReview: false,
  },
];

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('FileChangesPanel', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let stageChangesMock: ReturnType<typeof mock>;
  let unstageChangesMock: ReturnType<typeof mock>;
  let stageAllChangesMock: ReturnType<typeof mock>;
  let stageAllTaskChangesMock: ReturnType<typeof mock>;
  let revertChangesMock: ReturnType<typeof mock>;
  let openDiffModalMock: ReturnType<typeof mock>;
  let loadCurrentChangesMock: ReturnType<typeof mock>;
  let finishTaskMock: ReturnType<typeof mock>;
  let commitStagedChangesMock: ReturnType<typeof mock>;
  let commitAllReadyTaskRepositoriesMock: ReturnType<typeof mock>;

  const seedStores = (
    repository: ReviewRepositoryState,
    options: {
      loadState?: 'ready' | 'out_of_scope' | 'awaiting_worktree' | 'invalid_mapping';
      loadMessage?: string | null;
      taskOverrides?: Record<string, unknown>;
      taskStoreOverrides?: Record<string, unknown>;
      executionRecords?: Record<string, import('../../stores/useTaskStore').TaskCompletionRepositoryRecord>;
    } = {}
  ) => {
    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      selectedTaskId: 'task-1',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project One',
          isOpen: true,
          projects: [
            {
              id: 'project-1',
              name: 'Project One',
              mountName: 'project-one',
              path: '/tmp/repo-1',
              isReadOnly: false,
              created_at: '2026-04-08T00:00:00.000Z',
              status: 'active',
              metadata: {
                description: '',
                tags: [],
                team_members: [],
                api_contracts: [],
                dependencies: [],
              },
            },
          ],
        },
      ],
      getProjectById: () => ({
        id: 'project-1',
        name: 'Project One',
        mountName: 'project-one',
        path: '/tmp/repo-1',
        created_at: '2026-04-08T00:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      }),
    });

    useTaskStore.setState({
      ...useTaskStore.getState(),
      tasks: [
        {
          id: 'task-1',
          title: 'Review panel actions',
          status: 'InProgress',
          draft: false,
          project_id: 'project-1',
          assigned_branch: 'feature/review-actions',
          execution_targets: [],
          ...options.taskOverrides,
        } as never,
      ],
      branchWorktrees: {},
      finishTask: finishTaskMock,
      loadMergeWorkflowReview: mock(async () => null),
      ...options.taskStoreOverrides,
    });

    loadCurrentChangesMock = mock(async () => undefined);
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories: options.loadState && options.loadState !== 'ready' ? [] : [repository],
      reviewSummary: options.loadState && options.loadState !== 'ready'
        ? buildReviewTaskSummary([])
        : buildReviewTaskSummary([repository]),
      currentTaskLoadState: options.loadState ?? 'ready',
      currentTaskLoadMessage: options.loadMessage ?? null,
      isLoading: false,
      isCommitting: false,
      isDiffModalOpen: false,
      lastError: null,
      executionRecords: options.executionRecords ?? {},
      loadCurrentChanges: loadCurrentChangesMock,
      resetReviewState: mock(() => undefined),
      openDiffModal: openDiffModalMock,
      closeDiffModal: mock(() => undefined),
      stageChanges: stageChangesMock,
      unstageChanges: unstageChangesMock,
      stageAllChanges: stageAllChangesMock,
      stageAllTaskChanges: stageAllTaskChangesMock,
      revertChanges: revertChangesMock,
      commitStagedChanges: commitStagedChangesMock,
      commitAllReadyTaskRepositories: commitAllReadyTaskRepositoriesMock,
      setCommitMessageDraft: mock(() => undefined),
      getOverallStats: () => repository.stats,
    });
  };

  const seedActiveAssistantRuntime = () => {
    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: [
        {
          id: 'conversation-1',
          title: 'Task conversation',
          scope_mode: 'Implement',
          task_id: 'task-1',
          group_id: 'group-1',
          project_id: 'project-1',
          last_message: '',
          message_count: 1,
          updated_at: '2026-04-22T10:00:00.000Z',
          is_unread: false,
        },
      ],
      conversationRuntimeById: {
        'conversation-1': {
          phase: 'streaming',
          sessionId: 'session-1',
          assistantMessageId: 'message-1',
          abortController: null,
          lastError: null,
        },
      },
    });
  };

  const finishAssistantRuntime = () => {
    useChatStore.setState({
      ...useChatStore.getState(),
      conversationRuntimeById: {},
    });
  };

  const finishAssistantAndFlushPostAssistantRefresh = async () => {
    jest.useFakeTimers();
    try {
      await act(async () => {
        finishAssistantRuntime();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {
      await flushRender();
    });
  };

  const buildBlockedMergeWorkflowRuntime = (
    overrides: Partial<{
      blockingKind: 'repository_dirty' | 'merge_conflict' | 'merge_in_progress' | null;
      nextAction:
        | 'clean_repository'
        | 'resolve_conflicts'
        | 'finish_or_abort_merge'
        | 'complete_merge'
        | null;
      mergeInProgress: boolean;
      conflictFiles: string[];
      dirtyFiles: Array<{ path: string; status: string; area: 'staged' | 'unstaged' | 'untracked' }>;
      blockingReason: string | null;
      recommendedAction:
        | 'stash_dirty'
        | 'commit_staged_resolution'
        | 'assistant'
        | 'abort_merge'
        | 'complete_merge';
      availableActions: Array<
        'stash_dirty' |
        'commit_staged_resolution' |
        'revert_dirty' |
        'assistant' |
        'retry_check' |
        'abort_merge' |
        'complete_merge'
      >;
    }> = {}
  ) => {
    const dirtyRepository = {
      id: 'repo-1',
      projectId: 'project-1',
      repoPath: '/repos/project',
      sourceBranchName: 'feature/review-actions',
      targetBranchName: 'plan/review-actions',
      progressState: 'blocked',
      hadChangesAtStart: true,
      mergeAppliedAt: null,
      isClean: false,
      hasChanges: true,
      ahead: 1,
      behind: 0,
      mergeable: false,
      conflictFiles: [],
      dirtyFiles: [{ path: 'src/local.ts', status: 'modified', area: 'unstaged' }],
      mergeInProgress: false,
      diff: '',
      checkStatus: 'not_run',
      blockingKind: 'repository_dirty',
      nextAction: 'clean_repository',
      blockingReason: 'Cannot continue merge because /repos/project has uncommitted changes.',
      isSourcePublished: false,
      mergeStrategy: 'dirty',
      recommendedAction: 'stash_dirty',
      availableActions: ['stash_dirty', 'revert_dirty', 'assistant', 'retry_check'],
      ...overrides,
    };

    return {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Task 1',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [dirtyRepository],
      blockedRepositories: [dirtyRepository],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };
  };

  beforeEach(async () => {
    mock.restore();
    installFileChangesRuntimeMock();
    resizeObserverWidth = 640;
    globalThis.ResizeObserver = ResizeObserverTestMock as unknown as typeof ResizeObserver;
    notifySuccessMock = mock(() => undefined);
    notifyErrorMock = mock(() => undefined);
    notifyActionRequiredMock = mock(() => undefined);
    getArchitectPlanMock = mock(async () => null);
    listArtifactEntriesMock = mock(async () => []);
    validateArtifactMock = mock(async () => undefined);
    unvalidateArtifactMock = mock(async () => undefined);
    await loadFileChangesPanelModules();
    metadataModelConfigForTest = { mode: 'conversation' };
    metadataModelConfigListeners.clear();
    const resourcePressureBackoff = await import('../../services/resourcePressureBackoff');
    resourcePressureBackoff.__testables.reset();
    stageChangesMock = mock(async () => undefined);
    unstageChangesMock = mock(async () => undefined);
    stageAllChangesMock = mock(async () => undefined);
    stageAllTaskChangesMock = mock(async () => undefined);
    revertChangesMock = mock(async () => undefined);
    openDiffModalMock = mock(() => undefined);
    loadCurrentChangesMock = mock(async () => undefined);
    finishTaskMock = mock(async () => undefined);
    commitStagedChangesMock = mock(async () => ({
      hash: 'abc123',
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      committedRepositoryId: 'repo-1',
      repositories: [],
    }));
    commitAllReadyTaskRepositoriesMock = mock(async () => ({
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      commits: [
        {
          hash: 'abc123',
          taskId: 'task-1',
          taskCompleted: false,
          taskStatus: 'InProgress',
          committedRepositoryId: 'repo-1',
          repositories: [],
        },
      ],
      repositories: [],
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await clearPreferencesForTest();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    root = null;
    container = null;
    if (initialAppState) {
      useAppStore.setState(initialAppState, true);
    }
    if (initialTaskState) {
      useTaskStore.setState(initialTaskState, true);
    }
    if (initialChatState) {
      useChatStore.setState(initialChatState, true);
    }
    if (initialProviderState) {
      useProviderStore.setState(initialProviderState, true);
    }
    if (initialFileChangesState) {
      useFileChangesStore.setState(initialFileChangesState, true);
    }
    if (hadInitialBackendTransport) {
      process.env.VITE_BACKEND_TRANSPORT = initialBackendTransport;
    } else {
      delete process.env.VITE_BACKEND_TRANSPORT;
    }
    await clearPreferencesForTest();
    mock.restore();
  });

  it('renders validate and revert actions for pending scopes', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const validateButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Validate');
    const revertButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Revert');

    expect(validateButtons.length).toBeGreaterThan(0);
    expect(validateButtons.every((button) => button.disabled)).toBe(true);
    expect(revertButtons.length).toBeGreaterThan(0);
    expect(document.body.querySelectorAll('[data-pending-validation-indicator="true"]').length).toBeGreaterThan(0);
    document.body.querySelectorAll('[data-pending-validation-indicator="true"]').forEach((indicator) => {
      expect(indicator.className).toContain('group-hover:opacity-0');
      expect(indicator.className).not.toContain('group-focus-within:opacity-0');
    });
    document.body.querySelectorAll('[data-file-change-metadata="true"]').forEach((metadata) => {
      expect(metadata.className).toContain('group-hover:opacity-0');
      expect(metadata.className).not.toContain('group-focus-within:opacity-0');
    });
    document.body.querySelectorAll('[data-scope-action-rail="true"]').forEach((rail) => {
      expect(rail.className).toContain('group-hover:opacity-100');
      expect(rail.className).toContain('group-hover:pointer-events-auto');
      expect(rail.className).not.toContain('group-focus-within:opacity-100');
      expect(rail.className).toContain('bg-gradient-to-l');
      expect(rail.className).not.toContain('bg-transparent');
    });
    expect(document.body.textContent).not.toContain('{{pending}}');
    expect(document.body.textContent).not.toContain('{{validated}}');

    await reviewAllPendingFileDiffs();
    const enabledValidateButtons = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.getAttribute('aria-label') === 'Validate' && !button.disabled);
    expect(enabledValidateButtons.length).toBeGreaterThan(0);

    await act(async () => {
      validateButtons[0]?.click();
      await flushRender();
    });

    expect(stageChangesMock).toHaveBeenCalled();
    expect(stageChangesMock.mock.calls[0]?.[0]).toBe('repo-1');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('renders task artifacts as a changes project with produced and inherited badges', async () => {
    const plan = buildArtifactPlan();
    const entries = buildArtifactEntries();
    getArchitectPlanMock = mock(async () => plan);
    listArtifactEntriesMock = mock(async () => entries);
    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_storage_branch: 'feature/artifacts',
        plan_target_branch: 'feature/artifacts',
        dependencies: ['audit'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const artifactSection = document.body.querySelector('[data-artifacts-review-section="true"]');
    expect(artifactSection).not.toBeNull();
    expect(document.body.textContent).toContain('Artifacts');
    await act(async () => {
      (artifactSection?.querySelector('button') as HTMLButtonElement | null)?.click();
      await flushRender();
    });
    expect(document.body.textContent).toContain('API contract');
    expect(document.body.textContent).toContain('Audit findings');
    expect(document.body.textContent).toContain('Produced');
    expect(document.body.textContent).toContain('Inherited');
    expect(document.body.textContent).toContain('Validated');
  });

  it('keeps application repository folders visible when artifacts are present', async () => {
    const plan = buildArtifactPlan();
    const entries = buildArtifactEntries();
    getArchitectPlanMock = mock(async () => plan);
    listArtifactEntriesMock = mock(async () => entries);
    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_storage_branch: 'feature/artifacts',
        plan_target_branch: 'feature/artifacts',
        dependencies: ['audit'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const sections = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-review-repository-section="true"]')
    );
    const repositorySection = sections.find(
      (section) => !section.hasAttribute('data-artifacts-review-section')
    );
    const artifactSection = sections.find((section) =>
      section.hasAttribute('data-artifacts-review-section')
    );

    expect(repositorySection?.getAttribute('data-review-repository-expanded')).toBe('true');
    expect(repositorySection?.textContent).toContain('src');
    expect(repositorySection?.textContent).toContain('main.ts');
    expect(artifactSection?.getAttribute('data-review-repository-expanded')).toBe('false');
    expect(document.body.textContent).toContain('Artifacts');
  });

  it('shows expected artifact contracts as a compact empty-state count', async () => {
    const plan = buildArtifactPlan();
    getArchitectPlanMock = mock(async () => plan);
    listArtifactEntriesMock = mock(async () => []);
    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_storage_branch: 'feature/artifacts',
        plan_target_branch: 'feature/artifacts',
        dependencies: ['audit'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const artifactSection = document.body.querySelector('[data-artifacts-review-section="true"]');
    await act(async () => {
      (artifactSection?.querySelector('button') as HTMLButtonElement | null)?.click();
      await flushRender();
    });

    expect(artifactSection?.textContent).toContain('1 expected');
    expect(artifactSection?.textContent).not.toContain('Expected by this task: API contract');
    expect(artifactSection?.textContent).not.toContain('Expected artifacts');
    expect(artifactSection?.textContent).not.toContain('required');
    expect(artifactSection?.textContent).toContain('No produced artifacts yet.');
  });

  it('opens an artifact diff modal and validates pending artifacts from the global action', async () => {
    const plan = buildArtifactPlan();
    const entries = buildArtifactEntries();
    getArchitectPlanMock = mock(async () => plan);
    listArtifactEntriesMock = mock(async () => entries);
    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_storage_branch: 'feature/artifacts',
        plan_target_branch: 'feature/artifacts',
        dependencies: ['audit'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const artifactSection = document.body.querySelector('[data-artifacts-review-section="true"]');
    await act(async () => {
      (artifactSection?.querySelector('button') as HTMLButtonElement | null)?.click();
      await flushRender();
    });

    const artifactButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('API contract')) as HTMLButtonElement | undefined;
    await act(async () => {
      artifactButton?.click();
      await flushRender();
    });

    expect(document.body.querySelector('[data-artifact-diff-modal="true"]')?.getAttribute('data-artifact-id')).toBe('api-contract');

    await reviewAllPendingFileDiffs();

    const validateButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Validate changes')) as HTMLButtonElement | undefined;
    await act(async () => {
      validateButton?.click();
      await flushRender();
    });

    expect(stageAllTaskChangesMock).toHaveBeenCalled();
    expect(validateArtifactMock).toHaveBeenCalled();
    expect(validateArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      artifactId: 'api-contract',
    });
  });

  it('reloads artifacts and selects the saved artifact version after modal saves', async () => {
    const plan = buildArtifactPlan();
    let entries = buildArtifactEntries();
    const savedEntry: VisiblePlanTaskArtifactReviewEntry = {
      artifact: {
        ...entries[1]!.artifact,
        id: 'audit-findings-task-1',
        taskId: 'task-1',
        title: 'Audit findings',
        contentHash: 'saved',
        supersedes: 'audit-findings',
        visibility: 'own',
      },
      review: null,
      hasValidatedReview: false,
      hasPendingReview: true,
    };
    getArchitectPlanMock = mock(async () => plan);
    listArtifactEntriesMock = mock(async () => entries);
    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_storage_branch: 'feature/artifacts',
        plan_target_branch: 'feature/artifacts',
        dependencies: ['audit'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const artifactSection = document.body.querySelector('[data-artifacts-review-section="true"]');
    await act(async () => {
      (artifactSection?.querySelector('button') as HTMLButtonElement | null)?.click();
      await flushRender();
    });
    const artifactButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Audit findings')) as HTMLButtonElement | undefined;
    await act(async () => {
      artifactButton?.click();
      await flushRender();
    });
    expect(document.body.querySelector('[data-artifact-diff-modal="true"]')?.getAttribute('data-artifact-id')).toBe('audit-findings');

    entries = [...entries, savedEntry];
    const mockSaveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Mock artifact saved')) as HTMLButtonElement | undefined;
    await act(async () => {
      mockSaveButton?.click();
      await flushRender();
    });

    expect(listArtifactEntriesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(document.body.querySelector('[data-artifact-diff-modal="true"]')?.getAttribute('data-artifact-id')).toBe('audit-findings-task-1');
  });

  it('toggles a repository section without creating a selected repository state', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const section = document.body.querySelector(
      '[data-review-repository-section="true"]'
    ) as HTMLElement | null;
    const headerButton = section?.querySelector('button') as HTMLButtonElement | null;
    expect(section?.getAttribute('data-review-repository-expanded')).toBe('true');
    expect('selectedRepositoryId' in useFileChangesStore.getState()).toBe(false);

    await act(async () => {
      headerButton?.click();
      await flushRender();
    });

    const collapsedSection = document.body.querySelector(
      '[data-review-repository-section="true"]'
    ) as HTMLElement | null;
    expect(collapsedSection?.getAttribute('data-review-repository-expanded')).toBe('false');
    expect('selectedRepositoryId' in useFileChangesStore.getState()).toBe(false);
  });

  it('opens a file diff with the repository id without selecting the repository', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const mainFileButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('main.ts'));
    expect(mainFileButton).toBeDefined();

    await act(async () => {
      mainFileButton?.click();
      await flushRender();
    });

    expect(openDiffModalMock).toHaveBeenCalledWith('repo-1', 'change-1');
    expect('selectedRepositoryId' in useFileChangesStore.getState()).toBe(false);
  });

  it('reverts a section with the explicit repository id', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const revertButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Revert');
    expect(revertButton).toBeDefined();

    await act(async () => {
      revertButton?.click();
      await flushRender();
    });

    const confirmButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Revert' && button.getAttribute('aria-label') !== 'Revert');
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton?.click();
      await flushRender();
    });

    expect(revertChangesMock).toHaveBeenCalled();
    expect(revertChangesMock.mock.calls[0]?.[0]).toBe('repo-1');
    expect('selectedRepositoryId' in useFileChangesStore.getState()).toBe(false);
  });

  it('caps expanded multi-repository sections instead of giving each one forced flex height', async () => {
    const activeRepository = buildRepository(false);
    const emptyRepository: ReviewRepositoryState = {
      ...buildRepository(false),
      id: 'repo-2',
      projectId: 'project-2',
      repoPath: '/tmp/repo-2',
      worktreePath: '/tmp/worktree-2',
      changes: [],
      stagedPaths: [],
      selectedChangeId: null,
      stats: {
        pendingVisibleFileCount: 0,
        validatedStagedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      commitState: 'no_changes',
    };
    const thirdRepository: ReviewRepositoryState = {
      ...buildRepository(false),
      id: 'repo-3',
      projectId: 'project-3',
      repoPath: '/tmp/repo-3',
      worktreePath: '/tmp/worktree-3',
      branchName: 'feature/review-actions',
    };
    const repositories = [activeRepository, emptyRepository, thirdRepository];

    seedStores(activeRepository);
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories,
      reviewSummary: buildReviewTaskSummary(repositories),
      getOverallStats: () => ({
        pendingVisibleFileCount: 4,
        validatedStagedFileCount: 0,
        additions: 14,
        deletions: 2,
      }),
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const expandedSection = document.body.querySelector(
      '[data-review-repository-section="true"][data-review-repository-expanded="true"]'
    ) as HTMLElement | null;
    expect(expandedSection).not.toBeNull();
    expect(expandedSection?.style.maxHeight).toBe('240px');
    expect(expandedSection?.className).not.toContain('flex-1');
    expect(expandedSection?.className).not.toContain('basis-0');
    expect(expandedSection?.className).toContain('overflow-hidden');
    expect(expandedSection?.firstElementChild?.className).not.toContain('bg-primary/5');
    expect(expandedSection?.firstElementChild?.className).toContain('bg-accent/25');
    expect('selectedRepositoryId' in useFileChangesStore.getState()).toBe(false);

    const scrollRegion = expandedSection?.querySelector(
      '[data-review-repository-scroll-region="true"]'
    ) as HTMLElement | null;
    expect(scrollRegion?.className).toContain('overflow-y-auto');
  });

  it('hides scope actions once only staged changes remain', async () => {
    const repository = buildRepository(true);
    repository.changes = repository.changes.map((change) => ({
      ...change,
      indexContent: change.modifiedContent,
      hasPendingVisibleChange: false,
      hasValidatedStage: true,
    }));
    repository.stagedPaths = ['src/main.ts', 'src/nested/child.ts'];
    repository.selectedChangeId = 'change-1';
    repository.stats = {
      pendingVisibleFileCount: 0,
      validatedStagedFileCount: 2,
      additions: 0,
      deletions: 0,
    };
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const validateButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Validate');
    const revertButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Revert');
    const unstageButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Unstage');

    expect(validateButtons).toHaveLength(0);
    expect(revertButtons).toHaveLength(0);
    expect(unstageButtons.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('main.ts');
    expect(document.body.textContent).toContain('child.ts');
    document.body.querySelectorAll('[data-file-change-metadata="true"]').forEach((metadata) => {
      expect(metadata.className).toContain('group-hover:opacity-0');
      expect(metadata.className).not.toContain('group-focus-within:opacity-0');
    });
    document.body.querySelectorAll('[data-repository-change-status="true"]').forEach((status) => {
      expect(status.className).toContain('group-hover:opacity-0');
      expect(status.className).not.toContain('group-focus-within:opacity-0');
    });
    expect(document.body.querySelectorAll('[data-pending-validation-indicator="true"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('validated file(s) staged and ready to commit');
    expect(document.body.textContent).not.toContain('All visible changes are already validated');

    await act(async () => {
      unstageButtons[0]?.click();
      await flushRender();
    });

    expect(unstageChangesMock).toHaveBeenCalled();
    expect(unstageChangesMock.mock.calls[0]?.[0]).toBe('repo-1');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('validates the current diff state without moving the task into a review status', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const validateButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Validate changes');
    expect(validateButton).toBeDefined();
    expect(validateButton?.disabled).toBe(true);
    await reviewAllPendingFileDiffs();
    expect(validateButton?.disabled).toBe(false);
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      validateButton?.click();
      await flushRender();
    });

    expect(stageAllTaskChangesMock).toHaveBeenCalledTimes(1);
    expect(stageAllChangesMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0]?.status).toBe('InProgress');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('keeps Commit as the primary action while a repository is ready to commit', async () => {
    const repository = buildRepository(true);
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttonTexts = Array.from(document.body.querySelectorAll('button'))
      .map((button) => button.textContent?.trim())
      .filter((value): value is string => Boolean(value));

    expect(buttonTexts).toContain('Commit');
    expect(buttonTexts).not.toContain('Finish task');

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(commitStagedChangesMock).not.toHaveBeenCalled();
  });

  it('asks for the metadata model choice the first time a commit is generated', async () => {
    await clearPreferencesForTest();
    metadataModelConfigForTest = null;
    const repository = buildRepository(true);
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Choose metadata generation model');
    expect(document.body.textContent).toContain('Conversation model');
    expect(commitAllReadyTaskRepositoriesMock).not.toHaveBeenCalled();

    const continueButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Continue');
    expect(continueButton).toBeDefined();

    await act(async () => {
      continueButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(readMetadataModelConfigForTest()).toEqual({
      mode: 'conversation',
    });
  });

  it('shows the backend commit error message when the commit rejects with an object payload', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      throw { message: 'Backend exploded' };
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(notifyErrorMock).toHaveBeenCalledWith('Backend exploded');
    expect(notifyErrorMock).not.toHaveBeenCalledWith('[object Object]');
  });

  it('shows a retry modal when commit message generation fails', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('model unavailable');
      error.name = 'SmartCommitMessageGenerationError';
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Couldn’t generate commit messages');
    expect(document.body.textContent).toContain('Retry generation');
    expect(document.body.textContent).toContain('Write manually');
    expect(document.body.textContent).toContain('Metadata model settings');
    expect(document.body.textContent).toContain('Cancel');
    expect(notifyErrorMock).not.toHaveBeenCalled();

    const retryButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry generation'));
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(2);
  });

  it('opens manual commit message editing after commit message generation fails', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('missing API key');
      error.name = 'SmartCommitMessageGenerationError';
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    const writeManuallyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Write manually'));
    expect(writeManuallyButton).toBeDefined();

    await act(async () => {
      writeManuallyButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Write commit messages');
    expect(document.body.textContent).toContain('Write a Conventional Commit message for each repository, then commit.');

    const subjectInput = Array.from(document.body.querySelectorAll('input'))
      .find((input) => input.value === 'review actions');
    expect(subjectInput).toBeDefined();

    commitAllReadyTaskRepositoriesMock.mockImplementationOnce(async () => ({
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      commits: [],
      repositories: [],
    }));

    const manualCommitButton = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Commit')
      .at(-1);

    await act(async () => {
      manualCommitButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenLastCalledWith({
      messagesByRepositoryId: {
        'repo-1': 'feat: review actions',
      },
    });
  });

  it('opens the commit model settings from the generation failure modal', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('model unavailable');
      error.name = 'SmartCommitMessageGenerationError';
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    const settingsButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Metadata model settings'));
    expect(settingsButton).toBeDefined();

    await act(async () => {
      settingsButton?.click();
      await flushRender();
    });

    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().activeSettingsTab).toBe('models');
    expect(document.body.textContent).not.toContain('Couldn’t generate commit messages');
  });

  it('uses the latest saved metadata model config when retrying after generation fails', async () => {
    const repository = buildRepository(true);
    metadataModelConfigForTest = {
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: null,
    };
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('model unavailable');
      error.name = 'SmartCommitMessageGenerationError';
      throw error;
    });
    seedStores(repository);
    useProviderStore.setState({
      ...useProviderStore.getState(),
      providerConfigs: [
        {
          id: 'provider-a',
          name: 'Provider A',
          providerType: 'openai',
          baseUrl: 'https://a.example.test/v1',
          hasStoredApiKey: true,
          isEnabled: true,
          isLocal: false,
        },
        {
          id: 'provider-b',
          name: 'Provider B',
          providerType: 'openai',
          baseUrl: 'https://b.example.test/v1',
          hasStoredApiKey: true,
          isEnabled: true,
          isLocal: false,
        },
      ],
      modelsByProvider: {
        'provider-a': [{ id: 'model-a', name: 'Model A', provider_id: 'provider-a', isEnabled: true }],
        'provider-b': [{ id: 'model-b', name: 'Model B', provider_id: 'provider-b', isEnabled: true }],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    await act(async () => {
      metadataModelConfigForTest = {
        mode: 'dedicated',
        providerId: 'provider-b',
        modelId: 'model-b',
        reasoningEffort: null,
      };
      metadataModelConfigListeners.forEach((listener) => listener(metadataModelConfigForTest));
      await flushRender();
    });

    commitAllReadyTaskRepositoriesMock.mockImplementationOnce(async () => ({
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      commits: [],
      repositories: [],
    }));

    const retryButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry generation'));

    await act(async () => {
      retryButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenLastCalledWith({
      modelConfig: {
        mode: 'dedicated',
        providerId: 'provider-b',
        modelId: 'model-b',
        reasoningEffort: null,
      },
    });
  });

  it('shows structured commit message editing when generated fields are invalid', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('Commit type must be one of: feat, fix, perf, build, chore, ci, docs, refactor, style, test, revert');
      error.name = 'SmartCommitMessageGenerationError';
      Object.assign(error, {
        generatedMessages: {
          repositories: [
            {
              repositoryId: repository.id,
              type: 'release',
              scope: 'project-one',
              subject: 'update generated messages',
              body: null,
            },
          ],
        },
      });
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Review commit messages');
    expect(document.body.textContent).toContain('Type');
    expect(document.body.textContent).toContain('Subject');
    expect(document.body.textContent).toContain('Body');
    expect(document.body.textContent).toContain('Commit type must be one of');
    const modalCommitButton = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Commit')
      .at(-1) as HTMLButtonElement | undefined;
    expect(modalCommitButton?.disabled).toBe(true);
  });

  it('switches the primary action to Finish task once the task is fully resolved', async () => {
    const repository: ReviewRepositoryState = {
      ...buildRepository(true),
      id: 'project-1::repo-1',
      changes: [],
      selectedChangeId: null,
      stats: {
        pendingVisibleFileCount: 0,
        validatedStagedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      stagedPaths: [],
      commitState: 'committed',
    };
    seedStores(repository, {
      taskOverrides: {
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            worktreeKey: 'repo-1',
          },
        ],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const buttonTexts = buttons
      .map((button) => button.textContent?.trim())
      .filter((value): value is string => Boolean(value));

    expect(buttonTexts).toContain('Finish task');
    expect(buttonTexts).not.toContain('Commit');

    const finishButton = buttons.find((button) => button.textContent?.trim() === 'Finish task');
    expect(finishButton).toBeDefined();

    await act(async () => {
      finishButton?.click();
      await flushRender();
    });

    expect(finishTaskMock).toHaveBeenCalledWith('task-1');
    expect(commitStagedChangesMock).not.toHaveBeenCalled();
    expect(commitAllReadyTaskRepositoriesMock).not.toHaveBeenCalled();
  });

  it('finishes a Direct Git task without creating a merge review runtime', async () => {
    const repository: ReviewRepositoryState = {
      ...buildRepository(true),
      id: 'project-1::repository-root',
      executionMode: 'git',
      executionKind: 'repository_root',
      changes: [],
      selectedChangeId: null,
      stats: {
        pendingVisibleFileCount: 0,
        validatedStagedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      stagedPaths: [],
      commitState: 'committed',
    };
    const loadMergeWorkflowReviewMock = mock(async () => null);
    seedStores(repository, {
      taskOverrides: {
        task_kind: 'direct',
        execution_targets: [{
          projectId: 'project-1',
          branchName: 'develop',
          targetBranchName: 'develop',
          executionMode: 'git',
          executionKind: 'repository_root',
          worktreeKey: 'repository-root',
        }],
      },
      taskStoreOverrides: {
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    const finishButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Finish task');
    await act(async () => {
      finishButton?.click();
      await flushRender();
    });

    expect(loadMergeWorkflowReviewMock).not.toHaveBeenCalled();
    expect(finishTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('protects Finish task from double clicks while the merge is in flight', async () => {
    const repository: ReviewRepositoryState = {
      ...buildRepository(true),
      id: 'project-1::repo-1',
      changes: [],
      selectedChangeId: null,
      stats: {
        pendingVisibleFileCount: 0,
        validatedStagedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      stagedPaths: [],
      commitState: 'committed',
    };
    seedStores(repository, {
      taskOverrides: {
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            worktreeKey: 'repo-1',
          },
        ],
      },
    });

    let resolveFinishTask: (() => void) | null = null;
    finishTaskMock.mockImplementation(() => new Promise<void>((resolve) => {
      resolveFinishTask = resolve;
    }));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const finishButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Finish task') as HTMLButtonElement | undefined;
    expect(finishButton).toBeDefined();

    act(() => {
      finishButton?.click();
      finishButton?.click();
    });
    await flushRender();

    expect(finishTaskMock).toHaveBeenCalledTimes(1);
    expect(finishButton?.disabled).toBe(true);

    await act(async () => {
      resolveFinishTask?.();
      await flushRender();
    });
  });

  it('renders the dedicated plan finalization panel instead of loading file changes', async () => {
    const repository = buildRepository(false);
    const planFinalizationRuntime = {
      taskId: 'task-1',
      kind: 'plan_finalization',
      phase: 'ready',
      taskStatus: 'Pending',
      review: {
        taskId: 'task-1',
        title: 'Finalize plan: Checkout refresh',
        taskSource: 'plan_finalization',
        planId: 'plan-1',
        planTitle: 'Checkout refresh',
        targetBranch: 'develop',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'plan/checkout-refresh',
          targetBranchName: 'develop',
          isClean: true,
          hasChanges: true,
          mergeable: true,
          conflictFiles: [],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'passed',
          blockingKind: null,
          nextAction: null,
          blockingReason: null,
        },
      ],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };
    const loadPlanFinalizationReviewMock = mock(async () => planFinalizationRuntime);
    seedStores(repository, {
      taskOverrides: {
        title: 'Finalize plan: Checkout refresh',
        description: 'Merge the plan branch into the configured development branches or archive the plan.',
        task_source: 'plan_finalization',
        plan_id: 'plan-1',
        assigned_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'develop',
            targetBranchName: 'develop',
            executionKind: 'repository_root',
            worktreeKey: 'plan-finalization:project-1:project-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? planFinalizationRuntime : null,
        loadMergeWorkflowReview: loadPlanFinalizationReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        archivePlanFromTask: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-plan-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Plan finalization');
    expect(document.body.textContent).toContain('Merge plan');
    expect(document.body.textContent).toContain('Archive');
    expect(loadPlanFinalizationReviewMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('renders the merge workflow panel for a normal task with merge blockers', async () => {
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Merge workflow');
    expect(document.body.querySelector('[data-merge-workflow-layout="wide"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-sidebar="true"]')).toBeNull();
    expect(document.body.querySelector('[data-merge-repository-rail="true"]')).toBeNull();
    expect(document.body.textContent).toContain('File conflicts');
    expect(document.body.textContent).toContain('Conflicting files');
    expect(document.body.textContent).toContain('Resolve manually');
    expect(document.body.textContent).toContain('Resolve with AI');
    expect(document.body.textContent).not.toContain('View diff');
    expect(document.body.querySelector('[data-merge-incident-kind="file_conflict"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Resolve the repository blockers before retrying the merge.');
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Resolve these conflicts before finishing',
      expect.objectContaining({
        category: 'task_attention_required',
        notificationKey: expect.stringContaining('merge-workflow-blocker:task-1:repo-1'),
      })
    );
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('does not reload the merge review again while it is already loading', async () => {
    const loadMergeWorkflowReviewMock = mock(async () => null);
    const loadingRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'loading_review',
      taskStatus: 'InProgress',
      review: null,
      repositories: [],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: null,
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? loadingRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Loading merge review...');
    expect(loadMergeWorkflowReviewMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('asks before stashing dirty merge blockers automatically', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      conflictFiles: ['src/local-conflict.ts'],
    });

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local changes');
    expect(document.body.textContent).toContain('Target branch has local changes');
    expect(document.body.textContent).toContain('1 local change(s) detected in the target checkout.');
    expect(document.body.textContent).not.toContain('Has conflicts');
    expect(document.body.textContent).not.toContain('View diff');
    expect(document.body.textContent).not.toContain('Resolve manually');
    expect(document.body.textContent).not.toContain('src/local.ts');
    expect(document.body.textContent).not.toContain('src/local-conflict.ts');
    expect(document.body.querySelector('[data-merge-incident-kind="dirty"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-dirty-state-summary="true"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-affected-files="true"]')).toBeNull();

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local changes need attention');
    expect(resolveMergeWorkflowAutomaticallyMock).not.toHaveBeenCalled();

    const stashButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Stash and retry'));

    await act(async () => {
      stashButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'stash_dirty',
    });
  });

  it('offers a staged-resolution continuation for assistant-staged dirty blockers', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      dirtyFiles: [
        { path: 'lib/l10n/app_localizations.dart', status: 'modified', area: 'staged' },
        { path: 'lib/l10n/app_ar.arb', status: 'added', area: 'staged' },
        { path: 'lib/l10n/app_localizations_ar.dart', status: 'added', area: 'staged' },
      ],
      blockingReason: 'Cannot continue merge because /repos/project has staged changes.',
      recommendedAction: 'commit_staged_resolution',
      availableActions: [
        'commit_staged_resolution',
        'revert_dirty',
        'assistant',
        'retry_check',
      ],
    });

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Staged changes');
    expect(document.body.textContent).toContain('Staged resolution is waiting');
    expect(document.body.textContent).not.toContain('Target branch has local changes');

    const continueButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Continue'));

    await act(async () => {
      continueButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Staged changes ready');

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Commit staged and continue'));

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'commit_staged_resolution',
    });
    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1', {
      allowWithoutCodeChanges: true,
    });
  });

  it('merges ready fast-forwardable repositories without asking for a strategy', async () => {
    let resolveRunMergeWorkflow: (() => void) | null = null;
    const runMergeWorkflowMock = mock(() => new Promise<void>((resolve) => {
      resolveRunMergeWorkflow = resolve;
    }));
    const mergeWorkflowRuntime = {
      ...buildBlockedMergeWorkflowRuntime(),
      phase: 'ready',
      taskStatus: 'InProgress',
      blockedRepositories: [],
      message: null,
    };
    mergeWorkflowRuntime.repositories = [
      {
        ...mergeWorkflowRuntime.repositories[0],
        progressState: 'pending',
        isClean: true,
        mergeable: true,
        blockingKind: null,
        nextAction: null,
        blockingReason: null,
        dirtyFiles: [],
        mergeStrategy: 'fast_forward_available',
        recommendedAction: 'fast_forward',
        availableActions: ['fast_forward', 'merge_commit'],
      },
    ];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 0,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const mergeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Merge task'));

    await act(async () => {
      mergeButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Fast-forward available');
    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1');
    expect(runMergeWorkflowMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRunMergeWorkflow?.();
      await flushRender();
    });

    const remainingMergeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Merge task'));
    expect(remainingMergeButton?.disabled).toBe(false);
  });

  it('opens the assistant when a rebase strategy fails', async () => {
    const runMergeWorkflowMock = mock(async () => {
      throw new Error('rebase conflict');
    });
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: 'conversation-1',
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 1,
    }));
    const mergeWorkflowRuntime = {
      ...buildBlockedMergeWorkflowRuntime(),
      phase: 'ready',
      taskStatus: 'InProgress',
      blockedRepositories: [],
      message: null,
    };
    mergeWorkflowRuntime.repositories = [
      {
        ...mergeWorkflowRuntime.repositories[0],
        progressState: 'pending',
        isClean: true,
        mergeable: true,
        blockingKind: null,
        nextAction: null,
        blockingReason: null,
        dirtyFiles: [],
        mergeStrategy: 'rebase_available',
        recommendedAction: 'rebase_then_continue',
        availableActions: ['rebase_then_continue', 'merge_commit', 'assistant'],
        isSourcePublished: false,
      },
    ];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const chooseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Choose merge strategy'));

    await act(async () => {
      chooseButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Rebase available');

    const rebaseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Rebase then continue'));

    await act(async () => {
      rebaseButton?.click();
      await flushRender();
    });

    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1', {
      mergeStrategyAction: 'rebase_then_continue',
    });
    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'assistant',
    });
    const remainingRebaseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Rebase then continue'));
    expect(remainingRebaseButton).toBeUndefined();
  });

  it('offers revert for dirty merge blockers', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    const revertButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Revert and retry'));

    await act(async () => {
      revertButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'revert_dirty',
    });
  });

  it('renders multiple merge blockers as separate incident cards', async () => {
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();
    const secondRepository = {
      ...mergeWorkflowRuntime.repositories[0],
      id: 'repo-2',
      projectId: 'project-2',
      repoPath: '/repos/project-two',
      dirtyFiles: [{ path: 'src/other.ts', status: 'modified', area: 'unstaged' }],
      blockingReason: 'Cannot continue merge because /repos/project-two has uncommitted changes.',
    };
    mergeWorkflowRuntime.repositories = [
      mergeWorkflowRuntime.repositories[0],
      secondRepository,
    ];
    mergeWorkflowRuntime.blockedRepositories = mergeWorkflowRuntime.repositories;

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 2,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const text = document.body.textContent || '';
    expect(text.match(/Target branch has local changes/g)?.length).toBe(2);
    expect(text).toContain('project');
    expect(text).toContain('project-two');
    expect(text).not.toContain('src/local.ts');
    expect(text).not.toContain('src/other.ts');
    expect(text).toContain('2 repositories need attention.');
    expect(document.body.querySelector('[data-merge-repository-sidebar="true"]')).toBeNull();
    expect(document.body.querySelector('[data-merge-repository-rail="true"]')).toBeNull();
  });

  it('opens a repository-scoped manual conflict resolver', async () => {
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/first.ts'],
      blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/first.ts.',
    });
    const repository = {
      ...mergeWorkflowRuntime.repositories[0],
      isClean: true,
      dirtyFiles: [],
      diff: [
        'diff --git a/src/first.ts b/src/first.ts',
        'index 111..222 100644',
        '--- a/src/first.ts',
        '+++ b/src/first.ts',
        '@@ -1 +1 @@',
        '-first old',
        '+first new',
        'diff --git a/src/second.ts b/src/second.ts',
        'index 333..444 100644',
        '--- a/src/second.ts',
        '+++ b/src/second.ts',
        '@@ -1 +1 @@',
        '-second old',
        '+second new',
      ].join('\n'),
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };
    mergeWorkflowRuntime.repositories = [repository];
    mergeWorkflowRuntime.blockedRepositories = [repository];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveManuallyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve manually'));

    await act(async () => {
      resolveManuallyButton?.click();
      await flushRender();
    });

    const modal = document.body.querySelector('[data-merge-conflict-resolver-modal="true"]');

    expect(modal?.getAttribute('data-repository-id')).toBe('repo-1');
    expect(modal?.textContent).toContain('src/first.ts');
  });

  it('keeps manual conflict resolver files scoped to the clicked repository', async () => {
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/first-only.ts'],
      blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/first-only.ts.',
    });
    const firstRepository = {
      ...mergeWorkflowRuntime.repositories[0],
      isClean: true,
      dirtyFiles: [],
      diff: [
        'diff --git a/src/first-only.ts b/src/first-only.ts',
        '--- a/src/first-only.ts',
        '+++ b/src/first-only.ts',
        '@@ -1 +1 @@',
        '-first',
        '+FIRST',
      ].join('\n'),
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };
    const secondRepository = {
      ...firstRepository,
      id: 'repo-2',
      projectId: 'project-2',
      repoPath: '/repos/project-two',
      conflictFiles: ['src/second-only.ts'],
      diff: [
        'diff --git a/src/second-only.ts b/src/second-only.ts',
        '--- a/src/second-only.ts',
        '+++ b/src/second-only.ts',
        '@@ -1 +1 @@',
        '-second',
        '+SECOND',
      ].join('\n'),
      blockingReason: 'Cannot continue merge because /repos/project-two would conflict in: src/second-only.ts.',
    };
    mergeWorkflowRuntime.repositories = [firstRepository, secondRepository];
    mergeWorkflowRuntime.blockedRepositories = mergeWorkflowRuntime.repositories;

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveManuallyButtons = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.includes('Resolve manually'));

    await act(async () => {
      resolveManuallyButtons[1]?.click();
      await flushRender();
    });

    const modal = document.body.querySelector('[data-merge-conflict-resolver-modal="true"]');

    expect(modal?.getAttribute('data-repository-id')).toBe('repo-2');
    expect(modal?.textContent).toContain('second-only.ts');
    expect(modal?.textContent).not.toContain('first-only.ts');
  });

  it('blocks manual conflict resolution only while the scoped AI assistant is active', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: 'conversation-1',
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 1,
    }));
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/conflict.ts'],
      blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/conflict.ts.',
    });
    const repository = {
      ...mergeWorkflowRuntime.repositories[0],
      isClean: true,
      dirtyFiles: [],
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };
    mergeWorkflowRuntime.repositories = [repository];
    mergeWorkflowRuntime.blockedRepositories = [repository];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });
    seedActiveAssistantRuntime();

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveWithAiButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve with AI'));

    await act(async () => {
      resolveWithAiButton?.click();
      await flushRender();
    });

    const resolvingButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('AI resolving'));

    expect(resolvingButton).toBeDefined();
    expect(resolvingButton?.disabled).toBe(true);

    await act(async () => {
      finishAssistantRuntime();
      await flushRender();
    });

    const manualButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve manually'));

    expect(manualButton).toBeDefined();
    expect(manualButton?.disabled).toBe(false);
  });

  it('refreshes the merge review when closing the manual conflict resolver', async () => {
    const loadMergeWorkflowReviewMock = mock(async () => null);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/conflict.ts'],
      blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/conflict.ts.',
    });
    const repository = {
      ...mergeWorkflowRuntime.repositories[0],
      isClean: true,
      dirtyFiles: [],
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };
    mergeWorkflowRuntime.repositories = [repository];
    mergeWorkflowRuntime.blockedRepositories = [repository];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => null),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveManuallyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve manually'));

    await act(async () => {
      resolveManuallyButton?.click();
      await flushRender();
    });

    const closeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Close resolver'));

    await act(async () => {
      closeButton?.click();
      await flushRender();
    });

    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledWith('task-1', { force: true });
    expect(document.body.querySelector('[data-merge-conflict-resolver-modal="true"]')).toBeNull();
  });

  it('asks before stashing dirty merge blockers from retry merge and then retries', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local changes need attention');
    expect(resolveMergeWorkflowAutomaticallyMock).not.toHaveBeenCalled();
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();

    const stashButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Stash and retry'));

    await act(async () => {
      stashButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'stash_dirty',
    });
    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1');
  });

  it('shows a resolved in-progress merge as ready to complete', async () => {
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: null,
      nextAction: 'complete_merge',
      mergeInProgress: true,
      blockingReason: null,
    });
    mergeWorkflowRuntime.repositories = mergeWorkflowRuntime.repositories.map((repository) => ({
      ...repository,
      progressState: 'pending',
      isClean: true,
      dirtyFiles: [],
      conflictFiles: [],
      mergeable: true,
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    }));
    mergeWorkflowRuntime.blockedRepositories = [];
    mergeWorkflowRuntime.phase = 'ready';
    mergeWorkflowRuntime.taskStatus = 'InProgress';

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 0,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Resolution ready');
    expect(document.body.textContent).toContain('Merge resolution is ready');
    expect(document.body.textContent).toContain('1 resolved merge(s) ready to complete.');
    expect(document.body.textContent).not.toContain('A merge is already in progress');
    expect(document.body.textContent).not.toContain('Resolve manually');

    const completeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Complete merge'));

    await act(async () => {
      completeButton?.click();
      await flushRender();
    });

    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1', {
      mergeStrategyAction: 'complete_merge',
    });
  });

  it('lets the global merge action complete a resolved in-progress merge', async () => {
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: null,
      nextAction: 'complete_merge',
      mergeInProgress: true,
      blockingReason: null,
    });
    mergeWorkflowRuntime.repositories = mergeWorkflowRuntime.repositories.map((repository) => ({
      ...repository,
      progressState: 'pending',
      isClean: true,
      dirtyFiles: [],
      conflictFiles: [],
      mergeable: true,
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    }));
    mergeWorkflowRuntime.blockedRepositories = [];
    mergeWorkflowRuntime.phase = 'ready';
    mergeWorkflowRuntime.taskStatus = 'InProgress';

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 0,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const mergeTaskButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Merge task');

    await act(async () => {
      mergeTaskButton?.click();
      await flushRender();
    });

    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1');
    expect(document.body.textContent).not.toContain('Abort resolved merge?');
  });

  it('confirms aborting a resolved merge before discarding the merge state', async () => {
    const abortMergeWorkflowManualResolutionMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: null,
      nextAction: 'complete_merge',
      mergeInProgress: true,
      blockingReason: null,
    });
    mergeWorkflowRuntime.repositories = mergeWorkflowRuntime.repositories.map((repository) => ({
      ...repository,
      progressState: 'pending',
      isClean: true,
      dirtyFiles: [],
      conflictFiles: [],
      mergeable: true,
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    }));
    mergeWorkflowRuntime.blockedRepositories = [];
    mergeWorkflowRuntime.phase = 'ready';
    mergeWorkflowRuntime.taskStatus = 'InProgress';

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        abortMergeWorkflowManualResolution: abortMergeWorkflowManualResolutionMock,
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 1,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Complete merge');
    expect(document.body.textContent).not.toContain('A merge is already in progress');
    expect(document.body.querySelector('[data-merge-resolution-repository-list="true"]')).toBeNull();

    const abortButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Abort merge');

    await act(async () => {
      abortButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Abort resolved merge?');
    expect(document.body.querySelector('[data-merge-resolution-repository-list="true"]')?.textContent)
      .toContain('/repos/project');
    expect(abortMergeWorkflowManualResolutionMock).not.toHaveBeenCalled();

    const confirmAbortButton = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Abort merge')
      .at(-1);

    await act(async () => {
      confirmAbortButton?.click();
      await flushRender();
    });

    expect(abortMergeWorkflowManualResolutionMock).toHaveBeenCalledWith(
      'task-1',
      'repo-1'
    );
  });

  it('loads the merge review once when an existing runtime has no review yet', async () => {
    const loadMergeWorkflowReviewMock = mock(async () => null);
    const idleRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'idle',
      taskStatus: 'InProgress',
      review: null,
      repositories: [],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: null,
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? idleRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledTimes(1);
    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledWith('task-1');
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('renders the merge workflow incident list in compact width', async () => {
    resizeObserverWidth = 360;
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-merge-workflow-layout="compact"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-rail="true"]')).toBeNull();
    expect(document.body.querySelector('[data-merge-repository-sidebar="true"]')).toBeNull();
    expect(document.body.textContent).toContain('File conflicts');
    expect(document.body.textContent).toContain('Resolve manually');
    expect(document.body.textContent).toContain('Resolve with AI');
    expect(document.body.textContent).not.toContain('View diff');
    expect(document.body.textContent).not.toContain('Resolve the repository blockers before retrying the merge.');
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Resolve these conflicts before finishing',
      expect.objectContaining({
        category: 'task_attention_required',
        notificationKey: expect.stringContaining('merge-workflow-blocker:task-1:repo-1'),
      })
    );
  });

  it('keeps large merge diffs out of the main incident list', async () => {
    const largeDiff = `${'diff --git a/src/main.ts b/src/main.ts\n'.repeat(4000)}END-OF-LARGE-DIFF`;
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: largeDiff,
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: largeDiff,
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Diff too large to render fully. Showing a preview.');
    expect(document.body.textContent).not.toContain('END-OF-LARGE-DIFF');
    expect(document.body.textContent).toContain('Resolve manually');
    expect(document.body.textContent).toContain('Resolve with AI');
    expect(document.body.textContent).not.toContain('View diff');
    expect(document.body.textContent).not.toContain('END-OF-LARGE-DIFF');
  });

  it('refreshes the merge workflow review when the assistant finishes for the selected task', async () => {
    seedActiveAssistantRuntime();
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/main.ts'],
      blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/main.ts.',
    });
    const loadMergeWorkflowReviewMock = mock(async () => mergeWorkflowRuntime);

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        merge_workflow: { taskId: 'task-1' },
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 1,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    loadMergeWorkflowReviewMock.mockClear();

    await finishAssistantAndFlushPostAssistantRefresh();

    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledWith('task-1', { force: true });
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('refreshes normal file changes silently when the assistant finishes for the selected task', async () => {
    seedActiveAssistantRuntime();
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    loadCurrentChangesMock.mockClear();

    await finishAssistantAndFlushPostAssistantRefresh();

    expect(loadCurrentChangesMock).toHaveBeenCalledWith({ silent: true });
  });

  it('refreshes after the assistant finishes while preserving an open diff modal', async () => {
    seedActiveAssistantRuntime();
    seedStores(buildRepository(false));
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      isDiffModalOpen: true,
      selectedDiffTarget: { repositoryId: 'repo-1', changeId: 'change-1' },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    loadCurrentChangesMock.mockClear();

    await finishAssistantAndFlushPostAssistantRefresh();

    expect(loadCurrentChangesMock).toHaveBeenCalledWith({
      silent: true,
      preserveDiffModalSession: true,
    });
    expect(useFileChangesStore.getState().isDiffModalOpen).toBe(true);
  });

  it('renders the scoped empty-state message when the task is outside the current repository scope', async () => {
    seedStores(buildRepository(false), {
      loadState: 'out_of_scope',
      loadMessage: 'This task has no changes in Project One.',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('This task has no changes in Project One.');
    expect(document.body.textContent).not.toContain('No pending file changes for this task yet.');
  });

  it('renders an actionable callout when the task worktree is not ready', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage:
        'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).toContain('Commit, stash, or discard');
    expect(document.body.textContent).toContain('Retry');
  });

  it('renders a plain empty state while a pending task has no worktree yet', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage: 'Make your first changes to this task to see them here.',
      taskOverrides: {
        status: 'Pending',
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Make your first changes to this task to see them here.');
    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(Array.from(document.body.querySelectorAll('button')).some((button) =>
      button.textContent?.trim() === 'Retry'
    )).toBe(false);
  });

  it('renders a calm waiting state for a failed task without a worktree', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage: 'Retry this task to continue. Its changes will appear here.',
      taskOverrides: {
        status: 'Failed',
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Retry this task to continue. Its changes will appear here.');
    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(Array.from(document.body.querySelectorAll('button')).some((button) =>
      button.textContent?.trim() === 'Retry'
    )).toBe(false);
  });

  it('keeps invalid worktree mappings actionable', async () => {
    seedStores(buildRepository(false), {
      loadState: 'invalid_mapping',
      loadMessage: 'Macro could not find the prepared task worktree for feature/demo.',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).toContain('Macro could not find the prepared task worktree for feature/demo.');
    expect(Array.from(document.body.querySelectorAll('button')).some((button) =>
      button.textContent?.trim() === 'Retry'
    )).toBe(true);
  });

  it('renders a calm locked state when the selected task is dependency-blocked', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage: 'Unlock this task to see its changes here.',
      taskOverrides: {
        status: 'Blocked',
        is_blocked: true,
        blocked_by: ['Prepare checkout model'],
        blocked_by_task_ids: ['task-0'],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Task blocked');
    expect(document.body.textContent).toContain('Blocked by: Prepare checkout model');
    expect(document.body.textContent).toContain('Complete the prerequisite tasks');
    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).not.toContain('Retry');
  });

  it('renders a plain empty state for a manual feature draft without a prompt', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage: 'Make your first changes to this task to see them here.',
      taskOverrides: {
        status: 'Pending',
        draft: true,
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Make your first changes to this task to see them here.');
    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).not.toContain('Retry');
  });

  it('reloads repository changes when the focused project changes', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    loadCurrentChangesMock.mockClear();

    await act(async () => {
      useAppStore.setState({
        ...useAppStore.getState(),
        selectedProjectId: 'project-1',
      });
      await flushRender();
    });

    expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);
  });

  it('does not load repository changes while the task is awaiting a user response', async () => {
    seedStores(buildRepository(false), {
      taskOverrides: {
        status: 'AwaitingResponse',
      },
    });
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Loading repository changes');
  });

  it('does not load repository changes while a questionnaire is pending for the task', async () => {
    seedStores(buildRepository(false));
    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: [
        {
          id: 'conversation-1',
          title: 'Task conversation',
          scope_mode: 'Implement',
          task_id: 'task-1',
          group_id: 'group-1',
          project_id: 'project-1',
          last_message: '',
          message_count: 1,
          updated_at: '2026-04-22T10:00:00.000Z',
          is_unread: false,
        },
      ],
      getActiveQuestionnaire: (() => ({ mode: 'pending_reply' })) as never,
    });
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('shows one resource-pressure notification and backs off automatic refreshes', async () => {
    seedStores(buildRepository(false));
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      lastError: 'Failed to read workspace state: Too many open files (os error 24)',
    });
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Macro is temporarily overloaded',
      expect.objectContaining({
        notificationKey: 'implement-task-error:too-many-open-files',
      })
    );
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('does not start a polling snapshot while the initial review load is pending', async () => {
    seedStores(buildRepository(false));
    let finishInitialLoad!: () => void;
    const pendingInitialLoad = new Promise<void>((resolve) => {
      finishInitialLoad = resolve;
    });
    loadCurrentChangesMock = mock(async () => pendingInitialLoad);
    useFileChangesStore.setState({ loadCurrentChanges: loadCurrentChangesMock });

    jest.useFakeTimers();
    try {
      await act(async () => {
        root?.render(<FileChangesPanel />);
        await Promise.resolve();
      });
      expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(1_500);
        await Promise.resolve();
      });
      expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);

      finishInitialLoad();
      await act(async () => {
        await pendingInitialLoad;
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels an active review load when the panel closes', async () => {
    seedStores(buildRepository(false));
    const cancelReviewLoad = mock(() => undefined);
    useFileChangesStore.setState({ cancelReviewLoad });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    await act(async () => {
      root?.unmount();
      root = null;
      await Promise.resolve();
    });

    expect(cancelReviewLoad).toHaveBeenCalledTimes(1);
  });

  it('opens project settings instead of retrying an invalid direct-mode configuration', async () => {
    seedStores(buildRepository(false));
    const openProjectGitFlowModal = mock(() => undefined);
    useAppStore.setState({ openProjectGitFlowModal });
    useFileChangesStore.setState({
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'DIRECT_MODE_CONFIGURATION_REQUIRED',
          message: 'Direct review requires project configuration.',
          details: { projectId: 'project-1', worktreeModified: false },
        },
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const settingsButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Project settings'
    );
    expect(settingsButton).toBeDefined();
    expect(Array.from(document.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Retry'
    )).toBe(false);
    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(openProjectGitFlowModal).toHaveBeenCalledWith('project-1');
  });

  it('does not retry a suspended review when an unrelated project changes', async () => {
    seedStores(buildRepository(false), {
      taskOverrides: {
        execution_targets: [{ projectId: 'project-1', executionMode: 'direct' }],
      },
    });
    const retrySuspendedReview = mock(async () => undefined);
    useFileChangesStore.setState({
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'DIRECT_CHECKPOINT_CORRUPT',
          message: "Macro's internal review checkpoint is incomplete.",
          details: { reviewProjectId: 'project-1' },
        },
      },
      retrySuspendedReview,
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    retrySuspendedReview.mockClear();

    await act(async () => {
      useAppStore.setState({
        projectGroups: [
          ...useAppStore.getState().projectGroups,
          {
            id: 'group-unrelated',
            name: 'Unrelated',
            isOpen: true,
            projects: [{
              id: 'project-2',
              name: 'Project Two',
              mountName: 'project-two',
              path: '/tmp/changed-unrelated-path',
              isReadOnly: false,
              created_at: '2026-04-08T00:00:00.000Z',
              status: 'active',
              metadata: {
                description: '',
                tags: [],
                team_members: [],
                api_contracts: [],
                dependencies: [],
              },
            }],
          },
        ],
      });
      await flushRender();
    });

    expect(retrySuspendedReview).not.toHaveBeenCalled();
  });

  it('does not retry a suspended multi-project review when another target changes', async () => {
    seedStores(buildRepository(false), {
      taskOverrides: {
        execution_targets: [
          { projectId: 'project-1', executionMode: 'direct', checkpointId: 'checkpoint-a' },
          { projectId: 'project-2', executionMode: 'direct', checkpointId: 'checkpoint-b' },
        ],
      },
    });
    const retrySuspendedReview = mock(async () => undefined);
    useFileChangesStore.setState({
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'DIRECT_CHECKPOINT_CORRUPT',
          message: "Macro's internal review checkpoint is incomplete.",
          details: { reviewProjectId: 'project-1' },
        },
      },
      retrySuspendedReview,
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    retrySuspendedReview.mockClear();

    await act(async () => {
      useTaskStore.setState((state) => ({
        tasks: state.tasks.map((task) => task.id === 'task-1'
          ? {
              ...task,
              execution_targets: task.execution_targets?.map((target) => target.projectId === 'project-2'
                ? { ...target, checkpointId: 'checkpoint-b-updated' }
                : target),
            }
          : task),
      }));
      await flushRender();
    });

    expect(retrySuspendedReview).not.toHaveBeenCalled();
  });

  it('retries a suspended Git review when its effective worktree changes', async () => {
    seedStores(buildRepository(false), {
      taskOverrides: {
        execution_targets: [{
          projectId: 'project-1',
          executionMode: 'git',
          worktreeKey: 'repo-1',
          branchName: 'feature/task-1',
        }],
      },
    });
    useTaskStore.setState({ branchWorktrees: { 'repo-1': '/tmp/old-worktree' } });
    const retrySuspendedReview = mock(async () => undefined);
    useFileChangesStore.setState({
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'GIT_OBJECT_MISSING',
          message: 'A Git object required for this operation is missing.',
          details: { reviewProjectId: 'project-1' },
        },
      },
      retrySuspendedReview,
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    retrySuspendedReview.mockClear();

    await act(async () => {
      useTaskStore.setState({ branchWorktrees: { 'repo-1': '/tmp/repaired-worktree' } });
      await flushRender();
    });

    expect(retrySuspendedReview).toHaveBeenCalledTimes(1);
    expect(retrySuspendedReview).toHaveBeenCalledWith('task-1');
  });

  it('opens settings for the project that suspended a multi-project review', async () => {
    seedStores(buildRepository(false), {
      taskOverrides: {
        execution_targets: [
          { projectId: 'project-1', executionMode: 'direct' },
          { projectId: 'project-2', executionMode: 'direct' },
        ],
      },
    });
    const openProjectGitFlowModal = mock(() => undefined);
    useAppStore.setState({ openProjectGitFlowModal });
    useFileChangesStore.setState({
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'DIRECT_CHECKPOINT_PROJECT_MISMATCH',
          message: "Macro's internal review checkpoint belongs to another project path.",
          details: { reviewProjectId: 'project-2' },
        },
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    const settingsButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Project settings'
    );
    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openProjectGitFlowModal).toHaveBeenCalledWith('project-2');
  });

  it('deduplicates a missing-object warning, stops polling, and resumes from Retry', async () => {
    seedStores(buildRepository(false));
    const retrySuspendedReviewMock = mock(async () => undefined);
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      reviewSuspension: {
        taskId: 'task-1',
        retrying: false,
        error: {
          code: 'GIT_OBJECT_MISSING',
          message: 'A Git object required for this operation is missing.',
          details: {
            objectId: '0123456789abcdef0123456789abcdef01234567',
            retryAttempted: true,
            worktreeModified: false,
            gitOutput: 'fatal: unable to read object',
          },
        },
      },
      retrySuspendedReview: retrySuspendedReviewMock,
    });
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(notifyActionRequiredMock).toHaveBeenCalledTimes(1);
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Git review is paused',
      expect.objectContaining({
        notificationKey: 'implement-review:suspended:GIT_OBJECT_MISSING:task-1',
      })
    );
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Macro did not modify any working files.'
    );
    expect(document.body.textContent).toContain('Show details');
    const detailsButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Show details'
    );
    expect(detailsButton?.getAttribute('aria-expanded')).toBe('false');
    const detailsId = detailsButton?.getAttribute('aria-controls');
    expect(detailsId).toBeTruthy();
    await act(async () => {
      detailsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    expect(detailsButton?.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(detailsId || '')?.textContent).toContain(
      '0123456789abcdef0123456789abcdef01234567'
    );

    const retryButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    expect(retrySuspendedReviewMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      useFileChangesStore.setState({
        reviewSuspension: {
          taskId: 'task-1',
          retrying: false,
          error: {
            code: 'DIRECT_CHECKPOINT_CORRUPT',
            message: "Macro's internal review checkpoint is incomplete.",
            details: {
              checkpointId: 'task-1-0123456789abcdef',
              acceptedHistoryAtRisk: true,
              worktreeModified: false,
            },
          },
        },
      });
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    expect(document.body.textContent).toContain("Macro's review checkpoint is damaged");
    expect(document.body.textContent).not.toContain('repository is damaged');

    await act(async () => {
      useFileChangesStore.setState({
        reviewSuspension: {
          taskId: 'task-1',
          retrying: false,
          error: {
            code: 'DIRECT_CHECKPOINT_PROJECT_MISMATCH',
            message: "Macro's internal review checkpoint belongs to another project path.",
            details: { checkpointId: 'task-1-0123456789abcdef' },
          },
        },
      });
      root?.render(<FileChangesPanel />);
      await flushRender();
    });
    expect(document.body.textContent).toContain('belongs to another project path');
    expect(Array.from(document.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Retry'
    )).toBe(false);
    expect(notifyActionRequiredMock).toHaveBeenLastCalledWith(
      "Macro's review checkpoint belongs to another project path",
      expect.objectContaining({
        actions: [expect.objectContaining({ label: 'Project settings' })],
      })
    );
  });

  it('loads changes when only a focused project is selected', async () => {
    seedStores(buildRepository(false));
    loadCurrentChangesMock.mockClear();

    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: null,
      selectedProjectId: 'project-1',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Select a project to view changes');
  });

  it('renders a read-only remote empty state and hides validation actions in remote mode', async () => {
    process.env.VITE_BACKEND_TRANSPORT = 'remote';
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local validation is not available in remote mode yet.');
    expect(document.body.textContent).toContain('This action is not available in remote mode yet.');
    expect(document.body.textContent).not.toContain('Validate changes');
    expect(document.body.textContent).not.toContain('Commit');
    expect(document.body.textContent).not.toContain('Finish task');
    expect(document.querySelector('[aria-label="Validate"]')).toBeNull();
    expect(document.querySelector('[aria-label="Revert"]')).toBeNull();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });
});
