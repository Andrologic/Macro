import * as tauriIpc from './tauriIpc';
import type { AppMode } from '../types';
import type { ProjectMount } from '../types';
import { isMacroScopedPath, isMetadataRelativePath } from './toolModePolicy';
import {
  canUseRemoteKernel,
  executeRemoteWorkspaceTool,
  validateRemoteToolExecution,
} from './remoteKernelApi';
import { useAppStore } from '../stores/useAppStore';
import { getFocusedProjectForGroup, getSubProjectsForGroup } from './globalProjects';

type ToolArgs = Record<string, unknown>;
const isGitTool = (toolName: string): boolean => toolName.startsWith('git_');
const gitBackendToolIds = new Set([
  'git_status',
  'git_log',
  'git_branch_list',
  'git_diff',
  'git_get_tree',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_merge',
  'git_reset',
  'git_stash',
]);

export interface ExecuteWorkspaceToolOptions {
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  workspacePathsByProjectId?: Record<string, string>;
  projectId?: string | null;
  focusedProjectId?: string | null;
  groupId?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
}

export const isWriteTool = (toolName: string): boolean => toolName === 'write' || toolName === 'edit';

const isUnknownCommandError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  const message = typeof maybe.message === 'string' ? maybe.message.toLowerCase() : '';
  return (
    message.includes('unknown command') ||
    message.includes('tool_validate_execution') ||
    message.includes('tool_execute_workspace')
  );
};

const extractCandidatePath = (toolName: string, args: ToolArgs): string | undefined => {
  if (
    toolName === 'write' ||
    toolName === 'edit' ||
    toolName === 'read' ||
    toolName === 'list'
  ) {
    const rawPath = sanitizePathInput(toString(args.path) || '.');
    return rawPath || undefined;
  }

  return undefined;
};

export const assertPathAllowed = (mode: AppMode, path: string): void => {
  if (mode !== 'Architect') return;
  if (!isMetadataRelativePath(path)) {
    throw new Error('Architect mode can only edit metadata files in the @macro root.');
  }
};

const toString = (value: unknown): string => (typeof value === 'string' ? value : '');

