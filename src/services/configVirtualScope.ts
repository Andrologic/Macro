import type {
  ConfigDocument,
  ConfigDocumentKind,
  ConfigScope,
} from '../types/generated/config';
import {
  configurationApplyPatch,
  configurationGetDocument,
} from './configurationClient';
import { loadValidProjectRegistrySnapshot } from './validProjectRegistry';
import type { ParsedPatchOperation } from './workspaceToolExecutor';
import * as workspaceToolExecutor from './workspaceToolExecutor';

const USER_DOCUMENTS = new Set<ConfigDocumentKind>([
  'runtime',
  'settings',
  'agents',
  'providers',
  'tools',
  'skills',
  'git',
]);
const PROJECT_DOCUMENTS = new Set<ConfigDocumentKind>(['agents', 'tools', 'skills', 'git']);

type ConfigVirtualTarget = {
  kind: ConfigDocumentKind;
  scope: ConfigScope;
  path: string;
};

const normalizeVirtualPath = (value: unknown): string =>
  (typeof value === 'string' ? value : '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

const isSafeProjectId = (value: string): boolean => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return false;
  const upper = value.toUpperCase();
  return !['CON', 'PRN', 'AUX', 'NUL'].includes(upper)
    && !/^(COM|LPT)[1-9]$/.test(upper);
};

export const parseConfigVirtualPath = (value: unknown): ConfigVirtualTarget | null => {
  const path = normalizeVirtualPath(value);
  const userMatch = /^@config\/user\/([a-z]+)\.json$/.exec(path);
  if (userMatch) {
    const kind = userMatch[1] as ConfigDocumentKind;
    if (!USER_DOCUMENTS.has(kind)) throw new Error(`Unknown user configuration document: ${path}.`);
    return { kind, scope: { type: 'user' }, path };
  }

  const projectMatch = /^@config\/projects\/([^/]+)\/([a-z]+)\.json$/.exec(path);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const kind = projectMatch[2] as ConfigDocumentKind;
    if (!isSafeProjectId(projectId)) throw new Error(`Invalid project id in configuration path: ${path}.`);
    if (!PROJECT_DOCUMENTS.has(kind)) throw new Error(`Document ${kind}.json cannot use project scope.`);
    return { kind, scope: { type: 'project', projectId }, path };
  }

  return null;
};

const isConfigVirtualPath = (value: unknown): boolean => {
  const path = normalizeVirtualPath(value);
  return path === '@config' || path.startsWith('@config/');
};

const formatDocument = (document: ConfigDocument): string =>
  `${JSON.stringify(document.value, null, 2)}\n`;

