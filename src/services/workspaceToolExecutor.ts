import * as tauriIpc from './tauriIpc';
import type { AppMode } from '../types';
import { isMacroScopedPath } from './toolModePolicy';
import { useAppStore } from '../stores/useAppStore';

type ToolArgs = Record<string, unknown>;

export const isWriteTool = (toolName: string): boolean => toolName === 'write' || toolName === 'edit';

export const assertPathAllowed = (mode: AppMode, path: string): void => {
  if (mode !== 'Architect') return;
  if (!isMacroScopedPath(path)) {
    throw new Error('Architect mode can only edit files under .macro/.');
  }
};

const toString = (value: unknown): string => (typeof value === 'string' ? value : '');

const getSelectedProjectRoot = (): string => {
  const appState = useAppStore.getState();
  if (!appState.selectedGroupId) return '.';

  const group = appState.projectGroups.find((candidate) => candidate.id === appState.selectedGroupId);
  if (!group) return '.';

  const project = appState.selectedProjectId
    ? group.projects.find((candidate) => candidate.id === appState.selectedProjectId)
    : group.projects[0];

  return project?.path || '.';
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

export const executeWorkspaceTool = async (
  toolName: string,
  args: ToolArgs,
  mode: AppMode
): Promise<string | undefined> => {
  if (!tauriIpc.isTauriAvailable()) {
    return 'Workspace tools require Tauri runtime.';
  }

  try {
    if (toolName === 'list') {
      const inputPath = toString(args.path) || '.';
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
      const inputPath = toString(args.path);
      if (!inputPath) return 'Missing path argument for read tool.';
      const path = resolvePathForMode(inputPath, mode);
      const result = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace: mode === 'Debug',
      });
      if (result.is_binary) {
        return `File ${path} is binary (${result.size} bytes, encoding=${result.encoding}).`;
      }

      const startLine = typeof args.start_line === 'number' ? Math.max(1, Math.floor(args.start_line)) : 1;
      const endLine = typeof args.end_line === 'number' ? Math.max(startLine, Math.floor(args.end_line)) : undefined;

      const lines = result.content.split('\n');
      const selected = lines.slice(startLine - 1, endLine ? endLine : undefined);
      return `FILE: ${path}\nLANGUAGE: ${result.language}\nSIZE: ${result.size}\n\n${selected.join('\n')}`;
    }

    if (toolName === 'write') {
      const inputPath = toString(args.path);
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
      const inputPath = toString(args.path);
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
    return `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
  }
};
