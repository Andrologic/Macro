/** Local navigation organization. Does not alter AgSDL documents or Git paths. */
export interface BlueprintFolder {
  id: string;
  scopeId: string;
  name: string;
}
export interface BlueprintFolderOrganization {
  folders: BlueprintFolder[];
  placements: Record<string, string>;
  collapsedIds: string[];
}
export const emptyBlueprintFolders = (): BlueprintFolderOrganization => ({ folders: [], placements: {}, collapsedIds: [] });
const placementKey = (scopeId: string, planKey: string) => JSON.stringify([scopeId, planKey]);
export function normalizeBlueprintFolders(value: unknown): BlueprintFolderOrganization {
  const result = emptyBlueprintFolders();
  if (!value || typeof value !== 'object') return result;
  const raw = value as Partial<BlueprintFolderOrganization>;
  for (const folder of Array.isArray(raw.folders) ? raw.folders : []) {
    if (folder && typeof folder.id === 'string' && folder.id && typeof folder.scopeId === 'string' && folder.scopeId && typeof folder.name === 'string' && folder.name.trim() && !result.folders.some(f => f.id === folder.id)) {
      result.folders.push({ id: folder.id, scopeId: folder.scopeId, name: folder.name.trim().slice(0, 80) });
    }
  }
  const ids = new Set(result.folders.map(f => f.id));
  if (raw.placements && typeof raw.placements === 'object') {
    for (const [key, id] of Object.entries(raw.placements)) {
      if (typeof id !== 'string' || !ids.has(id)) continue;
      try {
        const pair: unknown = JSON.parse(key);
        if (Array.isArray(pair) && pair.length === 2 && pair.every(x => typeof x === 'string' && x) && result.folders.some(f => f.id === id && f.scopeId === pair[0])) result.placements[key] = id;
      } catch { /* Ignore invalid persisted identities. */ }
    }
  }
  result.collapsedIds = Array.isArray(raw.collapsedIds) ? [...new Set(raw.collapsedIds.filter(id => typeof id === 'string' && ids.has(id)))] : [];
  return result;
}
export const blueprintFolderId = (state: BlueprintFolderOrganization, scopeId: string, planKey: string): string | null => {
  const id = state.placements[placementKey(scopeId, planKey)];
  return state.folders.some(f => f.id === id && f.scopeId === scopeId) ? id : null;
};
export function nameBlueprintFolder(state: BlueprintFolderOrganization, scopeId: string, id: string, name: string): BlueprintFolderOrganization {
  const normalized = name.trim().slice(0, 80);
  if (!normalized || state.folders.some(f => f.scopeId === scopeId && f.id !== id && f.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error('invalid-folder-name');
  const existing = state.folders.find(f => f.id === id);
  if (existing && existing.scopeId !== scopeId) throw new Error('invalid-folder-scope');
  const folder = { id, scopeId, name: normalized };
  return { ...state, folders: existing ? state.folders.map(f => f.id === id ? folder : f) : [...state.folders, folder] };
}
export function moveBlueprintToFolder(state: BlueprintFolderOrganization, scopeId: string, planKey: string, folderId: string | null): BlueprintFolderOrganization {
  if (!planKey || (folderId && !state.folders.some(f => f.id === folderId && f.scopeId === scopeId))) throw new Error('invalid-folder-target');
  const placements = { ...state.placements };
  const key = placementKey(scopeId, planKey);
  if (folderId) placements[key] = folderId;
  else delete placements[key];
  return { ...state, placements, collapsedIds: state.collapsedIds.filter(id => id !== folderId) };
}
export function removeBlueprintFolder(state: BlueprintFolderOrganization, id: string): BlueprintFolderOrganization {
  return { folders: state.folders.filter(f => f.id !== id), placements: Object.fromEntries(Object.entries(state.placements).filter(([, target]) => target !== id)), collapsedIds: state.collapsedIds.filter(value => value !== id) };
}
