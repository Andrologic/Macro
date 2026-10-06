import { serializeAgsdlChatContext } from "../agsdl/selectionContext";
import type { Citation } from "../../stores/useCitationsStore";
import type { ContextRefKind, ContextReference, PersistedContextReference, SkillManifest, WorkspaceFileReference } from "../../types";
/** Pasted selections stay in the draft until the user chooses which one to keep. */
export function hasMultipleAgsdlContexts(refs: readonly { kind: ContextRefKind }[] | undefined): boolean {
  return (refs?.filter(ref => ref.kind === 'agsdl').length ?? 0) > 1;
}
export const persistableContextRefs = (
  refs: readonly ContextReference[],
): PersistedContextReference[] | undefined => {
  const persisted = refs.map((ref) => {
    const skill =
      ref.kind === "skill" &&
      ref.data &&
      typeof ref.data === "object"
        ? (ref.data as SkillManifest)
        : null;
    const file =
      ref.kind === "file" &&
      ref.data &&
      typeof ref.data === "object" &&
      "path" in ref.data
        ? (ref.data as WorkspaceFileReference)
        : null;
    const source =
      ref.kind === "source" &&
      ref.data &&
      typeof ref.data === "object"
        ? (ref.data as Citation)
        : null;
    const conversation =
      ref.kind === "conversation" && ref.data && typeof ref.data === "object" &&
      "conversationId" in ref.data ? ref.data : null;
    return {
      id: ref.id,
      kind: ref.kind,
      title: ref.title,
      subtitle: ref.subtitle,
      ...(conversation ? { conversationId: conversation.conversationId } : {}),
      ...(ref.kind === "agsdl" ? { agsdl: ref.data as import("../../types").AgsdlSelectionReference } : {}),
      ...(skill
        ? {
            skillFilePath: skill.skillFilePath,
            contentHash: skill.contentHash,
            location: skill.location,
            source: skill.source,
          }
        : {}),
      ...(file
        ? {
            path: file.path,
            relativePath: file.relativePath,
            projectId: file.projectId ?? null,
            projectName: file.projectName ?? null,
          }
        : {}),
      ...(source
        ? {
            snippet: source.content || source.snippet,
            sourceLabel: source.source,
            url: source.url,
          }
        : {}),
    } satisfies PersistedContextReference;
  });
  return persisted.length > 0 ? persisted : undefined;
};


export interface ComposerSnapshot {
  text: string;
  images: import('../../stores/chat/chatLocalSessionState').MessageImageAttachment[];
  contextRefs: ContextReference[];
}

/** Capture before asynchronous preparation. Never read live selections to finish a send. */
export function captureComposerSnapshot(draft: ComposerSnapshot): ComposerSnapshot {
  return structuredClone(draft);
}

export function sameComposerSnapshot(left: ComposerSnapshot, right: ComposerSnapshot): boolean {
  return left.text === right.text &&
    JSON.stringify(left.images) === JSON.stringify(right.images) &&
    JSON.stringify(persistableContextRefs(left.contextRefs)) === JSON.stringify(persistableContextRefs(right.contextRefs));
}

/** Build model context from the same persisted references used to render the message. */
export function submissionHiddenContext(refs: readonly PersistedContextReference[] | undefined, supplied?: string): string | undefined {
  if (hasMultipleAgsdlContexts(refs)) throw new Error('Only one AgSDL selection may be sent.');
  if (supplied?.includes('<agsdl_selection>')) return supplied;
  const selection = refs?.find(ref => ref.kind === 'agsdl')?.agsdl;
  return [supplied, serializeAgsdlChatContext(selection)].filter(Boolean).join('\n\n') || undefined;
}
