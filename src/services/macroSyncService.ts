import type { AppMode } from '../types';
import { toServiceError } from './contracts/errors';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';

type MacroSyncResult = tauriIpc.MacroBranchSyncDto;

interface StreamMetadataSyncParams {
  mode: AppMode;
  conversationId: string;
  trigger: 'send' | 'edit';
}

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

const normalizeMacroErrorMessage = (input: string): string => {
  const message = input.trim();
  if (!message) return 'Metadata sync failed.';

  const lower = message.toLowerCase();
  if (lower.includes('authentication failed') || lower.includes('could not read from remote repository')) {
    return 'Metadata sync failed: Git authentication for origin is not configured.';
  }
  if (lower.includes('non-fast-forward') || lower.includes('fetch first')) {
    return 'Metadata sync failed: remote changed, pull @macro first and resolve conflicts if needed.';
  }
  if (lower.includes('could not resolve host') || lower.includes('network')) {
    return 'Metadata sync failed: network issue while reaching remote.';
  }
  if (lower.includes('no such remote') || lower.includes("'origin'")) {
    return 'Metadata sync failed: remote origin is missing in this repository.';
  }

  return message;
};

const toFailedMacroResult = (message: string): MacroSyncResult => ({
  branch: '@macro',
  state: 'failed',
  worktree_path: '',
  is_dirty: false,
  has_upstream: false,
  ahead: 0,
  behind: 0,
  conflicted_files: [],
  committed: false,
  commit_hash: null,
  output: null,
  error: message,
});

const applyMacroSyncResult = (result: MacroSyncResult): MacroSyncResult => {
  useAppStore.getState().setMetadataSyncStatus({
    state: result.state,
    error: result.error,
    conflictFiles: result.conflicted_files,
  });
  return result;
};

const applyMacroSyncFailure = (error: unknown): MacroSyncResult => {
  const normalized = normalizeMacroErrorMessage(toServiceError(error).message);
  const result = toFailedMacroResult(normalized);
  return applyMacroSyncResult(result);
};

const setMacroSyncPending = () => {
  useAppStore.getState().setMetadataSyncStatus({
    state: 'pending',
    error: null,
    conflictFiles: [],
  });
};

const isMacroSyncBlocked = (result: MacroSyncResult): boolean =>
  result.state === 'failed' || result.state === 'conflict';

export const refreshMacroSyncStatus = async (options?: {
  ensure?: boolean;
}): Promise<MacroSyncResult | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  return runWithMacroSyncLock(async () => {
    try {
      const result = options?.ensure
        ? await tauriIpc.macroBranchEnsure()
        : await tauriIpc.macroBranchStatus();
      return applyMacroSyncResult(result);
    } catch (error) {
      return applyMacroSyncFailure(error);
    }
  });
};

export const pullMacroMetadata = async (): Promise<MacroSyncResult | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  return runWithMacroSyncLock(async () => {
    setMacroSyncPending();
    try {
      const ensure = applyMacroSyncResult(await tauriIpc.macroBranchEnsure());
      if (isMacroSyncBlocked(ensure)) {
        return ensure;
      }

      return applyMacroSyncResult(await tauriIpc.macroBranchPull());
    } catch (error) {
      return applyMacroSyncFailure(error);
    }
  });
};

export const pushMacroMetadata = async (options?: {
  commitMessage?: string;
}): Promise<MacroSyncResult | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  return runWithMacroSyncLock(async () => {
    setMacroSyncPending();
    try {
      const ensure = applyMacroSyncResult(await tauriIpc.macroBranchEnsure());
      if (isMacroSyncBlocked(ensure)) {
        return ensure;
      }

      const commit = applyMacroSyncResult(
        await tauriIpc.macroBranchCommitIfDirty({
          message: options?.commitMessage,
        })
      );
      if (isMacroSyncBlocked(commit)) {
        return commit;
      }

      return applyMacroSyncResult(await tauriIpc.macroBranchPush());
    } catch (error) {
      return applyMacroSyncFailure(error);
    }
  });
};

export const syncMacroMetadataAfterStream = async (
  params: StreamMetadataSyncParams
): Promise<MacroSyncResult | null> => {
  if (params.mode !== 'Architect' || !tauriIpc.isTauriAvailable()) {
    return null;
  }

  return runWithMacroSyncLock(async () => {
    setMacroSyncPending();
    try {
      const ensure = applyMacroSyncResult(await tauriIpc.macroBranchEnsure());
      if (isMacroSyncBlocked(ensure)) {
        return ensure;
      }

      const commitMessage = `chore(metadata): sync ${params.trigger} stream for ${params.conversationId}`;
      const commit = applyMacroSyncResult(
        await tauriIpc.macroBranchCommitIfDirty({
          message: commitMessage,
        })
      );
      if (isMacroSyncBlocked(commit)) {
        return commit;
      }

      if (useAppStore.getState().metadataAutoPush) {
        return applyMacroSyncResult(await tauriIpc.macroBranchPush());
      }

      return commit;
    } catch (error) {
      return applyMacroSyncFailure(error);
    }
  });
};
