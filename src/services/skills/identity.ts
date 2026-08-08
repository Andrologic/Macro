import type {
  ContextReference,
  PersistedContextReference,
  SkillLocation,
  SkillManifest,
} from '../../types';

export const normalizeSkillLookupName = (value: string): string =>
  value.trim().replace(/^\$/, '').normalize('NFKC').toLowerCase();

export const getSkillLocation = (skill: SkillManifest): SkillLocation => (
  skill.location ?? {
    kind: 'local',
    uri: skill.rootPath ?? skill.skillFilePath ?? skill.id,
  }
);

export const getSkillLocationUri = (skill: SkillManifest): string =>
  getSkillLocation(skill).uri;

export const getRefSkillIdentity = (
  ref: ContextReference | PersistedContextReference,
): { contentHash?: string; locationUri?: string; skillFilePath?: string | null } => {
  const refData = 'data' in ref ? ref.data : undefined;
  const data =
    refData && typeof refData === 'object' && 'name' in refData
      ? (refData as SkillManifest)
      : null;
  return {
    contentHash: ('contentHash' in ref ? ref.contentHash : undefined) ?? data?.contentHash,
    locationUri: ('location' in ref ? ref.location?.uri : undefined) ?? data?.location?.uri,
    skillFilePath: ('skillFilePath' in ref ? ref.skillFilePath : undefined) ?? data?.skillFilePath,
  };
};

export const skillIdentityChanged = (
  skill: SkillManifest,
  expectedIdentity: { contentHash?: string; locationUri?: string; skillFilePath?: string | null },
): boolean => {
  const locationUri = getSkillLocationUri(skill);
  const changedPath = Boolean(
    expectedIdentity.skillFilePath &&
    skill.skillFilePath &&
    skill.skillFilePath !== expectedIdentity.skillFilePath,
  );
  const changedHash = Boolean(
    expectedIdentity.contentHash &&
    skill.contentHash &&
    skill.contentHash !== expectedIdentity.contentHash,
  );
  const changedLocation = Boolean(
    !expectedIdentity.contentHash &&
    expectedIdentity.locationUri &&
    expectedIdentity.locationUri !== locationUri,
  );
  return changedPath || changedHash || changedLocation;
};
