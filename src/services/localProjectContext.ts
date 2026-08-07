import type { AppMode } from '../types';
import * as tauriIpc from './tauriIpc';

export type ProjectSwitchPolicy = 'resume_per_project' | 'reset_on_switch';

export interface LocalProjectContextState {
  projectId: string;
  groupId: string | null;
  focusProjectId: string | null;
  lastPlanId: string | null;
  lastTaskId: string | null;
  architectConversationId: string | null;
  implementConversationId: string | null;
  updatedAt: string;
}

export interface LocalSessionContextState {
  globalProjectId: string | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  mode: AppMode | null;
  updatedAt: string;
}

const APP_SETTING_PROJECT_SWITCH_POLICY_KEY = 'project_switch_policy';
const DEFAULT_PROJECT_SWITCH_POLICY: ProjectSwitchPolicy = 'resume_per_project';

const LEGACY_POLICY_STORAGE_KEY = 'macro_project_switch_policy';
const LEGACY_PROJECT_CONTEXTS_KEY = 'macro_project_context_states';
const LEGACY_SESSION_CONTEXT_KEY = 'macro_session_context_state';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeProjectSwitchPolicy = (value: unknown): ProjectSwitchPolicy =>
  value === 'reset_on_switch' ? value : DEFAULT_PROJECT_SWITCH_POLICY;

const safeJsonParse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const toNowIso = (): string => new Date().toISOString();

const normalizeProjectContext = (
  projectId: string,
  value: Partial<LocalProjectContextState> | null | undefined
): LocalProjectContextState => ({
  projectId,
  groupId: typeof value?.groupId === 'string' ? value.groupId : null,
  focusProjectId: typeof value?.focusProjectId === 'string' ? value.focusProjectId : null,
  lastPlanId: typeof value?.lastPlanId === 'string' ? value.lastPlanId : null,
  lastTaskId: typeof value?.lastTaskId === 'string' ? value.lastTaskId : null,
  architectConversationId:
    typeof value?.architectConversationId === 'string' ? value.architectConversationId : null,
  implementConversationId:
    typeof value?.implementConversationId === 'string' ? value.implementConversationId : null,
  updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : toNowIso(),
});

const normalizeSessionContext = (
  value: Partial<LocalSessionContextState> | null | undefined
): LocalSessionContextState => ({
  globalProjectId:
    typeof value?.globalProjectId === 'string'
      ? value.globalProjectId
      : typeof value?.selectedGroupId === 'string'
        ? value.selectedGroupId
        : null,
  selectedGroupId: typeof value?.selectedGroupId === 'string' ? value.selectedGroupId : null,
  selectedProjectId: typeof value?.selectedProjectId === 'string' ? value.selectedProjectId : null,
  mode:
    value?.mode === 'Architect' ||
    value?.mode === 'Implement' ||
    value?.mode === 'Chat'
      ? value.mode
      : null,
  updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : toNowIso(),
});

const readLegacyProjectContexts = (): Record<string, LocalProjectContextState> => {
  if (typeof window === 'undefined') return {};
  const parsed = safeJsonParse<Record<string, LocalProjectContextState>>(
    window.localStorage.getItem(LEGACY_PROJECT_CONTEXTS_KEY)
  );
  if (!parsed || !isRecord(parsed)) return {};

  const normalized: Record<string, LocalProjectContextState> = {};
  for (const [projectId, value] of Object.entries(parsed)) {
    if (!projectId.trim()) continue;
    normalized[projectId] = normalizeProjectContext(projectId, value);
  }
  return normalized;
};

const writeLegacyProjectContexts = (contexts: Record<string, LocalProjectContextState>): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LEGACY_PROJECT_CONTEXTS_KEY, JSON.stringify(contexts));
};

const readLegacySessionContext = (): LocalSessionContextState | null => {
  if (typeof window === 'undefined') return null;
  const parsed = safeJsonParse<LocalSessionContextState>(
    window.localStorage.getItem(LEGACY_SESSION_CONTEXT_KEY)
  );
  return normalizeSessionContext(parsed);
};

