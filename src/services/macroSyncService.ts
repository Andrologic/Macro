import type { AppMode } from '../types';
import { toServiceError } from './contracts/errors';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';

type MacroSyncResult = tauriIpc.MacroBranchSyncDto;
type ManualMacroAction = 'commit' | 'pull' | 'push';

interface StreamMetadataSyncParams {
  mode: AppMode;
  conversationId: string;
  trigger: 'send' | 'edit';
}

interface FallbackMacroFailure {
  state: tauriIpc.MacroSyncState;
  reason: tauriIpc.MacroSyncReason;
  nextAction: tauriIpc.MacroSyncNextAction | null;
  message: string;
}

interface MacroSyncAppState {
  metadataAutoPush: boolean;
  setMetadataSyncStatus: (params: {
    state: tauriIpc.MacroSyncState;
    error?: string | null;
    reason?: tauriIpc.MacroSyncReason | null;
    nextAction?: tauriIpc.MacroSyncNextAction | null;
    conflictFiles?: string[];
  }) => void;
}

export interface MacroSyncServiceDependencies {
  tauriIpc: Pick<
    typeof tauriIpc,
    | 'isTauriAvailable'
    | 'macroBranchEnsure'
    | 'macroBranchStatus'
    | 'macroBranchCommitIfDirty'
    | 'macroBranchPull'
    | 'macroBranchPush'
  >;
  getAppState: () => MacroSyncAppState;
  toServiceError: typeof toServiceError;
}

export interface MacroSyncService {
  refreshMacroSyncStatus: (options?: { ensure?: boolean }) => Promise<MacroSyncResult | null>;
  commitMacroMetadata: (options?: { commitMessage?: string }) => Promise<MacroSyncResult | null>;
  pullMacroMetadata: () => Promise<MacroSyncResult | null>;
  pushMacroMetadata: () => Promise<MacroSyncResult | null>;
  syncMacroMetadataAfterStream: (params: StreamMetadataSyncParams) => Promise<MacroSyncResult | null>;
}

const MACRO_REASON_MESSAGES: Record<tauriIpc.MacroSyncReason, string | null> = {
  clean: null,
  dirty: 'Metadata changes are local only. Commit @macro before pulling or pushing.',
  ahead: 'Metadata is ahead of origin. Push @macro to publish it.',
  behind: 'Metadata is behind origin. Pull @macro before pushing.',
  diverged: 'Metadata diverged from origin. Pull @macro and resolve any conflicts before pushing.',
  merge_conflict: 'Metadata has unresolved merge conflicts. Resolve the conflicted files first.',
  missing_origin: 'Remote origin is not configured for metadata sync.',
  missing_upstream: 'Branch @macro has no upstream yet. Push @macro to publish it.',
  auth_required: 'Git authentication for origin is not configured.',
  network_error: 'Network error while reaching the metadata remote.',
  unknown_error: 'Metadata sync failed.',
};

const describeMacroReason = (reason: tauriIpc.MacroSyncReason | null | undefined): string | null =>
  reason ? MACRO_REASON_MESSAGES[reason] ?? null : null;

export const getMacroSyncDescription = (
  result: Pick<MacroSyncResult, 'error' | 'reason'>
): string | null => {
  const explicit = result.error?.trim();
  if (explicit) {
    return explicit;
  }
  return describeMacroReason(result.reason);
};

const classifyFallbackMacroFailure = (message: string): FallbackMacroFailure => {
  const normalized = message.trim() || 'Metadata sync failed.';
  const lower = normalized.toLowerCase();

  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('could not read from remote repository')
  ) {
    return {
      state: 'failed',
      reason: 'auth_required',
      nextAction: 'configure_auth',
      message: describeMacroReason('auth_required') || normalized,
    };
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('failed to connect') ||
    lower.includes('network') ||
    lower.includes('timed out')
  ) {
    return {
      state: 'failed',
      reason: 'network_error',
      nextAction: 'retry',
      message: describeMacroReason('network_error') || normalized,
    };
  }

  if (
    lower.includes('no such remote') ||
    lower.includes("'origin'") ||
    lower.includes('remote origin') && lower.includes('not found')
  ) {
    return {
      state: 'failed',
      reason: 'missing_origin',
      nextAction: 'configure_remote',
      message: describeMacroReason('missing_origin') || normalized,
    };
  }

  if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    lower.includes('rejected')
  ) {
    return {
      state: 'pending',
      reason: 'diverged',
      nextAction: 'pull',
      message: describeMacroReason('diverged') || normalized,
    };
  }

  if (lower.includes('merge conflict') || lower.includes('automatic merge failed')) {
    return {
      state: 'conflict',
      reason: 'merge_conflict',
      nextAction: 'resolve_conflict',
      message: describeMacroReason('merge_conflict') || normalized,
    };
  }

  return {
    state: 'failed',
    reason: 'unknown_error',
    nextAction: 'retry',
    message: normalized,
  };
};

const toFailedMacroResult = (message: string): MacroSyncResult => {
  const failure = classifyFallbackMacroFailure(message);
  return {
    branch: '@macro',
    state: failure.state,
    worktree_path: '',
    is_dirty: false,
    has_origin: false,
    has_upstream: false,
    ahead: 0,
    behind: 0,
    conflicted_files: [],
    committed: false,
    commit_hash: null,
    reason: failure.reason,
    next_action: failure.nextAction,
    output: null,
    error: failure.message,
  };
};

