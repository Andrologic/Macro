import { resolveProjectGitFlowSettings } from '../../services/architectGitNaming';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupAction,
  ProjectGitSetupState,
  ProjectGroup,
} from '../../types';
import {
  buildProjectSetupPrompts,
  getProjectSetupAction,
  type ProjectSetupPromptDetails,
} from './projectGitSetup';

export type ProjectModalSourceMode = 'new_repo' | 'existing_repo';
export type ProjectDestinationMode = 'standalone' | 'existing_group' | 'new_group';

export interface PendingProjectCreation {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ReturnType<typeof resolveProjectGitFlowSettings>;
}

export interface PendingGitFlowConfirmation {
  createPayload: PendingProjectCreation;
  branches: string[];
  currentBranch: string | null;
  mainBranch: string;
  baseBranch: string;
}

export interface PendingProjectSetupPrompt {
  createPayload: PendingProjectCreation;
  detection: ProjectGitFlowDetection;
  prompts: ProjectSetupPromptDetails[];
  promptIndex: number;
  acceptedActions: ProjectGitSetupAction[];
}

export interface ProjectWithGitSetupPayload extends PendingProjectCreation {
  path: string;
  gitSetupActions: ProjectGitSetupAction[];
  expectedRepoRootPath: string | null;
  expectedSetupState: ProjectGitSetupState;
  expectedRecommendedActionSequence: ProjectGitSetupAction[];
}

interface BuildPendingProjectCreationOptions {
  isAttachingToExistingGroup: boolean;
  targetGroupId: string | null;
  subProjectPath: string;
  derivedSubProjectName: string;
}

export const normalizeProjectPath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export const inferProjectNameFromPath = (value: string): string => {
  const parts = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
};

export const slugifyProjectFolderName = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'repo';
};

export const isValidProjectFolderName = (value: string): boolean => {
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== '.' && trimmed !== '..';
};

export const joinProjectPath = (parentPath: string, folderName: string): string => {
  const trimmedParentPath = parentPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const trimmedFolderName = folderName.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmedParentPath || !trimmedFolderName) {
    return '';
  }
  return `${trimmedParentPath}/${trimmedFolderName}`;
};

export const findProjectByPath = (
  projectGroups: ProjectGroup[],
  requestedPath: string,
  standaloneProjects: Project[] = []
): Project | null => {
  const normalizedRequestedPath = normalizeProjectPath(requestedPath);
  if (!normalizedRequestedPath) {
    return null;
  }

  for (const project of standaloneProjects) {
    if (normalizeProjectPath(project.path) === normalizedRequestedPath) {
      return project;
    }
  }

  for (const group of projectGroups) {
    const project = group.projects.find(
      (candidate) => normalizeProjectPath(candidate.path) === normalizedRequestedPath
    );
    if (project) {
      return project;
    }
  }

  return null;
};

export const hasDuplicateSubProjectName = (
  group: ProjectGroup | null,
  subProjectName: string
): boolean => {
  const normalizedName = subProjectName.trim().toLowerCase();
  if (!group || !normalizedName) {
    return false;
  }

  return group.projects.some(
    (project) => project.name.trim().toLowerCase() === normalizedName
  );
};

export const buildPendingProjectCreation = ({
  isAttachingToExistingGroup,
  targetGroupId,
  subProjectPath,
  derivedSubProjectName,
}: BuildPendingProjectCreationOptions): PendingProjectCreation => {
  const trimmedSubProjectPath = subProjectPath.trim();

  return {
    name: derivedSubProjectName,
    description: '',
    groupId: isAttachingToExistingGroup ? targetGroupId : null,
    groupName: null,
    path: trimmedSubProjectPath || undefined,
  };
};

export const getEffectiveProjectGitSetupState = (
  detection: ProjectGitFlowDetection
): ProjectGitSetupState =>
  detection.setupState || (detection.repoDetected ? 'ready' : 'not_git');

export const shouldConfirmDetectedGitFlow = (
  detection: ProjectGitFlowDetection
): boolean =>
  detection.repoDetected &&
  (
    detection.requiresConfirmation ||
    getEffectiveProjectGitSetupState(detection) === 'needs_branch_confirmation'
  );

