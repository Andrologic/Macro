import { readExecutionSnapshot, readExecutionDiagnostic } from "../../services/tauriIpc";
import { captureRuntimeSelection, sameRuntimeReference, isAgsdlReference, type RuntimeSelectionCapture } from "../../services/agsdl/runtimeSelection";
import { readAgsdlSelectionPayload, readRuntimeCapture, stripAgsdlChatContext } from '../../services/agsdl/chatContextPayload';
export { agsdlContextForModel } from '../../services/agsdl/chatContextPayload';
import { serializeAgsdlChatContext } from "../../services/agsdl/selectionContext";
export { serializeAgsdlChatContext } from "../../services/agsdl/selectionContext";
import i18n from "../../i18n";
import type { AgsdlSelectionReference, AgsdlDocumentReference, AgsdlRuntimeReference, ContextReference } from "../../types";
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
  selection: Pick<AgsdlDocumentReference, "path" | "title" | "relatedPaths" | "diagnostic">,
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
  return context.contextKind === "runtime" || useAgsdlStore.getState().sessions[agsdlSessionKey(context)]?.version === context.version;
}

/** Read only the display metadata from our persisted selection envelope. */
export function readAgsdlChatSelection(hiddenContext?: string): { title: string; review: boolean } | undefined {
  const runtime = readRuntimeCapture(hiddenContext);
  if (runtime) return { title: runtime.reference.title, review: runtime.diagnostics.length > 0 };
  const selection = readAgsdlSelectionPayload(hiddenContext);
  return selection ? { title: selection.title, review: !!selection.diagnostic } : undefined;
}

/** Replace only selection context when editing; preserve unrelated message context. */
export function replaceAgsdlChatContext(hiddenContext: string | undefined, context: AgsdlChatContext | undefined, capture?: import("../../services/agsdl/runtimeSelection").RuntimeSelectionCapture): string | undefined {
  const previous = stripAgsdlChatContext(hiddenContext);
  return [previous, serializeAgsdlChatContext(context, capture)].filter(Boolean).join('\n\n') || undefined;
}

/** Compatibility reader for messages sent before selections became normal references. */
export function legacyAgsdlReference(hiddenContext: string | undefined, conversationId: string, messageId: string): ContextReference | undefined {
  const runtime = readRuntimeCapture(hiddenContext);
  if (runtime) return { id: runtime.reference.id, kind: 'agsdl', title: runtime.reference.title, data: runtime.reference };
  const value = readAgsdlSelectionPayload(hiddenContext, true);
  if (!value) return undefined;
  const context: AgsdlChatContext = {
    id: `legacy-agsdl:${messageId}`, conversationId, document: 'agsdl',
    planId: value.plan_id, branchName: value.target_branch,
    version: value.revision, persistedRevision: value.persisted_revision ?? 0,
    path: value.path, title: value.title, diagnostic: value.diagnostic, relatedPaths: value.related_paths,
  };
  return { id: context.id, kind: 'agsdl', title: context.title, data: context };
}


/** Runtime attachments retain only exact identities. Public data is resolved before acceptance. */
export async function prepareAgsdlRuntimeContext(context: Omit<AgsdlRuntimeReference, "id" | "conversationId" | "document" | "contextKind">): Promise<void> {
  const chat = useChatStore.getState();
  const conversationId = chat.selectedConversationId;
  const plan = await getArchitectPlan(context.branchName, context.planId);
  const conversation = useChatStore.getState().conversations.find(item => item.id === conversationId);
  if (!conversationId || useChatStore.getState().selectedConversationId !== conversationId || !plan || plan.status === "deleted" ||
      plan.conversationId !== conversationId || conversation?.project_id !== context.source.owner.projectId ||
      context.planId !== context.source.owner.planId || context.branchName !== context.source.owner.branch) throw new Error("Runtime selection owner differs from the conversation");
  const reference: AgsdlRuntimeReference = { ...context, document: "agsdl", contextKind: "runtime", id: crypto.randomUUID(), conversationId };
  for (const ref of useChatStore.getState().composerContextRefs) if (ref.kind === 'agsdl') useChatStore.getState().removeComposerContextRef(ref.id, ref.kind);
  useChatStore.getState().addComposerContextRef({ id: reference.id, kind: 'agsdl', title: reference.title, data: reference });
}


export async function captureAgsdlChatContext(context: AgsdlChatContext | undefined, conversationId: string | null, unchanged: () => boolean, previousHidden?: string): Promise<RuntimeSelectionCapture | undefined> {
  if (!context || context.contextKind !== "runtime") return;
  if (!isAgsdlReference(context)) throw new Error("Invalid runtime reference");
  const ownsDestination = async () => {
    const plan = await getArchitectPlan(context.branchName, context.planId);
    const chat = useChatStore.getState();
    const conversation = chat.conversations.find(item => item.id === conversationId);
    if (!unchanged() || context.conversationId !== conversationId || chat.selectedConversationId !== conversationId ||
        conversation?.project_id !== context.source.owner.projectId || !plan || plan.status === "deleted" || plan.conversationId !== conversationId ||
        context.planId !== context.source.owner.planId || context.branchName !== context.source.owner.branch) throw new Error("Runtime selection owner or draft changed before acceptance");
  };
  await ownsDestination();
  const previous = readRuntimeCapture(previousHidden);
  const capture = previous && sameRuntimeReference(context, previous.reference) ? previous : await captureRuntimeSelection(context, {
    snapshot: readExecutionSnapshot, diagnostic: readExecutionDiagnostic,
  });
  await ownsDestination();
  return capture;
}
