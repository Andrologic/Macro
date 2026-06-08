import type { Project, ProjectGroup, ProjectRegistry } from '../types';
import i18n from '../i18n';
import { DEFAULT_LANGUAGE, resolveSupportedLanguage } from '../i18n/languages';
import { getProjectGroupByProjectId, resolveExplicitProjectIdForGroup } from './globalProjects';
import { assignMountNamesToProjectGroups } from './projectMounts';

export interface RememberedProjectRecord {
  projectId: string;
  groupId: string | null;
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface ProjectRegistryRepairReport {
  repaired: boolean;
  duplicatePathsRemoved: number;
  emptyGroupsRemoved: number;
  removedSyntheticGroups: number;
  removedSyntheticProjects: number;
  removedGroupIds: string[];
  removedProjectIds: string[];
  deadSelectedGroupId: string | null;
  deadSelectedProjectId: string | null;
}

export interface NormalizeProjectRegistryResult {
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  report: ProjectRegistryRepairReport;
}

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const isSyntheticGroupId = (value: string | null | undefined): boolean =>
  Boolean(value && value.startsWith('session-group-'));

const isSyntheticProjectId = (value: string | null | undefined): boolean =>
  Boolean(value && value.startsWith('session-project-'));

export const countProjectsInRegistry = (groups: ProjectGroup[]): number =>
  groups.reduce((total, group) => total + group.projects.length, 0);

export const countProjectsInProjectRegistry = (registry: ProjectRegistry): number =>
  registry.standaloneProjects.length + countProjectsInRegistry(registry.projectGroups);

export const getAllProjectsInRegistry = (registry: ProjectRegistry): Project[] => [
  ...registry.standaloneProjects,
  ...registry.projectGroups.flatMap((group) => group.projects),
];

const toRegistry = (input: ProjectRegistry | ProjectGroup[]): ProjectRegistry =>
  Array.isArray(input)
    ? { standaloneProjects: [], projectGroups: input }
    : {
        standaloneProjects: input.standaloneProjects ?? [],
        projectGroups: input.projectGroups ?? [],
      };

const resolveRegistrySummaryLanguage = () => {
  if (typeof document !== 'undefined') {
    const documentLanguage =
      document.documentElement.lang ||
      document.documentElement.getAttribute('lang') ||
      i18n.resolvedLanguage ||
      i18n.language;
    return resolveSupportedLanguage(documentLanguage, DEFAULT_LANGUAGE);
  }

  return resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language, DEFAULT_LANGUAGE);
};

const getRegistryTranslation = (key: string): string | null => {
  const language = resolveRegistrySummaryLanguage();
  if (!i18n.hasResourceBundle(language, 'translation')) {
    return null;
  }

  const value = i18n.getResource(language, 'translation', `projects.${key}`);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const getRegistryFallbackCopy = (key: string): string => {
  const language = resolveRegistrySummaryLanguage();
  const isFrench = language === 'fr';

  switch (key) {
    case 'registryRepairDuplicates_one':
      return isFrench ? '{{count}} doublon supprimé' : '{{count}} duplicate removed';
    case 'registryRepairDuplicates_other':
      return isFrench ? '{{count}} doublons supprimés' : '{{count}} duplicates removed';
    case 'registryRepairEmptyGroups_one':
      return isFrench ? '{{count}} groupe vide supprimé' : '{{count}} empty group removed';
    case 'registryRepairEmptyGroups_other':
      return isFrench ? '{{count}} groupes vides supprimés' : '{{count}} empty groups removed';
    case 'registryRepairSynthetic':
      return isFrench
        ? 'Références de session héritées nettoyées'
        : 'Legacy session references cleaned up';
    case 'registryRepairSelection':
      return isFrench ? 'Sélection invalide réparée' : 'Invalid selection repaired';
    case 'registryRepairSummary':
      return isFrench
        ? 'Macro a réparé le registre des projets : {{details}}.'
        : 'Macro repaired the project registry: {{details}}.';
    default:
      return '';
  }
};

const interpolate = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(values[key] ?? ''));

