import type { ProjectGitFlowSettings } from '../types';
import type {
  GitBranchWorktreeEnsureDto,
  gitBranchWorktreeCreate,
} from './tauriIpc';

export interface PlanIntegrationWorktreeProjectRef {
  gitFlowSettings?: ProjectGitFlowSettings | null;
}

export type PlanIntegrationWorktreeTauri = Pick<
  {
    gitBranchWorktreeCreate: typeof gitBranchWorktreeCreate;
  },
  'gitBranchWorktreeCreate'
>;

const normalizeBranchName = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || 'work';
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const normalizedProjectId = (projectId: string): string =>
  projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 16) || 'project';

export const toPlanIntegrationWorktreeKey = (
  projectId: string,
  branchName: string,
): string => {
  const normalized = normalizeBranchName(branchName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return `integration-${normalizedProjectId(projectId)}-${normalized || 'plan'}-${stableHash(`${projectId}:${branchName}`)}`;
};

export const resolveStableFallbackBranchesForProject = (params: {
  projectId: string;
  getProjectById: (
    projectId: string
  ) => PlanIntegrationWorktreeProjectRef | null | undefined;
  getGitFlowBaseBranch: () => string;
  extraBranches?: Array<string | null | undefined>;
}): string[] => {
  const settings = params.getProjectById(params.projectId)?.gitFlowSettings;
  return Array.from(
    new Set(
      [
        settings?.baseBranch,
        settings?.mainBranch,
        params.getGitFlowBaseBranch(),
        'main',
        ...(params.extraBranches || []),
      ]
        .map((branch) => branch?.trim() || '')
        .filter(Boolean),
    ),
  );
};

const joinRepoPath = (repoPath: string, ...segments: string[]): string =>
  [
    repoPath.replace(/[\\/]+$/, ''),
    ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, '')),
  ]
    .filter(Boolean)
    .join('/');

const sanitizeWorktreeKey = (value: string): string => {
  const sanitized = value
    .split('')
    .map((character) =>
      /[a-zA-Z0-9_-]/.test(character) ? character : '-',
    )
    .join('')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!sanitized) {
    return stableHash(value);
  }
  if (sanitized.length > 48) {
    return `${sanitized.slice(0, 40)}-${stableHash(value)}`;
  }
  return sanitized;
};

export const buildPlanIntegrationWorktreePath = (
  repositoryRootPath: string,
  worktreeKey: string,
): string =>
  joinRepoPath(
    repositoryRootPath,
    '.macro',
    'worktrees',
    `integration-${sanitizeWorktreeKey(worktreeKey)}`,
  );

export const ensurePlanIntegrationWorktree = async (params: {
  tauri: PlanIntegrationWorktreeTauri;
  repositoryRootPath: string;
  projectId: string;
  planBranchName: string;
  getProjectById: (
    projectId: string
  ) => PlanIntegrationWorktreeProjectRef | null | undefined;
  getGitFlowBaseBranch: () => string;
  fromRef?: string | null;
  extraFallbackBranches?: Array<string | null | undefined>;
}): Promise<GitBranchWorktreeEnsureDto> => {
  const fallbackBranches = resolveStableFallbackBranchesForProject({
    projectId: params.projectId,
    getProjectById: params.getProjectById,
    getGitFlowBaseBranch: params.getGitFlowBaseBranch,
    extraBranches: [
      params.fromRef,
      ...(params.extraFallbackBranches || []),
    ],
  });

  return params.tauri.gitBranchWorktreeCreate({
    repoPath: params.repositoryRootPath,
    worktreeKey: toPlanIntegrationWorktreeKey(
      params.projectId,
      params.planBranchName,
    ),
    branchName: params.planBranchName,
    fromRef: params.fromRef || fallbackBranches[0] || null,
    fallbackBranches,
  });
};
