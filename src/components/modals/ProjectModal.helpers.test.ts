import { describe, expect, it } from 'bun:test';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGroup,
} from '../../types';
import {
  advanceProjectSetupPrompt,
  buildPendingProjectCreation,
  buildPendingProjectSetupPrompt,
  buildProjectWithGitSetupPayload,
  findProjectByPath,
  getProjectCreationErrorMessage,
  getAcceptedActionsAfterConfirmingPrompt,
  getDetectedProjectBranchSettings,
  hasDuplicateSubProjectName,
  inferProjectNameFromPath,
  isValidProjectFolderName,
  joinProjectPath,
  normalizeProjectPath,
  slugifyProjectFolderName,
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

const buildProjectGroup = (overrides: Partial<ProjectGroup>): ProjectGroup => ({
  id: 'group-id',
  name: 'Group',
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
  it('translates only the exact typed canonical project duplicate refusal', () => {
    const message = 'A project with this folder already exists in the workspace.';
    const translate = (_key: string, fallback: string) => fallback;
    const duplicate = Object.freeze({ code: 'Validation', message });
    expect(getProjectCreationErrorMessage(duplicate, translate))
      .toBe('This folder is already attached to a project in this workspace.');
    expect(getProjectCreationErrorMessage({ code: 'Validation', 0: message }, translate))
      .toBe('This folder is already attached to a project in this workspace.');
    for (const failure of [
      { code: 'Validation', message: 'Unknown project group id: group-123' },
      { code: 'Git', message },
      { code: 'FilesystemPermissionDenied', message },
      { code: 'Validation', message: `${message} Retry later.` },
      { code: 'Validation', message: message.toLowerCase() },
    ]) {
      expect(getProjectCreationErrorMessage(failure, translate)).toBe(failure.message);
    }
    expect(getProjectCreationErrorMessage(message, translate)).toBe(message);
    expect(getProjectCreationErrorMessage(new Error(message), translate)).toBe(message);
  });

  it('preserves Unix and WSL Linux path case while matching Windows path case', () => {
    expect(normalizeProjectPath('/synthetic/App')).not.toBe(normalizeProjectPath('/synthetic/app'));
    expect(normalizeProjectPath('//wsl$/Ubuntu/home/App')).not.toBe(normalizeProjectPath('//wsl$/Ubuntu/home/app'));
    expect(normalizeProjectPath('//wsl$/Ubuntu/home/App')).toBe(normalizeProjectPath('//WSL.LOCALHOST/ubuntu/home/App'));
    expect(normalizeProjectPath('C:/App')).toBe(normalizeProjectPath('c:/app'));
  });

  it('normalizes paths and infers names from Windows or POSIX paths', () => {
    expect(normalizeProjectPath(' C:\\Work\\App\\\\ ')).toBe('c:/work/app');
    expect(inferProjectNameFromPath('C:\\Work\\App\\')).toBe('App');
    expect(inferProjectNameFromPath('/repos/macro/api')).toBe('api');
    expect(slugifyProjectFolderName('Backend API')).toBe('backend-api');
    expect(joinProjectPath('C:\\Work\\Suite\\', 'backend-api')).toBe('C:/Work/Suite/backend-api');
    expect(isValidProjectFolderName('backend-api')).toBe(true);
    expect(isValidProjectFolderName('../backend')).toBe(false);
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
        subProjectPath: ' C:/work/app ',
        derivedSubProjectName: 'app',
      })
    ).toEqual({
      name: 'app',
      description: '',
      groupId: null,
      groupName: null,
      path: 'C:/work/app',
    });

    expect(
      buildPendingProjectCreation({
        isAttachingToExistingGroup: true,
        targetGroupId: 'group-id',
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

  it('uses detected branch roles for an unconventional repository', () => {
    const detection = buildDetection({
      repoDetected: true,
      branches: ['release/v1'],
      currentBranch: 'integration',
      suggestedMainBranch: 'production',
      suggestedBaseBranch: 'integration',
      requiresConfirmation: true,
      setupState: 'needs_branch_confirmation',
    });

    expect(getDetectedProjectBranchSettings(detection)).toMatchObject({
      mainBranch: 'production',
      baseBranch: 'integration',
    });
  });

  it('leaves ambiguous detached branches unmapped and excludes the metadata branch', () => {
    const detection = buildDetection({
      repoDetected: true,
      requiresConfirmation: true,
      setupState: 'needs_branch_confirmation',
      branches: ['@macro', 'integration', 'production'],
      suggestedMainBranch: null,
      suggestedBaseBranch: null,
      currentBranch: null,
    });
    expect(getDetectedProjectBranchSettings(detection)).toBeUndefined();
    expect(getDetectedProjectBranchSettings({ ...detection, currentBranch: '@macro' })).toBeUndefined();
    expect(getDetectedProjectBranchSettings({ ...detection, suggestedBaseBranch: '@macro', currentBranch: 'integration' }))
      .toMatchObject({ mainBranch: 'integration', baseBranch: 'integration' });
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

  it('skips a development-branch recommendation for an existing repository', () => {
    const detection = buildDetection({
      repoDetected: true,
      setupState: 'single_main_only',
      recommendedActionSequence: ['create_develop'],
      currentBranch: 'main',
    });

    expect(buildPendingProjectSetupPrompt(createPayload, 'C:/work/app', detection)).toBeNull();
  });
});
