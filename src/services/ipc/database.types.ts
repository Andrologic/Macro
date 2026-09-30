import type { OmitFields } from './compatibility.types';
import type {
DbInitializationStatusDto as NativeDbInitializationStatusDto
} from '../../types/generated/ipc';

/** database IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbInitializationStatusDto = OmitFields<NativeDbInitializationStatusDto, "status"> & {
  status: "initializing" | "ready" | "failed";
};
