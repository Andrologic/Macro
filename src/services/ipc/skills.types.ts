/** skills IPC DTOs. Kept separate for generated Rust binding integration. */

import type { SkillManifest } from "../../types";

export interface SkillListResponseDto {
  skills: SkillManifest[];
}

export interface SkillDetailResponseDto {
  skill: SkillManifest;
  body: string;
}

export interface SkillResourceReadResponseDto {
  skillId: string;
  path: string;
  content: string;
}
