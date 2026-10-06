import type { AgsdlSelectionReference } from '../../types';
import { serializeAgsdlChatContext } from './selectionContext';

interface AgsdlSelectionPayload {
  plan_id?: string;
  target_branch?: string;
  document: 'agsdl';
  revision?: string;
  persisted_revision?: number;
  path?: string;
  related_paths?: string[];
  title: string;
  diagnostic?: string;
}

interface AgsdlTargetPayload extends AgsdlSelectionPayload {
  plan_id: string;
  target_branch: string;
  revision: string;
  path: string;
}

// JSON string contents cannot terminate a block: the delimiter owns its line.
const selectionBlocks = () => /^<agsdl_selection>\r?\n([\s\S]*?)\r?\n<\/agsdl_selection>(?=\r?\n|$)/gm;

/** Legacy display-only selections remain readable; model and tool references require a complete target. */
export function readAgsdlSelectionPayload(hiddenContext: string | undefined, requireTarget: true): AgsdlTargetPayload | undefined;
export function readAgsdlSelectionPayload(hiddenContext: string | undefined): AgsdlSelectionPayload | undefined;
export function readAgsdlSelectionPayload(hiddenContext: string | undefined, requireTarget = false): AgsdlSelectionPayload | undefined {
  const blocks = [...(hiddenContext ?? '').matchAll(selectionBlocks())];
  if (blocks.length !== 1) return undefined;
  try {
    const candidate: unknown = JSON.parse(blocks[0][1]);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const value = candidate as Record<string, unknown>;
    if (value.document !== 'agsdl' || typeof value.title !== 'string') return undefined;
    const targetFields = ['plan_id', 'target_branch', 'revision', 'path'];
    if (!targetFields.every(key => typeof value[key] === 'string' || (!requireTarget && value[key] === undefined))) return undefined;
    if (value.persisted_revision !== undefined && (!Number.isSafeInteger(value.persisted_revision) || Number(value.persisted_revision) < 0)) return undefined;
    if (value.related_paths !== undefined && (!Array.isArray(value.related_paths) || !value.related_paths.every(path => typeof path === 'string'))) return undefined;
    if (value.diagnostic !== undefined && typeof value.diagnostic !== 'string') return undefined;
    return {
      plan_id: value.plan_id as string, target_branch: value.target_branch as string,
      document: 'agsdl', revision: value.revision as string, path: value.path as string,
      title: value.title as string,
      ...(value.persisted_revision === undefined ? {} : { persisted_revision: value.persisted_revision as number }),
      ...(value.related_paths === undefined ? {} : { related_paths: value.related_paths as string[] }),
      ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic as string }),
    };
  } catch { return undefined; }
}

/** Remove selection blocks and their authoring reminder, preserving other metadata. */
export function stripAgsdlChatContext(hiddenContext: string | undefined): string | undefined {
  const pattern = new RegExp(`${selectionBlocks().source}(?:\\r?\\nUse agsdl_get[^\\r\\n]*)?`, 'gm');
  return hiddenContext?.replace(pattern, '').trim() || undefined;
}

/** Only the validated AgSDL block and its fixed authoring reminder reach the model. */
export function agsdlContextForModel(hiddenContext: string | undefined): string | undefined {
  const payload = readAgsdlSelectionPayload(hiddenContext, true);
  if (!payload) return undefined;
  const selection: AgsdlSelectionReference = {
    id: '', conversationId: '', planId: payload.plan_id, branchName: payload.target_branch,
    document: payload.document, version: payload.revision, persistedRevision: payload.persisted_revision ?? 0,
    path: payload.path, relatedPaths: payload.related_paths, title: payload.title, diagnostic: payload.diagnostic,
  };
  return serializeAgsdlChatContext(selection);
}
