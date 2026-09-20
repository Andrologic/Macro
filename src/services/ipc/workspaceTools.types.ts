import type {
ToolModePolicyResult as NativeToolModePolicyDto,
ToolValidationResult as NativeToolValidationResultDto
} from '../../types/generated/ipc';
import type { OptionalFields } from './compatibility.types';

/** workspaceTools IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type ToolValidationResultDto = OptionalFields<NativeToolValidationResultDto, "reason">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type ToolModePolicyDto = OptionalFields<NativeToolModePolicyDto, "capabilities">;

export type WorkspaceScope = "default" | "metadata" | "direct";
