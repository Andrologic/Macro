import type { ProjectGitFlowSettings } from '../types';
import { renderGitFlowBranchName } from './architectGitNaming';

export type ArchitectPlanKind = 'feature' | 'release' | 'hotfix' | 'bugfix';
export type TypedArchitectPlanKind = Exclude<ArchitectPlanKind, 'feature'>;

export interface ArchitectPlanGitFlowProjectMetadata {
  projectId: string;
  sourceBranch: string;
  integrationBranch: string;
  targetBranch: string;
  backmergeBranch?: string | null;
  proposedVersion?: string | null;
  confirmedVersion?: string | null;
  proposedSlug?: string | null;
  confirmedSlug?: string | null;
}

export interface ArchitectPlanGitFlowMetadata {
  version: 1;
  planKind: ArchitectPlanKind;
  slug?: string | null;
  projects: Record<string, ArchitectPlanGitFlowProjectMetadata>;
}

export interface ArchitectPlanKindRef {
  planKind?: string | null;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata> | null;
  slug?: string | null;
  title?: string | null;
}

export const ARCHITECT_PLAN_KINDS: ArchitectPlanKind[] = [
  'feature',
  'release',
  'hotfix',
  'bugfix',
];

export const normalizeArchitectPlanKind = (
  value?: string | null,
): ArchitectPlanKind =>
  ARCHITECT_PLAN_KINDS.includes(value as ArchitectPlanKind)
    ? (value as ArchitectPlanKind)
    : 'feature';

export const isTypedGitFlowPlanKind = (
  value?: string | null,
): value is TypedArchitectPlanKind => {
  const kind = normalizeArchitectPlanKind(value);
  return kind === 'release' || kind === 'hotfix' || kind === 'bugfix';
};

const normalizeBranchName = (value?: string | null, fallback = 'develop'): string => {
  const normalized = (typeof value === 'string' ? value : fallback)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || fallback;
};

export const normalizeVersionSlug = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  return trimmed.replace(/^v(?=\d)/i, '');
};

export const getPlanKindSourceBranch = (params: {
  planKind: ArchitectPlanKind;
  baseBranch: string;
  mainBranch: string;
}): string => {
  if (params.planKind === 'hotfix') {
    return normalizeBranchName(params.mainBranch, 'main');
  }
  return normalizeBranchName(params.baseBranch, 'develop');
};

export const getPlanKindTargetBranch = (params: {
  planKind: ArchitectPlanKind;
  baseBranch: string;
  mainBranch: string;
}): string => {
  if (params.planKind === 'release' || params.planKind === 'hotfix') {
    return normalizeBranchName(params.mainBranch, 'main');
  }
  return normalizeBranchName(params.baseBranch, 'develop');
};

export const getPlanKindBackmergeBranch = (params: {
  planKind: ArchitectPlanKind;
  baseBranch: string;
}): string | null => {
  if (params.planKind === 'release' || params.planKind === 'hotfix') {
    return normalizeBranchName(params.baseBranch, 'develop');
  }
  return null;
};

const pickProjectMetadata = (
  plan: ArchitectPlanKindRef,
  projectId: string,
): Partial<ArchitectPlanGitFlowProjectMetadata> | null =>
  plan.gitFlowPlan?.projects?.[projectId] ?? null;

export const getArchitectPlanKind = (
  plan: ArchitectPlanKindRef,
): ArchitectPlanKind =>
  normalizeArchitectPlanKind(plan.planKind || plan.gitFlowPlan?.planKind);

export const getArchitectPlanBranchSlugForProject = (params: {
  plan: ArchitectPlanKindRef;
  projectId: string;
  fallbackSlug?: string | null;
}): string => {
  const projectMetadata = pickProjectMetadata(params.plan, params.projectId);
  const explicitSlug =
    projectMetadata?.confirmedSlug ||
    projectMetadata?.proposedSlug ||
    projectMetadata?.confirmedVersion ||
    projectMetadata?.proposedVersion ||
    params.plan.gitFlowPlan?.slug ||
    params.fallbackSlug ||
    params.plan.slug ||
    params.plan.title ||
    'plan';
  return normalizeVersionSlug(explicitSlug) || 'plan';
};

