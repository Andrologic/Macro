import * as tauriIpc from './tauriIpc';

type MacroMetadataTauri = Pick<
  typeof tauriIpc,
  'isTauriAvailable' | 'macroBranchCommitIfDirty'
>;

export type MacroMetadataMutationKind =
  | 'plan_created'
  | 'plan_updated'
  | 'plan_archived'
  | 'plan_deleted'
  | 'plan_repaired'
  | 'task_metadata'
  | 'manual_feature'
  | 'chat_synced'
  | 'project_state';

export type MacroMetadataMutationImportance = 'light' | 'structural';

export interface MacroMetadataMutation {
  workspacePath: string;
  kind: MacroMetadataMutationKind;
  entityId?: string | null;
  label?: string | null;
  importance?: MacroMetadataMutationImportance;
  message?: string | null;
}

export type MacroMetadataFlushTrigger =
  | 'debounced_structural'
  | 'explicit_checkpoint'
  | 'code_pull'
  | 'code_push'
  | 'project_switch'
  | 'app_close';

export interface MacroMetadataFlushRequest {
  trigger: MacroMetadataFlushTrigger;
  workspacePaths: string[];
  message?: string | null;
}

interface PendingMacroMetadataMutation {
  workspacePath: string;
  kind: MacroMetadataMutationKind;
  entityId: string | null;
  label: string | null;
  importance: MacroMetadataMutationImportance;
  message: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface MacroMetadataCoordinatorDeps {
  tauri?: MacroMetadataTauri;
  debounceMs?: number;
}

export const MACRO_METADATA_STRUCTURAL_DEBOUNCE_MS = 0;

const pendingMutations = new Map<string, PendingMacroMetadataMutation>();

const normalizeWorkspacePath = (workspacePath?: string | null): string | null => {
  const normalized = workspacePath?.trim();
  return normalized ? normalized : null;
};

const normalizeLabel = (value?: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const defaultMessageForMutation = (
  mutation: Pick<MacroMetadataMutation, 'kind' | 'label' | 'entityId'>
): string => {
  const label = normalizeLabel(mutation.label) || normalizeLabel(mutation.entityId);
  switch (mutation.kind) {
    case 'plan_created':
      return `chore(@macro): create plan ${label || 'draft'}`;
    case 'plan_archived':
      return `chore(@macro): archive plan ${label || 'draft'}`;
    case 'plan_deleted':
      return `chore(@macro): delete plan ${label || 'draft'}`;
    case 'plan_repaired':
      return `chore(@macro): repair plan ${label || 'draft'}`;
    case 'task_metadata':
    case 'manual_feature':
      return 'chore(@macro): update task metadata';
    case 'plan_updated':
      return `chore(@macro): update plan ${label || 'draft'}`;
    case 'chat_synced':
    case 'project_state':
    default:
      return 'chore(@macro): sync project state';
  }
};

const messageForTrigger = (
  trigger: MacroMetadataFlushTrigger,
  pending: PendingMacroMetadataMutation | null,
  explicitMessage?: string | null
): string => {
  const normalizedExplicit = normalizeLabel(explicitMessage);
  if (normalizedExplicit) {
    return normalizedExplicit.replace(/^chore\(metadata\):/i, 'chore(@macro):');
  }
  if (trigger === 'debounced_structural' && pending?.message) {
    return pending.message;
  }
  if (trigger === 'explicit_checkpoint' && pending?.message) {
    return pending.message;
  }
  return 'chore(@macro): sync project state';
};

const getDeps = (deps?: MacroMetadataCoordinatorDeps): {
  tauri: MacroMetadataTauri;
  debounceMs: number;
} => ({
  tauri: deps?.tauri ?? tauriIpc,
  debounceMs: deps?.debounceMs ?? MACRO_METADATA_STRUCTURAL_DEBOUNCE_MS,
});

const clearPendingTimer = (pending: PendingMacroMetadataMutation | undefined): void => {
  if (pending?.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
};

export const recordMacroMetadataMutation = (
  mutation: MacroMetadataMutation,
  deps?: MacroMetadataCoordinatorDeps
): void => {
  const workspacePath = normalizeWorkspacePath(mutation.workspacePath);
  if (!workspacePath) return;

  const { tauri, debounceMs } = getDeps(deps);
  if (!tauri.isTauriAvailable()) return;

  const previous = pendingMutations.get(workspacePath);
  const importance = mutation.importance ?? 'light';

  if (importance === 'light') {
    pendingMutations.set(workspacePath, {
      workspacePath,
      kind: previous?.kind ?? mutation.kind,
      entityId: previous?.entityId ?? normalizeLabel(mutation.entityId),
      label: previous?.label ?? normalizeLabel(mutation.label),
      importance: previous?.importance ?? 'light',
      message: previous?.message ?? normalizeLabel(mutation.message),
      timer: previous?.timer ?? null,
    });
    return;
  }

  clearPendingTimer(previous);

  const next: PendingMacroMetadataMutation = {
    workspacePath,
    kind: mutation.kind,
    entityId: normalizeLabel(mutation.entityId),
    label: normalizeLabel(mutation.label),
    importance,
    message:
      normalizeLabel(mutation.message) ||
      (importance === 'structural'
        ? defaultMessageForMutation(mutation)
        : previous?.message ?? null),
    timer: null,
  };

  pendingMutations.set(workspacePath, next);

  if (debounceMs <= 0) {
    void flushMacroMetadata({
      trigger: 'debounced_structural',
      workspacePaths: [workspacePath],
    }, deps);
    return;
  }

  next.timer = setTimeout(() => {
    void flushMacroMetadata({
      trigger: 'debounced_structural',
      workspacePaths: [workspacePath],
    }, deps);
  }, Math.max(0, debounceMs));
};

export const flushMacroMetadata = async (
  request: MacroMetadataFlushRequest,
  deps?: MacroMetadataCoordinatorDeps
): Promise<tauriIpc.MacroBranchSyncDto[]> => {
  const { tauri } = getDeps(deps);
  if (!tauri.isTauriAvailable()) return [];

  const workspacePaths = Array.from(
    new Set(
      request.workspacePaths
        .map((workspacePath) => normalizeWorkspacePath(workspacePath))
        .filter((workspacePath): workspacePath is string => Boolean(workspacePath))
    )
  );

  const results: tauriIpc.MacroBranchSyncDto[] = [];
  for (const workspacePath of workspacePaths) {
    const pending = pendingMutations.get(workspacePath) ?? null;
    clearPendingTimer(pending ?? undefined);
    pendingMutations.delete(workspacePath);

    results.push(
      await tauri.macroBranchCommitIfDirty({
        workspacePath,
        message: messageForTrigger(request.trigger, pending, request.message),
      })
    );
  }

  return results;
};

export const flushPendingMacroMetadata = async (
  trigger: MacroMetadataFlushTrigger,
  deps?: MacroMetadataCoordinatorDeps
): Promise<tauriIpc.MacroBranchSyncDto[]> =>
  flushMacroMetadata({
    trigger,
    workspacePaths: Array.from(pendingMutations.keys()),
  }, deps);

export const clearMacroMetadataCoordinatorForTests = (): void => {
  for (const pending of pendingMutations.values()) {
    clearPendingTimer(pending);
  }
  pendingMutations.clear();
};
