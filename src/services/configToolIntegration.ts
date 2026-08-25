import type {
  ConfigDocumentKind,
  ConfigScope,
  JsonPatchOperation,
} from '../types/generated/config';
import {
  configurationApplyPatch,
  configurationGetDocument,
  configurationGetSnapshot,
  configurationValidateDocument,
} from './configurationClient';

const DOCUMENT_KINDS = new Set<ConfigDocumentKind>([
  'runtime',
  'settings',
  'agents',
  'providers',
  'tools',
  'skills',
  'git',
]);

const readKind = (args: Record<string, unknown>): ConfigDocumentKind => {
  const value = typeof args.document === 'string' ? args.document.trim() : '';
  if (!DOCUMENT_KINDS.has(value as ConfigDocumentKind)) {
    throw new Error(`Unknown configuration document: ${value || '(missing)'}.`);
  }
  return value as ConfigDocumentKind;
};

const readScope = (args: Record<string, unknown>): ConfigScope => {
  if (args.scope !== 'project') return { type: 'user' };
  const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
  if (!projectId) throw new Error('project_id is required for project configuration.');
  return { type: 'project', projectId };
};

const readPatch = (value: unknown): JsonPatchOperation[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('patch must contain at least one RFC 6902 operation.');
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`patch[${index}] must be an object.`);
    }
    const operation = candidate as Record<string, unknown>;
    if (typeof operation.op !== 'string' || typeof operation.path !== 'string') {
      throw new Error(`patch[${index}] requires string op and path fields.`);
    }
    return {
      op: operation.op,
      path: operation.path,
      ...(typeof operation.from === 'string' ? { from: operation.from } : {}),
      ...('value' in operation ? { value: operation.value } : {}),
    };
  });
};

export const handleConfigToolCall = async (
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | undefined> => {
  if (toolName === 'config_list') {
    const projectIds = Array.isArray(args.project_ids)
      ? args.project_ids.filter((value): value is string => typeof value === 'string')
      : [];
    return JSON.stringify(await configurationGetSnapshot(projectIds), null, 2);
  }

  if (toolName === 'config_get') {
    return JSON.stringify(await configurationGetDocument(readKind(args), readScope(args)), null, 2);
  }

  if (toolName === 'config_validate') {
    if (!('value' in args)) throw new Error('value is required for config_validate.');
    return JSON.stringify(await configurationValidateDocument({
      kind: readKind(args),
      scope: readScope(args),
      document: args.value,
    }), null, 2);
  }

  if (toolName === 'config_patch') {
    const expectedEtag = typeof args.expected_etag === 'string'
      ? args.expected_etag.trim()
      : '';
    if (!expectedEtag) throw new Error('expected_etag is required for config_patch.');
    return JSON.stringify(await configurationApplyPatch({
      kind: readKind(args),
      scope: readScope(args),
      expectedEtag,
      patch: readPatch(args.patch),
      source: 'agent',
    }), null, 2);
  }

  return undefined;
};