const formatToolError = (error: unknown): string => {
  if (error instanceof Error) return error.message;

  if (error && typeof error === 'object') {
    const maybe = error as Record<string, unknown>;
    const code = typeof maybe.code === 'string' ? maybe.code : undefined;
    const message = typeof maybe.message === 'string' ? maybe.message : undefined;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
};

const sanitizePathInput = (value: string): string =>
  value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`]+$/, '')
    .replace(/^\.\//, '');

const formatWithLineNumbers = (lines: string[], startLine: number): string => {
  return lines
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
};

const getSelectedProjectRoot = (): string => {
  const appState = useAppStore.getState();
  const normalize = (value?: string): string => (value || '').replace(/\\/g, '/').replace(/\/$/, '');

  const focusedProject = getFocusedProjectForGroup(
    appState.projectGroups,
    appState.selectedGroupId,
    appState.selectedProjectId
  );
  if (focusedProject?.path) {
    return normalize(focusedProject.path) || '.';
  }

  for (const group of appState.projectGroups) {
    const firstProject = group.projects[0];
    if (firstProject?.path) {
      return normalize(firstProject.path) || '.';
    }
  }

  return '.';
};

const normalizeWorkspacePath = (value?: string | null): string | null => {
  const trimmed = (value || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!trimmed || trimmed === '.' || trimmed === './') {
    return null;
  }
  return trimmed;
};

interface ProjectWorkspaceCandidate {
  id: string;
  name: string;
  mountName: string;
  workspacePath: string | null;
}

const slugifyProjectAlias = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const getProjectWorkspaceCandidates = (
  options: ExecuteWorkspaceToolOptions
): ProjectWorkspaceCandidate[] => {
  if (options.projectMounts?.length) {
    return options.projectMounts.map((mount) => ({
      id: mount.projectId,
      name: mount.displayName,
      mountName: mount.mountName,
      workspacePath: normalizeWorkspacePath(
        options.workspacePathsByProjectId?.[mount.projectId] || mount.workspacePath
      ),
    }));
  }

  const appState = useAppStore.getState();
  const projects =
    options.groupId
      ? getSubProjectsForGroup(appState.projectGroups, options.groupId)
      : appState.projectGroups.flatMap((group) => group.projects);

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    mountName: project.mountName,
    workspacePath:
      normalizeWorkspacePath(options.workspacePathsByProjectId?.[project.id]) ||
      normalizeWorkspacePath(project.path),
  }));
};

const getProjectAliases = (candidate: ProjectWorkspaceCandidate): string[] => {
  const workspaceTail =
    candidate.workspacePath?.split('/').filter(Boolean).pop() ||
    '';
  return Array.from(
    new Set(
      [
        candidate.mountName,
        candidate.id,
        candidate.name,
        slugifyProjectAlias(candidate.name),
        workspaceTail,
        slugifyProjectAlias(workspaceTail),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
};

const stripProjectAliasPrefix = (
  inputPath: string,
  candidates: ProjectWorkspaceCandidate[]
): { projectId: string; path: string } | null => {
  const normalizedInput = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedInput || normalizedInput === '.') {
    return null;
  }

  for (const candidate of candidates) {
    for (const alias of getProjectAliases(candidate)) {
      if (normalizedInput === alias) {
        return { projectId: candidate.id, path: '.' };
      }
      if (normalizedInput.startsWith(`${alias}/`)) {
        return {
          projectId: candidate.id,
          path: normalizedInput.slice(alias.length + 1) || '.',
        };
      }
    }
  }

  return null;
};

const findProjectByAbsolutePath = (
  inputPath: string,
  candidates: ProjectWorkspaceCandidate[]
): ProjectWorkspaceCandidate | null => {
  const normalizedInput = normalizeWorkspacePath(inputPath);
  if (!normalizedInput) return null;

  const matchingCandidates = candidates
    .filter((candidate) => candidate.workspacePath && normalizedInput.startsWith(candidate.workspacePath))
    .sort((left, right) => (right.workspacePath?.length || 0) - (left.workspacePath?.length || 0));

  return matchingCandidates[0] || null;
};

const getProjectWorkspacePath = (
  projectId: string | null | undefined,
  candidates: ProjectWorkspaceCandidate[]
): string | null => {
  if (!projectId) return null;
  return candidates.find((candidate) => candidate.id === projectId)?.workspacePath ?? null;
};

const getProjectWorkspaceCandidate = (
  projectId: string | null | undefined,
  candidates: ProjectWorkspaceCandidate[]
): ProjectWorkspaceCandidate | null => {
  if (!projectId) return null;
  return candidates.find((candidate) => candidate.id === projectId) ?? null;
};

const isVirtualRootEnabled = (
  options: ExecuteWorkspaceToolOptions,
  candidates: ProjectWorkspaceCandidate[]
): boolean => {
  if (options.virtualRootEnabled) {
    return candidates.length > 0;
  }

  return Boolean(options.groupId && candidates.length > 1);
};

const stripProjectSelectionArgs = (args: ToolArgs): ToolArgs => {
  const nextArgs = { ...args };
  delete nextArgs.project_id;
  delete nextArgs.projectId;
  return nextArgs;
};

const getExplicitToolProjectId = (
  args: ToolArgs,
  candidates: ProjectWorkspaceCandidate[]
): string | null => {
  const explicit = sanitizePathInput(toString(args.project_id) || toString(args.projectId));
  if (!explicit) return null;
  const normalizedExplicit = explicit.toLowerCase();
  const match = candidates.find((candidate) =>
    candidate.id === explicit ||
    getProjectAliases(candidate).includes(normalizedExplicit)
  );
  return match?.id ?? null;
};

const isRootPathInput = (value: string): boolean => {
  const normalized = value.trim().replace(/\\/g, '/');
  return !normalized || normalized === '.' || normalized === './';
};

const toVirtualPath = (
  candidate: ProjectWorkspaceCandidate,
  inputPath: string | null | undefined
): string => {
  const normalized = sanitizePathInput(toString(inputPath) || '.').replace(/\\/g, '/');
  if (isRootPathInput(normalized)) {
    return candidate.mountName;
  }

  return `${candidate.mountName}/${normalized.replace(/^\.\//, '')}`;
};

const getVirtualRootEntries = (candidates: ProjectWorkspaceCandidate[]) =>
  candidates.map((candidate) => ({
    path: candidate.mountName,
    relative_path: candidate.mountName,
    name: candidate.mountName,
    kind: 'directory',
    is_hidden: false,
    is_readonly: false,
  }));

const formatResolvedWorkspacePath = (
  candidate: ProjectWorkspaceCandidate | null,
  relativePath: string,
  mode: AppMode
): { virtualPath: string; realPath: string | null } => {
  if (!candidate) {
    return {
      virtualPath: sanitizePathInput(relativePath || '.'),
      realPath: null,
    };
  }

  return {
    virtualPath: toVirtualPath(candidate, relativePath),
    realPath:
      mode === 'Debug' && candidate.workspacePath
        ? joinPathWithinWorkspace(candidate.workspacePath, relativePath || '.')
        : null,
  };
};

const normalizeDirEntryForVirtualRoot = (
  entry: tauriIpc.FsDirEntryDto,
  candidate: ProjectWorkspaceCandidate,
  mode: AppMode
): tauriIpc.FsDirEntryDto => {
  const virtualPath = toVirtualPath(candidate, entry.relative_path || '.');
  const nextEntry: tauriIpc.FsDirEntryDto = {
    ...entry,
    path: mode === 'Debug' ? entry.path : virtualPath,
    relative_path: virtualPath,
    name: entry.name,
  };
  return nextEntry;
};

export const resolveToolWorkspaceRouting = (
  toolName: string,
  args: ToolArgs,
  options: ExecuteWorkspaceToolOptions
): {
  projectId: string | null;
  workspacePath: string | null;
  args: ToolArgs;
} => {
  const candidates = getProjectWorkspaceCandidates(options);
  const strippedArgs = stripProjectSelectionArgs(args);
  const rawPath =
    sanitizePathInput(
      isGitTool(toolName)
        ? toString(args.repo_path)
        : toString(args.path)
    ) || '';
  const defaultWorkspacePath =
    normalizeWorkspacePath(options.defaultWorkspacePath) ||
    normalizeWorkspacePath(options.workspacePath) ||
    getProjectWorkspacePath(options.focusedProjectId, candidates) ||
    getProjectWorkspacePath(options.projectId, candidates) ||
    normalizeWorkspacePath(getSelectedProjectRoot());

  let projectId = getExplicitToolProjectId(args, candidates);
  let adjustedPath = rawPath;

  if (rawPath) {
    if (!isAbsolutePath(rawPath)) {
      const prefixedMatch = stripProjectAliasPrefix(rawPath, candidates);
      if (prefixedMatch && (!projectId || projectId === prefixedMatch.projectId)) {
        projectId = prefixedMatch.projectId;
        adjustedPath = prefixedMatch.path;
      }
    } else if (!projectId) {
      projectId = findProjectByAbsolutePath(rawPath, candidates)?.id ?? null;
    }
  }

  const resolvedProjectId = projectId || options.projectId || null;
  const workspacePath =
    getProjectWorkspacePath(resolvedProjectId, candidates) ||
    defaultWorkspacePath;
  const nextArgs = { ...strippedArgs };
  const pathKey = isGitTool(toolName) ? 'repo_path' : 'path';
  if (rawPath && adjustedPath !== rawPath) {
    nextArgs[pathKey] = adjustedPath;
  }

  return {
    projectId: resolvedProjectId,
    workspacePath,
    args: nextArgs,
  };
};

const isAbsolutePath = (value: string): boolean =>
  /^(?:[a-zA-Z]:\/|\/)/.test(value.replace(/\\/g, '/'));

const resolvePathForMode = (inputPath: string, mode: AppMode): string => {
  if (mode !== 'Debug') {
    return inputPath;
  }

  const root = getSelectedProjectRoot().replace(/\\/g, '/').replace(/\/$/, '') || '.';
  const normalizedInput = (inputPath || '.').replace(/\\/g, '/');

  if (normalizedInput.startsWith('/')) {
    return normalizedInput;
  }

  if (normalizedInput === '.' || normalizedInput === '') {
    return root;
  }

  if (root === '.') {
    return normalizedInput;
  }

  return `${root}/${normalizedInput}`;
};

const joinPathWithinWorkspace = (workspacePath: string, inputPath: string): string => {
  const normalizedInput = (inputPath || '.').replace(/\\/g, '/');
  if (isAbsolutePath(normalizedInput)) {
    return normalizedInput;
  }

  if (normalizedInput === '.' || normalizedInput === '') {
    return workspacePath;
  }

  if (workspacePath === '.') {
    return normalizedInput.replace(/^\.\//, '');
  }

  return `${workspacePath}/${normalizedInput.replace(/^\.\//, '')}`;
};

const resolveBackendPath = (
  inputPath: string,
  mode: AppMode,
  workspacePath?: string | null
): string => {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (normalizedWorkspacePath && !isMacroScopedPath(inputPath)) {
    return inputPath;
  }

  return resolvePathForMode(inputPath, mode);
};

const resolveDirectPath = (
  inputPath: string,
  mode: AppMode,
  workspacePath?: string | null
): string => {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (normalizedWorkspacePath && !isMacroScopedPath(inputPath)) {
    return joinPathWithinWorkspace(normalizedWorkspacePath, inputPath);
  }

  return resolvePathForMode(inputPath, mode);
};

export const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
};

export const pathMatchesGlob = (path: string, pattern: string): boolean => {
  try {
    return globToRegex(pattern).test(path);
  } catch {
    return false;
  }
};

const readAllCandidateFiles = async (
  includeHidden = false,
  mode: AppMode,
  workspacePath?: string | null
) => {
  const debugMode = mode === 'Debug';
  const entries = await tauriIpc.fsListDir({
    path: resolveDirectPath('.', mode, workspacePath),
    recursive: true,
    includeHidden,
    allowOutsideWorkspace: debugMode || Boolean(normalizeWorkspacePath(workspacePath)),
  });
  return entries.filter((entry) => entry.kind === 'file');
};

const resolveGitRepoPath = (
  args: ToolArgs,
  mode: AppMode,
  workspacePath?: string | null
): string => {
  const explicitRepoPath = sanitizePathInput(toString(args.repo_path));
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (explicitRepoPath) {
    return normalizedWorkspacePath
      ? joinPathWithinWorkspace(normalizedWorkspacePath, explicitRepoPath)
      : resolvePathForMode(explicitRepoPath, mode);
  }

  return normalizedWorkspacePath || resolvePathForMode('.', mode);
};

const shouldFallbackRepoPath = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  const code = typeof maybe.code === 'string' ? maybe.code : '';
  const message = typeof maybe.message === 'string' ? maybe.message.toLowerCase() : '';
  return (
    code === 'FilesystemNotFound' ||
    code === 'GitRepositoryNotFound' ||
    code === 'InvalidPath' ||
    code === 'FilesystemPathOutsideWorkspace' ||
    message.includes('outside the workspace')
  );
};

const runGitWithRepoFallback = async <T>(
  primaryRepoPath: string,
  execute: (repoPath: string) => Promise<T>,
  allowFallbackToDot: boolean
): Promise<{ value: T; repoPath: string }> => {
  const candidates = allowFallbackToDot
    ? Array.from(new Set([primaryRepoPath, '.'].filter(Boolean)))
    : [primaryRepoPath];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const value = await execute(candidate);
      return { value, repoPath: candidate };
    } catch (error) {
      lastError = error;
      if (!shouldFallbackRepoPath(error) || candidate === candidates[candidates.length - 1]) {
        throw error;
      }
    }
  }

  throw lastError;
};

