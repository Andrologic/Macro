import { serializeAgsdlChatContext } from "../../services/agsdl/selectionContext";
export { serializeAgsdlChatContext } from "../../services/agsdl/selectionContext";
import i18n from "../../i18n";
import type { AgsdlSelectionReference, ContextReference } from "../../types";
import { getArchitectPlan } from "../../services/architectPlanService";
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from "../useAgsdlStore";
import { list, object, readDocument, sourceAt } from "../../services/agsdl/document";
import { useChatStore } from "../useChatStore";

export type AgsdlChatContext = AgsdlSelectionReference;

export function getAgsdlContext(refs: readonly ContextReference[]): AgsdlChatContext | undefined {
  return refs.find(ref => ref.kind === 'agsdl')?.data as AgsdlChatContext | undefined;
}

/** Resolve viewer-only legacy cards to their real source owner. */
export function resolveAgsdlSelectionPath(source: string, path: string): string {
  if (path.startsWith("/legacy/")) {
    const index = Number(path.slice("/legacy/".length));
    const definitions = list(readDocument(source).definitions).map(object);
    const archiveIndex = definitions.findIndex(value => value.kind === "Resource" && object(value.key).id === "macro-legacy-plan");
    const node = object(list(object(definitions[archiveIndex]?.payload).nodes)[index]);
    const matches = definitions.map((value, index) => ({ value, index })).filter(({ value }) =>
      value.kind === "Agent" && typeof node.id === "string" && object(value.annotations).macroLegacyNodeId === node.id);
    path = matches.length === 1 ? `/definitions/${matches[0].index}` : `/definitions/${archiveIndex}/payload/nodes/${index}`;
  }
  // Root references also support repairing a malformed or empty document.
  if (path) sourceAt(source, path);
  return path;
}

/** Attach a document reference to the plan's currently selected chat. Never sends or changes draft text. */
export async function prepareAgsdlChatContext(
  target: AgsdlTarget,
  selection: Pick<AgsdlChatContext, "path" | "title" | "relatedPaths" | "diagnostic">,
): Promise<void> {
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  if (!session) throw new Error(i18n.t("agsdl.chatDocumentMissing", { ns: "agsdl", defaultValue: "Load the AgSDL document first." }));
  const path = resolveAgsdlSelectionPath(session.source, selection.path);
  const relatedPaths = selection.relatedPaths?.map(path => resolveAgsdlSelectionPath(session.source, path));
  const plan = await getArchitectPlan(target.branchName, target.planId);
  const chat = useChatStore.getState();
  const conversationId = chat.selectedConversationId;
  const pending = conversationId ? chat.getPendingArchitectConversationTarget(conversationId) : null;
  const ownsPending = !plan?.conversationId && pending?.planId === target.planId && pending.branchName === target.branchName;
  if (!plan || plan.status === "deleted" || !conversationId ||
      (plan.conversationId !== conversationId && !ownsPending)) {
    throw new Error(i18n.t("agsdl.chatConversationMissing", { ns: "agsdl", defaultValue: "Open this plan’s conversation before attaching AgSDL context." }));
  }
  const context: AgsdlChatContext = {
    ...target, ...selection, path, relatedPaths, document: "agsdl", id: crypto.randomUUID(),
    conversationId, version: session.version,
    persistedRevision: session.persistedRevision,
  };
  // The common reference collection owns selection, persistence and removal.
  if (useChatStore.getState().selectedConversationId !== conversationId) return;
  for (const ref of useChatStore.getState().composerContextRefs) {
    if (ref.kind === 'agsdl') useChatStore.getState().removeComposerContextRef(ref.id, ref.kind);
  }
  useChatStore.getState().addComposerContextRef({ id: context.id, kind: 'agsdl', title: context.title, data: context });
}

export function isAgsdlChatContextCurrent(context: AgsdlChatContext): boolean {
  return useAgsdlStore.getState().sessions[agsdlSessionKey(context)]?.version === context.version;
}

/** Read only the display metadata from our persisted selection envelope. */
export function readAgsdlChatSelection(hiddenContext?: string): { title: string; review: boolean } | undefined {
  const match = hiddenContext?.match(/<agsdl_selection>\s*([\s\S]*?)\s*<\/agsdl_selection>/);
  if (!match) return undefined;
  try {
    const selection: unknown = JSON.parse(match[1]);
    if (!selection || typeof selection !== "object") return undefined;
    const value = selection as Record<string, unknown>;
    if (value.document !== "agsdl" || typeof value.title !== "string") return undefined;
    return { title: value.title, review: typeof value.diagnostic === "string" && value.diagnostic.length > 0 };
  } catch { return undefined; }
}

/** Replace only selection context when editing; preserve unrelated message context. */
export function replaceAgsdlChatContext(hiddenContext: string | undefined, context: AgsdlChatContext | undefined): string | undefined {
  const previous = hiddenContext?.replace(/<agsdl_selection>[\s\S]*?<\/agsdl_selection>\nUse agsdl_get[^\n]*/g, '').trim();
  return [previous, serializeAgsdlChatContext(context)].filter(Boolean).join('\n\n') || undefined;
}

/** Compatibility reader for messages sent before selections became normal references. */
export function legacyAgsdlReference(hiddenContext: string | undefined, conversationId: string, messageId: string): ContextReference | undefined {
  const match = hiddenContext?.match(/<agsdl_selection>\s*([\s\S]*?)\s*<\/agsdl_selection>/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (value.document !== 'agsdl' || !['plan_id', 'target_branch', 'revision', 'path', 'title'].every(key => typeof value[key] === 'string')) return undefined;
    const context: AgsdlChatContext = {
      id: `legacy-agsdl:${messageId}`, conversationId, document: 'agsdl',
      planId: value.plan_id as string, branchName: value.target_branch as string,
      version: value.revision as string, persistedRevision: typeof value.persisted_revision === 'number' ? value.persisted_revision : 0,
      path: value.path as string, title: value.title as string,
      diagnostic: typeof value.diagnostic === 'string' ? value.diagnostic : undefined,
      relatedPaths: Array.isArray(value.related_paths) ? value.related_paths.filter((path): path is string => typeof path === 'string') : undefined,
    };
    return { id: context.id, kind: 'agsdl', title: context.title, data: context };
  } catch { return undefined; }
}

/** Only AgSDL selection payloads are model context. */
export function agsdlContextForModel(hiddenContext: string | undefined): string | undefined {
  return hiddenContext?.startsWith("<agsdl_selection>\n") ? hiddenContext : undefined;
}
