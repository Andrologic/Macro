import { list, object, readDocument, sourceAt } from "../../services/agsdl/document";
import type { AgsdlSelectionReference } from "../../types";
import { agsdlSessionKey, useAgsdlStore } from "../useAgsdlStore";

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

export function isAgsdlChatContextCurrent(context: AgsdlSelectionReference): boolean {
  if (context.contextKind === "runtime") return true;
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(context.blueprintId !== undefined ? { blueprintId: context.blueprintId } : context)];
  if (!session) return false;
  if (session.version === context.version) return true;
  // Each load starts a new session version. A draft restored after a reload still
  // targets the same document while its saved revision is unchanged and unedited.
  if (session.dirty || session.saving || session.persistedRevision !== context.persistedRevision) return false;
  try {
    for (const path of [context.path, ...(context.relatedPaths ?? [])]) resolveAgsdlSelectionPath(session.source, path);
    return true;
  } catch { return false; }
}
