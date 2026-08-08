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
  name: id.startsWith('project:')
    ? id.split(':').at(-2) ?? 'skill'
    : id.split(':').at(-2) ?? id.split(':').at(-1) ?? 'skill',
  description: 'Reusable agent guidance',
  rootPath: `/skills/${id.replaceAll(':', '-')}`,
  skillFilePath: `/skills/${id.replaceAll(':', '-')}/SKILL.md`,
  source: id.startsWith('project:')
    ? {
        kind: 'project',
        namespace: (id.split(':')[2] as SkillManifest['source']['namespace']) ?? 'agents',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repos/web',
        skillRootPath: '/repos/web/.agents/skills',
      }
    : {
        kind: 'global',
        namespace: (id.split(':')[1] as SkillManifest['source']['namespace']) ?? 'agents',
        projectId: null,
        projectName: null,
        rootPath: '/Users/test/.agents/skills',
        skillRootPath: '/Users/test/.agents/skills',
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
    createSkillTemplate: mock(async () => ({
      skill: skills[0],
      folderPath: skills[0]?.rootPath ?? '/skills/new-skill',
      skillFilePath: skills[0]?.skillFilePath ?? '/skills/new-skill/SKILL.md',
    })),
    openSkillLocation: mock(async () => undefined),
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
    const skill = buildSkill('project:project-1:agents:docs:aaa111', { name: 'docs' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: true, extraLegacyFlag: false },
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
      scriptsEnabled: true,
    });
    expect(JSON.parse(localStorage.getItem('macro_skill_settings') ?? '{}')).toEqual({
      version: 2,
      skills: {
        [skill.id]: { enabled: true, scriptsEnabled: true },
      },
    });
  });

  it('imports local skills as enabled with scripts disabled', async () => {
    const skill = buildSkill('global:agents:formatter:aaa111', { name: 'formatter' });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);

    await useSkillsStore.getState().installSkillFromLocalPath('/tmp/formatter');

    expect(services.installSkillFromLocalPath).toHaveBeenCalledWith({
      sourcePath: '/tmp/formatter',
    });
    expect(useSkillsStore.getState().getSkillSettings(skill.id)).toEqual({
      enabled: true,
      scriptsEnabled: false,
    });
    expect(JSON.parse(localStorage.getItem('macro_skill_settings') ?? '{}')).toMatchObject({
      skills: {
        [skill.id]: { enabled: true, scriptsEnabled: false },
      },
    });
  });

  it('creates skill templates with a destination and opens skill locations through the service', async () => {
    const skill = buildSkill('project:project-1:agents:new-skill:aaa111', {
      name: 'new-skill',
    });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);

    const created = await useSkillsStore.getState().createSkillTemplate({
      name: 'new-skill',
      description: 'Use when Macro needs focused guidance.',
      destinationKind: 'project',
      projectId: PROJECT_ROOT.projectId,
    });
    const opened = await useSkillsStore.getState().openSkillLocation(skill.id, 'skillFile');

    expect(created).toEqual(skill);
    expect(services.createSkillTemplate).toHaveBeenCalledWith({
      name: 'new-skill',
      description: 'Use when Macro needs focused guidance.',
      destinationKind: 'project',
      projectId: PROJECT_ROOT.projectId,
      projectRoots: [PROJECT_ROOT],
    });
    expect(useSkillsStore.getState().getSkillSettings(skill.id)).toEqual({
      enabled: true,
      scriptsEnabled: false,
    });
    expect(services.openSkillLocation).toHaveBeenCalledWith({
      skillId: skill.id,
      target: 'skillFile',
      projectRoots: [PROJECT_ROOT],
    });
    expect(opened).toBe(true);
  });

  it('activates instructions and reads resources only for enabled valid skills', async () => {
    const skill = buildSkill('project:project-1:agents:docs:aaa111', { name: 'docs' });
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

  it('blocks script execution until the skill is enabled and scripts are enabled', async () => {
    const skill = buildSkill('project:project-1:agents:runner:aaa111', { name: 'runner' });
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    })).toContain('disabled');

    useSkillsStore.getState().setSkillScriptsEnabled(skill.id, true);
    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    })).toContain('disabled');

    useSkillsStore.getState().setSkillScriptsEnabled(skill.id, false);
    useSkillsStore.getState().setSkillEnabled(skill.id, true);
    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    })).toContain('Scripts are disabled for this skill');

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

  it('uses permission snapshots as a floor and live settings as a revocation veto', async () => {
    const skill = buildSkill('project:project-1:agents:runner:aaa111', { name: 'runner' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    const beforeGrant = useSkillsStore
      .getState()
      .createSkillPermissionSnapshot('conversation-1', 'turn-1');
    useSkillsStore.getState().setSkillScriptsEnabled(skill.id, true);

    expect(useSkillsStore.getState().getRunnableSkillIds()).toEqual([skill.id]);
    expect(useSkillsStore.getState().getRunnableSkillIds({
      permissionSnapshot: beforeGrant,
    })).toEqual([]);
    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    }, beforeGrant)).toContain('when this turn started');

    const afterGrant = useSkillsStore
      .getState()
      .createSkillPermissionSnapshot('conversation-1', 'turn-2');
    expect(useSkillsStore.getState().getRunnableSkillIds({
      permissionSnapshot: afterGrant,
    })).toEqual([skill.id]);

    useSkillsStore.getState().setSkillScriptsEnabled(skill.id, false);
    expect(await useSkillsStore.getState().runSkillScript({
      skillId: skill.id,
      scriptPath: 'scripts/check.sh',
    }, afterGrant)).toContain('Scripts are disabled for this skill');
    expect(services.runSkillScript).not.toHaveBeenCalled();
  });

  it('refuses ambiguous explicit name mentions', async () => {
    const projectSkill = buildSkill('project:project-1:agents:docs:aaa111', { name: 'docs' });
    const globalSkill = buildSkill('global:agents:docs:bbb222', { name: 'docs' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [projectSkill.id]: { enabled: true, scriptsEnabled: false },
          [globalSkill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore } = await loadSkillsStore([projectSkill, globalSkill]);

    await useSkillsStore.getState().loadSettings();

    expect(useSkillsStore.getState().findEnabledSkillByName('docs')).toBeNull();
    expect(useSkillsStore.getState().resolveEnabledSkillMentions('Use $docs')).toEqual([]);

    const preparation = await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: 'Use $docs',
      toolsAvailable: true,
    });
    expect(preparation.systemInstructionBlocks).toEqual([]);
    expect(preparation.warnings[0]).toContain('ambiguous');
  });

  it('uses effective skills by name while allowing shadowed skills by exact id', async () => {
    const projectSkill = buildSkill('project:project-1:agents:docs:aaa111', { name: 'docs' });
    const globalSkill = buildSkill('global:agents:docs:bbb222', {
      name: 'docs',
      shadowedBySkillId: projectSkill.id,
    });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [projectSkill.id]: { enabled: true, scriptsEnabled: false },
          [globalSkill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore, services } = await loadSkillsStore([projectSkill, globalSkill]);

    await useSkillsStore.getState().loadSettings();

    expect(useSkillsStore.getState().getEnabledSkills()).toEqual([projectSkill]);
    expect(useSkillsStore.getState().findEnabledSkillByName('docs')).toEqual(projectSkill);
    expect(useSkillsStore.getState().findEnabledSkillByName(globalSkill.id)).toEqual(globalSkill);
    expect(useSkillsStore.getState().resolveEnabledSkillMentions('Use $docs')).toEqual([projectSkill]);

    useSkillsStore.getState().setSkillScriptsEnabled(projectSkill.id, true);
    useSkillsStore.getState().setSkillScriptsEnabled(globalSkill.id, true);
    expect(useSkillsStore.getState().getRunnableSkillIds()).toEqual([projectSkill.id]);
    expect(useSkillsStore.getState().getRunnableSkillIds({ includeShadowed: true })).toEqual([
      projectSkill.id,
      globalSkill.id,
    ]);

    const preparation = await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: 'Use the selected docs skill.',
      contextRefs: [
        {
          id: globalSkill.id,
          kind: 'skill',
          title: globalSkill.name,
          skillFilePath: globalSkill.skillFilePath,
          source: globalSkill.source,
        },
      ],
      toolsAvailable: true,
    });

    expect(services.getSkill).toHaveBeenCalledWith({
      skillId: globalSkill.id,
      projectRoots: [PROJECT_ROOT],
    });
    expect(preparation.explicitSkillIds).toEqual([globalSkill.id]);
    expect(preparation.systemInstructionBlocks[0]).toContain(`Shadowed by: ${projectSkill.id}`);
  });

  it('resolves enabled skill mentions from dollar and bracket syntax without duplicates', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa111', { name: 'test-skill' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore } = await loadSkillsStore([skill]);

    await useSkillsStore.getState().loadSettings();

    expect(
      useSkillsStore
        .getState()
        .resolveEnabledSkillMentions('Use $test-skill then [skill: test-skill]')
    ).toEqual([skill]);
  });

  it('migrates legacy settings when a single new skill id matches', async () => {
    const skill = buildSkill('global:agents:formatter:aaa111', { name: 'formatter' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          'global:formatter': { enabled: true, scriptsEnabled: true },
        },
      }),
    );
    const { useSkillsStore } = await loadSkillsStore([skill]);

    await useSkillsStore.getState().loadSettings();

    expect(useSkillsStore.getState().getSkillSettings(skill.id)).toEqual({
      enabled: true,
      scriptsEnabled: true,
    });
    const stored = JSON.parse(localStorage.getItem('macro_skill_settings') ?? '{}');
    expect(stored.skills['global:formatter']).toBeUndefined();
    expect(stored.skills[skill.id]).toEqual({
      enabled: true,
      scriptsEnabled: true,
    });
  });

  it('preloads explicit structured skill refs by id and path', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa111', { name: 'test-skill' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    const preparation = await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: '[skill: test-skill] use it',
      contextRefs: [
        {
          id: skill.id,
          kind: 'skill',
          title: skill.name,
          skillFilePath: skill.skillFilePath,
          source: skill.source,
        },
      ],
      toolsAvailable: false,
    });

    expect(services.getSkill).toHaveBeenCalledWith({
      skillId: skill.id,
      projectRoots: [PROJECT_ROOT],
    });
    expect(preparation.explicitSkillIds).toEqual([skill.id]);
    expect(preparation.systemInstructionBlocks[0]).toContain('<skill_content');
    expect(preparation.systemInstructionBlocks[0]).toContain('# Instructions');
    expect(preparation.toolsAvailable).toBe(false);
  });

  it('preloads remote manifests without local paths using content hash and location', async () => {
    const skill = buildSkill('remote:registry:agents:remote-docs:abc123', {
      name: 'remote-docs',
      rootPath: null,
      skillFilePath: null,
      location: { kind: 'remote', uri: 'macro://registry/remote-docs' },
      contentHash: 'hash-remote-docs',
      source: {
        kind: 'global',
        namespace: 'agents',
        projectId: null,
        projectName: null,
        rootPath: 'macro://registry',
        skillRootPath: 'macro://registry/skills',
      },
    });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore, services } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    const preparation = await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: '[skill: remote-docs] use it',
      contextRefs: [
        {
          id: skill.id,
          kind: 'skill',
          title: skill.name,
          contentHash: skill.contentHash,
          location: skill.location,
          source: skill.source,
        },
      ],
      toolsAvailable: false,
    });

    expect(services.getSkill).toHaveBeenCalledWith({
      skillId: skill.id,
      projectRoots: [PROJECT_ROOT],
    });
    expect(preparation.explicitSkillIds).toEqual([skill.id]);
    expect(preparation.systemInstructionBlocks[0]).toContain('location_kind="remote"');
    expect(preparation.systemInstructionBlocks[0]).toContain('content_hash="hash-remote-docs"');

    await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: '[skill: remote-docs] use it again',
      contextRefs: [
        {
          id: skill.id,
          kind: 'skill',
          title: skill.name,
          contentHash: skill.contentHash,
          location: skill.location,
          source: skill.source,
        },
      ],
      toolsAvailable: false,
    });

    expect(services.getSkill).toHaveBeenCalledTimes(1);
  });

  it('loads a non-ambiguous bracket mention even when native tools are unavailable', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa111', { name: 'test-skill' });
    localStorage.setItem(
      'macro_skill_settings',
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      }),
    );
    const { useSkillsStore } = await loadSkillsStore([skill]);
    await useSkillsStore.getState().loadSettings();

    const preparation = await useSkillsStore.getState().prepareSkillsForTurn({
      conversationId: 'conversation-1',
      content: '[skill: test-skill] use it',
      toolsAvailable: false,
    });

    expect(preparation.explicitSkillIds).toEqual([skill.id]);
    expect(preparation.systemInstructionBlocks[0]).toContain('Skill: test-skill');
  });
});
