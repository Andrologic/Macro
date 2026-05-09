import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useChatStore } from '../../stores/useChatStore';
import { providerHasCredentials, useProviderStore } from '../../stores/useProviderStore';
import type { ReasoningEffort } from '../../types';
import {
  useFileChangesStore,
  buildFolderTree,
  type FolderNode,
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import {
  type ReviewRepositorySummary,
  type ReviewRepositoryUiState,
} from '../../services/implementMultiRepoSummary';
import {
  getServiceRuntimeCapabilities,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
} from '../../services';
import { toServiceError } from '../../services/contracts/errors';
import {
  areAllFileChangesRepositoriesResolved,
} from '../../services/fileChangesReviewScope';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import {
  mergeWorkflowNeedsUserDecision,
  resolveMergeWorkflowViewState,
} from '../../services/mergeWorkflow';
import { isPlanFinalizationTaskSource } from '../../services/planFinalization';
import { isSmartCommitMessageGenerationError } from '../../services/smartCommitMessageGenerator';
import {
  formatConventionalCommitMessage,
  validateConventionalCommitFields,
  type ConventionalCommitFields,
} from '../../services/conventionalCommit';
import {
  normalizeSmartCommitModelConfig,
  type SmartCommitModelConfig,
} from '../../services/smartCommitModelConfig';
import {
  loadSmartCommitModelConfig,
  saveSmartCommitModelConfig,
  subscribeSmartCommitModelConfig,
} from '../../services/smartCommitModelPreference';
import {
  buildEditableCommitMessages,
  buildManualCommitMessageDrafts,
} from '../../services/smartCommitDrafts';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { notify } from '../ui/toastService';
import { FileChangesDiffModal } from '../modals/FileChangesDiffModal';
import { Button } from '../ui/Button';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { MergeWorkflowTaskPanel } from '../plan/MergeWorkflowTaskPanel';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { ActionableErrorCallout } from '../shared/ActionableErrorCallout';
import {
  getDependencyBlockedMessage,
  TaskBlockedState,
} from './TaskBlockedState';
import {
  presentServiceError,
  presentWorktreeError,
} from '../../services/degradedErrorPresentation';
import {
  getTooManyOpenFilesNotificationKey,
  isTooManyOpenFilesBackoffActive,
  isTooManyOpenFilesMessage,
  noteTooManyOpenFilesBackoff,
} from '../../services/resourcePressureBackoff';
import { isManualDraftPendingInitialization } from '../../services/manualDraftInitialization';
import { canAutoRefreshFileChangesForTask } from '../../services/fileChangesRefreshPolicy';
import { CommitMessageEditorModal } from './CommitMessageEditorModal';
import { CommitMessageGenerationFailureModal } from './CommitMessageGenerationFailureModal';

interface FileChangesPanelProps {
  className?: string;
}

interface CommitMessageEditState {
  mode: 'review_generated' | 'manual_fallback';
  fieldsByRepositoryId: Record<string, ConventionalCommitFields>;
  error: string | null;
}

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

const interpolateFallbackPlaceholders = (
  value: string,
  options?: Record<string, unknown>
): string => {
  if (!options) {
    return value;
  }
  return Object.entries(options).reduce((text, [key, rawValue]) => {
    const replacement = rawValue == null ? '' : String(rawValue);
    return text.replaceAll(`{{${key}}}`, replacement);
  }, value);
};

const CHANGE_PANEL_POLL_INTERVAL_MS = 1500;
const CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS = 8000;
const POST_ASSISTANT_REFRESH_DELAY_MS = 400;
const NO_REASONING_EFFORTS = (_providerId?: string | null, _modelId?: string | null): ReasoningEffort[] => [];

const STATUS_COLORS = {
  added: 'text-primary',
  modified: 'text-foreground',
  deleted: 'text-destructive',
};

const STATUS_BG = {
  added: 'bg-primary/10',
  modified: 'bg-muted',
  deleted: 'bg-destructive/10',
};

const STATUS_MARKERS: Record<string, string> = {
  added: '+',
  modified: 'M',
  deleted: '-',
};

const REVIEW_STATE_CLASSES: Record<ReviewRepositoryUiState, string> = {
  pending_validation: 'bg-primary/10 text-primary',
  ready_to_commit: 'bg-secondary text-secondary-foreground',
  committed: 'bg-muted text-muted-foreground',
  no_changes: 'bg-muted text-muted-foreground',
};

const getRepositoryPathTail = (repoPath: string | null | undefined, fallback: string): string => {
  const normalized = (repoPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || fallback;
};

const getRepositoryDisplayName = (
  repository: Pick<ReviewRepositoryState, 'projectId' | 'repoPath'>,
  projectName?: string | null
): string => {
  const tail = getRepositoryPathTail(repository.repoPath, repository.projectId);
  return projectName || tail;
};

const normalizeCommitErrorMessage = (raw: string, t: TranslateFn): string => {
  const value = raw.toLowerCase();
  if (value.includes('staged files outside this task')) {
    return t(
      'implement.errors.foreignStagedFilesShort',
      'Some staged files do not belong to this task. Unstage them first.'
    );
  }
  return raw;
};

interface FolderTreeItemProps {
  repositoryId: string;
  node: FolderNode;
  depth: number;
  selectedChangeId: string | null;
  onFileClick: (changeId: string) => void;
  onStageChanges: (changeIds: string[]) => void;
  onUnstageChanges: (changeIds: string[]) => void;
  onRevert: (changeIds: string[], scopeLabel: string, requiresConfirm: boolean) => void;
  labels: {
    staged: string;
    validate: string;
    unstage: string;
    revert: string;
  };
}

interface ScopeActionRailProps {
  onValidate?: () => void;
  onUnstage?: () => void;
  onRevert?: () => void;
  labels: {
    staged: string;
    validate: string;
    unstage: string;
    revert: string;
  };
  className?: string;
}

const ScopeActionRail: React.FC<ScopeActionRailProps> = ({
  onValidate,
  onUnstage,
  onRevert,
  labels,
  className,
}) => (
  <div
    className={cn(
      'absolute inset-y-0 right-0 z-20 flex items-center gap-1 pr-1 pl-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
      'bg-transparent',
      className
    )}
  >
    {onValidate && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        title={labels.validate}
        aria-label={labels.validate}
        onClick={(event) => {
          event.stopPropagation();
          onValidate();
        }}
      >
        <Icon name="check" size={14} />
      </Button>
    )}
    {onUnstage && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        title={labels.unstage}
        aria-label={labels.unstage}
        onClick={(event) => {
          event.stopPropagation();
          onUnstage();
        }}
      >
        <Icon name="minus" size={14} />
      </Button>
    )}
    {onRevert && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        title={labels.revert}
        aria-label={labels.revert}
        onClick={(event) => {
          event.stopPropagation();
          onRevert();
        }}
      >
        <Icon name="undo-2" size={14} />
      </Button>
    )}
  </div>
);

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  repositoryId,
  node,
  depth,
  selectedChangeId,
  onFileClick,
  onStageChanges,
  onUnstageChanges,
  onRevert,
  labels,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasPendingValidation = node.hasPendingVisibleChanges;
  const pendingChangeIds = node.pendingChangeIds;
  const stagedChangeIds = node.stagedChangeIds;

  if (node.type === 'folder') {
    return (
      <div>
        <div
          className="group relative rounded transition-colors hover:bg-accent/50"
          style={{ marginLeft: `${depth * 12}px` }}
        >
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex min-w-0 w-full appearance-none items-center gap-2 border-0 bg-transparent px-2 py-1.5 pr-2 text-left outline-none"
          >
            <Icon
              name={isOpen ? 'chevron-down' : 'chevron-right'}
              size={12}
              className="text-muted-foreground shrink-0"
            />
            <Icon
              name={isOpen ? 'folder-open' : 'folder'}
              size={14}
              className="text-primary/80 shrink-0"
            />
            <span className="text-sm text-foreground truncate">{node.name}</span>
            {!isOpen && hasPendingValidation && (
              <span
                data-pending-validation-indicator="true"
                className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0"
              />
            )}
          </button>
          {(pendingChangeIds.length > 0 || stagedChangeIds.length > 0) && (
            <ScopeActionRail
              onValidate={pendingChangeIds.length > 0 ? () => onStageChanges(pendingChangeIds) : undefined}
              onUnstage={stagedChangeIds.length > 0 ? () => onUnstageChanges(stagedChangeIds) : undefined}
              onRevert={pendingChangeIds.length > 0 ? () => onRevert(pendingChangeIds, node.path, true) : undefined}
              labels={labels}
              className="rounded-r"
            />
          )}
        </div>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <FolderTreeItem
                repositoryId={repositoryId}
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedChangeId={selectedChangeId}
                onFileClick={onFileClick}
                onStageChanges={onStageChanges}
                onUnstageChanges={onUnstageChanges}
                onRevert={onRevert}
                labels={labels}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const change = node.fileChange;
  if (!change) return null;

  const isSelected = selectedChangeId === change.id;

  return (
    <div
      className={cn(
        'group relative rounded-lg transition-all overflow-hidden',
        isSelected
          ? 'bg-primary/[0.035]'
          : 'bg-primary/[0.035] hover:bg-primary/[0.06]'
      )}
      style={{ marginLeft: `${depth * 12}px` }}
    >
      <button
        type="button"
        onClick={() => onFileClick(change.id)}
        className="flex min-w-0 w-full appearance-none items-center gap-2 border-0 bg-transparent px-2 py-1.5 pr-2 text-left outline-none"
      >
        <span
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold font-mono',
            STATUS_BG[change.status]
          )}
        >
          <span className={STATUS_COLORS[change.status]}>{STATUS_MARKERS[change.status]}</span>
        </span>

        <span className="text-sm text-foreground truncate flex-1 text-left">{node.name}</span>

        {change.hasPendingVisibleChange && (
          <span
            data-pending-validation-indicator="true"
            className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0"
          />
        )}

        <div
          className={cn(
            'flex items-center gap-1 text-[11px] shrink-0 opacity-60',
            (change.hasPendingVisibleChange || change.hasValidatedStage) &&
              'transition-opacity group-hover:opacity-0'
          )}
        >
          {change.hasValidatedStage && (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
              {labels.staged}
            </span>
          )}
          {change.additions > 0 && (
            <span className="text-primary font-mono">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="text-destructive font-mono">-{change.deletions}</span>
          )}
        </div>
      </button>
      {(change.hasPendingVisibleChange || change.hasValidatedStage) && (
        <ScopeActionRail
          onValidate={change.hasPendingVisibleChange ? () => onStageChanges([change.id]) : undefined}
          onUnstage={change.hasValidatedStage ? () => onUnstageChanges([change.id]) : undefined}
          onRevert={change.hasPendingVisibleChange ? () => onRevert([change.id], change.path, false) : undefined}
          labels={labels}
          className="rounded-r-lg"
        />
      )}
    </div>
  );
};

