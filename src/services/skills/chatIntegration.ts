export { buildSkillReferenceLines, buildSkillCatalogInstruction, buildExplicitSkillsInstruction } from './chatPrompt';
import type {
  ContextReference,
  PersistedContextReference,
  SkillManifest,
  SkillPermissionSnapshot,
} from '../../types';
import { getServiceRuntimeCapabilities } from '../serviceRuntime';
import { useSkillsStore } from '../../stores/useSkillsStore';
import type { ToolResultResolution } from '../streamingChat';
import { formatScriptResult } from './activation';
import type { ProjectExecutionContext } from '../projectExecutionContext';

type SkillToolArgs = Record<string, unknown>;

const skillToolError = (result: string): ToolResultResolution => ({
  kind: 'result',
  result,
  isError: true,
  errorKind: 'permission',
  toString: () => result,
});

const readStringArg = (
  args: SkillToolArgs,
  snakeName: string,
  camelName: string = snakeName,
): string => {
  const snakeValue = args[snakeName];
  const camelValue = args[camelName];
  return typeof snakeValue === 'string'
    ? snakeValue.trim()
    : typeof camelValue === 'string'
      ? camelValue.trim()
      : '';
};

const snapshotSkillPermission = (
  snapshot: SkillPermissionSnapshot | null | undefined,
  skillId: string,
) => snapshot?.skills[skillId] ?? null;

const isSkillEnabledInSnapshot = (
  snapshot: SkillPermissionSnapshot | null | undefined,
  skillId: string,
): boolean => !snapshot || snapshotSkillPermission(snapshot, skillId)?.enabled === true;

const isSkillScriptRunnableInSnapshot = (
  snapshot: SkillPermissionSnapshot | null | undefined,
  skillId: string,
): boolean => {
  if (!snapshot) return true;
  const permission = snapshotSkillPermission(snapshot, skillId);
  return permission?.enabled === true &&
    permission.scriptsEnabled === true &&
    permission.hasScripts === true &&
    Boolean(permission.contentHash) &&
    permission.contentHash === permission.trustedContentHash;
};

export const handleSkillToolCall = async (
  normalizedToolName: string,
  args: SkillToolArgs,
  conversationId: string,
  permissionSnapshot: SkillPermissionSnapshot | null =
    useSkillsStore.getState().getSkillPermissionSnapshot(conversationId),
  executionContext?: ProjectExecutionContext,
  chatAdmission?: import('../ipc/chatAdmission').ChatToolAdmission,
): Promise<ToolResultResolution | string | undefined> => {
  if (normalizedToolName === 'skill_activate') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    if (!skillId) return 'Missing skill_id for skill_activate.';
    if (!isSkillEnabledInSnapshot(permissionSnapshot, skillId)) {
      return skillToolError(`Skill ${skillId} was not enabled when this turn started. Enable it in Settings > Skills and retry on the next turn.`);
    }
    const result = await useSkillsStore.getState().activateSkill(skillId, conversationId);
    return /^(?:Skill .+ is (?:disabled|invalid))/.test(result)
      ? skillToolError(result)
      : result;
  }

  if (normalizedToolName === 'skill_read_resource') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    const resourcePath = readStringArg(args, 'path');
    if (!skillId || !resourcePath) {
      return 'Missing skill_id or path for skill_read_resource.';
    }
    if (!isSkillEnabledInSnapshot(permissionSnapshot, skillId)) {
      return skillToolError(`Skill ${skillId} was not enabled when this turn started. Enable it in Settings > Skills and retry on the next turn.`);
    }
    const result = await useSkillsStore.getState().readSkillResource(skillId, resourcePath);
    return /^Skill .+ is (?:disabled|invalid)/.test(result)
      ? skillToolError(result)
      : result;
  }

  if (normalizedToolName === 'skill_run_script') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    const scriptPath = readStringArg(args, 'script_path', 'scriptPath');
    if (!skillId || !scriptPath) {
      return 'Missing skill_id or script_path for skill_run_script.';
    }
    if (!isSkillScriptRunnableInSnapshot(permissionSnapshot, skillId)) {
      return skillToolError('Skill scripts were not enabled when this turn started. Enable Scripts for this skill in Settings and retry on the next turn.');
    }
    const scriptArgs = Array.isArray(args.args)
      ? args.args.filter((item): item is string => typeof item === 'string')
      : [];
    const result = await useSkillsStore.getState().runSkillScriptResult({
      skillId,
      scriptPath,
      executionContext: {
        projectId: executionContext?.projectId ?? null,
        workspacePath: executionContext?.projectId &&
          executionContext.actionableProjectIds.includes(executionContext.projectId)
          ? executionContext.workspacePathsByProjectId[executionContext.projectId] ?? null
          : null,
      },
      args: scriptArgs,
      timeoutMs:
        typeof args.timeout_ms === 'number'
          ? args.timeout_ms
          : typeof args.timeoutMs === 'number'
            ? args.timeoutMs
            : null,
      allowWorkspace:
        args.allow_workspace === true || args.allowWorkspace === true,
    }, permissionSnapshot, chatAdmission);
    if (typeof result === 'string') return skillToolError(result);
    const formatted = formatScriptResult(result);
    return result.timedOut
      ? {
          kind: 'result',
          result: formatted,
          isError: true,
          errorKind: 'execution',
          toString: () => formatted,
        }
      : formatted;
  }

  return undefined;
};

