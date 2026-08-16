import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { open } from '@tauri-apps/plugin-dialog';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';
import { useAppStore, type MetadataSyncRepositoryStatus } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useChatStore } from '../../stores/useChatStore';
import { hasUnreadNotifications, useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { toServiceError } from '../../services/contracts/errors';
import * as tauriIpc from '../../services/tauriIpc';
import {
  buildMacroConflictAssistantPrompt,
  toMacroConflictResolutionEntries,
  type ConflictResolutionEntry,
} from '../../services/conflictResolution';
import { openConflictAssistant } from '../../services/conflictAssistantService';
import { ConflictResolutionPanel } from '../conflicts/ConflictResolutionPanel';
import { createMacroSyncService, getMacroSyncDescription } from '../../services/macroSyncService';
import { resolveFooterGitContext } from '../../services/footerGitContext';
import { NotificationCenterPopover } from './NotificationCenterPopover';
import {
  presentMetadataSyncIssue,
  resolveDegradedErrorPresentation,
} from '../../services/degradedErrorPresentation';
import { cn } from '../../utils/cn';

type FooterSyncAction = 'fetch' | 'pull' | 'push';
type CodeDivergenceStrategy = 'merge' | 'rebase' | 'fastForward';
type CodeDivergenceAction = CodeDivergenceStrategy | 'abort' | 'discard';
type CodeDivergencePreflightStatus =
  | 'checking'
  | 'available'
  | 'conflicts'
  | 'blocked'
  | 'failed';
type MacroConflictContext = FooterSyncAction | 'refresh';
type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

interface ScopedProject {
  id: string;
  name: string;
  path: string;
  source: 'project' | 'folder';
}

interface CodeStatusSnapshot {
  branch: string | null;
  ahead: number;
  behind: number;
}

interface RepositorySyncResult {
  projectName: string;
  success: boolean;
  message: string;
}

interface CodeDivergenceEntry {
  project: ScopedProject;
  branch: string;
  upstreamBranch: string;
  ahead: number;
  behind: number;
  isClean: boolean;
  mergeInProgress: boolean;
  conflictFiles: string[];
  preflight: Record<CodeDivergenceStrategy, CodeDivergencePreflight>;
}

interface CodeDivergenceResolution {
  entries: CodeDivergenceEntry[];
  error: string | null;
}

interface CodeDivergencePreflight {
  status: CodeDivergencePreflightStatus;
  conflictFiles: string[];
  error: string | null;
}

interface CodeDivergenceStrategySummary {
  status: CodeDivergencePreflightStatus;
  conflictFiles: string[];
}

interface FooterMetadataSyncState {
  state: tauriIpc.MacroSyncState;
  error: string | null;
  reason: tauriIpc.MacroSyncReason | null;
  nextAction: tauriIpc.MacroSyncNextAction | null;
  conflictFiles: string[];
  repositories: MetadataSyncRepositoryStatus[];
}

interface PushRemoteResolutionEntry {
  projectId: string | null;
  projectName: string;
  repoPath: string;
  url: string;
  source: 'code' | 'metadata' | 'code_and_metadata';
}

interface PushPreflightCodeEntry {
  project: ScopedProject;
  status: tauriIpc.GitStatusDto | null;
  error: string | null;
}

interface MetadataOriginCandidate {
  repoPath: string;
  projectId: string | null;
  reason: tauriIpc.MacroSyncReason | null;
  nextAction: tauriIpc.MacroSyncNextAction | null;
}

type MacroSyncResultWithRepositories = tauriIpc.MacroBranchSyncDto & {
  repositories?: MetadataSyncRepositoryStatus[];
};

interface PushMissingOriginResolution {
  kind: 'missing_origin';
  scopeProjects: ScopedProject[];
  readyProjects: ScopedProject[];
  entries: PushRemoteResolutionEntry[];
  error: string | null;
}

interface PushMissingUpstreamResolution {
  kind: 'missing_upstream';
  macroResult: tauriIpc.MacroBranchSyncDto;
  scopeProjects: ScopedProject[];
  context: 'push' | 'resolve';
}

type PushResolutionState = PushMissingOriginResolution | PushMissingUpstreamResolution;

const DEFAULT_CODE_STATUS: CodeStatusSnapshot = { branch: null, ahead: 0, behind: 0 };
const DEFAULT_FOOTER_METADATA_SYNC: FooterMetadataSyncState = {
  state: 'clean',
  error: null,
  reason: null,
  nextAction: null,
  conflictFiles: [],
  repositories: [],
};
const CODE_DIVERGENCE_STRATEGIES: CodeDivergenceStrategy[] = ['merge', 'rebase', 'fastForward'];
const CODE_DIVERGENCE_STATUS_PRIORITY: CodeDivergencePreflightStatus[] = [
  'checking',
  'conflicts',
  'blocked',
  'failed',
  'available',
];

const uniqueStrings = (items: string[]): string[] =>
  Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));

const getFolderName = (path: string): string => {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
};

const createCodeDivergencePreflight = (
  status: CodeDivergencePreflightStatus,
  options?: { conflictFiles?: string[]; error?: string | null }
): CodeDivergencePreflight => ({
  status,
  conflictFiles: uniqueStrings(options?.conflictFiles ?? []),
  error: options?.error ?? null,
});

const createCheckingCodeDivergencePreflights = (): Record<
  CodeDivergenceStrategy,
  CodeDivergencePreflight
> => ({
  merge: createCodeDivergencePreflight('checking'),
  rebase: createCodeDivergencePreflight('checking'),
  fastForward: createCodeDivergencePreflight('checking'),
});

const formatGitOutput = (output: string | null | undefined, t: TranslateFn): string => {
  const normalized = (output || '').trim();
  if (!normalized) return t('footer.sync.done', 'Done.');
  return normalized.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' | ');
};

const getDefaultUpstreamBranchName = (branch: string): string => `origin/${branch}`;

const isDirtyWorktreeError = (message: string | null | undefined): boolean => {
  const normalized = (message || '').toLowerCase();
  return normalized.includes('commit or stash') || normalized.includes('not clean');
};

const isUnmergedIndexError = (message: string | null | undefined): boolean => {
  const normalized = (message || '').toLowerCase();
  return normalized.includes('not fully merged index') || normalized.includes('unmerged');
};

const getConflictMarkerIndex = (message: string): { index: number; marker: string } | null => {
  const normalized = message.toLowerCase();
  const markers = ['conflicts in:', 'conflicts:'];
  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      return { index, marker };
    }
  }
  return null;
};

const extractConflictFilesFromError = (message: string | null | undefined): string[] => {
  const raw = (message || '').trim();
  if (!raw) return [];

  const marker = getConflictMarkerIndex(raw);
  if (!marker) {
    const files: string[] = [];
    const conflictPattern = /\bCONFLICT\s*\([^)]+\):[^\n]*?\bin\s+([^\s,;]+)/gi;
    let match = conflictPattern.exec(raw);
    while (match) {
      files.push(match[1] ?? '');
      match = conflictPattern.exec(raw);
    }
    return uniqueStrings(files);
  }

  return uniqueStrings(raw
    .slice(marker.index + marker.marker.length)
    .split(',')
    .map((item) => item.trim().replace(/[.;]$/, ''))
    .filter(Boolean));
};

const getConflictFilesFromDto = (dto: { conflictFiles?: string[]; conflict_files?: string[] }): string[] =>
  uniqueStrings([...(dto.conflictFiles ?? []), ...(dto.conflict_files ?? [])]);

const summarizeConflictError = (message: string | null | undefined): string | null => {
  const raw = (message || '').trim();
  if (!raw) return null;

  const marker = getConflictMarkerIndex(raw);
  if (!marker) return raw;

  const prefix = raw.slice(0, marker.index).trim().replace(/\s*(because of)?\s*$/i, '').trim();
  return prefix ? `${prefix} because of conflicts.` : 'Conflict files need manual resolution.';
};

const getStatusConflictFiles = (status: tauriIpc.GitStatusDto): string[] =>
  Array.from(new Set([...(status.conflictedFiles || []), ...((status.conflicted_files as string[] | undefined) || [])]));

const getStatusMergeInProgress = (status: tauriIpc.GitStatusDto): boolean =>
  Boolean(status.mergeInProgress ?? status.merge_in_progress);

const buildCodeDivergencePreflightFromError = (error: unknown): CodeDivergencePreflight => {
  const message = toServiceError(error).message;
  const conflictFiles = extractConflictFilesFromError(message);
  const normalized = message.toLowerCase();
  if (conflictFiles.length > 0 || normalized.includes('conflict')) {
    return createCodeDivergencePreflight('conflicts', {
      conflictFiles,
      error: summarizeConflictError(message),
    });
  }
  if (isDirtyWorktreeError(message) || isUnmergedIndexError(message)) {
    return createCodeDivergencePreflight('blocked', { error: summarizeConflictError(message) });
  }
  return createCodeDivergencePreflight('failed', { error: summarizeConflictError(message) });
};

const buildMergeCodeDivergencePreflight = (
  check: tauriIpc.GitMergeCheckDto
): CodeDivergencePreflight => {
  const conflictFiles = getConflictFilesFromDto(check);
  if (check.mergeable) {
    return createCodeDivergencePreflight('available');
  }
  return createCodeDivergencePreflight(conflictFiles.length > 0 ? 'conflicts' : 'failed', {
    conflictFiles,
  });
};

const buildRebaseCodeDivergencePreflight = (
  check: tauriIpc.GitRebaseCheckDto
): CodeDivergencePreflight => {
  const conflictFiles = uniqueStrings([
    ...getConflictFilesFromDto(check),
    ...extractConflictFilesFromError(check.output),
  ]);
  if (check.rebaseable) {
    return createCodeDivergencePreflight('available');
  }
  return createCodeDivergencePreflight(
    conflictFiles.length > 0 || check.output.toLowerCase().includes('conflict')
      ? 'conflicts'
      : 'failed',
    { conflictFiles }
  );
};

