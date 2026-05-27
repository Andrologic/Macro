import type { SkillManifest, SkillSettings } from '../../types';

const SKILL_SETTINGS_STORAGE_KEY = 'macro_skill_settings';
const SKILL_SETTINGS_VERSION = 1;

type StoredSkillSettings = {
  version: number;
  skills: Record<string, SkillSettings>;
};

export const DEFAULT_SKILL_SETTINGS: SkillSettings = {
  enabled: false,
  trusted: false,
  scriptsEnabled: false,
};

export const normalizeSkillSettings = (value: unknown): SkillSettings => {
  const candidate = value && typeof value === 'object' ? value as Partial<SkillSettings> : {};
  const trusted = candidate.trusted === true;
  return {
    enabled: candidate.enabled === true,
    trusted,
    scriptsEnabled: trusted && candidate.scriptsEnabled === true,
  };
};

export const readStoredSkillSettings = (): Record<string, SkillSettings> => {
  try {
    const raw = localStorage.getItem(SKILL_SETTINGS_STORAGE_KEY);
    if (!raw || raw === 'undefined') return {};
    const parsed = JSON.parse(raw) as Partial<StoredSkillSettings>;
    const skills = parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
    return Object.fromEntries(
      Object.entries(skills).map(([id, settings]) => [id, normalizeSkillSettings(settings)]),
    );
  } catch {
    return {};
  }
};

export const writeStoredSkillSettings = (
  settingsBySkillId: Record<string, SkillSettings>,
): void => {
  localStorage.setItem(
    SKILL_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: SKILL_SETTINGS_VERSION,
      skills: settingsBySkillId,
    } satisfies StoredSkillSettings),
  );
};

export const normalizeSkillNameForLegacyId = (value: string, fallback = 'skill'): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

export const legacySkillIdFor = (skill: SkillManifest): string => {
  const normalizedName = normalizeSkillNameForLegacyId(skill.name);
  return skill.source.kind === 'project'
    ? `project:${skill.source.projectId ?? 'unknown'}:${normalizedName}`
    : `global:${normalizedName}`;
};

export const migrateLegacySkillSettings = (
  settingsBySkillId: Record<string, SkillSettings>,
  skills: SkillManifest[],
): Record<string, SkillSettings> => {
  const next = { ...settingsBySkillId };
  const skillsByLegacyId = new Map<string, SkillManifest[]>();
  for (const skill of skills) {
    const legacyId = legacySkillIdFor(skill);
    skillsByLegacyId.set(legacyId, [...(skillsByLegacyId.get(legacyId) ?? []), skill]);
  }

  let changed = false;
  for (const [legacyId, settings] of Object.entries(settingsBySkillId)) {
    const matches = skillsByLegacyId.get(legacyId) ?? [];
    const effectiveMatches = matches.filter((skill) => !skill.shadowedBySkillId);
    const migrationMatches = effectiveMatches.length === 1 ? effectiveMatches : matches;
    if (migrationMatches.length !== 1) continue;
    const [skill] = migrationMatches;
    if (!skill || skill.id === legacyId) continue;
    if (!next[skill.id]) {
      next[skill.id] = settings;
    }
    delete next[legacyId];
    changed = true;
  }

  if (changed) {
    writeStoredSkillSettings(next);
  }
  return next;
};
