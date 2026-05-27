import { describe, expect, it } from 'bun:test';
import type { SkillManifest, SkillSettings } from '../../types';
import { getRunnableSkillIds, findEnabledSkillByName } from './availability';
import { getSkillLocationUri, skillIdentityChanged } from './identity';
import { normalizeSkillMentionName, parseMentionNames } from './mentions';

const buildSkill = (
  id: string,
  overrides: Partial<SkillManifest> = {},
): SkillManifest => ({
  id,
  name: 'docs',
  description: 'Documentation skill',
  rootPath: '/skills/docs',
  skillFilePath: '/skills/docs/SKILL.md',
  location: { kind: 'local', uri: '/skills/docs' },
  source: {
    kind: 'global',
    namespace: 'agents',
    projectId: null,
    projectName: null,
    rootPath: '/skills',
    skillRootPath: '/skills',
  },
  resources: [],
  scripts: [],
  diagnostics: [],
  specCompliant: true,
  shadowedBySkillId: null,
  contentHash: 'hash-a',
  validationErrors: [],
  isValid: true,
  ...overrides,
});

describe('skills helpers', () => {
  it('parses Unicode dollar and bracket skill mentions with NFKC normalization', () => {
    expect(parseMentionNames('Use $技能 and [skill: café] now')).toEqual(['技能', 'café']);
    expect(normalizeSkillMentionName('cafe\u{0301}')).toBe('café');
  });

  it('uses location uri for remote manifests without local paths', () => {
    const remoteSkill = buildSkill('remote:registry:docs:abc', {
      rootPath: null,
      skillFilePath: null,
      location: { kind: 'remote', uri: 'macro://skills/docs' },
    });

    expect(getSkillLocationUri(remoteSkill)).toBe('macro://skills/docs');
    expect(skillIdentityChanged(remoteSkill, { locationUri: 'macro://skills/docs' })).toBe(false);
    expect(skillIdentityChanged(remoteSkill, { locationUri: 'macro://skills/other' })).toBe(true);
  });

  it('finds effective skills by name while allowing shadowed exact-id matches', () => {
    const effective = buildSkill('global:agents:docs:aaa', { name: 'docs' });
    const shadowed = buildSkill('global:codex:docs:bbb', {
      name: 'docs',
      shadowedBySkillId: effective.id,
    });

    expect(findEnabledSkillByName('docs', [effective, shadowed], [effective])).toBe(effective);
    expect(findEnabledSkillByName(shadowed.id, [effective, shadowed], [effective])).toBe(shadowed);
  });

  it('returns runnable ids only for enabled trusted skills with scripts', () => {
    const runner = buildSkill('global:agents:runner:aaa', {
      name: 'runner',
      scripts: [{ path: 'scripts/run.sh', kind: 'script', sizeBytes: 12 }],
    });
    const plain = buildSkill('global:agents:plain:bbb', { name: 'plain' });
    const settings: Record<string, SkillSettings> = {
      [runner.id]: { enabled: true, trusted: true, scriptsEnabled: true },
      [plain.id]: { enabled: true, trusted: true, scriptsEnabled: true },
    };

    expect(getRunnableSkillIds([runner, plain], (id) => settings[id] ?? {
      enabled: false,
      trusted: false,
      scriptsEnabled: false,
    })).toEqual([runner.id]);
  });
});