const canCheckWorkspaceEntries = (): boolean => tauriIpc.isTauriAvailable();

const workspaceEntryExists = async (
  candidate: ProjectWorkspaceCandidate,
  relativePath: string
): Promise<boolean> => {
  if (!candidate.workspacePath || !canCheckWorkspaceEntries()) {
    return false;
  }

  try {
    return await tauriIpc.fsExists(joinPathWithinWorkspace(candidate.workspacePath, relativePath), {
      workspacePath: candidate.workspacePath,
    });
  } catch {
    return false;
  }
};

const resolveVirtualToolTarget = async (params: {
  toolName: string;
  rawPath: string;
  args: ToolArgs;
  candidates: ProjectWorkspaceCandidate[];
  focusedProjectId?: string | null;
  defaultProjectId?: string | null;
}): Promise<{
  candidate: ProjectWorkspaceCandidate | null;
  relativePath: string;
  explicitTarget: boolean;
  usedFocusedProject: boolean;
  matchCount: number;
}> => {
  const explicitProjectId = getExplicitToolProjectId(params.args, params.candidates);
  const prefixedMatch =
    params.rawPath && !isAbsolutePath(params.rawPath)
      ? stripProjectAliasPrefix(params.rawPath, params.candidates)
      : null;

  if (explicitProjectId) {
    return {
      candidate: getProjectWorkspaceCandidate(explicitProjectId, params.candidates),
      relativePath: prefixedMatch && prefixedMatch.projectId === explicitProjectId ? prefixedMatch.path : params.rawPath || '.',
      explicitTarget: true,
      usedFocusedProject: false,
      matchCount: explicitProjectId ? 1 : 0,
    };
  }

  if (prefixedMatch) {
    return {
      candidate: getProjectWorkspaceCandidate(prefixedMatch.projectId, params.candidates),
      relativePath: prefixedMatch.path,
      explicitTarget: true,
      usedFocusedProject: false,
      matchCount: 1,
    };
  }

  if (isAbsolutePath(params.rawPath)) {
    const match = findProjectByAbsolutePath(params.rawPath, params.candidates);
    if (match) {
      return {
        candidate: match,
        relativePath:
          params.rawPath.replace(/\\/g, '/').slice((match.workspacePath || '').length).replace(/^\/+/, '') || '.',
        explicitTarget: true,
        usedFocusedProject: false,
        matchCount: 1,
      };
    }
  }

  const focusedCandidate =
    getProjectWorkspaceCandidate(params.focusedProjectId, params.candidates) ||
    getProjectWorkspaceCandidate(params.defaultProjectId, params.candidates);

  if (params.toolName === 'write' || params.toolName === 'edit') {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || '.',
      explicitTarget: false,
      usedFocusedProject: Boolean(focusedCandidate),
      matchCount: focusedCandidate ? 1 : 0,
    };
  }

  if (gitBackendToolIds.has(params.toolName)) {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || '.',
      explicitTarget: false,
      usedFocusedProject: Boolean(focusedCandidate),
      matchCount: focusedCandidate ? 1 : 0,
    };
  }

  if (focusedCandidate && (isRootPathInput(params.rawPath) || await workspaceEntryExists(focusedCandidate, params.rawPath))) {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || '.',
      explicitTarget: false,
      usedFocusedProject: Boolean(params.rawPath && !isRootPathInput(params.rawPath)),
      matchCount: 1,
    };
  }

  if (!params.rawPath || isRootPathInput(params.rawPath)) {
    return {
      candidate: focusedCandidate,
      relativePath: '.',
      explicitTarget: false,
      usedFocusedProject: false,
      matchCount: focusedCandidate ? 1 : 0,
    };
  }

  const matches = [];
  for (const candidate of params.candidates) {
    if (await workspaceEntryExists(candidate, params.rawPath)) {
      matches.push(candidate);
      if (matches.length > 1) {
        break;
      }
    }
  }

  return {
    candidate: matches.length === 1 ? matches[0] : null,
    relativePath: params.rawPath,
    explicitTarget: false,
    usedFocusedProject: false,
    matchCount: matches.length,
  };
};

