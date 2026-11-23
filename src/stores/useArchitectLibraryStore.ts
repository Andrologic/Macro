import { create } from "zustand";
import { createEmptyBlueprintDocument } from "../services/agsdl/design";
import {
  architectLibrary, type ArchitectProject, type BlueprintDraft, type BlueprintSummary,
  type BlueprintVersion, type BlueprintVersionSummary, type VersionKey,
} from "../services/ipc/architectLibrary";
import { useAgsdlStore } from "./useAgsdlStore";

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
  /** Every project's blueprints, for the library tree. The selected project's entry mirrors `blueprints`. */
  projectBlueprints: Record<string, Read<BlueprintSummary[]>>;
  versions: Read<BlueprintVersionSummary[]>;
  restoreSelection: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshBlueprints: () => Promise<void>;
  refreshProjectBlueprints: (projectId: string) => Promise<void>;
  refreshAllBlueprints: () => Promise<void>;
  refreshVersions: () => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  selectBlueprint: (projectId: string, blueprintId: string, versionNumber?: number | null) => Promise<void>;
  selectVersion: (number: number | null) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  createBlueprint: (projectId: string, name: string) => Promise<void>;
  adaptRecoveryDraft: (blueprintId: string, expectedRevision: number, projectId: string, name: string) => Promise<void>;
  adaptVersion: (key: VersionKey, projectId: string, name: string) => Promise<void>;
  commitImport: (handle: string, projectId: string, name: string) => Promise<void>;
  deleteVersion: (key: VersionKey) => Promise<void>;
  saveVersion: (blueprintId: string, note: string | null) => Promise<void>;
}

const selectionKey = "macro_architect_library_selection_v1";
function rememberSelection(projectId: string | null, blueprintId: string | null, versionNumber: number | null) {
  localStorage.setItem(selectionKey, JSON.stringify({ projectId, blueprintId, versionNumber }));
}

export function confirmedBlueprintDraft({ draft, draftStatus, versionNumber }: ArchitectLibraryState) {
  return draftStatus === "idle" && versionNumber === null ? draft : null;
}

export function selectedBlueprintForConversation(conversationId: string) {
  const draft = confirmedBlueprintDraft(useArchitectLibraryStore.getState());
  return draft?.conversationId === conversationId && !draft.archived && draft.storageState !== "recovery" ? draft : null;
}

