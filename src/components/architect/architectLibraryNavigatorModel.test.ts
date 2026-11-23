import { expect, it } from "bun:test";
import type { BlueprintSummary, BlueprintVersionSummary } from "../../services/ipc/architectLibrary";
import {
  archivedEntries, blueprintMenu, createMenu, isDraftModified, libraryEntries, projectMenu, versionMenu,
  visibleVersions, VISIBLE_VERSIONS,
} from "./architectLibraryNavigatorModel";

const version = (number: number, extra: Partial<BlueprintVersionSummary> = {}): BlueprintVersionSummary =>
  ({ blueprintId: "b", number, revision: number, note: null, storageState: "archive", ...extra });
const blueprint = (id: string, name: string, extra: Partial<BlueprintSummary> = {}): BlueprintSummary =>
  ({ id, projectId: "p", name, revision: 1, origin: null, archived: false, conversationId: null, ...extra });

it("shows the most recent versions first and keeps repair entries visible", () => {
  const all = Array.from({ length: 8 }, (_, index) => version(index + 1));
  all[0] = version(1, { storageState: "recovery" });
  const collapsed = visibleVersions(all, false);
  expect(collapsed.rows.map(row => row.number)).toEqual([8, 7, 6, 5, 4, 1]);
  expect(collapsed.rows.length).toBe(VISIBLE_VERSIONS + 1);
  expect(collapsed.hidden).toBe(2);
  const everything = visibleVersions(all, true);
  expect(everything.rows.map(row => row.number)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  expect(everything.hidden).toBe(0);
});

it("marks the draft modified only once it moved past the latest saved version", () => {
  expect(isDraftModified(2, [])).toBe(false);
  expect(isDraftModified(undefined, [version(1)])).toBe(false);
  expect(isDraftModified(3, [version(1, { revision: 3 })])).toBe(false);
  expect(isDraftModified(4, [version(1, { revision: 3 })])).toBe(true);
  // A version that could not be recovered says nothing about the draft.
  expect(isDraftModified(9, [version(2, { revision: 9, storageState: "recovery" }), version(1, { revision: 9 })])).toBe(false);
  expect(isDraftModified(9, [version(2, { revision: 2, storageState: "recovery" })])).toBe(false);
});

it("filters projects and blueprints by name, opens matching projects, and keeps archives apart", () => {
  const projects = [{ id: "p", name: "Mes systèmes" }, { id: "q", name: "Essais" }];
  const all: Record<string, BlueprintSummary[]> = {
    p: [blueprint("1", "Revue de code"), blueprint("2", "Veille"), blueprint("3", "Ancien", { archived: true })],
    q: [blueprint("4", "Revue rapide", { projectId: "q" })],
  };
  const of = (id: string) => all[id] ?? [];
  expect(libraryEntries(projects, of, "").map(entry => [entry.project.id, entry.blueprints.length, entry.matched])).toEqual([["p", 2, false], ["q", 1, false]]);
  const revue = libraryEntries(projects, of, " revue ");
  expect(revue.map(entry => [entry.project.id, entry.blueprints.map(item => item.id), entry.matched])).toEqual([["p", ["1"], true], ["q", ["4"], true]]);
  expect(libraryEntries(projects, of, "essais")[0].blueprints.map(item => item.id)).toEqual(["4"]);
  expect(libraryEntries(projects, of, "inconnu")).toEqual([]);
  expect(archivedEntries(projects, of, "").map(entry => entry.blueprint.id)).toEqual(["3"]);
  expect(archivedEntries(projects, of, "veille")).toEqual([]);
});

it("offers only what makes sense for each kind of entry", () => {
  expect(projectMenu().map(action => action.id)).toEqual(["newBlueprint", "importFile", "importFolder"]);
  expect(createMenu(false).map(action => action.id)).toEqual(["newProject"]);
  expect(createMenu(true).map(action => action.id)).toEqual(["newProject", "newBlueprint"]);
  expect(blueprintMenu({ archived: false }, false).map(action => action.id)).toEqual(["saveVersion", "exportDraft"]);
  expect(blueprintMenu({ archived: true }, false)).toEqual([]);
  expect(blueprintMenu({ archived: false }, true)).toEqual([]);
  const normal = versionMenu({ storageState: "archive" }).map(action => action.id);
  expect(normal).toEqual(["open", "adapt", "exportArchive", "exportFolder", "delete"]);
  // A version to repair is neither exported nor launched: those entries are absent, not disabled.
  const repair = versionMenu({ storageState: "recovery" }).map(action => action.id);
  expect(repair).toEqual(["adaptRepair", "downloadOriginal", "delete"]);
  expect(versionMenu({ storageState: "recovery" }).find(action => action.id === "delete")?.danger).toBe(true);
});
