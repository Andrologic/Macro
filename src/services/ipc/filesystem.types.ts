/** filesystem IPC DTOs. Kept separate for generated Rust binding integration. */

export interface FsFileContentDto {
  content: string;
  language: string;
  is_binary: boolean;
  size: number;
  encoding: string;
  revision?: string;
  unix_mode?: number;
}

export interface FsDirEntryDto {
  path: string;
  relative_path: string;
  name: string;
  kind: string;
  size?: number | null;
  modified?: string | null;
  created?: string | null;
  language?: string | null;
  is_hidden: boolean;
  is_readonly: boolean;
}

export interface WorkspaceFileSearchRootDto {
  project_id?: string | null;
  project_name?: string | null;
  workspace_path: string;
  mount_name?: string | null;
  is_focused: boolean;
}

export interface WorkspaceFileSearchResultDto {
  id: string;
  path: string;
  relative_path: string;
  project_id?: string | null;
  project_name?: string | null;
  language?: string | null;
  size_bytes?: number | null;
  modified?: string | null;
  is_focused: boolean;
}

export interface FsFileStatsDto {
  path: string;
  name: string;
  kind: string;
  size: number;
  created?: string | null;
  modified: string;
  accessed?: string | null;
  permissions: string;
  language?: string | null;
  is_readonly: boolean;
  is_hidden: boolean;
  is_symlink: boolean;
  symlink_target?: string | null;
}

export interface FsWriteResultDto {
  path: string;
  bytes_written: number;
  created: boolean;
  skipped: boolean;
  revision?: string;
  unix_mode?: number;
}
