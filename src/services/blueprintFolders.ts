/** Local navigation organization. Does not alter AgSDL documents or Git paths. */
export interface BlueprintFolder {
  id: string;
  scopeId: string;
  name: string;
  /** Missing in existing preferences means the project root. */
  parentId?: string | null;
}
export interface BlueprintFolderOrganization {
  folders: BlueprintFolder[];
  placements: Record<string, string>;
  collapsedIds: string[];
}
export type BlueprintNavigatorDrag =
  | { kind: 'blueprint'; scopeId: string; locatorKey: string }
  | { kind: 'folder'; scopeId: string; folderId: string };

export const emptyBlueprintFolders = (): BlueprintFolderOrganization => ({ folders: [], placements: {}, collapsedIds: [] });
const placementKey = (scopeId: string, planKey: string) => JSON.stringify([scopeId, planKey]);

/** Walk upward defensively, including when reading malformed older preferences. */
export function blueprintFolderAncestors(state: BlueprintFolderOrganization, id: string | null): BlueprintFolder[] {
  const ancestors: BlueprintFolder[] = [];
  const seen = new Set<string>();
  let folder = state.folders.find(f => f.id === id);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    ancestors.unshift(folder);
    const scopeId = folder.scopeId;
    const parentId = folder.parentId;
    folder = state.folders.find(f => f.id === parentId && f.scopeId === scopeId);
  }
  return ancestors;
}
function validParent(state: BlueprintFolderOrganization, scopeId: string, id: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  const parent = state.folders.find(f => f.id === parentId);
  return Boolean(parent && parent.scopeId === scopeId && !blueprintFolderAncestors(state, parentId).some(f => f.id === id));
}
function expandAncestors(state: BlueprintFolderOrganization, id: string | null): string[] {
  const expanded = new Set(blueprintFolderAncestors(state, id).map(f => f.id));
  return state.collapsedIds.filter(value => !expanded.has(value));
}
export function normalizeBlueprintFolders(value: unknown): BlueprintFolderOrganization {
  const result = emptyBlueprintFolders();
  if (!value || typeof value !== 'object') return result;
  const raw = value as Partial<BlueprintFolderOrganization>;
  for (const folder of Array.isArray(raw.folders) ? raw.folders : []) {
    if (folder && typeof folder.id === 'string' && folder.id && typeof folder.scopeId === 'string' && folder.scopeId && typeof folder.name === 'string' && folder.name.trim() && !result.folders.some(f => f.id === folder.id)) {
      result.folders.push({ id: folder.id, scopeId: folder.scopeId, name: folder.name.trim().slice(0, 80), parentId: typeof folder.parentId === 'string' && folder.parentId ? folder.parentId : null });
    }
  }
  // Invalid edges become roots, preserving the folders and their blueprints.
  result.folders = result.folders.map(folder => ({ ...folder, parentId: validParent(result, folder.scopeId, folder.id, folder.parentId ?? null) ? folder.parentId : null }));
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
export function nameBlueprintFolder(state: BlueprintFolderOrganization, scopeId: string, id: string, name: string, parentId?: string | null): BlueprintFolderOrganization {
  const existing = state.folders.find(f => f.id === id);
  if (existing && existing.scopeId !== scopeId) throw new Error('invalid-folder-scope');
  const parent = parentId === undefined ? existing?.parentId ?? null : parentId;
  if (!validParent(state, scopeId, id, parent)) throw new Error('invalid-folder-target');
  const normalized = name.trim().slice(0, 80);
  if (!normalized || state.folders.some(f => f.scopeId === scopeId && (f.parentId ?? null) === parent && f.id !== id && f.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error('invalid-folder-name');
  const folder = { id, scopeId, name: normalized, parentId: parent };
  return { ...state, folders: existing ? state.folders.map(f => f.id === id ? folder : f) : [...state.folders, folder], collapsedIds: expandAncestors(state, parent) };
}
export function canMoveBlueprintFolder(state: BlueprintFolderOrganization, id: string, parentId: string | null): boolean {
  const folder = state.folders.find(f => f.id === id);
  return Boolean(folder && validParent(state, folder.scopeId, id, parentId) && !state.folders.some(f => f.id !== id && f.scopeId === folder.scopeId && (f.parentId ?? null) === parentId && f.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase()));
}
export function moveBlueprintFolder(state: BlueprintFolderOrganization, id: string, parentId: string | null): BlueprintFolderOrganization {
  if (!canMoveBlueprintFolder(state, id, parentId)) throw new Error('invalid-folder-target');
  return { ...state, folders: state.folders.map(folder => folder.id === id ? { ...folder, parentId } : folder), collapsedIds: expandAncestors(state, parentId) };
}
/** Preorder also supplies the path for compact destination pickers. */
export function blueprintFolderTree(state: BlueprintFolderOrganization, scopeId: string): { folder: BlueprintFolder; depth: number; path: string }[] {
  const rows: { folder: BlueprintFolder; depth: number; path: string }[] = [];
  const visit = (parentId: string | null, depth: number, prefix: string) => {
    for (const folder of state.folders.filter(f => f.scopeId === scopeId && (f.parentId ?? null) === parentId)) {
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
      rows.push({ folder, depth, path });
      visit(folder.id, depth + 1, path);
    }
  };
  visit(null, 0, '');
  return rows;
}
export function moveBlueprintToFolder(state: BlueprintFolderOrganization, scopeId: string, planKey: string, folderId: string | null): BlueprintFolderOrganization {
  if (!planKey || (folderId && !state.folders.some(f => f.id === folderId && f.scopeId === scopeId))) throw new Error('invalid-folder-target');
  const placements = { ...state.placements };
  const key = placementKey(scopeId, planKey);
  if (folderId) placements[key] = folderId;
  else delete placements[key];
  return { ...state, placements, collapsedIds: expandAncestors(state, folderId) };
}
/** Remove only the container. Promote its contents one level, never delete them. */
export function removeBlueprintFolder(state: BlueprintFolderOrganization, id: string): BlueprintFolderOrganization {
  const removed = state.folders.find(f => f.id === id);
  if (!removed) return state;
  const parentId = removed.parentId ?? null;
  const retained = state.folders.filter(f => f.id !== id && f.parentId !== id);
  const names = new Set(retained.filter(f => f.scopeId === removed.scopeId && (f.parentId ?? null) === parentId).map(f => f.name.toLocaleLowerCase()));
  const promoted = state.folders.filter(f => f.parentId === id).map(folder => {
    let name = folder.name;
    let suffix = 2;
    while (names.has(name.toLocaleLowerCase())) { const ending = ` (${suffix++})`; name = folder.name.slice(0, 80 - ending.length) + ending; }
    names.add(name.toLocaleLowerCase());
    return { ...folder, parentId, name };
  });
  const placements = { ...state.placements };
  for (const [key, target] of Object.entries(placements)) {
    if (target !== id) continue;
    if (parentId) placements[key] = parentId;
    else delete placements[key];
  }
  return { folders: [...retained, ...promoted], placements, collapsedIds: expandAncestors(state, parentId).filter(value => value !== id) };
}
