import type { Project, ProjectGroup } from '../../types';
import {
  getArchitectPlanVisibleProjectIds,
  type ArchitectPlanSummary,
} from '../../services/architectPlanService';
import type { ArchitectPlanCatalogBranch } from '../../services/macroProjectMetadataLoader';

export type ArchitectNavigatorScopeKind = 'group' | 'project';

export interface ArchitectNavigatorScope {
  id: string;
  kind: ArchitectNavigatorScopeKind;
  label: string;
  groupId: string | null;
  projectId: string | null;
  projectIds: string[];
  projects: Project[];
}

export interface ArchitectNavigatorPlanEntry {
  plan: ArchitectPlanSummary;
  branchName: string;
  scopeId: string;
  scopeLabel: string;
  projectCount: number;
}

const compareUpdatedAtDesc = (
  left: Pick<ArchitectPlanSummary, 'id' | 'updatedAt'>,
  right: Pick<ArchitectPlanSummary, 'id' | 'updatedAt'>,
): number => {
  const leftUpdatedAt = new Date(left.updatedAt).getTime();
  const rightUpdatedAt = new Date(right.updatedAt).getTime();
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return left.id.localeCompare(right.id);
};

export const buildArchitectNavigatorScopes = (params: {
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
}): ArchitectNavigatorScope[] => [
  ...params.projectGroups.map<ArchitectNavigatorScope>((group) => ({
    id: `group:${group.id}`,
    kind: 'group',
    label: group.name,
    groupId: group.id,
    projectId: null,
    projectIds: group.projects.map((project) => project.id),
    projects: group.projects,
  })),
  ...params.standaloneProjects.map<ArchitectNavigatorScope>((project) => ({
    id: `project:${project.id}`,
    kind: 'project',
    label: project.name,
    groupId: null,
    projectId: project.id,
    projectIds: [project.id],
    projects: [project],
  })),
];

const chooseCanonicalScope = (
  plan: ArchitectPlanSummary,
  scopes: ArchitectNavigatorScope[],
): ArchitectNavigatorScope | null => {
  const planProjectIds = new Set(getArchitectPlanVisibleProjectIds(plan));
  if (planProjectIds.size === 0) {
    return null;
  }

  return scopes
    .map((scope) => ({
      scope,
      overlap: scope.projectIds.filter((projectId) => planProjectIds.has(projectId)).length,
    }))
    .filter((candidate) => candidate.overlap > 0)
    .sort((left, right) => {
      if (left.overlap !== right.overlap) {
        return right.overlap - left.overlap;
      }
      if (left.scope.kind !== right.scope.kind) {
        return left.scope.kind === 'group' ? -1 : 1;
      }
      return left.scope.label.localeCompare(right.scope.label);
    })[0]?.scope ?? null;
};

export const buildArchitectNavigatorPlanEntries = (params: {
  branches: ArchitectPlanCatalogBranch[];
  scopes: ArchitectNavigatorScope[];
}): ArchitectNavigatorPlanEntry[] => {
  const plansById = new Map<
    string,
    { plan: ArchitectPlanSummary; branchName: string }
  >();

  for (const branch of params.branches) {
    for (const plan of branch.plans) {
      if (plan.status === 'deleted') {
        continue;
      }
      const current = plansById.get(plan.id);
      if (!current || compareUpdatedAtDesc(plan, current.plan) < 0) {
        plansById.set(plan.id, { plan, branchName: branch.branchName });
      }
    }
  }

  return Array.from(plansById.values())
    .map<ArchitectNavigatorPlanEntry | null>(({ plan, branchName }) => {
      const scope = chooseCanonicalScope(plan, params.scopes);
      if (!scope) {
        return null;
      }
      return {
        plan,
        branchName,
        scopeId: scope.id,
        scopeLabel: scope.label,
        projectCount: getArchitectPlanVisibleProjectIds(plan).length,
      };
    })
    .filter((entry): entry is ArchitectNavigatorPlanEntry => Boolean(entry))
    .sort((left, right) => compareUpdatedAtDesc(left.plan, right.plan));
};

export const sanitizeArchitectNavigatorIds = (
  value: unknown,
  validIds?: ReadonlySet<string>,
): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !validIds || validIds.has(entry));
  return Array.from(new Set(normalized));
};

