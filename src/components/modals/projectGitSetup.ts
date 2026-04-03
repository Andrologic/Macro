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
