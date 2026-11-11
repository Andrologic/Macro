import { create } from "zustand";
import { toServiceError } from "../services/contracts/errors";
import { getArchitectPlan } from "../services/architectPlanService";
import * as ipc from "../services/tauriIpc";
import { executionCodexStatus } from "../services/ipc/agsdlExecution";
import { useAppStore } from "./useAppStore";
import { useTaskStore } from "./useTaskStore";
import { useChatStore } from "./useChatStore";
import { useAgsdlStore, agsdlSessionKey, type AgsdlTarget } from "./useAgsdlStore";
import type { PublicSnapshot, PublicProjection, SourceOwner, SourceRevision, SystemStartId, StartRequest, PublicStartReceipt, ExternalDeliveryRequest, DeliveryId, ActivationId, PublicExecutionIntent, ExecutionIntentPayload, ExecutionIntentAdmission, ExecutionIntentScope, ExecutionIntentError, IntentId } from "../services/agsdlExecution/contracts";
import type { ExecutionPreflight, PublicRunSummary, ApprovalPage, PublicExecutionDiagnostic, PublicApproval, ResolvedCardTask } from "../types/generated/ipc";
import { assertProjection, appendProjection, assertDiagnosticPage, executionInput, executionProfileForContract, executionPrompt } from "../services/agsdl/executionView";
import { sameSource } from "../services/agsdl/runtimeSelection";
import { PRODUCT_RUNTIME_AVAILABLE } from "../services/agsdlExecution/compiler";
import { sourceDigest } from "../services/agsdlExecution/compiler";
import { readDocument } from "../services/agsdl/document";
import { loadHumanRequests030 } from "../services/agsdl/humanRequests030";
import { loadRuntimeProjection030 } from "../services/agsdl/runtimeProjection030";
import type { PublicSnapshot030 } from "../services/ipc/agsdlExecution030";
import type { HumanPage030 } from "../types/generated/ipc/HumanPage030";
import type { RuntimeProjectionPage030 } from "../types/generated/ipc/RuntimeProjectionPage030";
import type { PublicExecutionIntent as VersionedIntent, EngineSourceRevision, EngineVersions as WireEngineVersions, PublicRunSummary030, RunPage030 } from "../types/generated/ipc";

