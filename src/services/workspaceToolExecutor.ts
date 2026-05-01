import * as tauriIpc from "./tauriIpc";
import type { AppMode } from "../types";
import type { ProjectMount } from "../types";
import { isMacroScopedPath, isMetadataRelativePath } from "./toolModePolicy";
import {
  canUseRemoteKernel,
  executeRemoteWorkspaceTool,
  validateRemoteToolExecution,
} from "./remoteKernelApi";
import { useAppStore } from "../stores/useAppStore";
import {
  getFocusedProjectForGroup,
  getSubProjectsForGroup,
} from "./globalProjects";

type ToolArgs = Record<string, unknown>;
const isGitTool = (toolName: string): boolean => toolName.startsWith("git_");
const gitReadToolIds = new Set([
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
]);
const gitMutatingToolIds = new Set([
  "git_add",
  "git_commit",
  "git_checkout",
  "git_merge",
  "git_reset",
  "git_stash",
]);
const gitBackendToolIds = new Set([...gitReadToolIds, ...gitMutatingToolIds]);

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

export const isWriteTool = (toolName: string): boolean =>
  toolName === "write" ||
  toolName === "edit" ||
  toolName === "delete" ||
  toolName === "apply_patch";

const isUnknownCommandError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const maybe = error as Record<string, unknown>;
  const message =
    typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  return (
    message.includes("unknown command") ||
    message.includes("tool_validate_execution") ||
    message.includes("tool_execute_workspace")
  );
};

const extractCandidatePath = (
  toolName: string,
  args: ToolArgs,
): string | undefined => {
  if (
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "delete" ||
    toolName === "read" ||
    toolName === "list"
  ) {
    const rawPath = sanitizePathInput(toString(args.path) || ".");
    return rawPath || undefined;
  }

  return undefined;
};

export const assertPathAllowed = (mode: AppMode, path: string): void => {
  if (mode !== "Architect") return;
  if (!isMetadataRelativePath(path)) {
    throw new Error(
      "Architect mode can only edit metadata files in the @macro root.",
    );
  }
};

const toString = (value: unknown): string =>
  typeof value === "string" ? value : "";

type ParsedPatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | {
      kind: "update";
      path: string;
      hunks: Array<Array<{ kind: " " | "+" | "-"; content: string }>>;
    }
  | { kind: "delete"; path: string };

type PatchTarget = {
  candidate: ProjectWorkspaceCandidate;
  relativePath: string;
  displayPath: string;
  realPath: string;
};

type PatchValidationRecord = {
  path: string;
  exists: boolean;
  readable: boolean;
  is_binary: boolean;
  size: number;
  encoding: string | null;
  language: string | null;
};

type PatchChangeRecord = {
  path: string;
  status: "created" | "updated" | "deleted";
  additions: number;
  deletions: number;
  created: boolean;
  bytes_written: number;
  validation: PatchValidationRecord;
  project_id?: string;
  mount_name?: string;
  real_path?: string;
};

type StructuredWriteResultInput = {
  path: string;
  status: "created" | "updated" | "deleted";
  additions: number;
  deletions: number;
  created: boolean;
  bytesWritten: number;
  validation: PatchValidationRecord;
  replacements?: number;
  projectId?: string;
  mountName?: string;
  realPath?: string | null;
  rawPath?: string;
};

type PatchWriteCommitChange = {
  displayPath: string;
  realPath: string;
  newContent: string | null;
  existsOptions?: {
    workspaceScope?: tauriIpc.WorkspaceScope;
    workspacePath?: string | null;
  };
  readOptions?: {
    allowOutsideWorkspace?: boolean;
    workspaceScope?: tauriIpc.WorkspaceScope;
    workspacePath?: string | null;
  };
  writeOptions?: {
    allowOutsideWorkspace?: boolean;
    workspaceScope?: tauriIpc.WorkspaceScope;
    workspacePath?: string | null;
  };
  deleteOptions?: {
    workspaceScope?: tauriIpc.WorkspaceScope;
    workspacePath?: string | null;
  };
};

type PatchWriteRollbackSnapshot = {
  change: PatchWriteCommitChange;
  existed: boolean;
  content: string | null;
};

const formatToolError = (error: unknown): string => {
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object") {
    const maybe = error as Record<string, unknown>;
    const code = typeof maybe.code === "string" ? maybe.code : undefined;
    const message =
      typeof maybe.message === "string" ? maybe.message : undefined;
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

const rollbackPatchWriteChanges = async (
  snapshots: PatchWriteRollbackSnapshot[],
): Promise<void> => {
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.existed) {
      try {
        if (await tauriIpc.fsExists(snapshot.change.realPath, snapshot.change.existsOptions)) {
          await tauriIpc.fsDelete({
            path: snapshot.change.realPath,
            ...snapshot.change.deleteOptions,
          });
        }
      } catch (error) {
        throw new Error(
          `Rollback failed for ${snapshot.change.displayPath}: ${formatToolError(error)}`,
        );
      }
      continue;
    }

    if (snapshot.content === null) {
      continue;
    }

    try {
      await tauriIpc.fsWriteFile({
        path: snapshot.change.realPath,
        content: snapshot.content,
        createDirs: true,
        ...snapshot.change.writeOptions,
      });
    } catch (error) {
      throw new Error(
        `Rollback failed for ${snapshot.change.displayPath}: ${formatToolError(error)}`,
      );
    }
  }
};

const commitPatchWriteChangesWithRollback = async (
  changes: PatchWriteCommitChange[],
): Promise<void> => {
  const snapshots: PatchWriteRollbackSnapshot[] = [];

  try {
    for (const change of changes) {
      const existed = await tauriIpc.fsExists(change.realPath, change.existsOptions);
      const content = existed
        ? (
            await tauriIpc.fsReadFileWithOptions({
              path: change.realPath,
              ...change.readOptions,
            })
          ).content
        : null;
      snapshots.push({ change, existed, content });
    }

    for (const change of changes) {
      if (change.newContent === null) {
        await tauriIpc.fsDelete({
          path: change.realPath,
          ...change.deleteOptions,
        });
        continue;
      }

      await tauriIpc.fsWriteFile({
        path: change.realPath,
        content: change.newContent,
        createDirs: true,
        ...change.writeOptions,
      });
    }
  } catch (error) {
    try {
      await rollbackPatchWriteChanges(snapshots);
    } catch (rollbackError) {
      throw new Error(
        `${formatToolError(error)}; ${formatToolError(rollbackError)}`,
      );
    }
    throw error;
  }
};

