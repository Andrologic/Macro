import type {
  ProjectGitFlowDetection,
  ProjectGitSetupAction,
  ProjectGitSetupRiskFlag,
} from '../../types';

export type ProjectSetupPromptKind = 'init_git' | 'initial_commit' | 'create_develop';

export interface ProjectSetupPromptDetails {
  kind: ProjectSetupPromptKind;
  projectPath: string;
  mainBranch?: string | null;
  resolvedRepoRootPath?: string | null;
  repoResolution: ProjectGitFlowDetection['repoResolution'];
  initialCommitPreviewPaths: string[];
  initialCommitPreviewCount: number;
  initialCommitRiskFlags: ProjectGitSetupRiskFlag[];
}

type ProjectSetupTranslate = (
  key: string,
  fallback: string,
  options?: Record<string, string>
) => string;

type ProjectSetupPromptContext = 'project_creation' | 'project_settings';

const getPromptMainBranch = (prompt: Pick<ProjectSetupPromptDetails, 'mainBranch'>): string =>
  prompt.mainBranch || 'main';

export const shouldPromptToCreateDevelop = (
  setupState?: string,
  mainBranch?: string | null
): boolean => {
  if (setupState !== 'single_main_only') {
    return false;
  }

  const normalizedMainBranch = (mainBranch || '').trim().toLowerCase();
  return normalizedMainBranch === 'main'
    || normalizedMainBranch === 'master'
    || normalizedMainBranch === 'trunk';
};

export const buildProjectSetupPromptDetails = (
  kind: ProjectSetupPromptKind,
  projectPath: string,
  detection: ProjectGitFlowDetection
): ProjectSetupPromptDetails => ({
  kind,
  projectPath,
  mainBranch:
    detection.suggestedMainBranch
    ?? detection.suggestedCommitBranch
    ?? detection.currentBranch
    ?? 'main',
  resolvedRepoRootPath: detection.resolvedRepoRootPath ?? null,
  repoResolution: detection.repoResolution,
  initialCommitPreviewPaths: detection.initialCommitPreviewPaths,
  initialCommitPreviewCount: detection.initialCommitPreviewCount,
  initialCommitRiskFlags: detection.initialCommitRiskFlags,
});

export const getProjectSetupPromptKind = (
  action: ProjectGitSetupAction
): ProjectSetupPromptKind => {
  if (action === 'initialize_repo') {
    return 'init_git';
  }
  if (action === 'create_initial_commit') {
    return 'initial_commit';
  }
  return 'create_develop';
};

export const getProjectSetupAction = (kind: ProjectSetupPromptKind): ProjectGitSetupAction => {
  if (kind === 'init_git') {
    return 'initialize_repo';
  }
  if (kind === 'initial_commit') {
    return 'create_initial_commit';
  }
  return 'create_develop';
};

export const buildProjectSetupPrompts = (
  projectPath: string,
  detection: ProjectGitFlowDetection
): ProjectSetupPromptDetails[] =>
  detection.recommendedActionSequence.map((action) =>
    buildProjectSetupPromptDetails(getProjectSetupPromptKind(action), projectPath, detection)
  );

export const hasProjectSetupRisks = (riskFlags: ProjectGitSetupRiskFlag[]): boolean =>
  riskFlags.length > 0;

export const getProjectSetupPromptTitle = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind'>
): string => {
  if (prompt.kind === 'init_git') {
    return t('project.initGitTitle', 'Initialize Git?');
  }
  if (prompt.kind === 'initial_commit') {
    return t('project.initialCommitTitle', 'Create the initial commit?');
  }
  return t('project.createDevelopTitle', 'Create develop?');
};

export const getProjectSetupPromptDescription = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind' | 'mainBranch'>,
  context: ProjectSetupPromptContext
): string => {
  const readOnlyFallback =
    context === 'project_creation'
      ? 'the project will be added as read-only.'
      : 'the project will stay read-only.';

  if (prompt.kind === 'init_git') {
    return t(
      'project.initGitDescription',
      `This folder is not a Git repository yet. Initialize Git now to enable worktrees and editable workflows. If you skip this step, ${readOnlyFallback}`
    );
  }
  if (prompt.kind === 'initial_commit') {
    return t(
      'project.initialCommitDescription',
      `This repository has no initial commit yet. Create it now to enable branches, worktrees, and editable workflows. If you skip this step, ${readOnlyFallback}`
    );
  }

  const branchName = getPromptMainBranch(prompt);
  return t(
    'project.createDevelopDescription',
    'This repository can work in mainline mode: Macro will use {{mainBranch}} as both the main branch and the development target. Create develop only if this project intentionally uses a separate integration branch.',
    { mainBranch: branchName, branchName }
  );
};

export const getProjectSetupPromptConfirmLabel = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind'>
): string => {
  if (prompt.kind === 'create_develop') {
    return t('project.createDevelopConfirm', 'Create develop');
  }
  if (prompt.kind === 'initial_commit') {
    return t('project.createInitialCommitConfirm', 'Create initial commit');
  }
  return t('project.initGitConfirm', 'Initialize Git');
};

export const getProjectSetupPromptCancelLabel = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind' | 'mainBranch'>
): string => {
  if (prompt.kind !== 'create_develop') {
    return t('project.keepReadOnly', 'Keep read-only');
  }
  return t('project.createDevelopDecline', 'Keep {{branchName}} only', {
    branchName: getPromptMainBranch(prompt),
  });
};

export const getProjectSetupMainlineExplanation = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'mainBranch'>
): string =>
  t(
    'project.mainlineModeExplanation',
    'Keep {{branchName}} as the development target. Feature work merges back into {{branchName}}, and urgent fixes can use hotfix plans.',
    { branchName: getPromptMainBranch(prompt) }
  );

export const getProjectSetupDevelopExplanation = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'mainBranch'>
): string =>
  t(
    'project.developModeExplanation',
    'Create develop from {{branchName}} for repositories that intentionally use a separate integration branch.',
    { branchName: getPromptMainBranch(prompt) }
  );
