/** terminal IPC DTOs. Kept separate for generated Rust binding integration. */

export interface TerminalSessionDto {
  id: string;
  project_id: string | null;
  project_name: string | null;
  mount_name: string | null;
  workspace_path: string | null;
  cwd: string;
  status: string;
  last_command: string | null;
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  output_truncated: boolean;
  updated_at: string;
}

export interface TerminalTabDto {
  id: string;
  kind: string;
  task_id: string | null;
  project_id: string;
  project_name: string;
  mount_name: string;
  workspace_path: string;
  cwd: string;
  title: string;
  status: string;
  snapshot: string;
  last_command: string | null;
  last_exit_code: number | null;
  has_live_session: boolean;
  is_restored: boolean;
  output_sequence: number;
  generation?: number;
  created_at: string;
  updated_at: string;
}

export interface TerminalPromptContextInput {
  projectLabel?: string | null;
  taskLabel?: string | null;
  branchLabel?: string | null;
}

export interface TerminalOutputEvent {
  tab_id: string;
  data: string;
  snapshot: string;
  sequence: number;
  generation?: number;
  updated_at: string;
}
