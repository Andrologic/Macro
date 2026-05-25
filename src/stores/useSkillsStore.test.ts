import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { SkillManifest } from '../types';

const PROJECT_ROOT = {
  projectId: 'project-1',
  projectName: 'Web',
  path: '/repos/web',
};

const buildSkill = (
  id: string,
  overrides: Partial<SkillManifest> = {},
): SkillManifest => ({
  id,
  name: id.split(':').at(-1) ?? 'skill',
  description: 'Reusable agent guidance',
  rootPath: `/skills/${id.replaceAll(':', '-')}`,
  skillFilePath: `/skills/${id.replaceAll(':', '-')}/SKILL.md`,
  source: id.startsWith('project:')
    ? {
        kind: 'project',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repos/web',
      }
    : {
        kind: 'global',
        projectId: null,
        projectName: null,
        rootPath: '/Users/test/.agents/skills',
      },
  resources: [{ path: 'references/style.md', kind: 'reference', sizeBytes: 12 }],
  scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 20 }],
  validationErrors: [],
  isValid: true,
  ...overrides,
});

let importCounter = 0;

const loadSkillsStore = async (skills: SkillManifest[]) => {
  mock.restore();

  const services = {
    listSkills: mock(async (data?: { projectRoots?: unknown[] }) => ({
      skills,
      projectRoots: data?.projectRoots ?? [],
    })),
    getSkill: mock(async ({ skillId }: { skillId: string }) => ({
      skill: skills.find((skill) => skill.id === skillId) ?? buildSkill(skillId),
      body: '# Instructions\nUse the project style.',
    })),
    installSkillFromLocalPath: mock(async () => skills[0]),
    readSkillResource: mock(async () => ({
      skillId: skills[0]?.id ?? 'global:missing',
      path: 'references/style.md',
      content: 'Use concise UI copy.',
    })),
    runSkillScript: mock(async () => ({
      skillId: skills[0]?.id ?? 'global:missing',
      scriptPath: 'scripts/check.sh',
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })),
  };

  const appState = {
    projectGroups: [
      {
        id: 'group-1',
        name: 'Macro',
        projects: [
          {
            id: PROJECT_ROOT.projectId,
            name: PROJECT_ROOT.projectName,
            path: PROJECT_ROOT.path,
          },
        ],
      },
    ],
    selectedProjectId: PROJECT_ROOT.projectId,
    getProjectById: (projectId: string) =>
      projectId === PROJECT_ROOT.projectId
        ? {
            id: PROJECT_ROOT.projectId,
            name: PROJECT_ROOT.projectName,
            path: PROJECT_ROOT.path,
          }
        : null,
  };
  const useAppStore = ((selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState) as unknown as {
    (selector?: (state: typeof appState) => unknown): unknown;
    getState: () => typeof appState;
  };
  useAppStore.getState = () => appState;

  mock.module('../services', () => ({ services }));
  mock.module('./useAppStore', () => ({ useAppStore }));

  importCounter += 1;
  const module = await import(`./useSkillsStore.ts?skills-store-test=${importCounter}`);
  return { useSkillsStore: module.useSkillsStore, services };
};

describe('useSkillsStore', () => {
  afterEach(() => {
    localStorage.clear();
    mock.restore();
  });

  it('loads persisted settings and sends active project roots to the service', async () => {
    const skill = buildSkill('project:project-1:docs', { name: 'docs' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, trusted: true, scriptsEnabled: true },
        },
      }),
    );
    const { useSkillsStore, services } = await loadSkillsStore([skill]);

    await useSkillsStore.getState().loadSettings();

    expect(services.listSkills.mock.calls[0]?.[0]).toEqual({
      projectRoots: [PROJECT_ROOT],
    });
    expect(useSkillsStore.getState().getEnabledSkills()).toEqual([skill]);
    expect(useSkillsStore.getState().getSkillSettings(skill.id)).toEqual({
      enabled: true,
      trusted: true,
      scriptsEnabled: true,
    });
  });

  it('imports local skills as enabled but untrusted global skills', async () => {
    const skill = buildSkill('global:formatter', { name: 'formatter' });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);

    await useSkillsStore.getState().installSkillFromLocalPath('/tmp/formatter');

    expect(services.installSkillFromLocalPath).toHaveBeenCalledWith({
      sourcePath: '/tmp/formatter',
    });
    expect(useSkillsStore.getState().getSkillSettings(skill.id)).toEqual({
      enabled: true,
      trusted: false,
      scriptsEnabled: false,
    });
    expect(JSON.parse(localStorage.getItem('macro_skill_settings') ?? '{}')).toMatchObject({
      skills: {
        [skill.id]: { enabled: true, trusted: false, scriptsEnabled: false },
      },
    });
  });

  it('activates instructions and reads resources only for enabled valid skills', async () => {
    const skill = buildSkill('project:project-1:docs', { name: 'docs' });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    const disabledActivation = await useSkillsStore
      .getState()
      .activateSkill(skill.id, 'conversation-1');
    expect(disabledActivation).toContain('disabled');

    useSkillsStore.getState().setSkillEnabled(skill.id, true);
    const activation = await useSkillsStore.getState().activateSkill(skill.id, 'conversation-1');
    const resource = await useSkillsStore.getState().readSkillResource(
      skill.id,
      'references/style.md',
    );

    expect(activation).toContain('# Instructions');
    expect(resource).toBe('Use concise UI copy.');
    expect(services.getSkill).toHaveBeenCalledWith({
      skillId: skill.id,
      projectRoots: [PROJECT_ROOT],
    });
    expect(services.readSkillResource).toHaveBeenCalledWith({
      skillId: skill.id,
      resourcePath: 'references/style.md',
      projectRoots: [PROJECT_ROOT],
    });
    expect(useSkillsStore.getState().activationsByConversationId['conversation-1']?.[0])
      .toMatchObject({ skillId: skill.id });
  });

  it('blocks script execution until the skill is trusted and scripts are enabled', async () => {
    const skill = buildSkill('project:project-1:runner', { name: 'runner' });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    })).toContain('disabled');

    useSkillsStore.getState().setSkillEnabled(skill.id, true);
    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    })).toContain('script execution is disabled');

    useSkillsStore.getState().setSkillTrusted(skill.id, true);
    useSkillsStore.getState().setSkillScriptsEnabled(skill.id, true);
    const result = await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
      args: ['--fix'],
      allowWorkspace: true,
    });

    expect(result).toContain('STDOUT:\nok');
    expect(services.runSkillScript).toHaveBeenCalledWith({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
      args: ['--fix'],
      allowWorkspace: true,
      projectRoots: [PROJECT_ROOT],
      workspacePath: PROJECT_ROOT.path,
    });
  });

  it('prefers project skills over global skills for explicit name mentions', async () => {
    const projectSkill = buildSkill('project:project-1:docs', { name: 'docs' });
    const globalSkill = buildSkill('global:docs', { name: 'docs' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [projectSkill.id]: { enabled: true, trusted: false, scriptsEnabled: false },
          [globalSkill.id]: { enabled: true, trusted: false, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore } = await loadSkillsStore([projectSkill, globalSkill]);

    await useSkillsStore.getState().loadSettings();

    expect(useSkillsStore.getState().findEnabledSkillByName('docs')).toEqual(projectSkill);
    expect(useSkillsStore.getState().resolveEnabledSkillMentions('Use $docs')).toEqual([
      projectSkill,
    ]);
  });
});