const shouldBlockMacroAction = (
  result: MacroSyncResult,
  action: ManualMacroAction
): boolean => {
  if (result.state === 'conflict') {
    return true;
  }

  const nextAction = result.next_action;
  if (!nextAction) {
    return false;
  }

  if (action === 'commit') {
    return nextAction === 'resolve_conflict';
  }

  if (action === 'pull') {
    return (
      nextAction === 'commit' ||
      nextAction === 'resolve_conflict' ||
      nextAction === 'configure_remote' ||
      nextAction === 'configure_auth'
    );
  }

  return (
    nextAction === 'commit' ||
    nextAction === 'pull' ||
    nextAction === 'resolve_conflict' ||
    nextAction === 'configure_remote' ||
    nextAction === 'configure_auth'
  );
};

const defaultMacroSyncServiceDependencies: MacroSyncServiceDependencies = {
  tauriIpc,
  getAppState: () => useAppStore.getState(),
  toServiceError,
};

export const createMacroSyncService = (
  dependencies: MacroSyncServiceDependencies = defaultMacroSyncServiceDependencies
): MacroSyncService => {
  let macroSyncQueueTail: Promise<void> = Promise.resolve();

  const runWithMacroSyncLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = macroSyncQueueTail;
    let release: () => void = () => {};
    macroSyncQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const applyMacroSyncResult = (result: MacroSyncResult): MacroSyncResult => {
    dependencies.getAppState().setMetadataSyncStatus({
      state: result.state,
      error:
        result.error?.trim() ||
        (result.state === 'failed' || result.state === 'conflict'
          ? describeMacroReason(result.reason)
          : null),
      reason: result.reason,
      nextAction: result.next_action,
      conflictFiles: result.conflicted_files,
    });
    return result;
  };

  const applyMacroSyncFailure = (error: unknown): MacroSyncResult => {
    const result = toFailedMacroResult(dependencies.toServiceError(error).message);
    return applyMacroSyncResult(result);
  };

  const setMacroSyncPending = () => {
    dependencies.getAppState().setMetadataSyncStatus({
      state: 'pending',
      error: null,
      reason: null,
      nextAction: null,
      conflictFiles: [],
    });
  };

  const refreshMacroSyncStatus = async (options?: {
    ensure?: boolean;
  }): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      try {
        const result = options?.ensure
          ? await dependencies.tauriIpc.macroBranchEnsure()
          : await dependencies.tauriIpc.macroBranchStatus();
        return applyMacroSyncResult(result);
      } catch (error) {
        return applyMacroSyncFailure(error);
      }
    });
  };

  const commitMacroMetadata = async (options?: {
    commitMessage?: string;
  }): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      setMacroSyncPending();
      try {
        const ensure = applyMacroSyncResult(await dependencies.tauriIpc.macroBranchEnsure());
        if (shouldBlockMacroAction(ensure, 'commit')) {
          return ensure;
        }

        return applyMacroSyncResult(
          await dependencies.tauriIpc.macroBranchCommitIfDirty({
            message: options?.commitMessage,
          })
        );
      } catch (error) {
        return applyMacroSyncFailure(error);
      }
    });
  };

  const pullMacroMetadata = async (): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      setMacroSyncPending();
      try {
        const ensure = applyMacroSyncResult(await dependencies.tauriIpc.macroBranchEnsure());
        if (shouldBlockMacroAction(ensure, 'pull')) {
          return ensure;
        }

        return applyMacroSyncResult(await dependencies.tauriIpc.macroBranchPull());
      } catch (error) {
        return applyMacroSyncFailure(error);
      }
    });
  };

  const pushMacroMetadata = async (): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      setMacroSyncPending();
      try {
        const ensure = applyMacroSyncResult(await dependencies.tauriIpc.macroBranchEnsure());
        if (shouldBlockMacroAction(ensure, 'push')) {
          return ensure;
        }

        return applyMacroSyncResult(await dependencies.tauriIpc.macroBranchPush());
      } catch (error) {
        return applyMacroSyncFailure(error);
      }
    });
  };

  const syncMacroMetadataAfterStream = async (
    params: StreamMetadataSyncParams
  ): Promise<MacroSyncResult | null> => {
    if (params.mode !== 'Architect' || !dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      setMacroSyncPending();
      try {
        const ensure = applyMacroSyncResult(await dependencies.tauriIpc.macroBranchEnsure());
        if (ensure.state === 'conflict') {
          return ensure;
        }

        const commitMessage = `chore(metadata): sync ${params.trigger} stream for ${params.conversationId}`;
        const commit = applyMacroSyncResult(
          await dependencies.tauriIpc.macroBranchCommitIfDirty({
            message: commitMessage,
          })
        );

        if (dependencies.getAppState().metadataAutoPush) {
          if (shouldBlockMacroAction(commit, 'push')) {
            return commit;
          }
          return applyMacroSyncResult(await dependencies.tauriIpc.macroBranchPush());
        }

        return commit;
      } catch (error) {
        return applyMacroSyncFailure(error);
      }
    });
  };

  return {
    refreshMacroSyncStatus,
    commitMacroMetadata,
    pullMacroMetadata,
    pushMacroMetadata,
    syncMacroMetadataAfterStream,
  };
};

const defaultMacroSyncService = createMacroSyncService();

export const refreshMacroSyncStatus = defaultMacroSyncService.refreshMacroSyncStatus;
export const commitMacroMetadata = defaultMacroSyncService.commitMacroMetadata;
export const pullMacroMetadata = defaultMacroSyncService.pullMacroMetadata;
export const pushMacroMetadata = defaultMacroSyncService.pushMacroMetadata;
export const syncMacroMetadataAfterStream = defaultMacroSyncService.syncMacroMetadataAfterStream;
