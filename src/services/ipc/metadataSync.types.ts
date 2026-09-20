import type { OmitFields } from './compatibility.types';
import type {
MacroBranchSyncDto as NativeMacroBranchSyncDto
} from '../../types/generated/ipc';

/** metadataSync IPC contracts and explicit frontend adaptations of generated native bindings. */

export type MacroSyncState = "clean" | "pending" | "failed" | "conflict";

export type MacroSyncReason =
  | "clean"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged"
  | "merge_conflict"
  | "missing_origin"
  | "missing_upstream"
  | "auth_required"
  | "network_error"
  | "unknown_error";

export type MacroSyncNextAction =
  | "commit"
  | "push"
  | "pull"
  | "resolve_conflict"
  | "configure_remote"
  | "configure_auth"
  | "retry";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type MacroBranchSyncDto = OmitFields<NativeMacroBranchSyncDto, "state" | "reason" | "next_action"> & {
  state: MacroSyncState;
  reason: MacroSyncReason | null;
  next_action: MacroSyncNextAction | null;
};
