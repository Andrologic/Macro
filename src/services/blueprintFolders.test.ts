import { describe, expect, it } from 'bun:test';
import { blueprintFolderId, blueprintFolderAncestors, blueprintFolderTree, canMoveBlueprintFolder, moveBlueprintFolder, emptyBlueprintFolders, moveBlueprintToFolder, nameBlueprintFolder, normalizeBlueprintFolders, removeBlueprintFolder } from './blueprintFolders';

describe('blueprint navigation folders', () => {
  it('keeps branches and project scopes separate and rejects cross-project targets', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'project:a', 'f', 'Releases');
    state = moveBlueprintToFolder(state, 'project:a', '["develop","plan"]', 'f');
    expect(blueprintFolderId(state, 'project:a', '["develop","plan"]')).toBe('f');
    expect(blueprintFolderId(state, 'project:a', '["main","plan"]')).toBeNull();
    expect(blueprintFolderId(state, 'project:b', '["develop","plan"]')).toBeNull();
    expect(() => moveBlueprintToFolder(state, 'project:b', 'plan', 'f')).toThrow('invalid-folder-target');
    expect(() => moveBlueprintToFolder(state, 'project:a', 'plan', 'missing')).toThrow('invalid-folder-target');
  });
  it('returns every blueprint to the root when a folder is removed', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'project:a', 'f', 'Delivery');
    state = moveBlueprintToFolder(state, 'project:a', 'one', 'f');
    state = moveBlueprintToFolder(state, 'project:a', 'two', 'f');
    const result = removeBlueprintFolder(state, 'f');
    expect(result.folders).toEqual([]);
    expect(blueprintFolderId(result, 'project:a', 'one')).toBeNull();
    expect(blueprintFolderId(result, 'project:a', 'two')).toBeNull();
    expect(state.placements).not.toEqual({});
  });
  it('renames without changing assignments and prevents duplicate names within a project', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'project:a', 'f', ' Releases ');
    state = moveBlueprintToFolder(state, 'project:a', 'one', 'f');
    expect(() => nameBlueprintFolder(state, 'project:a', 'g', 'releases')).toThrow();
    expect(() => nameBlueprintFolder(state, 'project:a', 'g', '   ')).toThrow();
    state = nameBlueprintFolder(state, 'project:a', 'f', 'Shipping');
    expect(blueprintFolderId(state, 'project:a', 'one')).toBe('f');
    expect(nameBlueprintFolder(state, 'project:b', 'g', 'Shipping').folders).toHaveLength(2);
    expect(() => nameBlueprintFolder(state, 'project:b', 'f', 'Other')).toThrow();
  });
  it('normalizes persisted state and discards invalid or foreign assignments', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'project:a', 'f', 'Delivery');
    state = moveBlueprintToFolder(state, 'project:a', 'one', 'f');
    expect(normalizeBlueprintFolders(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(normalizeBlueprintFolders({ ...state, folders: [...state.folders, null, state.folders[0]], placements: { ...state.placements, invalid: 'f', '["project:b","other"]': 'f' }, collapsedIds: ['f', 'missing', 'f'] })).toEqual({ ...state, collapsedIds: ['f'] });
    expect(normalizeBlueprintFolders(null)).toEqual(emptyBlueprintFolders());
  });
  it('expands the destination after a move, and can return a blueprint to the root', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'project:a', 'f', 'Delivery');
    state.collapsedIds = ['f'];
    state = moveBlueprintToFolder(state, 'project:a', 'one', 'f');
    expect(state.collapsedIds).toEqual([]);
    state = moveBlueprintToFolder(state, 'project:a', 'one', null);
    expect(blueprintFolderId(state, 'project:a', 'one')).toBeNull();
  });
});