export const filterSkillToolsForAvailability = (
  toolIds: string[],
  options: { tauriAvailable: boolean },
): string[] => {
  const skillsState = useSkillsStore.getState();
  const runtimeCapabilities = getServiceRuntimeCapabilities({
    tauriAvailable: options.tauriAvailable,
  });
  const enabledLoadableSkills = skillsState.getEnabledLoadableSkills();
  const hasEnabledLoadableSkill = enabledLoadableSkills.length > 0;
  const hasRunnableSkill =
    runtimeCapabilities.skillScripts && skillsState.getRunnableSkillIds().length > 0;

  return toolIds.filter((toolId) => {
    if (toolId === 'skill_activate' || toolId === 'skill_read_resource') {
      return runtimeCapabilities.skills && hasEnabledLoadableSkill;
    }
    if (toolId === 'skill_run_script') {
      return runtimeCapabilities.skills && hasEnabledLoadableSkill && hasRunnableSkill;
    }
    return true;
  });
};

export const collectExplicitSkillsForPrompt = (
  userContent: string | null | undefined,
  contextRefs: Array<ContextReference | PersistedContextReference>,
): SkillManifest[] => {
  const skillsState = useSkillsStore.getState();
  const mentionedSkills = userContent
    ? skillsState.resolveEnabledSkillMentions(userContent)
    : [];
  const selectedSkills = contextRefs
    .filter((ref) => ref.kind === 'skill')
    .map((ref) => skillsState.getSkillById(ref.id))
    .filter((skill): skill is SkillManifest => Boolean(skill));
  return Array.from(
    new Map([...mentionedSkills, ...selectedSkills].map((skill) => [skill.id, skill])).values(),
  );
};

export const getSkillToolIdsForRequest = (
  allowedToolIds: string[],
  permissionSnapshot?: SkillPermissionSnapshot | null,
): { skillToolIds: string[]; runnableSkillToolIds: string[] } => {
  const skillsState = useSkillsStore.getState();
  return {
    skillToolIds: allowedToolIds.includes('skill_activate')
      ? skillsState.getEnabledLoadableSkills({ permissionSnapshot }).map((skill) => skill.id)
      : [],
    runnableSkillToolIds: allowedToolIds.includes('skill_run_script')
      ? skillsState.getRunnableSkillIds({ permissionSnapshot })
      : [],
  };
};
