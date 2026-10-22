import { create } from "zustand";
import { toServiceError } from "../services/contracts/errors";
import { getArchitectPlan } from "../services/architectPlanService";
import * as ipc from "../services/tauriIpc";
import { useAppStore } from "./useAppStore";
import { useTaskStore } from "./useTaskStore";
import { useChatStore } from "./useChatStore";
import { useAgsdlStore, agsdlSessionKey, type AgsdlTarget } from "./useAgsdlStore";
import type { PublicSnapshot, PublicProjection, SourceOwner, SourceRevision, SystemStartId, StartRequest, PublicStartReceipt, ExternalDeliveryRequest, DeliveryId, ActivationId, PublicExecutionIntent, ExecutionIntentPayload, ExecutionIntentAdmission, ExecutionIntentScope, ExecutionIntentError, IntentId } from "../services/agsdlExecution/contracts";
import type { ExecutionPreflight, PublicRunSummary, ApprovalPage, PublicExecutionDiagnostic, PublicApproval, ResolvedCardTask } from "../types/generated/ipc";
import { assertProjection, appendProjection, assertDiagnosticPage, executionInput, executionPrompt } from "../services/agsdl/executionView";
import { sameSource } from "../services/agsdl/runtimeSelection";
import { PRODUCT_RUNTIME_AVAILABLE } from "../services/agsdlExecution/compiler";

