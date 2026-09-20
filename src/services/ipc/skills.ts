/** skills IPC wrappers and frontend adapters. */

import type {
  SkillLocationOpenRequest,
  SkillManifest,
  SkillProjectRoot,
  SkillScriptRunResult,
  SkillTemplateCreateRequest,
  SkillTemplateCreateResult,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import type {
  SkillDetailResponseDto,
  SkillListResponseDto,
  SkillResourceReadResponseDto,
} from "./skills.types";

export async function skillsList(params: {
  projectRoots?: SkillProjectRoot[];
}): Promise<SkillListResponseDto> {
  return invoke<SkillListResponseDto>("skills_list", {
    projectRoots: params.projectRoots ?? [],
  });
}

export async function skillsGet(params: {
  skillId: string;
  projectRoots?: SkillProjectRoot[];
}): Promise<SkillDetailResponseDto> {
  return invoke<SkillDetailResponseDto>("skills_get", {
    skillId: params.skillId,
    projectRoots: params.projectRoots ?? [],
  });
}

export async function skillsInstallFromLocalPath(params: {
  sourcePath: string;
}): Promise<SkillManifest> {
  return invoke<SkillManifest>("skills_install_from_local_path", {
    sourcePath: params.sourcePath,
  });
}

export async function skillsCreateTemplate(
  params: SkillTemplateCreateRequest,
): Promise<SkillTemplateCreateResult> {
  return invoke<SkillTemplateCreateResult>("skills_create_template", {
    name: params.name,
    description: params.description,
    destinationKind: params.destinationKind,
    destinationId: params.destinationId ?? null,
    projectId: params.projectId ?? null,
    projectRoots: params.projectRoots ?? [],
  });
}

export async function skillsOpenLocation(
  params: SkillLocationOpenRequest,
): Promise<void> {
  return invoke<void>("skills_open_location", {
    skillId: params.skillId,
    target: params.target,
    projectRoots: params.projectRoots ?? [],
  });
}

export async function skillsReadResource(params: {
  skillId: string;
  resourcePath: string;
  projectRoots?: SkillProjectRoot[];
}): Promise<SkillResourceReadResponseDto> {
  return invoke<SkillResourceReadResponseDto>("skills_read_resource", {
    skillId: params.skillId,
    resourcePath: params.resourcePath,
    projectRoots: params.projectRoots ?? [],
  });
}

export async function skillsRunScript(params: {
  skillId: string;
  scriptPath: string;
  args?: string[];
  timeoutMs?: number | null;
  allowWorkspace?: boolean;
  workspacePath?: string | null;
  projectRoots?: SkillProjectRoot[];
}): Promise<SkillScriptRunResult> {
  return invoke<SkillScriptRunResult>("skills_run_script", {
    skillId: params.skillId,
    scriptPath: params.scriptPath,
    args: params.args ?? [],
    timeoutMs: params.timeoutMs ?? null,
    allowWorkspace: params.allowWorkspace ?? false,
    workspacePath: params.workspacePath ?? null,
    projectRoots: params.projectRoots ?? [],
  });
}
