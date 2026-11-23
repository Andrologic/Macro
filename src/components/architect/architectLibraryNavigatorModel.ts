import type { ArchitectProject, BlueprintSummary, BlueprintVersionSummary } from "../../services/ipc/architectLibrary";
import type { IconName } from "../ui/Icon";

/** Older versions stay one click away: recovery entries are always visible. */
export const VISIBLE_VERSIONS = 5;

export const sortVersions = (versions: readonly BlueprintVersionSummary[]) =>
  versions.slice().sort((a, b) => b.number - a.number);

export function visibleVersions(versions: readonly BlueprintVersionSummary[], showAll: boolean) {
  const sorted = sortVersions(versions);
  if (showAll) return { rows: sorted, hidden: 0 };
  const recent = new Set(sorted.slice(0, VISIBLE_VERSIONS).map(version => version.number));
  const rows = sorted.filter(version => recent.has(version.number) || version.storageState === "recovery");
  return { rows, hidden: sorted.length - rows.length };
}

/** The draft moved on from the latest saved version. Without a version there is nothing to compare. */
export function isDraftModified(draftRevision: number | undefined, versions: readonly BlueprintVersionSummary[]) {
  if (draftRevision === undefined) return false;
  const latest = sortVersions(versions).find(version => version.storageState !== "recovery");
  return !!latest && draftRevision > latest.revision;
}

export interface LibraryEntry {
  project: ArchitectProject;
  /** Blueprints still being designed. Archived ones live in their own group. */
  blueprints: BlueprintSummary[];
  /** The project matches the search, or one of its blueprints does: show it open. */
  matched: boolean;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase();

/** Search looks at project and blueprint names, never at notes. A project match keeps all its blueprints. */
export function libraryEntries(
  projects: readonly ArchitectProject[],
  blueprintsOf: (projectId: string) => readonly BlueprintSummary[],
  query: string,
): LibraryEntry[] {
  const needle = normalize(query);
  return projects.flatMap((project): LibraryEntry[] => {
    const all = blueprintsOf(project.id).filter(blueprint => !blueprint.archived);
    if (!needle) return [{ project, blueprints: all, matched: false }];
    if (normalize(project.name).includes(needle)) return [{ project, blueprints: all, matched: true }];
    const blueprints = all.filter(blueprint => normalize(blueprint.name).includes(needle));
    return blueprints.length ? [{ project, blueprints, matched: true }] : [];
  });
}

export function archivedEntries(
  projects: readonly ArchitectProject[],
  blueprintsOf: (projectId: string) => readonly BlueprintSummary[],
  query: string,
) {
  const needle = normalize(query);
  return projects.flatMap(project => blueprintsOf(project.id)
    .filter(blueprint => blueprint.archived && (!needle || normalize(blueprint.name).includes(needle) || normalize(project.name).includes(needle)))
    .map(blueprint => ({ project, blueprint })));
}

export interface MenuAction { id: string; icon: IconName; danger?: boolean }

export const projectMenu = (): MenuAction[] => [
  { id: "newBlueprint", icon: "plus" },
  { id: "importFile", icon: "upload" },
  { id: "importFolder", icon: "folder-open" },
];

export const createMenu = (hasProject: boolean): MenuAction[] => [
  { id: "newProject", icon: "folder" },
  ...(hasProject ? [{ id: "newBlueprint", icon: "layout-template" as const }] : []),
];

export const importMenu = (): MenuAction[] => [
  { id: "importFile", icon: "file-text" },
  { id: "importFolder", icon: "folder-open" },
];

/** A blueprint's draft is where work happens. Archived and recovery drafts offer nothing to do from the tree. */
export function blueprintMenu(blueprint: Pick<BlueprintSummary, "archived">, recovery: boolean): MenuAction[] {
  if (blueprint.archived || recovery) return [];
  return [{ id: "saveVersion", icon: "save" }, { id: "exportDraft", icon: "download" }];
}

/** A version that could not become an archive can be repaired or downloaded, never exported or run. */
export function versionMenu(version: Pick<BlueprintVersionSummary, "storageState">): MenuAction[] {
  if (version.storageState === "recovery") return [
    { id: "adaptRepair", icon: "copy" },
    { id: "downloadOriginal", icon: "download" },
    { id: "delete", icon: "trash", danger: true },
  ];
  return [
    { id: "open", icon: "eye" },
    { id: "adapt", icon: "copy" },
    { id: "exportArchive", icon: "archive" },
    { id: "exportFolder", icon: "folder-open" },
    { id: "delete", icon: "trash", danger: true },
  ];
}
