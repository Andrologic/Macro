/** filesystem IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  FsDirEntryDto,
  FsFileContentDto,
  FsFileStatsDto,
  FsWriteResultDto,
  WorkspaceFileSearchResultDto,
  WorkspaceFileSearchRootDto,
} from "./filesystem.types";
import type { WorkspaceScope } from "./workspaceTools.types";

export async function fsReadFile(path: string): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>("fs_read_file", { path });
}

export async function fsReadFileWithOptions(params: {
  path: string;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>("fs_read_file", {
    path: params.path,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsWriteFile(params: {
  path: string;
  content: string;
  createDirs?: boolean;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
  expectedRevision?: string | null;
  unixMode?: number | null;
}): Promise<FsWriteResultDto> {
  return invoke<FsWriteResultDto>("fs_write_file", {
    path: params.path,
    content: params.content,
    createDirs: params.createDirs ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
    expectedRevision: params.expectedRevision ?? null,
    unixMode: params.unixMode ?? null,
  });
}

export async function fsListDir(params: {
  path: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<FsDirEntryDto[]> {
  return invoke<FsDirEntryDto[]>("fs_list_dir", {
    path: params.path,
    recursive: params.recursive ?? null,
    includeHidden: params.includeHidden ?? null,
    maxDepth: params.maxDepth ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsSearchFiles(params: {
  roots: WorkspaceFileSearchRootDto[];
  query: string;
  limit?: number;
  includeHidden?: boolean;
  virtualRootEnabled?: boolean;
}): Promise<WorkspaceFileSearchResultDto[]> {
  return invoke<WorkspaceFileSearchResultDto[]>("fs_search_files", {
    roots: params.roots,
    query: params.query,
    limit: params.limit ?? null,
    includeHidden: params.includeHidden ?? null,
    virtualRootEnabled: params.virtualRootEnabled ?? null,
  });
}

export async function fsStat(
  path: string,
  options?: {
    workspaceScope?: WorkspaceScope;
    workspacePath?: string | null;
  },
): Promise<FsFileStatsDto> {
  return invoke<FsFileStatsDto>("fs_stat", {
    path,
    workspaceScope: options?.workspaceScope ?? null,
    workspacePath: options?.workspacePath ?? null,
  });
}

export async function fsExists(
  path: string,
  options?: {
    workspaceScope?: WorkspaceScope;
    workspacePath?: string | null;
  },
): Promise<boolean> {
  return invoke<boolean>("fs_exists", {
    path,
    workspaceScope: options?.workspaceScope ?? null,
    workspacePath: options?.workspacePath ?? null,
  });
}

export async function fsDelete(params: {
  path: string;
  recursive?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
  expectedRevision?: string | null;
}): Promise<void> {
  return invoke("fs_delete", {
    path: params.path,
    recursive: params.recursive ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
    expectedRevision: params.expectedRevision ?? null,
  });
}

export async function fsCreateDir(params: {
  path: string;
  recursive?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<void> {
  return invoke("fs_create_dir", {
    path: params.path,
    recursive: params.recursive ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsCopy(params: {
  src: string;
  dest: string;
}): Promise<number> {
  return invoke<number>("fs_copy", {
    src: params.src,
    dest: params.dest,
  });
}

export async function fsMove(params: {
  src: string;
  dest: string;
}): Promise<void> {
  return invoke("fs_move", {
    src: params.src,
    dest: params.dest,
  });
}
