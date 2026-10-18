import { describe, expect, it } from 'bun:test';
import { blueprintFolderId, emptyBlueprintFolders, moveBlueprintToFolder, nameBlueprintFolder, normalizeBlueprintFolders, removeBlueprintFolder } from './blueprintFolders';

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
