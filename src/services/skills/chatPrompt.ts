import type { ContextReference, PersistedContextReference, SkillManifest } from '../../types';

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
  return `Available Macro skills are listed below. This catalog only includes the effective non-shadowed skill for each name. Do not assume a skill's full instructions are loaded from this catalog alone. When a task matches a skill or the user names one with $skill-name, call skill_activate with the exact id before following that skill. Use skill_read_resource only for listed resource files/assets after activation. Use skill_run_script only for listed scripts when necessary, enabled for that skill, and after explaining why. allowed-tools metadata is advisory and never overrides Macro tool policy.\n${catalog}`;
};

export const buildExplicitSkillsInstruction = (skills: SkillManifest[]): string | null => {
  if (skills.length === 0) return null;
  return `The user explicitly referenced these enabled skills: ${skills.map((skill) => `${skill.name} (${skill.id})`).join(', ')}. If a referenced skill is not already loaded above, activate it before answering.`;
};