export const buildPendingGitFlowConfirmation = (
  createPayload: PendingProjectCreation,
  detection: ProjectGitFlowDetection
): PendingGitFlowConfirmation => {
  const branches = Array.from(
    new Set(
      [
        ...detection.branches,
        detection.currentBranch ?? null,
        detection.suggestedMainBranch ?? null,
        detection.suggestedBaseBranch ?? null,
      ].filter((branch): branch is string => Boolean(branch?.trim()))
    )
  );
  const defaultBranch = branches[0] || '';

  return {
    createPayload,
    branches,
    currentBranch: detection.currentBranch ?? null,
    mainBranch: detection.suggestedMainBranch ?? detection.currentBranch ?? defaultBranch,
    baseBranch:
      detection.suggestedBaseBranch ??
      detection.currentBranch ??
      detection.suggestedMainBranch ??
      defaultBranch,
  };
};

export const buildPendingProjectSetupPrompt = (
  createPayload: PendingProjectCreation,
  projectPath: string,
  detection: ProjectGitFlowDetection
): PendingProjectSetupPrompt | null => {
  const prompts = buildProjectSetupPrompts(projectPath, detection);
  if (prompts.length === 0) {
    return null;
  }

  return {
    createPayload,
    detection,
    prompts,
    promptIndex: 0,
    acceptedActions: [],
  };
};

export const getActiveProjectSetupPrompt = (
  pendingProjectSetupPrompt: PendingProjectSetupPrompt | null
): ProjectSetupPromptDetails | null =>
  pendingProjectSetupPrompt?.prompts[pendingProjectSetupPrompt.promptIndex] ?? null;

export const advanceProjectSetupPrompt = (
  pendingProjectSetupPrompt: PendingProjectSetupPrompt,
  activeProjectSetupPrompt: ProjectSetupPromptDetails
): PendingProjectSetupPrompt | null => {
  const nextAcceptedActions = [
    ...pendingProjectSetupPrompt.acceptedActions,
    getProjectSetupAction(activeProjectSetupPrompt.kind),
  ];

  if (pendingProjectSetupPrompt.promptIndex >= pendingProjectSetupPrompt.prompts.length - 1) {
    return null;
  }

  return {
    ...pendingProjectSetupPrompt,
    acceptedActions: nextAcceptedActions,
    promptIndex: pendingProjectSetupPrompt.promptIndex + 1,
  };
};

export const getAcceptedActionsAfterConfirmingPrompt = (
  pendingProjectSetupPrompt: PendingProjectSetupPrompt,
  activeProjectSetupPrompt: ProjectSetupPromptDetails
): ProjectGitSetupAction[] => [
  ...pendingProjectSetupPrompt.acceptedActions,
  getProjectSetupAction(activeProjectSetupPrompt.kind),
];

export const buildProjectWithGitSetupPayload = (
  createPayload: PendingProjectCreation,
  projectPath: string,
  detection: ProjectGitFlowDetection,
  gitSetupActions: ProjectGitSetupAction[]
): ProjectWithGitSetupPayload => ({
  ...createPayload,
  path: projectPath,
  gitSetupActions,
  expectedRepoRootPath: detection.resolvedRepoRootPath ?? null,
  expectedSetupState: detection.setupState,
  expectedRecommendedActionSequence: detection.recommendedActionSequence,
});

export const buildDeclinedProjectSetupPayload = (
  createPayload: PendingProjectCreation,
  activeProjectSetupPrompt: ProjectSetupPromptDetails
): PendingProjectCreation => {
  if (activeProjectSetupPrompt.kind !== 'create_develop') {
    return createPayload;
  }

  const mainBranch = activeProjectSetupPrompt.mainBranch || 'main';
  return {
    ...createPayload,
    gitFlowSettings: resolveProjectGitFlowSettings({
      mainBranch,
      baseBranch: mainBranch,
    }),
  };
};

export const getAcceptedActionsAfterDecliningPrompt = (
  pendingProjectSetupPrompt: PendingProjectSetupPrompt,
  activeProjectSetupPrompt: ProjectSetupPromptDetails
): ProjectGitSetupAction[] =>
  activeProjectSetupPrompt.kind === 'create_develop'
    ? pendingProjectSetupPrompt.acceptedActions
    : [];