const renderRepositoryState = (
  repository: ReviewRepositoryState,
  repositorySummary: ReviewRepositorySummary | undefined,
  t: TranslateFn
): string => {
  if (repositorySummary?.isCommitting) {
    return t('implement.commitInProgress', 'Committing changes...');
  }
  if (repositorySummary?.state === 'committed') {
    return t('implement.repositoryCommitted', 'Committed');
  }
  if (repositorySummary?.state === 'no_changes') {
    return t('implement.repositoryNoChanges', 'No changes');
  }
  if (repositorySummary?.hasPendingVisibleChanges && repositorySummary?.hasValidatedStagedChanges) {
    return t(
      'implement.repositoryPendingAndReady',
      '{{pending}} pending, {{validated}} ready',
      {
        pending: repositorySummary.pendingVisibleFileCount,
        validated: repositorySummary.validatedStagedFileCount,
      }
    );
  }
  if (repositorySummary?.hasValidatedStagedChanges) {
    return t('implement.repositoryReadyToCommit', 'Ready to commit');
  }
  if (repository.commitState === 'committed') {
    return t('implement.repositoryCommitted', 'Committed');
  }
  if (repository.commitState === 'no_changes') {
    return t('implement.repositoryNoChanges', 'No changes');
  }
  return t('implement.repositoryValidationProgress', '{{pending}} pending', {
    pending: repository.stats.pendingVisibleFileCount,
  });
};