const parseApplyPatch = (patchText: string): ParsedPatchOperation[] => {
  const lines = patchText.split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error(
      "Invalid apply_patch payload: missing '*** Begin Patch' header.",
    );
  }
  if (lines[lines.length - 1] !== "*** End Patch") {
    throw new Error(
      "Invalid apply_patch payload: missing '*** End Patch' footer.",
    );
  }

  const operations: ParsedPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      const addedLines: string[] = [];
      index += 1;
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new Error(
            `Invalid add-file line for ${path}: expected '+' prefix.`,
          );
        }
        addedLines.push(lines[index].slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, lines: addedLines });
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      const hunks: Array<Array<{ kind: " " | "+" | "-"; content: string }>> =
        [];
      let currentHunk: Array<{ kind: " " | "+" | "-"; content: string }> = [];
      index += 1;
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (current === "@@" || current.startsWith("@@ ")) {
          if (currentHunk.length > 0) {
            hunks.push(currentHunk);
            currentHunk = [];
          }
          index += 1;
          continue;
        }
        const kind = current[0] as " " | "+" | "-";
        if (kind !== " " && kind !== "+" && kind !== "-") {
          throw new Error(
            `Invalid update hunk line for ${path}: expected ' ', '+', or '-'.`,
          );
        }
        currentHunk.push({ kind, content: current.slice(1) });
        index += 1;
      }
      if (currentHunk.length > 0) {
        hunks.push(currentHunk);
      }
      if (hunks.length === 0) {
        throw new Error(
          `Update patch for ${path} must contain at least one hunk.`,
        );
      }
      operations.push({ kind: "update", path, hunks });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }

    throw new Error(`Invalid apply_patch section header: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error(
      "Invalid apply_patch payload: no file operations were provided.",
    );
  }

  return operations;
};

const splitTextLines = (
  content: string,
): { lines: string[]; trailingNewline: boolean } => {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
};

const joinTextLines = (lines: string[], trailingNewline: boolean): string => {
  const joined = lines.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
};

const findLineSequence = (
  lines: string[],
  needle: string[],
  startIndex: number,
): number => {
  if (needle.length === 0) {
    return Math.min(startIndex, lines.length);
  }
  for (
    let candidateStart = startIndex;
    candidateStart <= lines.length - needle.length;
    candidateStart += 1
  ) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[candidateStart + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return candidateStart;
    }
  }
  return -1;
};

const applyPatchHunksToContent = (
  path: string,
  currentContent: string,
  hunks: Array<Array<{ kind: " " | "+" | "-"; content: string }>>,
): string => {
  const { lines, trailingNewline } = splitTextLines(currentContent);
  let searchStart = 0;
  for (const hunk of hunks) {
    const oldLines = hunk
      .filter((line) => line.kind !== "+")
      .map((line) => line.content);
    const replacementLines = hunk
      .filter((line) => line.kind !== "-")
      .map((line) => line.content);
    const replaceAt = findLineSequence(lines, oldLines, searchStart);
    if (replaceAt === -1) {
      throw new Error(`Patch hunk could not be applied cleanly to ${path}.`);
    }
    lines.splice(replaceAt, oldLines.length, ...replacementLines);
    searchStart = replaceAt + replacementLines.length;
  }
  return joinTextLines(lines, trailingNewline);
};

const computeLineChangeStats = (
  oldContent: string,
  newContent: string,
): { additions: number; deletions: number } => {
  const oldLines = splitTextLines(oldContent).lines;
  const newLines = splitTextLines(newContent).lines;
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    additions: Math.max(0, newLines.length - prefix - suffix),
    deletions: Math.max(0, oldLines.length - prefix - suffix),
  };
};

const buildApplyPatchDiff = (
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>,
): string =>
  files
    .map(
      (file) =>
        `${file.status.toUpperCase()} ${file.path} (+${file.additions} -${file.deletions})`,
    )
    .join("\n");

const countLogicalLines = (content: string): number =>
  splitTextLines(content).lines.length;

const buildStructuredWriteResponse = (
  input: StructuredWriteResultInput,
): string =>
  JSON.stringify(
    {
      ok: true,
      ...(typeof input.replacements === "number"
        ? { replacements: input.replacements }
        : {}),
      ...(input.rawPath ? { path: input.rawPath } : {}),
      ...(typeof input.rawPath === "undefined" && input.realPath
        ? { path: input.realPath }
        : {}),
      bytes_written: input.bytesWritten,
      created: input.created,
      files: [
        {
          path: input.path,
          status: input.status,
          additions: input.additions,
          deletions: input.deletions,
          created: input.created,
          bytes_written: input.bytesWritten,
          validation: input.validation,
          ...(input.projectId ? { project_id: input.projectId } : {}),
          ...(input.mountName ? { mount_name: input.mountName } : {}),
          ...(input.realPath ? { real_path: input.realPath } : {}),
        },
      ],
      diff: buildApplyPatchDiff([
        {
          path: input.path,
          status: input.status,
          additions: input.additions,
          deletions: input.deletions,
        },
      ]),
      diagnostics: [],
      validation: {
        all_files_readable:
          input.validation.readable || !input.validation.exists,
        files: [input.validation],
      },
      errors: [],
    },
    null,
    2,
  );

const sanitizePathInput = (value: string): string =>
  value
    .trim()
    .replace(/^['"`]+/, "")
    .replace(/['"`]+$/, "")
    .replace(/^\.\//, "");

const formatWithLineNumbers = (lines: string[], startLine: number): string => {
  return lines
    .map(
      (line, index) =>
        `${String(startLine + index).padStart(4, " ")} | ${line}`,
    )
    .join("\n");
};

const getSelectedProjectRoot = (): string => {
  const appState = useAppStore.getState();
  const normalize = (value?: string): string =>
    (value || "").replace(/\\/g, "/").replace(/\/$/, "");

  const focusedProject = getFocusedProjectForGroup(
    appState.projectGroups,
    appState.selectedGroupId,
    appState.selectedProjectId,
  );
  if (focusedProject?.path) {
    return normalize(focusedProject.path) || ".";
  }

  for (const group of appState.projectGroups) {
    const firstProject = group.projects[0];
    if (firstProject?.path) {
      return normalize(firstProject.path) || ".";
    }
  }

  return ".";
};

const normalizeWorkspacePath = (value?: string | null): string | null => {
  const trimmed = (value || "").trim().replace(/\\/g, "/").replace(/\/$/, "");
  if (!trimmed || trimmed === "." || trimmed === "./") {
    return null;
  }
  return trimmed;
};

interface ProjectWorkspaceCandidate {
  id: string;
  name: string;
  mountName: string;
  workspacePath: string | null;
  isReadOnly: boolean;
}

const slugifyProjectAlias = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const getProjectWorkspaceCandidates = (
  options: ExecuteWorkspaceToolOptions,
): ProjectWorkspaceCandidate[] => {
  if (options.projectMounts?.length) {
    return options.projectMounts.map((mount) => ({
      id: mount.projectId,
      name: mount.displayName,
      mountName: mount.mountName,
      workspacePath: normalizeWorkspacePath(
        options.workspacePathsByProjectId?.[mount.projectId] ||
          mount.workspacePath,
      ),
      isReadOnly: Boolean(mount.isReadOnly),
    }));
  }

  const appState = useAppStore.getState();
  const projects = options.groupId
    ? getSubProjectsForGroup(appState.projectGroups, options.groupId)
    : appState.projectGroups.flatMap((group) => group.projects);

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    mountName: project.mountName,
    workspacePath:
      normalizeWorkspacePath(options.workspacePathsByProjectId?.[project.id]) ||
      normalizeWorkspacePath(project.path),
    isReadOnly: Boolean(project.isReadOnly),
  }));
};

const getProjectAliases = (candidate: ProjectWorkspaceCandidate): string[] => {
  const workspaceTail =
    candidate.workspacePath?.split("/").filter(Boolean).pop() || "";
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
        .filter(Boolean),
    ),
  );
};

const stripProjectAliasPrefix = (
  inputPath: string,
  candidates: ProjectWorkspaceCandidate[],
): { projectId: string; path: string } | null => {
  const normalizedInput = inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedInput || normalizedInput === ".") {
    return null;
  }

  for (const candidate of candidates) {
    for (const alias of getProjectAliases(candidate)) {
      if (normalizedInput === alias) {
        return { projectId: candidate.id, path: "." };
      }
      if (normalizedInput.startsWith(`${alias}/`)) {
        return {
          projectId: candidate.id,
          path: normalizedInput.slice(alias.length + 1) || ".",
        };
      }
    }
  }

  return null;
};

const findProjectByAbsolutePath = (
  inputPath: string,
  candidates: ProjectWorkspaceCandidate[],
): ProjectWorkspaceCandidate | null => {
  const normalizedInput = normalizeWorkspacePath(inputPath);
  if (!normalizedInput) return null;

  const matchingCandidates = candidates
    .filter(
      (candidate) =>
        candidate.workspacePath &&
        normalizedInput.startsWith(candidate.workspacePath),
    )
    .sort(
      (left, right) =>
        (right.workspacePath?.length || 0) - (left.workspacePath?.length || 0),
    );

  return matchingCandidates[0] || null;
};

const getProjectWorkspacePath = (
  projectId: string | null | undefined,
  candidates: ProjectWorkspaceCandidate[],
): string | null => {
  if (!projectId) return null;
  return (
    candidates.find((candidate) => candidate.id === projectId)?.workspacePath ??
    null
  );
};

const getProjectWorkspaceCandidate = (
  projectId: string | null | undefined,
  candidates: ProjectWorkspaceCandidate[],
): ProjectWorkspaceCandidate | null => {
  if (!projectId) return null;
  return candidates.find((candidate) => candidate.id === projectId) ?? null;
};

const isVirtualRootEnabled = (
  options: ExecuteWorkspaceToolOptions,
  candidates: ProjectWorkspaceCandidate[],
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
  candidates: ProjectWorkspaceCandidate[],
): string | null => {
  const explicit = sanitizePathInput(
    toString(args.project_id) || toString(args.projectId),
  );
  if (!explicit) return null;
  const normalizedExplicit = explicit.toLowerCase();
  const match = candidates.find(
    (candidate) =>
      candidate.id === explicit ||
      getProjectAliases(candidate).includes(normalizedExplicit),
  );
  return match?.id ?? null;
};

const isRootPathInput = (value: string): boolean => {
  const normalized = value.trim().replace(/\\/g, "/");
  return !normalized || normalized === "." || normalized === "./";
};

const toVirtualPath = (
  candidate: ProjectWorkspaceCandidate,
  inputPath: string | null | undefined,
): string => {
  const normalized = sanitizePathInput(toString(inputPath) || ".").replace(
    /\\/g,
    "/",
  );
  if (isRootPathInput(normalized)) {
    return candidate.mountName;
  }

  return `${candidate.mountName}/${normalized.replace(/^\.\//, "")}`;
};

const getVirtualRootEntries = (candidates: ProjectWorkspaceCandidate[]) =>
  candidates.map((candidate) => ({
    path: candidate.mountName,
    relative_path: candidate.mountName,
    name: candidate.mountName,
    kind: "directory",
    is_hidden: false,
    is_readonly: candidate.isReadOnly,
  }));

const formatResolvedWorkspacePath = (
  candidate: ProjectWorkspaceCandidate | null,
  relativePath: string,
  _mode: AppMode,
): { virtualPath: string; realPath: string | null } => {
  if (!candidate) {
    return {
      virtualPath: sanitizePathInput(relativePath || "."),
      realPath: null,
    };
  }

  return {
    virtualPath: toVirtualPath(candidate, relativePath),
    realPath: null,
  };
};

const normalizeDirEntryForVirtualRoot = (
  entry: tauriIpc.FsDirEntryDto,
  candidate: ProjectWorkspaceCandidate,
  _mode: AppMode,
): tauriIpc.FsDirEntryDto => {
  const virtualPath = toVirtualPath(candidate, entry.relative_path || ".");
  const nextEntry: tauriIpc.FsDirEntryDto = {
    ...entry,
    path: virtualPath,
    relative_path: virtualPath,
    name: entry.name,
    is_readonly: entry.is_readonly || candidate.isReadOnly,
  };
  return nextEntry;
};

const isMutatingWorkspaceTool = (toolName: string): boolean =>
  toolName === "write" ||
  toolName === "edit" ||
  toolName === "delete" ||
  toolName === "apply_patch" ||
  gitMutatingToolIds.has(toolName) ||
  toolName === "terminal_create_session";

