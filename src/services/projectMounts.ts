import type { Project, ProjectGroup } from '../types';

export interface ProjectMount {
  projectId: string;
  groupId: string | null;
  mountName: string;
  displayName: string;
  workspacePath: string | null;
  isReadOnly: boolean;
}

const stripTrailingSeparators = (value: string): string =>
  value.replace(/[\\/]+$/, '');

const getPathBasename = (value: string): string => {
  const normalized = stripTrailingSeparators(value.trim().replace(/\\/g, '/'));
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
};

export const slugifyProjectMount = (value: string): string =>
  value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';

const getProjectMountBase = (project: Pick<Project, 'id' | 'name' | 'path'> & { mountName?: string | null }): string => {
  const explicitMount = slugifyProjectMount(project.mountName || '');
  if (explicitMount !== 'project' || (project.mountName || '').trim().length > 0) {
    return explicitMount;
  }

  const pathBasename = getPathBasename(project.path);
  if (pathBasename) {
    return slugifyProjectMount(pathBasename);
  }

  if (project.name.trim()) {
    return slugifyProjectMount(project.name);
  }

  return slugifyProjectMount(project.id);
};

export const assignMountNamesToProjects = <T extends Pick<Project, 'id' | 'name' | 'path'> & { mountName?: string | null }>(
  projects: T[]
): Array<T & { mountName: string }> => {
  const used = new Set<string>();

  return projects.map((project) => {
    const base = getProjectMountBase(project);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return {
      ...project,
      mountName: candidate,
    };
  });
};

export const assignMountNamesToProjectGroups = (groups: ProjectGroup[]): ProjectGroup[] =>
  groups.map((group) => ({
    ...group,
    projects: assignMountNamesToProjects(group.projects),
  }));

export const buildProjectMounts = (params: {
  projectGroups: ProjectGroup[];
  groupId?: string | null;
  projectIds?: string[] | null;
  workspacePathsByProjectId?: Record<string, string>;
}): ProjectMount[] => {
  const scopedProjectIds = new Set(params.projectIds || []);

  return params.projectGroups
    .filter((group) => !params.groupId || group.id === params.groupId)
    .flatMap((group) =>
      group.projects
        .filter((project) => scopedProjectIds.size === 0 || scopedProjectIds.has(project.id))
        .map((project) => ({
          projectId: project.id,
          groupId: group.id,
          mountName: project.mountName,
          displayName: project.name,
          workspacePath: params.workspacePathsByProjectId?.[project.id] || project.path || null,
          isReadOnly: Boolean(project.isReadOnly),
        }))
    );
};