const writeLegacySessionContext = (state: LocalSessionContextState): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LEGACY_SESSION_CONTEXT_KEY, JSON.stringify(state));
};

export const getProjectSwitchPolicy = async (): Promise<ProjectSwitchPolicy> => {
  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbGetAppSetting(APP_SETTING_PROJECT_SWITCH_POLICY_KEY);
      if (record?.value_json) {
        return normalizeProjectSwitchPolicy(safeJsonParse(record.value_json));
      }
    } catch {
      // fall through to legacy local fallback
    }
  }

  if (typeof window === 'undefined') return DEFAULT_PROJECT_SWITCH_POLICY;
  return normalizeProjectSwitchPolicy(
    safeJsonParse(window.localStorage.getItem(LEGACY_POLICY_STORAGE_KEY))
  );
};

export const setProjectSwitchPolicy = async (policy: ProjectSwitchPolicy): Promise<void> => {
  const normalized = normalizeProjectSwitchPolicy(policy);
  if (tauriIpc.isTauriAvailable()) {
    try {
      await tauriIpc.dbSetAppSetting({
        key: APP_SETTING_PROJECT_SWITCH_POLICY_KEY,
        valueJson: JSON.stringify(normalized),
      });
      return;
    } catch {
      // fallback to legacy local storage
    }
  }

  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LEGACY_POLICY_STORAGE_KEY, JSON.stringify(normalized));
};

export const getLocalProjectContextState = async (
  projectId: string
): Promise<LocalProjectContextState | null> => {
  if (!projectId.trim()) return null;

  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbGetProjectContextState(projectId);
      if (!record) return null;
      return normalizeProjectContext(projectId, {
        projectId: record.project_id,
        groupId: record.group_id,
        focusProjectId: record.focus_project_id,
        lastPlanId: record.last_plan_id,
        lastTaskId: record.last_task_id,
        architectConversationId: record.architect_conversation_id,
        implementConversationId: record.implement_conversation_id,
        updatedAt: record.updated_at,
      });
    } catch {
      // fallback to legacy local storage
    }
  }

  const contexts = readLegacyProjectContexts();
  return contexts[projectId] ?? null;
};

export const upsertLocalProjectContextState = async (
  input: {
    projectId: string;
    groupId?: string | null;
    focusProjectId?: string | null;
    lastPlanId?: string | null;
    lastTaskId?: string | null;
    architectConversationId?: string | null;
    implementConversationId?: string | null;
  }
): Promise<LocalProjectContextState | null> => {
  const projectId = input.projectId.trim();
  if (!projectId) return null;

  const normalized = normalizeProjectContext(projectId, {
    projectId,
    groupId: input.groupId ?? null,
    focusProjectId: input.focusProjectId ?? null,
    lastPlanId: input.lastPlanId ?? null,
    lastTaskId: input.lastTaskId ?? null,
    architectConversationId: input.architectConversationId ?? null,
    implementConversationId: input.implementConversationId ?? null,
    updatedAt: toNowIso(),
  });

  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbUpsertProjectContextState({
        projectId,
        groupId: normalized.groupId,
        focusProjectId: normalized.focusProjectId,
        lastPlanId: normalized.lastPlanId,
        lastTaskId: normalized.lastTaskId,
        architectConversationId: normalized.architectConversationId,
        implementConversationId: normalized.implementConversationId,
      });
      return normalizeProjectContext(projectId, {
        projectId: record.project_id,
        groupId: record.group_id,
        focusProjectId: record.focus_project_id,
        lastPlanId: record.last_plan_id,
        lastTaskId: record.last_task_id,
        architectConversationId: record.architect_conversation_id,
        implementConversationId: record.implement_conversation_id,
        updatedAt: record.updated_at,
      });
    } catch {
      // fallback to legacy local storage
    }
  }

  const contexts = readLegacyProjectContexts();
  contexts[projectId] = normalized;
  writeLegacyProjectContexts(contexts);
  return normalized;
};

