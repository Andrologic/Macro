import type { GitFlowBranchType } from '../types';
import { sanitizeBranchSlugInput } from './architectGitNaming';

export type WorkBranchType = Exclude<GitFlowBranchType, 'plan'>;

const WORK_BRANCH_TYPES: WorkBranchType[] = ['feature', 'release', 'hotfix', 'bugfix'];

const normalizeBranchName = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
};

export const isWorkBranchType = (value: unknown): value is WorkBranchType =>
  typeof value === 'string' && WORK_BRANCH_TYPES.includes(value as WorkBranchType);

export const inferWorkBranchTypeFromName = (value?: string | null): WorkBranchType => {
  const normalized = normalizeBranchName(value).toLowerCase();
  const prefix = normalized.split('/').filter(Boolean)[0];
  return isWorkBranchType(prefix) ? prefix : 'feature';
};

const inferBranchSlugFromName = (value?: string | null, branchType: WorkBranchType = 'feature'): string => {
  const normalized = normalizeBranchName(value);
  const parts = normalized.split('/').filter(Boolean);
  const leaf = parts[parts.length - 1] || normalized || '';
  return sanitizeBranchSlugInput(leaf, branchType);
};

export interface WorkBranchIntent {
  branchType: WorkBranchType;
  branchSlug: string;
  label: string;
  key: string;
  legacyAssignedBranch: string;
}

export const buildWorkBranchLabel = (branchType: WorkBranchType, branchSlug: string): string =>
  `${branchType}/${branchSlug}`;

export const resolveWorkBranchIntent = (params: {
  branchType?: string | null;
  branchSlug?: string | null;
  assignedBranch?: string | null;
  fallbackSlug?: string | null;
}): WorkBranchIntent => {
  const branchType = isWorkBranchType(params.branchType)
    ? params.branchType
    : inferWorkBranchTypeFromName(params.assignedBranch);
  const normalizedAssignedBranch = normalizeBranchName(params.assignedBranch);
  const rawSlug =
    (typeof params.branchSlug === 'string' && params.branchSlug.trim().length > 0
      ? params.branchSlug
      : null) ||
    normalizedAssignedBranch ||
    params.fallbackSlug ||
    'work';
  const branchSlug = sanitizeBranchSlugInput(rawSlug, branchType);

  return {
    branchType,
    branchSlug,
    label: buildWorkBranchLabel(branchType, branchSlug),
    key: `${branchType}:${branchSlug}`,
    legacyAssignedBranch:
      normalizedAssignedBranch || inferBranchSlugFromName(rawSlug, branchType),
  };
};

export const getPlanNodeBranchIntent = (node: {
  branchType?: string | null;
  branchSlug?: string | null;
  assignedBranch?: string | null;
  title?: string | null;
}): WorkBranchIntent =>
  resolveWorkBranchIntent({
    branchType: node.branchType,
    branchSlug: node.branchSlug,
    assignedBranch: node.assignedBranch,
    fallbackSlug: node.title,
  });

export const getPredictedBranchIntent = (
  branch: {
    branchType?: string | null;
    branchSlug?: string | null;
    name?: string | null;
  }
): WorkBranchIntent =>
  resolveWorkBranchIntent({
    branchType: branch.branchType,
    branchSlug: branch.branchSlug,
    assignedBranch: branch.name,
  });

export const getPredictedBranchIntentKey = (
  branch: {
    branchType?: string | null;
    branchSlug?: string | null;
    name?: string | null;
  }
): string => getPredictedBranchIntent(branch).key;

export const getPlanNodeBranchIntentKey = (
  node: {
    branchType?: string | null;
    branchSlug?: string | null;
    assignedBranch?: string | null;
    title?: string | null;
  }
): string => getPlanNodeBranchIntent(node).key;
