import { create } from "zustand";
import { adaptationChanges,readDesign,retainDesignOrigin,withDocumentDesign,type AgsdlEnvelopeMetadata,type DesignMetadata } from "../services/agsdl/design";
import {
applyChanges,
AGSDL_CONTRACT,
AGSDL_020_CONTRACT,
MAX_AGSDL_BYTES,
readDocument,
scanSource,
object,
validateDocument,
} from "../services/agsdl/document";
import { AgsdlUserError } from "../services/agsdl/userErrors";
import type { ArchitectPlanStatus } from "../services/architectPlanService";
import {
getArchitectPlan,
updateArchitectPlan,
} from "../services/architectPlanService";
import type { AgsdlChange,AgsdlReport } from "../types/agsdl";
import {
  architectLibrary, type BlueprintDocument, type BlueprintDraft, type BlueprintVersion,
  type BlueprintVersionSummary, type ProjectFile, type MacroSettingsChange, type ProjectView,
} from "../services/ipc/architectLibrary";

import {
  checkBatch, historyBuffers, initialProject, localProjectEdit, prepareProjectEdit, projectHistoryBudget, queueProjectEdit,
  type ProjectEditState, type ProjectOperation,
} from "./agsdl/projectEdits";

export interface AgsdlTarget {
  branchName: string;
  planId: string;
}
export interface BlueprintDocumentTarget {
  blueprintId: string;
  number?: number;
}
export type AgsdlDocumentTarget = AgsdlTarget | BlueprintDocumentTarget;

export const agsdlSessionKey = (target: AgsdlDocumentTarget) =>
  "blueprintId" in target
    ? JSON.stringify(["blueprint", target.blueprintId, target.number ?? null])
    : JSON.stringify([target.branchName, target.planId]);
interface Snapshot extends AgsdlEnvelopeMetadata {
  source: string;
  annexes: Record<string, string>;
}
export interface AgsdlSession extends Snapshot {
  libraryDocument?: BlueprintDocument;
  project?: ProjectEditState;
  draftConflict?: { saved: BlueprintDraft | null };
  version: string;
  persistedRevision: number;
  dirty: boolean;
  saving: boolean;
  status: ArchitectPlanStatus;
  history: Snapshot[];
  future: Snapshot[];
  reports: AgsdlReport[];
  error: string | null;
}
interface AgsdlState {
  sessions: Record<string, AgsdlSession>;
  openBlueprintDocument: (record: BlueprintDraft | BlueprintVersion) => AgsdlSession;
  saveVersion: (blueprintId: string, note: string | null, isCurrent?: () => boolean) => Promise<BlueprintVersionSummary>;
  load: (target: AgsdlDocumentTarget, reload?: boolean) => Promise<AgsdlSession>;
  replace: (
    target: AgsdlDocumentTarget,
    source: string,
    annexes?: Record<string, string>,
    expectedVersion?: string,
    metadata?: AgsdlEnvelopeMetadata,
  ) => void;
  setDesign: (target: AgsdlDocumentTarget, design: DesignMetadata, expectedVersion?: string) => void;
  edit: (
    target: AgsdlDocumentTarget,
    changes: AgsdlChange[],
    expectedVersion?: string,
  ) => void | Promise<void>;
  readProjectFile: (target: BlueprintDocumentTarget, path: string) => Promise<ProjectFile | null>;
  applyProjectBatch: (target: BlueprintDocumentTarget, files: ProjectOperation[], settings?: MacroSettingsChange, expectedVersion?: string, isCurrent?: () => boolean, persist?: boolean) => Promise<void>;
  discardProjectMigrationFile: (target: BlueprintDocumentTarget, path: string) => Promise<void>;
  undo: (target: AgsdlDocumentTarget, redo?: boolean) => void;
  save: (target: AgsdlDocumentTarget) => Promise<void>;
  refreshDraftConflict: (target: BlueprintDocumentTarget) => Promise<void>;
  resolveDraftConflict: (target: BlueprintDocumentTarget, version: string, revision: number, choice: "saved" | "local") => Promise<void>;
  validate: (target: AgsdlDocumentTarget) => Promise<void>;
}
const pendingLoads = new Map<string, Promise<AgsdlSession>>();
function draftContract(source: string): unknown {
  try { return readDocument(source).contract; }
  catch { return undefined; } // Malformed drafts remain repairable.
}
function assertEditableEdition(...sources: string[]): void {
  for (const source of sources) {
    if (draftContract(source) === AGSDL_020_CONTRACT) {
      throw new AgsdlUserError("agsdl.unsupportedEdition020", "AgSDL 0.2 is no longer supported. This document cannot be edited or run.");
    }
  }
}
const snapshot = ({ source, annexes, design, display, migration }: Snapshot): Snapshot => structuredClone({
  source, annexes, design, display, migration,
});
/** Convert the legacy header in an editor snapshot. Keep exact JSON outside its two tokens. */
function upgradeLegacyFlowHeader(source: string): string {
  try {
    const { tree, spans, bytes } = scanSource(source);
    const document = object(tree);
    if (document.contract !== "agsdl-0.3.0") return source;
    const legacySchema = "https://raw.githubusercontent.com/Andrologic/AgSDL/v0.3.0/schema/agsdl.schema.json";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const edits = [{ span: spans.get("/contract")!, value: AGSDL_CONTRACT }];
    if (document.$schema === legacySchema) {
      edits.push({ span: spans.get("/$schema")!, value: legacySchema.replace("v0.3.0", "v0.4.0") });
    }
    let result = "";
    let offset = 0;
    for (const { span, value } of edits.sort((a, b) => a.span.start - b.span.start)) {
      result += decoder.decode(bytes.subarray(offset, span.start)) + JSON.stringify(value);
      offset = span.end;
    }
    return result + decoder.decode(bytes.subarray(offset));
  } catch {
    return source; // Keep malformed editor snapshots available to undo or redo.
  }
}

