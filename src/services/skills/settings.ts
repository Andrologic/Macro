import type { SkillManifest, SkillSettings } from '../../types';
import { selectEffectiveConfigDocument, useConfigStore } from '../../stores/useConfigStore';
import { patchUserConfigTopLevel } from '../configDocuments';

export const DEFAULT_SKILL_SETTINGS: SkillSettings = {
  enabled: false,
  scriptsEnabled: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const normalizeSkillSettings = (value: unknown): SkillSettings => {
  const candidate = isRecord(value) ? value : {};
  const trust = isRecord(candidate.trust) &&
    typeof candidate.trust.contentHash === 'string' &&
    typeof candidate.trust.grantedAt === 'string' &&
    candidate.trust.grantedBy === 'user'
    ? {
        contentHash: candidate.trust.contentHash,
        grantedAt: candidate.trust.grantedAt,
        grantedBy: 'user' as const,
      }
    : undefined;
  return {
    enabled: candidate.enabled === true,
    scriptsEnabled: candidate.scriptsEnabled === true,
    ...(trust ? { trust } : {}),
  };
};

export const readStoredSkillSettings = (): Record<string, SkillSettings> => {
  const document = selectEffectiveConfigDocument<{ permissions?: Record<string, unknown> }>(
    useConfigStore.getState().snapshot,
    'skills',
  );
  return Object.fromEntries(
    Object.entries(document?.permissions ?? {}).map(([id, settings]) => [
      id,
      normalizeSkillSettings(settings),
    ]),
  );
};

export const isSkillTrustCurrent = (
  settings: SkillSettings,
  contentHash: string | null | undefined,
): boolean => Boolean(
  contentHash &&
  settings.trust?.grantedBy === 'user' &&
  settings.trust.contentHash === contentHash,
);

let settingsWriteQueue: Promise<void> = Promise.resolve();

export const writeStoredSkillSettings = (
  settingsBySkillId: Record<string, SkillSettings>,
): Promise<void> => {
  const normalized = Object.fromEntries(
    Object.entries(settingsBySkillId).map(([id, settings]) => [
      id,
      normalizeSkillSettings(settings),
    ]),
  );
  const write = settingsWriteQueue.catch(() => undefined).then(async () => {
    await patchUserConfigTopLevel('skills', 'permissions', normalized);
  });
  settingsWriteQueue = write.catch(() => undefined);
  return write;
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

// Les anciennes préférences restent sur disque pendant une version, mais ne sont
// volontairement ni lues ni importées dans le nouveau registre JSON.
export const migrateLegacySkillSettings = (
  settingsBySkillId: Record<string, SkillSettings>,
  _skills: SkillManifest[],
): Record<string, SkillSettings> => settingsBySkillId;