export const useArchitectLibraryStore = create<ArchitectLibraryState>((set, get) => {
  let draftRequest = 0;
  let versionRequest = 0;
  const catalogRequests = { projects: 0, blueprints: 0, versions: 0 };
  const projectRequests = new Map<string, number>();
  const nextProjectRequest = (projectId: string) => {
    const request = (projectRequests.get(projectId) ?? 0) + 1;
    projectRequests.set(projectId, request);
    return request;
  };
  // A refresh keeps showing the last list instead of flashing a loading state.
  const publishProject = (projectId: string, request: number, result: Read<BlueprintSummary[]>) => {
    if (projectRequests.get(projectId) !== request) return;
    set(state => {
      const previous = state.projectBlueprints[projectId];
      return { projectBlueprints: { ...state.projectBlueprints,
        [projectId]: result.status === "loading" && previous?.status === "ready" ? previous : result } };
    });
  };

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

  const openDraft = (draft: BlueprintDraft, versionNumber: number | null = null) => {
    useAgsdlStore.getState().openBlueprintDocument(draft);
    rememberSelection(draft.projectId, draft.id, versionNumber);
    set({ blueprintId: draft.id, draft, draftStatus: "idle", versionNumber });
    return Promise.all([get().refreshVersions(), versionNumber === null ? undefined : get().selectVersion(versionNumber)]);
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
    projectBlueprints: {},
    versions: { status: "idle" },
    async restoreSelection() {
      if (get().projectId || draftRequest) return;
      let saved;
      try { saved = JSON.parse(localStorage.getItem(selectionKey) || "null"); } catch { return; }
      if (typeof saved?.projectId !== "string") return;
      if (typeof saved.blueprintId !== "string") { await get().selectProject(saved.projectId); return; }
      await get().selectBlueprint(saved.projectId, saved.blueprintId, Number.isSafeInteger(saved.versionNumber) ? saved.versionNumber : null);
    },
    refreshProjects: () => readCatalog("projects", () => architectLibrary.listProjects(), projects => set({ projects })),
    async refreshBlueprints() {
      const { projectId } = get();
      if (!projectId) return;
      const request = nextProjectRequest(projectId);
      await readCatalog("blueprints", () => architectLibrary.listBlueprints(projectId), blueprints => {
        set({ blueprints });
        publishProject(projectId, request, blueprints);
      });
    },
    async refreshProjectBlueprints(projectId) {
      if (get().projectId === projectId) { await get().refreshBlueprints(); return; }
      const request = nextProjectRequest(projectId);
      publishProject(projectId, request, { status: "loading" });
      try { publishProject(projectId, request, { status: "ready", value: await architectLibrary.listBlueprints(projectId) }); }
      catch { publishProject(projectId, request, { status: "error" }); }
    },
    async refreshAllBlueprints() {
      const { projects } = get();
      if (projects.status === "ready") await Promise.all(projects.value.map(project => get().refreshProjectBlueprints(project.id)));
    },
    async refreshVersions() {
      const { draft } = get();
      if (draft) await readCatalog("versions", () => architectLibrary.listVersions(draft.id), versions => set({ versions }));
    },
    async selectProject(projectId) {
      if (get().projectId !== projectId) {
        rememberSelection(projectId, null, null);
        catalogRequests.blueprints++;
        set({ ...clearDocument(), projectId, blueprints: { status: "idle" } });
      }
      await get().refreshBlueprints();
    },
    async selectBlueprint(projectId, blueprintId, versionNumber = null) {
      if (get().projectId === projectId && get().draft?.id === blueprintId) {
        await get().selectVersion(versionNumber);
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
        await openDraft(draft, versionNumber);
      } catch {
        if (request === draftRequest) set({ draftStatus: "error" });
      }
    },
    async selectVersion(number) {
      const { draft, versionNumber, draftStatus } = get();
      if (!draft) return;
      const request = ++versionRequest;
      rememberSelection(draft.projectId, draft.id, number);
      if (number === null) {
        if (versionNumber === null && draftStatus === "idle") return;
        set({ draftStatus: "loading", versionNumber: null, version: { status: "idle" } });
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
    async adaptRecoveryDraft(blueprintId, expectedRevision, projectId, name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const draft = await architectLibrary.adaptRecoveryDraft(blueprintId, expectedRevision, projectId, name.trim());
      await revealNewDraft(draft, requestedDraft, requestedVersion);
    },
    async adaptVersion(key, projectId, name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const draft = await architectLibrary.adaptVersion(key, projectId, name.trim());
      await revealNewDraft(draft, requestedDraft, requestedVersion);
    },
    async commitImport(handle, projectId, name) {
      const requestedDraft = draftRequest;
      const requestedVersion = versionRequest;
      const { draft } = await architectLibrary.commitImport(handle, projectId, name.trim());
      await revealNewDraft(draft, requestedDraft, requestedVersion);
    },
    async deleteVersion(key) {
      await architectLibrary.deleteVersion(key);
      if (get().draft?.id !== key.blueprintId) return;
      if (get().versionNumber === key.number) await get().selectVersion(null);
      await get().refreshVersions();
    },
    async saveVersion(blueprintId, note) {
      const draft = confirmedBlueprintDraft(get());
      if (draft?.id !== blueprintId || draft.archived) throw new Error("No editable draft selected");
      const request = versionRequest;
      await useAgsdlStore.getState().saveVersion(blueprintId, note?.trim() || null, () =>
        request === versionRequest && get().draft?.id === blueprintId);
      if (get().draft?.id === blueprintId) await get().refreshVersions();
    },
  };
});