const getFirstActionableCandidate = (
  candidates: ProjectWorkspaceCandidate[],
  preferredIds: Array<string | null | undefined>,
): ProjectWorkspaceCandidate | null => {
  for (const preferredId of preferredIds) {
    const preferred = getProjectWorkspaceCandidate(preferredId, candidates);
    if (preferred && !preferred.isReadOnly) {
      return preferred;
    }
  }
  return candidates.find((candidate) => !candidate.isReadOnly) || null;
};

const hasExplicitProjectTarget = (
  toolName: string,
  args: ToolArgs,
  candidates: ProjectWorkspaceCandidate[],
): boolean => {
  if (getExplicitToolProjectId(args, candidates)) {
    return true;
  }

  const rawPath = sanitizePathInput(
    isGitTool(toolName) ? toString(args.repo_path) : toString(args.path),
  );
  if (!rawPath) {
    return false;
  }

  if (!isAbsolutePath(rawPath)) {
    return Boolean(stripProjectAliasPrefix(rawPath, candidates));
  }

  return Boolean(findProjectByAbsolutePath(rawPath, candidates));
};

const resolveExplicitProjectTargetId = (
  rawPath: string,
  args: ToolArgs,
  candidates: ProjectWorkspaceCandidate[],
): string | null => {
  const explicitProjectId = getExplicitToolProjectId(args, candidates);
  if (explicitProjectId) {
    return explicitProjectId;
  }

  if (rawPath && !isAbsolutePath(rawPath)) {
    const prefixedMatch = stripProjectAliasPrefix(rawPath, candidates);
    if (prefixedMatch) {
      return prefixedMatch.projectId;
    }
  }

  if (rawPath && isAbsolutePath(rawPath)) {
    return findProjectByAbsolutePath(rawPath, candidates)?.id ?? null;
  }

  return null;
};

export const resolveExplicitMutatingToolProjectTargets = (
  toolName: string,
  args: ToolArgs,
  options: ExecuteWorkspaceToolOptions,
): string[] => {
  if (!isMutatingWorkspaceTool(toolName)) {
    return [];
  }

  const candidates = getProjectWorkspaceCandidates(options);
  const addProjectId = (projectIds: Set<string>, projectId?: string | null) => {
    const trimmed = typeof projectId === "string" ? projectId.trim() : "";
    if (trimmed) {
      projectIds.add(trimmed);
    }
  };

  if (toolName === "terminal_create_session") {
    const explicitProjectId = getExplicitToolProjectId(args, candidates);
    return explicitProjectId ? [explicitProjectId] : [];
  }

  if (toolName === "apply_patch") {
    const patchText = toString(args.patch_text);
    if (!patchText) {
      return [];
    }

    const projectIds = new Set<string>();
    try {
      for (const operation of parseApplyPatch(patchText)) {
        addProjectId(
          projectIds,
          resolveExplicitProjectTargetId(operation.path, args, candidates),
        );
      }
    } catch {
      return [];
    }
    return Array.from(projectIds);
  }

  const rawPath = sanitizePathInput(
    isGitTool(toolName) ? toString(args.repo_path) : toString(args.path),
  );
  const projectId = resolveExplicitProjectTargetId(rawPath, args, candidates);
  return projectId ? [projectId] : [];
};

const buildReadOnlyToolError = (
  toolName: string,
  candidate: ProjectWorkspaceCandidate,
): string => {
  const label = candidate.name || candidate.mountName || candidate.id;
  if (toolName === "terminal_create_session") {
    return `Error executing terminal_create_session: subproject "${label}" is read-only.`;
  }
  if (
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "delete" ||
    toolName === "apply_patch"
  ) {
    return `Error executing ${toolName}: subproject "${label}" is read-only.`;
  }
  if (gitMutatingToolIds.has(toolName)) {
    return `Error executing ${toolName}: subproject "${label}" is read-only.`;
  }
  return `Subproject "${label}" is read-only.`;
};

const resolveMutatingVirtualTarget = async (params: {
  toolName: string;
  rawPath: string;
  args: ToolArgs;
  candidates: ProjectWorkspaceCandidate[];
  focusedProjectId?: string | null;
  defaultProjectId?: string | null;
}): Promise<{
  target: Awaited<ReturnType<typeof resolveVirtualToolTarget>>;
  error: string | null;
}> => {
  const target = await resolveVirtualToolTarget(params);
  if (
    !isMutatingWorkspaceTool(params.toolName) ||
    !target.candidate?.isReadOnly
  ) {
    return { target, error: null };
  }

  if (target.explicitTarget) {
    return {
      target,
      error: buildReadOnlyToolError(params.toolName, target.candidate),
    };
  }

  const fallbackCandidate = getFirstActionableCandidate(params.candidates, [
    params.focusedProjectId,
    params.defaultProjectId,
  ]);
  if (!fallbackCandidate) {
    return {
      target,
      error: buildReadOnlyToolError(params.toolName, target.candidate),
    };
  }

  return {
    target: {
      candidate: fallbackCandidate,
      relativePath:
        params.toolName === "write" ||
        params.toolName === "edit" ||
        params.toolName === "delete" ||
        params.toolName === "apply_patch"
          ? params.rawPath || "."
          : ".",
      explicitTarget: false,
      usedFocusedProject: false,
      matchCount: 1,
    },
    error: null,
  };
};

export const resolveToolWorkspaceRouting = (
  toolName: string,
  args: ToolArgs,
  options: ExecuteWorkspaceToolOptions,
): {
  projectId: string | null;
  workspacePath: string | null;
  args: ToolArgs;
} => {
  const candidates = getProjectWorkspaceCandidates(options);
  const strippedArgs = stripProjectSelectionArgs(args);
  const rawPath =
    sanitizePathInput(
      isGitTool(toolName) ? toString(args.repo_path) : toString(args.path),
    ) || "";
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
      if (
        prefixedMatch &&
        (!projectId || projectId === prefixedMatch.projectId)
      ) {
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
  const pathKey = isGitTool(toolName) ? "repo_path" : "path";
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
  /^(?:[a-zA-Z]:\/|\/)/.test(value.replace(/\\/g, "/"));

const resolvePathForMode = (inputPath: string, _mode: AppMode): string =>
  inputPath;

const joinPathWithinWorkspace = (
  workspacePath: string,
  inputPath: string,
): string => {
  const normalizedInput = (inputPath || ".").replace(/\\/g, "/");
  if (isAbsolutePath(normalizedInput)) {
    return normalizedInput;
  }

  if (normalizedInput === "." || normalizedInput === "") {
    return workspacePath;
  }

  if (workspacePath === ".") {
    return normalizedInput.replace(/^\.\//, "");
  }

  return `${workspacePath}/${normalizedInput.replace(/^\.\//, "")}`;
};

const resolveBackendPath = (
  inputPath: string,
  mode: AppMode,
  workspacePath?: string | null,
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
  workspacePath?: string | null,
): string => {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (normalizedWorkspacePath && !isMacroScopedPath(inputPath)) {
    return joinPathWithinWorkspace(normalizedWorkspacePath, inputPath);
  }

  return resolvePathForMode(inputPath, mode);
};

export const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
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
  workspacePath?: string | null,
) => {
  const entries = await tauriIpc.fsListDir({
    path: resolveDirectPath(".", mode, workspacePath),
    recursive: true,
    includeHidden,
    allowOutsideWorkspace: Boolean(normalizeWorkspacePath(workspacePath)),
  });
  return entries.filter((entry) => entry.kind === "file");
};

const resolveGitRepoPath = (
  args: ToolArgs,
  mode: AppMode,
  workspacePath?: string | null,
): string => {
  const explicitRepoPath = sanitizePathInput(toString(args.repo_path));
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (explicitRepoPath) {
    return normalizedWorkspacePath
      ? joinPathWithinWorkspace(normalizedWorkspacePath, explicitRepoPath)
      : resolvePathForMode(explicitRepoPath, mode);
  }

  return normalizedWorkspacePath || resolvePathForMode(".", mode);
};

const shouldFallbackRepoPath = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const maybe = error as Record<string, unknown>;
  const code = typeof maybe.code === "string" ? maybe.code : "";
  const message =
    typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  return (
    code === "FilesystemNotFound" ||
    code === "GitRepositoryNotFound" ||
    code === "InvalidPath" ||
    code === "FilesystemPathOutsideWorkspace" ||
    message.includes("outside the workspace")
  );
};

const runGitWithRepoFallback = async <T>(
  primaryRepoPath: string,
  execute: (repoPath: string) => Promise<T>,
  allowFallbackToDot: boolean,
): Promise<{ value: T; repoPath: string }> => {
  const candidates = allowFallbackToDot
    ? Array.from(new Set([primaryRepoPath, "."].filter(Boolean)))
    : [primaryRepoPath];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const value = await execute(candidate);
      return { value, repoPath: candidate };
    } catch (error) {
      lastError = error;
      if (
        !shouldFallbackRepoPath(error) ||
        candidate === candidates[candidates.length - 1]
      ) {
        throw error;
      }
    }
  }

  throw lastError;
};

const canCheckWorkspaceEntries = (): boolean => tauriIpc.isTauriAvailable();

