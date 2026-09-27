import type {
RepositoryInstructionIssue as NativeRepositoryInstructionIssueDto,
RepositoryInstructionLoadResult as NativeRepositoryInstructionLoadResultDto,
RepositoryInstructionProjectInput as NativeRepositoryInstructionProjectInputDto,
RepositoryInstructionSource as NativeRepositoryInstructionSourceDto
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** repositoryInstructions IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type RepositoryInstructionProjectInputDto = OptionalFields<NativeRepositoryInstructionProjectInputDto, "scopePath">;

export type RepositoryInstructionSourceDto = NativeRepositoryInstructionSourceDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type RepositoryInstructionIssueDto = OptionalFields<NativeRepositoryInstructionIssueDto, "sourcePath">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type RepositoryInstructionLoadResultDto = OmitFields<NativeRepositoryInstructionLoadResultDto, "issues"> & {
  issues: RepositoryInstructionIssueDto[];
};
