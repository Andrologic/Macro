import type { OmitFields } from './compatibility.types';
import type {
AppUpdateSnapshot as NativeNativeAppUpdateSnapshotDto,
StagedUpdateManifest as NativeNativeStagedUpdateDto
} from '../../types/generated/ipc';

/** updates IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: exposes the existing public view. */
export type NativeStagedUpdateDto = OmitFields<NativeNativeStagedUpdateDto, "generation" | "packageFile" | "signature">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type NativeAppUpdateSnapshotDto = OmitFields<NativeNativeAppUpdateSnapshotDto, "update"> & {
  update: NativeStagedUpdateDto | null;
};