interface ExecutionView {
  owner?: SourceOwner;
  conversationId?: string;
  runs: PublicRunSummary[];
  nextRuns: string | null;
  snapshot?: PublicSnapshot;
  projection?: PublicProjection;
  approvals?: ApprovalPage;
  diagnostic?: PublicExecutionDiagnostic;
  diagnosticPinned: boolean;
  preflight?: ExecutionPreflight;
  captured: boolean;
  /** The native runs and intents of this scope were read at least once. */
  loaded: boolean;
  busy: boolean;
  stale: boolean;
  error?: string;
  /** Latest native intent of this scope. SQLite owns it; this is only its view. */
  intent?: PublicExecutionIntent;
  /** Start/Deliver/Resume/Discard in flight. Stop never waits for it. */
  intentBusy: boolean;
  /** Delivery admitted natively and installed in this view, including after Resume. */
  acceptedDelivery?: ExternalDeliveryRequest;
  stopping: boolean;
  cardTask?: { run: SystemStartId; path: string; resolved: ResolvedCardTask | null };
  inspectTask: (path: string) => Promise<void>;
  open: (target: AgsdlTarget, conversationId: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshRun: () => Promise<void>;
  watch: (owner: SourceOwner, conversationId: string, run: SystemStartId) => () => void;
  moreRuns: () => Promise<void>;
  select: (id: SystemStartId | undefined) => Promise<void>;
  moreProjection: () => Promise<void>;
  moreDiagnostics: () => Promise<void>;
  showCaptured: (value: boolean) => void;
  start: (prompt?: string) => Promise<void>;
  deliver: (agentName: string, prompt: string) => Promise<void>;
  resume: () => Promise<void>;
  discard: () => Promise<void>;
  stop: (activationId?: ActivationId) => Promise<void>;
  decide: (approval: PublicApproval, approve: boolean) => Promise<void>;
  openTask: (path: string) => Promise<void>;
  task: (path: string) => Promise<ResolvedCardTask | null>;
}
const sameSourceOwner = (left: SourceOwner, right: SourceOwner) => left.projectId === right.projectId && left.planId === right.planId && left.branch === right.branch;
const empty = { runs: [], nextRuns: null, captured: false, loaded: false, busy: false, stale: false, diagnosticPinned: false, intent: undefined, intentBusy: false, stopping: false, acceptedDelivery: undefined };
let generation = 0;
/** Changes only when the view leaves its project/plan/branch/conversation scope. */
let scopeGeneration = 0;
let taskGeneration = 0;
const watchers = new Map<string, { timer: ReturnType<typeof setInterval>; leases: number }>();
const executionErrorKeys = new Set(["agsdl.execution.error", "agsdl.execution.stale", "agsdl.execution.unavailable", "agsdl.execution.intentOpen", "agsdl.execution.retryable", "agsdl.execution.saveBeforeStart", "agsdl.execution.ownerChanged", "agsdl.execution.promptRequired", "agsdl.execution.capturedAgentRequired", "agsdl.execution.taskUnavailable",
  "agsdl.execution.refused.SCOPE_INVALID", "agsdl.execution.refused.SOURCE_CHANGED", "agsdl.execution.refused.TARGET_INVALID", "agsdl.execution.refused.TARGET_CLOSED", "agsdl.execution.refused.INPUT_CONSTRAINT"]);
const intentFailure = (error: unknown): ExecutionIntentError | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && "currentIntentKey" in (error as object) ? error as ExecutionIntentError : undefined;
};
const openIntent = (intent: PublicExecutionIntent | undefined) => !!intent && intent.state.kind !== "closed";
const executionError = (error: unknown) => {
  // Structured native intent errors are mapped by code, never by message text.
  const intent = intentFailure(error);
  if (intent) return { error: intent.code === "SLOT_OCCUPIED" ? "agsdl.execution.intentOpen" : intent.code === "SCOPE_INVALID" || intent.code === "SCOPE_UNAVAILABLE" ? "agsdl.execution.ownerChanged" : "agsdl.execution.error", stale: false };
  const message = toServiceError(error).message;
  const stale = message.includes("Projection page is stale; restart explicitly");
  return { error: stale ? "agsdl.execution.stale" : executionErrorKeys.has(message) ? message : "agsdl.execution.error", stale };
};
const source = (value: ExecutionPreflight["source"]): SourceRevision => value as SourceRevision;
export const useAgsdlExecutionStore = create<ExecutionView>((set, get) => {
  let refreshingRun = false;
  const ownerMatches = (owner: SourceOwner | undefined, target: AgsdlTarget, projectId: string) => owner?.planId === target.planId && owner.branch === target.branchName && owner.projectId === projectId;
  const owns = async (expected = get()) => {
    if (!expected.owner || !expected.conversationId || get().owner !== expected.owner || get().conversationId !== expected.conversationId) throw new Error("agsdl.execution.ownerChanged");
    const plan = await getArchitectPlan(expected.owner.branch, expected.owner.planId);
    const chat = useChatStore.getState();
    if (chat.selectedConversationId !== expected.conversationId || chat.conversations.find(item => item.id === expected.conversationId)?.project_id !== expected.owner.projectId ||
        !plan || plan.status === "deleted" || plan.conversationId !== expected.conversationId || get().owner !== expected.owner) throw new Error("agsdl.execution.ownerChanged");
  };
  const operation = async (work: (initial: ExecutionView, current: () => Promise<boolean>) => Promise<void>) => {
    const initial = get(); const token = ++generation;
    const current = async () => { if (token !== generation) return false; await owns(initial); return token === generation; };
    set({ busy: true, error: undefined });
    try { if (await current()) await work(initial, current); }
    catch (error) { if (token === generation) set(executionError(error)); }
    finally { if (token === generation) set({ busy: false }); }
  };
  const refreshedSummaries = async (initial: ExecutionView) => {
    const latest = new Map<string, PublicRunSummary>();
    const cursors = new Set<string>();
    let after: string | null = null;
    do {
      const page = await ipc.listExecutionRuns({ owner: initial.owner!, after, limit: 100 });
      for (const run of page.runs) {
        if (!sameSourceOwner(run.source.owner, initial.owner!)) throw new Error("Run source owner differs");
        latest.set(run.systemStartId, run);
      }
      if (!page.nextCursor || latest.has(initial.snapshot?.systemStartId ?? "")) break;
      if (cursors.has(page.nextCursor)) throw new Error("Repeated run page");
      cursors.add(page.nextCursor);
      after = page.nextCursor;
    } while (after);
    return initial.runs.map(run => latest.get(run.systemStartId) ?? run);
  };
  const readRun = async (snapshot: PublicSnapshot) => {
    const projection = await ipc.readExecutionProjection(snapshot.systemStartId);
    assertProjection(projection, snapshot);
    const approvals = await ipc.readExecutionApprovals({ systemStartId: snapshot.systemStartId, source: snapshot.source });
    const diagnostic = await ipc.readExecutionDiagnostic({ systemStartId: snapshot.systemStartId, source: snapshot.source, activationId: null, through: projection.cursor, recent: true });
    assertDiagnosticPage(diagnostic, snapshot, projection.cursor);
    return { snapshot, projection, approvals, diagnostic, stale: false, diagnosticPinned: false };
  };
  const scopeOf = (view: ExecutionView): ExecutionIntentScope => ({ owner: view.owner!, conversationId: view.conversationId! });
  /** Install the admitted run in this exact view. Returns false when the view moved. */
  const install = async (admission: ExecutionIntentAdmission, payload: ExecutionIntentPayload, initial: ExecutionView, current: () => Promise<boolean>): Promise<boolean> => {
    let snapshot: PublicSnapshot;
    if (admission.kind === "start") {
      const receipt: PublicStartReceipt = admission.receipt;
      if (payload.kind !== "start" || receipt.systemStartId !== receipt.snapshot.systemStartId || !sameSource(receipt.snapshot.source, payload.request.source)) throw new Error("Start receipt identity differs");
      snapshot = receipt.snapshot;
    } else {
      if (payload.kind !== "deliver" || admission.receipt.deliveryId !== payload.request.deliveryId || admission.receipt.work.systemStartId !== payload.request.systemStartId) throw new Error("Delivery receipt identity differs");
      snapshot = initial.snapshot?.systemStartId === payload.request.systemStartId ? initial.snapshot : await ipc.readExecutionSnapshot(payload.request.systemStartId);
    }
    if (!sameSourceOwner(snapshot.source.owner, initial.owner!)) throw new Error("Run source owner differs");
    const result = await readRun(snapshot);
    const page = await ipc.listExecutionRuns({ owner: initial.owner!, after: null, limit: 20 });
    if (page.runs.some(run => !sameSourceOwner(run.source.owner, initial.owner!))) throw new Error("Run source owner differs");
    if (!(await current())) return false;
    set({ ...result, runs: page.runs, nextRuns: page.nextCursor, captured: false,
      ...(payload.kind === "deliver" ? { acceptedDelivery: payload.request } : {}) });
    return true;
  };
  /** Advance one retained intent. Submit runs at most once per explicit action;
   * the intent is acknowledged only after its run is installed in this view. */
  const settle = async (row: PublicExecutionIntent | null, initial: ExecutionView, current: () => Promise<boolean>, submit: boolean) => {
    let submitted = !submit;
    for (;;) {
      if (!(await current())) return;
      if (!row) { set({ intent: undefined }); return; }
      set({ intent: row });
      const state = row.state;
      if (state.kind === "prepared" || state.kind === "submissionPending") {
        if (submitted) { if (state.kind === "submissionPending" && state.retryableFailure) set({ error: "agsdl.execution.retryable" }); return; }
        submitted = true;
        row = await ipc.submitExecutionIntent(row.key);
      } else if (state.kind === "admitted") {
        if (!(await install(state.admission, row.payload, initial, current))) return;
        row = await ipc.closeExecutionIntent({ key: row.key, expectedRevision: row.revision, disposition: "acknowledged" });
      } else if (state.kind === "refused") {
        set({ error: `agsdl.execution.refused.${state.code}` });
        return;
      } else {
        // A lost close acknowledgement: the admission is still installed once.
        if (state.admission && submit && get().snapshot?.systemStartId !== (state.admission.kind === "start" ? state.admission.receipt.systemStartId : state.admission.receipt.work.systemStartId)) {
          if (!(await install(state.admission, row.payload, initial, current))) return;
        }
        set({ intent: undefined });
        return;
      }
    }
  };
  const intentOperation = async (work: (initial: ExecutionView, current: () => Promise<boolean>) => Promise<void>) => {
    const initial = get(); const token = scopeGeneration;
    if (initial.intentBusy) return;
    const current = async () => { if (token !== scopeGeneration) return false; await owns(initial); return token === scopeGeneration; };
    set({ intentBusy: true, error: undefined });
    try { if (await current()) await work(initial, current); }
    catch (error) { if (token === scopeGeneration) set(executionError(error)); }
    finally { if (token === scopeGeneration) set({ intentBusy: false }); }
  };
  /** Stage a new request. A slot already held natively is shown, never replaced. */
  const stage = async (payload: ExecutionIntentPayload, initial: ExecutionView, current: () => Promise<boolean>) => {
    let row: PublicExecutionIntent;
    try { row = await ipc.stageExecutionIntent({ scope: scopeOf(initial), intentId: crypto.randomUUID() as IntentId, payload }); }
    catch (error) {
      const failure = intentFailure(error);
      if (failure?.code === "SLOT_OCCUPIED" && failure.currentIntentKey) {
        const retained = await ipc.readExecutionIntent(failure.currentIntentKey);
        if (await current()) set({ intent: retained ?? undefined });
      }
      throw error;
    }
    await settle(row, initial, current, true);
  };
  return {
    ...empty,
    async open(target, conversationId) {
      const conversation = useChatStore.getState().conversations.find(item => item.id === conversationId);
      if (!conversation?.project_id) { ++generation; ++scopeGeneration; set({ ...empty, owner: undefined, conversationId: undefined }); return; }
      // Same scope: keep what is shown, unless the last read failed (retry).
      if (ownerMatches(get().owner, target, conversation.project_id) && get().conversationId === conversationId && ((get().loaded && !get().error) || get().busy)) return;
      ++scopeGeneration;
      set({ ...empty, snapshot: undefined, projection: undefined, approvals: undefined, diagnostic: undefined, preflight: undefined, error: undefined,
        owner: { projectId: conversation.project_id, planId: target.planId, branch: target.branchName }, conversationId });
      // Open only reads: no Preflight, compilation, stage, submit or close.
      await operation(async (initial, current) => {
        const [intents, page] = await Promise.all([ipc.readExecutionIntents({ scope: scopeOf(initial) }), ipc.listExecutionRuns({ owner: initial.owner!, after: null, limit: 20 })]);
        if (intents.length > 1 || page.runs.some(run => !sameSourceOwner(run.source.owner, initial.owner!))) throw new Error("Native scope read differs");
        if (!(await current())) return;
        set({ intent: intents[0], runs: page.runs, nextRuns: page.nextCursor, loaded: true });
        // An open intent keeps priority and is only shown; an admitted one shows its run.
        if (intents[0]) {
          const admitted = intents[0].state.kind === "admitted" ? intents[0].state.admission : undefined;
          if (admitted) await install(admitted, intents[0].payload, initial, current);
          return;
        }
        // Otherwise show the latest run of this exact owner; another one can be selected later.
        const latest = page.runs[0];
        if (!latest) return;
        const snapshot = await ipc.readExecutionSnapshot(latest.systemStartId as SystemStartId);
        if (snapshot.systemStartId !== latest.systemStartId || !sameSourceOwner(snapshot.source.owner, initial.owner!)) throw new Error("Run source owner differs");
        const result = await readRun(snapshot);
        if (await current()) set(result);
      });
    },
    refresh: () => operation(async (initial, current) => {
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: null });
      if (!ownerMatches(preflight.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId)) throw new Error("Preflight source owner differs");
      const page = await ipc.listExecutionRuns({ owner: initial.owner!, after: null, limit: 20 });
      if (page.runs.some(run => !ownerMatches(run.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId))) throw new Error("Run source owner differs");
      const intents = await ipc.readExecutionIntents({ scope: scopeOf(initial) });
      const result = initial.snapshot ? await readRun(initial.snapshot) : {};
      if (await current()) set({ ...result, preflight, runs: page.runs, nextRuns: page.nextCursor, loaded: true, ...(get().intentBusy ? {} : { intent: intents[0] }) });
    }),
    async refreshRun() {
      const initial = get();
      if (refreshingRun || initial.busy || initial.intentBusy || initial.stopping || initial.stale || !initial.snapshot) return;
      const token = generation;
      const current = async () => {
        if (token !== generation || get().snapshot !== initial.snapshot || get().intentBusy || get().stopping) return false;
        await owns(initial);
        return token === generation && get().snapshot === initial.snapshot && !get().intentBusy && !get().stopping;
      };
      // Background observation must not disable controls or cancel foreground intent.
      refreshingRun = true;
      try {
        const result = await readRun(initial.snapshot);
        // Refresh retained run summaries when progress changes, without replacing
        // the user's paginated history or selected run.
        let runs = initial.runs;
        if (result.projection.cursor !== initial.projection?.cursor) {
          runs = await refreshedSummaries(initial);
        }
        if (!(await current())) return;
        const pinned = !!initial.projection?.nextPage || (initial.projection?.agents.length ?? 0) > 64 || (initial.projection?.activations.length ?? 0) > 64;
        if (pinned && result.projection.cursor !== initial.projection?.cursor) set({ stale: true });
        else set({ ...result, runs, projection: pinned ? initial.projection : result.projection,
          diagnostic: initial.diagnosticPinned ? initial.diagnostic : result.diagnostic, diagnosticPinned: initial.diagnosticPinned });
      } catch (error) {
        if (token === generation && get().snapshot === initial.snapshot && !get().intentBusy && !get().stopping) set(executionError(error));
      } finally { refreshingRun = false; }
    },
    watch(owner, conversationId, run) {
      const key = JSON.stringify([owner.projectId, owner.planId, owner.branch, conversationId, run]);
      const existing = watchers.get(key);
      if (existing) existing.leases += 1;
      else {
        const timer = setInterval(() => {
          const state = get();
          if (state.owner && sameSourceOwner(state.owner, owner) && state.conversationId === conversationId && state.snapshot?.systemStartId === run) void state.refreshRun();
        }, 2000);
        watchers.set(key, { timer, leases: 1 });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const watcher = watchers.get(key);
        if (watcher && --watcher.leases === 0) { clearInterval(watcher.timer); watchers.delete(key); }
      };
    },
    moreRuns: () => operation(async (initial, current) => {
      if (!initial.nextRuns) return;
      const page = await ipc.listExecutionRuns({ owner: initial.owner!, after: initial.nextRuns, limit: 20 });
      if (page.runs.some(run => !ownerMatches(run.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId))) throw new Error("Run source owner differs");
      if (await current()) set({ runs: [...initial.runs, ...page.runs], nextRuns: page.nextCursor });
    }),
    select: id => operation(async (initial, current) => {
      set({ snapshot: undefined, projection: undefined, approvals: undefined, diagnostic: undefined, cardTask: undefined, captured: false, stale: false });
      if (!id) return;
      const snapshot = await ipc.readExecutionSnapshot(id);
      if (!ownerMatches(snapshot.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId)) throw new Error("Run source owner differs");
      const result = await readRun(snapshot);
      if (await current()) set(result);
    }),
    moreProjection: () => operation(async (initial, current) => {
      if (!initial.snapshot || !initial.projection?.nextPage || initial.stale) return;
      const page = await ipc.readExecutionProjection(initial.snapshot.systemStartId, initial.projection.nextPage);
      const projection = appendProjection(initial.projection, page, initial.snapshot);
      if (await current()) set({ projection });
    }),
    moreDiagnostics: () => operation(async (initial, current) => {
      if (!initial.snapshot || !initial.diagnostic?.nextBefore) return;
      const page = await ipc.readExecutionDiagnostic({ systemStartId: initial.snapshot.systemStartId, source: initial.snapshot.source, activationId: null,
        through: initial.diagnostic.through, recent: true, before: initial.diagnostic.nextBefore });
      assertDiagnosticPage(page, initial.snapshot, initial.diagnostic.through);
      if (page.diagnostics.some(item => initial.diagnostic!.diagnostics.some(old => old.id === item.id))) throw new Error("Repeated diagnostic page");
      if (await current()) set({ diagnosticPinned: true, diagnostic: { ...page, diagnostics: [...initial.diagnostic!.diagnostics, ...page.diagnostics] } });
    }),
    showCaptured(captured) { set({ captured }); },
    start: (prompt = "") => intentOperation(async (initial, current) => {
      if (openIntent(get().intent)) throw new Error("agsdl.execution.intentOpen");
      const session = useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })];
      if (!session || !Number.isSafeInteger(session.persistedRevision) || session.dirty || session.saving || !initial.preflight || initial.preflight.authoredSource !== session.source) throw new Error("agsdl.execution.saveBeforeStart");
      // Editor revisions count document saves; native revisions count plan mutations.
      // Exact source bytes and the native expected revision protect this capture.
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: initial.preflight.source });
      if (!preflight.productRuntimeAvailable || !preflight.staticValid || !preflight.runtimeSupported || preflight.incomplete) throw new Error("agsdl.execution.unavailable");
      if (!(await current()) || useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })]?.version !== session.version) return;
      const request: StartRequest = { source: source(preflight.source), profile: "macro-serial-inline-v1", associations: {}, requestId: crypto.randomUUID(), entry: executionInput(preflight.authoredSource).hasEntry
        ? { deliveryId: crypto.randomUUID() as DeliveryId, messageJson: executionPrompt(prompt) } : null };
      await stage({ kind: "start", request }, initial, current);
    }),
    deliver: (agentName, prompt) => intentOperation(async (initial, current) => {
      if (openIntent(get().intent)) throw new Error("agsdl.execution.intentOpen");
      // Deliver to the retained capture, independently of the current document preflight.
      // Native intent admission still validates runtime availability and the captured run.
      if (!initial.snapshot || !PRODUCT_RUNTIME_AVAILABLE) throw new Error("agsdl.execution.unavailable");
      const input = executionInput(initial.snapshot.authoredSource);
      if (!input.graphless || !input.agents.includes(agentName)) throw new Error("agsdl.execution.capturedAgentRequired");
      const request: ExternalDeliveryRequest = { systemStartId: initial.snapshot.systemStartId, deliveryId: crypto.randomUUID() as DeliveryId, agentName, messageJson: executionPrompt(prompt) };
      await stage({ kind: "deliver", source: initial.snapshot.source, request }, initial, current);
    }),
    resume: () => intentOperation(async (initial, current) => {
      // Always resume the native row by its retained key, never the current form.
      const row = initial.intent ? await ipc.readExecutionIntent(initial.intent.key) : (await ipc.readExecutionIntents({ scope: scopeOf(initial) }))[0] ?? null;
      await settle(row, initial, current, true);
    }),
    discard: () => intentOperation(async (_initial, current) => {
      const intent = get().intent;
      if (!intent || !["prepared", "submissionPending", "refused"].includes(intent.state.kind)) return;
      const row = await ipc.closeExecutionIntent({ key: intent.key, expectedRevision: intent.revision, disposition: "discarded" });
      if (await current()) set({ intent: row.state.kind === "closed" ? undefined : row });
    }),
    async stop(activationId) {
      // Native Stop owns its key and joins. It needs neither the intent slot nor
      // current plan metadata, so it stays available while a request waits.
      const initial = get(); const token = scopeGeneration;
      if (!initial.snapshot) return;
      const systemStartId = initial.snapshot.systemStartId;
      set({ stopping: true, error: undefined });
      const sameRun = () => token === scopeGeneration && get().snapshot?.systemStartId === systemStartId;
      try {
        await ipc.ensureExecutionStop({ systemStartId, activationId: activationId ?? null });
        if (!sameRun()) return;
        const result = await readRun(get().snapshot!);
        const runs = await refreshedSummaries(initial);
        if (sameRun()) set({ ...result, runs });
      } catch (error) { if (token === scopeGeneration) set(executionError(error)); }
      finally { if (token === scopeGeneration) set({ stopping: false }); }
    },
    decide: (approval, approve) => operation(async (initial, current) => {
      if (!initial.snapshot || !initial.approvals?.approvals.some(item => item.approvalId === approval.approvalId && item.status === "pending" && item.work.systemStartId === initial.snapshot!.systemStartId)) return;
      await ipc.decideExecutionApproval({ scope: { systemStartId: initial.snapshot.systemStartId, source: initial.snapshot.source }, approvalId: approval.approvalId, approve });
      const result = await readRun(initial.snapshot);
      const runs = await refreshedSummaries(initial);
      if (await current()) set({ ...result, runs });
    }),
    async inspectTask(path) {
      const token = ++taskGeneration;
      const snapshot = get().snapshot;
      set({ cardTask: undefined });
      if (!snapshot) return;
      try {
        const resolved = await get().task(path);
        if (token === taskGeneration && get().snapshot === snapshot) set({ cardTask: { run: snapshot.systemStartId, path, resolved } });
      } catch { /* A departed owner cannot publish a Task link. */ }
    },
    async openTask(path) {
      const initial = get();
      const resolved = await get().task(path);
      if (!resolved) throw new Error("agsdl.execution.taskUnavailable");
      const task = useTaskStore.getState().getTaskById(resolved.taskId);
      if (!task || task.archived_at || task.plan_id !== resolved.planId || (task.plan_storage_branch || task.plan_target_branch) !== resolved.branch ||
          (task.project_id !== resolved.projectId && !task.project_ids?.includes(resolved.projectId))) throw new Error("agsdl.execution.taskUnavailable");
      await owns(initial);
      if (get().snapshot !== initial.snapshot) return;
      useAppStore.getState().setMode("Implement");
      await useTaskStore.getState().activateTask(task.id);
    },
    async task(path) {
      const initial = get(); await owns(initial);
      if (!initial.snapshot) return null;
      const task = await ipc.resolveExecutionCardTask({ systemStartId: initial.snapshot.systemStartId, source: initial.snapshot.source, path });
      await owns(initial);
      if (get().snapshot !== initial.snapshot || !task || task.projectId !== initial.owner!.projectId || task.planId !== initial.owner!.planId || task.branch !== initial.owner!.branch ||
          task.executionTarget.projectId !== initial.owner!.projectId) return null;
      return task;
    },
  };
});
