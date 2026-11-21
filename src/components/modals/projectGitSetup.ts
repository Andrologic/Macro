import type {
  ProjectGitFlowDetection,
  ProjectGitSetupAction,
  ProjectGitSetupRiskFlag,
} from '../../types';

export type ProjectSetupPromptKind = 'init_git' | 'initial_commit';

export interface ProjectSetupPromptDetails {
  kind: ProjectSetupPromptKind;
  projectPath: string;
  resolvedRepoRootPath?: string | null;
  repoResolution: ProjectGitFlowDetection['repoResolution'];
  initialCommitPreviewPaths: string[];
  initialCommitPreviewCount: number;
  initialCommitRiskFlags: ProjectGitSetupRiskFlag[];
}

type ProjectSetupTranslate = (
  key: string,
  fallback: string,
) => string;

const buildProjectSetupPromptDetails = (
  kind: ProjectSetupPromptKind,
  projectPath: string,
  detection: ProjectGitFlowDetection
): ProjectSetupPromptDetails => ({
  kind,
  projectPath,
  resolvedRepoRootPath: detection.resolvedRepoRootPath ?? null,
  repoResolution: detection.repoResolution,
  initialCommitPreviewPaths: detection.initialCommitPreviewPaths,
  initialCommitPreviewCount: detection.initialCommitPreviewCount,
  initialCommitRiskFlags: detection.initialCommitRiskFlags,
});

export const getProjectSetupAction = (kind: ProjectSetupPromptKind): ProjectGitSetupAction =>
  kind === 'init_git' ? 'initialize_repo' : 'create_initial_commit';

export const buildProjectSetupPrompts = (
  projectPath: string,
  detection: ProjectGitFlowDetection
): ProjectSetupPromptDetails[] =>
  detection.recommendedActionSequence
    .filter((action) => action === 'initialize_repo' || action === 'create_initial_commit')
    .map((action) => buildProjectSetupPromptDetails(
      action === 'initialize_repo' ? 'init_git' : 'initial_commit',
      projectPath,
      detection,
    ));

export const hasProjectSetupRisks = (riskFlags: ProjectGitSetupRiskFlag[]): boolean =>
  riskFlags.length > 0;

export const getProjectSetupPromptTitle = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind'>
): string => {
  if (prompt.kind === 'init_git') {
    return t('project.initGitTitle', 'Initialize Git?');
  }
  return t('project.initialCommitTitle', 'Create the initial commit?');
};

export const getProjectSetupPromptDescription = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind'>,
): string => {
  if (prompt.kind === 'init_git') {
    return t(
      'project.initGitDescription',
      'This folder is not a Git repository yet. Initialize Git to prepare Git-backed Macro storage.'
    );
  }
  return t(
    'project.initialCommitDescription',
    'Create the initial commit to enable Git-backed Macro storage. Without it, the project stays read-only.'
  );
};

export const getProjectSetupPromptConfirmLabel = (
  t: ProjectSetupTranslate,
  prompt: Pick<ProjectSetupPromptDetails, 'kind'>
): string => {
  if (prompt.kind === 'initial_commit') {
    return t('project.createInitialCommitConfirm', 'Create initial commit');
  }
  return t('project.initGitConfirm', 'Initialize Git');
};
