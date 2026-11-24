import { isFlowDocumentContract } from "../services/agsdl/contract";
import { create } from "zustand";
import { readDocument } from "../services/agsdl/document";
import { executionProfileForContract,executionPrompt } from '../services/agsdl/executionView';
import { loadHumanRequests030 } from "../services/agsdl/humanRequests030";
import { loadRuntimeProjection030 } from "../services/agsdl/runtimeProjection030";
import type { ExecutionIntentError,ExecutionIntentScope,SourceOwner,SystemStartId } from "../services/agsdlExecution/contracts";
import { sourceDigest } from '../services/agsdlExecution/sourceDigest';
import { getArchitectPlan } from "../services/architectPlanService";
import { toServiceError } from "../services/contracts/errors";
import { executionCodexStatus } from "../services/ipc/agsdlExecution";
import type { PublicSnapshot030 } from "../services/ipc/agsdlExecution030";
import * as ipc from "../services/tauriIpc";
import type { EngineSourceRevision,ExecutionPreflight,PublicRunSummary030,RunPage030,PublicExecutionIntent as VersionedIntent,EngineVersions as WireEngineVersions } from "../types/generated/ipc";
import type { HumanPage030 } from "../types/generated/ipc/HumanPage030";
import type { RuntimeProjectionPage030 } from "../types/generated/ipc/RuntimeProjectionPage030";
import { agsdlSessionKey,useAgsdlStore,type AgsdlTarget } from "./useAgsdlStore";
import { useChatStore } from "./useChatStore";

interface ExecutionView {
  owner?: SourceOwner;
  conversationId?: string;
  runs030: PublicRunSummary030[];
  nextRuns030: string | null;
  runs030Error: boolean;
  snapshot030?: PublicSnapshot030;
  humans030?: HumanPage030;
  humans030Stale: boolean;
  runtime030?: RuntimeProjectionPage030;
  runtime030Stale: boolean;
  preflight?: ExecutionPreflight;
  /** The native runs and intents of this scope were read at least once. */
  loaded: boolean;
  busy: boolean;
  stale: boolean;
  error?: string;
  intent030?: VersionedIntent;
  /** Start/Deliver/Resume/Discard in flight. Stop never waits for it. */
  intentBusy: boolean;
  stopping: boolean;
  refresh: () => Promise<void>;
  open030: (target: AgsdlTarget, conversationId: string) => Promise<void>;
  refreshRuns030: () => Promise<void>;
  moreRuns030: () => Promise<void>;
  select030: (id: string) => Promise<void>;
  refreshHumans030: () => Promise<void>;
  refreshRuntime030: () => Promise<void>;
  start030: (prompt: string) => Promise<void>;
  stop030: (systemStartId: string) => Promise<void>;
  launched030?: string;
  notice030?: string;
  launchDiagnostics030?: ExecutionPreflight["diagnostics"];
  resume: () => Promise<void>;
  discard: () => Promise<void>;
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
      !sameSourceOwner(intent.key.scope.owner, owner) || intent.key.scope.conversationId !== conversationId) throw new Error('Invalid AgSDL admission');
  const { receipt } = admission;
  const request = intent.payload.request;
  if (!receipt.systemStartId || !receipt.flowInvocationId || request.profile !== 'macro-agsdl-030-v1' ||
      !sameSourceOwner(request.source.owner, owner) || !sameWireSource(receipt.source, request.source) || receipt.entryDeliveryId !== (request.entry?.deliveryId ?? null) ||
      receipt.versions.snapshot !== '2' || !isFlowDocumentContract(receipt.versions.contract) || receipt.versions.profile !== request.profile) throw new Error('Invalid AgSDL receipt');
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
const empty = { runs030: [], nextRuns030: null, runs030Error: false, loaded: false, busy: false, stale: false, humans030Stale: false, runtime030Stale: false, snapshot030: undefined, humans030: undefined, runtime030: undefined, intent030: undefined, intentBusy: false, stopping: false, launched030: undefined, notice030: undefined, launchDiagnostics030: [] };
let generation = 0;
/** Changes only when the view leaves its project/plan/branch/conversation scope. */
let scopeGeneration = 0;
const executionErrorKeys = new Set(["agsdl.execution.error", "agsdl.execution.stale", "agsdl.execution.unavailable", "agsdl.execution.intentOpen", "agsdl.execution.retryable", "agsdl.execution.saveBeforeStart", "agsdl.execution.ownerChanged", "agsdl.execution.promptRequired", "agsdl.execution.capturedAgentRequired", "agsdl.execution.taskUnavailable", "agsdl.execution.unsupported030", "agsdl.execution.codexNotInstalled", "agsdl.execution.codexLoginRequired", "agsdl.execution.codexUnsupported",
  "agsdl.execution.codexPackageIncomplete",
  "agsdl.execution.refused.SCOPE_INVALID", "agsdl.execution.refused.SOURCE_CHANGED", "agsdl.execution.refused.TARGET_INVALID", "agsdl.execution.refused.TARGET_CLOSED", "agsdl.execution.refused.INPUT_CONSTRAINT"]);
