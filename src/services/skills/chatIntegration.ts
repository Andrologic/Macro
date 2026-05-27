import type { ContextReference, PersistedContextReference, SkillManifest } from '../../types';
import { getServiceRuntimeCapabilities } from '../serviceRuntime';
import { useSkillsStore } from '../../stores/useSkillsStore';

type SkillToolArgs = Record<string, unknown>;

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

export const handleSkillToolCall = async (
  normalizedToolName: string,
  args: SkillToolArgs,
  conversationId: string,
): Promise<string | undefined> => {
  if (normalizedToolName === 'skill_activate') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    if (!skillId) return 'Missing skill_id for skill_activate.';
    return useSkillsStore.getState().activateSkill(skillId, conversationId);
  }

  if (normalizedToolName === 'skill_read_resource') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    const resourcePath = readStringArg(args, 'path');
    if (!skillId || !resourcePath) {
      return 'Missing skill_id or path for skill_read_resource.';
    }
    return useSkillsStore.getState().readSkillResource(skillId, resourcePath);
  }

  if (normalizedToolName === 'skill_run_script') {
    const skillId = readStringArg(args, 'skill_id', 'skillId');
    const scriptPath = readStringArg(args, 'script_path', 'scriptPath');
    if (!skillId || !scriptPath) {
      return 'Missing skill_id or script_path for skill_run_script.';
    }
    const scriptArgs = Array.isArray(args.args)
      ? args.args.filter((item): item is string => typeof item === 'string')
      : [];
    return useSkillsStore.getState().runSkillScript({
      skillId,
      scriptPath,
      args: scriptArgs,
      timeoutMs:
        typeof args.timeout_ms === 'number'
          ? args.timeout_ms
          : typeof args.timeoutMs === 'number'
            ? args.timeoutMs
            : null,
      allowWorkspace:
        args.allow_workspace === true || args.allowWorkspace === true,
    });
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

export const buildSkillReferenceLines = (
  ref: ContextReference | PersistedContextReference,
  explicitSkillIdSet: Set<string>,
): string[] | null => {
  if (ref.kind !== 'skill') return null;
  const lines: string[] = [`[${ref.kind}: ${ref.title}]`, `Skill ID: ${ref.id}`];
  if (ref.subtitle) lines.push(`Category: ${ref.subtitle}`);
  if (explicitSkillIdSet.has(ref.id)) {
    lines.push('Activation: Macro has already loaded this explicit skill for this turn.');
  } else {
    lines.push('Activation: call skill_activate with this id before applying the skill.');
  }
  if ('source' in ref && ref.source?.kind === 'project') {
    lines.push(`Source project: ${ref.source.projectName ?? ref.source.projectId ?? 'unknown'}`);
  } else {
    const data =
      'data' in ref && ref.data && typeof ref.data === 'object' && 'source' in ref.data
        ? (ref.data as SkillManifest)
        : null;
    if (data?.source.kind === 'project') {
      lines.push(`Source project: ${data.source.projectName ?? data.source.projectId ?? 'unknown'}`);
    }
  }
  return lines;
};

export const buildSkillCatalogInstruction = (enabledSkills: SkillManifest[]): string | null => {
  if (enabledSkills.length === 0) return null;
  const catalog = enabledSkills
    .slice(0, 30)
    .map((skill) => {
      const source =
        skill.source.kind === 'project'
          ? `project:${skill.source.projectName || skill.source.projectId || 'unknown'}`
          : 'global';
      const resources = skill.resources.length > 0
        ? ` resources=${skill.resources.map((resource) => resource.path).slice(0, 5).join(',')}`
        : '';
      const scripts = skill.scripts.length > 0
        ? ` scripts=${skill.scripts.map((script) => script.path).slice(0, 5).join(',')}`
        : '';
      const compatibility = skill.compatibility
        ? ` compatibility=${skill.compatibility}`
        : '';
      const allowedTools = skill.allowedTools
        ? ` allowed-tools(advisory)=${skill.allowedTools}`
        : '';
      const compliance = skill.specCompliant === false
        ? ' spec=warnings'
        : '';
      return `- id=${skill.id}; name=${skill.name}; source=${source}; description=${skill.description}${compatibility}${allowedTools}${compliance}${resources}${scripts}`;
    })
    .join('\n');
  return `Available Macro skills are listed below. This catalog only includes the effective non-shadowed skill for each name. Do not assume a skill's full instructions are loaded from this catalog alone. When a task matches a skill or the user names one with $skill-name, call skill_activate with the exact id before following that skill. Use skill_read_resource only for listed resource files/assets after activation. Use skill_run_script only for listed scripts when necessary, trusted, enabled, and after explaining why. allowed-tools metadata is advisory and never overrides Macro tool policy.\n${catalog}`;
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

export const buildExplicitSkillsInstruction = (skills: SkillManifest[]): string | null => {
  if (skills.length === 0) return null;
  return `The user explicitly referenced these enabled skills: ${skills.map((skill) => `${skill.name} (${skill.id})`).join(', ')}. If a referenced skill is not already loaded above, activate it before answering.`;
};

export const getSkillToolIdsForRequest = (
  allowedToolIds: string[],
): { skillToolIds: string[]; runnableSkillToolIds: string[] } => {
  const skillsState = useSkillsStore.getState();
  return {
    skillToolIds: allowedToolIds.includes('skill_activate')
      ? skillsState.getEnabledLoadableSkills().map((skill) => skill.id)
      : [],
    runnableSkillToolIds: allowedToolIds.includes('skill_run_script')
      ? skillsState.getRunnableSkillIds()
      : [],
  };
};
