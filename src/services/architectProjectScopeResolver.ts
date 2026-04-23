import type { PlanNode, Project, ProjectGroup } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import { getProjectGroupByProjectId } from './globalProjects';
import { normalizeNodeProjectIds } from './implementTaskDerivation';
import * as tauriIpc from './tauriIpc';

type ProjectInspection = {
  profileTags: string[];
  discoveredTokens: string[];
};

type ScopeResolverTauriDeps = Pick<
  typeof tauriIpc,
  'isTauriAvailable' | 'fsListDir' | 'fsReadFileWithOptions'
>;

export interface ArchitectResolvedProjectScope {
  actionableProjectIds: string[];
  contextProjectIds: string[];
  expectedProjectIds: string[];
  reasonsByProjectId: Record<string, string>;
}

const DEFAULT_ACTIONABLE_REASON = 'Selected for implementation in this plan.';
const DEFAULT_CONTEXT_REASON = 'Available for code reading in this plan scope.';

const inspectionCache = new Map<string, Promise<ProjectInspection>>();

const unique = (items: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const slugify = (value: string): string =>
  value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const tokenize = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );

const normalizeKeywordPattern = (value: string): string =>
  value.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

const hasKeyword = (text: string, keyword: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${normalizeKeywordPattern(keyword)}([^a-z0-9]|$)`, 'i').test(text);

const hasNegativeCue = (text: string, keyword: string): boolean =>
  new RegExp(
    `(?:pas|sans|not|without|exclude|excluding|skip|avoid)\\s+(?:the\\s+)?${normalizeKeywordPattern(keyword)}`,
    'i'
  ).test(text);

const getCandidateProjects = (
  projectGroups: ProjectGroup[],
  selectedGroupId?: string | null,
  selectedProjectId?: string | null
): Project[] => {
  if (selectedGroupId) {
    const selectedGroup = projectGroups.find((group) => group.id === selectedGroupId);
    if (selectedGroup?.projects.length) {
      return selectedGroup.projects;
    }
  }

  if (selectedProjectId) {
    const selectedGroup = getProjectGroupByProjectId(projectGroups, selectedProjectId);
    if (selectedGroup?.projects.length) {
      return selectedGroup.projects;
    }
  }

  return projectGroups.flatMap((group) => group.projects);
};

const inferProfileTagsFromEntries = (paths: string[]): string[] => {
  const normalizedPaths = paths.map((path) => path.toLowerCase());
  const hasPath = (fragment: string): boolean => normalizedPaths.some((path) => path.includes(fragment));
  const tags = new Set<string>();

  if (
    hasPath('/android') ||
    hasPath('/ios') ||
    hasPath('/app.json') ||
    hasPath('/pubspec.yaml') ||
    hasPath('/react-native.config') ||
    hasPath('/capacitor.config')
  ) {
    tags.add('mobile');
  }

  if (
    hasPath('/next.config.') ||
    hasPath('/vite.config.') ||
    hasPath('/index.html') ||
    hasPath('/public') ||
    hasPath('/src/app') ||
    hasPath('/src/pages')
  ) {
    tags.add('web');
  }

  if (
    hasPath('/prisma') ||
    hasPath('/migrations') ||
    hasPath('/schema.prisma') ||
    hasPath('/openapi') ||
    hasPath('/src/server') ||
    hasPath('/src/api') ||
    hasPath('/src/routes') ||
    hasPath('/dockerfile')
  ) {
    tags.add('backend');
  }

  if (hasPath('/docs') || hasPath('/mkdocs') || hasPath('/docusaurus')) {
    tags.add('docs');
  }

  if (hasPath('/.storybook') || hasPath('/storybook')) {
    tags.add('storybook');
  }

  return Array.from(tags);
};

const inferTagsFromPackageJson = (content: string): string[] => {
  try {
    const parsed = JSON.parse(content) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys({
      ...(parsed.dependencies || {}),
      ...(parsed.devDependencies || {}),
    }).map((dependency) => dependency.toLowerCase());
    const tags = new Set<string>();

    if (dependencyNames.some((dependency) => dependency.includes('react-native') || dependency.includes('expo'))) {
      tags.add('mobile');
    }
    if (dependencyNames.some((dependency) => dependency === 'next' || dependency.includes('vite') || dependency === 'react')) {
      tags.add('web');
    }
    if (
      dependencyNames.some((dependency) =>
        ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'prisma'].includes(dependency)
      )
    ) {
      tags.add('backend');
    }
    if (dependencyNames.some((dependency) => dependency.includes('storybook'))) {
      tags.add('storybook');
    }

    return Array.from(tags);
  } catch {
    return [];
  }
};

const inspectProjectRepository = async (
  project: Pick<Project, 'id' | 'path'>,
  tauri: ScopeResolverTauriDeps
): Promise<ProjectInspection> => {
  const cacheKey = `${project.id}:${project.path}`;
  const cached = inspectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pendingInspection = (async (): Promise<ProjectInspection> => {
    if (!tauri.isTauriAvailable() || !project.path?.trim()) {
      return {
        profileTags: [],
        discoveredTokens: [],
      };
    }

    try {
      const entries = await tauri.fsListDir({
        path: project.path,
        recursive: true,
        includeHidden: false,
        maxDepth: 2,
        allowOutsideWorkspace: true,
        workspacePath: project.path,
      });
      const relativePaths = entries.map((entry) => `/${entry.relative_path || entry.name}`.replace(/\\/g, '/'));
      const discoveredTokens = unique(relativePaths.flatMap((entry) => tokenize(entry)));
      const packageJsonEntry = entries.find(
        (entry) =>
          entry.kind === 'file' &&
          entry.relative_path.replace(/\\/g, '/').toLowerCase() === 'package.json'
      );
      const packageJsonTags = packageJsonEntry
        ? inferTagsFromPackageJson(
            (
              await tauri.fsReadFileWithOptions({
                path: `${project.path.replace(/[\\/]+$/, '')}/package.json`,
                allowOutsideWorkspace: true,
                workspacePath: project.path,
              })
            ).content
          )
        : [];

      return {
        profileTags: unique([...inferProfileTagsFromEntries(relativePaths), ...packageJsonTags]),
        discoveredTokens,
      };
    } catch {
      return {
        profileTags: [],
        discoveredTokens: [],
      };
    }
  })();

  inspectionCache.set(cacheKey, pendingInspection);
  return pendingInspection;
};

const PROFILE_KEYWORDS: Record<string, string[]> = {
  mobile: ['mobile', 'ios', 'android', 'react native', 'react-native', 'expo'],
  web: ['web', 'website', 'site', 'frontend', 'front-end', 'browser'],
  backend: ['backend', 'back-end', 'api', 'server', 'service', 'database', 'db', 'endpoint'],
  docs: ['docs', 'documentation'],
  storybook: ['storybook', 'design system', 'ui kit'],
};

const buildProjectAliases = (project: Pick<Project, 'id' | 'name' | 'mountName' | 'path' | 'metadata'>): string[] => {
  const basename = project.path.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  return unique([
    project.id,
    project.name,
    project.mountName,
    slugify(project.name),
    basename,
    slugify(basename),
    ...(project.metadata.tags || []),
  ]);
};

const shouldPreserveScopeAdditively = (status: ArchitectPlanRecord['status']): boolean =>
  status === 'validated' || status === 'in_progress' || status === 'completed';

export const inferArchitectPlanProjectScope = async (params: {
  activePlan: Pick<ArchitectPlanRecord, 'status' | 'projectIds' | 'contextProjectIds' | 'title' | 'label' | 'description'>;
  nodes: Array<Pick<PlanNode, 'title' | 'description' | 'projectId' | 'projectIds'>>;
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  tauri?: ScopeResolverTauriDeps;
}): Promise<ArchitectResolvedProjectScope> => {
  const tauri = params.tauri || tauriIpc;
  const candidates = getCandidateProjects(
    params.projectGroups,
    params.selectedGroupId,
    params.selectedProjectId
  );
  const candidateIds = candidates.map((project) => project.id);
  const explicitNodeProjectIds = unique(
    params.nodes.flatMap((node) => normalizeNodeProjectIds(node)).filter((projectId) => candidateIds.includes(projectId))
  );
  const combinedText = [
    params.activePlan.label,
    params.activePlan.title,
    params.activePlan.description,
    ...params.nodes.flatMap((node) => [node.title, node.description]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const scoredProjects = await Promise.all(
    candidates.map(async (project) => {
      const inspection = await inspectProjectRepository(project, tauri);
      const aliases = buildProjectAliases(project);
      let score = 0;
      let reason = '';

      if (explicitNodeProjectIds.includes(project.id)) {
        return {
          project,
          score: 100,
          reason: 'Explicitly targeted by the generated strategy.',
        };
      }

      for (const alias of aliases) {
        if (hasNegativeCue(combinedText, alias)) {
          score -= 8;
          if (!reason) {
            reason = `De-emphasized because the brief excludes ${alias}.`;
          }
        } else if (hasKeyword(combinedText, alias)) {
          score += 8;
          if (!reason) {
            reason = `Matched project alias "${alias}" in the plan brief.`;
          }
        }
      }

      for (const tag of inspection.profileTags) {
        const keywords = PROFILE_KEYWORDS[tag] || [];
        if (
          keywords.some((keyword) => hasKeyword(combinedText, keyword)) &&
          !keywords.every((keyword) => hasNegativeCue(combinedText, keyword))
        ) {
          score += 5;
          if (!reason) {
            reason = `Repository structure suggests ${tag} work and matches the plan brief.`;
          }
        }
      }

      const metadataText = `${project.metadata.description || ''} ${(project.metadata.tags || []).join(' ')}`.toLowerCase();
      if (!reason && tokenize(metadataText).some((token) => hasKeyword(combinedText, token))) {
        score += 1;
        reason = 'Matched secondary project metadata while resolving scope.';
      }

      if (!reason && inspection.discoveredTokens.some((token) => token.length > 3 && hasKeyword(combinedText, token))) {
        score += 2;
        reason = 'Matched repository file structure while resolving scope.';
      }

      return {
        project,
        score,
        reason,
      };
    })
  );

  const inferredActionableProjectIds = unique(
    scoredProjects
      .filter((entry) => !entry.project.isReadOnly && entry.score >= 4)
      .map((entry) => entry.project.id)
  );

  let actionableProjectIds = inferredActionableProjectIds;
  if (explicitNodeProjectIds.length > 0) {
    actionableProjectIds = unique([...explicitNodeProjectIds, ...inferredActionableProjectIds]);
  }

  if (actionableProjectIds.length === 0) {
    actionableProjectIds = unique([
      ...(params.activePlan.projectIds || []),
      ...(params.selectedProjectId ? [params.selectedProjectId] : []),
      candidates.find((project) => !project.isReadOnly)?.id,
    ]);
  }

  if (shouldPreserveScopeAdditively(params.activePlan.status)) {
    actionableProjectIds = unique([...(params.activePlan.projectIds || []), ...actionableProjectIds]);
  }

  actionableProjectIds = actionableProjectIds.filter((projectId) => {
    const project = candidates.find((candidate) => candidate.id === projectId);
    return Boolean(project && !project.isReadOnly);
  });

  const inferredContextProjectIds = unique(
    candidates
      .map((project) => project.id)
      .filter((projectId) => !actionableProjectIds.includes(projectId))
  );

  const contextProjectIds = shouldPreserveScopeAdditively(params.activePlan.status)
    ? unique([
        ...(params.activePlan.contextProjectIds || []),
        ...inferredContextProjectIds,
      ]).filter((projectId) => !actionableProjectIds.includes(projectId))
    : inferredContextProjectIds;
  const expectedProjectIds = unique([...actionableProjectIds, ...contextProjectIds]);

  const reasonsByProjectId = Object.fromEntries(
    expectedProjectIds.map((projectId) => {
      const explicitReason = scoredProjects.find((entry) => entry.project.id === projectId)?.reason;
      if (actionableProjectIds.includes(projectId)) {
        return [
          projectId,
          explicitReason ||
            ((params.activePlan.projectIds || []).includes(projectId) && shouldPreserveScopeAdditively(params.activePlan.status)
              ? 'Preserved as an already-actionable repository for this plan.'
              : DEFAULT_ACTIONABLE_REASON),
        ] as const;
      }

      return [
        projectId,
        ((params.activePlan.contextProjectIds || []).includes(projectId) && shouldPreserveScopeAdditively(params.activePlan.status))
          ? 'Preserved as existing context for this plan.'
          : DEFAULT_CONTEXT_REASON,
      ] as const;
    })
  );

  return {
    actionableProjectIds,
    contextProjectIds,
    expectedProjectIds,
    reasonsByProjectId,
  };
};