const workspaceEntryExists = async (
  candidate: ProjectWorkspaceCandidate,
  relativePath: string,
): Promise<boolean> => {
  if (!candidate.workspacePath || !canCheckWorkspaceEntries()) {
    return false;
  }

  try {
    return await tauriIpc.fsExists(
      joinPathWithinWorkspace(candidate.workspacePath, relativePath),
      {
        workspacePath: candidate.workspacePath,
      },
    );
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
  const explicitProjectId = getExplicitToolProjectId(
    params.args,
    params.candidates,
  );
  const prefixedMatch =
    params.rawPath && !isAbsolutePath(params.rawPath)
      ? stripProjectAliasPrefix(params.rawPath, params.candidates)
      : null;

  if (explicitProjectId) {
    return {
      candidate: getProjectWorkspaceCandidate(
        explicitProjectId,
        params.candidates,
      ),
      relativePath:
        prefixedMatch && prefixedMatch.projectId === explicitProjectId
          ? prefixedMatch.path
          : params.rawPath || ".",
      explicitTarget: true,
      usedFocusedProject: false,
      matchCount: explicitProjectId ? 1 : 0,
    };
  }

  if (prefixedMatch) {
    return {
      candidate: getProjectWorkspaceCandidate(
        prefixedMatch.projectId,
        params.candidates,
      ),
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
          params.rawPath
            .replace(/\\/g, "/")
            .slice((match.workspacePath || "").length)
            .replace(/^\/+/, "") || ".",
        explicitTarget: true,
        usedFocusedProject: false,
        matchCount: 1,
      };
    }
  }

  const focusedCandidate =
    getProjectWorkspaceCandidate(params.focusedProjectId, params.candidates) ||
    getProjectWorkspaceCandidate(params.defaultProjectId, params.candidates);

  if (
    params.toolName === "write" ||
    params.toolName === "edit" ||
    params.toolName === "delete"
  ) {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || ".",
      explicitTarget: false,
      usedFocusedProject: Boolean(focusedCandidate),
      matchCount: focusedCandidate ? 1 : 0,
    };
  }

  if (gitBackendToolIds.has(params.toolName)) {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || ".",
      explicitTarget: false,
      usedFocusedProject: Boolean(focusedCandidate),
      matchCount: focusedCandidate ? 1 : 0,
    };
  }

  if (
    focusedCandidate &&
    (isRootPathInput(params.rawPath) ||
      (await workspaceEntryExists(focusedCandidate, params.rawPath)))
  ) {
    return {
      candidate: focusedCandidate,
      relativePath: params.rawPath || ".",
      explicitTarget: false,
      usedFocusedProject: Boolean(
        params.rawPath && !isRootPathInput(params.rawPath),
      ),
      matchCount: 1,
    };
  }

  if (!params.rawPath || isRootPathInput(params.rawPath)) {
    return {
      candidate: focusedCandidate,
      relativePath: ".",
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
  options: ExecuteWorkspaceToolOptions = {},
): Promise<string | undefined> => {
  const useTauri = tauriIpc.isTauriAvailable();
  const useRemoteKernel = !useTauri && canUseRemoteKernel();
  const candidates = getProjectWorkspaceCandidates(options);
  const virtualRootCandidate = isVirtualRootEnabled(options, candidates);
  const focusedProjectId =
    options.focusedProjectId || options.projectId || null;
  const rawArgs = { ...args };
  const routing = resolveToolWorkspaceRouting(toolName, args, options);
  args = routing.args;
  let effectiveProjectId = routing.projectId;
  let effectiveWorkspacePath =
    normalizeWorkspacePath(routing.workspacePath) ||
    normalizeWorkspacePath(options.defaultWorkspacePath) ||
    normalizeWorkspacePath(options.workspacePath) ||
    normalizeWorkspacePath(getSelectedProjectRoot());
  const explicitProjectTarget = hasExplicitProjectTarget(
    toolName,
    rawArgs,
    candidates,
  );

  if (!virtualRootCandidate && isMutatingWorkspaceTool(toolName)) {
    const routedCandidate = getProjectWorkspaceCandidate(
      effectiveProjectId,
      candidates,
    );
    if (routedCandidate?.isReadOnly) {
      if (explicitProjectTarget) {
        return buildReadOnlyToolError(toolName, routedCandidate);
      }

      const fallbackCandidate = getFirstActionableCandidate(candidates, [
        focusedProjectId,
        options.projectId,
        routing.projectId,
      ]);
      if (!fallbackCandidate) {
        return buildReadOnlyToolError(toolName, routedCandidate);
      }

      effectiveProjectId = fallbackCandidate.id;
      effectiveWorkspacePath =
        normalizeWorkspacePath(fallbackCandidate.workspacePath) ||
        effectiveWorkspacePath;
    }
  }

  if (!useTauri && !useRemoteKernel) {
    return "Workspace tools require Tauri runtime.";
  }

  const useMetadataWorkspace =
    mode === "Architect" &&
    (toolName === "write" ||
      toolName === "edit" ||
      toolName === "delete" ||
      toolName === "apply_patch");
  const virtualRootEnabled = virtualRootCandidate && !useMetadataWorkspace;

  const executeBackendTool = async (
    backendToolName: string,
    backendArgs: ToolArgs,
  ): Promise<string> => {
    if (useTauri) {
      return tauriIpc.executeWorkspaceTool({
        mode,
        toolId: backendToolName,
        args: backendArgs,
        workspacePath: effectiveWorkspacePath,
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
        projectMounts: options.projectMounts,
        virtualRootEnabled,
        focusedProjectId,
      });
    }

    return executeRemoteWorkspaceTool({
      mode,
      toolId: backendToolName,
      args: backendArgs,
      workspacePath: effectiveWorkspacePath,
      workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      projectMounts: options.projectMounts,
      virtualRootEnabled,
      focusedProjectId,
    });
  };

  const validateBackendTool = async (
    backendToolName: string,
    path?: string,
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
    const workspaceToolIds = new Set([
      "list",
      "read",
      "write",
      "edit",
      "delete",
      "apply_patch",
      "glob",
      "grep",
    ]);
    if (workspaceToolIds.has(toolName)) {
      try {
        const backendResult = await executeBackendTool(toolName, args);

        if (backendResult && backendResult !== "UNSUPPORTED_WORKSPACE_TOOL") {
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
      const shouldUseBackendFirst = true;

      if (shouldUseBackendFirst) {
        const backendArgs: ToolArgs = {
          ...args,
          repo_path: explicitRepoPath || ".",
        };

        try {
          const backendResult = await executeBackendTool(toolName, backendArgs);

          if (backendResult && backendResult !== "UNSUPPORTED_WORKSPACE_TOOL") {
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
      ? useMetadataWorkspace
        ? candidatePathInput
        : resolveBackendPath(candidatePathInput, mode, effectiveWorkspacePath)
      : undefined;

    try {
      const validation = await validateBackendTool(
        toolName,
        resolvedCandidatePath,
      );

      if (!validation.allowed) {
        return (
          validation.reason ||
          `Tool ${toolName} is not allowed in mode ${mode}.`
        );
      }
    } catch (validationError) {
      if (!isUnknownCommandError(validationError)) {
        throw validationError;
      }

      if (
        (toolName === "write" ||
          toolName === "edit" ||
          toolName === "delete" ||
          toolName === "apply_patch") &&
        resolvedCandidatePath
      ) {
        assertPathAllowed(mode, resolvedCandidatePath);
      }
    }

    if (virtualRootEnabled) {
      if (!useTauri) {
        return "Virtual multi-project workspace tools require Tauri runtime.";
      }

      const explicitProjectId = getExplicitToolProjectId(rawArgs, candidates);
      const rawFsPath = sanitizePathInput(toString(rawArgs.path) || ".");
      const rawGitPath = sanitizePathInput(toString(rawArgs.repo_path) || ".");
      const prefixedFsPath =
        rawFsPath && !isAbsolutePath(rawFsPath)
          ? stripProjectAliasPrefix(rawFsPath, candidates)
          : null;

      if (toolName === "list") {
        if (
          isRootPathInput(rawFsPath) &&
          !explicitProjectId &&
          !prefixedFsPath
        ) {
          const entries = getVirtualRootEntries(candidates);
          return JSON.stringify(
            { path: ".", virtual_root: true, count: entries.length, entries },
            null,
            2,
          );
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
          typeof rawArgs.max_depth === "number"
            ? Math.max(1, Math.floor(rawArgs.max_depth))
            : undefined;
        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        const entries = await tauriIpc.fsListDir({
          path: joinPathWithinWorkspace(
            target.candidate.workspacePath,
            target.relativePath,
          ),
          recursive,
          includeHidden,
          maxDepth,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        const normalizedEntries = entries.map((entry) =>
          normalizeDirEntryForVirtualRoot(entry, target.candidate!, mode),
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
          2,
        );
      }

      if (toolName === "read") {
        if (!rawFsPath) return "Missing path argument for read tool.";

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

        const path = joinPathWithinWorkspace(
          target.candidate.workspacePath,
          target.relativePath,
        );
        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        const result = await tauriIpc.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });

        if (result.is_binary) {
          return `File ${resolved.virtualPath} is binary (${result.size} bytes, encoding=${result.encoding}).`;
        }

        const startLine =
          typeof rawArgs.start_line === "number"
            ? Math.max(1, Math.floor(rawArgs.start_line))
            : 1;
        const endLine =
          typeof rawArgs.end_line === "number"
            ? Math.max(startLine, Math.floor(rawArgs.end_line))
            : undefined;

        const lines = result.content.split("\n");
        const selected = lines.slice(
          startLine - 1,
          endLine ? endLine : undefined,
        );
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

        return `FILE: ${resolved.virtualPath}\nSOURCE: WORKSPACE_FILE\n${notices.join("\n")}\nLANGUAGE: ${result.language}\nSIZE: ${result.size}\nLINES: ${startLine}-${effectiveEndLine}\n\n---BEGIN FILE CONTENT---\n${numberedContent}\n---END FILE CONTENT---`;
      }

      if (toolName === "write") {
        const inputPath = sanitizePathInput(toString(rawArgs.path));
        const content = toString(rawArgs.content);
        if (!inputPath) return "Missing path argument for write tool.";

        const { target, error } = await resolveMutatingVirtualTarget({
          toolName,
          rawPath: inputPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });
        if (error) {
          return error;
        }

        if (!target.candidate?.workspacePath) {
          return "Error executing write: select a subproject with project_id or a mount-prefixed path before writing.";
        }

        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        assertPathAllowed(mode, resolved.virtualPath);
        const realPath = joinPathWithinWorkspace(
          target.candidate.workspacePath,
          target.relativePath,
        );
        const writeResult = await tauriIpc.fsWriteFile({
          path: realPath,
          content,
          createDirs: rawArgs.create_dirs !== false,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        const readback = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        return buildStructuredWriteResponse({
          path: resolved.virtualPath,
          status: writeResult.created ? "created" : "updated",
          additions: countLogicalLines(content),
          deletions: 0,
          created: writeResult.created,
          bytesWritten: writeResult.bytes_written,
          validation: {
            path: resolved.virtualPath,
            exists: true,
            readable: true,
            is_binary: readback.is_binary,
            size: readback.size,
            encoding: readback.encoding,
            language: readback.language,
          },
          projectId: target.candidate.id,
          mountName: target.candidate.mountName,
          realPath: resolved.realPath,
          rawPath: resolved.virtualPath,
        });
      }

      if (toolName === "edit") {
        const inputPath = sanitizePathInput(toString(rawArgs.path));
        const oldText = toString(rawArgs.old_text);
        const newText = toString(rawArgs.new_text);
        const replaceAll = rawArgs.replace_all === true;

        if (!inputPath) return "Missing path argument for edit tool.";
        if (!oldText) return "Missing old_text argument for edit tool.";

        const { target, error } = await resolveMutatingVirtualTarget({
          toolName,
          rawPath: inputPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });
        if (error) {
          return error;
        }

        if (!target.candidate?.workspacePath) {
          return "Error executing edit: select a subproject with project_id or a mount-prefixed path before editing.";
        }

        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        assertPathAllowed(mode, resolved.virtualPath);
        const realPath = joinPathWithinWorkspace(
          target.candidate.workspacePath,
          target.relativePath,
        );
        const current = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        if (current.is_binary) {
          return `Cannot edit binary file: ${resolved.virtualPath}`;
        }

        const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const occurrences = (
          current.content.match(new RegExp(escapedOld, "g")) || []
        ).length;
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
        const readback = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        const stats = computeLineChangeStats(current.content, updated);
        return buildStructuredWriteResponse({
          path: resolved.virtualPath,
          status: "updated",
          additions: stats.additions,
          deletions: stats.deletions,
          created: false,
          bytesWritten: updated.length,
          validation: {
            path: resolved.virtualPath,
            exists: true,
            readable: true,
            is_binary: readback.is_binary,
            size: readback.size,
            encoding: readback.encoding,
            language: readback.language,
          },
          replacements: replaceAll ? occurrences : 1,
          projectId: target.candidate.id,
          mountName: target.candidate.mountName,
          realPath: resolved.realPath,
          rawPath: resolved.virtualPath,
        });
      }

      if (toolName === "delete") {
        const inputPath = sanitizePathInput(toString(rawArgs.path));

        if (!inputPath) return "Missing path argument for delete tool.";

        const { target, error } = await resolveMutatingVirtualTarget({
          toolName,
          rawPath: inputPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });
        if (error) {
          return error;
        }

        if (!target.candidate?.workspacePath) {
          return "Error executing delete: select a subproject with project_id or a mount-prefixed path before deleting.";
        }

        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        assertPathAllowed(mode, resolved.virtualPath);
        const realPath = joinPathWithinWorkspace(
          target.candidate.workspacePath,
          target.relativePath,
        );
        const targetStats = await tauriIpc.fsStat(realPath, {
          workspacePath: target.candidate.workspacePath,
        });
        if (targetStats.kind !== "file") {
          return `Cannot delete directory with delete tool: ${resolved.virtualPath}. Only files are supported.`;
        }

        const current = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace: true,
          workspacePath: target.candidate.workspacePath,
        });
        const deletions = current.is_binary
          ? 0
          : countLogicalLines(current.content);

        await tauriIpc.fsDelete({
          path: realPath,
          workspacePath: target.candidate.workspacePath,
        });

        return buildStructuredWriteResponse({
          path: resolved.virtualPath,
          status: "deleted",
          additions: 0,
          deletions,
          created: false,
          bytesWritten: 0,
          validation: {
            path: resolved.virtualPath,
            exists: false,
            readable: false,
            is_binary: false,
            size: 0,
            encoding: null,
            language: null,
          },
          projectId: target.candidate.id,
          mountName: target.candidate.mountName,
          realPath: resolved.realPath,
          rawPath: resolved.virtualPath,
        });
      }

      if (toolName === "apply_patch") {
        const patchText = toString(rawArgs.patch_text);
        if (!patchText)
          return "Missing patch_text argument for apply_patch tool.";

        let operations: ParsedPatchOperation[];
        try {
          operations = parseApplyPatch(patchText);
        } catch (error) {
          return formatToolError(error);
        }

        const pendingChanges: Array<{
          target: PatchTarget;
          status: "created" | "updated" | "deleted";
          newContent: string | null;
          created: boolean;
          bytesWritten: number;
          additions: number;
          deletions: number;
        }> = [];

        for (const operation of operations) {
          const { target, error } = await resolveMutatingVirtualTarget({
            toolName,
            rawPath: operation.path,
            args: rawArgs,
            candidates,
            focusedProjectId,
            defaultProjectId: options.projectId,
          });
          if (error) {
            return error;
          }
          if (!target.candidate?.workspacePath) {
            return "Error executing apply_patch: select a subproject with project_id or mount-prefixed paths before patching.";
          }

          const resolved = formatResolvedWorkspacePath(
            target.candidate,
            target.relativePath,
            mode,
          );
          assertPathAllowed(mode, resolved.virtualPath);
          const patchTarget: PatchTarget = {
            candidate: target.candidate,
            relativePath: target.relativePath,
            displayPath: resolved.virtualPath,
            realPath: joinPathWithinWorkspace(
              target.candidate.workspacePath,
              target.relativePath,
            ),
          };

          if (operation.kind === "add") {
            const newContent = joinTextLines(operation.lines, true);
            const alreadyExists = await tauriIpc.fsExists(
              patchTarget.realPath,
              {
                workspacePath: patchTarget.candidate.workspacePath,
              },
            );
            if (alreadyExists) {
              return `Cannot add file ${patchTarget.displayPath} because it already exists.`;
            }
            pendingChanges.push({
              target: patchTarget,
              status: "created",
              newContent,
              created: true,
              bytesWritten: newContent.length,
              additions: countLogicalLines(newContent),
              deletions: 0,
            });
            continue;
          }

          const current = await tauriIpc.fsReadFileWithOptions({
            path: patchTarget.realPath,
            allowOutsideWorkspace: true,
            workspacePath: patchTarget.candidate.workspacePath,
          });

          if (operation.kind === "delete") {
            pendingChanges.push({
              target: patchTarget,
              status: "deleted",
              newContent: null,
              created: false,
              bytesWritten: 0,
              additions: 0,
              deletions: countLogicalLines(current.content),
            });
            continue;
          }

          if (current.is_binary) {
            return `Cannot apply patch to binary file: ${patchTarget.displayPath}`;
          }

          let newContent: string;
          try {
            newContent = applyPatchHunksToContent(
              patchTarget.displayPath,
              current.content,
              operation.hunks,
            );
          } catch (error) {
            return formatToolError(error);
          }

          const stats = computeLineChangeStats(current.content, newContent);
          pendingChanges.push({
            target: patchTarget,
            status: "updated",
            newContent,
            created: false,
            bytesWritten: newContent.length,
            additions: stats.additions,
            deletions: stats.deletions,
          });
        }

        await commitPatchWriteChangesWithRollback(
          pendingChanges.map((change) => ({
            displayPath: change.target.displayPath,
            realPath: change.target.realPath,
            newContent: change.newContent,
            existsOptions: {
              workspacePath: change.target.candidate.workspacePath,
            },
            readOptions: {
              allowOutsideWorkspace: true,
              workspacePath: change.target.candidate.workspacePath,
            },
            writeOptions: {
              allowOutsideWorkspace: true,
              workspacePath: change.target.candidate.workspacePath,
            },
            deleteOptions: {
              workspacePath: change.target.candidate.workspacePath,
            },
          })),
        );

        const files: PatchChangeRecord[] = [];
        const validationFiles: PatchValidationRecord[] = [];
        const errors: string[] = [];

        for (const change of pendingChanges) {
          let validation: PatchValidationRecord;
          if (change.newContent === null) {
            validation = {
              path: change.target.displayPath,
              exists: false,
              readable: false,
              is_binary: false,
              size: 0,
              encoding: null,
              language: null,
            };
          } else {
            try {
              const readback = await tauriIpc.fsReadFileWithOptions({
                path: change.target.realPath,
                allowOutsideWorkspace: true,
                workspacePath: change.target.candidate.workspacePath,
              });
              validation = {
                path: change.target.displayPath,
                exists: true,
                readable: true,
                is_binary: readback.is_binary,
                size: readback.size,
                encoding: readback.encoding,
                language: readback.language,
              };
            } catch (error) {
              errors.push(
                `Validation failed for ${change.target.displayPath}: ${formatToolError(error)}`,
              );
              validation = {
                path: change.target.displayPath,
                exists: true,
                readable: false,
                is_binary: false,
                size: 0,
                encoding: null,
                language: null,
              };
            }
          }
          validationFiles.push(validation);
        files.push({
          path: change.target.displayPath,
          status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            created: change.created,
            bytes_written: change.bytesWritten,
          validation,
          project_id: change.target.candidate.id,
          mount_name: change.target.candidate.mountName,
        });
      }

        return JSON.stringify(
          {
            ok: errors.length === 0,
            files,
            diff: buildApplyPatchDiff(files),
            diagnostics: [],
            validation: {
              all_files_readable: errors.length === 0,
              files: validationFiles,
            },
            errors,
            applied_operations: pendingChanges.length,
          },
          null,
          2,
        );
      }

      if (toolName === "glob") {
        const pattern = toString(rawArgs.pattern) || "**/*";
        const includeHidden = rawArgs.include_hidden === true;
        const matches = new Set<string>();

        for (const candidate of candidates) {
          if (!candidate.workspacePath) continue;
          const files = await readAllCandidateFiles(
            includeHidden,
            mode,
            candidate.workspacePath,
          );
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
          {
            pattern,
            virtual_root: true,
            count: matches.size,
            paths: Array.from(matches),
          },
          null,
          2,
        );
      }

      if (toolName === "grep") {
        const query = toString(rawArgs.query);
        if (!query) return "Missing query argument for grep tool.";

        const includeHidden = rawArgs.include_hidden === true;
        const isRegexp = rawArgs.is_regexp === true;
        const includePattern = toString(rawArgs.include_pattern);
        const maxResults =
          typeof rawArgs.max_results === "number"
            ? Math.max(1, Math.floor(rawArgs.max_results))
            : 50;

        let matcher: RegExp | null = null;
        if (isRegexp) {
          try {
            matcher = new RegExp(query, "i");
          } catch {
            return `Invalid regex pattern for grep: ${query}`;
          }
        }

        const results: Array<{
          path: string;
          line: number;
          text: string;
          project_id: string;
          mount_name: string;
        }> = [];

        for (const candidate of candidates) {
          if (!candidate.workspacePath) continue;
          const files = await readAllCandidateFiles(
            includeHidden,
            mode,
            candidate.workspacePath,
          );

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
              path: joinPathWithinWorkspace(
                candidate.workspacePath,
                file.relative_path,
              ),
              allowOutsideWorkspace: true,
              workspacePath: candidate.workspacePath,
            });
            if (content.is_binary) continue;

            const lines = content.content.split("\n");
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
                  return JSON.stringify(
                    { query, total: results.length, results },
                    null,
                    2,
                  );
                }
              }
            }
          }
        }

        return JSON.stringify(
          { query, total: results.length, results },
          null,
          2,
        );
      }

      if (isGitTool(toolName)) {
        const { target, error } = await resolveMutatingVirtualTarget({
          toolName,
          rawPath: rawGitPath,
          args: rawArgs,
          candidates,
          focusedProjectId,
          defaultProjectId: options.projectId,
        });
        if (error) {
          return error;
        }

        if (!target.candidate?.workspacePath) {
          return "Error executing git tool: select a subproject with project_id or a mount-prefixed repo_path before running git commands.";
        }

        const resolved = formatResolvedWorkspacePath(
          target.candidate,
          target.relativePath,
          mode,
        );
        const repoPath = joinPathWithinWorkspace(
          target.candidate.workspacePath,
          target.relativePath,
        );
        const allowRepoFallback = false;
        let effectiveRepoPath = repoPath;
        const repoMeta = {
          project_id: target.candidate.id,
          mount_name: target.candidate.mountName,
          repo_path: resolved.virtualPath,
          ...(resolved.realPath ? { real_repo_path: resolved.realPath } : {}),
        };

        if (toolName === "git_status") {
          const { value: status } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
          );
          return JSON.stringify({ ...repoMeta, ...status }, null, 2);
        }

        if (toolName === "git_log") {
          const limit =
            typeof rawArgs.limit === "number"
              ? Math.max(1, Math.floor(rawArgs.limit))
              : undefined;
          const branch = toString(rawArgs.branch) || undefined;
          const { value: commits } = await runGitWithRepoFallback(
            repoPath,
            (candidate) =>
              tauriIpc.gitLog({ repoPath: candidate, limit, branch }),
            allowRepoFallback,
          );
          return JSON.stringify(
            { ...repoMeta, count: commits.length, commits },
            null,
            2,
          );
        }

        if (toolName === "git_branch_list") {
          const { value: branches } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitBranchList(candidate),
            allowRepoFallback,
          );
          return JSON.stringify({ ...repoMeta, ...branches }, null, 2);
        }

        if (toolName === "git_diff") {
          const base = toString(rawArgs.base) || undefined;
          const head = toString(rawArgs.head) || undefined;
          const contextLines =
            typeof rawArgs.context_lines === "number"
              ? Math.max(0, Math.floor(rawArgs.context_lines))
              : undefined;
          const ignoreWhitespace = rawArgs.ignore_whitespace === true;
          const paths = Array.isArray(rawArgs.paths)
            ? rawArgs.paths.filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0,
              )
            : undefined;
          const { value: patch } = await runGitWithRepoFallback(
            repoPath,
            (candidate) =>
              tauriIpc.gitDiff({
                repoPath: candidate,
                base,
                head,
                contextLines,
                ignoreWhitespace,
                paths,
              }),
            allowRepoFallback,
          );
          const header = [
            `REPO: ${repoMeta.repo_path}`,
            `PROJECT_ID: ${repoMeta.project_id}`,
            `MOUNT: ${repoMeta.mount_name}`,
            ...(repoMeta.real_repo_path
              ? [`REAL_REPO_PATH: ${repoMeta.real_repo_path}`]
              : []),
          ].join("\n");
          return `${header}\n\n${patch || ""}`;
        }

        if (toolName === "git_get_tree") {
          const branch = toString(rawArgs.branch) || undefined;
          const { value: tree } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitGetTree({ repoPath: candidate, branch }),
            allowRepoFallback,
          );
          return JSON.stringify({ ...repoMeta, ...tree }, null, 2);
        }

        if (toolName === "git_add") {
          const paths = Array.isArray(rawArgs.paths)
            ? rawArgs.paths.filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0,
              )
            : ["."];
          await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitAdd({ repoPath: candidate, paths });
            },
            allowRepoFallback,
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
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
            2,
          );
        }

        if (toolName === "git_commit") {
          const message = toString(rawArgs.message);
          if (!message) return "Missing message argument for git_commit tool.";

          const { value: before } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitLog({ repoPath: candidate, limit: 1 });
            },
            allowRepoFallback,
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
            allowRepoFallback,
          );

          const { value: after } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitLog({ repoPath: candidate, limit: 1 }),
            allowRepoFallback,
          );
          const headAfter = after[0]?.id ?? null;
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
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
            2,
          );
        }

        if (toolName === "git_checkout") {
          const branchOrCommit =
            toString(rawArgs.branch_or_commit) || toString(rawArgs.branch);
          if (!branchOrCommit)
            return "Missing branch_or_commit argument for git_checkout tool.";

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
            allowRepoFallback,
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
          );
          return JSON.stringify(
            {
              ok: true,
              ...repoMeta,
              branch: status.branch,
              target: branchOrCommit,
            },
            null,
            2,
          );
        }

        if (toolName === "git_merge") {
          const branchName =
            toString(rawArgs.branch_name) || toString(rawArgs.branch);
          const intoBranch = toString(rawArgs.into_branch);
          if (!branchName || !intoBranch) {
            return "Missing branch_name or into_branch argument for git_merge tool.";
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
            allowRepoFallback,
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
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
            2,
          );
        }

        if (toolName === "git_reset") {
          const modeArg = toString(rawArgs.mode);
          if (modeArg !== "soft" && modeArg !== "mixed" && modeArg !== "hard") {
            return "Missing or invalid mode for git_reset. Use one of: soft, mixed, hard.";
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
            allowRepoFallback,
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
          );
          return JSON.stringify(
            { ok: true, ...repoMeta, branch: status.branch },
            null,
            2,
          );
        }

        if (toolName === "git_stash") {
          const message = toString(rawArgs.message) || undefined;
          const { value: stashId } = await runGitWithRepoFallback(
            repoPath,
            (candidate) => {
              effectiveRepoPath = candidate;
              return tauriIpc.gitStash({ repoPath: candidate, message });
            },
            allowRepoFallback,
          );
          const { value: status } = await runGitWithRepoFallback(
            effectiveRepoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
          );
          return JSON.stringify(
            { ok: true, ...repoMeta, branch: status.branch, stash: stashId },
            null,
            2,
          );
        }

        return `Unknown Git tool: ${toolName}`;
      }
    }

    if (isGitTool(toolName)) {
      const allowRepoFallback = false;
      const repoPath = resolveGitRepoPath(args, mode, effectiveWorkspacePath);
      let effectiveRepoPath = repoPath;

      if (toolName === "git_status") {
        const { value: status, repoPath: resolvedRepoPath } =
          await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitStatus(candidate),
            allowRepoFallback,
          );
        return JSON.stringify(
          { repo_path: resolvedRepoPath, ...status },
          null,
          2,
        );
      }

      if (toolName === "git_log") {
        const limit =
          typeof args.limit === "number"
            ? Math.max(1, Math.floor(args.limit))
            : undefined;
        const branch = toString(args.branch) || undefined;
        const { value: commits, repoPath: resolvedRepoPath } =
          await runGitWithRepoFallback(
            repoPath,
            (candidate) =>
              tauriIpc.gitLog({ repoPath: candidate, limit, branch }),
            allowRepoFallback,
          );
        return JSON.stringify(
          { repo_path: resolvedRepoPath, count: commits.length, commits },
          null,
          2,
        );
      }

      if (toolName === "git_branch_list") {
        const { value: branches, repoPath: resolvedRepoPath } =
          await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitBranchList(candidate),
            allowRepoFallback,
          );
        return JSON.stringify(
          { repo_path: resolvedRepoPath, ...branches },
          null,
          2,
        );
      }

      if (toolName === "git_diff") {
        const base = toString(args.base) || undefined;
        const head = toString(args.head) || undefined;
        const contextLines =
          typeof args.context_lines === "number"
            ? Math.max(0, Math.floor(args.context_lines))
            : undefined;
        const ignoreWhitespace = args.ignore_whitespace === true;
        const paths = Array.isArray(args.paths)
          ? args.paths.filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
          : undefined;
        const { value: patch } = await runGitWithRepoFallback(
          repoPath,
          (candidate) =>
            tauriIpc.gitDiff({
              repoPath: candidate,
              base,
              head,
              contextLines,
              ignoreWhitespace,
              paths,
            }),
          allowRepoFallback,
        );
        return patch || "";
      }

      if (toolName === "git_get_tree") {
        const branch = toString(args.branch) || undefined;
        const { value: tree, repoPath: resolvedRepoPath } =
          await runGitWithRepoFallback(
            repoPath,
            (candidate) => tauriIpc.gitGetTree({ repoPath: candidate, branch }),
            allowRepoFallback,
          );
        return JSON.stringify(
          { repo_path: resolvedRepoPath, ...tree },
          null,
          2,
        );
      }

      if (toolName === "git_add") {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
          : ["."];
        await runGitWithRepoFallback(
          repoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitAdd({ repoPath: candidate, paths });
          },
          allowRepoFallback,
        );
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
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
          2,
        );
      }

      if (toolName === "git_commit") {
        const message = toString(args.message);
        if (!message) return "Missing message argument for git_commit tool.";

        const { value: before } = await runGitWithRepoFallback(
          repoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitLog({ repoPath: candidate, limit: 1 });
          },
          allowRepoFallback,
        );
        const headBefore = before[0]?.id ?? null;

        const { value: hash } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitCommit({
              repoPath: candidate,
              message,
              stageAll: args.stage_all !== false,
            });
          },
          allowRepoFallback,
        );

        const { value: after } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitLog({ repoPath: candidate, limit: 1 }),
          allowRepoFallback,
        );
        const headAfter = after[0]?.id ?? null;
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
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
          2,
        );
      }

      if (toolName === "git_checkout") {
        const branchOrCommit =
          toString(args.branch_or_commit) || toString(args.branch);
        if (!branchOrCommit)
          return "Missing branch_or_commit argument for git_checkout tool.";

        await runGitWithRepoFallback(
          repoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitCheckout({
              repoPath: candidate,
              branchOrCommit,
              create: args.create === true,
            });
          },
          allowRepoFallback,
        );
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
        );
        return JSON.stringify(
          {
            ok: true,
            repo_path: effectiveRepoPath,
            branch: status.branch,
            target: branchOrCommit,
          },
          null,
          2,
        );
      }

      if (toolName === "git_merge") {
        const branchName = toString(args.branch_name) || toString(args.branch);
        const intoBranch = toString(args.into_branch);
        if (!branchName || !intoBranch) {
          return "Missing branch_name or into_branch argument for git_merge tool.";
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
          allowRepoFallback,
        );
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
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
          2,
        );
      }

      if (toolName === "git_reset") {
        const modeArg = toString(args.mode);
        if (modeArg !== "soft" && modeArg !== "mixed" && modeArg !== "hard") {
          return "Missing or invalid mode for git_reset. Use one of: soft, mixed, hard.";
        }

        await runGitWithRepoFallback(
          repoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitReset({
              repoPath: candidate,
              mode: modeArg,
              commit: toString(args.commit) || undefined,
              confirm: args.confirm === true ? true : undefined,
            });
          },
          allowRepoFallback,
        );
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
        );
        return JSON.stringify(
          { ok: true, repo_path: effectiveRepoPath, branch: status.branch },
          null,
          2,
        );
      }

      if (toolName === "git_stash") {
        const message = toString(args.message) || undefined;
        const { value: stashId } = await runGitWithRepoFallback(
          repoPath,
          (candidate) => {
            effectiveRepoPath = candidate;
            return tauriIpc.gitStash({ repoPath: candidate, message });
          },
          allowRepoFallback,
        );
        const { value: status } = await runGitWithRepoFallback(
          effectiveRepoPath,
          (candidate) => tauriIpc.gitStatus(candidate),
          allowRepoFallback,
        );
        return JSON.stringify(
          {
            ok: true,
            repo_path: effectiveRepoPath,
            branch: status.branch,
            stash: stashId,
          },
          null,
          2,
        );
      }

      return `Unknown Git tool: ${toolName}`;
    }

    if (toolName === "list") {
      const inputPath = sanitizePathInput(toString(args.path) || ".");
      const path = resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      const recursive = args.recursive !== false;
      const includeHidden = args.include_hidden === true;
      const maxDepth =
        typeof args.max_depth === "number"
          ? Math.max(1, Math.floor(args.max_depth))
          : undefined;
      const entries = await tauriIpc.fsListDir({
        path,
        recursive,
        includeHidden,
        maxDepth,
        allowOutsideWorkspace: Boolean(effectiveWorkspacePath),
      });
      return JSON.stringify({ path, count: entries.length, entries }, null, 2);
    }

    if (toolName === "read") {
      const inputPath = sanitizePathInput(toString(args.path));
      if (!inputPath) return "Missing path argument for read tool.";
      const path = resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      let result;
      let resolvedPath = path;

      try {
        result = await tauriIpc.fsReadFileWithOptions({
          path,
          allowOutsideWorkspace: Boolean(effectiveWorkspacePath),
        });
      } catch (readError) {
        if (!effectiveWorkspacePath || isAbsolutePath(inputPath)) {
          throw readError;
        }

        const root = resolveDirectPath(".", mode, effectiveWorkspacePath);
        const normalizedInput = inputPath
          .replace(/\\/g, "/")
          .replace(/^\.\//, "");
        const entries = await tauriIpc.fsListDir({
          path: root,
          recursive: true,
          includeHidden: false,
          allowOutsideWorkspace: true,
        });

        const candidates = entries
          .filter((entry) => entry.kind === "file")
          .filter((entry) => {
            const rel = entry.relative_path
              .replace(/\\/g, "/")
              .replace(/^\.\//, "");
            const abs = entry.path.replace(/\\/g, "/");
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
                .filter((entry) => entry.kind === "file")
                .filter((entry) => {
                  const rel = entry.relative_path
                    .replace(/\\/g, "/")
                    .replace(/^\.\//, "");
                  const relLower = rel.toLowerCase();
                  const inputLower = normalizedInput.toLowerCase();
                  const basename = rel.split("/").pop() || rel;
                  const basenameLower = basename.toLowerCase();
                  const basenameNoExt = basenameLower.replace(/\.[^/.]+$/, "");
                  const inputNoExt = inputLower.replace(/\.[^/.]+$/, "");

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
            .join(", ");
          return `Error executing read: multiple files match "${inputPath}" under ${root}. Be explicit. Matches: ${suggestion}`;
        } else {
          throw readError;
        }
      }

      if (result.is_binary) {
        return `File ${resolvedPath} is binary (${result.size} bytes, encoding=${result.encoding}).`;
      }

      const startLine =
        typeof args.start_line === "number"
          ? Math.max(1, Math.floor(args.start_line))
          : 1;
      const endLine =
        typeof args.end_line === "number"
          ? Math.max(startLine, Math.floor(args.end_line))
          : undefined;

      const lines = result.content.split("\n");
      const selected = lines.slice(
        startLine - 1,
        endLine ? endLine : undefined,
      );
      const effectiveEndLine = endLine ?? startLine + selected.length - 1;
      const numberedContent = formatWithLineNumbers(selected, startLine);
      const resolvedNotice =
        resolvedPath !== path
          ? `RESOLVED_PATH: ${resolvedPath} (from requested: ${inputPath})\n`
          : "";
      return `FILE: ${resolvedPath}\nSOURCE: WORKSPACE_FILE\n${resolvedNotice}LANGUAGE: ${result.language}\nSIZE: ${result.size}\nLINES: ${startLine}-${effectiveEndLine}\n\n---BEGIN FILE CONTENT---\n${numberedContent}\n---END FILE CONTENT---`;
    }

    if (toolName === "write") {
      const inputPath = sanitizePathInput(toString(args.path));
      const content = toString(args.content);
      if (!inputPath) return "Missing path argument for write tool.";
      const resolvedPath = useMetadataWorkspace
        ? inputPath
        : resolveBackendPath(inputPath, mode, effectiveWorkspacePath);
      const path = useMetadataWorkspace
        ? inputPath
        : resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      assertPathAllowed(mode, resolvedPath);
      const createDirs = args.create_dirs !== false;
      const writeResult = await tauriIpc.fsWriteFile({
        path,
        content,
        createDirs,
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      const readback = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      return buildStructuredWriteResponse({
        path: resolvedPath,
        status: writeResult.created ? "created" : "updated",
        additions: countLogicalLines(content),
        deletions: 0,
        created: writeResult.created,
        bytesWritten: writeResult.bytes_written,
        validation: {
          path: resolvedPath,
          exists: true,
          readable: true,
          is_binary: readback.is_binary,
          size: readback.size,
          encoding: readback.encoding,
          language: readback.language,
        },
        rawPath: writeResult.path,
      });
    }

    if (toolName === "edit") {
      const inputPath = sanitizePathInput(toString(args.path));
      const oldText = toString(args.old_text);
      const newText = toString(args.new_text);
      const replaceAll = args.replace_all === true;

      if (!inputPath) return "Missing path argument for edit tool.";
      if (!oldText) return "Missing old_text argument for edit tool.";

      const resolvedPath = useMetadataWorkspace
        ? inputPath
        : resolveBackendPath(inputPath, mode, effectiveWorkspacePath);
      const path = useMetadataWorkspace
        ? inputPath
        : resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      assertPathAllowed(mode, resolvedPath);

      const current = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      if (current.is_binary) {
        return `Cannot edit binary file: ${path}`;
      }

      const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const occurrences = (
        current.content.match(new RegExp(escapedOld, "g")) || []
      ).length;
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
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      const stats = computeLineChangeStats(current.content, updated);
      const readback = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      return buildStructuredWriteResponse({
        path: resolvedPath,
        status: "updated",
        additions: stats.additions,
        deletions: stats.deletions,
        created: writeResult.created,
        bytesWritten: writeResult.bytes_written,
        validation: {
          path: resolvedPath,
          exists: true,
          readable: true,
          is_binary: readback.is_binary,
          size: readback.size,
          encoding: readback.encoding,
          language: readback.language,
        },
        replacements: replaceAll ? occurrences : 1,
        rawPath: writeResult.path,
      });
    }

    if (toolName === "delete") {
      const inputPath = sanitizePathInput(toString(args.path));
      if (!inputPath) return "Missing path argument for delete tool.";

      const resolvedPath = useMetadataWorkspace
        ? inputPath
        : resolveBackendPath(inputPath, mode, effectiveWorkspacePath);
      const path = useMetadataWorkspace
        ? inputPath
        : resolveDirectPath(inputPath, mode, effectiveWorkspacePath);
      assertPathAllowed(mode, resolvedPath);

      const targetStats = await tauriIpc.fsStat(path, {
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
        workspacePath: effectiveWorkspacePath,
      });
      if (targetStats.kind !== "file") {
        return `Cannot delete directory with delete tool: ${resolvedPath}. Only files are supported.`;
      }

      const current = await tauriIpc.fsReadFileWithOptions({
        path,
        allowOutsideWorkspace:
          !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
      });
      const deletions = current.is_binary ? 0 : countLogicalLines(current.content);

      await tauriIpc.fsDelete({
        path,
        workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
        workspacePath: effectiveWorkspacePath,
      });

      return buildStructuredWriteResponse({
        path: resolvedPath,
        status: "deleted",
        additions: 0,
        deletions,
        created: false,
        bytesWritten: 0,
        validation: {
          path: resolvedPath,
          exists: false,
          readable: false,
          is_binary: false,
          size: 0,
          encoding: null,
          language: null,
        },
        rawPath: path,
      });
    }

    if (toolName === "apply_patch") {
      const patchText = toString(args.patch_text);
      if (!patchText)
        return "Missing patch_text argument for apply_patch tool.";

      let operations: ParsedPatchOperation[];
      try {
        operations = parseApplyPatch(patchText);
      } catch (error) {
        return formatToolError(error);
      }

      const pendingChanges: Array<{
        path: string;
        realPath: string;
        status: "created" | "updated" | "deleted";
        newContent: string | null;
        additions: number;
        deletions: number;
        created: boolean;
        bytesWritten: number;
      }> = [];

      for (const operation of operations) {
        const resolvedPath = useMetadataWorkspace
          ? operation.path
          : resolveBackendPath(operation.path, mode, effectiveWorkspacePath);
        const realPath = useMetadataWorkspace
          ? operation.path
          : resolveDirectPath(operation.path, mode, effectiveWorkspacePath);
        assertPathAllowed(mode, resolvedPath);

        if (operation.kind === "add") {
          const newContent = joinTextLines(operation.lines, true);
          const alreadyExists = await tauriIpc.fsExists(realPath, {
            workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            workspacePath: effectiveWorkspacePath,
          });
          if (alreadyExists) {
            return `Cannot add file ${resolvedPath} because it already exists.`;
          }
          pendingChanges.push({
            path: resolvedPath,
            realPath,
            status: "created",
            newContent,
            additions: countLogicalLines(newContent),
            deletions: 0,
            created: true,
            bytesWritten: newContent.length,
          });
          continue;
        }

        const current = await tauriIpc.fsReadFileWithOptions({
          path: realPath,
          allowOutsideWorkspace:
            !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
          workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
        });

        if (operation.kind === "delete") {
          pendingChanges.push({
            path: resolvedPath,
            realPath,
            status: "deleted",
            newContent: null,
            additions: 0,
            deletions: countLogicalLines(current.content),
            created: false,
            bytesWritten: 0,
          });
          continue;
        }

        if (current.is_binary) {
          return `Cannot apply patch to binary file: ${resolvedPath}`;
        }

        let newContent: string;
        try {
          newContent = applyPatchHunksToContent(
            resolvedPath,
            current.content,
            operation.hunks,
          );
        } catch (error) {
          return formatToolError(error);
        }
        const stats = computeLineChangeStats(current.content, newContent);
        pendingChanges.push({
          path: resolvedPath,
          realPath,
          status: "updated",
          newContent,
          additions: stats.additions,
          deletions: stats.deletions,
          created: false,
          bytesWritten: newContent.length,
        });
      }

      await commitPatchWriteChangesWithRollback(
        pendingChanges.map((change) => ({
          displayPath: change.path,
          realPath: change.realPath,
          newContent: change.newContent,
          existsOptions: {
            workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            workspacePath: effectiveWorkspacePath,
          },
          readOptions: {
            allowOutsideWorkspace:
              !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
            workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            workspacePath: effectiveWorkspacePath,
          },
          writeOptions: {
            allowOutsideWorkspace:
              !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
            workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            workspacePath: effectiveWorkspacePath,
          },
          deleteOptions: {
            workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            workspacePath: effectiveWorkspacePath,
          },
        })),
      );

      const files: PatchChangeRecord[] = [];
      const validationFiles: PatchValidationRecord[] = [];
      const errors: string[] = [];

      for (const change of pendingChanges) {
        let validation: PatchValidationRecord;
        if (change.newContent === null) {
          validation = {
            path: change.path,
            exists: false,
            readable: false,
            is_binary: false,
            size: 0,
            encoding: null,
            language: null,
          };
        } else {
          try {
            const readback = await tauriIpc.fsReadFileWithOptions({
              path: change.realPath,
              allowOutsideWorkspace:
                !useMetadataWorkspace && Boolean(effectiveWorkspacePath),
              workspaceScope: useMetadataWorkspace ? "metadata" : undefined,
            });
            validation = {
              path: change.path,
              exists: true,
              readable: true,
              is_binary: readback.is_binary,
              size: readback.size,
              encoding: readback.encoding,
              language: readback.language,
            };
          } catch (error) {
            errors.push(
              `Validation failed for ${change.path}: ${formatToolError(error)}`,
            );
            validation = {
              path: change.path,
              exists: true,
              readable: false,
              is_binary: false,
              size: 0,
              encoding: null,
              language: null,
            };
          }
        }
        validationFiles.push(validation);
        files.push({
          path: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          created: change.created,
          bytes_written: change.bytesWritten,
          validation,
        });
      }

      return JSON.stringify(
        {
          ok: errors.length === 0,
          files,
          diff: buildApplyPatchDiff(files),
          diagnostics: [],
          validation: {
            all_files_readable: errors.length === 0,
            files: validationFiles,
          },
          errors,
          applied_operations: pendingChanges.length,
        },
        null,
        2,
      );
    }

    if (toolName === "glob") {
      const pattern = toString(args.pattern) || "**/*";
      const includeHidden = args.include_hidden === true;
      const files = await readAllCandidateFiles(
        includeHidden,
        mode,
        effectiveWorkspacePath,
      );
      const matches = files
        .map((entry) => entry.relative_path)
        .filter((relativePath) => pathMatchesGlob(relativePath, pattern));
      return JSON.stringify(
        { pattern, count: matches.length, paths: matches },
        null,
        2,
      );
    }

    if (toolName === "grep") {
      const query = toString(args.query);
      if (!query) return "Missing query argument for grep tool.";

      const includeHidden = args.include_hidden === true;
      const isRegexp = args.is_regexp === true;
      const includePattern = toString(args.include_pattern);
      const maxResults =
        typeof args.max_results === "number"
          ? Math.max(1, Math.floor(args.max_results))
          : 50;

      const files = await readAllCandidateFiles(
        includeHidden,
        mode,
        effectiveWorkspacePath,
      );
      let matcher: RegExp | null = null;
      if (isRegexp) {
        try {
          matcher = new RegExp(query, "i");
        } catch {
          return `Invalid regex pattern for grep: ${query}`;
        }
      }
      const results: Array<{ path: string; line: number; text: string }> = [];

      for (const file of files) {
        if (
          includePattern &&
          !pathMatchesGlob(file.relative_path, includePattern)
        ) {
          continue;
        }

        const content = await tauriIpc.fsReadFileWithOptions({
          path: resolveDirectPath(
            file.relative_path,
            mode,
            effectiveWorkspacePath,
          ),
          allowOutsideWorkspace: Boolean(effectiveWorkspacePath),
        });
        if (content.is_binary) continue;

        const lines = content.content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const match = matcher
            ? matcher.test(line)
            : line.toLowerCase().includes(query.toLowerCase());
          if (match) {
            results.push({
              path: file.relative_path,
              line: index + 1,
              text: line.trim(),
            });
            if (results.length >= maxResults) {
              return JSON.stringify(
                { query, total: results.length, results },
                null,
                2,
              );
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
