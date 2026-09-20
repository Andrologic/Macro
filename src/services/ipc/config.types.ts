import type { OmitFields } from './compatibility.types';
import type {
OrphanSecretDto as NativeOrphanSecretDto
} from '../../types/generated/ipc';

/** config IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type OrphanSecretDto = OmitFields<NativeOrphanSecretDto, "secretType"> & {
  secretType: 'apiKey' | 'chatgptSession';
};