interface ExecutionView {
  owner?: SourceOwner;
  conversationId?: string;
  runs: PublicRunSummary[];
  nextRuns: string | null;
  runs030: PublicRunSummary030[];
  nextRuns030: string | null;
  runs030Error: boolean;
  snapshot?: PublicSnapshot;
  snapshot030?: PublicSnapshot030;
  humans030?: HumanPage030;
  humans030Stale: boolean;
  runtime030?: RuntimeProjectionPage030;
  runtime030Stale: boolean;
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
  intent030?: VersionedIntent;
  /** Start/Deliver/Resume/Discard in flight. Stop never waits for it. */
  intentBusy: boolean;
  /** Delivery admitted natively and installed in this view, including after Resume. */
  acceptedDelivery?: ExternalDeliveryRequest;
  stopping: boolean;
  cardTask?: { run: SystemStartId; path: string; resolved: ResolvedCardTask | null };
  inspectTask: (path: string) => Promise<void>;
  open: (target: AgsdlTarget, conversationId: string) => Promise<void>;
  open030: (target: AgsdlTarget, conversationId: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshRun: () => Promise<void>;
  watch: (owner: SourceOwner, conversationId: string, run: SystemStartId) => () => void;
  moreRuns: () => Promise<void>;
  refreshRuns030: () => Promise<void>;
  moreRuns030: () => Promise<void>;
  select: (id: SystemStartId | undefined) => Promise<void>;
  select030: (id: string) => Promise<void>;
  refreshHumans030: () => Promise<void>;
  refreshRuntime030: () => Promise<void>;
  moreProjection: () => Promise<void>;
  moreDiagnostics: () => Promise<void>;
  showCaptured: (value: boolean) => void;
  start: (prompt?: string) => Promise<void>;
  start030: (prompt: string) => Promise<void>;
  stop030: (systemStartId: string) => Promise<void>;
  launched030?: string;
  notice030?: string;
  launchDiagnostics030?: ExecutionPreflight["diagnostics"];
  deliver: (agentName: string, prompt: string) => Promise<void>;
  resume: () => Promise<void>;
  discard: () => Promise<void>;
  stop: (activationId?: ActivationId) => Promise<void>;
  decide: (approval: PublicApproval, approve: boolean) => Promise<void>;
  openTask: (path: string) => Promise<void>;
  task: (path: string) => Promise<ResolvedCardTask | null>;
}
const sameSourceOwner = (left: SourceOwner, right: SourceOwner) => left.projectId === right.projectId && left.planId === right.planId && left.branch === right.branch;
const sameWireSource = (left: EngineSourceRevision, right: EngineSourceRevision) =>
  sameSourceOwner(left.owner, right.owner) && left.revision === right.revision && left.sourceSha256 === right.sourceSha256;
const sameWireVersions = (left: WireEngineVersions, right: WireEngineVersions) =>
  (['snapshot', 'contract', 'compiler', 'runtime', 'registry', 'profile'] as const).every(key => left[key] === right[key]);
/** A closed receipt retains its native identity after acknowledgement. */
const retainedStartReceipt030 = (intent: VersionedIntent | undefined, owner: SourceOwner | undefined, conversationId: string | undefined) => {
  const state = intent?.state;
  const admission = state && (state.kind === 'admitted' || state.kind === 'closed') ? state.admission : null;
  if (admission?.kind !== 'start030') return undefined;
  if (!intent || !owner || intent.formatVersion !== '1' || intent.payload.kind !== 'start' ||
      !sameSourceOwner(intent.key.scope.owner, owner) || intent.key.scope.conversationId !== conversationId) throw new Error('Invalid 0.3 admission');
  const { receipt } = admission;
  const request = intent.payload.request;
  if (!receipt.systemStartId || !receipt.flowInvocationId || request.profile !== 'macro-agsdl-030-v1' ||
      !sameSourceOwner(request.source.owner, owner) || !sameWireSource(receipt.source, request.source) || receipt.entryDeliveryId !== (request.entry?.deliveryId ?? null) ||
      receipt.versions.snapshot !== '2' || receipt.versions.contract !== 'agsdl-0.3.0' || receipt.versions.profile !== request.profile) throw new Error('Invalid 0.3 receipt');
  return receipt;
};
const runtimeFlowId030 = (view: ExecutionView, snapshot: PublicSnapshot030, validatedIntent: VersionedIntent | undefined) => {
  const run = view.runs030.find(item => item.systemStartId === snapshot.systemStartId);
  const admitted = retainedStartReceipt030(view.intent030, view.owner, view.conversationId);
  const retained = view.runtime030;
  const retainedFlow = retained?.scope.systemStartId === snapshot.systemStartId && sameWireSource(retained.scope.source, snapshot.source) ? retained.flowInvocationId : undefined;
  const id = run?.flowInvocationId ?? (view.intent030 === validatedIntent && admitted?.systemStartId === snapshot.systemStartId ? admitted.flowInvocationId : retainedFlow);
  if (!id || (run && (!sameWireSource(run.source, snapshot.source) || !sameWireVersions(run.versions, snapshot.versions))) ||
      (run && retained?.scope.systemStartId === snapshot.systemStartId && sameWireSource(retained.scope.source, snapshot.source) && retained.scope.snapshotId !== run.snapshotId) ||
      (admitted?.systemStartId === snapshot.systemStartId && (admitted.flowInvocationId !== id || !sameWireSource(admitted.source, snapshot.source) || !sameWireVersions(admitted.versions, snapshot.versions))) ||
      (retainedFlow && retainedFlow !== id)) throw new Error('Run identity differs');
  return id;
};
/** A new history page can invalidate the displayed capture or revision even
 * before the user asks for another runtime read. Off-page captures stay valid. */
const runtimeStaleAfterRuns030 = (view: ExecutionView, runs: readonly PublicRunSummary030[]) => {
  if (view.runtime030Stale || !view.snapshot030 || !view.runtime030) return view.runtime030Stale;
  const snapshot = view.snapshot030, runtime = view.runtime030;
  const run = runs.find(item => item.systemStartId === snapshot.systemStartId);
  return !!run && (!sameWireSource(run.source, snapshot.source) || !sameWireVersions(run.versions, snapshot.versions) ||
    run.flowInvocationId !== runtime.flowInvocationId || run.snapshotId !== runtime.scope.snapshotId ||
    !sameWireSource(run.source, runtime.scope.source) || run.revision !== runtime.revision);
};
const isIntent030 = (row: { readonly payload: { readonly kind: 'start'; readonly request: { readonly profile: string } } | { readonly kind: 'deliver' }; readonly state: { readonly kind: string; readonly admission?: { readonly kind: string } | null } }) => (row.payload.kind === 'start' && row.payload.request.profile === 'macro-agsdl-030-v1') ||
  ((row.state.kind === 'admitted' || row.state.kind === 'closed') && row.state.admission?.kind === 'start030');
const empty = { runs: [], nextRuns: null, runs030: [], nextRuns030: null, runs030Error: false, captured: false, loaded: false, busy: false, stale: false, humans030Stale: false, runtime030Stale: false, snapshot030: undefined, humans030: undefined, runtime030: undefined, diagnosticPinned: false, intent: undefined, intent030: undefined, intentBusy: false, stopping: false, acceptedDelivery: undefined, launched030: undefined, notice030: undefined, launchDiagnostics030: [] };
let generation = 0;
/** Changes only when the view leaves its project/plan/branch/conversation scope. */
let scopeGeneration = 0;
let taskGeneration = 0;
const watchers = new Map<string, { timer: ReturnType<typeof setInterval>; leases: number }>();
const executionErrorKeys = new Set(["agsdl.execution.error", "agsdl.execution.stale", "agsdl.execution.unavailable", "agsdl.execution.intentOpen", "agsdl.execution.retryable", "agsdl.execution.saveBeforeStart", "agsdl.execution.ownerChanged", "agsdl.execution.promptRequired", "agsdl.execution.capturedAgentRequired", "agsdl.execution.taskUnavailable", "agsdl.execution.unsupported030", "agsdl.execution.codexNotInstalled", "agsdl.execution.codexLoginRequired", "agsdl.execution.codexUnsupported",
  "agsdl.execution.refused.SCOPE_INVALID", "agsdl.execution.refused.SOURCE_CHANGED", "agsdl.execution.refused.TARGET_INVALID", "agsdl.execution.refused.TARGET_CLOSED", "agsdl.execution.refused.INPUT_CONSTRAINT"]);
const intentFailure = (error: unknown): ExecutionIntentError | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && "currentIntentKey" in (error as object) ? error as ExecutionIntentError : undefined;
};
const openIntent = (intent: PublicExecutionIntent | undefined) => !!intent && intent.state.kind !== "closed";
/** Unknown native admission versions must be installed by a matching reader. */
const admissionRunId = (admission: ExecutionIntentAdmission): SystemStartId | undefined => {
  if (admission.kind === "start") return admission.receipt.systemStartId;
  if (admission.kind === "deliver") return admission.receipt.work.systemStartId;
  return undefined;
};
const executionError = (error: unknown) => {
  // Structured native intent errors are mapped by code, never by message text.
  const intent = intentFailure(error);
  if (intent) return { error: intent.code === "SLOT_OCCUPIED" ? "agsdl.execution.intentOpen" : intent.code === "SCOPE_INVALID" || intent.code === "SCOPE_UNAVAILABLE" ? "agsdl.execution.ownerChanged" : "agsdl.execution.error", stale: false };
  const native = toServiceError(error);
  if (native.code === 'CALL_PLATFORM_UNQUALIFIED') return { error: 'agsdl.execution.callPlatform030', stale: false };
  if (native.code === 'CALL_PERMISSIONS_UNSUPPORTED') return { error: 'agsdl.execution.callPermissions030', stale: false };
  if (native.code === 'UNSUPPORTED_030_FEATURE') return { error: 'agsdl.execution.unsupported030', stale: false, launchDiagnostics030: [{ code: native.code, pointer: 'pointer' in native && typeof native.pointer === 'string' ? native.pointer : '', message: native.message }] };
  if (native.code === 'CODEX_NOT_INSTALLED') return { error: 'agsdl.execution.codexNotInstalled', stale: false };
  if (native.code === 'CODEX_LOGIN_REQUIRED') return { error: 'agsdl.execution.codexLoginRequired', stale: false };
  if (['CODEX_VERSION_UNQUALIFIED', 'CODEX_PLATFORM_UNQUALIFIED'].includes(native.code ?? '')) return { error: 'agsdl.execution.codexUnsupported', stale: false };
  const message = native.message;
  const stale = message.includes("Projection page is stale; restart explicitly");
  return { error: stale ? "agsdl.execution.stale" : executionErrorKeys.has(message) ? message : "agsdl.execution.error", stale };
};
const source = (value: ExecutionPreflight["source"]): SourceRevision => value as SourceRevision;
export const useAgsdlExecutionStore = create<ExecutionView>((set, get) => {
  let refreshingRun = false;
  let cursors030 = new Set<string>();
  const validatePage030 = (page: RunPage030, owner: SourceOwner, previous: PublicRunSummary030[], cursor: string | null) => {
    if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096 || page.nextCursor === cursor || (cursor !== null && cursors030.has(page.nextCursor)))) throw new Error('Invalid run cursor');
    const ids = new Set(previous.map(run => run.systemStartId));
    for (const run of page.runs) {
      if (!run.systemStartId || !run.flowInvocationId || !run.snapshotId || ids.has(run.systemStartId) || !sameSourceOwner(run.source.owner, owner) || run.versions.snapshot !== '2' || run.versions.contract !== 'agsdl-0.3.0' || run.versions.profile !== 'macro-agsdl-030-v1') throw new Error('Invalid 0.3 run');
      ids.add(run.systemStartId);
    }
  };
  // A retained intent is visible even when rejected; only a fully verified
  // receipt/capture pair may supply identity in the absence of a run summary.
  let validatedIntent030: VersionedIntent | undefined;
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
  /** Observation only: a 0.3 admission stays retained until its versioned
   * projection and production admission are available. */
  const observe030 = async (row: VersionedIntent, initial: ExecutionView, current: () => Promise<boolean>, preserveSelection = false) => {
    const token = generation;
    const sameSelection = async () => token === generation && await current() && token === generation;
    if (!initial.owner || !sameSourceOwner(row.key.scope.owner, initial.owner) || row.key.scope.conversationId !== initial.conversationId || !isIntent030(row)) throw new Error('Intent scope differs');
    if (!(await sameSelection())) return;
    set({ intent030: row, intent: undefined });
    const admission = row.state.kind === 'admitted' || row.state.kind === 'closed' ? row.state.admission : null;
    if (!admission) return;
    if (admission.kind !== 'start030' || row.payload.kind !== 'start') throw new Error('Invalid 0.3 admission');
    const receipt = retainedStartReceipt030(row, initial.owner, initial.conversationId);
    if (!receipt) throw new Error('Invalid 0.3 admission');
    const snapshot = await ipc.readExecutionSnapshot030(receipt.systemStartId);
    if (snapshot.systemStartId !== receipt.systemStartId || !sameWireSource(snapshot.source, receipt.source) ||
        (snapshot.associations.conversationId !== undefined && snapshot.associations.conversationId !== initial.conversationId) ||
        !sameWireVersions(snapshot.versions, receipt.versions) ||
        await sourceDigest(snapshot.authoredSource) !== receipt.source.sourceSha256 || readDocument(snapshot.authoredSource).contract !== 'agsdl-0.3.0') throw new Error('Invalid 0.3 snapshot');
    if (!(await sameSelection())) return;
    validatedIntent030 = row;
    if (preserveSelection && (initial.snapshot || initial.snapshot030)) return;
    set({ snapshot030: snapshot, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false,
      snapshot: undefined, projection: undefined, approvals: undefined, diagnostic: undefined, cardTask: undefined, acceptedDelivery: undefined });
  };
  const scopeOf = (view: ExecutionView): ExecutionIntentScope => ({ owner: view.owner!, conversationId: view.conversationId! });
  /** Install the admitted run in this exact view. Returns false when the view moved. */
  const install = async (admission: ExecutionIntentAdmission, payload: ExecutionIntentPayload, initial: ExecutionView, current: () => Promise<boolean>): Promise<boolean> => {
    let snapshot: PublicSnapshot;
    if (admission.kind === "start") {
      const receipt: PublicStartReceipt = admission.receipt;
      if (payload.kind !== "start" || receipt.systemStartId !== receipt.snapshot.systemStartId || !sameSource(receipt.snapshot.source, payload.request.source)) throw new Error("Start receipt identity differs");
      snapshot = receipt.snapshot;
    } else if (admission.kind === "deliver") {
      if (payload.kind !== "deliver" || admission.receipt.deliveryId !== payload.request.deliveryId || admission.receipt.work.systemStartId !== payload.request.systemStartId) throw new Error("Delivery receipt identity differs");
      snapshot = initial.snapshot?.systemStartId === payload.request.systemStartId ? initial.snapshot : await ipc.readExecutionSnapshot(payload.request.systemStartId);
    } else throw new Error("agsdl.execution.unavailable");
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
        if (state.admission && submit) {
          const runId = admissionRunId(state.admission);
          if (!runId || get().snapshot?.systemStartId !== runId) {
            if (!(await install(state.admission, row.payload, initial, current))) return;
          }
        }
        set({ intent: undefined });
        return;
      }
    }
  };
  const intentOperation = async (work: (initial: ExecutionView, current: () => Promise<boolean>) => Promise<void>) => {
    const initial = get(); const token = scopeGeneration;
    const documentKey = initial.owner && agsdlSessionKey({ planId: initial.owner.planId, branchName: initial.owner.branch });
    const documentSource = documentKey && useAgsdlStore.getState().sessions[documentKey]?.source;
    if (initial.intentBusy) return;
    const current = async () => { if (token !== scopeGeneration) return false; await owns(initial); return token === scopeGeneration; };
    set({ intentBusy: true, error: undefined, notice030: undefined, launchDiagnostics030: [] });
    try { if (await current()) await work(initial, current); }
    catch (error) { if (token === scopeGeneration && (!documentKey || useAgsdlStore.getState().sessions[documentKey]?.source === documentSource)) set(executionError(error)); }
    finally { if (token === scopeGeneration) set({ intentBusy: false }); }
  };
  const settle030 = async (row: VersionedIntent, initial: ExecutionView, current: () => Promise<boolean>, submit: boolean) => {
    if (!(await current())) return;
    set({ intent030: row });
    if ((row.state.kind === 'prepared' || row.state.kind === 'submissionPending') && submit) {
      row = await ipc.submitExecutionIntentVersioned(row.key);
      if (!(await current())) return;
      set({ intent030: row });
    }
    if (row.state.kind === 'refused') { set({ error: `agsdl.execution.refused.${row.state.code}` }); return; }
    if (row.state.kind === 'submissionPending') { set({ error: 'agsdl.execution.retryable' }); return; }
    const receipt = retainedStartReceipt030(row, initial.owner, initial.conversationId);
    if (!receipt) return;
    await observe030(row, initial, current);
    if (!(await current())) return;
    if (row.state.kind === 'admitted') {
      row = await ipc.closeExecutionIntentVersioned({ key: row.key, expectedRevision: row.revision, disposition: 'acknowledged' });
      if (!(await current())) return;
    }
    set({ intent030: row, launched030: receipt.systemStartId });
    await get().refreshRuns030();
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
        const [versioned, page] = await Promise.all([ipc.readExecutionIntentsVersioned({ scope: scopeOf(initial) }), ipc.listExecutionRuns({ owner: initial.owner!, after: null, limit: 20 })]);
        if (versioned.length > 1 || page.runs.some(run => !sameSourceOwner(run.source.owner, initial.owner!))) throw new Error("Native scope read differs");
        if (!(await current())) return;
        if (versioned[0] && isIntent030(versioned[0])) {
          set({ runs: page.runs, nextRuns: page.nextCursor, loaded: true });
          await observe030(versioned[0], initial, current);
          return;
        }
        const intents = await ipc.readExecutionIntents({ scope: scopeOf(initial) });
        if (intents.length > 1 || intents.length !== versioned.length ||
            (intents[0] && (intents[0].key.intentId !== versioned[0].key.intentId || intents[0].revision !== versioned[0].revision || isIntent030(intents[0])))) throw new Error("Native scope read differs");
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
        // A 0.3 run must be opened through the versioned reader, never the
        // historical snapshot/projection path. The run list remains selectable.
        if (latest.versions?.contract === 'agsdl-0.3.0') return;
        const snapshot = await ipc.readExecutionSnapshot(latest.systemStartId as SystemStartId);
        if (snapshot.systemStartId !== latest.systemStartId || !sameSourceOwner(snapshot.source.owner, initial.owner!)) throw new Error("Run source owner differs");
        const result = await readRun(snapshot);
        if (await current()) set(result);
      });
    },
    async open030(target, conversationId) {
      const opening = get().open(target, conversationId);
      const token = generation;
      await opening;
      const view = get();
      // open records errors in state; its resolved promise is not proof of a
      // successful read. A second operation must not erase a failed open.
      if (token !== generation || !view.loaded || view.error || view.busy ||
          view.owner?.planId !== target.planId || view.owner.branch !== target.branchName || view.conversationId !== conversationId) return;
      await get().refreshRuns030();
    },
    refresh: () => operation(async (initial, current) => {
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: null });
      if (!ownerMatches(preflight.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId)) throw new Error("Preflight source owner differs");
      const page = await ipc.listExecutionRuns({ owner: initial.owner!, after: null, limit: 20 });
      if (page.runs.some(run => !ownerMatches(run.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId))) throw new Error("Run source owner differs");
      const versioned = await ipc.readExecutionIntentsVersioned({ scope: scopeOf(initial) });
      if (versioned.length > 1) throw new Error('Native scope read differs');
      if (versioned[0] && isIntent030(versioned[0])) {
        if (!(await current())) return;
        set({ preflight, runs: page.runs, nextRuns: page.nextCursor, loaded: true });
        await observe030(versioned[0], initial, current, true);
        return;
      }
      const intents = await ipc.readExecutionIntents({ scope: scopeOf(initial) });
      if (intents.length > 1 || intents.length !== versioned.length ||
          (intents[0] && (intents[0].key.intentId !== versioned[0].key.intentId || intents[0].revision !== versioned[0].revision || isIntent030(intents[0])))) throw new Error('Native scope read differs');
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
    refreshRuns030: () => operation(async (initial, current) => {
      try {
        const page = await ipc.listExecutionRuns030({ owner: initial.owner!, after: null, limit: 20 });
        if (!(await current())) return;
        validatePage030(page, initial.owner!, [], null);
        cursors030 = new Set();
        set({ runs030: page.runs, nextRuns030: page.nextCursor, runs030Error: false, runtime030Stale: runtimeStaleAfterRuns030(initial, page.runs) });
      } catch (error) {
        if (await current()) set({ runs030Error: true });
        throw error;
      }
    }),
    moreRuns030: () => operation(async (initial, current) => {
      if (!initial.nextRuns030) return;
      try {
        const page = await ipc.listExecutionRuns030({ owner: initial.owner!, after: initial.nextRuns030, limit: 20 });
        if (!(await current())) return;
        validatePage030(page, initial.owner!, initial.runs030, initial.nextRuns030);
        cursors030.add(initial.nextRuns030);
        set({ runs030: [...initial.runs030, ...page.runs], nextRuns030: page.nextCursor, runs030Error: false, runtime030Stale: runtimeStaleAfterRuns030(initial, page.runs) });
      } catch (error) {
        if (await current()) set({ runs030Error: true });
        throw error;
      }
    }),
    select: id => operation(async (initial, current) => {
      set({ snapshot: undefined, snapshot030: undefined, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, projection: undefined, approvals: undefined, diagnostic: undefined, cardTask: undefined, captured: false, stale: false });
      if (!id) return;
      const snapshot = await ipc.readExecutionSnapshot(id);
      if (!ownerMatches(snapshot.source.owner, { planId: initial.owner!.planId, branchName: initial.owner!.branch }, initial.owner!.projectId)) throw new Error("Run source owner differs");
      const result = await readRun(snapshot);
      if (await current()) set(result);
    }),
    select030: id => operation(async (initial, current) => {
      const token = generation;
      set({ snapshot: undefined, snapshot030: undefined, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, projection: undefined, approvals: undefined, diagnostic: undefined, cardTask: undefined, captured: false, stale: false });
      const snapshot = await ipc.readExecutionSnapshot030(id);
      if (snapshot.systemStartId !== id || !sameSourceOwner(snapshot.source.owner, initial.owner!) ||
          (snapshot.associations.conversationId !== undefined && snapshot.associations.conversationId !== initial.conversationId) ||
          await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256 || readDocument(snapshot.authoredSource).contract !== 'agsdl-0.3.0') throw new Error('Run source differs');
      const flowInvocationId = runtimeFlowId030(initial, snapshot, validatedIntent030);
      const [humans, runtime] = await Promise.all([
        loadHumanRequests030({ systemStartId: id, source: snapshot.source }, ipc.readExecutionHumans030, () => token === generation),
        loadRuntimeProjection030({ systemStartId: id, source: snapshot.source, snapshotId: initial.runs030.find(run => run.systemStartId === id)?.snapshotId ?? null }, flowInvocationId, ipc.readExecutionRuntimeProjection030, () => token === generation),
      ]);
      if (humans && runtime && await current()) set({ snapshot030: snapshot, humans030: humans, runtime030: runtime });
    }),
    refreshHumans030: () => operation(async (initial, current) => {
      const snapshot = initial.snapshot030;
      if (!snapshot) return;
      const token = generation;
      try {
        const humans = await loadHumanRequests030({ systemStartId: snapshot.systemStartId, source: snapshot.source }, ipc.readExecutionHumans030, () => token === generation && get().snapshot030 === snapshot);
        if (humans && await current() && get().snapshot030 === snapshot) set({ humans030: humans, humans030Stale: false });
      } catch (error) {
        if (await current() && get().snapshot030 === snapshot) set({ humans030Stale: true });
        throw error;
      }
    }),
    refreshRuntime030: () => operation(async (initial, current) => {
      const snapshot = initial.snapshot030;
      if (!snapshot) return;
      const token = generation;
      try {
        const flowInvocationId = runtimeFlowId030(initial, snapshot, validatedIntent030);
        const retained = initial.runtime030?.scope;
        const snapshotId = retained?.systemStartId === snapshot.systemStartId && sameWireSource(retained.source, snapshot.source) ? retained.snapshotId : initial.runs030.find(run => run.systemStartId === snapshot.systemStartId)?.snapshotId ?? null;
        const runtime = await loadRuntimeProjection030({ systemStartId: snapshot.systemStartId, source: snapshot.source, snapshotId }, flowInvocationId, ipc.readExecutionRuntimeProjection030, () => token === generation && get().snapshot030 === snapshot);
        if (runtime && await current() && get().snapshot030 === snapshot) set({ runtime030: runtime, runtime030Stale: false });
      } catch (error) {
        if (await current() && get().snapshot030 === snapshot) set({ runtime030Stale: true });
        throw error;
      }
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
      if (openIntent(get().intent) || (get().intent030 && get().intent030!.state.kind !== 'closed')) throw new Error("agsdl.execution.intentOpen");
      const session = useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })];
      if (!session || !Number.isSafeInteger(session.persistedRevision) || session.dirty || session.saving || !initial.preflight || initial.preflight.authoredSource !== session.source) throw new Error("agsdl.execution.saveBeforeStart");
      // Editor revisions count document saves; native revisions count plan mutations.
      // Exact source bytes and the native expected revision protect this capture.
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: initial.preflight.source });
      if (!preflight.productRuntimeAvailable || !preflight.staticValid || !preflight.runtimeSupported || preflight.incomplete) throw new Error("agsdl.execution.unavailable");
      if (!sameSource(source(preflight.source), source(initial.preflight.source)) || preflight.authoredSource !== session.source ||
          executionProfileForContract(readDocument(preflight.authoredSource).contract) !== 'macro-serial-inline-v1') throw new Error("agsdl.execution.unavailable");
      if (!(await current()) || useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })]?.version !== session.version) return;
      const request: StartRequest = { source: source(preflight.source), profile: "macro-serial-inline-v1", associations: {}, requestId: crypto.randomUUID(), entry: executionInput(preflight.authoredSource).hasEntry
        ? { deliveryId: crypto.randomUUID() as DeliveryId, messageJson: executionPrompt(prompt) } : null };
      await stage({ kind: "start", request }, initial, current);
    }),
    start030: async prompt => {
      const view = get();
      const chat = useChatStore.getState();
      if (view.conversationId && chat.getPendingArchitectConversationTarget(view.conversationId)) {
        try {
          const id = await chat.materializeArchitectConversation(view.conversationId);
          await get().open030({ planId: view.owner!.planId, branchName: view.owner!.branch }, id);
        } catch (error) { set(executionError(error)); return; }
      }
      await intentOperation(async (initial, current) => {
      if (openIntent(get().intent) || (get().intent030 && get().intent030!.state.kind !== 'closed')) throw new Error("agsdl.execution.intentOpen");
      const session = useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })];
      if (!session || !Number.isSafeInteger(session.persistedRevision) || session.dirty || session.saving) throw new Error("agsdl.execution.saveBeforeStart");
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: null });
      if (!(await current())) return;
      if (useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })]?.version !== session.version) return;
      set({ launchDiagnostics030: preflight.diagnostics.filter(item => item.code !== 'READ_ONLY_CEILING') });
      if (preflight.diagnostics.some(item => item.code === 'UNSUPPORTED_030_FEATURE')) throw new Error('agsdl.execution.unsupported030');
      if (!(await current())) return;
      set({ notice030: preflight.diagnostics.some(item => item.code === 'READ_ONLY_CEILING') ? 'agsdl.execution.readOnly030' : undefined });
      const document = readDocument(preflight.authoredSource);
      const messageJson = document.flow ? executionPrompt(prompt) : "{}";
      const agents = document.agents;
      const needsCodex = (agents !== null && typeof agents === 'object' && !Array.isArray(agents) && Object.values(agents).some(agent => agent !== null && typeof agent === 'object' && 'harness' in agent && agent.harness === 'codex'));
      if (needsCodex) {
        const status = await executionCodexStatus();
        if (status.code === 'CODEX_NOT_INSTALLED') throw new Error('agsdl.execution.codexNotInstalled');
        if (status.code === 'CODEX_LOGIN_REQUIRED') throw new Error('agsdl.execution.codexLoginRequired');
        if (['CODEX_VERSION_UNQUALIFIED', 'CODEX_PLATFORM_UNQUALIFIED'].includes(status.code)) throw new Error('agsdl.execution.codexUnsupported');
        if (!status.available) throw new Error('agsdl.execution.unavailable');
      }
      if (!preflight.productRuntimeAvailable || !preflight.staticValid || !preflight.runtimeSupported || preflight.incomplete ||
          preflight.authoredSource !== session.source || executionProfileForContract(readDocument(preflight.authoredSource).contract) !== 'macro-agsdl-030-v1') throw new Error('agsdl.execution.unavailable');
      if (!(await current()) || useAgsdlStore.getState().sessions[agsdlSessionKey({ planId: initial.owner!.planId, branchName: initial.owner!.branch })]?.version !== session.version) return;
      let row: VersionedIntent;
      try { row = await ipc.stageExecutionIntentVersioned({ scope: scopeOf(initial), intentId: crypto.randomUUID(), payload: { kind: 'start', request: {
        source: preflight.source, profile: 'macro-agsdl-030-v1', associations: {}, requestId: crypto.randomUUID(),
        entry: document.flow ? { deliveryId: crypto.randomUUID(), messageJson } : null,
      } } });
      } catch (error) {
        const rows = await ipc.readExecutionIntentsVersioned({ scope: scopeOf(initial) });
        if (await current() && rows.length === 1 && isIntent030(rows[0])) set({ intent030: rows[0] });
        throw error;
      }
      if (!(await current())) return;
      await settle030(row, initial, current, true);
      });
    },
    stop030: async systemStartId => {
      const token = scopeGeneration;
      set({ stopping: true, error: undefined });
      try { await ipc.stopExecution030({ systemStartId: systemStartId as SystemStartId, requestId: crypto.randomUUID() }); }
      catch (error) { if (token === scopeGeneration) set(executionError(error)); }
      finally { if (token === scopeGeneration) set({ stopping: false }); }
    },
    deliver: (agentName, prompt) => intentOperation(async (initial, current) => {
      if (openIntent(get().intent) || (get().intent030 && get().intent030!.state.kind !== 'closed')) throw new Error("agsdl.execution.intentOpen");
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
      if (initial.intent030) {
        const token = generation;
        const row = await ipc.readExecutionIntentVersioned(initial.intent030.key);
        if (token !== generation) return;
        if (!row || row.key.intentId !== initial.intent030.key.intentId) throw new Error('Intent identity differs');
        await settle030(row, initial, current, true);
        return;
      }
      const row = initial.intent ? await ipc.readExecutionIntent(initial.intent.key) : (await ipc.readExecutionIntents({ scope: scopeOf(initial) }))[0] ?? null;
      await settle(row, initial, current, true);
    }),
    discard: () => intentOperation(async (_initial, current) => {
      const versioned = get().intent030;
      if (versioned && ["prepared", "submissionPending", "refused"].includes(versioned.state.kind)) {
        const row = await ipc.closeExecutionIntentVersioned({ key: versioned.key, expectedRevision: versioned.revision, disposition: "discarded" });
        if (await current()) set({ intent030: row.state.kind === "closed" ? undefined : row });
        return;
      }
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