export const executeWorkspaceTool = async (
  toolName: string,
  args: ToolArgs,
  mode: AppMode,
  options: ExecuteWorkspaceToolOptions = {}
): Promise<string | undefined> => {
  const useTauri = tauriIpc.isTauriAvailable();
  const useRemoteKernel = !useTauri && canUseRemoteKernel();
  const candidates = getProjectWorkspaceCandidates(options);
  const virtualRootCandidate = isVirtualRootEnabled(options, candidates);
  const focusedProjectId = options.focusedProjectId || options.projectId || null;
  const rawArgs = { ...args };
  const routing = resolveToolWorkspaceRouting(toolName, args, options);
  args = routing.args;
  const effectiveWorkspacePath =
    normalizeWorkspacePath(routing.workspacePath) ||
    normalizeWorkspacePath(options.defaultWorkspacePath) ||
    normalizeWorkspacePath(options.workspacePath) ||
    normalizeWorkspacePath(getSelectedProjectRoot());

  if (!useTauri && !useRemoteKernel) {
    return 'Workspace tools require Tauri runtime.';
  }

  const useMetadataWorkspace = mode === 'Architect' && (toolName === 'write' || toolName === 'edit');
  const virtualRootEnabled = virtualRootCandidate && !useMetadataWorkspace;

  const executeBackendTool = async (
    backendToolName: string,
    backendArgs: ToolArgs
  ): Promise<string> => {
    if (useTauri) {
      return tauriIpc.executeWorkspaceTool({
        mode,
        toolId: backendToolName,
        args: backendArgs,
        workspacePath: effectiveWorkspacePath,
        workspaceScope: useMetadataWorkspace ? 'metadata' : undefined,
      });
    }

    return executeRemoteWorkspaceTool({
      mode,
      toolId: backendToolName,
      args: backendArgs,
      workspacePath: effectiveWorkspacePath,
      workspaceScope: useMetadataWorkspace ? 'metadata' : undefined,
    });
  };

  const validateBackendTool = async (
    backendToolName: string,
    path?: string
  ): Promise<{ allowed: boolean; reason?: string | null }> => {
    if (useTauri) {
      return tauriIpc.validateToolExecution({
        mode,
        toolId: backendToolName,
        path,
      });
    }

    return validateRemoteToolExecution({
      mode,
      toolId: backendToolName,
      path,
    });
  };

  try {
    const workspaceToolIds = new Set(['list', 'read', 'write', 'edit', 'glob', 'grep']);
    if (workspaceToolIds.has(toolName) && !virtualRootEnabled) {
      try {
        const backendResult = await executeBackendTool(toolName, args);

        if (backendResult && backendResult !== 'UNSUPPORTED_WORKSPACE_TOOL') {
          return backendResult;
        }
      } catch (error) {
        if (!isUnknownCommandError(error)) {
          throw error;
        }
      }
    }

    if (gitBackendToolIds.has(toolName) && !virtualRootEnabled) {
      const explicitRepoPath = sanitizePathInput(toString(args.repo_path));
      const shouldUseBackendFirst = !(mode === 'Debug' && !explicitRepoPath);

      if (shouldUseBackendFirst) {
        const backendArgs: ToolArgs = {
          ...args,
          repo_path: explicitRepoPath || '.',
        };

        try {
          const backendResult = await executeBackendTool(toolName, backendArgs);

          if (backendResult && backendResult !== 'UNSUPPORTED_WORKSPACE_TOOL') {
            return backendResult;
          }
        } catch (error) {
          if (!isUnknownCommandError(error)) {
            throw error;
          }
        }
      }
    }

    const candidatePathInput = extractCandidatePath(toolName, args);
    const resolvedCandidatePath = candidatePathInput
      ? (useMetadataWorkspace ? candidatePathInput : resolveBackendPath(candidatePathInput, mode, effectiveWorkspacePath))
      : undefined;

    try {
      const validation = await validateBackendTool(toolName, resolvedCandidatePath);

      if (!validation.allowed) {
        return validation.reason || `Tool ${toolName} is not allowed in mode ${mode}.`;
      }
    } catch (validationError) {
      if (!isUnknownCommandError(validationError)) {
        throw validationError;
      }

      if ((toolName === 'write' || toolName === 'edit') && resolvedCandidatePath) {
        assertPathAllowed(mode, resolvedCandidatePath);
      }
    }

    if (virtualRootEnabled) {
      if (!useTauri) {
        return 'Virtual multi-project workspace tools require Tauri runtime.';
      }

      const explicitProjectId = getExplicitToolProjectId(rawArgs, candidates);
      const rawFsPath = sanitizePathInput(toString(rawArgs.path) || '.');
      const rawGitPath = sanitizePathInput(toString(rawArgs.repo_path) || '.');
      const prefixedFsPath =
        rawFsPath && !isAbsolutePath(rawFsPath)
          ? stripProjectAliasPrefix(rawFsPath, candidates)
          : null;

      if (toolName === 'list') {
        if (isRootPathInput(rawFsPath) && !explicitProjectId && !prefixedFsPath) {
          const entries = getVirtualRootEntries(candidates);
          return JSON.stringify({ path: '.', virtual_root: true, count: entries.length, entries }, null, 2);
        }

        const target = await resolveVirtualToolTarget({
          toolName,
          rawPath: rawFsPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });

        if (!target.candidate?.workspacePath) {
          if (target.matchCount > 1) {
            return `Error executing list: multiple subprojects match "${rawFsPath}". Prefix the path with a mount name or pass project_id.`;
          }
          return `Error executing list: unable to resolve "${rawFsPath}" to a subproject.`;
        }

        const recursive = rawArgs.recursive !== false;
        const includeHidden = rawArgs.include_hidden === true;
        const maxDepth =
          typeof rawArgs.max_depth === 'number'
            ? Math.max(1, Math.floor(rawArgs.max_depth))
            : undefined;
        const resolved = formatResolvedWorkspacePath(target.candidate, target.relativePath, mode);
        const entries = await tauriIpc.fsListDir({
          path: joinPathWithinWorkspace(target.candidate.workspacePath, target.relativePath),
          recursive,
          includeHidden,
          maxDepth,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        const normalizedEntries = entries.map((entry) =>
          normalizeDirEntryForVirtualRoot(entry, target.candidate!, mode)
        );
        return JSON.stringify(
          {
            path: resolved.virtualPath,
            project_id: target.candidate.id,
            mount_name: target.candidate.mountName,
            ...(resolved.realPath ? { real_path: resolved.realPath } : {}),
            count: normalizedEntries.length,
            entries: normalizedEntries,
          },
          null,
          2
        );
      }

      if (toolName === 'read') {
        if (!rawFsPath) return 'Missing path argument for read tool.';

        const target = await resolveVirtualToolTarget({
          toolName,
          rawPath: rawFsPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });

        if (!target.candidate?.workspacePath) {
          if (target.matchCount > 1) {
            return `Error executing read: multiple subprojects contain "${rawFsPath}". Prefix the path with a mount name or pass project_id.`;
          }
          return `Error executing read: unable to resolve "${rawFsPath}" to a subproject.`;
        }

        const path = joinPathWithinWorkspace(target.candidate.workspacePath, target.relativePath);
        const resolved = formatResolvedWorkspacePath(target.candidate, target.relativePath, mode);
        const result = await tauriIpc.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });

        if (result.is_binary) {
          return `File ${resolved.virtualPath} is binary (${result.size} bytes, encoding=${result.encoding}).`;
        }

        const startLine =
          typeof rawArgs.start_line === 'number' ? Math.max(1, Math.floor(rawArgs.start_line)) : 1;
        const endLine =
          typeof rawArgs.end_line === 'number'
            ? Math.max(startLine, Math.floor(rawArgs.end_line))
            : undefined;

        const lines = result.content.split('\n');
        const selected = lines.slice(startLine - 1, endLine ? endLine : undefined);
        const effectiveEndLine = endLine ?? startLine + selected.length - 1;
        const numberedContent = formatWithLineNumbers(selected, startLine);
        const notices: string[] = [
          `PROJECT_ID: ${target.candidate.id}`,
          `MOUNT: ${target.candidate.mountName}`,
        ];
        if (!target.explicitTarget && resolved.virtualPath !== rawFsPath) {
          notices.push(`RESOLVED_VIRTUAL_PATH: ${resolved.virtualPath}`);
        }
        if (resolved.realPath) {
          notices.push(`REAL_PATH: ${resolved.realPath}`);
        }

        return `FILE: ${resolved.virtualPath}\nSOURCE: WORKSPACE_FILE\n${notices.join('\n')}\nLANGUAGE: ${result.language}\nSIZE: ${result.size}\nLINES: ${startLine}-${effectiveEndLine}\n\n---BEGIN FILE CONTENT---\n${numberedContent}\n---END FILE CONTENT---`;
      }

      if (toolName === 'write') {
        const inputPath = sanitizePathInput(toString(rawArgs.path));
        const content = toString(rawArgs.content);
        if (!inputPath) return 'Missing path argument for write tool.';

        const target = await resolveVirtualToolTarget({
          toolName,
          rawPath: inputPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });

        if (!target.candidate?.workspacePath) {
          return 'Error executing write: select a subproject with project_id or a mount-prefixed path before writing.';
        }

        const resolved = formatResolvedWorkspacePath(target.candidate, target.relativePath, mode);
        assertPathAllowed(mode, resolved.virtualPath);
        const writeResult = await tauriIpc.fsWriteFile({
          path: joinPathWithinWorkspace(target.candidate.workspacePath, target.relativePath),
          content,
          createDirs: rawArgs.create_dirs !== false,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        return JSON.stringify(
          {
            ok: true,
            path: resolved.virtualPath,
            project_id: target.candidate.id,
            mount_name: target.candidate.mountName,
            ...(resolved.realPath ? { real_path: resolved.realPath } : {}),
            bytes_written: writeResult.bytes_written,
            created: writeResult.created,
          },
          null,
          2
        );
      }

      if (toolName === 'edit') {
        const inputPath = sanitizePathInput(toString(rawArgs.path));
        const oldText = toString(rawArgs.old_text);
        const newText = toString(rawArgs.new_text);
        const replaceAll = rawArgs.replace_all === true;

        if (!inputPath) return 'Missing path argument for edit tool.';
        if (!oldText) return 'Missing old_text argument for edit tool.';

        const target = await resolveVirtualToolTarget({
          toolName,
          rawPath: inputPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });

        if (!target.candidate?.workspacePath) {
          return 'Error executing edit: select a subproject with project_id or a mount-prefixed path before editing.';
        }

        const resolved = formatResolvedWorkspacePath(target.candidate, target.relativePath, mode);
        assertPathAllowed(mode, resolved.virtualPath);
        const realPath = joinPathWithinWorkspace(target.candidate.workspacePath, target.relativePath);
        const current = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        if (current.is_binary) {
          return `Cannot edit binary file: ${resolved.virtualPath}`;
        }

        const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const occurrences = (current.content.match(new RegExp(escapedOld, 'g')) || []).length;
        if (occurrences === 0) {
          return `No match found for old_text in ${resolved.virtualPath}.`;
        }

        const updated = replaceAll
          ? current.content.split(oldText).join(newText)
          : current.content.replace(oldText, newText);

        await tauriIpc.fsWriteFile({
          path: realPath,
          content: updated,
          createDirs: true,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        return JSON.stringify(
          {
            ok: true,
            path: resolved.virtualPath,
            project_id: target.candidate.id,
            mount_name: target.candidate.mountName,
            ...(resolved.realPath ? { real_path: resolved.realPath } : {}),
            replacements: replaceAll ? occurrences : 1,
          },
          null,
          2
        );
      }

      if (toolName === 'glob') {
        const pattern = toString(rawArgs.pattern) || '**/*';
        const includeHidden = rawArgs.include_hidden === true;
        const matches = new Set<string>();

        for (const candidate of candidates) {
          if (!candidate.workspacePath) continue;
          const files = await readAllCandidateFiles(includeHidden, mode, candidate.workspacePath);
          files.forEach((entry) => {
            const virtualPath = toVirtualPath(candidate, entry.relative_path);
            if (
              pathMatchesGlob(virtualPath, pattern) ||
              pathMatchesGlob(entry.relative_path, pattern)
            ) {
              matches.add(virtualPath);
            }
          });
        }

        return JSON.stringify(
          { pattern, virtual_root: true, count: matches.size, paths: Array.from(matches) },
          null,
          2
        );
      }

      if (toolName === 'grep') {
        const query = toString(rawArgs.query);
        if (!query) return 'Missing query argument for grep tool.';

        const includeHidden = rawArgs.include_hidden === true;
        const isRegexp = rawArgs.is_regexp === true;
        const includePattern = toString(rawArgs.include_pattern);
        const maxResults =
          typeof rawArgs.max_results === 'number'
            ? Math.max(1, Math.floor(rawArgs.max_results))
            : 50;

        let matcher: RegExp | null = null;
        if (isRegexp) {
          try {
            matcher = new RegExp(query, 'i');
          } catch {
            return `Invalid regex pattern for grep: ${query}`;
          }
        }

        const results: Array<{ path: string; line: number; text: string; project_id: string; mount_name: string }> = [];

        for (const candidate of candidates) {
          if (!candidate.workspacePath) continue;
          const files = await readAllCandidateFiles(includeHidden, mode, candidate.workspacePath);

          for (const file of files) {
            const virtualPath = toVirtualPath(candidate, file.relative_path);
            if (
              includePattern &&
              !pathMatchesGlob(virtualPath, includePattern) &&
              !pathMatchesGlob(file.relative_path, includePattern)
            ) {
              continue;
            }

            const content = await tauriIpc.fsReadFileWithOptions({
              path: joinPathWithinWorkspace(candidate.workspacePath, file.relative_path),
              allowOutsideWorkspace: true,
              workspacePath: candidate.workspacePath,
            });
            if (content.is_binary) continue;

            const lines = content.content.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index];
              const match = matcher
                ? matcher.test(line)
                : line.toLowerCase().includes(query.toLowerCase());
              if (match) {
                results.push({
                  path: virtualPath,
                  line: index + 1,
                  text: line.trim(),
                  project_id: candidate.id,
                  mount_name: candidate.mountName,
                });
                if (results.length >= maxResults) {
                  return JSON.stringify({ query, total: results.length, results }, null, 2);
                }
              }
            }
          }
        }

        return JSON.stringify({ query, total: results.length, results }, null, 2);
      }

      if (isGitTool(toolName)) {
        const target = await resolveVirtualToolTarget({
          toolName,
          rawPath: rawGitPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });

        if (!target.candidate?.workspacePath) {
          return 'Error executing git tool: select a subproject with project_id or a mount-prefixed repo_path before running git commands.';
        }

        const resolved = formatResolvedWorkspacePath(target.candidate, target.relativePath, mode);
        const repoPath = joinPathWithinWorkspace(target.candidate.workspacePath, target.relativePath);
        const allowRepoFallback = false;
        let effectiveRepoPath = repoPath;
        const repoMeta = {
          project_id: target.candidate.id,
          mount_name: target.candidate.mountName,
          repo_path: resolved.virtualPath,
          ...(resolved.realPath ? { real_repo_path: resolved.realPath } : {}),
        };

        if (toolName === 'git_status') {
          const { value: status } = await runGitWithRepoFallback(repoPath, (candidate) =>
            tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify({ ...repoMeta, ...status }, null, 2);
        }

        if (toolName === 'git_log') {
          const limit = typeof rawArgs.limit === 'number' ? Math.max(1, Math.floor(rawArgs.limit)) : undefined;
          const branch = toString(rawArgs.branch) || undefined;
          const { value: commits } = await runGitWithRepoFallback(repoPath, (candidate) =>
            tauriIpc.gitLog({ repoPath: candidate, limit, branch }),
            allowRepoFallback
          );
          return JSON.stringify({ ...repoMeta, count: commits.length, commits }, null, 2);
        }

        if (toolName === 'git_branch_list') {
          const { value: branches } = await runGitWithRepoFallback(repoPath, (candidate) =>
            tauriIpc.gitBranchList(candidate),
            allowRepoFallback
          );
          return JSON.stringify({ ...repoMeta, ...branches }, null, 2);
        }

        if (toolName === 'git_diff') {
          const base = toString(rawArgs.base) || undefined;
          const head = toString(rawArgs.head) || undefined;
          const contextLines =
            typeof rawArgs.context_lines === 'number'
              ? Math.max(0, Math.floor(rawArgs.context_lines))
              : undefined;
          const ignoreWhitespace = rawArgs.ignore_whitespace === true;
          const paths = Array.isArray(rawArgs.paths)
            ? rawArgs.paths.filter(
                (value): value is string => typeof value === 'string' && value.trim().length > 0
              )
            : undefined;
          const { value: patch } = await runGitWithRepoFallback(repoPath, (candidate) =>
            tauriIpc.gitDiff({
              repoPath: candidate,
              base,
              head,
              contextLines,
              ignoreWhitespace,
              paths,
            }),
            allowRepoFallback
          );
          const header = [
            `REPO: ${repoMeta.repo_path}`,
            `PROJECT_ID: ${repoMeta.project_id}`,
            `MOUNT: ${repoMeta.mount_name}`,
            ...(repoMeta.real_repo_path ? [`REAL_REPO_PATH: ${repoMeta.real_repo_path}`] : []),
          ].join('\n');
          return `${header}\n\n${patch || ''}`;
        }

        if (toolName === 'git_get_tree') {
          const branch = toString(rawArgs.branch) || undefined;
          const { value: tree } = await runGitWithRepoFallback(repoPath, (candidate) =>
            tauriIpc.gitGetTree({ repoPath: candidate, branch }),
            allowRepoFallback
          );
          return JSON.stringify({ ...repoMeta, ...tree }, null, 2);
        }

        if (toolName === 'git_add') {
          const paths = Array.isArray(rawArgs.paths)
            ? rawArgs.paths.filter(
                (value): value is string => typeof value === 'string' && value.trim().length > 0
              )
            : ['.'];
          await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitAdd({ repoPath: candidate, paths });
            },
            allowRepoFallback
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify(
            {
              ok: true,
              ...repoMeta,
              staged_paths: paths,
              staged_count: status.staged_files.length,
              branch: status.branch,
            },
            null,
            2
          );
        }

        if (toolName === 'git_commit') {
          const message = toString(rawArgs.message);
          if (!message) return 'Missing message argument for git_commit tool.';

          const { value: before } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitLog({ repoPath: candidate, limit: 1 });
            },
            allowRepoFallback
          );
          const headBefore = before[0]?.id ?? null;

          const { value: hash } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitCommit({
                repoPath: candidate,
                message,
                stageAll: rawArgs.stage_all !== false,
              });
            },
            allowRepoFallback
          );

          const { value: after } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitLog({ repoPath: candidate, limit: 1 }),
            allowRepoFallback
          );
          const headAfter = after[0]?.id ?? null;
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );

          return JSON.stringify(
            {
              ok: true,
              ...repoMeta,
              branch: status.branch,
              hash,
              head_before: headBefore,
              head_after: headAfter,
              head_changed: headBefore !== headAfter,
            },
            null,
            2
          );
        }

        if (toolName === 'git_checkout') {
          const branchOrCommit = toString(rawArgs.branch_or_commit) || toString(rawArgs.branch);
          if (!branchOrCommit) return 'Missing branch_or_commit argument for git_checkout tool.';

          await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitCheckout({
                repoPath: candidate,
                branchOrCommit,
                create: rawArgs.create === true,
              });
            },
            allowRepoFallback
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify(
            { ok: true, ...repoMeta, branch: status.branch, target: branchOrCommit },
            null,
            2
          );
        }

        if (toolName === 'git_merge') {
          const branchName = toString(rawArgs.branch_name) || toString(rawArgs.branch);
          const intoBranch = toString(rawArgs.into_branch);
          if (!branchName || !intoBranch) {
            return 'Missing branch_name or into_branch argument for git_merge tool.';
          }

          const { value: output } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitMerge({
                repoPath: candidate,
                branchName,
                intoBranch,
              });
            },
            allowRepoFallback
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify(
            {
              ok: true,
              ...repoMeta,
              branch: status.branch,
              merged_branch: branchName,
              into_branch: intoBranch,
              output,
            },
            null,
            2
          );
        }

        if (toolName === 'git_reset') {
          const modeArg = toString(rawArgs.mode);
          if (modeArg !== 'soft' && modeArg !== 'mixed' && modeArg !== 'hard') {
            return 'Missing or invalid mode for git_reset. Use one of: soft, mixed, hard.';
          }

          await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitReset({
                repoPath: candidate,
                mode: modeArg,
                commit: toString(rawArgs.commit) || undefined,
                confirm: rawArgs.confirm === true ? true : undefined,
              });
            },
            allowRepoFallback
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify({ ok: true, ...repoMeta, branch: status.branch }, null, 2);
        }

        if (toolName === 'git_stash') {
          const message = toString(rawArgs.message) || undefined;
          const { value: stashId } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitStash({ repoPath: candidate, message });
            },
            allowRepoFallback
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback
          );
          return JSON.stringify(
            { ok: true, ...repoMeta, branch: status.branch, stash: stashId },
            null,
            2
          );
        }

        return `Unknown Git tool: ${toolName}`;
      }
    }

    if (isGitTool(toolName)) {
      const allowRepoFallback = false;
      const repoPath = resolveGitRepoPath(args, mode, effectiveWorkspacePath);
      let effectiveRepoPath = repoPath;

      if (toolName === 'git_status') {
        const { value: status, repoPath: resolvedRepoPath } = await runGitWithRepoFallback(repoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify({ repo_path: resolvedRepoPath, ...status }, null, 2);
      }

      if (toolName === 'git_log') {
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;
        const branch = toString(args.branch) || undefined;
        const { value: commits, repoPath: resolvedRepoPath } = await runGitWithRepoFallback(repoPath, (candidate) =>
          tauriIpc.gitLog({ repoPath: candidate, limit, branch }),
          allowRepoFallback
        );
        return JSON.stringify({ repo_path: resolvedRepoPath, count: commits.length, commits }, null, 2);
      }

      if (toolName === 'git_branch_list') {
        const { value: branches, repoPath: resolvedRepoPath } = await runGitWithRepoFallback(repoPath, (candidate) =>
          tauriIpc.gitBranchList(candidate),
          allowRepoFallback
        );
        return JSON.stringify({ repo_path: resolvedRepoPath, ...branches }, null, 2);
      }

      if (toolName === 'git_diff') {
        const base = toString(args.base) || undefined;
        const head = toString(args.head) || undefined;
        const contextLines = typeof args.context_lines === 'number' ? Math.max(0, Math.floor(args.context_lines)) : undefined;
        const ignoreWhitespace = args.ignore_whitespace === true;
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : undefined;
        const { value: patch } = await runGitWithRepoFallback(repoPath, (candidate) =>
          tauriIpc.gitDiff({
            repoPath: candidate,
            base,
            head,
            contextLines,
            ignoreWhitespace,
            paths,
          }),
          allowRepoFallback
        );
        return patch || '';
      }

      if (toolName === 'git_get_tree') {
        const branch = toString(args.branch) || undefined;
        const { value: tree, repoPath: resolvedRepoPath } = await runGitWithRepoFallback(repoPath, (candidate) =>
          tauriIpc.gitGetTree({ repoPath: candidate, branch }),
          allowRepoFallback
        );
        return JSON.stringify({ repo_path: resolvedRepoPath, ...tree }, null, 2);
      }

      if (toolName === 'git_add') {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : ['.'];
        await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitAdd({ repoPath: candidate, paths });
        }, allowRepoFallback);
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify(
          {
            ok: true,
            repo_path: effectiveRepoPath,
            staged_paths: paths,
            staged_count: status.staged_files.length,
            branch: status.branch,
          },
          null,
          2
        );
      }

      if (toolName === 'git_commit') {
        const message = toString(args.message);
        if (!message) return 'Missing message argument for git_commit tool.';

        const { value: before } = await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitLog({ repoPath: candidate, limit: 1 });
        }, allowRepoFallback);
        const headBefore = before[0]?.id ?? null;

        const { value: hash } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitCommit({
            repoPath: candidate,
            message,
            stageAll: args.stage_all !== false,
          });
        }, allowRepoFallback);

        const { value: after } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitLog({ repoPath: candidate, limit: 1 }),
          allowRepoFallback
        );
        const headAfter = after[0]?.id ?? null;
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );

        return JSON.stringify(
          {
            ok: true,
            repo_path: effectiveRepoPath,
            branch: status.branch,
            hash,
            head_before: headBefore,
            head_after: headAfter,
            head_changed: headBefore !== headAfter,
          },
          null,
          2
        );
      }

      if (toolName === 'git_checkout') {
        const branchOrCommit = toString(args.branch_or_commit) || toString(args.branch);
        if (!branchOrCommit) return 'Missing branch_or_commit argument for git_checkout tool.';

        await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitCheckout({
            repoPath: candidate,
            branchOrCommit,
            create: args.create === true,
          });
        }, allowRepoFallback);
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify({ ok: true, repo_path: effectiveRepoPath, branch: status.branch, target: branchOrCommit }, null, 2);
      }

      if (toolName === 'git_merge') {
        const branchName = toString(args.branch_name) || toString(args.branch);
        const intoBranch = toString(args.into_branch);
        if (!branchName || !intoBranch) {
          return 'Missing branch_name or into_branch argument for git_merge tool.';
        }

        const { value: output } = await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitMerge({
            repoPath: candidate,
            branchName,
            intoBranch,
          });
        }, allowRepoFallback);
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify(
          {
            ok: true,
            repo_path: effectiveRepoPath,
            branch: status.branch,
            merged_branch: branchName,
            into_branch: intoBranch,
            output,
          },
          null,
          2
        );
      }

      if (toolName === 'git_reset') {
        const modeArg = toString(args.mode);
        if (modeArg !== 'soft' && modeArg !== 'mixed' && modeArg !== 'hard') {
          return 'Missing or invalid mode for git_reset. Use one of: soft, mixed, hard.';
        }

        await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitReset({
            repoPath: candidate,
            mode: modeArg,
            commit: toString(args.commit) || undefined,
            confirm: args.confirm === true ? true : undefined,
          });
        }, allowRepoFallback);
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify({ ok: true, repo_path: effectiveRepoPath, branch: status.branch }, null, 2);
      }

      if (toolName === 'git_stash') {
        const message = toString(args.message) || undefined;
        const { value: stashId } = await runGitWithRepoFallback(repoPath, (candidate) => {
          effectiveRepoPath = candidate;
          return tauriIpc.gitStash({ repoPath: candidate, message });
        }, allowRepoFallback);
        const { value: status } = await runGitWithRepoFallback(effectiveRepoPath, (candidate) =>
          tauriIpc.gitStatus(candidate),
          allowRepoFallback
        );
        return JSON.stringify({ ok: true, repo_path: effectiveRepoPath, branch: status.branch, stash: stashId }, null, 2);
      }

      return `Unknown Git tool: ${toolName}`;
    }

    if (toolName === 'list') {
      const inputPath = sanitizePathInput(toString(args.path) || '.');
      const path = resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      const recursive = args.recursive !== false;
      const includeHidden = args.include_hidden === true;
      const maxDepth = typeof args.max_depth === 'number' ? Math.max(1, Math.floor(args.max_depth)) : undefined;
      const debugMode = mode === 'Debug';

      const entries = await tauriIpc.fsListDir({
        path,
        recursive,
        includeHidden,
        maxDepth,
        allowOutsideWorkspace: debugMode || Boolean(effectiveWorkspacePath),
      });
      return JSON.stringify({ path, count: entries.length, entries }, null, 2);
    }

    if (toolName === 'read') {
      const inputPath = sanitizePathInput(toString(args.path));
      if (!inputPath) return 'Missing path argument for read tool.';
      const path = resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      let result;
      let resolvedPath = path;

      try {
        result = await tauriIpc.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: mode === 'Debug' || Boolean(effectiveWorkspacePath),
        });
      } catch (readError) {
        if (
          (mode !== 'Debug' && !effectiveWorkspacePath) ||
          isAbsolutePath(inputPath)
        ) {
          throw readError;
        }

        const root = resolveDirectPath('.', mode, effectiveWorkspacePath);
        const normalizedInput = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
        const entries = await tauriIpc.fsListDir({
          path: root,
          recursive: true,
          includeHidden: false,
          allowOutsideWorkspace: true,
        });

        const candidates = entries
          .filter((entry) => entry.kind === 'file')
          .filter((entry) => {
            const rel = entry.relative_path.replace(/\\/g, '/').replace(/^\.\//, '');
            const abs = entry.path.replace(/\\/g, '/');
            return (
              rel === normalizedInput ||
              rel.endsWith(`/${normalizedInput}`) ||
              abs.endsWith(`/${normalizedInput}`)
            );
          });

        const fallbackCandidates =
          candidates.length > 0
            ? candidates
            : entries
                .filter((entry) => entry.kind === 'file')
                .filter((entry) => {
                  const rel = entry.relative_path.replace(/\\/g, '/').replace(/^\.\//, '');
                  const relLower = rel.toLowerCase();
                  const inputLower = normalizedInput.toLowerCase();
                  const basename = rel.split('/').pop() || rel;
                  const basenameLower = basename.toLowerCase();
                  const basenameNoExt = basenameLower.replace(/\.[^/.]+$/, '');
                  const inputNoExt = inputLower.replace(/\.[^/.]+$/, '');

                  return (
                    relLower === inputLower ||
                    relLower.endsWith(`/${inputLower}`) ||
                    basenameLower === inputLower ||
                    basenameNoExt === inputNoExt ||
                    basenameLower.startsWith(`${inputLower}.`) ||
                    basenameLower.startsWith(`${inputNoExt}.`)
                  );
                });

        if (fallbackCandidates.length === 1) {
          resolvedPath = fallbackCandidates[0].path;
          result = await tauriIpc.fsReadFileWithOptions({
            path: resolvedPath,
            allowOutsideWorkspace: true,
          });
        } else if (fallbackCandidates.length > 1) {
          const suggestion = fallbackCandidates
            .slice(0, 5)
            .map((entry) => entry.relative_path)
            .join(', ');
          return `Error executing read: multiple files match "${inputPath}" under ${root}. Be explicit. Matches: ${suggestion}`;
        } else {
          throw readError;
        }
      }

      if (result.is_binary) {
        return `File ${resolvedPath} is binary (${result.size} bytes, encoding=${result.encoding}).`;
      }

      const startLine = typeof args.start_line === 'number' ? Math.max(1, Math.floor(args.start_line)) : 1;
      const endLine = typeof args.end_line === 'number' ? Math.max(startLine, Math.floor(args.end_line)) : undefined;

      const lines = result.content.split('\n');
      const selected = lines.slice(startLine - 1, endLine ? endLine : undefined);
      const effectiveEndLine = endLine ?? startLine + selected.length - 1;
      const numberedContent = formatWithLineNumbers(selected, startLine);
      const resolvedNotice = resolvedPath !== path
        ? `RESOLVED_PATH: ${resolvedPath} (from requested: ${inputPath})\n`
        : '';
      return `FILE: ${resolvedPath}\nSOURCE: WORKSPACE_FILE\n${resolvedNotice}LANGUAGE: ${result.language}\nSIZE: ${result.size}\nLINES: ${startLine}-${effectiveEndLine}\n\n---BEGIN FILE CONTENT---\n${numberedContent}\n---END FILE CONTENT---`;
    }

    if (toolName === 'write') {
      const inputPath = sanitizePathInput(toString(args.path));
      const content = toString(args.content);
      if (!inputPath) return 'Missing path argument for write tool.';
      const path = useMetadataWorkspace ? inputPath : resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      assertPathAllowed(mode, useMetadataWorkspace ? inputPath : resolveBackendPath(inputPath, mode, effectiveWorkspacePath));
      const createDirs = args.create_dirs !== false;
      const writeResult = await tauriIpc.fsWriteFile({
        path,
        content,
        createDirs,
        allowOutsideWorkspace: mode === 'Debug' || (!useMetadataWorkspace && Boolean(effectiveWorkspacePath)),
        workspaceScope: useMetadataWorkspace ? 'metadata' : undefined,
      });
      return JSON.stringify({ ok: true, ...writeResult }, null, 2);
    }

    if (toolName === 'edit') {
      const inputPath = sanitizePathInput(toString(args.path));
      const oldText = toString(args.old_text);
      const newText = toString(args.new_text);
      const replaceAll = args.replace_all === true;

      if (!inputPath) return 'Missing path argument for edit tool.';
      if (!oldText) return 'Missing old_text argument for edit tool.';

      const path = useMetadataWorkspace ? inputPath : resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      assertPathAllowed(mode, useMetadataWorkspace ? inputPath : resolveBackendPath(inputPath, mode, effectiveWorkspacePath));

      const current = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace: mode === 'Debug' || (!useMetadataWorkspace && Boolean(effectiveWorkspacePath)),
        workspaceScope: useMetadataWorkspace ? 'metadata' : undefined,
      });
      if (current.is_binary) {
        return `Cannot edit binary file: ${path}`;
      }

      const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const occurrences = (current.content.match(new RegExp(escapedOld, 'g')) || []).length;
      if (occurrences === 0) {
        return `No match found for old_text in ${path}.`;
      }

      const updated = replaceAll
        ? current.content.split(oldText).join(newText)
        : current.content.replace(oldText, newText);

      const writeResult = await tauriIpc.fsWriteFile({
        path,
        content: updated,
        createDirs: true,
        allowOutsideWorkspace: mode === 'Debug' || (!useMetadataWorkspace && Boolean(effectiveWorkspacePath)),
        workspaceScope: useMetadataWorkspace ? 'metadata' : undefined,
      });
      return JSON.stringify({ ok: true, replacements: replaceAll ? occurrences : 1, ...writeResult }, null, 2);
    }

    if (toolName === 'glob') {
      const pattern = toString(args.pattern) || '**/*';
      const includeHidden = args.include_hidden === true;
      const files = await readAllCandidateFiles(includeHidden, mode, effectiveWorkspacePath);
      const matches = files
        .map((entry) => entry.relative_path)
        .filter((relativePath) => pathMatchesGlob(relativePath, pattern));
      return JSON.stringify({ pattern, count: matches.length, paths: matches }, null, 2);
    }

    if (toolName === 'grep') {
      const query = toString(args.query);
      if (!query) return 'Missing query argument for grep tool.';

      const includeHidden = args.include_hidden === true;
      const isRegexp = args.is_regexp === true;
      const includePattern = toString(args.include_pattern);
      const maxResults = typeof args.max_results === 'number' ? Math.max(1, Math.floor(args.max_results)) : 50;

      const files = await readAllCandidateFiles(includeHidden, mode, effectiveWorkspacePath);
      let matcher: RegExp | null = null;
      if (isRegexp) {
        try {
          matcher = new RegExp(query, 'i');
        } catch {
          return `Invalid regex pattern for grep: ${query}`;
        }
      }
      const results: Array<{ path: string; line: number; text: string }> = [];

      for (const file of files) {
        if (includePattern && !pathMatchesGlob(file.relative_path, includePattern)) {
          continue;
        }

        const content = await tauriIpc.fsReadFileWithOptions({
          path: resolveDirectPath(file.relative_path, mode, effectiveWorkspacePath),
          allowOutsideWorkspace: mode === 'Debug' || Boolean(effectiveWorkspacePath),
        });
        if (content.is_binary) continue;

        const lines = content.content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const match = matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase());
          if (match) {
            results.push({ path: file.relative_path, line: index + 1, text: line.trim() });
            if (results.length >= maxResults) {
              return JSON.stringify({ query, total: results.length, results }, null, 2);
            }
          }
        }
      }

      return JSON.stringify({ query, total: results.length, results }, null, 2);
    }

    return undefined;
  } catch (error) {
    return `Error executing ${toolName}: ${formatToolError(error)}`;
  }
};