describe('nested blueprint folders', () => {
  it('creates nested folders, allows repeated names in separate parents and expands the path', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'p', 'a', 'Delivery');
    state = nameBlueprintFolder(state, 'p', 'b', 'Mobile', 'a');
    state = nameBlueprintFolder(state, 'p', 'c', 'Desktop', 'a');
    state = nameBlueprintFolder(state, 'p', 'd', 'Checks', 'b');
    state = nameBlueprintFolder(state, 'p', 'e', 'Checks', 'c');
    state.collapsedIds = ['a', 'b', 'd', 'c'];
    state = moveBlueprintToFolder(state, 'p', 'plan', 'd');
    expect(state.collapsedIds).toEqual(['c']);
    expect(blueprintFolderTree(state, 'p').map(row => [row.folder.id, row.depth, row.path])).toContainEqual(['d', 2, 'Delivery / Mobile / Checks']);
    expect(() => nameBlueprintFolder(state, 'p', 'other', 'checks', 'b')).toThrow();
  });
  it('moves a complete subtree and rejects self, descendant, foreign and duplicate sibling targets', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'p', 'a', 'Delivery');
    state = nameBlueprintFolder(state, 'p', 'b', 'Mobile', 'a');
    state = nameBlueprintFolder(state, 'p', 'c', 'Product');
    state = nameBlueprintFolder(state, 'q', 'foreign', 'Other project');
    state = moveBlueprintToFolder(state, 'p', 'plan', 'b');
    expect(canMoveBlueprintFolder(state, 'a', 'a')).toBe(false);
    expect(canMoveBlueprintFolder(state, 'a', 'b')).toBe(false);
    expect(canMoveBlueprintFolder(state, 'a', 'foreign')).toBe(false);
    expect(() => moveBlueprintFolder(state, 'a', 'b')).toThrow();
    state = moveBlueprintFolder(state, 'a', 'c');
    expect(blueprintFolderAncestors(state, 'b').map(f => f.id)).toEqual(['c', 'a', 'b']);
    expect(blueprintFolderId(state, 'p', 'plan')).toBe('b');
    state = nameBlueprintFolder(state, 'p', 'duplicate', 'Mobile', 'c');
    expect(canMoveBlueprintFolder(state, 'b', 'c')).toBe(false);
    state = moveBlueprintFolder(state, 'a', null);
    expect(blueprintFolderAncestors(state, 'b').map(f => f.id)).toEqual(['a', 'b']);
  });
  it('promotes contents one level on removal without losing nested plans or colliding names', () => {
    let state = nameBlueprintFolder(emptyBlueprintFolders(), 'p', 'a', 'Delivery');
    state = nameBlueprintFolder(state, 'p', 'b', 'Mobile', 'a');
    state = nameBlueprintFolder(state, 'p', 'c', 'Checks', 'b');
    state = nameBlueprintFolder(state, 'p', 'd', 'Checks', 'a');
    state = nameBlueprintFolder(state, 'p', 'e', 'Deeper', 'c');
    state = moveBlueprintToFolder(state, 'p', 'direct', 'b');
    state = moveBlueprintToFolder(state, 'p', 'nested', 'e');
    state = removeBlueprintFolder(state, 'b');
    expect(blueprintFolderId(state, 'p', 'direct')).toBe('a');
    expect(blueprintFolderId(state, 'p', 'nested')).toBe('e');
    expect(state.folders.find(f => f.id === 'c')).toMatchObject({ parentId: 'a', name: 'Checks (2)' });
    expect(blueprintFolderAncestors(state, 'e').map(f => f.id)).toEqual(['a', 'c', 'e']);
  });
  it('migrates flat preferences and repairs cycles or unknown parents without discarding folders', () => {
    const state = normalizeBlueprintFolders({ folders: [
      { id: 'legacy', scopeId: 'p', name: 'Legacy' },
      { id: 'a', scopeId: 'p', name: 'A', parentId: 'b' },
      { id: 'b', scopeId: 'p', name: 'B', parentId: 'a' },
      { id: 'missing', scopeId: 'p', name: 'Missing', parentId: 'unknown' },
      { id: 'foreign', scopeId: 'q', name: 'Foreign', parentId: 'legacy' },
    ] });
    expect(state.folders).toHaveLength(5);
    expect(state.folders.every(f => f.parentId === null)).toBe(true);
    expect(blueprintFolderTree(state, 'p')).toHaveLength(4);
    expect(normalizeBlueprintFolders(state)).toEqual(state);
  });
});