const upgradeSnapshot = (entry: Snapshot): Snapshot => ({ ...entry, source: upgradeLegacyFlowHeader(entry.source) });
const isStaleRevision = (error: unknown) => {
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : error;
  return message === "Validation error: stale_revision";
};

const draftConflictError = () =>
  new AgsdlUserError("agsdl.library.revisionConflict", "The draft changed elsewhere. Review the conflict before saving.");

const assertDraft = (current: AgsdlSession) => {
  if (current.status !== "draft") throw new AgsdlUserError("agsdl.readOnly", "This document is read-only.");
};

const newSession = (document: BlueprintDocument, persistedRevision: number, status: ArchitectPlanStatus): AgsdlSession => ({
  ...snapshot(document),
  version: crypto.randomUUID(),
  persistedRevision,
  status,
  dirty: false,
  saving: false,
  history: [],
  future: [],
  reports: [],
  error: null,
});

const historyBudget = (history: Snapshot[]) => {
  let bytes = 0;
  return history
    .slice(-30)
    .reverse()
    .filter(
      (item) =>
        (bytes +=
          new TextEncoder().encode(item.source + Object.values(item.annexes).join("") + JSON.stringify({ design: item.design, display: item.display, migration: item.migration })).length) <=
        4 * MAX_AGSDL_BYTES,
    )
    .reverse();
};

