import type {
BackupStatus as NativeLocalBackupStatus
} from '../../types/generated/ipc';
import type { OptionalFields } from './compatibility.types';

/** backup IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type LocalBackupStatus = OptionalFields<NativeLocalBackupStatus, "code" | "path">;
