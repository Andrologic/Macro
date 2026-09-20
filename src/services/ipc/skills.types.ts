import type { OmitFields } from './compatibility.types';
import type {
SkillDetailResponse as NativeSkillDetailResponseDto,
SkillListResponse as NativeSkillListResponseDto,
SkillResourceReadResponse as NativeSkillResourceReadResponseDto
} from '../../types/generated/ipc';

/** skills IPC contracts and explicit frontend adaptations of generated native bindings. */

import type { SkillManifest } from "../../types";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type SkillListResponseDto = OmitFields<NativeSkillListResponseDto, "skills"> & {
  skills: SkillManifest[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type SkillDetailResponseDto = OmitFields<NativeSkillDetailResponseDto, "skill"> & {
  skill: SkillManifest;
};

export type SkillResourceReadResponseDto = NativeSkillResourceReadResponseDto;
