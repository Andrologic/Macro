/** settings IPC wrappers and frontend adapters. */

import type { AppMode } from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import type {
  DbAppSetting,
  DbCompareAndSwapAppSettingResult,
  DbProjectContextState,
  DbProjectRegistryRepairReport,
  DbSessionContextState,
} from "./settings.types";

export async function dbGetSetting(key: string): Promise<string | null> {
  return invoke<string | null>("db_get_setting", { key });
}

export async function dbSetSetting(params: {
  key: string;
  value: string;
}): Promise<void> {
  return invoke("db_set_setting", {
    key: params.key,
    value: params.value,
  });
}

export async function dbGetAppSetting(
  key: string,
): Promise<DbAppSetting | null> {
  return invoke<DbAppSetting | null>("db_get_app_setting", { key });
}

export async function dbSetAppSetting(params: {
  key: string;
  valueJson: string;
}): Promise<DbAppSetting> {
  return invoke<DbAppSetting>("db_set_app_setting", {
    key: params.key,
    valueJson: params.valueJson,
  });
}

export async function dbDeleteAppSetting(key: string): Promise<boolean> {
  return invoke<boolean>("db_delete_app_setting", { key });
}

export async function dbCompareAndSwapAppSetting(params: {
  key: string;
  expectedValueJson: string | null;
  valueJson: string;
}): Promise<DbCompareAndSwapAppSettingResult> {
  return invoke<DbCompareAndSwapAppSettingResult>("db_compare_and_swap_app_setting", {
    key: params.key,
    expectedValueJson: params.expectedValueJson,
    valueJson: params.valueJson,
  });
}

export async function dbGetProjectContextState(
  projectId: string,
): Promise<DbProjectContextState | null> {
  return invoke<DbProjectContextState | null>("db_get_project_context_state", {
    projectId,
  });
}

export async function dbUpsertProjectContextState(params: {
  projectId: string;
  groupId?: string | null;
  focusProjectId?: string | null;
  lastPlanId?: string | null;
  lastTaskId?: string | null;
  architectConversationId?: string | null;
  implementConversationId?: string | null;
}): Promise<DbProjectContextState> {
  return invoke<DbProjectContextState>("db_upsert_project_context_state", {
    input: {
      project_id: params.projectId,
      group_id: params.groupId ?? null,
      focus_project_id: params.focusProjectId ?? null,
      last_plan_id: params.lastPlanId ?? null,
      last_task_id: params.lastTaskId ?? null,
      architect_conversation_id: params.architectConversationId ?? null,
      implement_conversation_id: params.implementConversationId ?? null,
    },
  });
}

export async function dbDeleteProjectContextState(
  projectId: string,
): Promise<void> {
  return invoke("db_delete_project_context_state", {
    projectId,
  });
}

export async function dbGetSessionContextState(): Promise<DbSessionContextState | null> {
  return invoke<DbSessionContextState | null>("db_get_session_context_state");
}

export async function dbUpsertSessionContextState(params: {
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  mode?: AppMode | null;
}): Promise<DbSessionContextState> {
  return invoke<DbSessionContextState>("db_upsert_session_context_state", {
    input: {
      selected_group_id: params.selectedGroupId ?? null,
      selected_project_id: params.selectedProjectId ?? null,
      mode: params.mode ?? null,
    },
  });
}

export async function dbReconcileProjectRegistry(params: {
  validGroupIds: string[];
  validProjectIds: string[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): Promise<DbProjectRegistryRepairReport> {
  return invoke<DbProjectRegistryRepairReport>(
    "db_reconcile_project_registry",
    {
      input: {
        valid_group_ids: params.validGroupIds,
        valid_project_ids: params.validProjectIds,
        selected_group_id: params.selectedGroupId ?? null,
        selected_project_id: params.selectedProjectId ?? null,
      },
    },
  );
}
