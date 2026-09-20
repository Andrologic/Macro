import type { OmitFields } from './compatibility.types';
import type {
StateSnapshot as NativeStateSnapshotDto
} from '../../types/generated/ipc';

/** state IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type StateSnapshotDto = OmitFields<NativeStateSnapshotDto, "values"> & {
  values: Record<string, unknown>;
};