export const normalizeProjectRegistry = (params: {
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): NormalizeProjectRegistryResult => {
  const seenPaths = new Set<string>();
  const removedGroupIds: string[] = [];
  const removedProjectIds: string[] = [];
  let duplicatePathsRemoved = 0;
  let emptyGroupsRemoved = 0;
  let removedSyntheticGroups = 0;
  let removedSyntheticProjects = 0;

  const nextStandaloneProjects: Project[] = [];
  for (const project of params.standaloneProjects ?? []) {
    if (isSyntheticProjectId(project.id)) {
      removedSyntheticProjects += 1;
      removedProjectIds.push(project.id);
      continue;
    }

    const normalizedPath = normalizePath(project.path);
    if (!normalizedPath) {
      removedProjectIds.push(project.id);
      continue;
    }

    if (seenPaths.has(normalizedPath)) {
      duplicatePathsRemoved += 1;
      removedProjectIds.push(project.id);
      continue;
    }

    seenPaths.add(normalizedPath);
    nextStandaloneProjects.push(project);
  }

  const nextProjectGroups = params.projectGroups
    .map((group) => {
      if (isSyntheticGroupId(group.id)) {
        removedSyntheticGroups += 1;
        removedGroupIds.push(group.id);
        return null;
      }

      const nextProjects = group.projects.filter((project) => {
        if (isSyntheticProjectId(project.id)) {
          removedSyntheticProjects += 1;
          removedProjectIds.push(project.id);
          return false;
        }

        const normalizedPath = normalizePath(project.path);
        if (!normalizedPath) {
          removedProjectIds.push(project.id);
          return false;
        }

        if (seenPaths.has(normalizedPath)) {
          duplicatePathsRemoved += 1;
          removedProjectIds.push(project.id);
          return false;
        }

        seenPaths.add(normalizedPath);
        return true;
      });

      if (nextProjects.length === 0) {
        emptyGroupsRemoved += 1;
        removedGroupIds.push(group.id);
        return null;
      }

      if (nextProjects.length === 1) {
        nextStandaloneProjects.push(nextProjects[0]);
        return null;
      }

      return {
        ...group,
        projects: nextProjects,
      };
    })
    .filter((group): group is ProjectGroup => Boolean(group));

  const normalizedStandaloneProjects = assignMountNamesToProjectGroups([
    {
      id: '__standalone__',
      name: '__standalone__',
      isOpen: true,
      projects: nextStandaloneProjects,
    },
  ])[0]?.projects ?? [];
  const normalizedProjectGroups = assignMountNamesToProjectGroups(nextProjectGroups);

  const requestedSelectedProjectId =
    params.selectedProjectId && !isSyntheticProjectId(params.selectedProjectId)
      ? params.selectedProjectId
      : null;
  const requestedSelectedGroupId =
    params.selectedGroupId && !isSyntheticGroupId(params.selectedGroupId)
      ? params.selectedGroupId
      : null;

  let selectedGroupId: string | null = null;
  let selectedProjectId: string | null = null;

  if (requestedSelectedProjectId) {
    const standaloneProject = normalizedStandaloneProjects.find(
      (project) => project.id === requestedSelectedProjectId
    );
    if (standaloneProject) {
      selectedGroupId = null;
      selectedProjectId = standaloneProject.id;
    }

    const groupForProject = !standaloneProject ? getProjectGroupByProjectId(
      normalizedProjectGroups,
      requestedSelectedProjectId
    ) : null;
    if (groupForProject) {
      selectedGroupId = groupForProject.id;
      selectedProjectId = requestedSelectedProjectId;
    }
  }

  if (!selectedGroupId && requestedSelectedGroupId) {
    const existingGroup = normalizedProjectGroups.find((group) => group.id === requestedSelectedGroupId);
    if (existingGroup) {
      selectedGroupId = existingGroup.id;
    }
  }

  if (!selectedGroupId) {
    if (!selectedProjectId) {
      const firstStandaloneProject = normalizedStandaloneProjects[0] ?? null;
      if (firstStandaloneProject) {
        selectedProjectId = firstStandaloneProject.id;
      } else if (normalizedProjectGroups[0]) {
        selectedGroupId = normalizedProjectGroups[0].id;
      }
    }
  }

  if (selectedGroupId) {
    selectedProjectId = resolveExplicitProjectIdForGroup(
      normalizedProjectGroups,
      selectedGroupId,
      selectedProjectId ?? requestedSelectedProjectId ?? null
    );
  }

  const report: ProjectRegistryRepairReport = {
    repaired:
      duplicatePathsRemoved > 0 ||
      emptyGroupsRemoved > 0 ||
      removedSyntheticGroups > 0 ||
      removedSyntheticProjects > 0 ||
      (requestedSelectedGroupId ?? null) !== selectedGroupId ||
      (requestedSelectedProjectId ?? null) !== selectedProjectId,
    duplicatePathsRemoved,
    emptyGroupsRemoved,
    removedSyntheticGroups,
    removedSyntheticProjects,
    removedGroupIds,
    removedProjectIds,
    deadSelectedGroupId:
      requestedSelectedGroupId && requestedSelectedGroupId !== selectedGroupId
        ? requestedSelectedGroupId
        : null,
    deadSelectedProjectId:
      requestedSelectedProjectId && requestedSelectedProjectId !== selectedProjectId
        ? requestedSelectedProjectId
        : null,
  };

  return {
    standaloneProjects: normalizedStandaloneProjects,
    projectGroups: normalizedProjectGroups,
    selectedGroupId,
    selectedProjectId,
    report,
  };
};

export const reconcileRememberedProjects = (
  projectRegistry: ProjectRegistry | ProjectGroup[],
  rememberedProjects: RememberedProjectRecord[],
  options: { preserveUnmatched?: boolean } = {}
): RememberedProjectRecord[] => {
  const registry = toRegistry(projectRegistry);
  const projectById = new Map<
    string,
    { groupId: string | null; name: string; path: string }
  >([
    ...registry.standaloneProjects.map(
      (project) =>
        [
          project.id,
          {
            groupId: null,
            name: project.name,
            path: project.path,
          },
        ] as const
    ),
    ...registry.projectGroups.flatMap((group) =>
      group.projects.map(
        (project) =>
          [
            project.id,
            {
              groupId: group.id,
              name: project.name,
              path: project.path,
            },
          ] as const
      )
    ),
  ]);
  const groupByPath = new Map<
    string,
    { projectId: string; groupId: string | null; name: string; path: string }
  >([
    ...registry.standaloneProjects.map(
      (project) =>
        [
          normalizePath(project.path),
          {
            projectId: project.id,
            groupId: null,
            name: project.name,
            path: project.path,
          },
        ] as const
    ),
    ...registry.projectGroups.flatMap((group) =>
      group.projects.map(
        (project) =>
          [
            normalizePath(project.path),
            {
              projectId: project.id,
              groupId: group.id,
              name: project.name,
              path: project.path,
            },
          ] as const
      )
    ),
  ]);
  const seenKeys = new Set<string>();

  return rememberedProjects.flatMap((remembered) => {
    if (isSyntheticProjectId(remembered.projectId) || isSyntheticGroupId(remembered.groupId)) {
      return [];
    }

    const byId = projectById.get(remembered.projectId);
    const byPath = groupByPath.get(normalizePath(remembered.path));
    const resolved = byId
      ? {
          projectId: remembered.projectId,
          groupId: byId.groupId,
          name: byId.name,
          path: byId.path,
        }
      : byPath;

    if (!resolved) {
      if (!options.preserveUnmatched) {
        return [];
      }

      const normalizedRememberedPath = normalizePath(remembered.path);
      if (!remembered.projectId.trim() || !normalizedRememberedPath) {
        return [];
      }

      const key = `${remembered.projectId}:${normalizedRememberedPath}`;
      if (seenKeys.has(key)) {
        return [];
      }
      seenKeys.add(key);

      return [remembered];
    }

    const key = `${resolved.projectId}:${normalizePath(resolved.path)}`;
    if (seenKeys.has(key)) {
      return [];
    }
    seenKeys.add(key);

    return [
      {
        ...remembered,
        projectId: resolved.projectId,
        groupId: resolved.groupId,
        name: resolved.name,
        path: resolved.path,
      },
    ];
  });
};

export const resolveCanonicalProjectGroup = (
  projectGroups: ProjectGroup[],
  targetGroup: Pick<ProjectGroup, 'id' | 'name' | 'projects'> | null | undefined
): ProjectGroup | null => {
  if (!targetGroup) {
    return null;
  }

  const directMatch = projectGroups.find((group) => group.id === targetGroup.id) ?? null;
  if (directMatch) {
    return directMatch;
  }

  const targetPaths = new Set(
    targetGroup.projects
      .map((project) => normalizePath(project.path))
      .filter((path) => path.length > 0)
  );
  if (targetPaths.size > 0) {
    const pathMatch = projectGroups.find((group) =>
      group.projects.some((project) => targetPaths.has(normalizePath(project.path)))
    );
    if (pathMatch) {
      return pathMatch;
    }
  }

  const normalizedName = targetGroup.name.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const nameMatches = projectGroups.filter(
    (group) => group.name.trim().toLowerCase() === normalizedName
  );
  return nameMatches.length === 1 ? nameMatches[0] : null;
};

export const resolveCanonicalProject = (
  projectRegistry: ProjectRegistry | ProjectGroup[],
  targetProject: Pick<Project, 'id' | 'name' | 'path'> | null | undefined
): Project | null => {
  if (!targetProject) {
    return null;
  }

  const allProjects = getAllProjectsInRegistry(toRegistry(projectRegistry));
  const directMatch = allProjects.find((project) => project.id === targetProject.id) ?? null;
  if (directMatch) {
    return directMatch;
  }

  const normalizedTargetPath = normalizePath(targetProject.path);
  if (normalizedTargetPath) {
    const pathMatch =
      allProjects.find((project) => normalizePath(project.path) === normalizedTargetPath) ?? null;
    if (pathMatch) {
      return pathMatch;
    }
  }

  const normalizedName = targetProject.name.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const nameMatches = allProjects.filter(
    (project) => project.name.trim().toLowerCase() === normalizedName
  );
  return nameMatches.length === 1 ? nameMatches[0] : null;
};

export const formatProjectRegistryRepairSummary = (
  report: ProjectRegistryRepairReport
): string | null => {
  if (!report.repaired) {
    return null;
  }

  const parts: string[] = [];
  if (report.duplicatePathsRemoved > 0) {
    const key =
      report.duplicatePathsRemoved === 1
        ? 'registryRepairDuplicates_one'
        : 'registryRepairDuplicates_other';
    parts.push(
      interpolate(
        getRegistryTranslation(key) || getRegistryFallbackCopy(key),
        { count: report.duplicatePathsRemoved }
      )
    );
  }
  if (report.emptyGroupsRemoved > 0) {
    const key =
      report.emptyGroupsRemoved === 1
        ? 'registryRepairEmptyGroups_one'
        : 'registryRepairEmptyGroups_other';
    parts.push(
      interpolate(
        getRegistryTranslation(key) || getRegistryFallbackCopy(key),
        { count: report.emptyGroupsRemoved }
      )
    );
  }
  if (report.removedSyntheticGroups > 0 || report.removedSyntheticProjects > 0) {
    parts.push(
      getRegistryTranslation('registryRepairSynthetic') ||
        getRegistryFallbackCopy('registryRepairSynthetic')
    );
  }
  if (report.deadSelectedGroupId || report.deadSelectedProjectId) {
    parts.push(
      getRegistryTranslation('registryRepairSelection') ||
        getRegistryFallbackCopy('registryRepairSelection')
    );
  }

  return parts.length > 0
    ? interpolate(
        getRegistryTranslation('registryRepairSummary') ||
          getRegistryFallbackCopy('registryRepairSummary'),
        { details: parts.join(', ') }
      )
    : null;
};