export const deleteLocalProjectContextState = async (projectId: string): Promise<void> => {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return;

  if (tauriIpc.isTauriAvailable()) {
    try {
      await tauriIpc.dbDeleteProjectContextState(normalizedProjectId);
      return;
    } catch {
      // fallback to legacy local storage
    }
  }

  const contexts = readLegacyProjectContexts();
  delete contexts[normalizedProjectId];
  writeLegacyProjectContexts(contexts);
};

export const getLocalSessionContextState = async (): Promise<LocalSessionContextState | null> => {
  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbGetSessionContextState();
      if (!record) return null;
      return normalizeSessionContext({
        selectedGroupId: record.selected_group_id,
        selectedProjectId: record.selected_project_id,
        mode: record.mode as AppMode | null,
        updatedAt: record.updated_at,
      });
    } catch {
      // fallback to legacy local storage
    }
  }

  return readLegacySessionContext();
};

export const upsertLocalSessionContextState = async (
  input: {
    selectedGroupId?: string | null;
    selectedProjectId?: string | null;
    mode?: AppMode | null;
  }
): Promise<LocalSessionContextState> => {
  const normalized = normalizeSessionContext({
    globalProjectId: input.selectedGroupId ?? null,
    selectedGroupId: input.selectedGroupId ?? null,
    selectedProjectId: input.selectedProjectId ?? null,
    mode: input.mode ?? null,
    updatedAt: toNowIso(),
  });

  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbUpsertSessionContextState({
        selectedGroupId: normalized.selectedGroupId,
        selectedProjectId: normalized.selectedProjectId,
        mode: normalized.mode,
      });
      return normalizeSessionContext({
        globalProjectId: record.selected_group_id,
        selectedGroupId: record.selected_group_id,
        selectedProjectId: record.selected_project_id,
        mode: record.mode as AppMode | null,
        updatedAt: record.updated_at,
      });
    } catch {
      // fallback to legacy local storage
    }
  }

  writeLegacySessionContext(normalized);
  return normalized;
};

export const reconcileLocalProjectRegistryState = async (input: {
  validGroupIds: string[];
  validProjectIds: string[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): Promise<void> => {
  const validGroupIds = new Set(input.validGroupIds);
  const validProjectIds = new Set(input.validProjectIds);
  const selectedGroupId =
    input.selectedGroupId && validGroupIds.has(input.selectedGroupId)
      ? input.selectedGroupId
      : null;
  const selectedProjectId =
    input.selectedProjectId && validProjectIds.has(input.selectedProjectId)
      ? input.selectedProjectId
      : null;

  if (tauriIpc.isTauriAvailable()) {
    try {
      await tauriIpc.dbReconcileProjectRegistry({
        validGroupIds: [...validGroupIds],
        validProjectIds: [...validProjectIds],
        selectedGroupId,
        selectedProjectId,
      });
      return;
    } catch {
      // fallback to legacy local storage
    }
  }

  const legacyContexts = readLegacyProjectContexts();
  const nextContexts: Record<string, LocalProjectContextState> = {};

  Object.entries(legacyContexts).forEach(([projectId, context]) => {
    if (!validGroupIds.has(projectId)) {
      return;
    }

    nextContexts[projectId] = normalizeProjectContext(projectId, {
      ...context,
      groupId: context.groupId && validGroupIds.has(context.groupId) ? context.groupId : null,
      focusProjectId:
        context.focusProjectId && validProjectIds.has(context.focusProjectId)
          ? context.focusProjectId
          : null,
    });
  });

  writeLegacyProjectContexts(nextContexts);

  const legacySession = normalizeSessionContext(readLegacySessionContext());
  writeLegacySessionContext(
    normalizeSessionContext({
      ...legacySession,
      globalProjectId: selectedGroupId,
      selectedGroupId,
      selectedProjectId,
    })
  );
};