const parseDocumentContent = (content: unknown, path: string): unknown => {
  if (typeof content !== 'string') throw new Error(`Missing JSON content for ${path}.`);
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid strict JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const replaceDocument = async (
  target: ConfigVirtualTarget,
  value: unknown,
): Promise<string> => {
  const current = await configurationGetDocument(target.kind, target.scope);
  const result = await configurationApplyPatch({
    kind: target.kind,
    scope: target.scope,
    expectedEtag: current.etag,
    patch: [{ op: 'replace', path: '', value }],
    source: 'agent',
  });
  return JSON.stringify({
    path: target.path,
    status: result.status,
    etag: result.document.etag,
    pendingSensitiveChange: result.pendingChange?.id ?? null,
    restartRequired: result.restartRequired,
  }, null, 2);
};

const minimalDocument = (kind: ConfigDocumentKind): Record<string, unknown> => ({
  $schema: `./schemas/v1/${kind}.schema.json`,
  schemaVersion: 1,
});

export const listConfigPath = async (
  value: unknown,
  projectRegistryLoader: typeof loadValidProjectRegistrySnapshot = loadValidProjectRegistrySnapshot,
): Promise<string> => {
  const path = normalizeVirtualPath(value) || '@config';
  if (path === '@config') return '@config/user/\n@config/projects/';
  if (path === '@config/user') {
    return [...USER_DOCUMENTS].map((kind) => `@config/user/${kind}.json`).join('\n');
  }
  if (path === '@config/projects') {
    const registry = await projectRegistryLoader();
    return registry.validProjectIds
      .filter(isSafeProjectId)
      .sort()
      .map((projectId) => `@config/projects/${projectId}/`)
      .join('\n');
  }
  const projectMatch = /^@config\/projects\/([^/]+)$/.exec(path);
  if (projectMatch && isSafeProjectId(projectMatch[1])) {
    return [...PROJECT_DOCUMENTS]
      .map((kind) => `@config/projects/${projectMatch[1]}/${kind}.json`)
      .join('\n');
  }
  throw new Error(`Configuration directory does not exist: ${path}.`);
};

const applyConfigTextPatch = async (operation: ParsedPatchOperation): Promise<string> => {
  const target = parseConfigVirtualPath(operation.path);
  if (!target) throw new Error(`apply_patch path is outside @config: ${operation.path}.`);
  if (operation.kind === 'delete') {
    return replaceDocument(target, minimalDocument(target.kind));
  }
  if (operation.kind === 'add') {
    throw new Error(`${target.path} already exists. Use an update section or config_patch.`);
  }
  const current = await configurationGetDocument(target.kind, target.scope);
  const updatedContent = workspaceToolExecutor.applyPatchHunksToContent(
    target.path,
    formatDocument(current),
    operation.hunks,
  );
  return replaceDocument(target, parseDocumentContent(updatedContent, target.path));
};

export const handleConfigVirtualScopeToolCall = async (
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | undefined> => {
  if (toolName === 'apply_patch') {
    const patchText = typeof args.patch_text === 'string' ? args.patch_text : '';
    if (!patchText.includes('@config/')) return undefined;
    const operations = workspaceToolExecutor.parseApplyPatch(patchText);
    if (operations.some((operation) => !isConfigVirtualPath(operation.path))) {
      throw new Error('A single apply_patch call cannot mix @config and workspace files.');
    }
    if (operations.length !== 1) {
      throw new Error('Use one @config document per apply_patch call so ETag conflicts remain atomic.');
    }
    return applyConfigTextPatch(operations[0]);
  }

  if (!['list', 'read', 'write', 'edit', 'delete'].includes(toolName)) return undefined;
  if (!isConfigVirtualPath(args.path)) return undefined;
  if (toolName === 'list') return listConfigPath(args.path);

  const target = parseConfigVirtualPath(args.path);
  if (!target) throw new Error(`Expected an @config JSON document path, received ${String(args.path)}.`);
  if (toolName === 'read') {
    const content = formatDocument(await configurationGetDocument(target.kind, target.scope));
    const start = typeof args.start_line === 'number' ? Math.max(1, Math.floor(args.start_line)) : 1;
    const lines = content.split('\n');
    const end = typeof args.end_line === 'number'
      ? Math.max(start, Math.floor(args.end_line))
      : lines.length;
    return lines.slice(start - 1, end).join('\n');
  }
  if (toolName === 'delete') return replaceDocument(target, minimalDocument(target.kind));
  if (toolName === 'write') {
    return replaceDocument(target, parseDocumentContent(args.content, target.path));
  }

  const current = formatDocument(await configurationGetDocument(target.kind, target.scope));
  const oldText = typeof args.old_text === 'string' ? args.old_text : '';
  const newText = typeof args.new_text === 'string' ? args.new_text : '';
  if (!oldText) throw new Error(`old_text is required to edit ${target.path}.`);
  if (!current.includes(oldText)) throw new Error(`old_text was not found in ${target.path}.`);
  const updated = args.replace_all === true
    ? current.split(oldText).join(newText)
    : current.replace(oldText, newText);
  return replaceDocument(target, parseDocumentContent(updated, target.path));
};