const intentFailure = (error: unknown): ExecutionIntentError | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && "currentIntentKey" in (error as object) ? error as ExecutionIntentError : undefined;
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
  if (native.code === 'CODEX_PACKAGE_INCOMPLETE') return { error: 'agsdl.execution.codexPackageIncomplete', stale: false };
  if (native.code === 'CODEX_LOGIN_REQUIRED') return { error: 'agsdl.execution.codexLoginRequired', stale: false };
  if (['CODEX_VERSION_UNQUALIFIED', 'CODEX_PLATFORM_UNQUALIFIED'].includes(native.code ?? '')) return { error: 'agsdl.execution.codexUnsupported', stale: false };
  const message = native.message;
  const stale = message.includes("Projection page is stale; restart explicitly");
  return { error: stale ? "agsdl.execution.stale" : executionErrorKeys.has(message) ? message : "agsdl.execution.error", stale };
};
export const useAgsdlExecutionStore = create<ExecutionView>((set, get) => {
  let cursors030 = new Set<string>();
  const validatePage030 = (page: RunPage030, owner: SourceOwner, previous: PublicRunSummary030[], cursor: string | null) => {
    if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096 || page.nextCursor === cursor || (cursor !== null && cursors030.has(page.nextCursor)))) throw new Error('Invalid run cursor');
    const ids = new Set(previous.map(run => run.systemStartId));
    for (const run of page.runs) {
      if (!run.systemStartId || !run.flowInvocationId || !run.snapshotId || ids.has(run.systemStartId) || !sameSourceOwner(run.source.owner, owner) || run.versions.snapshot !== '2' || !isFlowDocumentContract(run.versions.contract) || run.versions.profile !== 'macro-agsdl-030-v1') throw new Error('Invalid AgSDL run');
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
  /** Observation only: a 0.3 admission stays retained until its versioned
   * projection and production admission are available. */
  const observe030 = async (row: VersionedIntent, initial: ExecutionView, current: () => Promise<boolean>, preserveSelection = false) => {
    const token = generation;
    const sameSelection = async () => token === generation && await current() && token === generation;
    if (!initial.owner || !sameSourceOwner(row.key.scope.owner, initial.owner) || row.key.scope.conversationId !== initial.conversationId || !isIntent030(row)) throw new Error('Intent scope differs');
    if (!(await sameSelection())) return;
    set({ intent030: row, });
    const admission = row.state.kind === 'admitted' || row.state.kind === 'closed' ? row.state.admission : null;
    if (!admission) return;
    if (admission.kind !== 'start030' || row.payload.kind !== 'start') throw new Error('Invalid AgSDL admission');
    const receipt = retainedStartReceipt030(row, initial.owner, initial.conversationId);
    if (!receipt) throw new Error('Invalid AgSDL admission');
    const snapshot = await ipc.readExecutionSnapshot030(receipt.systemStartId);
    if (snapshot.systemStartId !== receipt.systemStartId || !sameWireSource(snapshot.source, receipt.source) ||
        (snapshot.associations.conversationId !== undefined && snapshot.associations.conversationId !== initial.conversationId) ||
        !sameWireVersions(snapshot.versions, receipt.versions) ||
        await sourceDigest(snapshot.authoredSource) !== receipt.source.sourceSha256 || readDocument(snapshot.authoredSource).contract !== snapshot.versions.contract) throw new Error('Invalid AgSDL snapshot');
    if (!(await sameSelection())) return;
    validatedIntent030 = row;
    if (preserveSelection && (initial.snapshot030)) return;
    set({ snapshot030: snapshot, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, });
  };
  const scopeOf = (view: ExecutionView): ExecutionIntentScope => ({ owner: view.owner!, conversationId: view.conversationId! });
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
  return {
    ...empty,
    async open030(target, conversationId) {
      const conversation = useChatStore.getState().conversations.find(item => item.id === conversationId);
      if (!conversation?.project_id) { ++generation; ++scopeGeneration; set({ ...empty, owner: undefined, conversationId: undefined }); return; }
      if (ownerMatches(get().owner, target, conversation.project_id) && get().conversationId === conversationId && ((get().loaded && !get().error) || get().busy)) return;
      ++scopeGeneration;
      set({ ...empty, preflight: undefined, error: undefined,
        owner: { projectId: conversation.project_id, planId: target.planId, branch: target.branchName }, conversationId });
      await operation(async (initial, current) => {
        const rows = await ipc.readExecutionIntentsVersioned({ scope: scopeOf(initial) });
        if (rows.length > 1 || rows.some(row => !isIntent030(row))) throw new Error('Native scope read differs');
        if (!(await current())) return;
        set({ loaded: true });
        if (rows[0]) await observe030(rows[0], initial, current);
      });
      if (get().loaded && !get().error && get().conversationId === conversationId && ownerMatches(get().owner, target, conversation.project_id)) await get().refreshRuns030();
    },
    refresh: () => operation(async (initial, current) => {
      const preflight = await ipc.preflightExecution({ owner: initial.owner!, expected: null });
      if (!sameSourceOwner(preflight.source.owner, initial.owner!)) throw new Error('Preflight source owner differs');
      const rows = await ipc.readExecutionIntentsVersioned({ scope: scopeOf(initial) });
      if (rows.length > 1 || rows.some(row => !isIntent030(row))) throw new Error('Native scope read differs');
      if (!(await current())) return;
      set({ preflight, loaded: true });
      if (rows[0]) await observe030(rows[0], initial, current, true);
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
    select030: id => operation(async (initial, current) => {
      const token = generation;
      set({ snapshot030: undefined, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, stale: false });
      const snapshot = await ipc.readExecutionSnapshot030(id);
      if (snapshot.systemStartId !== id || !sameSourceOwner(snapshot.source.owner, initial.owner!) ||
          (snapshot.associations.conversationId !== undefined && snapshot.associations.conversationId !== initial.conversationId) ||
          await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256 || readDocument(snapshot.authoredSource).contract !== snapshot.versions.contract) throw new Error('Run source differs');
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
      if ((get().intent030 && get().intent030!.state.kind !== 'closed')) throw new Error("agsdl.execution.intentOpen");
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
        if (status.code === 'CODEX_PACKAGE_INCOMPLETE') throw new Error('agsdl.execution.codexPackageIncomplete');
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
    }),
    discard: () => intentOperation(async (_initial, current) => {
      const versioned = get().intent030;
      if (versioned && ["prepared", "submissionPending", "refused"].includes(versioned.state.kind)) {
        const row = await ipc.closeExecutionIntentVersioned({ key: versioned.key, expectedRevision: versioned.revision, disposition: "discarded" });
        if (await current()) set({ intent030: row.state.kind === "closed" ? undefined : row });
        return;
      }
    }),
  };
});
