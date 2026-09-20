import type {
TerminalOutputEvent as NativeTerminalOutputEvent,
TerminalPromptContext as NativeTerminalPromptContextInput,
TerminalSessionDto as NativeTerminalSessionDto,
TerminalTabDto as NativeTerminalTabDto
} from '../../types/generated/ipc';
import type { OptionalFields } from './compatibility.types';

/** terminal IPC contracts and explicit frontend adaptations of generated native bindings. */

export type TerminalSessionDto = NativeTerminalSessionDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type TerminalTabDto = OptionalFields<NativeTerminalTabDto, "generation">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type TerminalPromptContextInput = OptionalFields<NativeTerminalPromptContextInput, "projectLabel" | "taskLabel" | "branchLabel">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type TerminalOutputEvent = OptionalFields<NativeTerminalOutputEvent, "generation">;
