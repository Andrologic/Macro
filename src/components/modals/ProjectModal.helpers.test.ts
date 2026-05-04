import { describe, expect, it } from 'bun:test';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGroup,
} from '../../types';
import {
  getProjectSetupDevelopExplanation,
  getProjectSetupMainlineExplanation,
  getProjectSetupPromptDescription,
  getProjectSetupPromptTitle,
  type ProjectSetupPromptDetails,
} from './projectGitSetup';
import {
  advanceProjectSetupPrompt,
  buildDeclinedProjectSetupPayload,
  buildPendingGitFlowConfirmation,
  buildPendingProjectCreation,
  buildPendingProjectSetupPrompt,
  buildProjectWithGitSetupPayload,
  findProjectByPath,
  getAcceptedActionsAfterConfirmingPrompt,
  getAcceptedActionsAfterDecliningPrompt,
  hasDuplicateSubProjectName,
  inferProjectNameFromPath,
  normalizeProjectPath,
  shouldConfirmDetectedGitFlow,
  type PendingProjectCreation,
} from './ProjectModal.helpers';

const buildProject = (overrides: Partial<Project>): Project => ({
  id: 'project-id',
  name: 'Existing Project',
  mountName: 'existing-project',
  path: 'C:/work/existing',
  created_at: '2026-04-13T12:00:00.000Z',
  status: 'active',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
  ...overrides,
});

const testTranslate = (
  _key: string,
  fallback: string,
  options?: Record<string, string>
): string =>
  Object.entries(options ?? {}).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    fallback
  );

const buildProjectGroup = (overrides: Partial<ProjectGroup>): ProjectGroup => ({
  id: 'group-id',
  name: 'Global Project',
  isOpen: true,
  projects: [],
  ...overrides,
});

const buildDetection = (
  overrides: Partial<ProjectGitFlowDetection> = {}
): ProjectGitFlowDetection => ({
  repoDetected: false,
  branches: [],
  currentBranch: null,
  suggestedMainBranch: null,
  suggestedBaseBranch: null,
  suggestedCommitBranch: null,
  requiresConfirmation: false,
  setupState: 'not_git',
  hasInitialCommit: false,
  resolvedRepoRootPath: null,
  repoResolution: 'none',
  initialCommitPreviewPaths: [],
  initialCommitPreviewCount: 0,
  initialCommitRiskFlags: [],
  recommendedActionSequence: [],
  ...overrides,
});

const createPayload: PendingProjectCreation = {
  name: 'app',
  description: '',
  groupId: null,
  groupName: 'Suite',
  path: 'C:/work/app',
};

