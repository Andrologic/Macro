import { create } from "zustand";
import { adaptationChanges,readDesign,retainDesignOrigin,withDocumentDesign,type AgsdlEnvelopeMetadata,type DesignMetadata } from "../services/agsdl/design";
import {
applyChanges,
AGSDL_020_CONTRACT,
MAX_AGSDL_BYTES,
readDocument,
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
  type BlueprintVersionSummary,
} from "../services/ipc/architectLibrary";

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
  saveVersion: (blueprintId: string, note: string | null) => Promise<BlueprintVersionSummary>;
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
  ) => void;
  undo: (target: AgsdlDocumentTarget, redo?: boolean) => void;
  save: (target: AgsdlDocumentTarget) => Promise<void>;
  validate: (target: AgsdlDocumentTarget) => Promise<void>;
}
const pendingLoads = new Map<string, Promise<AgsdlSession>>();
function assertEditableEdition(...sources: string[]): void {
  for (const source of sources) {
    let contract: unknown;
    try { contract = readDocument(source).contract; }
    catch { continue; } // Malformed drafts remain repairable.
    if (contract === AGSDL_020_CONTRACT) {
      throw new AgsdlUserError("agsdl.unsupportedEdition020", "AgSDL 0.2 is no longer supported. This document cannot be edited or run.");
    }
  }
}
const snapshot = ({ source, annexes, design, display, migration }: Snapshot): Snapshot => structuredClone({
  source, annexes, design, display, migration,
});
const draftSaveError = (error: unknown) => {
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : error;
  return message === "Validation error: stale_revision"
    ? new AgsdlUserError("agsdl.library.revisionConflict", "The draft changed elsewhere. Your edits are still in this window.")
    : error;
};

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
  return {
    sessions: {},
    openBlueprintDocument(record) {
      const target = "number" in record
        ? { blueprintId: record.blueprintId, number: record.number }
        : { blueprintId: record.id };
      const status = "number" in record || record.archived ? "archived" : "draft";
      const existing = get().sessions[agsdlSessionKey(target)];
      if (existing && (existing.dirty || existing.saving ||
        existing.persistedRevision > record.revision ||
        (existing.persistedRevision === record.revision && existing.status === status))) return existing;
      const next = { ...newSession(record.document, record.revision, status), libraryDocument: record.document };
      update(target, next);
      return next;
    },
    async saveVersion(blueprintId, note) {
      const target = { blueprintId };
      const current = session(target);
      assertDraft(current);
      if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "A save is already in progress.");
      assertEditableEdition(current.source);
      if (current.dirty) await get().save(target);
      const saved = session(target);
      if (saved.version !== current.version || saved.saving || saved.dirty)
        throw new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
      update(target, { ...saved, saving: true });
      try {
        return await architectLibrary.saveVersion(blueprintId, saved.persistedRevision, note);
      } catch (error) {
        throw draftSaveError(error);
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
      assertEditableEdition(current.source);
      get().replace(
        target,
        applyChanges(current.source, changes),
        undefined,
        expectedVersion ?? current.version,
      );
    },
    undo(target, redo = false) {
      const current = session(target);
      if (current.status !== "draft") return;
      if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "Wait for the current save to finish.");
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
    async save(target) {
      const current = session(target);
      if (current.saving) throw new AgsdlUserError("agsdl.userError.saving", "A save is already in progress.");
      if (!current.dirty) return;
      assertDraft(current);
      assertEditableEdition(current.source);
      update(target, { ...current, saving: true, error: null });
      try {
        const document = snapshot(current);
        let revision: number;
        let status: ArchitectPlanStatus;
        if ("blueprintId" in target) {
          const draft = await architectLibrary.saveDraft(target.blueprintId, current.persistedRevision, { ...current.libraryDocument, ...document })
            .catch(error => { throw draftSaveError(error); });
          revision = draft.revision;
          status = draft.archived ? "archived" : "draft";
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
          saving: false,
          persistedRevision: revision,
          dirty: latest.version !== current.version,
          status,
        });
      } catch (error) {
        update(target, {
          ...session(target),
          saving: false,
          error: error instanceof AgsdlUserError ? error.messageKey : error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async validate(target) {
      const current = session(target);
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
