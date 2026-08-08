import type { SkillManifest, SkillPermissionSnapshot, SkillSettings } from '../../types';
import { normalizeSkillLookupName } from './identity';

export const isSkillLoadable = (skill: SkillManifest): boolean => skill.isValid;

export const isSkillEffective = (skill: SkillManifest): boolean => !skill.shadowedBySkillId;

type SkillAvailabilityOptions = {
  includeShadowed?: boolean;
  permissionSnapshot?: SkillPermissionSnapshot | null;
};

const isEnabledForSnapshotOrSettings = (
  skill: SkillManifest,
  getSettings: (skillId: string) => SkillSettings,
  permissionSnapshot?: SkillPermissionSnapshot | null,
): boolean => {
  if (permissionSnapshot) {
    return permissionSnapshot.skills[skill.id]?.enabled === true;
  }
  return getSettings(skill.id).enabled;
};

const isRunnableForSnapshotOrSettings = (
  skill: SkillManifest,
  getSettings: (skillId: string) => SkillSettings,
  permissionSnapshot?: SkillPermissionSnapshot | null,
): boolean => {
  if (permissionSnapshot) {
    const permission = permissionSnapshot.skills[skill.id];
    return permission?.enabled === true &&
      permission.scriptsEnabled === true &&
      permission.hasScripts === true &&
      skill.scripts.length > 0;
  }
  const settings = getSettings(skill.id);
  return settings.scriptsEnabled && skill.scripts.length > 0;
};

export const getEnabledLoadableSkills = (
  skills: SkillManifest[],
  getSettings: (skillId: string) => SkillSettings,
  options?: SkillAvailabilityOptions,
): SkillManifest[] => skills.filter((skill) => {
  if (!isSkillLoadable(skill)) return false;
  if (!isEnabledForSnapshotOrSettings(skill, getSettings, options?.permissionSnapshot)) return false;
  return options?.includeShadowed === true || isSkillEffective(skill);
});

export const getRunnableSkillIds = (
  skills: SkillManifest[],
  getSettings: (skillId: string) => SkillSettings,
  options?: SkillAvailabilityOptions,
): string[] => getEnabledLoadableSkills(skills, getSettings, options)
  .filter((skill) =>
    isRunnableForSnapshotOrSettings(skill, getSettings, options?.permissionSnapshot)
  )
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
