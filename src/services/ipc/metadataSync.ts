/** metadataSync IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { MacroBranchSyncDto } from "./metadataSync.types";

export async function macroBranchEnsure(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_ensure", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchStatus(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_status", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchCommitIfDirty(params?: {
  message?: string;
  pilotOnly?: boolean;
  metadataPaths?: string[];
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_commit_if_dirty", {
    message: params?.message ?? null,
    ...(params?.pilotOnly ? { pilotOnly: true, metadataPaths: params.metadataPaths ?? [] } : {}),
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchPush(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_push", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchPull(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_pull", {
    workspacePath: params?.workspacePath ?? null,
  });
}