const FileChangesPanelBase: React.FC<FileChangesPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const translate: TranslateFn = (key, fallback, options) =>
    interpolateFallbackPlaceholders(
      String(t(key, { defaultValue: fallback, ...(options || {}) })),
      options
    );
  const serviceRuntimeCapabilities = getServiceRuntimeCapabilities();
  const isReadOnlyRemoteMode = !serviceRuntimeCapabilities.taskMutation;
  const {
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    projectGroups,
    getProjectById,
    openSettings,
  } = useAppStore();
  const currentTask = useTaskStore((state) =>
    selectedTaskId ? state.tasks.find((task) => task.id === selectedTaskId) ?? null : null
  );
  const currentMergeWorkflowRuntime = useTaskStore((state) =>
    selectedTaskId ? state.getMergeWorkflowRuntime(selectedTaskId) : null
  );
  const selectedTaskAssistantRuntimeSignature = useChatStore((state) => {
    if (!selectedTaskId) return '';
    return state.conversations
      .filter((conversation) =>
        conversation.scope_mode === 'Implement' &&
        conversation.task_id === selectedTaskId
      )
      .map((conversation) => {
        const runtime = state.conversationRuntimeById[conversation.id];
        return [
          conversation.id,
          runtime?.phase ?? 'idle',
          runtime?.sessionId ?? '',
        ].join(':');
      })
      .sort()
      .join('|');
  });
  const selectedTaskHasPendingQuestionnaire = useChatStore((state) => {
    if (!selectedTaskId) return false;
    return state.conversations.some((conversation) => {
      if (
        conversation.scope_mode !== 'Implement' ||
        conversation.task_id !== selectedTaskId
      ) {
        return false;
      }
      return state.getActiveQuestionnaire(conversation.id)?.mode === 'pending_reply';
    });
  });
  const selectedTaskWorktreeKey = useTaskStore((state) => {
    if (!selectedTaskId) return '';
    const task = state.tasks.find((candidate) => candidate.id === selectedTaskId);
    if (!task?.execution_targets?.length) return '';
    return task.execution_targets
      .map((target) => `${target.worktreeKey}:${state.branchWorktrees[target.worktreeKey] ?? ''}`)
      .join('|');
  });
  const finishTask = useTaskStore((state) => state.finishTask);
  const loadMergeWorkflowReview = useTaskStore((state) => state.loadMergeWorkflowReview);
  const providerStore = useProviderStore();
  const providerConfigs = providerStore.providerConfigs;
  const modelsByProvider = providerStore.modelsByProvider;
  const getAvailableReasoningEfforts = providerStore.getAvailableReasoningEfforts ?? NO_REASONING_EFFORTS;
  const [expandedRepositoryIds, setExpandedRepositoryIds] = useState<Record<string, boolean>>({});
  const [pendingRevertScope, setPendingRevertScope] = useState<{
    repositoryId: string;
    changeIds: string[];
    scopeLabel: string;
  } | null>(null);
  const [commitMessageGenerationError, setCommitMessageGenerationError] = useState<string | null>(null);
  const [smartCommitModelConfig, setSmartCommitModelConfig] = useState<SmartCommitModelConfig | null | undefined>(
    undefined
  );
  const [isCommitModelChoiceOpen, setIsCommitModelChoiceOpen] = useState(false);
  const [commitModelChoiceMode, setCommitModelChoiceMode] = useState<'conversation' | 'dedicated'>('conversation');
  const [dedicatedCommitProviderId, setDedicatedCommitProviderId] = useState('');
  const [dedicatedCommitModelId, setDedicatedCommitModelId] = useState('');
  const [dedicatedCommitReasoningEffort, setDedicatedCommitReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [postAssistantRefreshToken, setPostAssistantRefreshToken] = useState(0);
  const assistantRefreshTaskIdRef = useRef<string | null>(null);
  const assistantWasActiveForTaskRef = useRef(false);
  const postAssistantRefreshPendingRef = useRef(false);
  const postAssistantRefreshInFlightRef = useRef(false);
  const postAssistantRefreshTimeoutRef = useRef<number | null>(null);
  const [commitMessageEditState, setCommitMessageEditState] = useState<CommitMessageEditState | null>(null);
  const {
    repositories,
    reviewSummary,
    currentTaskLoadState,
    currentTaskLoadMessage,
    selectedRepositoryId,
    selectedDiffTarget,
    isDiffModalOpen,
    isLoading,
    isGeneratingCommitMessages,
    isCommitting,
    lastError,
    executionRecords,
    loadCurrentChanges,
    resetReviewState,
    selectRepository,
    openDiffModal,
    closeDiffModal,
    stageChanges,
    unstageChanges,
    stageAllTaskChanges,
    revertChanges,
    commitAllReadyTaskRepositories,
    getOverallStats,
  } = useFileChangesStore();
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const enabledCommitProviders = useMemo(
    () => providerConfigs.filter((provider) => providerHasCredentials(provider)),
    [providerConfigs]
  );
  const normalizeCommitModelConfig = useCallback((
    config: SmartCommitModelConfig | null | undefined
  ): SmartCommitModelConfig | null =>
    normalizeSmartCommitModelConfig(config, {
      providerConfigs: enabledCommitProviders,
      modelsByProvider,
      getAvailableReasoningEfforts,
    }), [enabledCommitProviders, getAvailableReasoningEfforts, modelsByProvider]);
  const dedicatedCommitModels = useMemo(
    () => dedicatedCommitProviderId
      ? (modelsByProvider[dedicatedCommitProviderId] || []).filter((model) => model.isEnabled !== false)
      : [],
    [dedicatedCommitProviderId, modelsByProvider]
  );
  const dedicatedCommitReasoningEfforts = getAvailableReasoningEfforts(
    dedicatedCommitProviderId || null,
    dedicatedCommitModelId || null
  );
  const canUseDedicatedCommitModel = Boolean(dedicatedCommitProviderId && dedicatedCommitModelId);
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const hasRepositoryScope = workspaceState.scopedProjectIds.length > 0;
  const isPlanFinalizationTask = isPlanFinalizationTaskSource(currentTask?.task_source);
  const hasActiveMergeWorkflow = Boolean(currentMergeWorkflowRuntime);
  const hasResourcePressureError = isTooManyOpenFilesMessage(lastError);
  const canAutoRefreshCurrentTask = canAutoRefreshFileChangesForTask({
    selectedTaskId,
    taskStatus: currentTask?.status,
    hasPendingQuestionnaire: selectedTaskHasPendingQuestionnaire,
    hasRepositoryScope,
    isReadOnlyRemoteMode,
    isPlanFinalizationTask,
    hasActiveMergeWorkflow,
    hasResourcePressureError,
    isResourcePressureBackoffActive: isTooManyOpenFilesBackoffActive(),
  });
  const isSelectedTaskAssistantActive =
    selectedTaskAssistantRuntimeSignature.includes(':preparing:') ||
    selectedTaskAssistantRuntimeSignature.includes(':streaming:');

  useEffect(() => {
    let disposed = false;
    void loadSmartCommitModelConfig()
      .then((value) => {
        if (!disposed) {
          const normalized = normalizeCommitModelConfig(value);
          setSmartCommitModelConfig(normalized);
          if (normalized?.mode === 'dedicated') {
            setCommitModelChoiceMode('dedicated');
            setDedicatedCommitProviderId(normalized.providerId);
            setDedicatedCommitModelId(normalized.modelId);
            setDedicatedCommitReasoningEffort(normalized.reasoningEffort ?? null);
          }
        }
      });

    const unsubscribe = subscribeSmartCommitModelConfig(
      (value) => {
        if (disposed) return;
        const normalized = normalizeCommitModelConfig(value);
        setSmartCommitModelConfig(normalized);
        if (normalized?.mode === 'dedicated') {
          setCommitModelChoiceMode('dedicated');
          setDedicatedCommitProviderId(normalized.providerId);
          setDedicatedCommitModelId(normalized.modelId);
          setDedicatedCommitReasoningEffort(normalized.reasoningEffort ?? null);
        } else if (normalized?.mode === 'conversation') {
          setCommitModelChoiceMode('conversation');
        }
      }
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [normalizeCommitModelConfig]);

  useEffect(() => {
    if (commitModelChoiceMode !== 'dedicated') return;
    if (!dedicatedCommitProviderId && enabledCommitProviders[0]) {
      setDedicatedCommitProviderId(enabledCommitProviders[0].id);
      return;
    }
    if (
      dedicatedCommitProviderId &&
      !dedicatedCommitModels.some((model) => model.id === dedicatedCommitModelId)
    ) {
      setDedicatedCommitModelId(dedicatedCommitModels[0]?.id ?? '');
      setDedicatedCommitReasoningEffort(null);
    }
  }, [
    commitModelChoiceMode,
    dedicatedCommitModelId,
    dedicatedCommitModels,
    dedicatedCommitProviderId,
    enabledCommitProviders,
  ]);

  useEffect(() => {
    if (isReadOnlyRemoteMode) {
      resetReviewState();
      return;
    }
    if (
      !hasRepositoryScope ||
      !selectedTaskId ||
      !canAutoRefreshCurrentTask ||
      isPlanFinalizationTask ||
      hasActiveMergeWorkflow ||
      hasResourcePressureError ||
      isTooManyOpenFilesBackoffActive()
    ) {
      resetReviewState();
      return;
    }
    if (isDiffModalOpen) {
      return;
    }
    void loadCurrentChanges();
  }, [
    currentTask?.status,
    canAutoRefreshCurrentTask,
    hasResourcePressureError,
    isDiffModalOpen,
    loadCurrentChanges,
    hasRepositoryScope,
    hasActiveMergeWorkflow,
    isPlanFinalizationTask,
    resetReviewState,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    selectedTaskWorktreeKey,
    isReadOnlyRemoteMode,
  ]);

  useEffect(() => {
    if (isReadOnlyRemoteMode) {
      return;
    }
    if (
      !hasRepositoryScope ||
      !selectedTaskId ||
      !canAutoRefreshCurrentTask ||
      isPlanFinalizationTask ||
      hasActiveMergeWorkflow ||
      hasResourcePressureError
    ) {
      return;
    }
    if (isDiffModalOpen) {
      return;
    }

    let disposed = false;
    let refreshInFlight = false;
    let timeoutId: number | null = null;

    const refreshChanges = async (silent: boolean = true) => {
      if (disposed || refreshInFlight || isCommitting || isTooManyOpenFilesBackoffActive()) {
        return;
      }

      refreshInFlight = true;
      try {
        await loadCurrentChanges({ silent });
      } catch (error) {
        if (isTooManyOpenFilesMessage(error)) {
          noteTooManyOpenFilesBackoff();
        }
      } finally {
        refreshInFlight = false;
      }
    };

    const scheduleRefresh = (delayMs: number) => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }

      timeoutId = window.setTimeout(() => {
        if (disposed) {
          return;
        }

        if (document.visibilityState === 'visible') {
          void refreshChanges();
          scheduleRefresh(CHANGE_PANEL_POLL_INTERVAL_MS);
          return;
        }

        scheduleRefresh(CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS);
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshChanges();
      }
      scheduleRefresh(
        document.visibilityState === 'visible'
          ? CHANGE_PANEL_POLL_INTERVAL_MS
          : CHANGE_PANEL_HIDDEN_POLL_INTERVAL_MS
      );
    };

    scheduleRefresh(CHANGE_PANEL_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    hasRepositoryScope,
    hasActiveMergeWorkflow,
    canAutoRefreshCurrentTask,
    hasResourcePressureError,
    isCommitting,
    isDiffModalOpen,
    isPlanFinalizationTask,
    loadCurrentChanges,
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    isReadOnlyRemoteMode,
  ]);

  useEffect(() => {
    if (!lastError || !isTooManyOpenFilesMessage(lastError)) {
      return;
    }

    noteTooManyOpenFilesBackoff();
    const presentation = presentServiceError(lastError);
    notify.actionRequired(presentation.title, {
      notificationKey: getTooManyOpenFilesNotificationKey(),
      tone: 'warning',
      description: [presentation.body, presentation.nextStep].filter(Boolean).join('\n\n'),
      category: 'task_attention_required',
      actions: [
        {
          label: t('common.retry', 'Retry'),
          variant: 'primary',
          onClick: () => void loadCurrentChanges(),
        },
      ],
    });
  }, [lastError, loadCurrentChanges, t]);

  useEffect(() => {
    if (assistantRefreshTaskIdRef.current === selectedTaskId) {
      return;
    }
    assistantRefreshTaskIdRef.current = selectedTaskId;
    assistantWasActiveForTaskRef.current = isSelectedTaskAssistantActive;
    postAssistantRefreshPendingRef.current = false;
    if (postAssistantRefreshTimeoutRef.current) {
      window.clearTimeout(postAssistantRefreshTimeoutRef.current);
      postAssistantRefreshTimeoutRef.current = null;
    }
  }, [isSelectedTaskAssistantActive, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) return;

    if (isSelectedTaskAssistantActive) {
      assistantWasActiveForTaskRef.current = true;
      return;
    }

    if (!assistantWasActiveForTaskRef.current) {
      return;
    }

    assistantWasActiveForTaskRef.current = false;
    postAssistantRefreshPendingRef.current = true;
    if (postAssistantRefreshTimeoutRef.current) {
      window.clearTimeout(postAssistantRefreshTimeoutRef.current);
    }
    postAssistantRefreshTimeoutRef.current = window.setTimeout(() => {
      postAssistantRefreshTimeoutRef.current = null;
      setPostAssistantRefreshToken((token) => token + 1);
    }, POST_ASSISTANT_REFRESH_DELAY_MS);
  }, [
    isSelectedTaskAssistantActive,
    selectedTaskAssistantRuntimeSignature,
    selectedTaskId,
  ]);

  useEffect(() => {
    return () => {
      if (postAssistantRefreshTimeoutRef.current) {
        window.clearTimeout(postAssistantRefreshTimeoutRef.current);
        postAssistantRefreshTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!postAssistantRefreshToken || !postAssistantRefreshPendingRef.current) {
      return;
    }
    if (isDiffModalOpen || isCommitting || isGeneratingCommitMessages) {
      return;
    }
    if (
      postAssistantRefreshInFlightRef.current ||
      isReadOnlyRemoteMode ||
      !hasRepositoryScope ||
      hasResourcePressureError ||
      !canAutoRefreshFileChangesForTask({
        selectedTaskId,
        taskStatus: currentTask?.status,
        hasPendingQuestionnaire: selectedTaskHasPendingQuestionnaire,
        hasRepositoryScope,
        isReadOnlyRemoteMode,
        isPlanFinalizationTask: false,
        hasActiveMergeWorkflow: false,
        hasResourcePressureError,
        isResourcePressureBackoffActive: isTooManyOpenFilesBackoffActive(),
      }) ||
      !currentTask ||
      !selectedTaskId
    ) {
      return;
    }

    postAssistantRefreshInFlightRef.current = true;

    const refreshAfterAssistant = async () => {
      try {
        const hasMergeWorkflowContext = Boolean(
          currentMergeWorkflowRuntime ||
          currentTask.merge_workflow
        );

        if (hasMergeWorkflowContext) {
          await loadMergeWorkflowReview(currentTask.id, { force: true });
          return;
        }

        if (!isPlanFinalizationTask) {
          await loadCurrentChanges({ silent: true });
        }
      } catch {
        // Silent refresh: the panel will surface explicit errors on the next user action.
      } finally {
        postAssistantRefreshPendingRef.current = false;
        postAssistantRefreshInFlightRef.current = false;
      }
    };

    void refreshAfterAssistant();
  }, [
    currentMergeWorkflowRuntime,
    currentTask,
    hasRepositoryScope,
    hasResourcePressureError,
    isCommitting,
    isDiffModalOpen,
    isGeneratingCommitMessages,
    isPlanFinalizationTask,
    isReadOnlyRemoteMode,
    loadCurrentChanges,
    loadMergeWorkflowReview,
    postAssistantRefreshToken,
    selectedTaskId,
    selectedTaskHasPendingQuestionnaire,
  ]);

  useEffect(() => {
    if (repositories.length === 0) return;
    setExpandedRepositoryIds((current) => {
      const next = { ...current };
      repositories.forEach((repository) => {
        if (next[repository.id] !== undefined) return;
        next[repository.id] =
          repositories.length === 1 ||
          repository.id === selectedRepositoryId ||
          repository.id === reviewSummary.nextRepositoryId;
      });
      return next;
    });
  }, [repositories, reviewSummary.nextRepositoryId, selectedRepositoryId]);

  const repositorySummaryById = useMemo(
    () => new Map(reviewSummary.repositories.map((repository) => [repository.id, repository])),
    [reviewSummary.repositories]
  );
  const overallStats = getOverallStats();
  const actionableFileCount =
    overallStats.pendingVisibleFileCount + overallStats.validatedStagedFileCount;
  const progressPercent = actionableFileCount > 0
    ? (overallStats.validatedStagedFileCount / actionableFileCount) * 100
    : 0;
  const hasPendingValidation = reviewSummary.actionCounts.pending_validation > 0;
  const hasReadyToCommit = reviewSummary.actionCounts.ready_to_commit > 0;
  const showValidateChangesButton = currentTask !== null && currentTask.status !== 'Completed';
  const allTaskRepositoriesResolved = Boolean(
    currentTask &&
      areAllFileChangesRepositoriesResolved({
        task: currentTask,
        repositories,
        executionRecords,
        fallbackRepositoryIds: repositories.map((repository) => repository.id),
      })
  );
  const hasTaskCommittedRepositories =
    reviewSummary.hasCommittedRepositories || Object.keys(executionRecords).length > 0;
  const canFinishTask =
    !isCommitting &&
    !isGeneratingCommitMessages &&
    currentTask !== null &&
    !currentTask.draft &&
    currentTask.status !== 'Completed' &&
    allTaskRepositoriesResolved &&
    reviewSummary.actionCounts.pending_validation === 0 &&
    reviewSummary.actionCounts.ready_to_commit === 0 &&
    hasTaskCommittedRepositories;
  const isValidateChangesDisabled = isCommitting || isGeneratingCommitMessages || !hasPendingValidation;
  const validateChangesDisabledReason = isGeneratingCommitMessages
    ? t('implement.generatingCommitMessages', 'Preparing commit messages...')
    : t(
        'implement.noRemainingChangesToValidate',
        'No remaining unstaged changes to validate.'
      );
  const isCommitDisabled = isCommitting || isGeneratingCommitMessages || !hasReadyToCommit;
  const commitDisabledReason = isGeneratingCommitMessages
    ? t('implement.generatingCommitMessages', 'Preparing commit messages...')
    : t('implement.noValidatedChangesToCommit', 'Validate changes before commit.');

  const displayError = normalizeCommitErrorMessage(
    lastError || '',
    translate
  );
  const outOfScopeMessage = currentTaskLoadState === 'out_of_scope'
    ? currentTaskLoadMessage
    : null;
  const dependencyBlockedMessage = getDependencyBlockedMessage(currentTask, t);
  const isManualDraftEmptyState =
    isManualDraftPendingInitialization(currentTask) &&
    (currentTaskLoadState === 'invalid_mapping' || currentTaskLoadState === 'awaiting_worktree');
  const draftEmptyStateMessage = isManualDraftEmptyState
    ? currentTaskLoadMessage
    : null;
  const mappingError = !dependencyBlockedMessage && !isManualDraftEmptyState &&
    (currentTaskLoadState === 'invalid_mapping' || currentTaskLoadState === 'awaiting_worktree')
    ? currentTaskLoadMessage
    : null;
  const mappingErrorPresentation = mappingError
    ? presentWorktreeError(mappingError, {
        fallbackBody: mappingError,
      })
    : null;
  const displayErrorPresentation = displayError
    ? presentServiceError(displayError, {
        fallbackBody: displayError,
      })
    : null;
  const runCommit = async (
    options: {
      modelConfig?: SmartCommitModelConfig | null;
      messagesByRepositoryId?: Record<string, string>;
    } = {}
  ) => {
    if (isCommitting || isGeneratingCommitMessages || !hasReadyToCommit) return;
    setCommitMessageGenerationError(null);

    try {
      await commitAllReadyTaskRepositories(options);
      setCommitMessageEditState(null);
    } catch (error) {
      const messageText = toServiceError(error).message;
      if (isSmartCommitMessageGenerationError(error)) {
        if (error.generatedMessages) {
          setCommitMessageEditState({
            mode: 'review_generated',
            fieldsByRepositoryId: buildEditableCommitMessages(error.generatedMessages, repositories),
            error: messageText || t(
              'implement.commitMessageValidationFailed',
              'Generated commit messages need manual review.'
            ),
          });
          return;
        }
        setCommitMessageGenerationError(
          messageText ||
            t('implement.commitMessageGenerationFailed', 'Could not generate commit messages.')
        );
        return;
      }
      notify.error(
        normalizeCommitErrorMessage(
          messageText || t('implement.commitFailed', 'Failed to commit changes'),
          translate
        )
      );
    }
  };

  const handleCommit = async () => {
    const persisted = await loadSmartCommitModelConfig();
    const sourceConfig = smartCommitModelConfig === undefined ? persisted : persisted ?? smartCommitModelConfig;
    const normalizedConfig = normalizeCommitModelConfig(sourceConfig);

    setSmartCommitModelConfig(normalizedConfig);
    if (normalizedConfig?.mode === 'dedicated') {
      setCommitModelChoiceMode('dedicated');
      setDedicatedCommitProviderId(normalizedConfig.providerId);
      setDedicatedCommitModelId(normalizedConfig.modelId);
      setDedicatedCommitReasoningEffort(normalizedConfig.reasoningEffort ?? null);
    } else if (normalizedConfig?.mode === 'conversation') {
      setCommitModelChoiceMode('conversation');
    }

    if (normalizedConfig === null) {
      setIsCommitModelChoiceOpen(true);
      return;
    }

    await runCommit({ modelConfig: normalizedConfig });
  };

  const handleWriteCommitMessagesManually = () => {
    setCommitMessageGenerationError(null);
    setCommitMessageEditState({
      mode: 'manual_fallback',
      fieldsByRepositoryId: buildManualCommitMessageDrafts(repositories, {
        taskTitle: currentTask?.title,
      }),
      error: null,
    });
  };

  const handleOpenCommitModelSettings = () => {
    setCommitMessageGenerationError(null);
    openSettings('models');
  };

  const saveAndUseCommitModelConfig = async (config: SmartCommitModelConfig) => {
    const normalizedConfig = normalizeCommitModelConfig(config) ?? config;
    await saveSmartCommitModelConfig(normalizedConfig);
    setSmartCommitModelConfig(normalizedConfig);
    setIsCommitModelChoiceOpen(false);
    await runCommit({ modelConfig: normalizedConfig });
  };

  const handleCommitEditedMessages = async () => {
    if (!commitMessageEditState) return;
    await runCommit({
      messagesByRepositoryId: Object.fromEntries(
        Object.entries(commitMessageEditState.fieldsByRepositoryId).map(([repositoryId, fields]) => [
          repositoryId,
          formatConventionalCommitMessage({ ...fields, scope: null }),
        ])
      ),
    });
  };

  const handleValidateChanges = async () => {
    if (!hasPendingValidation) return;
    try {
      await stageAllTaskChanges();
    } catch (error) {
      notify.error(
        toServiceError(error).message ||
          t('implement.validateChangesFailed', 'Failed to validate and stage changes.')
      );
    }
  };

  const handleStageScope = async (repositoryId: string, changeIds: string[]) => {
    if (changeIds.length === 0) return;
    try {
      await stageChanges(repositoryId, changeIds);
    } catch (error) {
      notify.error(
        toServiceError(error).message ||
          t('implement.validateChangesFailed', 'Failed to validate and stage changes.')
      );
    }
  };

  const handleUnstageScope = async (repositoryId: string, changeIds: string[]) => {
    if (changeIds.length === 0) return;
    if (isReadOnlyRemoteMode) {
      notify.error(REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE);
      return;
    }
    try {
      await unstageChanges(repositoryId, changeIds);
    } catch (error) {
      notify.error(
        toServiceError(error).message ||
          t('implement.unstageFailed', 'Failed to unstage changes.')
      );
    }
  };

  const handleRevert = async (repositoryId: string, changeIds: string[]) => {
    if (changeIds.length === 0) return;
    if (isReadOnlyRemoteMode) {
      notify.error(REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE);
      return;
    }
    try {
      await revertChanges(repositoryId, changeIds);
      notify.success(t('implement.revertSuccess', 'Changes reverted.'));
    } catch (error) {
      const messageText = toServiceError(error).message;
      notify.error(messageText || t('implement.revertFailed', 'Failed to revert changes.'));
    }
  };

  const commitMessageValidationByRepositoryId = useMemo(() => {
    if (!commitMessageEditState) return {};
    return Object.fromEntries(
      Object.entries(commitMessageEditState.fieldsByRepositoryId).map(([repositoryId, fields]) => [
        repositoryId,
        validateConventionalCommitFields({ ...fields, scope: null }),
      ])
    );
  }, [commitMessageEditState]);
  const hasInvalidEditedCommitMessage = Object.values(commitMessageValidationByRepositoryId)
    .some((validation) => !validation.ok);
  const commitMessageEditorRepositories = useMemo(() => (
    repositories.map((repository) => ({
      id: repository.id,
      label: getRepositoryDisplayName(repository, getProjectById(repository.projectId)?.name),
    }))
  ), [getProjectById, repositories]);

  const updateEditedCommitMessageFields = useCallback((
    repositoryId: string,
    patch: Partial<ConventionalCommitFields>
  ) => {
    setCommitMessageEditState((current) => current
      ? {
          ...current,
          fieldsByRepositoryId: {
            ...current.fieldsByRepositoryId,
            [repositoryId]: {
              ...current.fieldsByRepositoryId[repositoryId],
              ...patch,
            },
          },
        }
      : current
    );
  }, []);

  const handleOpenCommit = () => {
    if (isReadOnlyRemoteMode) {
      notify.error(REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE);
      return;
    }
    void handleCommit();
  };

  const handleFinishTask = async () => {
    if (!currentTask || isCommitting || isGeneratingCommitMessages) return;
    try {
      const mergeRuntime = await loadMergeWorkflowReview(currentTask.id, { force: true });
      if (mergeWorkflowNeedsUserDecision(mergeRuntime)) {
        resetReviewState();
        return;
      }
      await finishTask(currentTask.id);
      resetReviewState();
      notify.success(t('implement.taskFinished', 'Task finished'), {
        category: 'task_completed',
      });
    } catch (error) {
      const nextRuntime = useTaskStore.getState().getMergeWorkflowRuntime(currentTask.id);
      const nextViewState = resolveMergeWorkflowViewState(nextRuntime, {
        canArchive: currentTask.task_source === 'plan_finalization',
      });
      if (!nextViewState.isBlocked && !nextViewState.isFailed) {
        const messageText = toServiceError(error).message;
        notify.error(messageText || t('implement.completeTaskFailed', 'Failed to complete task'));
      }
    }
  };
  const primaryAction = canFinishTask
    ? {
        onClick: () => void handleFinishTask(),
        disabled: isGeneratingCommitMessages,
        title: undefined,
        icon: 'git-merge' as const,
        label: t('implement.finishTask', 'Finish task'),
      }
    : {
        onClick: handleOpenCommit,
        disabled: isCommitDisabled,
        title: isCommitDisabled ? commitDisabledReason : undefined,
        icon: 'git-commit' as const,
        label: isGeneratingCommitMessages
          ? t('implement.generatingCommitMessages', 'Preparing commit messages...')
          : t('implement.commitChangesGeneric', 'Commit'),
      };

  const actionLabels = {
    staged: t('implement.stagedBadge', 'Staged'),
    validate: t('implement.validateAction', 'Validate'),
    unstage: t('implement.unstageAction', 'Unstage'),
    revert: t('implement.revertAction', 'Revert'),
  };

  if (isWorkspaceMissing) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
        data-tour-id="implement-changes-panel"
      >
        <ProjectWorkspaceEmptyState
          stateKind={workspaceState.kind}
          variant="secondary"
          panelKind="changes"
        />
      </aside>
    );
  }

  if (!selectedTaskId) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
        data-tour-id="implement-changes-panel"
      >
        <div className="text-center px-6">
          <Icon name="git-compare" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectTaskForValidation', 'Select a task to validate changes')}
          </p>
        </div>
      </aside>
    );
  }

  if (isReadOnlyRemoteMode) {
    return (
      <aside
        className={cn(
          'h-full w-full bg-card border-l border-border flex items-center justify-center',
          className
        )}
        data-tour-id="implement-changes-panel"
      >
        <div className="text-center px-6 max-w-sm">
          <Icon name="lock" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-foreground text-sm font-medium">
            {t(
              'implement.remoteValidationUnavailable',
              'Local validation is not available in remote mode yet.'
            )}
          </p>
          <p className="mt-2 text-muted-foreground text-sm">
            {REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE}
          </p>
        </div>
      </aside>
    );
  }

  if (currentTask && (isPlanFinalizationTask || currentMergeWorkflowRuntime)) {
    return <MergeWorkflowTaskPanel task={currentTask} className={className} />;
  }

  return (
    <aside
      className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}
      data-tour-id="implement-changes-panel"
    >
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="folder-git-2" size={16} className="text-primary" />
          {t('implement.changesValidationPanel', 'Changes')}
        </h1>
      </div>

      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {overallStats.validatedStagedFileCount > 0 && overallStats.pendingVisibleFileCount > 0
              ? translate('implement.overallPendingAndReadyCompact', '{{ready}} ready, {{pending}} pending', {
                  ready: overallStats.validatedStagedFileCount,
                  pending: overallStats.pendingVisibleFileCount,
                })
              : overallStats.validatedStagedFileCount > 0
                ? translate('implement.overallReadyCompact', '{{ready}} ready', {
                    ready: overallStats.validatedStagedFileCount,
                  })
                : translate('implement.overallPendingCompact', '{{pending}} pending', {
                    pending: overallStats.pendingVisibleFileCount,
                  })}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.loadingRepositoryChanges', 'Loading repository changes...')}
          </div>
        )}
        {!isLoading && mappingError && (
          <div className="px-4 py-6">
            {mappingErrorPresentation ? (
              <ActionableErrorCallout
                presentation={mappingErrorPresentation}
                actionLabel={t('common.retry', 'Retry')}
                onAction={() => void loadCurrentChanges()}
                compact
              />
            ) : (
              <div className="text-center text-sm text-muted-foreground">{mappingError}</div>
            )}
          </div>
        )}
        {!isLoading && !mappingError && dependencyBlockedMessage && (
          <TaskBlockedState
            variant="panel"
            title={t('implement.taskBlockedTitle', 'Task blocked')}
            message={dependencyBlockedMessage}
            help={t(
              'implement.taskBlockedChangesHelp',
              'Complete the prerequisite tasks before reviewing changes here.'
            )}
          />
        )}
        {!isLoading && !mappingError && !displayError && outOfScopeMessage && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {outOfScopeMessage}
          </div>
        )}
        {!isLoading && !mappingError && !dependencyBlockedMessage && !displayError && !outOfScopeMessage && draftEmptyStateMessage && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {draftEmptyStateMessage}
          </div>
        )}
        {!isLoading && !dependencyBlockedMessage && displayError && (
          <div className="px-4 py-6">
            {displayErrorPresentation ? (
              <ActionableErrorCallout
                presentation={displayErrorPresentation}
                actionLabel={t('common.retry', 'Retry')}
                onAction={() => void loadCurrentChanges()}
                compact
              />
            ) : (
              <div className="text-center text-sm text-destructive">{displayError}</div>
            )}
          </div>
        )}
        {!isLoading && !mappingError && !dependencyBlockedMessage && !displayError && !outOfScopeMessage && !draftEmptyStateMessage && repositories.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('implement.noPendingChanges', 'No pending file changes for this task yet.')}
          </div>
        )}
        {!isLoading && !mappingError && !dependencyBlockedMessage && !displayError && repositories.map((repository) => {
          const project = getProjectById(repository.projectId);
          const repositorySummary = repositorySummaryById.get(repository.id);
          const isExpanded =
            expandedRepositoryIds[repository.id] ??
            (
              repositories.length === 1 ||
              repository.id === selectedRepositoryId ||
              repositorySummary?.isNextAction ||
              false
            );
          const folderTree = buildFolderTree(repository.changes || []);
          const repositoryError = normalizeCommitErrorMessage(repository.lastError || '', translate);
          const repositoryErrorPresentation = repositoryError
            ? presentServiceError(repositoryError, {
                repoPath: repository.repoPath,
                projectId: repository.projectId,
                fallbackBody: repositoryError,
              })
            : null;
          const repositoryName = getRepositoryDisplayName(repository, project?.name);
          const repositoryHasPendingValidation =
            repository.commitState === 'idle' && repository.stats.pendingVisibleFileCount > 0;
          const repositoryChangeIds = repository.changes
            .filter((change) => change.hasPendingVisibleChange)
            .map((change) => change.id);
          const repositoryStagedChangeIds = repository.changes
            .filter((change) => change.hasValidatedStage)
            .map((change) => change.id);
          const repositoryActionCount = repositoryChangeIds.length + repositoryStagedChangeIds.length;
          return (
            <section
              key={repository.id}
              className={cn(
                'mx-2 flex min-h-0 flex-col',
                isExpanded ? 'min-h-[7rem] flex-1 basis-0' : 'shrink-0'
              )}
            >
              <div
                className={cn(
                  'group relative w-full rounded-xl px-3 py-2.5 transition-colors overflow-hidden',
                  repository.id === selectedRepositoryId || isExpanded
                    ? 'bg-primary/5'
                    : 'bg-card hover:bg-accent/40'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      selectRepository(repository.id);
                      setExpandedRepositoryIds((current) => ({
                        ...current,
                        [repository.id]: !(
                          current[repository.id] ??
                          (repositories.length === 1 ||
                            repository.id === selectedRepositoryId ||
                            repository.id === reviewSummary.nextRepositoryId)
                        ),
                      }));
                    }}
                    className="min-w-0 flex flex-1 appearance-none items-center gap-2 border-0 bg-transparent text-left outline-none"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                      <Icon
                        name={isExpanded ? 'folder-open' : 'folder'}
                        size={15}
                        className="shrink-0 text-primary/80"
                      />
                      <span className="text-sm font-medium text-foreground truncate">
                        {repositoryName}
                      </span>
                      {!isExpanded && repositoryHasPendingValidation && (
                        <span
                          data-pending-validation-indicator="true"
                          className="h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-primary/15 transition-opacity group-hover:opacity-0"
                        />
                      )}
                      {repositorySummary?.isNextAction && !repositorySummary.isSelected && (
                        <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">
                          {t('implement.nextRepository', 'Next')}
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {repositorySummary && (
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded-full text-[10px] shrink-0',
                          repositoryActionCount > 0 && 'transition-opacity group-hover:opacity-0',
                          REVIEW_STATE_CLASSES[repositorySummary.state]
                        )}
                      >
                        {renderRepositoryState(repository, repositorySummary, translate)}
                      </span>
                    )}
                  </div>
                </div>
                {repository.commitState === 'idle' && repositoryActionCount > 0 && (
                  <ScopeActionRail
                    onValidate={
                      repositoryChangeIds.length > 0
                        ? () => void handleStageScope(repository.id, repositoryChangeIds)
                        : undefined
                    }
                    onUnstage={
                      repositoryStagedChangeIds.length > 0
                        ? () => void handleUnstageScope(repository.id, repositoryStagedChangeIds)
                        : undefined
                    }
                    onRevert={
                      repositoryChangeIds.length > 0
                        ? () => setPendingRevertScope({
                          repositoryId: repository.id,
                          changeIds: repositoryChangeIds,
                          scopeLabel: repositoryName,
                        })
                        : undefined
                    }
                    labels={actionLabels}
                    className="rounded-r-xl"
                  />
                )}
              </div>

              {isExpanded && (
                <div className="ml-4 mr-3 mb-3 flex min-h-0 flex-1 flex-col pl-2">
                  <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
                    {repositoryError && (
                      <div className="px-2 py-3">
                        {repositoryErrorPresentation ? (
                          <ActionableErrorCallout
                            presentation={repositoryErrorPresentation}
                            actionLabel={t('common.retry', 'Retry')}
                            onAction={() => void loadCurrentChanges({ silent: true })}
                            compact
                          />
                        ) : (
                          <div className="text-center text-sm text-destructive">{repositoryError}</div>
                        )}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'committed' && (
                      <div className="px-2 py-8 text-center text-sm text-primary">
                        {t('implement.repositoryCommittedHelp', 'This repository has already been committed for this task.')}
                      </div>
                    )}
                    {!repositoryError && repository.commitState === 'no_changes' && (
                      <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                        {t('implement.repositoryNoChangesHelp', 'No pending file changes for this repository.')}
                      </div>
                    )}
                    {!repositoryError &&
                      repository.commitState === 'idle' &&
                      folderTree.length === 0 &&
                      repository.stats.validatedStagedFileCount === 0 && (
                        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                          {t('implement.noPendingChanges', 'No pending file changes for this repository.')}
                        </div>
                      )}
                    {!repositoryError && repository.commitState === 'idle' && folderTree.map((node) => (
                      <FolderTreeItem
                        repositoryId={repository.id}
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedChangeId={repository.selectedChangeId}
                        onFileClick={(changeId) => {
                          selectRepository(repository.id);
                          openDiffModal(repository.id, changeId);
                        }}
                        onStageChanges={(changeIds) => {
                          selectRepository(repository.id);
                          void handleStageScope(repository.id, changeIds);
                        }}
                        onUnstageChanges={(changeIds) => {
                          selectRepository(repository.id);
                          void handleUnstageScope(repository.id, changeIds);
                        }}
                        onRevert={(changeIds, scopeLabel, requiresConfirm) => {
                          selectRepository(repository.id);
                          if (requiresConfirm) {
                            setPendingRevertScope({
                              repositoryId: repository.id,
                              changeIds,
                              scopeLabel,
                            });
                            return;
                          }
                          void handleRevert(repository.id, changeIds);
                        }}
                        labels={actionLabels}
                      />
                    ))}
                  </div>

                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="p-3 border-t border-border shrink-0 space-y-2">
        {showValidateChangesButton && (
          <button
            onClick={handleValidateChanges}
            data-tour-id="implement-validate-changes"
            disabled={isValidateChangesDisabled}
            title={isValidateChangesDisabled ? validateChangesDisabledReason : undefined}
            className={cn(
              'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
              isValidateChangesDisabled
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            <Icon name="check-circle" size={14} />
            {t('implement.validateChanges', 'Validate changes')}
          </button>
        )}
        <button
          onClick={primaryAction.onClick}
          data-tour-id="implement-commit-changes"
          disabled={primaryAction.disabled}
          title={primaryAction.title}
          className={cn(
            'w-full py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
            primaryAction.disabled
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'
          )}
        >
          <Icon name={primaryAction.icon} size={14} />
          {primaryAction.label}
        </button>
      </div>

      {isDiffModalOpen && selectedDiffTarget && (
        <FileChangesDiffModal
          onClose={closeDiffModal}
        />
      )}

      {pendingRevertScope && (
        <ConfirmPromptModal
          isOpen={true}
          title={t('implement.revertScopeTitle', 'Revert these changes?')}
          description={t(
            'implement.revertScopeDescription',
            'This will discard the local changes for "{{scope}}".',
            { scope: pendingRevertScope.scopeLabel }
          )}
          confirmLabel={t('implement.revertAction', 'Revert')}
          cancelLabel={t('common.cancel', 'Cancel')}
          confirmVariant="error"
          onCancel={() => setPendingRevertScope(null)}
          onConfirm={() => {
            const scope = pendingRevertScope;
            setPendingRevertScope(null);
            void handleRevert(scope.repositoryId, scope.changeIds);
          }}
        />
      )}

      {isCommitModelChoiceOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setIsCommitModelChoiceOpen(false)}
          />
          <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <h3 className="text-sm font-semibold text-foreground">
                {t('implement.commitModelChoiceTitle', 'Choose commit message model')}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  'implement.commitModelChoiceDescription',
                  'Macro can generate commit messages with the active conversation model or with a dedicated model for every commit.'
                )}
              </p>

              <div className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/20 p-1 sm:grid-cols-2">
                <button
                  type="button"
                  className={cn(
                    'rounded-md px-3 py-2 text-sm transition-colors',
                    commitModelChoiceMode === 'conversation'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                  onClick={() => setCommitModelChoiceMode('conversation')}
                >
                  {t('implement.commitModelConversation', 'Conversation model')}
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded-md px-3 py-2 text-sm transition-colors',
                    commitModelChoiceMode === 'dedicated'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                  onClick={() => setCommitModelChoiceMode('dedicated')}
                >
                  {t('implement.commitModelDedicated', 'Dedicated model')}
                </button>
              </div>

              {commitModelChoiceMode === 'dedicated' && (
                <div className="mt-4 space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('settings.providers', 'AI Providers')}
                    </span>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                      value={dedicatedCommitProviderId}
                      onChange={(event) => {
                        const providerId = event.target.value;
                        const firstModel = (modelsByProvider[providerId] || [])
                          .find((model) => model.isEnabled !== false);
                        setDedicatedCommitProviderId(providerId);
                        setDedicatedCommitModelId(firstModel?.id ?? '');
                        setDedicatedCommitReasoningEffort(null);
                      }}
                    >
                      <option value="">{t('chat.selectProvider', 'Select a provider')}</option>
                      {enabledCommitProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('chat.selectModel', 'Select a model')}
                    </span>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                      value={dedicatedCommitModelId}
                      onChange={(event) => {
                        setDedicatedCommitModelId(event.target.value);
                        setDedicatedCommitReasoningEffort(null);
                      }}
                      disabled={!dedicatedCommitProviderId}
                    >
                      <option value="">{t('chat.selectModel', 'Select a model')}</option>
                      {dedicatedCommitModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name || model.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {dedicatedCommitReasoningEfforts.length > 0 && (
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('models.reasoningEffort', 'Reasoning')}
                      </span>
                      <select
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                        value={dedicatedCommitReasoningEffort ?? ''}
                        onChange={(event) =>
                          setDedicatedCommitReasoningEffort(
                            event.target.value ? event.target.value as ReasoningEffort : null
                          )
                        }
                      >
                        <option value="">{t('models.defaultReasoning', 'Default')}</option>
                        {dedicatedCommitReasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" size="sm" onClick={() => setIsCommitModelChoiceOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                disabled={commitModelChoiceMode === 'dedicated' && !canUseDedicatedCommitModel}
                onClick={() => {
                  const config: SmartCommitModelConfig = commitModelChoiceMode === 'dedicated'
                    ? {
                        mode: 'dedicated',
                        providerId: dedicatedCommitProviderId,
                        modelId: dedicatedCommitModelId,
                        reasoningEffort: dedicatedCommitReasoningEffort,
                      }
                    : { mode: 'conversation' };
                  void saveAndUseCommitModelConfig(config);
                }}
              >
                {t('common.continue', 'Continue')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {commitMessageEditState && (
        <CommitMessageEditorModal
          t={translate}
          mode={commitMessageEditState.mode}
          error={commitMessageEditState.error}
          fieldsByRepositoryId={commitMessageEditState.fieldsByRepositoryId}
          repositories={commitMessageEditorRepositories}
          validationsByRepositoryId={commitMessageValidationByRepositoryId}
          isCommitting={isCommitting}
          isGeneratingCommitMessages={isGeneratingCommitMessages}
          hasInvalidMessage={hasInvalidEditedCommitMessage}
          onCancel={() => setCommitMessageEditState(null)}
          onRetryGeneration={() => {
            setCommitMessageEditState(null);
            void handleCommit();
          }}
          onCommit={() => void handleCommitEditedMessages()}
          onUpdateFields={updateEditedCommitMessageFields}
        />
      )}

      {commitMessageGenerationError && (
        <CommitMessageGenerationFailureModal
          t={translate}
          error={commitMessageGenerationError}
          isGeneratingCommitMessages={isGeneratingCommitMessages}
          onRetryGeneration={() => {
            setCommitMessageGenerationError(null);
            void handleCommit();
          }}
          onWriteManually={handleWriteCommitMessagesManually}
          onOpenCommitModelSettings={handleOpenCommitModelSettings}
          onCancel={() => setCommitMessageGenerationError(null)}
        />
      )}
    </aside>
  );
};

export const FileChangesPanel = React.memo(FileChangesPanelBase);

export default FileChangesPanel;