const summarizeCodeDivergenceStrategy = (
  entries: CodeDivergenceEntry[],
  strategy: CodeDivergenceStrategy
): CodeDivergenceStrategySummary => {
  const statuses = entries.map((entry) => entry.preflight[strategy].status);
  const status =
    CODE_DIVERGENCE_STATUS_PRIORITY.find((candidate) => statuses.includes(candidate)) ?? 'failed';
  return {
    status,
    conflictFiles: uniqueStrings(entries.flatMap((entry) => entry.preflight[strategy].conflictFiles)),
  };
};

const unavailableGitStatus = (branch: string): tauriIpc.GitStatusDto => ({
  branch,
  head_commit: null,
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  conflicted_files: [],
  merge_in_progress: false,
  conflictedFiles: [],
  mergeInProgress: false,
  is_clean: false,
  has_origin: false,
  has_upstream: false,
  ahead: 0,
  behind: 0,
});

interface CodeDivergenceResolutionModalProps {
  resolution: CodeDivergenceResolution;
  action: CodeDivergenceAction | null;
  t: TranslateFn;
  onClose: () => void;
  onResolve: (strategy: CodeDivergenceStrategy, options?: { stashFirst?: boolean }) => void;
  onAbortMerge: () => void;
  onDiscardLocalChanges: () => void;
  onOpenConflictAssistant: () => void;
}

