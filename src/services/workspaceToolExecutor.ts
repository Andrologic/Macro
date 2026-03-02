import * as tauriIpc from './tauriIpc';
import type { AppMode } from '../types';
import { isMacroScopedPath } from './toolModePolicy';
import {
  canUseRemoteKernel,
  executeRemoteWorkspaceTool,
  validateRemoteToolExecution,
} from './remoteKernelApi';
import { useAppStore } from '../stores/useAppStore';

type ToolArgs = Record<string, unknown>;
const isGitTool = (toolName: string): boolean => toolName.startsWith('git_');

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
  if (!isMacroScopedPath(path)) {
    throw new Error('Architect mode can only edit files under .macro/.');
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

  if (appState.selectedProjectId) {
    for (const group of appState.projectGroups) {
      const selectedProject = group.projects.find((project) => project.id === appState.selectedProjectId);
      if (selectedProject?.path) {
        return normalize(selectedProject.path) || '.';
      }
    }
  }

  if (appState.selectedGroupId) {
    const group = appState.projectGroups.find((candidate) => candidate.id === appState.selectedGroupId);
    const fallbackGroupProject = group?.projects[0];
    if (fallbackGroupProject?.path) {
      return normalize(fallbackGroupProject.path) || '.';
    }
  }

  for (const group of appState.projectGroups) {
    const firstProject = group.projects[0];
    if (firstProject?.path) {
      return normalize(firstProject.path) || '.';
    }
  }

  return '.';
};

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

const readAllCandidateFiles = async (includeHidden = false, mode: AppMode) => {
  const debugMode = mode === 'Debug';
  const entries = await tauriIpc.fsListDir({
    path: resolvePathForMode('.', mode),
    recursive: true,
    includeHidden,
    allowOutsideWorkspace: debugMode,
  });
  return entries.filter((entry) => entry.kind === 'file');
};

const resolveGitRepoPath = (args: ToolArgs, mode: AppMode): string => {
  const explicitRepoPath = sanitizePathInput(toString(args.repo_path));
  if (explicitRepoPath) {
    return resolvePathForMode(explicitRepoPath, mode);
  }

  return resolvePathForMode('.', mode);
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

export const executeWorkspaceTool = async (
  toolName: string,
  args: ToolArgs,
  mode: AppMode
): Promise<string | undefined> => {
  const useTauri = tauriIpc.isTauriAvailable();
  const useRemoteKernel = !useTauri && canUseRemoteKernel();

  if (!useTauri && !useRemoteKernel) {
    return 'Workspace tools require Tauri runtime.';
  }

  const executeBackendTool = async (
    backendToolName: string,
    backendArgs: ToolArgs
  ): Promise<string> => {
    if (useTauri) {
      return tauriIpc.executeWorkspaceTool({
        mode,
        toolId: backendToolName,
        args: backendArgs,
      });
    }

    return executeRemoteWorkspaceTool({
      mode,
      toolId: backendToolName,
      args: backendArgs,
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
    if (workspaceToolIds.has(toolName)) {
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

    const gitBackendToolIds = new Set([
      'git_status',
      'git_log',
      'git_branch_list',
      'git_diff',
      'git_get_tree',
      'git_add',
      'git_commit',
      'git_checkout',
      'git_reset',
      'git_stash',
    ]);
    if (gitBackendToolIds.has(toolName)) {
      const explicitRepoPath = sanitizePathInput(toString(args.repo_path));
      const shouldUseBackendFirst = !(mode === 'Debug' && !explicitRepoPath);

      if (shouldUseBackendFirst) {
        const backendArgs: ToolArgs = {
          ...args,
          repo_path: explicitRepoPath || resolvePathForMode('.', mode),
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
      ? resolvePathForMode(candidatePathInput, mode)
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

    if (isGitTool(toolName)) {
      const allowRepoFallback = false;
      const repoPath = resolveGitRepoPath(args, mode);
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
      const path = resolvePathForMode(inputPath, mode);
      const recursive = args.recursive !== false;
      const includeHidden = args.include_hidden === true;
      const maxDepth = typeof args.max_depth === 'number' ? Math.max(1, Math.floor(args.max_depth)) : undefined;
      const debugMode = mode === 'Debug';

      const entries = await tauriIpc.fsListDir({
        path,
        recursive,
        includeHidden,
        maxDepth,
        allowOutsideWorkspace: debugMode,
      });
      return JSON.stringify({ path, count: entries.length, entries }, null, 2);
    }

    if (toolName === 'read') {
      const inputPath = sanitizePathInput(toString(args.path));
      if (!inputPath) return 'Missing path argument for read tool.';
      const path = resolvePathForMode(inputPath, mode);
      let result;
      let resolvedPath = path;

      try {
        result = await tauriIpc.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: mode === 'Debug',
        });
      } catch (readError) {
        if (mode !== 'Debug' || inputPath.startsWith('/')) {
          throw readError;
        }

        const root = resolvePathForMode('.', mode);
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
      const path = resolvePathForMode(inputPath, mode);
      assertPathAllowed(mode, path);
      const createDirs = args.create_dirs !== false;
      const writeResult = await tauriIpc.fsWriteFile({
        path,
        content,
        createDirs,
        allowOutsideWorkspace: mode === 'Debug',
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

      const path = resolvePathForMode(inputPath, mode);

      assertPathAllowed(mode, path);

      const current = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace: mode === 'Debug',
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
        allowOutsideWorkspace: mode === 'Debug',
      });
      return JSON.stringify({ ok: true, replacements: replaceAll ? occurrences : 1, ...writeResult }, null, 2);
    }

    if (toolName === 'glob') {
      const pattern = toString(args.pattern) || '**/*';
      const includeHidden = args.include_hidden === true;
      const files = await readAllCandidateFiles(includeHidden, mode);
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

      const files = await readAllCandidateFiles(includeHidden, mode);
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
          path: resolvePathForMode(file.relative_path, mode),
          allowOutsideWorkspace: mode === 'Debug',
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
