import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";

/**
 * The number of the latest version when the draft is exactly that version: nothing was edited since it was saved.
 * Undefined while the draft has changes, while a save runs, or until versions are known.
 */
export function useDraftMatchesVersion(blueprintId: string): number | undefined {
  const versions = useArchitectLibraryStore(state => state.versions);
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey({ blueprintId })]);
  if (versions.status !== "ready" || !session || session.dirty || session.saving) return undefined;
  const latest = versions.value.filter(version => version.storageState !== "recovery")
    .reduce<(typeof versions.value)[number] | undefined>((best, version) => !best || version.number > best.number ? version : best, undefined);
  return latest && latest.revision === session.persistedRevision ? latest.number : undefined;
}