const CodeDivergenceResolutionModal: React.FC<CodeDivergenceResolutionModalProps> = ({
  resolution,
  action,
  t,
  onClose,
  onResolve,
  onAbortMerge,
  onDiscardLocalChanges,
  onOpenConflictAssistant,
}) => {
  const hasMergeInProgress = resolution.entries.some((entry) => entry.mergeInProgress);
  const hasLocalChanges = resolution.entries.some((entry) => !entry.isClean);
  const strategySummaries = {
    merge: summarizeCodeDivergenceStrategy(resolution.entries, 'merge'),
    rebase: summarizeCodeDivergenceStrategy(resolution.entries, 'rebase'),
    fastForward: summarizeCodeDivergenceStrategy(resolution.entries, 'fastForward'),
  } satisfies Record<CodeDivergenceStrategy, CodeDivergenceStrategySummary>;
  const conflictFiles = uniqueStrings([
    ...resolution.entries.flatMap((entry) => entry.conflictFiles),
    ...CODE_DIVERGENCE_STRATEGIES.flatMap((strategy) => strategySummaries[strategy].conflictFiles),
    ...extractConflictFilesFromError(resolution.error),
  ]);
  const isChecking = CODE_DIVERGENCE_STRATEGIES.some(
    (strategy) => strategySummaries[strategy].status === 'checking'
  );
  const hasConflicts = CODE_DIVERGENCE_STRATEGIES.some(
    (strategy) => strategySummaries[strategy].status === 'conflicts'
  );
  const hasFailedPreflight = CODE_DIVERGENCE_STRATEGIES.some((strategy) =>
    ['failed', 'blocked'].includes(strategySummaries[strategy].status)
  );
  const availableStrategies = CODE_DIVERGENCE_STRATEGIES.filter(
    (strategy) => !hasMergeInProgress && strategySummaries[strategy].status === 'available'
  );
  const shouldCloseOnly = !hasMergeInProgress && !isChecking && availableStrategies.length === 0;

  const getStatusLabel = (status: CodeDivergencePreflightStatus): string => {
    switch (status) {
      case 'available':
        return t('footer.sync.preflightAvailable', 'Available');
      case 'conflicts':
        return t('footer.sync.preflightConflicts', 'Conflicts');
      case 'blocked':
        return t('footer.sync.preflightBlockedByLocalChanges', 'Blocked by local changes');
      case 'checking':
        return t('footer.sync.preflightChecking', 'Checking');
      case 'failed':
        return t('footer.sync.preflightFailed', 'Failed');
      default:
        return status;
    }
  };

  const getActionLabel = (strategy: CodeDivergenceStrategy): string => {
    if (strategy === 'merge') {
      return hasLocalChanges
        ? t('footer.sync.stashThenMerge', 'Stash, then merge')
        : t('footer.sync.mergeRemoteBranch', 'Merge');
    }
    if (strategy === 'rebase') {
      return hasLocalChanges
        ? t('footer.sync.stashThenRebase', 'Stash, then rebase')
        : t('footer.sync.rebaseOntoRemote', 'Rebase');
    }
    return hasLocalChanges
      ? t('footer.sync.stashThenFastForward', 'Stash, then fast-forward')
      : t('footer.sync.fastForwardOntoRemote', 'Fast-forward');
  };

  const getStrategyLabel = (strategy: CodeDivergenceStrategy): string => {
    if (strategy === 'merge') return t('footer.sync.mergeRemoteBranch', 'Merge');
    if (strategy === 'rebase') return t('footer.sync.rebaseOntoRemote', 'Rebase');
    return t('footer.sync.fastForwardOntoRemote', 'Fast-forward');
  };

  const statusTone = hasMergeInProgress || hasConflicts
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : hasLocalChanges
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : 'border-border/80 bg-muted/20 text-muted-foreground';
  const statusIcon = hasMergeInProgress || hasConflicts ? 'triangle-alert' : 'alert-circle';
  const statusTitle = hasMergeInProgress
    ? t('footer.sync.codeDivergenceMergeInProgressTitle', 'Merge in progress')
    : isChecking
      ? t('footer.sync.codeDivergenceCheckingTitle', 'Checking integration strategies')
      : hasConflicts
        ? t('footer.sync.codeDivergenceConflictTitle', 'Conflicts detected')
        : hasFailedPreflight
          ? t('footer.sync.codeDivergencePreflightFailedTitle', 'Preflight could not complete')
          : hasLocalChanges
            ? t('footer.sync.codeDivergenceDirtyTitle', 'Local changes detected')
            : t('footer.sync.codeDivergenceReadyTitle', 'Ready to integrate remote commits');
  const statusBody = hasMergeInProgress
    ? t(
        'footer.sync.codeDivergenceMergeInProgressBody',
        'Abort the current merge before trying another sync action.'
      )
    : isChecking
      ? t(
          'footer.sync.codeDivergenceCheckingBody',
          'Macro is checking merge and rebase before offering an action.'
        )
      : hasConflicts && availableStrategies.length === 0
        ? t(
            'footer.sync.codeDivergenceAllConflictBody',
            'Merge and rebase would conflict. Resolve these files manually, then retry.'
          )
        : hasConflicts
          ? t(
              'footer.sync.codeDivergenceSomeConflictBody',
              'One strategy would conflict. Use the available strategy or resolve the files manually.'
            )
          : hasFailedPreflight
            ? t(
                'footer.sync.codeDivergencePreflightFailedBody',
                'Macro could not prove a safe integration strategy. Close and refresh before retrying.'
              )
            : hasLocalChanges
              ? t(
                  'footer.sync.codeDivergenceDirtyWorktree',
                  'Macro will stash local changes before running the selected action.'
                )
              : t(
                  'footer.sync.codeDivergenceReadyBody',
                  'Rebase keeps history linear; merge preserves a merge commit.'
                );

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-divergence-title"
      >
        <div className="border-b border-border/80 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
              <Icon name="git-merge" size={16} />
            </div>
            <div className="min-w-0">
              <h3 id="code-divergence-title" className="text-sm font-semibold text-foreground">
                {t('footer.sync.codeDivergencePromptTitle', 'Branch has diverged from remote')}
              </h3>
              <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                {t(
                  'footer.sync.codeDivergencePromptDescription',
                  'This branch has local commits and remote commits. Choose how to integrate the remote commits.'
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className={cn('rounded-md border px-3 py-2.5 text-xs leading-5', statusTone)}>
            <div className="flex items-start gap-2">
              <Icon name={statusIcon} size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{statusTitle}</div>
                <div className="mt-0.5">{statusBody}</div>
                {!hasMergeInProgress && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {CODE_DIVERGENCE_STRATEGIES.map((strategy) => {
                      const summary = strategySummaries[strategy];
                      const isAvailable = summary.status === 'available';
                      return (
                        <div
                          key={strategy}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded border px-2.5 py-2',
                            isAvailable
                              ? 'border-emerald-500/20 bg-emerald-500/10'
                              : summary.status === 'checking'
                                ? 'border-border/70 bg-background/40'
                                : summary.status === 'conflicts'
                                  ? 'border-red-500/20 bg-red-500/10'
                                  : 'border-amber-500/20 bg-amber-500/10'
                          )}
                        >
                          <span className="font-medium text-foreground">{getStrategyLabel(strategy)}</span>
                          <span
                            className={cn(
                              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                              isAvailable
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : summary.status === 'checking'
                                  ? 'bg-muted text-muted-foreground'
                                  : summary.status === 'conflicts'
                                    ? 'bg-red-500/15 text-red-200'
                                    : 'bg-amber-500/15 text-amber-200'
                            )}
                          >
                            {getStatusLabel(summary.status)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="max-h-44 space-y-2 overflow-y-auto">
            {resolution.entries.map((entry) => (
              <div
                key={`${entry.project.id}:${entry.branch}`}
                className="rounded-md border border-border/80 bg-background/40 px-3 py-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {entry.project.name}
                  </span>
                  <span className="shrink-0 font-medium text-muted-foreground">
                    ↓ {entry.behind} · ↑ {entry.ahead}
                  </span>
                </div>
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="git-branch" size={12} className="shrink-0 text-blue-400" />
                  <span className="truncate">{entry.branch}</span>
                  <span className="shrink-0 text-muted-foreground/70">
                    {t('footer.sync.from', 'from')}
                  </span>
                  <span className="truncate">{entry.upstreamBranch}</span>
                  {!entry.isClean && !entry.mergeInProgress && (
                    <span className="ml-auto shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                      {t('footer.sync.localChangesBadge', 'local changes')}
                    </span>
                  )}
                  {entry.mergeInProgress && (
                    <span className="ml-auto shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                      {t('footer.sync.mergeInProgressBadge', 'merge in progress')}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {(hasMergeInProgress || hasConflicts) && conflictFiles.length > 0 && (
            <div className="rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2.5 text-xs">
              <div className="mb-2 font-medium text-red-200">
                {t('footer.sync.conflictedFiles', 'Conflicted files')}
              </div>
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto pr-1">
                {conflictFiles.map((file) => (
                  <span
                    key={file}
                    className="max-w-full truncate rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-100"
                    title={file}
                  >
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className={cn(
            'flex items-center border-t border-border/80 bg-muted/10 px-5 py-3',
            shouldCloseOnly ? 'justify-end' : 'gap-2'
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={Boolean(action)}
            onClick={onClose}
          >
            {shouldCloseOnly ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {hasLocalChanges && !hasMergeInProgress && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={Boolean(action)}
                onClick={() => {
                  const firstAvailable = availableStrategies[0];
                  if (firstAvailable) {
                    onResolve(firstAvailable, { stashFirst: true });
                  }
                }}
              >
                {t('footer.sync.stashAndRetry', 'Stash and retry')}
              </Button>
            )}
            {hasLocalChanges && !hasMergeInProgress && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={Boolean(action)}
                isLoading={action === 'discard'}
                onClick={onDiscardLocalChanges}
              >
                {t('footer.sync.discardLocalChanges', 'Discard local changes')}
              </Button>
            )}
            {hasConflicts && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={Boolean(action)}
                onClick={onOpenConflictAssistant}
              >
                {t('footer.sync.openConflictAssistant', 'Open conflict assistant')}
              </Button>
            )}
            {!shouldCloseOnly && (
              hasMergeInProgress ? (
                <Button
                  type="button"
                  variant="error"
                  size="sm"
                  disabled={Boolean(action)}
                  isLoading={action === 'abort'}
                  onClick={onAbortMerge}
                >
                  {t('footer.sync.abortMerge', 'Abort merge')}
                </Button>
              ) : (
                availableStrategies.map((strategy) => (
                  <Button
                    key={strategy}
                    type="button"
                    variant={availableStrategies.length === 1 || strategy === 'rebase' ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={Boolean(action)}
                    isLoading={action === strategy}
                    onClick={() => onResolve(strategy, { stashFirst: hasLocalChanges })}
                  >
                    {getActionLabel(strategy)}
                  </Button>
                ))
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Footer: React.FC = () => {
  const { t } = useTranslation();
  const translate = useCallback<TranslateFn>(
    (key, fallback, options) => String(t(key, { defaultValue: fallback, ...(options || {}) })),
    [t]
  );
  const isTauriRuntime = tauriIpc.isTauriAvailable();
  const {
    mode,
    selectedProjectId,
    standaloneProjects,
    projectGroups,
    selectedTaskId,
    activeArchitectPlanId,
    visibleArchitectPlans,
    metadataMissingUpstreamPolicy,
    setMetadataMissingUpstreamPolicy,
  } = useAppStore(useShallow((state) => ({
    mode: state.mode,
    selectedProjectId: state.selectedProjectId,
    standaloneProjects: state.standaloneProjects ?? [],
    projectGroups: state.projectGroups,
    selectedTaskId: state.selectedTaskId,
    activeArchitectPlanId: state.activeArchitectPlanId,
    visibleArchitectPlans: state.visibleArchitectPlans,
    metadataMissingUpstreamPolicy: state.metadataMissingUpstreamPolicy,
    setMetadataMissingUpstreamPolicy: state.setMetadataMissingUpstreamPolicy,
  })));
  const tasks = useTaskStore((state) => state.tasks);
  const { conversations, selectedConversationId } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    selectedConversationId: state.selectedConversationId,
  })));
  const notificationItems = useNotificationCenterStore((state) => state.items);
  const isNotificationCenterOpen = useNotificationCenterStore((state) => state.isCenterOpen);
  const setNotificationCenterOpen = useNotificationCenterStore((state) => state.setCenterOpen);

  const [gitScopeProjectId, setGitScopeProjectId] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<{ name: string; path: string } | null>(null);
  const [codeStatus, setCodeStatus] = useState(DEFAULT_CODE_STATUS);
  const [focusedProjectBranch, setFocusedProjectBranch] = useState<string | null>(null);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);
  const [footerMetadataSync, setFooterMetadataSync] = useState<FooterMetadataSyncState>(
    DEFAULT_FOOTER_METADATA_SYNC
  );
  const [syncAction, setSyncAction] = useState<FooterSyncAction | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [codeDivergenceResolution, setCodeDivergenceResolution] =
    useState<CodeDivergenceResolution | null>(null);
  const [codeDivergenceAction, setCodeDivergenceAction] =
    useState<CodeDivergenceAction | null>(null);
  const [pushResolution, setPushResolution] = useState<PushResolutionState | null>(null);
  const [isConfiguringRemote, setIsConfiguringRemote] = useState(false);
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);

  const refreshRef = useRef<Promise<void> | null>(null);
  const focusedBranchRequestIdRef = useRef(0);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);
  const footerMetadataSyncRef = useRef(footerMetadataSync);

  const registeredProjectCount = standaloneProjects.length + projectGroups.reduce(
    (count, group) => count + group.projects.length,
    0,
  );
  const canSelectFolder = mode === 'Architect' && registeredProjectCount === 0;

  const gitContext = useMemo(() => resolveFooterGitContext({
    mode,
    standaloneProjects,
    projectGroups,
    selectedTaskId,
    tasks,
    activeArchitectPlanId,
    visibleArchitectPlans,
    selectedConversationId,
    conversations,
    durableFocusProjectId: selectedProjectId,
    manualProjectId: gitScopeProjectId,
    selectedFolder: canSelectFolder ? selectedFolder : null,
  }), [activeArchitectPlanId, canSelectFolder, conversations, gitScopeProjectId, mode, projectGroups, selectedConversationId, selectedFolder, selectedProjectId, selectedTaskId, standaloneProjects, tasks, visibleArchitectPlans]);
  const focusProjects = gitContext.candidates;
  const focusedProject = gitContext.project;
  const scopeProjects = useMemo<ScopedProject[]>(
    () => (focusedProject ? [focusedProject] : []),
    [focusedProject]
  );
  const selectedProjectLabel = useMemo(
    () => focusedProject?.name ?? t('footer.scope.selectRepository', 'Sélectionner un dépôt'),
    [focusedProject, t]
  );
  const syncsMacroMetadata = focusedProject?.source === 'project';
  const setFooterMetadataSyncStatus = useCallback((params: {
    state: tauriIpc.MacroSyncState;
    error?: string | null;
    reason?: tauriIpc.MacroSyncReason | null;
    nextAction?: tauriIpc.MacroSyncNextAction | null;
    conflictFiles?: string[];
    repositories?: MetadataSyncRepositoryStatus[];
  }) => {
    setFooterMetadataSync({
      state: params.state,
      error: params.error ?? null,
      reason: params.reason ?? null,
      nextAction: params.nextAction ?? null,
      conflictFiles: params.state === 'conflict' ? (params.conflictFiles ?? []) : [],
      repositories: params.repositories ?? [],
    });
  }, []);
  const createMacroSyncServiceForProjects = useCallback((projects: ScopedProject[]) =>
    createMacroSyncService({
      tauriIpc,
      getAppState: () => ({
        ...useAppStore.getState(),
        setMetadataSyncStatus: setFooterMetadataSyncStatus,
      }),
      toServiceError,
      resolveTargets: async () => projects.map((project) => ({ repoPath: project.path, projectId: project.id })),
    }), [setFooterMetadataSyncStatus]);
  const scopedMacroSyncService = useMemo(
    () => createMacroSyncServiceForProjects(scopeProjects),
    [createMacroSyncServiceForProjects, scopeProjects]
  );

  const codeBehind = codeStatus.behind;
  const codeAhead = codeStatus.ahead;
  const macroBehind = macroSnapshot?.behind ?? 0;
  const macroAhead = macroSnapshot?.ahead ?? 0;
  const pullCountLabel = macroBehind > 0 ? `${codeBehind}@${macroBehind}` : String(codeBehind);
  const pushCountLabel = macroAhead > 0 ? `${codeAhead}@${macroAhead}` : String(codeAhead);
  const hasPullWork = codeBehind > 0 || macroBehind > 0;
  const hasPushWork = codeAhead > 0 || macroAhead > 0;
  const branchActionSuffix = focusedProjectBranch ? ` · ${focusedProjectBranch}` : '';
  const fetchActionLabel = `${t('footer.sync.refreshTitle', 'Rafraîchir l’état du code et du sync @macro')}${branchActionSuffix}`;
  const pullActionLabel = `${t('footer.sync.pull', 'Pull')}${branchActionSuffix}`;
  const pushActionLabel = `${t('footer.sync.push', 'Push')}${branchActionSuffix}`;
  const hasUnreadNotificationDot = useMemo(() => hasUnreadNotifications(notificationItems), [notificationItems]);
  const hasMissingUpstream =
    footerMetadataSync.reason === 'missing_upstream' &&
    footerMetadataSync.nextAction === 'push';
  const hasMissingOrigin =
    footerMetadataSync.reason === 'missing_origin' ||
    footerMetadataSync.nextAction === 'configure_remote';
  const shouldPromptForMissingUpstream =
    hasMissingUpstream && metadataMissingUpstreamPolicy !== 'ignore';
  const macroNeedsAttention =
    !hasMissingOrigin &&
    (
      footerMetadataSync.state === 'conflict' ||
      footerMetadataSync.state === 'failed' ||
      shouldPromptForMissingUpstream
    );
  const isMissingUpstreamResolution = shouldPromptForMissingUpstream && footerMetadataSync.state !== 'conflict';
  const canUseMacroAssistant =
    !isMissingUpstreamResolution &&
    (
      footerMetadataSync.state === 'conflict' ||
      footerMetadataSync.reason === 'merge_conflict' ||
      footerMetadataSync.reason === 'diverged' ||
      footerMetadataSync.reason === 'unknown_error'
    );

  const presentConflictIfNeeded = useCallback((result: tauriIpc.MacroBranchSyncDto, context: MacroConflictContext) => {
    if (result.state !== 'conflict') return;
    lastMacroConflictActionRef.current = context;
    setShowConflictModal(true);
    if (Date.now() - lastConflictToastAtRef.current < 12000) return;
    notify.error(t('footer.sync.macroConflictDetected', '@macro conflict detected'), {
      description: t('footer.sync.macroConflictGenericDescription', '@macro has unresolved conflicts. Resolve them, then retry the same sync step.'),
      category: 'git_sync_attention_required',
    });
    lastConflictToastAtRef.current = Date.now();
  }, [t]);

  useEffect(() => {
    setGitScopeProjectId(null);
  }, [gitContext.contextKey]);

  useEffect(() => {
    if (!canSelectFolder) setSelectedFolder(null);
  }, [canSelectFolder]);

  useEffect(() => {
    if (!gitScopeProjectId) return;
    if (!focusProjects.some((project) => project.id === gitScopeProjectId)) {
      setGitScopeProjectId(null);
    }
  }, [focusProjects, gitScopeProjectId]);

  useEffect(() => {
    footerMetadataSyncRef.current = footerMetadataSync;
  }, [footerMetadataSync]);

  const selectFolderScope = useCallback(async () => {
    if (!isTauriRuntime || !canSelectFolder || isSelectingFolder) return;
    setIsSelectingFolder(true);
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: t('footer.scope.selectFolder', 'Sélectionner un dossier Git'),
      });
      if (typeof selectedPath !== 'string' || !selectedPath.trim()) return;
      const path = selectedPath.trim();
      try {
        await tauriIpc.gitStatus(path);
      } catch (error) {
        notify.error(t('footer.scope.folderNotGit', 'Ce dossier n’est pas un dépôt Git.'), {
          description: toServiceError(error).message,
        });
        return;
      }
      setSelectedFolder({ name: getFolderName(path), path });
    } catch (error) {
      notify.error(t('footer.scope.folderSelectionFailed', 'Impossible de sélectionner ce dossier.'), {
        description: toServiceError(error).message,
      });
    } finally {
      setIsSelectingFolder(false);
    }
  }, [canSelectFolder, isSelectingFolder, isTauriRuntime, t]);

  const refreshCodeStatus = useCallback(async () => {
    if (!isTauriRuntime || scopeProjects.length === 0) {
      setCodeStatus(DEFAULT_CODE_STATUS);
      return;
    }

    const unavailableLabel = t('footer.sync.branchUnavailable', 'unavailable');
    const detachedLabel = t('footer.sync.branchDetached', 'detached');
    const statuses = await Promise.all(scopeProjects.map(async (project) => {
      try {
        return await tauriIpc.gitStatus(project.path);
      } catch {
        return unavailableGitStatus(unavailableLabel);
      }
    }));

    setCodeStatus({
      branch: statuses[0]?.branch || detachedLabel,
      ahead: statuses.reduce((sum, status) => sum + status.ahead, 0),
      behind: statuses.reduce((sum, status) => sum + status.behind, 0),
    });
  }, [isTauriRuntime, scopeProjects, t]);

  const focusedProjectPath = focusedProject?.path ?? null;

  const refreshFocusedProjectBranch = useCallback(async () => {
    const requestId = ++focusedBranchRequestIdRef.current;
    if (!isTauriRuntime || !focusedProjectPath) {
      if (requestId === focusedBranchRequestIdRef.current) setFocusedProjectBranch(null);
      return;
    }

    const unavailableLabel = t('footer.sync.branchUnavailable', 'unavailable');
    const detachedLabel = t('footer.sync.branchDetached', 'detached');
    try {
      const status = await tauriIpc.gitStatus(focusedProjectPath);
      if (requestId === focusedBranchRequestIdRef.current) {
        setFocusedProjectBranch(status.branch || detachedLabel);
      }
    } catch {
      if (requestId === focusedBranchRequestIdRef.current) {
        setFocusedProjectBranch(unavailableLabel);
      }
    }
  }, [focusedProjectPath, isTauriRuntime, t]);

  const readScopedCodeStatuses = useCallback(async (projects: ScopedProject[] = scopeProjects) => {
    const entries: PushPreflightCodeEntry[] = [];
    for (const project of projects) {
      try {
        entries.push({ project, status: await tauriIpc.gitStatus(project.path), error: null });
      } catch (error) {
        entries.push({ project, status: null, error: toServiceError(error).message });
      }
    }
    return entries;
  }, [scopeProjects]);

  const findDivergentCodeEntries = useCallback(async (
    projects: ScopedProject[]
  ): Promise<CodeDivergenceEntry[]> => {
    const statuses = await readScopedCodeStatuses(projects);
    return statuses.flatMap((entry): CodeDivergenceEntry[] => {
      const status = entry.status;
      if (
        !status ||
        !status.has_upstream ||
        !status.branch ||
        status.ahead <= 0 ||
        status.behind <= 0
      ) {
        return [];
      }

      return [{
        project: entry.project,
        branch: status.branch,
        upstreamBranch: getDefaultUpstreamBranchName(status.branch),
        ahead: status.ahead,
        behind: status.behind,
        isClean: status.is_clean,
        mergeInProgress: getStatusMergeInProgress(status),
        conflictFiles: getStatusConflictFiles(status),
        preflight: createCheckingCodeDivergencePreflights(),
      }];
    });
  }, [readScopedCodeStatuses]);

  const buildMissingOriginResolution = useCallback((
    codeEntries: PushPreflightCodeEntry[],
    macroResult: tauriIpc.MacroBranchSyncDto | null,
    projects: ScopedProject[] = scopeProjects
  ): PushMissingOriginResolution | null => {
    const entriesByPath = new Map<string, PushRemoteResolutionEntry>();
    const addEntry = (
      project: { id: string | null; name: string; path: string },
      source: PushRemoteResolutionEntry['source']
    ) => {
      const existing = entriesByPath.get(project.path);
      if (existing) {
        existing.source = existing.source === source ? source : 'code_and_metadata';
        return;
      }
      entriesByPath.set(project.path, {
        projectId: project.id,
        projectName: project.name,
        repoPath: project.path,
        url: '',
        source,
      });
    };

    for (const entry of codeEntries) {
      if (entry.status && !entry.status.has_origin) {
        addEntry(entry.project, 'code');
      }
    }

    const macroRepositories = (macroResult as MacroSyncResultWithRepositories | null)?.repositories ?? [];
    const metadataRepositories: MetadataOriginCandidate[] = macroRepositories.length
      ? macroRepositories
      : macroResult?.reason === 'missing_origin'
        ? projects.map((project) => ({
            repoPath: project.path,
            projectId: project.id,
            reason: macroResult.reason,
            nextAction: macroResult.next_action,
          }))
        : [];

    for (const repository of metadataRepositories) {
      if (repository.reason !== 'missing_origin' && repository.nextAction !== 'configure_remote') {
        continue;
      }
      const project = projects.find((candidate) => candidate.path === repository.repoPath);
      addEntry({
        id: repository.projectId ?? project?.id ?? null,
        name: project?.name ?? repository.repoPath,
        path: repository.repoPath,
      }, 'metadata');
    }

    const entries = Array.from(entriesByPath.values());
    if (entries.length === 0) return null;
    const missingPaths = new Set(entries.map((entry) => entry.repoPath));
    const readyProjects = codeEntries
      .filter((entry) => entry.status?.has_origin && !missingPaths.has(entry.project.path))
      .map((entry) => entry.project);

    return {
      kind: 'missing_origin',
      scopeProjects: projects,
      readyProjects,
      entries,
      error: null,
    };
  }, [scopeProjects]);

  const refreshMacroStatus = useCallback(async (ensure = false) => {
    if (!isTauriRuntime || !syncsMacroMetadata) {
      setMacroSnapshot(null);
      setFooterMetadataSync(DEFAULT_FOOTER_METADATA_SYNC);
      return null;
    }
    const result = await scopedMacroSyncService.refreshMacroSyncStatus({ ensure });
    if (result) {
      setMacroSnapshot(result);
    }
    return result;
  }, [isTauriRuntime, scopedMacroSyncService, syncsMacroMetadata]);

  const refreshFooterStatus = useCallback(async (options?: { ensureMacro?: boolean; showBusy?: boolean }) => {
    if (refreshRef.current) return refreshRef.current;
    const run = (async () => {
      if (options?.showBusy) setIsRefreshing(true);
      try {
        await Promise.all([refreshCodeStatus(), refreshMacroStatus(Boolean(options?.ensureMacro))]);
      } finally {
        if (options?.showBusy) setIsRefreshing(false);
      }
    })().finally(() => {
      if (refreshRef.current === run) refreshRef.current = null;
    });
    refreshRef.current = run;
    return run;
  }, [refreshCodeStatus, refreshMacroStatus]);

  useEffect(() => {
    let cancelled = false;
    const refreshCurrentScope = async () => {
      if (refreshRef.current) await refreshRef.current;
      if (!cancelled) await refreshFooterStatus({ ensureMacro: true });
    };
    void refreshCurrentScope();
    return () => {
      cancelled = true;
    };
  }, [refreshFooterStatus]);

  useEffect(() => {
    void refreshFocusedProjectBranch();
  }, [refreshFocusedProjectBranch]);

  const runCodeAction = useCallback(async (
    action: FooterSyncAction,
    projects: ScopedProject[] = scopeProjects
  ): Promise<RepositorySyncResult[]> => {
    const results: RepositorySyncResult[] = [];
    for (const project of projects) {
      try {
        const result = action === 'fetch'
          ? await tauriIpc.gitFetch({ repoPath: project.path })
          : action === 'pull'
            ? await tauriIpc.gitPull({ repoPath: project.path })
            : await tauriIpc.gitPush({ repoPath: project.path });
        results.push({ projectName: project.name, success: true, message: formatGitOutput(result.output, translate) });
      } catch (error) {
        results.push({ projectName: project.name, success: false, message: toServiceError(error).message });
      }
    }
    return results;
  }, [scopeProjects, translate]);

  const isDivergenceError = useCallback((message: string | null | undefined): boolean => {
    const normalized = (message || '').toLowerCase();
    return (
      normalized.includes('diverged') ||
      normalized.includes('non-fast-forward') ||
      normalized.includes('not possible to fast-forward') ||
      normalized.includes('rejected') ||
      normalized.includes('fetch first') ||
      normalized.includes('behind')
    );
  }, []);

  const buildCodeDivergenceEntryFromFailure = useCallback((
    project: ScopedProject,
    status: tauriIpc.GitStatusDto | null
  ): CodeDivergenceEntry | null => {
    const branch = status?.branch ?? null;
    if (!branch || !status?.has_upstream) {
      return null;
    }
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    if (ahead <= 0 && behind <= 0) {
      return null;
    }
    return {
      project,
      branch,
      upstreamBranch: getDefaultUpstreamBranchName(branch),
      ahead,
      behind,
      isClean: status.is_clean ?? false,
      mergeInProgress: getStatusMergeInProgress(status),
      conflictFiles: getStatusConflictFiles(status),
      preflight: {
        merge: createCodeDivergencePreflight('checking'),
        rebase: createCodeDivergencePreflight('checking'),
        fastForward: createCodeDivergencePreflight('checking'),
      },
    };
  }, []);

  const buildFastForwardPreflight = useCallback((entry: CodeDivergenceEntry): CodeDivergencePreflight => {
    if (entry.mergeInProgress) {
      return createCodeDivergencePreflight('blocked', {
        conflictFiles: entry.conflictFiles,
        error: t(
          'footer.sync.fastForwardBlockedMergeInProgress',
          'Cannot fast-forward while a merge is in progress.'
        ),
      });
    }
    if (entry.ahead > 0) {
      return createCodeDivergencePreflight('blocked', {
        error: t(
          'footer.sync.fastForwardBlockedLocalCommits',
          'Local commits prevent a fast-forward. Use merge or rebase instead.'
        ),
      });
    }
    if (entry.behind <= 0) {
      return createCodeDivergencePreflight('blocked', {
        error: t(
          'footer.sync.fastForwardBlockedNoRemoteCommits',
          'No remote commits to fast-forward to.'
        ),
      });
    }
    return createCodeDivergencePreflight('available');
  }, [t]);

  const runCodeDivergencePreflight = useCallback(async (entries: CodeDivergenceEntry[]) => {
    const checkedEntries = await Promise.all(entries.map(async (entry) => {
      let nextEntry = entry;

      try {
        await tauriIpc.gitFetch({
          repoPath: entry.project.path,
          branch: entry.branch,
        });
      } catch (error) {
        const failure = buildCodeDivergencePreflightFromError(error);
        return {
          ...entry,
          preflight: {
            merge: failure,
            rebase: failure,
            fastForward: failure,
          },
        };
      }

      try {
        const status = await tauriIpc.gitStatus(entry.project.path);
        nextEntry = {
          ...entry,
          branch: status.branch || entry.branch,
          upstreamBranch: getDefaultUpstreamBranchName(status.branch || entry.branch),
          ahead: status.ahead,
          behind: status.behind,
          isClean: status.is_clean,
          mergeInProgress: getStatusMergeInProgress(status),
          conflictFiles: getStatusConflictFiles(status),
        };
      } catch {
        nextEntry = entry;
      }

      if (nextEntry.mergeInProgress) {
        const blocked = createCodeDivergencePreflight('blocked', {
          conflictFiles: nextEntry.conflictFiles,
        });
        return {
          ...nextEntry,
          preflight: {
            merge: blocked,
            rebase: blocked,
            fastForward: buildFastForwardPreflight(nextEntry),
          },
        };
      }

      const [mergePreflight, rebasePreflight] = await Promise.all([
        tauriIpc.gitMergeCheck({
          repoPath: nextEntry.project.path,
          branchName: nextEntry.upstreamBranch,
          intoBranch: nextEntry.branch,
        })
          .then(buildMergeCodeDivergencePreflight)
          .catch(buildCodeDivergencePreflightFromError),
        tauriIpc.gitRebaseCheck({
          repoPath: nextEntry.project.path,
          branchName: nextEntry.branch,
          ontoBranch: nextEntry.upstreamBranch,
        })
          .then(buildRebaseCodeDivergencePreflight)
          .catch(buildCodeDivergencePreflightFromError),
      ]);

      return {
        ...nextEntry,
        preflight: {
          merge: mergePreflight,
          rebase: rebasePreflight,
          fastForward: buildFastForwardPreflight(nextEntry),
        },
      };
    }));

    const checkedByPath = new Map(checkedEntries.map((entry) => [entry.project.path, entry] as const));
    setCodeDivergenceResolution((current) => {
      if (!current) return null;
      return {
        ...current,
        entries: current.entries.map((entry) =>
          checkedByPath.get(entry.project.path) ?? entry
        ),
      };
    });
  }, [buildFastForwardPreflight]);

  const describeMacroResultForToast = useCallback((action: FooterSyncAction, result: tauriIpc.MacroBranchSyncDto | null) => {
    if (!result) {
      return '';
    }

    if (result.reason === 'dirty') {
      return action === 'fetch'
        ? t(
          'footer.sync.fetchDirtyDescription',
          'Le fetch du code est terminé. @macro sera enregistré automatiquement au prochain pull ou push du code.'
        )
        : t(
          'footer.sync.macroDirtyDescription',
          '@macro sera enregistré automatiquement avant la synchronisation du code.'
        );
    }

    return `@macro: ${getMacroSyncDescription(result) || formatGitOutput(result.output, translate)}`;
  }, [t, translate]);

  const runPushPreflight = useCallback(async (projects: ScopedProject[]) => {
    const shouldSyncMetadata = projects.some((project) => project.source === 'project');
    const macroSyncService = shouldSyncMetadata
      ? createMacroSyncServiceForProjects(projects)
      : null;
    const [codePreflight, preflight] = await Promise.all([
      readScopedCodeStatuses(projects),
      macroSyncService?.refreshMacroSyncStatus({ ensure: true }) ?? Promise.resolve(null),
    ]);
    if (preflight) {
      setMacroSnapshot(preflight);
    }
    const missingOriginResolution = buildMissingOriginResolution(codePreflight, preflight, projects);
    return {
      codePreflight,
      macroResult: preflight,
      missingOriginResolution,
      pushableProjects: missingOriginResolution?.readyProjects ?? projects,
    };
  }, [buildMissingOriginResolution, createMacroSyncServiceForProjects, readScopedCodeStatuses]);

  const handleSyncAction = useCallback(async (
    action: FooterSyncAction,
    options?: {
      publishMissingUpstream?: boolean;
      skipMissingUpstreamPrompt?: boolean;
      projects?: ScopedProject[];
    }
  ) => {
    const actionProjects = options?.projects ?? scopeProjects;
    if (!isTauriRuntime || syncAction || actionProjects.length === 0) return;
    const actionMacroSyncService = options?.projects
      ? createMacroSyncServiceForProjects(actionProjects)
      : scopedMacroSyncService;
    const shouldSyncMetadata = actionProjects.some((project) => project.source === 'project');
    setSyncAction(action);
    lastMacroConflictActionRef.current = action;
    try {
      if (action !== 'fetch' && codeAhead > 0 && codeBehind > 0) {
        const divergentEntries = await findDivergentCodeEntries(actionProjects);
        if (divergentEntries.length > 0) {
          setCodeDivergenceResolution({
            entries: divergentEntries,
            error: null,
          });
          await runCodeDivergencePreflight(divergentEntries);
          return;
        }
      }

      if (action === 'push') {
        const { macroResult: preflight, missingOriginResolution } = await runPushPreflight(actionProjects);

        if (missingOriginResolution) {
          setPushResolution(missingOriginResolution);
          return;
        }

        if (
          metadataMissingUpstreamPolicy !== 'ignore' &&
          !options?.publishMissingUpstream &&
          !options?.skipMissingUpstreamPrompt &&
          preflight?.reason === 'missing_upstream' &&
          preflight.next_action === 'push'
        ) {
          setPushResolution({ kind: 'missing_upstream', macroResult: preflight, scopeProjects: actionProjects, context: 'push' });
          return;
        }
      }

      const codeResults = await runCodeAction(action, actionProjects);
      const failures = codeResults.filter((result) => !result.success);

      if (failures.length > 0 && (action === 'pull' || action === 'push')) {
        const failedProjectNames = new Set(failures.map((failure) => failure.projectName));
        const resolutionEntries: CodeDivergenceEntry[] = [];
        for (const project of actionProjects) {
          if (!failedProjectNames.has(project.name)) continue;
          const failure = failures.find((candidate) => candidate.projectName === project.name);
          if (!failure || !isDivergenceError(failure.message)) continue;
          let status: tauriIpc.GitStatusDto | null = null;
          try {
            status = await tauriIpc.gitStatus(project.path);
          } catch {
            status = null;
          }
          const entry = buildCodeDivergenceEntryFromFailure(project, status);
          if (entry) {
            resolutionEntries.push(entry);
          }
        }
        if (resolutionEntries.length > 0) {
          const description = failures
            .slice(0, 2)
            .map((failure) => `${failure.projectName}: ${failure.message}`)
            .join(' | ');
          setCodeDivergenceResolution({
            entries: resolutionEntries,
            error: description,
          });
          await runCodeDivergencePreflight(resolutionEntries);
          return;
        }
      }

      let macroResult = shouldSyncMetadata
        ? action === 'fetch'
          ? await actionMacroSyncService.refreshMacroSyncStatus({ ensure: true })
          : await actionMacroSyncService.syncMacroMetadataForCodeAction({ action })
        : null;
      if (
        action === 'push' &&
        macroResult?.reason === 'missing_upstream' &&
        macroResult.next_action === 'push'
      ) {
        if (options?.publishMissingUpstream) {
          macroResult = await actionMacroSyncService.pushMacroMetadata();
        } else if (
          metadataMissingUpstreamPolicy !== 'ignore' &&
          !options?.skipMissingUpstreamPrompt
        ) {
          setPushResolution({ kind: 'missing_upstream', macroResult, scopeProjects: actionProjects, context: 'push' });
        }
      }
      if (macroResult) {
        setMacroSnapshot(macroResult);
        presentConflictIfNeeded(macroResult, action);
      }

      const successes = codeResults.filter((result) => result.success).length;
      const codeSummary = codeResults.length > 0
        ? [`${successes}/${codeResults.length} repos`, ...failures.slice(0, 2).map((result) => `${result.projectName}: ${result.message}`)].join(' | ')
        : '';
      const macroSummary = describeMacroResultForToast(action, macroResult);
      const description = [codeSummary, macroSummary].filter(Boolean).join(' | ');
      const hasMacroBlocker =
        macroResult?.state === 'failed' ||
        macroResult?.state === 'conflict' ||
        macroResult?.next_action === 'configure_auth' ||
        macroResult?.next_action === 'configure_remote' ||
        macroResult?.next_action === 'resolve_conflict' ||
        (action === 'push' && macroResult?.next_action === 'pull');
      const hasErrors = failures.length > 0 || macroResult?.state === 'failed' || macroResult?.state === 'conflict';
      const hasPending = macroResult?.state === 'pending' && hasMacroBlocker;
      if (hasErrors) {
        notify.error(t(`footer.sync.${action}Incomplete`, `${action} incomplete`), {
          description,
          category: 'git_sync_attention_required',
        });
      } else if (hasPending) {
        notify.info(t(`footer.sync.${action}Pending`, `${action} requires attention`), {
          description,
          category: 'git_sync_attention_required',
        });
      } else {
        notify.success(t(`footer.sync.${action}Complete`, `${action} complete`), {
          description,
          category: 'git_sync_completed',
        });
      }
    } finally {
      await refreshFooterStatus({ ensureMacro: action === 'fetch' });
      setSyncAction(null);
    }
  }, [codeAhead, codeBehind, createMacroSyncServiceForProjects, describeMacroResultForToast, findDivergentCodeEntries, isDivergenceError, isTauriRuntime, metadataMissingUpstreamPolicy, presentConflictIfNeeded, refreshFooterStatus, runCodeAction, runCodeDivergencePreflight, runPushPreflight, scopeProjects, scopedMacroSyncService, syncAction, t, buildCodeDivergenceEntryFromFailure]);

  const macroConflictEntries = useMemo<ConflictResolutionEntry[]>(() => {
    const repositories = footerMetadataSync.repositories.length > 0 ? footerMetadataSync.repositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: footerMetadataSync.state,
      error: footerMetadataSync.error,
      reason: footerMetadataSync.reason,
      nextAction: footerMetadataSync.nextAction,
      conflictFiles: footerMetadataSync.conflictFiles,
    }));
    return toMacroConflictResolutionEntries(repositories);
  }, [footerMetadataSync, macroSnapshot, scopeProjects]);
  const metadataSyncPresentation = useMemo(
    () => resolveDegradedErrorPresentation(
      presentMetadataSyncIssue({
        reason: footerMetadataSync.reason,
        nextAction: footerMetadataSync.nextAction,
        error: footerMetadataSync.error,
        repoPath: macroSnapshot?.worktree_path || null,
      }),
      (key, options) => String(t(key, options))
    ),
    [footerMetadataSync.error, footerMetadataSync.nextAction, footerMetadataSync.reason, macroSnapshot?.worktree_path, t]
  );

  const openAiConflictAssistant = async () => {
    const repositories = footerMetadataSync.repositories.length > 0 ? footerMetadataSync.repositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: footerMetadataSync.state,
      error: footerMetadataSync.error,
      reason: footerMetadataSync.reason,
      nextAction: footerMetadataSync.nextAction,
      conflictFiles: footerMetadataSync.conflictFiles,
    }));
    try {
      await openConflictAssistant({
        prompt: buildMacroConflictAssistantPrompt({ repositories }),
      });
      notify.success(t('footer.sync.aiConflictAssistantStarted', 'AI conflict assistant started'));
      setShowConflictModal(false);
    } catch (error) {
      notify.error(t('footer.sync.aiConflictAssistantStartFailed', 'Failed to start AI assistant'), {
        description: toServiceError(error).message,
      });
    }
  };

  const handleRetryMacroSync = async () => {
    if (isMissingUpstreamResolution) {
      const result = await scopedMacroSyncService.pushMacroMetadata();
      if (result) {
        setMacroSnapshot(result);
        if (result.state !== 'pending' || result.reason !== 'missing_upstream') {
          setShowConflictModal(false);
        }
      }
      await refreshFooterStatus({ showBusy: true });
      return;
    }

    const action = lastMacroConflictActionRef.current;
    if (action === 'fetch' || action === 'pull' || action === 'push') {
      await handleSyncAction(action);
      return;
    }
    await refreshFooterStatus({ ensureMacro: true, showBusy: true });
    if (footerMetadataSyncRef.current.state !== 'conflict') setShowConflictModal(false);
  };

  const continuePushAfterMissingUpstreamChoice = async (
    choice: 'push_macro' | 'ignore_forever' | 'ask_next_time'
  ) => {
    if (!pushResolution || pushResolution.kind !== 'missing_upstream') return;
    const projects = pushResolution.scopeProjects;
    setPushResolution(null);
    if (choice === 'ignore_forever') {
      setMetadataMissingUpstreamPolicy('ignore');
    }
    await handleSyncAction('push', {
      projects,
      publishMissingUpstream: choice === 'push_macro',
      skipMissingUpstreamPrompt: choice !== 'push_macro',
    });
  };

  const resolveMissingUpstreamChoice = async (
    choice: 'push_macro' | 'ignore_forever'
  ) => {
    if (!pushResolution || pushResolution.kind !== 'missing_upstream') return;
    const macroSyncService = createMacroSyncServiceForProjects(pushResolution.scopeProjects);
    setPushResolution(null);
    if (choice === 'ignore_forever') {
      setMetadataMissingUpstreamPolicy('ignore');
      return;
    }

    const result = await macroSyncService.pushMacroMetadata();
    if (result) {
      setMacroSnapshot(result);
    }
    await refreshFooterStatus({ showBusy: true });
  };

  const updatePushResolutionRemoteUrl = (repoPath: string, url: string) => {
    setPushResolution((current) => {
      if (!current || current.kind !== 'missing_origin') return current;
      return {
        ...current,
        error: null,
        entries: current.entries.map((entry) =>
          entry.repoPath === repoPath ? { ...entry, url } : entry
        ),
      };
    });
  };

  const configureMissingOriginsAndContinue = async () => {
    if (!pushResolution || pushResolution.kind !== 'missing_origin') return;
    const entries = pushResolution.entries;
    const entriesToConfigure = entries.filter((entry) => entry.url.trim().length > 0);
    if (pushResolution.readyProjects.length === 0 && entriesToConfigure.length === 0) {
      setPushResolution({
        ...pushResolution,
        error: t(
          'footer.sync.remoteUrlRequired',
          'Enter at least one origin URL, or cancel to keep every repository local.'
        ),
      });
      return;
    }

    setIsConfiguringRemote(true);
    try {
      for (const entry of entriesToConfigure) {
        await tauriIpc.gitRemoteAddOrigin({
          repoPath: entry.repoPath,
          url: entry.url.trim(),
        });
      }
      const { missingOriginResolution, pushableProjects } = await runPushPreflight(pushResolution.scopeProjects);
      if (pushableProjects.length === 0) {
        setPushResolution({
          ...(missingOriginResolution ?? pushResolution),
          error: t(
            'footer.sync.remoteUrlRequired',
            'Enter at least one origin URL, or cancel to keep every repository local.'
          ),
        });
        return;
      }
      setPushResolution(null);
      await refreshFooterStatus({ ensureMacro: true, showBusy: true });
      await handleSyncAction('push', { projects: pushableProjects });
    } catch (error) {
      setPushResolution({
        ...pushResolution,
        error: toServiceError(error).message,
      });
    } finally {
      setIsConfiguringRemote(false);
    }
  };

  const ignoreMissingUpstreamFromResolve = () => {
    setMetadataMissingUpstreamPolicy('ignore');
    setShowConflictModal(false);
  };

  const resolveCodeDivergence = async (
    strategy: CodeDivergenceStrategy,
    options?: { stashFirst?: boolean }
  ) => {
    if (!codeDivergenceResolution || codeDivergenceAction) return;
    if (codeDivergenceResolution.entries.some((entry) => entry.preflight[strategy].status !== 'available')) {
      return;
    }
    setCodeDivergenceAction(strategy);

    const failures: RepositorySyncResult[] = [];
    const successes: RepositorySyncResult[] = [];
    const stashedRepos: string[] = [];
    const nextEntries = [...codeDivergenceResolution.entries];

    try {
      for (const [entryIndex, entry] of codeDivergenceResolution.entries.entries()) {
        try {
          await tauriIpc.gitFetch({
            repoPath: entry.project.path,
            branch: entry.branch,
          });

          if (options?.stashFirst) {
            const latestStatus = await tauriIpc.gitStatus(entry.project.path);
            if (!latestStatus.is_clean) {
              await tauriIpc.gitStash({
                repoPath: entry.project.path,
                message: `Macro: stash before ${strategy} ${entry.branch}`,
              });
              stashedRepos.push(entry.project.path);
            }
          }

          let output: string;
          if (strategy === 'rebase') {
            output = await tauriIpc.gitRebaseBranch({
              repoPath: entry.project.path,
              branchName: entry.branch,
              ontoBranch: entry.upstreamBranch,
              confirm: true,
            });
          } else if (strategy === 'merge') {
            output = await tauriIpc.gitMerge({
              repoPath: entry.project.path,
              branchName: entry.upstreamBranch,
              intoBranch: entry.branch,
            });
          } else {
            output = await tauriIpc.gitFastForward({
              repoPath: entry.project.path,
              sourceBranch: entry.upstreamBranch,
              targetBranch: entry.branch,
            });
          }

          successes.push({
            projectName: entry.project.name,
            success: true,
            message: formatGitOutput(output, translate),
          });
        } catch (error) {
          const failedPreflight = buildCodeDivergencePreflightFromError(error);
          try {
            const status = await tauriIpc.gitStatus(entry.project.path);
            nextEntries[entryIndex] = {
              ...entry,
              isClean: status.is_clean,
              mergeInProgress: getStatusMergeInProgress(status),
              conflictFiles: uniqueStrings([
                ...getStatusConflictFiles(status),
                ...failedPreflight.conflictFiles,
              ]),
              preflight: {
                ...entry.preflight,
                [strategy]: failedPreflight,
              },
            };
          } catch {
            nextEntries[entryIndex] = {
              ...entry,
              conflictFiles: uniqueStrings([
                ...entry.conflictFiles,
                ...failedPreflight.conflictFiles,
              ]),
              preflight: {
                ...entry.preflight,
                [strategy]: failedPreflight,
              },
            };
          }
          failures.push({
            projectName: entry.project.name,
            success: false,
            message: toServiceError(error).message,
          });
        }
      }

      if (failures.length > 0) {
        const description = failures
          .slice(0, 2)
          .map((failure) => `${failure.projectName}: ${failure.message}`)
          .join(' | ');
        setCodeDivergenceResolution({
          ...codeDivergenceResolution,
          entries: nextEntries,
          error: description,
        });
        notify.error(t('footer.sync.codeDivergenceFailed', 'Could not resolve branch divergence'), {
          description,
          category: 'git_sync_attention_required',
        });
        return;
      }

      setCodeDivergenceResolution(null);
      notify.success(t('footer.sync.codeDivergenceResolved', 'Branch divergence resolved'), {
        description: successes.map((success) => success.projectName).join(', '),
        category: 'git_sync_completed',
      });
      if (stashedRepos.length > 0) {
        notify.info(
          t(
            'footer.sync.stashPreservedForManualPop',
            'Macro stashed local changes before resolving. Pop them manually with `git stash pop` once you are ready.'
          ),
          {
            description: stashedRepos.join(', '),
            category: 'git_sync_completed',
          }
        );
      }
    } finally {
      await refreshFooterStatus({ showBusy: true });
      setCodeDivergenceAction(null);
    }
  };

  const abortCodeDivergenceMerge = async () => {
    if (!codeDivergenceResolution || codeDivergenceAction) return;
    const entries = codeDivergenceResolution.entries.filter((entry) => entry.mergeInProgress);
    if (entries.length === 0) return;

    setCodeDivergenceAction('abort');
    const failures: RepositorySyncResult[] = [];
    try {
      for (const entry of entries) {
        try {
          await tauriIpc.gitAbortMerge({
            repoPath: entry.project.path,
            confirm: true,
          });
        } catch (error) {
          failures.push({
            projectName: entry.project.name,
            success: false,
            message: toServiceError(error).message,
          });
        }
      }

      if (failures.length > 0) {
        const description = failures
          .slice(0, 2)
          .map((failure) => `${failure.projectName}: ${failure.message}`)
          .join(' | ');
        setCodeDivergenceResolution({
          ...codeDivergenceResolution,
          error: description,
        });
        notify.error(t('footer.sync.abortMergeFailed', 'Could not abort merge'), {
          description,
          category: 'git_sync_attention_required',
        });
        return;
      }

      setCodeDivergenceResolution(null);
      notify.success(t('footer.sync.mergeAborted', 'Merge aborted'), {
        category: 'git_sync_completed',
      });
    } finally {
      await refreshFooterStatus({ showBusy: true });
      setCodeDivergenceAction(null);
    }
  };

  const discardCodeDivergenceLocalChanges = async () => {
    if (!codeDivergenceResolution || codeDivergenceAction) return;
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        t(
          'footer.sync.discardLocalChangesConfirm',
          'Discard all uncommitted changes in the listed repositories? This cannot be undone.'
        )
      );
      if (!confirmed) return;
    }
    setCodeDivergenceAction('discard');
    const failures: RepositorySyncResult[] = [];
    const successes: string[] = [];
    try {
      for (const entry of codeDivergenceResolution.entries) {
        try {
          const status = await tauriIpc.gitStatus(entry.project.path);
          if (status.is_clean) {
            successes.push(entry.project.name);
            continue;
          }
          const paths = uniqueStrings([
            ...status.staged_files.flatMap((file) => [file.old_path ?? '', file.path]),
            ...status.unstaged_files.flatMap((file) => [file.old_path ?? '', file.path]),
            ...status.untracked_files.flatMap((file) => [file.old_path ?? '', file.path]),
          ]);
          if (paths.length > 0) {
            await tauriIpc.gitRestorePaths({
              repoPath: entry.project.path,
              paths,
              target: 'staged_and_worktree',
            });
          }
          successes.push(entry.project.name);
        } catch (error) {
          failures.push({
            projectName: entry.project.name,
            success: false,
            message: toServiceError(error).message,
          });
        }
      }

      if (failures.length > 0) {
        const description = failures
          .slice(0, 2)
          .map((failure) => `${failure.projectName}: ${failure.message}`)
          .join(' | ');
        setCodeDivergenceResolution({
          ...codeDivergenceResolution,
          error: description,
        });
        notify.error(
          t('footer.sync.discardLocalChangesFailed', 'Failed to discard local changes'),
          { description, category: 'git_sync_attention_required' }
        );
        return;
      }

      setCodeDivergenceResolution(null);
      notify.success(
        t('footer.sync.localChangesDiscarded', 'Local changes discarded'),
        {
          description: successes.join(', '),
          category: 'git_sync_completed',
        }
      );
    } finally {
      await refreshFooterStatus({ showBusy: true });
      setCodeDivergenceAction(null);
    }
  };

  const openConflictAssistantForDivergence = async () => {
    if (!codeDivergenceResolution) return;
    const repositories: MetadataSyncRepositoryStatus[] = codeDivergenceResolution.entries.map(
      (entry) => ({
        repoPath: entry.project.path,
        projectId: entry.project.id,
        worktreePath: null,
        state: 'conflict',
        error: 'Code divergence conflicts detected during pull/push.',
        reason: 'merge_conflict',
        nextAction: 'resolve_conflict',
        conflictFiles: uniqueStrings(entry.conflictFiles),
      })
    );
    setCodeDivergenceResolution(null);
    try {
      await openConflictAssistant({
        prompt: buildMacroConflictAssistantPrompt({ repositories }),
        internalAgentProfile: 'repo_auditor',
      });
      notify.success(
        t('footer.sync.aiConflictAssistantStarted', 'AI conflict assistant started'),
        { category: 'git_sync_completed' }
      );
    } catch (error) {
      notify.error(
        t('footer.sync.aiConflictAssistantStartFailed', 'Failed to start AI assistant'),
        {
          description: toServiceError(error).message,
          category: 'git_sync_attention_required',
        }
      );
    }
  };

  const openPushResolution = () => {
    if (footerMetadataSync.reason === 'missing_origin' || footerMetadataSync.nextAction === 'configure_remote') {
      const repositories: MetadataOriginCandidate[] = footerMetadataSync.repositories.length > 0
        ? footerMetadataSync.repositories
        : scopeProjects.map((project) => ({
            repoPath: project.path,
            projectId: project.id,
            reason: footerMetadataSync.reason,
            nextAction: footerMetadataSync.nextAction,
          }));
      const entriesByPath = new Map<string, PushRemoteResolutionEntry>();
      for (const repository of repositories) {
        if (repository.reason !== 'missing_origin' && repository.nextAction !== 'configure_remote') continue;
        const project = scopeProjects.find((candidate) => candidate.path === repository.repoPath);
        entriesByPath.set(repository.repoPath, {
          projectId: repository.projectId ?? project?.id ?? null,
          projectName: project?.name ?? repository.repoPath,
          repoPath: repository.repoPath,
          url: '',
          source: 'metadata',
        });
      }
      if (entriesByPath.size > 0) {
        setPushResolution({
          kind: 'missing_origin',
          scopeProjects,
          readyProjects: [],
          entries: Array.from(entriesByPath.values()),
          error: null,
        });
        return;
      }
    }

    if (shouldPromptForMissingUpstream && macroSnapshot) {
      setPushResolution({ kind: 'missing_upstream', macroResult: macroSnapshot, scopeProjects, context: 'resolve' });
      return;
    }

    setShowConflictModal(true);
  };

  return (
    <>
      <footer
        className="h-8 overflow-hidden border-t border-border bg-card px-3 text-[11px] text-muted-foreground"
        data-tour-id="footer-status-bar"
      >
        <div className="flex h-full min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center overflow-hidden">
            {canSelectFolder ? (
              <button
                type="button"
                className="flex h-6 min-w-0 max-w-[14rem] items-center gap-1.5 rounded px-1 text-left hover:bg-muted/60 disabled:cursor-default disabled:opacity-60"
                title={selectedFolder?.path ?? t('footer.scope.selectFolder', 'Sélectionner un dossier Git')}
                aria-label={t('footer.scope.selectFolder', 'Sélectionner un dossier Git')}
                disabled={!isTauriRuntime || isSelectingFolder || Boolean(syncAction) || isRefreshing}
                onClick={() => void selectFolderScope()}
                data-tour-id="footer-folder-scope"
              >
                <Icon name="folder-git-2" size={12} className="block translate-x-[0.25px] -translate-y-[0.5px] shrink-0 text-primary" />
                <span className="truncate leading-4 text-foreground">
                  {focusedProject?.name ?? t('footer.scope.selectFolder', 'Sélectionner un dossier Git')}
                </span>
              </button>
            ) : (
              <span className="flex h-6 min-w-0 max-w-[12rem] items-center gap-1.5" title={focusedProject?.name || undefined}>
                <Icon name="folder-git-2" size={12} className="block translate-x-[0.25px] -translate-y-[0.5px] shrink-0 text-primary" />
                <span className="truncate leading-4 text-foreground">{focusedProject?.name || t('project.noProject', 'Aucun projet')}</span>
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2 h-6 w-6 shrink-0 px-0 text-[11px]"
              aria-label={fetchActionLabel}
              title={fetchActionLabel}
              disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
              onClick={() => void handleSyncAction('fetch')}
              data-tour-id="footer-fetch"
            >
              <span className="footer-git-action-icon-frame" aria-hidden="true">
                <Icon
                  name="refresh-cw"
                  size={12}
                  className={cn(
                    'footer-git-action-icon',
                    (syncAction === 'fetch' || isRefreshing) && 'footer-git-action-icon--fetching'
                  )}
                />
              </span>
            </Button>
            {(focusProjects.length > 0 || codeStatus.branch || hasPushWork || hasPullWork) && (
              <div className="flex min-w-0 items-center overflow-hidden">
                <span aria-hidden="true" className="mx-2 h-4 w-px shrink-0 bg-border/70" />
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                {focusProjects.length > 1 && (
                  <div className="ml-1 grid shrink-0">
                    <span
                      aria-hidden="true"
                      className="invisible col-start-1 row-start-1 h-6 whitespace-pre rounded border border-transparent px-2 pr-6 text-[11px]"
                    >
                      {selectedProjectLabel}
                    </span>
                    <select
                      className="col-start-1 row-start-1 h-6 min-w-0 rounded border border-border bg-card px-2 pr-6 text-[11px] leading-6 text-foreground"
                      value={focusedProject?.id ?? ''}
                      data-tour-id="footer-project-scope"
                      aria-label={t('footer.scope.gitScope', 'Portée Git')}
                      title={t('footer.scope.gitScope', 'Portée Git')}
                      onChange={(event) => setGitScopeProjectId(event.target.value || null)}
                    >
                      <option value="">{t('footer.scope.selectRepository', 'Sélectionner un dépôt')}</option>
                      {focusProjects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {focusedProject && focusedProjectBranch && (
                  <span className="flex min-w-0 max-w-[10rem] items-center gap-1.5" title={focusedProjectBranch}>
                    <Icon name="git-branch" size={12} className="shrink-0 text-blue-400" />
                    <span className="truncate">{focusedProjectBranch}</span>
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    hasPullWork ? 'text-amber-400 hover:text-amber-300' : 'text-muted-foreground/80'
                  )}
                  aria-label={`${pullActionLabel} · ${pullCountLabel}`}
                  title={pullActionLabel}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('pull')}
                  data-tour-id="footer-pull"
                >
                  <span className="footer-git-action-icon-frame" aria-hidden="true">
                    <Icon
                      name="arrow-down"
                      size={12}
                      className={cn(
                        'footer-git-action-icon',
                        syncAction === 'pull' && 'footer-git-action-icon--pulling'
                      )}
                    />
                  </span>
                  <span>{pullCountLabel}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    hasPushWork ? 'text-emerald-400 hover:text-emerald-300' : 'text-muted-foreground/80'
                  )}
                  aria-label={`${pushActionLabel} · ${pushCountLabel}`}
                  title={pushActionLabel}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('push')}
                  data-tour-id="footer-push"
                >
                  <span className="footer-git-action-icon-frame" aria-hidden="true">
                    <Icon
                      name="arrow-up"
                      size={12}
                      className={cn(
                        'footer-git-action-icon',
                        syncAction === 'push' && 'footer-git-action-icon--pushing'
                      )}
                    />
                  </span>
                  <span>{pushCountLabel}</span>
                </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {macroNeedsAttention && (
              <Button
                size="sm"
                variant="error"
                className="h-6 px-2 text-[11px]"
                onClick={openPushResolution}
              >
                {t('footer.sync.resolve', 'Resolve')}
              </Button>
            )}
            <Button
              ref={notificationCenterButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              aria-haspopup="dialog"
              aria-expanded={isNotificationCenterOpen}
              className={cn('relative h-6 w-6 px-0 text-[11px]', isNotificationCenterOpen && 'bg-accent text-foreground hover:bg-accent')}
              onClick={() => setNotificationCenterOpen(!isNotificationCenterOpen)}
              data-tour-id="notification-center"
            >
              <Icon name="bell" size={12} />
              {hasUnreadNotificationDot && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full border border-card bg-primary" />}
            </Button>
          </div>
        </div>
      </footer>

      {showConflictModal && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowConflictModal(false)} />
          <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl">
            <ConflictResolutionPanel
              title={metadataSyncPresentation.title}
              description={metadataSyncPresentation.nextStep || metadataSyncPresentation.body}
              repositories={macroConflictEntries}
              error={metadataSyncPresentation.technicalDetails}
              retryLabel={
                isMissingUpstreamResolution
                  ? t('footer.sync.pushMacroBranch', 'Push @macro')
                  : t('footer.sync.retrySync', 'Retry sync')
              }
              retryDisabled={Boolean(syncAction)}
              retryLoading={Boolean(syncAction) || isRefreshing}
              showConflictFiles={footerMetadataSync.state === 'conflict'}
              onDismiss={
                isMissingUpstreamResolution
                  ? ignoreMissingUpstreamFromResolve
                  : () => setShowConflictModal(false)
              }
              dismissLabel={
                isMissingUpstreamResolution
                  ? t('footer.sync.ignoreMissingUpstream', 'Ignore missing upstream')
                  : t('common.close', 'Close')
              }
              onRetry={() => void handleRetryMacroSync()}
              onUseAiAssistant={canUseMacroAssistant ? () => void openAiConflictAssistant() : undefined}
            />
          </div>
        </div>
      )}

      {pushResolution && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setPushResolution(null)} />
          <div
            className="relative w-full max-w-lg rounded-lg border border-border bg-card p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="push-resolution-title"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-amber-500/10 p-2 text-amber-500">
                <Icon name="git-branch" size={16} />
              </div>
              <div className="min-w-0">
                <h3 id="push-resolution-title" className="text-sm font-semibold text-foreground">
                  {pushResolution.kind === 'missing_origin'
                    ? t('footer.sync.missingOriginPromptTitle', 'Remote origin is missing')
                    : t('footer.sync.missingUpstreamPromptTitle', '@macro has no remote branch yet')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {pushResolution.kind === 'missing_origin'
                    ? t(
                        'footer.sync.missingOriginPromptDescription',
                        'Add origins for repositories you want to publish now. Leave a field blank to keep that repository local for this push.'
                      )
                    : t(
                        'footer.sync.missingUpstreamPromptDescription',
                        'Choose whether this push should publish the @macro metadata branch or keep it local.'
                      )}
                </p>
              </div>
            </div>
            {pushResolution.kind === 'missing_origin' ? (
              <>
                <p className="mt-4 rounded border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {t(
                    'footer.sync.missingOriginPromptSummary',
                    `${pushResolution.readyProjects.length} repositories ready to push. ${pushResolution.entries.length} need an origin.`
                  )}
                </p>
                <div className="mt-4 space-y-3">
                  {pushResolution.entries.map((entry) => (
                    <label key={entry.repoPath} className="block space-y-1.5">
                      <span className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
                        <span className="truncate">{entry.projectName}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {entry.source === 'code_and_metadata'
                            ? t('footer.sync.remoteNeededCodeAndMetadata', 'code + @macro')
                            : entry.source === 'metadata'
                              ? t('footer.sync.remoteNeededMetadata', '@macro')
                              : t('footer.sync.remoteNeededCode', 'code')}
                        </span>
                      </span>
                      <input
                        className="h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                        value={entry.url}
                        placeholder="https://github.com/org/repo.git"
                        disabled={isConfiguringRemote}
                        onChange={(event) => updatePushResolutionRemoteUrl(entry.repoPath, event.target.value)}
                      />
                      <span className="block truncate text-[11px] text-muted-foreground">{entry.repoPath}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t('footer.sync.remoteUrlOptional', 'Leave blank to skip this repository for this push.')}
                      </span>
                    </label>
                  ))}
                </div>
                {pushResolution.error && (
                  <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                    {pushResolution.error}
                  </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isConfiguringRemote}
                    onClick={() => setPushResolution(null)}
                  >
                    {t('common.cancel', 'Cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={Boolean(syncAction) || isConfiguringRemote}
                    isLoading={isConfiguringRemote}
                    onClick={() => void configureMissingOriginsAndContinue()}
                  >
                    {t('footer.sync.pushAvailableRepositories', 'Push available repositories')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {pushResolution.context === 'push' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(syncAction)}
                    onClick={() => void continuePushAfterMissingUpstreamChoice('ask_next_time')}
                  >
                    {t('footer.sync.askNextTime', 'Ask next time')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(syncAction)}
                  onClick={() => void (
                    pushResolution.context === 'resolve'
                      ? resolveMissingUpstreamChoice('ignore_forever')
                      : continuePushAfterMissingUpstreamChoice('ignore_forever')
                  )}
                >
                  {pushResolution.context === 'resolve'
                    ? t('footer.sync.ignoreMissingUpstream', 'Ignore missing upstream')
                    : t('footer.sync.doNotAskAgain', "Don't ask again")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={Boolean(syncAction)}
                  onClick={() => void (
                    pushResolution.context === 'resolve'
                      ? resolveMissingUpstreamChoice('push_macro')
                      : continuePushAfterMissingUpstreamChoice('push_macro')
                  )}
                >
                  {t('footer.sync.pushMacroBranch', 'Push @macro')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {codeDivergenceResolution && (
        <CodeDivergenceResolutionModal
          resolution={codeDivergenceResolution}
          action={codeDivergenceAction}
          t={translate}
          onClose={() => setCodeDivergenceResolution(null)}
          onResolve={(strategy, options) => void resolveCodeDivergence(strategy, options)}
          onAbortMerge={() => void abortCodeDivergenceMerge()}
          onDiscardLocalChanges={() => void discardCodeDivergenceLocalChanges()}
          onOpenConflictAssistant={() => void openConflictAssistantForDivergence()}
        />
      )}

      <NotificationCenterPopover
        isOpen={isNotificationCenterOpen}
        anchorRef={notificationCenterButtonRef}
        onClose={() => setNotificationCenterOpen(false)}
      />
    </>
  );
};
