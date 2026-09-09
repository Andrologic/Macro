import { create } from "zustand";
import {
  migrateArchitectPlanToAgsdl,
  updateArchitectPlan,
} from "../services/architectPlanService";
import type { ArchitectPlanStatus } from "../services/architectPlanService";
import type { AgsdlChange, AgsdlReport } from "../types/agsdl";
import {
  applyChanges,
  MAX_AGSDL_BYTES,
  validateDocument,
} from "../services/agsdl/document";

export interface AgsdlTarget {
  branchName: string;
  planId: string;
}
export const agsdlSessionKey = (target: AgsdlTarget) =>
  JSON.stringify([target.branchName, target.planId]);
interface Snapshot {
  source: string;
  annexes: Record<string, string>;
}
export interface AgsdlSession extends Snapshot {
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
  load: (target: AgsdlTarget, reload?: boolean) => Promise<AgsdlSession>;
  replace: (
    target: AgsdlTarget,
    source: string,
    annexes?: Record<string, string>,
    expectedVersion?: string,
  ) => void;
  edit: (
    target: AgsdlTarget,
    changes: AgsdlChange[],
    expectedVersion?: string,
  ) => void;
  undo: (target: AgsdlTarget, redo?: boolean) => void;
  save: (target: AgsdlTarget) => Promise<void>;
  validate: (target: AgsdlTarget) => Promise<void>;
}
const pendingLoads = new Map<string, Promise<AgsdlSession>>();
const snapshot = ({ source, annexes }: Snapshot): Snapshot => ({
  source,
  annexes,
});
const historyBudget = (history: Snapshot[]) => {
  let bytes = 0;
  return history
    .slice(-30)
    .reverse()
    .filter(
      (item) =>
        (bytes +=
          item.source.length + Object.values(item.annexes).join("").length) <=
        4 * MAX_AGSDL_BYTES,
    )
    .reverse();
};

export const useAgsdlStore = create<AgsdlState>((set, get) => {
  const session = (target: AgsdlTarget) => {
    const value = get().sessions[agsdlSessionKey(target)];
    if (!value) throw new Error("Load the AgSDL document first.");
    return value;
  };
  const update = (target: AgsdlTarget, value: AgsdlSession) =>
    set((state) => ({
      sessions: { ...state.sessions, [agsdlSessionKey(target)]: value },
    }));
  return {
    sessions: {},
    async load(target, reload = false) {
      const key = agsdlSessionKey(target);
      const existing = get().sessions[key];
      if (existing && !reload) return existing;
      if (existing?.saving)
        throw new Error("Wait for the current save to finish.");
      if (pendingLoads.has(key)) return pendingLoads.get(key)!;
      const originalVersion = existing?.version;
      const pending = (async () => {
        const plan = await migrateArchitectPlanToAgsdl(target.branchName, target.planId);
        if (!plan || plan.status === "deleted")
          throw new Error("The Architect plan is unavailable.");
        const current = get().sessions[key];
        if (current?.version !== originalVersion) return current;
        const next: AgsdlSession = {
          source: plan.agsdl?.source ?? "",
          annexes: plan.agsdl?.annexes ?? {},
          version: crypto.randomUUID(),
          persistedRevision: plan.agsdl?.revision ?? 0,
          dirty: false,
          saving: false,
          status: plan.status,
          history: [],
          future: [],
          reports: [],
          error: null,
        };
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
    replace(target, source, annexes, expectedVersion) {
      const current = session(target);
      if (current.status !== "draft")
        throw new Error("AgSDL editing requires a draft plan.");
      if (expectedVersion !== undefined && expectedVersion !== current.version)
        throw new Error("The document changed. Read it again before editing.");
      const nextAnnexes = annexes ?? current.annexes;
      if (
        new TextEncoder().encode(source + Object.values(nextAnnexes).join(""))
          .length > MAX_AGSDL_BYTES
      )
        throw new Error("AgSDL inputs exceed the 1 MiB editor limit.");
      if (
        source === current.source &&
        JSON.stringify(nextAnnexes) === JSON.stringify(current.annexes)
      )
        return;
      update(target, {
        ...current,
        source,
        annexes: nextAnnexes,
        version: crypto.randomUUID(),
        dirty: true,
        history: historyBudget([...current.history, snapshot(current)]),
        future: [],
        reports: [],
        error: null,
      });
    },
    edit(target, changes, expectedVersion) {
      const current = session(target);
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
      const from = redo ? current.future : current.history;
      const next = from.at(-1);
      if (!next) return;
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
      if (current.saving) throw new Error("A save is already in progress.");
      if (!current.dirty) return;
      update(target, { ...current, saving: true, error: null });
      try {
        const plan = await updateArchitectPlan({
          ...target,
          agsdl: snapshot(current),
          expectedAgsdlRevision: current.persistedRevision,
        });
        const latest = session(target);
        update(target, {
          ...latest,
          saving: false,
          persistedRevision: plan.agsdl!.revision,
          dirty: latest.version !== current.version,
          status: plan.status,
        });
      } catch (error) {
        update(target, {
          ...session(target),
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async validate(target) {
      const current = session(target);
      try {
        const reports = await validateDocument(current.source, current.annexes);
        if (session(target).version === current.version)
          update(target, { ...session(target), reports });
      } catch (error) {
        if (session(target).version === current.version)
          update(target, {
            ...session(target),
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  };
});