export const renderArchitectPlanIntegrationBranchName = (params: {
  plan: ArchitectPlanKindRef;
  projectId: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string => {
  const planKind = getArchitectPlanKind(params.plan);
  const storedIntegrationBranch = normalizeBranchName(
    pickProjectMetadata(params.plan, params.projectId)?.integrationBranch,
    '',
  );
  if (storedIntegrationBranch) {
    return storedIntegrationBranch;
  }

  if (planKind === 'feature') {
    return renderGitFlowBranchName({
      branchType: 'plan',
      planSlug: params.plan.slug || params.plan.title || 'plan',
      settings: params.settings,
    });
  }

  return renderGitFlowBranchName({
    branchType: planKind,
    planSlug: params.plan.slug || params.plan.title || 'plan',
    branchSlug: getArchitectPlanBranchSlugForProject({
      plan: params.plan,
      projectId: params.projectId,
    }),
    settings: params.settings,
  });
};

export const normalizeArchitectPlanGitFlowMetadata = (params: {
  planKind?: string | null;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata> | null;
  projectIds: string[];
  getProjectSettings?: (projectId: string) => Partial<ProjectGitFlowSettings> | null | undefined;
  getDefaultBranches?: (projectId: string) => { baseBranch: string; mainBranch: string };
  fallbackSlug?: string | null;
}): ArchitectPlanGitFlowMetadata | undefined => {
  const planKind = normalizeArchitectPlanKind(params.planKind || params.gitFlowPlan?.planKind);
  if (planKind === 'feature' && !params.gitFlowPlan) {
    return undefined;
  }

  const projects: Record<string, ArchitectPlanGitFlowProjectMetadata> = {};
  for (const projectId of params.projectIds) {
    const existing = params.gitFlowPlan?.projects?.[projectId];
    const branches = params.getDefaultBranches?.(projectId) || {
      baseBranch: 'develop',
      mainBranch: 'main',
    };
    const sourceBranch = normalizeBranchName(
      existing?.sourceBranch,
      getPlanKindSourceBranch({ planKind, ...branches }),
    );
    const targetBranch = normalizeBranchName(
      existing?.targetBranch,
      getPlanKindTargetBranch({ planKind, ...branches }),
    );
    const backmergeBranch =
      existing?.backmergeBranch === null
        ? null
        : normalizeBranchName(
            existing?.backmergeBranch,
            getPlanKindBackmergeBranch({ planKind, baseBranch: branches.baseBranch }) || '',
          ) || null;
    const branchSlug =
      normalizeVersionSlug(existing?.confirmedSlug) ||
      normalizeVersionSlug(existing?.proposedSlug) ||
      normalizeVersionSlug(existing?.confirmedVersion) ||
      normalizeVersionSlug(existing?.proposedVersion) ||
      normalizeVersionSlug(params.gitFlowPlan?.slug) ||
      normalizeVersionSlug(params.fallbackSlug) ||
      'plan';
    const integrationBranch = normalizeBranchName(
      existing?.integrationBranch,
      planKind === 'feature'
        ? renderGitFlowBranchName({
            branchType: 'plan',
            planSlug: params.fallbackSlug || 'plan',
            settings: params.getProjectSettings?.(projectId),
          })
        : renderGitFlowBranchName({
            branchType: planKind,
            planSlug: params.fallbackSlug || 'plan',
            branchSlug,
            settings: params.getProjectSettings?.(projectId),
          }),
    );

    projects[projectId] = {
      projectId,
      sourceBranch,
      integrationBranch,
      targetBranch,
      backmergeBranch,
      proposedVersion: normalizeVersionSlug(existing?.proposedVersion),
      confirmedVersion: normalizeVersionSlug(existing?.confirmedVersion),
      proposedSlug: normalizeVersionSlug(existing?.proposedSlug),
      confirmedSlug: normalizeVersionSlug(existing?.confirmedSlug),
    };
  }

  return {
    version: 1,
    planKind,
    slug: normalizeVersionSlug(params.gitFlowPlan?.slug),
    projects,
  };
};