describe('ProjectModal helpers', () => {
  it('normalizes paths and infers names from Windows or POSIX paths', () => {
    expect(normalizeProjectPath(' C:\\Work\\App\\\\ ')).toBe('c:/work/app');
    expect(inferProjectNameFromPath('C:\\Work\\App\\')).toBe('App');
    expect(inferProjectNameFromPath('/repos/macro/api')).toBe('api');
  });

  it('finds duplicate paths and names case-insensitively', () => {
    const group = buildProjectGroup({
      projects: [
        buildProject({
          id: 'api',
          name: 'API',
          path: 'C:/Work/Suite/API',
        }),
      ],
    });

    expect(findProjectByPath([group], 'c:/work/suite/api/')).toEqual(group.projects[0]);
    expect(hasDuplicateSubProjectName(group, ' api ')).toBe(true);
    expect(hasDuplicateSubProjectName(group, 'web')).toBe(false);
  });

  it('builds project creation payloads for new and existing groups', () => {
    expect(
      buildPendingProjectCreation({
        isAttachingToExistingGroup: false,
        targetGroupId: null,
        globalProjectName: ' Suite ',
        subProjectPath: ' C:/work/app ',
        derivedSubProjectName: 'app',
      })
    ).toEqual({
      name: 'app',
      description: '',
      groupId: null,
      groupName: 'Suite',
      path: 'C:/work/app',
    });

    expect(
      buildPendingProjectCreation({
        isAttachingToExistingGroup: true,
        targetGroupId: 'group-id',
        globalProjectName: 'Ignored',
        subProjectPath: '',
        derivedSubProjectName: 'api',
      })
    ).toEqual({
      name: 'api',
      description: '',
      groupId: 'group-id',
      groupName: null,
      path: undefined,
    });
  });

  it('prepares branch confirmation state from detected Git workflow metadata', () => {
    const detection = buildDetection({
      repoDetected: true,
      branches: ['release/v1'],
      currentBranch: 'integration',
      suggestedMainBranch: 'production',
      suggestedBaseBranch: 'integration',
      requiresConfirmation: true,
      setupState: 'needs_branch_confirmation',
    });

    expect(shouldConfirmDetectedGitFlow(detection)).toBe(true);
    expect(buildPendingGitFlowConfirmation(createPayload, detection)).toEqual({
      createPayload,
      branches: ['release/v1', 'integration', 'production'],
      currentBranch: 'integration',
      mainBranch: 'production',
      baseBranch: 'integration',
    });
  });

  it('advances setup prompts and builds final git setup payloads', () => {
    const detection = buildDetection({
      repoDetected: false,
      setupState: 'not_git',
      repoResolution: 'new_local_repo',
      resolvedRepoRootPath: 'C:/work/app',
      recommendedActionSequence: ['initialize_repo', 'create_initial_commit'],
      initialCommitPreviewPaths: ['package.json'],
      initialCommitPreviewCount: 1,
      initialCommitRiskFlags: ['env_file'],
    });
    const promptState = buildPendingProjectSetupPrompt(createPayload, 'C:/work/app', detection);
    expect(promptState).not.toBeNull();

    const firstPrompt = promptState!.prompts[0];
    const secondState = advanceProjectSetupPrompt(promptState!, firstPrompt);
    expect(secondState?.promptIndex).toBe(1);
    expect(secondState?.acceptedActions).toEqual(['initialize_repo']);

    const secondPrompt = secondState!.prompts[1];
    expect(getAcceptedActionsAfterConfirmingPrompt(secondState!, secondPrompt)).toEqual([
      'initialize_repo',
      'create_initial_commit',
    ]);
    expect(
      buildProjectWithGitSetupPayload(createPayload, 'C:/work/app', detection, [
        'initialize_repo',
        'create_initial_commit',
      ])
    ).toMatchObject({
      path: 'C:/work/app',
      gitSetupActions: ['initialize_repo', 'create_initial_commit'],
      expectedRepoRootPath: 'C:/work/app',
      expectedSetupState: 'not_git',
      expectedRecommendedActionSequence: ['initialize_repo', 'create_initial_commit'],
    });
  });

  it('keeps mainline settings and accepted actions when declining develop creation', () => {
    const detection = buildDetection({
      repoDetected: true,
      setupState: 'single_main_only',
      recommendedActionSequence: ['create_develop'],
      currentBranch: 'main',
    });
    const promptState = buildPendingProjectSetupPrompt(createPayload, 'C:/work/app', detection)!;
    const prompt = promptState.prompts[0];

    expect(buildDeclinedProjectSetupPayload(createPayload, prompt).gitFlowSettings).toMatchObject({
      mainBranch: 'main',
      baseBranch: 'main',
    });
    expect(getAcceptedActionsAfterDecliningPrompt(promptState, prompt)).toEqual([]);
  });

  it('centralizes Git setup prompt wording around generic Git workflows', () => {
    const prompt: ProjectSetupPromptDetails = {
      kind: 'create_develop',
      projectPath: 'C:/work/app',
      mainBranch: 'trunk',
      resolvedRepoRootPath: 'C:/work/app',
      repoResolution: 'selected_folder',
      initialCommitPreviewPaths: [],
      initialCommitPreviewCount: 0,
      initialCommitRiskFlags: [],
    };

    expect(getProjectSetupPromptTitle(testTranslate, prompt)).toBe('Create develop?');
    expect(getProjectSetupPromptDescription(testTranslate, prompt, 'project_creation')).toContain(
      'separate integration branch'
    );
    expect(getProjectSetupMainlineExplanation(testTranslate, prompt)).toContain('trunk');
    expect(getProjectSetupDevelopExplanation(testTranslate, prompt)).not.toMatch(/Git[- ]Flow/i);
  });
});
