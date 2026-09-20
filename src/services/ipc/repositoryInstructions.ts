/** repositoryInstructions IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  RepositoryInstructionLoadResultDto,
  RepositoryInstructionProjectInputDto,
} from "./repositoryInstructions.types";

export async function repositoryInstructionsLoad(params: {
  projects: RepositoryInstructionProjectInputDto[];
  maxFiles?: number;
  maxTotalBytes?: number;
}): Promise<RepositoryInstructionLoadResultDto> {
  return invoke<RepositoryInstructionLoadResultDto>("repository_instructions_load", {
    input: {
      projects: params.projects,
      maxFiles: params.maxFiles ?? null,
      maxTotalBytes: params.maxTotalBytes ?? null,
    },
  });
}
