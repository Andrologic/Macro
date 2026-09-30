import type {
DirEntryDto as NativeFsDirEntryDto,
FileContentDto as NativeFsFileContentDto,
FileStatsDto as NativeFsFileStatsDto,
WriteResultDto as NativeFsWriteResultDto,
WorkspaceFileSearchResultDto as NativeWorkspaceFileSearchResultDto,
WorkspaceFileSearchRootDto as NativeWorkspaceFileSearchRootDto
} from '../../types/generated/ipc';
import type { OptionalFields } from './compatibility.types';

/** filesystem IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type FsFileContentDto = OptionalFields<NativeFsFileContentDto, "revision">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type FsDirEntryDto = OptionalFields<NativeFsDirEntryDto,
  | "size"
  | "modified"
  | "created"
  | "language"
>;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceFileSearchRootDto = OptionalFields<NativeWorkspaceFileSearchRootDto, "project_id" | "project_name" | "mount_name">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceFileSearchResultDto = OptionalFields<NativeWorkspaceFileSearchResultDto,
  | "project_id"
  | "project_name"
  | "language"
  | "size_bytes"
  | "modified"
>;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type FsFileStatsDto = OptionalFields<NativeFsFileStatsDto,
  | "created"
  | "accessed"
  | "language"
  | "symlink_target"
>;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type FsWriteResultDto = OptionalFields<NativeFsWriteResultDto, "revision">;
