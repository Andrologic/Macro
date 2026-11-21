import { isAgsdlReference, sameRuntimeReference, type RuntimeSelectionCapture } from './runtimeSelection';
import type { PersistedContextReference } from '../../types';
import type { AgsdlSelectionReference } from '../../types';
import { serializeAgsdlChatContext } from './selectionContext';

export interface AgsdlSelectionPayload {
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
    if (value.context_kind !== undefined || !Object.keys(value).every(key => ['plan_id', 'target_branch', 'document', 'revision', 'persisted_revision', 'path', 'related_paths', 'title', 'diagnostic'].includes(key))) return undefined;
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
  const pattern = new RegExp(`${selectionBlocks().source}(?:\\r?\\n(?:Use agsdl_get|This AgSDL selection)[^\\r\\n]*)?`, 'gm');
  return hiddenContext?.replace(pattern, '').trim() || undefined;
}

/** Only the validated AgSDL block and its fixed authoring reminder reach the model. */
export function agsdlContextForModel(hiddenContext: string | undefined, refs?: readonly PersistedContextReference[], conversationId?: string): string | undefined {
  const capture = readRuntimeCapture(hiddenContext);
  if (capture) {
    const references = refs?.filter(ref => ref.kind === 'agsdl');
    const reference = references?.length === 1 ? references[0].agsdl : undefined;
    if (!reference || reference.contextKind !== 'runtime' || (conversationId !== undefined && reference.conversationId !== conversationId) || !sameRuntimeReference(reference, capture.reference)) return undefined;
    return serializeAgsdlChatContext(reference, capture);
  }
  const payload = readAgsdlSelectionPayload(hiddenContext, true);
  if (!payload) return undefined;
  const selection: AgsdlSelectionReference = {
    id: '', conversationId: '', planId: payload.plan_id, branchName: payload.target_branch,
    document: payload.document, version: payload.revision, persistedRevision: payload.persisted_revision ?? 0,
    path: payload.path, relatedPaths: payload.related_paths, title: payload.title, diagnostic: payload.diagnostic,
  };
  const serialized = serializeAgsdlChatContext(selection);
  if (refs) {
    const matching = refs.filter(ref => ref.kind === 'agsdl');
    if (matching.length && (matching.length !== 1 || !matching[0].agsdl || matching[0].agsdl.contextKind === 'runtime' || serializeAgsdlChatContext(matching[0].agsdl) !== serialized)) return;
  }
  return serialized;
}


/** Runtime captures are rebuilt from explicit public fields; unknown/private fields invalidate the block. */
export function readRuntimeCapture(hiddenContext: string | undefined): RuntimeSelectionCapture | undefined {
  const blocks = [...(hiddenContext ?? '').matchAll(selectionBlocks())];
  if (blocks.length !== 1) return;
  try {
    const value = JSON.parse(blocks[0][1]);
    const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
    const keys = (item: Record<string, unknown>, names: string[]) => Object.keys(item).every(key => names.includes(key));
    if (!object(value) || value.context_kind !== 'runtime' || !keys(value, ['context_kind', 'reference', 'fragments', 'versions', 'diagnostics']) ||
        !isAgsdlReference(value.reference) || value.reference.contextKind !== 'runtime') return;
    const reference = value.reference;
    const paths = [...new Set([reference.path, ...(reference.relatedPaths ?? [])])];
    if (!Array.isArray(value.fragments) || value.fragments.length !== paths.length || value.fragments.some((fragment, index) => !object(fragment) ||
        !keys(fragment, ['path', 'sourceText']) || fragment.path !== paths[index] || typeof fragment.sourceText !== 'string' || fragment.sourceText.length > 4_000_000)) return;
    const versions = value.versions;
    if (!object(versions) || !keys(versions, ['snapshot', 'contract', 'compiler', 'runtime', 'registry', 'profile']) ||
        versions.snapshot !== '1' || versions.contract !== 'agsdl-0.2.0' || versions.profile !== 'macro-serial-inline-v1' ||
        !['compiler', 'runtime', 'registry'].every(key => typeof versions[key] === 'string' && versions[key].length <= 2048)) return;
    const selected = reference.diagnosticSelection ?? [];
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length !== selected.length || value.diagnostics.some((item, index) => !object(item) ||
        !keys(item, ['id', 'sequence', 'code', 'pointer', 'message']) || item.id !== selected[index].id || item.sequence !== selected[index].sequence ||
        typeof item.code !== 'string' || item.code.length > 2048 || typeof item.pointer !== 'string' || item.pointer.length > 2048 || typeof item.message !== 'string' || item.message.length > 512)) return;
    return { reference, fragments: value.fragments.map(fragment => ({ path: fragment.path, sourceText: fragment.sourceText })),
      versions: { snapshot: '1', contract: 'agsdl-0.2.0', profile: 'macro-serial-inline-v1', compiler: versions.compiler as string, runtime: versions.runtime as string, registry: versions.registry as string },
      diagnostics: value.diagnostics.map(({ id, sequence, code, pointer, message }) => ({ id, sequence, code, pointer, message })) };
  } catch { return; }
}
