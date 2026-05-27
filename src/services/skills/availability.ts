import type { SkillManifest, SkillSettings } from '../../types';
import { normalizeSkillLookupName } from './identity';

export const isSkillLoadable = (skill: SkillManifest): boolean => skill.isValid;

export const isSkillEffective = (skill: SkillManifest): boolean => !skill.shadowedBySkillId;

export const getEnabledLoadableSkills = (
  skills: SkillManifest[],
  getSettings: (skillId: string) => SkillSettings,
  options?: { includeShadowed?: boolean },
): SkillManifest[] => skills.filter((skill) => {
  if (!isSkillLoadable(skill)) return false;
  if (!getSettings(skill.id).enabled) return false;
  return options?.includeShadowed === true || isSkillEffective(skill);
});

export const getRunnableSkillIds = (
  skills: SkillManifest[],
  getSettings: (skillId: string) => SkillSettings,
  options?: { includeShadowed?: boolean },
): string[] => getEnabledLoadableSkills(skills, getSettings, options)
  .filter((skill) => {
    const settings = getSettings(skill.id);
    return settings.trusted && settings.scriptsEnabled && skill.scripts.length > 0;
  })
  .map((skill) => skill.id);

export const findEnabledSkillByName = (
  name: string,
  enabledLoadableSkillsWithShadowed: SkillManifest[],
  effectiveEnabledSkills: SkillManifest[],
): SkillManifest | null => {
  const normalized = normalizeSkillLookupName(name);
  if (!normalized) return null;

  const exactIdMatch = enabledLoadableSkillsWithShadowed.find((skill) =>
    normalizeSkillLookupName(skill.id) === normalized,
  );
  if (exactIdMatch) return exactIdMatch;

  const matches = effectiveEnabledSkills.filter((skill) =>
    normalizeSkillLookupName(skill.name) === normalized,
  );
  return matches.length === 1 ? matches[0] ?? null : null;
};
