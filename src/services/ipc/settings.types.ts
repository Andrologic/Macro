/** settings IPC DTOs. Kept separate for generated Rust binding integration. */

export interface DbAppSetting {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface DbCompareAndSwapAppSettingResult {
  applied: boolean;
}

export interface DbProjectContextState {
  project_id: string;
  group_id: string | null;
  focus_project_id: string | null;
  last_plan_id: string | null;
  last_task_id: string | null;
  architect_conversation_id: string | null;
  implement_conversation_id: string | null;
  updated_at: string;
}

export interface DbSessionContextState {
  selected_group_id: string | null;
  selected_project_id: string | null;
  mode: string | null;
  updated_at: string;
}

export interface DbProjectRegistryRepairReport {
  conversations_updated: number;
  project_contexts_deleted: number;
  project_contexts_updated: number;
  session_context_updated: boolean;
}