export const useAgsdlStore = create<AgsdlState>((set, get) => {
  const session = (target: AgsdlDocumentTarget) => {
    const value = get().sessions[agsdlSessionKey(target)];
    if (!value) throw new Error("Load the AgSDL document first.");
    return value;
  };
  const update = (target: AgsdlDocumentTarget, value: AgsdlSession) =>
    set((state) => ({
      sessions: { ...state.sessions, [agsdlSessionKey(target)]: value },
    }));
  const fromBlueprint = (record: BlueprintDraft | BlueprintVersion): AgsdlSession => {
    const next = newSession(record.document, record.revision,
      "number" in record || record.archived || record.storageState === "recovery" ? "archived" : "draft");
    return record.project
      ? { ...next, project: initialProject(record.project, next.version) }
      : { ...next, libraryDocument: record.document };
  };

  const editConflict = () => new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
  const projectBatchRequired = () => new AgsdlUserError("agsdl.library.projectBatchRequired", "Edit the source files of this project.");
  const projectSaved = (current: AgsdlSession, view: ProjectView, overwritten: boolean): AgsdlSession => {
    const project = current.project!;
    const version = crypto.randomUUID();
    return {
      ...current, version, source: view.projection?.source ?? current.source,
      persistedRevision: view.revision, dirty: false, saving: false, draftConflict: undefined,
      project: {
        ...project, view, saved: view, pending: { files: [] }, queued: [], buffers: new Map(),
        graphRevision: view.projection ? view.revision : project.graphRevision,
        graphVersion: view.projection ? version : project.graphVersion,
        ...(overwritten ? { past: [], future: [] } : {}),
      },
    };
  };

  // Keep the editor's base revision until the user explicitly resolves the conflict.
  async function readConflictingDraft(target: BlueprintDocumentTarget) {
    update(target, { ...session(target), draftConflict: { saved: null } });
    const saved = await architectLibrary.getDraft(target.blueprintId);
    if (saved.id !== target.blueprintId) throw new Error("Unexpected blueprint identity");
    update(target, { ...session(target), draftConflict: { saved } });
  }

  async function handleBlueprintWriteError(target: BlueprintDocumentTarget, error: unknown) {
    if (!isStaleRevision(error)) return error;
    try { await readConflictingDraft(target); }
    catch { /* The conflict remains actionable even if the read needs to be retried. */ }
    return draftConflictError();
  }

  async function saveDocument(
    target: AgsdlDocumentTarget, overwrite?: BlueprintDraft, proposed?: AgsdlSession,
    discardMigrationFile?: string,
  ) {
    const current = session(target);
    if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "A save is already in progress.");
    if (current.draftConflict && !overwrite) throw draftConflictError();
    if (!current.dirty && !proposed && discardMigrationFile === undefined) return;
    assertDraft(current);
    assertEditableEdition(current.source);
    update(target, { ...current, saving: true, error: null });
    try {
      const draft = proposed ?? current;
      if ("blueprintId" in target && draft.project) {
        const batch = discardMigrationFile === undefined ? draft.project.pending
          : { ...draft.project.pending, discardMigrationFiles: [discardMigrationFile] };
        checkBatch(batch);
        const view = await architectLibrary.saveProjectDraft(
          target.blueprintId, overwrite?.revision ?? current.persistedRevision, batch);
        const saved = projectSaved(proposed ?? session(target), view, !!overwrite);
        update(target, saved);
        return saved;
      }
      const document = snapshot(current);
      let revision: number;
      let status: ArchitectPlanStatus;
      let libraryDocument = current.libraryDocument;
      if ("blueprintId" in target) {
        const draft = await architectLibrary.saveDraft(
          target.blueprintId,
          overwrite?.revision ?? current.persistedRevision,
          { ...(overwrite?.document ?? libraryDocument), ...document },
        );
        revision = draft.revision;
        status = draft.archived ? "archived" : "draft";
        libraryDocument = draft.document;
      } else {
        const plan = await updateArchitectPlan({
          ...target,
          agsdl: document,
          expectedAgsdlRevision: current.persistedRevision,
        });
        revision = plan.agsdl!.revision;
        status = plan.status;
      }
      const latest = session(target);
      update(target, {
        ...latest,
        libraryDocument,
        draftConflict: undefined,
        saving: false,
        persistedRevision: revision,
        dirty: latest.version !== current.version,
        status,
      });
    } catch (failure) {
      const error = "blueprintId" in target ? await handleBlueprintWriteError(target, failure) : failure;
      update(target, {
        ...session(target),
        saving: false,
        error: error instanceof AgsdlUserError ? error.messageKey : error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    sessions: {},
    openBlueprintDocument(record) {
      const target = "number" in record
        ? { blueprintId: record.blueprintId, number: record.number }
        : { blueprintId: record.id };
      const nextSession = fromBlueprint(record);
      const status = nextSession.status;
      const existing = get().sessions[agsdlSessionKey(target)];
      if (existing?.saving) return existing;
      if (existing && !("number" in record) && (existing.dirty || existing.draftConflict)) {
        const observed = existing.draftConflict?.saved?.revision ?? existing.persistedRevision;
        if (record.revision <= observed) return existing;
        const next = { ...existing, draftConflict: { saved: record } };
        update(target, next);
        return next;
      }
      if (existing && (existing.persistedRevision > record.revision ||
        (existing.persistedRevision === record.revision && existing.status === status && !!existing.project === !!record.project))) return existing;
      const next = nextSession;
      if (next.project && existing?.project && !next.project.saved.projection && existing.source) {
        next.source = existing.source;
        next.project.graphRevision = existing.project.graphRevision;
      }
      update(target, next);
      return next;
    },
    async saveVersion(blueprintId, note, isCurrent = () => true) {
      const target = { blueprintId };
      const current = session(target);
      assertDraft(current);
      if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "A save is already in progress.");
      if (current.draftConflict) throw draftConflictError();
      assertEditableEdition(current.source);
      // Validate and freeze a legacy edit in one native transaction so a
      // rejected conversion cannot persist the edit as a side effect.
      const atomicEdit = current.dirty && !current.project && draftContract(current.source) === "agsdl-0.3.0"
        ? { ...current.libraryDocument, ...snapshot(current) }
        : undefined;
      const flushed = current.dirty && !atomicEdit ? await saveDocument(target) : undefined;
      const saved = session(target);
      if (!isCurrent() || saved.version !== (flushed?.version ?? current.version) || saved.saving || (saved.dirty && !atomicEdit))
        throw new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
      update(target, { ...saved, saving: true });
      try {
        const { convertedDraft, ...version } = await architectLibrary.saveVersion(blueprintId, saved.persistedRevision, note, atomicEdit);
        const latest = session(target);
        if (convertedDraft) {
          if (latest.version === saved.version) {
            update(target, {
              ...newSession(convertedDraft, version.revision, saved.status),
              libraryDocument: convertedDraft,
              history: latest.history.map(upgradeSnapshot),
              future: latest.future.map(upgradeSnapshot),
              saving: true,
            });
          } else {
            try { await readConflictingDraft(target); }
            catch { /* Keep the newer local edits and let the user retry the conflict read. */ }
          }
        } else if (atomicEdit) {
          update(target, {
            ...latest,
            libraryDocument: atomicEdit,
            persistedRevision: version.revision,
            dirty: latest.version !== saved.version,
          });
        }
        return version;
      } catch (error) {
        throw await handleBlueprintWriteError(target, error);
      } finally {
        update(target, { ...session(target), saving: false });
      }
    },
    async load(target, reload = false) {
      const key = agsdlSessionKey(target);
      const existing = get().sessions[key];
      if (existing && !reload) return existing;
      if (existing?.saving)
        throw new AgsdlUserError("agsdl.userError.saving", "Wait for the current save to finish.");
      if (pendingLoads.has(key)) return pendingLoads.get(key)!;
      const originalVersion = existing?.version;
      const pending = (async () => {
        if ("blueprintId" in target) {
          if (target.number === undefined) {
            const draft = await architectLibrary.getDraft(target.blueprintId);
            if (draft.id !== target.blueprintId) throw new Error("Unexpected blueprint identity");
            return get().openBlueprintDocument(draft);
          }
          const version = await architectLibrary.getVersion({ blueprintId: target.blueprintId, number: target.number });
          if (version.blueprintId !== target.blueprintId || version.number !== target.number) throw new Error("Unexpected version identity");
          return get().openBlueprintDocument(version);
        }
        const plan = await getArchitectPlan(target.branchName, target.planId);
        if (!plan?.agsdl || plan.status === "deleted")
          throw new Error("The AgSDL system is unavailable.");
        const current = get().sessions[key];
        if (current && current.version !== originalVersion) return current;
        const next = newSession(plan.agsdl, plan.agsdl.revision, plan.status);
        update(target, next);
        return next;
      })();
      pendingLoads.set(key, pending);
      try {
        return await pending;
      } finally {
        pendingLoads.delete(key);
      }
    },
    replace(target, source, annexes, expectedVersion, metadata) {
      const current = session(target);
      if (current.project) throw projectBatchRequired();
      assertDraft(current);
      if (expectedVersion !== undefined && expectedVersion !== current.version)
        throw new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
      assertEditableEdition(current.source, source);
      const nextAnnexes = annexes ?? current.annexes;
      const metadataSource = metadata === undefined ? current : metadata;
      const nextMetadata = structuredClone({ design: retainDesignOrigin(current.design, metadataSource.design), display: metadataSource.display, migration: metadataSource.migration });
      if (
        new TextEncoder().encode(source + Object.values(nextAnnexes).join("") + JSON.stringify(nextMetadata))
          .length > MAX_AGSDL_BYTES
      )
        throw new Error("AgSDL inputs exceed the 1 MiB editor limit.");
      if (
        source === current.source &&
        JSON.stringify(nextAnnexes) === JSON.stringify(current.annexes) &&
        JSON.stringify(nextMetadata) === JSON.stringify({ design: current.design, display: current.display, migration: current.migration })
      )
        return;
      update(target, {
        ...current,
        source,
        design: nextMetadata.design,
        display: nextMetadata.display,
        migration: nextMetadata.migration,
        annexes: structuredClone(nextAnnexes),
        version: crypto.randomUUID(),
        dirty: true,
        history: historyBudget([...current.history, snapshot(current)]),
        future: [],
        reports: [],
        error: null,
      });
    },
    setDesign(target, design, expectedVersion) {
      const current = session(target);
      if (current.project) throw projectBatchRequired();
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
      assertEditableEdition(current.source);
      const previous = readDesign(current.source, current.design);
      const changes = adaptationChanges(current.source, previous, design);
      const adapted = changes.length ? applyChanges(current.source, changes) : current.source;
      const next = withDocumentDesign(adapted, design, { design: current.design, display: current.display, migration: current.migration });
      get().replace(target, next.source, undefined, expectedVersion ?? current.version, { design: next.design, display: next.display, migration: next.migration });
    },
    edit(target, changes, expectedVersion) {
      const current = session(target);
      if ("blueprintId" in target && current.project) {
        if (current.project.graphVersion !== current.version || !current.project.saved.projection) throw editConflict();
        return get().applyProjectBatch(target, changes.map(change => localProjectEdit(current.project!.saved, change)), undefined, expectedVersion);
      }
      assertEditableEdition(current.source);
      get().replace(
        target,
        applyChanges(current.source, changes),
        undefined,
        expectedVersion ?? current.version,
      );
    },
    async readProjectFile(target, path) {
      const current = session(target);
      const project = current.project;
      if (!project) throw projectBatchRequired();
      if (project.buffers.has(path)) return project.buffers.get(path)!;
      if (!project.saved.files.some(file => file.path === path)) return null;
      const file = await architectLibrary.readProjectFile(
        target.number === undefined
          ? { kind: "draft", blueprintId: target.blueprintId, revision: current.persistedRevision }
          : { kind: "version", key: { blueprintId: target.blueprintId, number: target.number } }, path,
      ).catch(async error => { throw await handleBlueprintWriteError(target, error); });
      const latest = session(target);
      if (latest.version !== current.version || latest.persistedRevision !== current.persistedRevision ||
          file.revision !== current.persistedRevision) throw editConflict();
      const latestProject = latest.project!;
      update(target, { ...latest, project: {
        ...latestProject, buffers: new Map(latestProject.buffers).set(path, file.content),
      } });
      return file.content;
    },
    async applyProjectBatch(target, files, settings, expectedVersion, isCurrent = () => true, persist = false) {
      const current = session(target);
      assertDraft(current);
      if (current.draftConflict) throw draftConflictError();
      if (current.saving || (expectedVersion !== undefined && expectedVersion !== current.version)) throw editConflict();
      if (!current.project) throw projectBatchRequired();
      const { buffers, entry } = await prepareProjectEdit(
        current.project, files, settings, path => get().readProjectFile(target, path));
      if (!entry.forward.files.length && !entry.forward.settings) return;
      const latest = session(target);
      if (!isCurrent() || latest.version !== current.version || latest.saving || latest.draftConflict) throw editConflict();
      const project = latest.project!;
      const next = {
        ...latest, version: crypto.randomUUID(), dirty: true, error: null,
        project: {
          ...project, buffers: new Map([...project.buffers, ...buffers]),
          ...queueProjectEdit(project, entry, true),
          past: projectHistoryBudget([...project.past, entry]), future: [],
        },
      };
      if (persist) await saveDocument(target, undefined, next);
      else update(target, next);
    },
    undo(target, redo = false) {
      const current = session(target);
      if (current.status !== "draft") return;
      if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "Wait for the current save to finish.");
      if (current.project) {
        if (current.draftConflict) throw draftConflictError();
        const project = current.project;
        const from = redo ? project.future : project.past;
        const entry = from.at(-1);
        if (!entry) return;
        const batch = redo ? entry.forward : entry.backward;
        const queue = queueProjectEdit(project, entry, redo);
        update(target, {
          ...current, version: crypto.randomUUID(), dirty: queue.queued.length > 0, error: null,
          project: {
            ...project, buffers: historyBuffers(project, batch),
            ...queue,
            past: redo ? projectHistoryBudget([...project.past, entry]) : from.slice(0, -1),
            future: redo ? from.slice(0, -1) : projectHistoryBudget([...project.future, entry]),
          },
        });
        return;
      }
      const from = redo ? current.future : current.history;
      const next = from.at(-1);
      if (!next) return;
      assertEditableEdition(current.source, next.source);
      update(target, {
        ...current,
        ...next,
        version: crypto.randomUUID(),
        dirty: true,
        reports: [],
        error: null,
        history: redo
          ? historyBudget([...current.history, snapshot(current)])
          : from.slice(0, -1),
        future: redo
          ? from.slice(0, -1)
          : historyBudget([...current.future, snapshot(current)]),
      });
    },
    async save(target) { await saveDocument(target); },
    async discardProjectMigrationFile(target, path) {
      if (!session(target).project) throw projectBatchRequired();
      await saveDocument(target, undefined, undefined, path);
    },
    async refreshDraftConflict(target) {
      const current = session(target);
      if (!current.draftConflict || current.saving) return;
      update(target, { ...current, saving: true });
      try {
        await readConflictingDraft(target);
      } finally {
        update(target, { ...session(target), saving: false });
      }
    },
    async resolveDraftConflict(target, version, revision, choice) {
      const current = session(target);
      const saved = current.draftConflict?.saved;
      if (current.saving || current.version !== version || saved?.revision !== revision)
        throw new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Review it before continuing.");
      if (choice === "saved") {
        const next = fromBlueprint(saved);
        if (next.project && current.project && !next.project.saved.projection && current.source) {
          next.source = current.source;
          next.project.graphRevision = current.project.graphRevision;
        }
        update(target, next);
      }
      else {
        if (saved.archived) throw new AgsdlUserError("agsdl.readOnly", "This document is read-only.");
        await saveDocument(target, saved);
      }
    },
    async validate(target) {
      const current = session(target);
      if ("blueprintId" in target && current.project) {
        if (!current.dirty || current.saving || current.draftConflict) return;
        try {
          const view = await architectLibrary.validateDraft(target.blueprintId, current.persistedRevision, current.project.pending);
          const latest = session(target);
          if (latest.version === current.version && latest.dirty && !latest.saving && latest.persistedRevision === current.persistedRevision)
            update(target, { ...latest, project: { ...latest.project!, view } });
        } catch (error) {
          const latest = session(target);
          if (latest.version !== current.version || !latest.dirty || latest.saving) return;
          if (isStaleRevision(error)) await handleBlueprintWriteError(target, error);
        }
        return;
      }
      try {
        const reports = await validateDocument(current.source, current.annexes);
        const latest = get().sessions[agsdlSessionKey(target)];
        if (latest?.version === current.version)
          update(target, { ...latest, reports });
      } catch (error) {
        const latest = get().sessions[agsdlSessionKey(target)];
        if (latest?.version === current.version)
          update(target, {
            ...latest,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  };
});
