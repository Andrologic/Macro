import { create } from "zustand";
import { createEmptyBlueprintDocument } from "../services/agsdl/design";
import {
  architectLibrary, type ArchitectProject, type BlueprintDraft, type BlueprintSummary,
  type BlueprintVersion, type BlueprintVersionSummary, type VersionKey,
} from "../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "./useAgsdlStore";

type Read<T> =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; value: T };

interface ArchitectLibraryState {
  projectId: string | null;
  blueprintId: string | null;
  /** Confirmed selection. The live document and revision belong to useAgsdlStore. */
  draft: BlueprintDraft | null;
  draftStatus: "idle" | "loading" | "error";
  versionNumber: number | null;
  version: Read<BlueprintVersion>;
  projects: Read<ArchitectProject[]>;
  blueprints: Read<BlueprintSummary[]>;
  versions: Read<BlueprintVersionSummary[]>;
  refreshProjects: () => Promise<void>;
  refreshBlueprints: () => Promise<void>;
  refreshVersions: () => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  selectBlueprint: (projectId: string, blueprintId: string) => Promise<void>;
  selectVersion: (number: number | null) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  createBlueprint: (projectId: string, name: string) => Promise<void>;
  adaptVersion: (key: VersionKey, projectId: string, name: string) => Promise<void>;
  saveVersion: (blueprintId: string, note: string | null) => Promise<void>;
}

export const useArchitectLibraryStore = create<ArchitectLibraryState>((set, get) => {
  let draftRequest = 0;
  let versionRequest = 0;
  const catalogRequests = { projects: 0, blueprints: 0, versions: 0 };

  async function readCatalog<K extends keyof typeof catalogRequests, T>(
    key: K,
    read: () => Promise<T>,
    publish: (result: Read<T>) => void,
  ) {
    const request = ++catalogRequests[key];
    publish({ status: "loading" });
    try {
      const value = await read();
      if (request === catalogRequests[key]) publish({ status: "ready", value });
    } catch {
      if (request === catalogRequests[key]) publish({ status: "error" });
    }
  }

  const clearDocument = () => {
    draftRequest++;
    versionRequest++;
    catalogRequests.versions++;
    return {
      blueprintId: null, draft: null, draftStatus: "idle", versionNumber: null,
      version: { status: "idle" }, versions: { status: "idle" },
    } as const;
  };

  const openDraft = (draft: BlueprintDraft) => {
    useAgsdlStore.getState().openBlueprintDocument(draft);
    set({ blueprintId: draft.id, draft, draftStatus: "idle" });
    return get().refreshVersions();
  };

  async function revealNewDraft(draft: BlueprintDraft, requestedDraft: number, requestedVersion: number) {
    if (requestedDraft !== draftRequest || requestedVersion !== versionRequest) {
      if (get().projectId === draft.projectId) await get().refreshBlueprints();
      return;
    }
    set({ ...clearDocument(), projectId: draft.projectId, blueprints: { status: "idle" } });
    await Promise.all([openDraft(draft), get().refreshBlueprints()]);
  }

  return {
    projectId: null,
    blueprintId: null,
    draft: null,
    draftStatus: "idle",
    versionNumber: null,
    version: { status: "idle" },
    projects: { status: "idle" },
    blueprints: { status: "idle" },
    versions: { status: "idle" },
    refreshProjects: () => readCatalog("projects", () => architectLibrary.listProjects(), projects => set({ projects })),
    async refreshBlueprints() {
      const { projectId } = get();
      if (projectId) await readCatalog("blueprints", () => architectLibrary.listBlueprints(projectId), blueprints => set({ blueprints }));
    },
    async refreshVersions() {
      const { draft } = get();
      if (draft) await readCatalog("versions", () => architectLibrary.listVersions(draft.id), versions => set({ versions }));
    },
    async selectProject(projectId) {
      if (get().projectId !== projectId) {
        catalogRequests.blueprints++;
        set({ ...clearDocument(), projectId, blueprints: { status: "idle" } });
      }
      await get().refreshBlueprints();
    },
    async selectBlueprint(projectId, blueprintId) {
      if (get().projectId === projectId && get().draft?.id === blueprintId) {
        await get().selectVersion(null);
        return;
      }
      const projectChanged = get().projectId !== projectId;
      const cleared = clearDocument();
      const request = draftRequest;
      set({ ...cleared, projectId, blueprintId, draftStatus: "loading",
        ...(projectChanged ? { blueprints: { status: "idle" } as const } : {}),
      });
      if (projectChanged) void get().refreshBlueprints();
      try {
        const draft = await architectLibrary.getDraft(blueprintId);
        if (draftRequest !== request) return;
        if (draft.id !== blueprintId || draft.projectId !== projectId) throw new Error("Unexpected blueprint identity");
        await openDraft(draft);
      } catch {
        if (request === draftRequest) set({ draftStatus: "error" });
      }
    },
    async selectVersion(number) {
      const { draft, versionNumber, draftStatus } = get();
      if (!draft) return;
      const request = ++versionRequest;
      if (number === null) {
        if (versionNumber === null && draftStatus === "idle") return;
        const editor = useAgsdlStore.getState();
        const current = editor.sessions[agsdlSessionKey({ blueprintId: draft.id })];
        const keepLocal = current?.dirty || current?.saving;
        set({ draftStatus: keepLocal ? "idle" : "loading", versionNumber: null, version: { status: "idle" } });
        if (keepLocal) return;
        try {
          const fresh = await architectLibrary.getDraft(draft.id);
          if (request !== versionRequest) return;
          if (fresh.id !== draft.id || fresh.projectId !== draft.projectId) throw new Error("Unexpected blueprint identity");
          useAgsdlStore.getState().openBlueprintDocument(fresh);
          set({ draft: fresh, draftStatus: "idle" });
        } catch {
          if (request === versionRequest) set({ draftStatus: "error" });
        }
        return;
      }
      set({ draftStatus: "idle", versionNumber: number, version: { status: "loading" } });
      try {
        const version = await architectLibrary.getVersion({ blueprintId: draft.id, number });
        if (request !== versionRequest) return;
        if (version.blueprintId !== draft.id || version.number !== number) throw new Error("Unexpected version identity");
        useAgsdlStore.getState().openBlueprintDocument(version);
        set({ version: { status: "ready", value: version } });
      } catch {
        if (request === versionRequest) set({ version: { status: "error" } });
      }
    },
    async createProject(name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const project = await architectLibrary.createProject(name.trim());
      await Promise.all([
        get().refreshProjects(),
        requestedDraft === draftRequest && requestedVersion === versionRequest ? get().selectProject(project.id) : undefined,
      ]);
    },
    async createBlueprint(projectId, name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const draft = await architectLibrary.createBlueprint(projectId, name.trim(), createEmptyBlueprintDocument(name.trim()));
      await revealNewDraft(draft, requestedDraft, requestedVersion);
    },
    async adaptVersion(key, projectId, name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const draft = await architectLibrary.adaptVersion(key, projectId, name.trim());
      await revealNewDraft(draft, requestedDraft, requestedVersion);
    },
    async saveVersion(blueprintId, note) {
      const { draft, versionNumber, draftStatus } = get();
      if (draftStatus !== "idle" || draft?.id !== blueprintId || draft.archived || versionNumber !== null) throw new Error("No editable draft selected");
      await useAgsdlStore.getState().saveVersion(blueprintId, note?.trim() || null);
      if (get().draft?.id === blueprintId) await get().refreshVersions();
    },
  };
});
