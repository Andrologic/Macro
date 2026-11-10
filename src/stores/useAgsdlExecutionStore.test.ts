import { beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { SystemStartId, Sequence, PublicSnapshot, PublicProjection, SourceRevision, PublicStopState, ActivationId, PublicExecutionIntent, ExecutionIntentKey, ExecutionStageIntentRequest, ExecutionCloseIntentRequest, ExecutionEnsureStopRequest, IntentRevision, FlowInvocationId } from "../services/agsdlExecution/contracts";
import type { RunListRequest030, RunPage030 } from '../types/generated/ipc';
import type { PublicSnapshot030 } from '../services/ipc/agsdlExecution030';
import type { HumanScope030 } from '../types/generated/ipc/HumanScope030';
import type { HumanPage030 } from '../types/generated/ipc/HumanPage030';
import type { RuntimeProjectionQuery030 } from '../types/generated/ipc/RuntimeProjectionQuery030';
import type { RuntimeProjectionPage030 } from '../types/generated/ipc/RuntimeProjectionPage030';
import type { RuntimeProjectionContinuation030 } from '../types/generated/ipc/RuntimeProjectionContinuation030';
import type { PublicExecutionIntent as VersionedIntent } from '../types/generated/ipc/PublicExecutionIntent';
let selected = "conversation";
let planConversation = "conversation";
const owner = { projectId: "project", planId: "plan", branch: "feature/work" };
const source = { owner, revision: "1", sourceSha256: "a".repeat(64) } as SourceRevision;
const snapshot = (id: string) => ({ systemStartId: id, source, authoredSource, versions: {}, associations: {} }) as PublicSnapshot;
const projection = (id: string, cursor = "9007199254740993", nextPage: PublicProjection["nextPage"] = null) => ({ systemStartId: id as SystemStartId, source, cursor: cursor as Sequence, agents: [], activations: [], systemStop: { kind: "none" }, nextPage }) as PublicProjection;
let readProjection: (id: string, page?: unknown) => Promise<PublicProjection>;
let available = false;
let authoredSource = '{}';
let completedCount = "0";
let listCalls = 0;
let preflightCalls = 0;
let seenPages: unknown[] = [];
let seenDiagnostics: { through: string; before?: string | null }[] = [];
let projectionChangesCursor = false;
let taskResult: unknown = null;
let snapshotOwner = owner;
let readSnapshot030: (id: string) => Promise<PublicSnapshot030>;
let readHumans030: (scope: HumanScope030) => Promise<HumanPage030>;
let readRuntime030: (scope: RuntimeProjectionQuery030, next?: RuntimeProjectionContinuation030) => Promise<RuntimeProjectionPage030>;
let wireIntent: VersionedIntent | undefined;
let listRuns030: (request: RunListRequest030) => Promise<RunPage030>;
mock.module("../services/architectPlanService", () => ({ getArchitectPlan: async () => ({ conversationId: planConversation, status: "draft" }), migrateArchitectPlanToAgsdl: async () => null, updateArchitectPlan: async () => {} }));
mock.module("./useChatStore", () => ({ useChatStore: { getState: () => ({ selectedConversationId: selected, conversations: [{ id: "conversation", project_id: "project" }, { id: "other", project_id: "foreign" }] }) } }));
mock.module("./useAppStore", () => ({ useAppStore: { getState: () => ({ setMode: () => {} }) } }));
mock.module("./useTaskStore", () => ({ useTaskStore: { getState: () => ({ getTaskById: () => undefined }) } }));
/** Controlled native authority. It persists outside the store, so a store reset
 * models a renderer reload. It is not a substitute for the SQLite intent tests. */
type Outcome = "admit" | "retry" | "refuse";
const native = {
  rows: new Map<string, PublicExecutionIntent>(), calls: [] as string[], submitted: [] as ExecutionIntentKey[], stops: [] as ExecutionEnsureStopRequest[],
  outcome: "admit" as Outcome, loseStage: false, loseSubmit: false, loseClose: false, submitGate: undefined as Promise<void> | undefined,
  stopState: { kind: "none" } as PublicStopState,
  reset() { this.rows.clear(); this.calls = []; this.submitted = []; this.stops = []; this.outcome = "admit"; this.loseStage = this.loseSubmit = this.loseClose = false; this.submitGate = undefined; this.stopState = { kind: "none" }; },
  open() { return [...this.rows.values()].filter(row => row.state.kind !== "closed"); },
  write(row: PublicExecutionIntent, state: PublicExecutionIntent["state"]) {
    const next = { ...row, state, revision: String(BigInt(row.revision) + 1n) as IntentRevision };
    this.rows.set(row.key.intentId, next); return next;
  },
};
const lost = (lose: boolean, value: PublicExecutionIntent) => { if (lose) throw new Error("Acknowledgement lost"); return structuredClone(value); };
mock.module("../services/tauriIpc", () => ({
  preflightExecution: async () => { preflightCalls++; return { source, authoredSource, staticValid: true, runtimeSupported: true, productRuntimeAvailable: available, incomplete: false }; },
  listExecutionRuns: async () => { listCalls++; return { runs: [...native.rows.values()].some(row => row.state.kind === "admitted" || row.state.kind === "closed" && row.state.admission) ? [{ systemStartId: 'started', source, counts: { completed: completedCount } }] : [], nextCursor: null }; },
  readExecutionSnapshot: async (id: string) => ({ ...snapshot(id), source: { ...source, owner: snapshotOwner } }),
  listExecutionRuns030: (request: RunListRequest030) => listRuns030(request),
  readExecutionSnapshot030: (id: string) => readSnapshot030(id),
  readExecutionHumans030: (scope: HumanScope030) => readHumans030(scope),
  readExecutionRuntimeProjection030: (scope: RuntimeProjectionQuery030, next?: RuntimeProjectionContinuation030) => readRuntime030(scope, next),
  readExecutionIntentsVersioned: async () => wireIntent ? [structuredClone(wireIntent)] : native.open(),
  readExecutionIntentVersioned: async () => wireIntent ? structuredClone(wireIntent) : null,
  readExecutionProjection: async (id: string, page?: unknown) => { seenPages.push(page); return readProjection(id, page); },
  readExecutionApprovals: async () => ({ approvals: [], incomplete: false }),
  readExecutionDiagnostic: async (request: { systemStartId: string; through: string; before?: string | null }) => { seenDiagnostics.push(request); return { source, systemStartId: request.systemStartId, activation: null, through: request.through, diagnostics: [], incomplete: !request.before, nextBefore: request.before ? null : '1' }; },
  stageExecutionIntent: async (request: ExecutionStageIntentRequest) => {
    native.calls.push("stage");
    const held = native.open().find(row => JSON.stringify(row.key.scope) === JSON.stringify(request.scope));
    if (held) throw { code: "SLOT_OCCUPIED", currentIntentKey: held.key };
    const row = { formatVersion: "1", key: { scope: request.scope, intentId: request.intentId }, revision: "1", payload: request.payload, state: { kind: "prepared" } } as PublicExecutionIntent;
    native.rows.set(request.intentId, row);
    return lost(native.loseStage, row);
  },
  readExecutionIntents: async () => { native.calls.push("read"); return structuredClone(native.open()); },
  readExecutionIntent: async (key: ExecutionIntentKey) => { native.calls.push("readOne"); const row = native.rows.get(key.intentId); return row ? structuredClone(row) : null; },
  submitExecutionIntent: async (key: ExecutionIntentKey) => {
    native.calls.push("submit"); native.submitted.push(structuredClone(key));
    await native.submitGate;
    let row = native.rows.get(key.intentId)!;
    if (row.state.kind === "prepared" || row.state.kind === "submissionPending") {
      const payload = row.payload;
      row = native.write(row, native.outcome === "retry" ? { kind: "submissionPending", retryableFailure: "RUNTIME_UNAVAILABLE" }
        : native.outcome === "refuse" ? { kind: "refused", code: "SOURCE_CHANGED" }
        : { kind: "admitted", admission: payload.kind === "start"
          ? { kind: "start", receipt: { systemStartId: "started" as SystemStartId, flowInvocationId: "flow" as FlowInvocationId, snapshot: snapshot("started") } }
          : { kind: "deliver", receipt: { deliveryId: payload.request.deliveryId, work: { systemStartId: payload.request.systemStartId } } } as unknown as Extract<PublicExecutionIntent["state"], { kind: "admitted" }>["admission"] });
    }
    return lost(native.loseSubmit, row);
  },
  closeExecutionIntent: async (request: ExecutionCloseIntentRequest) => {
    native.calls.push(`close:${request.disposition}`);
    let row = native.rows.get(request.key.intentId)!;
    if (row.state.kind === "closed") return structuredClone(row);
    if (row.revision !== request.expectedRevision) throw { code: "REVISION_CONFLICT", currentIntentKey: null };
    row = native.write(row, { kind: "closed", disposition: request.disposition, admission: row.state.kind === "admitted" ? row.state.admission : null });
    return lost(native.loseClose, row);
  },
  ensureExecutionStop: async (request: ExecutionEnsureStopRequest) => {
    native.calls.push("stop"); native.stops.push(structuredClone(request));
    native.stopState = native.stopState.kind === "none" ? { kind: "requested", requestId: "native-stop-key" } : native.stopState;
    return native.stopState;
  },
  resolveExecutionCardTask: async () => taskResult,
}));
const { useAgsdlStore, agsdlSessionKey } = await import("./useAgsdlStore");
const { useAgsdlExecutionStore: store } = await import("./useAgsdlExecutionStore");
const target = { planId: owner.planId, branchName: owner.branch };
/** A renderer reload: the store forgets everything, native rows remain. */
const reload = () => store.setState({ owner: undefined, conversationId: undefined, snapshot: undefined, snapshot030: undefined, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, projection: undefined, approvals: undefined, diagnostic: undefined, preflight: undefined, intent: undefined, intent030: undefined, intentBusy: false, acceptedDelivery: undefined, stopping: false, busy: false, error: undefined, runs: [], nextRuns: null, runs030: [], nextRuns030: null, runs030Error: false });
beforeEach(async () => {
  selected = planConversation = "conversation"; snapshotOwner = owner; seenPages = []; seenDiagnostics = []; projectionChangesCursor = false; taskResult = null; available = false; authoredSource = '{}'; listCalls = preflightCalls = 0; native.reset(); completedCount = "0"; wireIntent = undefined;
  listRuns030 = async () => ({runs:[],nextCursor:null});
  readProjection = async id => projection(id);
  reload();
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { source: '{}', annexes: {}, version: 'v1', persistedRevision: 1, status: 'draft', dirty: false, saving: false, history: [], future: [], reports: [], error: null } } });
  await store.getState().open(target, selected);
});
it("keeps the exact native continuation and exposes stale state without mixing cursors or restarting", async () => {
  readProjection = async (id, page) => !page ? projection(id, "9007199254740993", { cursor: "9007199254740993" as import('../services/agsdlExecution/contracts').Sequence, offset: 64 }) : projection(id, projectionChangesCursor ? "9007199254740994" : "9007199254740993");
  await store.getState().select("run" as SystemStartId);
  projectionChangesCursor = true; await store.getState().moreProjection();
  expect(seenPages).toEqual([undefined, { cursor: "9007199254740993", offset: 64 }]);
  expect(store.getState().stale).toBe(true); expect(store.getState().projection?.cursor).toBe("9007199254740993" as Sequence);
  expect(store.getState().projection?.nextPage?.offset).toBe(64);
});
it("ignores an old run result after a newer selection or destination switch", async () => {
  let release!: (value: PublicProjection) => void;
  readProjection = id => id === "old" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(projection(id));
  const old = store.getState().select("old" as SystemStartId);
  while (!release) await Promise.resolve();
  await store.getState().select("new" as SystemStartId);
  release(projection("old")); await old;
  expect(store.getState().snapshot?.systemStartId).toBe("new" as SystemStartId);
  release = undefined!;
  const delayed = store.getState().select("old" as SystemStartId); while (!release) await Promise.resolve();
  selected = "other"; release(projection("old")); await delayed;
  expect(store.getState().snapshot?.systemStartId).not.toBe("old" as SystemStartId);
});
it('loads a 0.3 human projection separately and retains it as stale after a read conflict', async () => {
  const authoredSource = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const capturedSource = { owner, revision: '1', sourceSha256: await sourceDigest(authoredSource) };
  readSnapshot030 = async id => ({ systemStartId: id, source: capturedSource, authoredSource, associations: {},
    versions: { snapshot: '2', contract: 'agsdl-0.3.0', profile: 'macro-agsdl-030-v1', compiler: 'c', runtime: 'r', registry: 'g' } });
  readHumans030 = async scope => ({ scope, cursor: '', total: '1', nextPage: null, requests: [{ id: 'request', revision: '0', status: 'open', workIds: [], content: { kind: 'question', question: 'Q', expectedResponse: 'unknown' } }] });
  store.setState({ runs030: [{ systemStartId:'run-030', flowInvocationId:'flow', source:capturedSource, versions:{snapshot:'2',contract:'agsdl-0.3.0',profile:'macro-agsdl-030-v1',compiler:'c',runtime:'r',registry:'g'}, snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0' }] });
  readRuntime030 = async scope => ({scope:{...scope,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null});
  await store.getState().select030('run-030');
  expect(store.getState().snapshot030?.systemStartId).toBe('run-030');
  expect(store.getState().snapshot).toBeUndefined();
  expect(store.getState().humans030?.requests[0].id).toBe('request');
  expect(store.getState().runtime030?.scope.snapshotId).toBe('capture');
  const previous = store.getState().runtime030;
  readRuntime030 = async () => { throw { code:'CONFLICT' }; };
  await store.getState().refreshRuntime030();
  expect(store.getState().runtime030Stale).toBe(true);
  expect(store.getState().runtime030).toBe(previous);
  readHumans030 = async () => { throw { code: 'CONFLICT' }; };
  await store.getState().refreshHumans030();
  expect(store.getState().humans030Stale).toBe(true);
  expect(store.getState().humans030?.requests[0].id).toBe('request');
});
it('does not install delayed 0.3 data after changing the selected run', async () => {
  const authoredSource = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const capturedSource = { owner, revision: '1', sourceSha256: await sourceDigest(authoredSource) };
  readSnapshot030 = async id => ({ systemStartId: id, source: capturedSource, authoredSource, associations: {},
    versions: { snapshot: '2', contract: 'agsdl-0.3.0', profile: 'macro-agsdl-030-v1', compiler: 'c', runtime: 'r', registry: 'g' } });
  store.setState({ runs030: [{ systemStartId:'old-030', flowInvocationId:'flow', source:capturedSource, versions:{snapshot:'2',contract:'agsdl-0.3.0',profile:'macro-agsdl-030-v1',compiler:'c',runtime:'r',registry:'g'}, snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0' }] });
  readRuntime030 = async scope => ({scope:{...scope,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null});
  let release!: (page: HumanPage030) => void;
  let requested!: HumanScope030;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  readHumans030 = scope => { requested = scope; return new Promise(resolve => { release = resolve; entered(); }); };
  const first = store.getState().select030('old-030');
  await started;
  await store.getState().select('new' as SystemStartId);
  release({ scope: requested, cursor: '', total: '0', requests: [], nextPage: null });
  await first;
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().snapshot?.systemStartId).toBe('new' as SystemStartId);
});
it('does not publish a partial 0.3 selection when a projection continuation conflicts', async () => {
  const authoredSource = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const capturedSource = { owner, revision:'1', sourceSha256:await sourceDigest(authoredSource) };
  const versions = { snapshot:'2' as const, contract:'agsdl-0.3.0' as const, profile:'macro-agsdl-030-v1' as const, compiler:'c', runtime:'r', registry:'g' };
  store.setState({runs030:[{systemStartId:'run-030',flowInvocationId:'flow',source:capturedSource,versions,snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'}]});
  readSnapshot030 = async id => ({systemStartId:id,source:capturedSource,authoredSource,versions,associations:{}});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  readRuntime030 = async (query, next) => {
    if (next) throw {code:'CONFLICT'};
    const scope = { ...query, snapshotId:'capture' };
    return {scope,flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'101',nextPage:{scope,revision:'1',offset:100},items:Array.from({length:100},(_,i)=>({kind:'instance' as const,value:{id:String(i).padStart(3,'0'),agent:'agent',selectorKind:'new',selectorName:null,currentActivationId:null,queueActivationIds:[],discarded:false}}))};
  };
  await store.getState().select030('run-030');
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().runtime030).toBeUndefined();
  expect(store.getState().humans030).toBeUndefined();
});
it('rejects a 0.3 run summary whose captured versions differ before reading its projection', async () => {
  const authoredSource = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const capturedSource = { owner, revision:'1', sourceSha256:await sourceDigest(authoredSource) };
  const versions = { snapshot:'2' as const, contract:'agsdl-0.3.0' as const, profile:'macro-agsdl-030-v1' as const, compiler:'c', runtime:'r', registry:'g' };
  store.setState({runs030:[{systemStartId:'run-030',flowInvocationId:'flow',source:capturedSource,versions:{...versions,runtime:'different'},snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'}]});
  readSnapshot030 = async id => ({systemStartId:id,source:capturedSource,authoredSource,versions,associations:{}});
  let reads = 0;
  readRuntime030 = async () => { reads++; throw new Error('Unexpected projection read'); };
  await store.getState().select030('run-030');
  expect(reads).toBe(0);
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().runtime030).toBeUndefined();
});
it('observes a versioned 0.3 admission and verifies its capture without submitting or acknowledging it', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = { owner, revision: '2', sourceSha256: await sourceDigest(text) };
  const versions = { snapshot: '2' as const, contract: 'agsdl-0.3.0' as const, profile: 'macro-agsdl-030-v1' as const, compiler: 'c', runtime: 'r', registry: 'g' };
  const request = { source: captured, profile: versions.profile, associations: {}, requestId: 'intent', entry: { deliveryId: 'entry', messageJson: '{}' } };
  wireIntent = { formatVersion: '1', key: { scope: { owner, conversationId: 'conversation' }, intentId: 'intent' }, revision: '1', payload: {kind:'start', request},
    state: {kind:'admitted', admission: {kind:'start030', receipt: {systemStartId:'run-030', flowInvocationId:'flow', source:captured, versions, entryDeliveryId:'entry'}}} };
  readSnapshot030 = async id => ({ systemStartId:id, source:captured, authoredSource:text, associations:{}, versions });
  await reopen();
  expect(store.getState().intent030?.state.kind).toBe('admitted');
  expect(store.getState().snapshot030?.systemStartId).toBe('run-030');
  expect(store.getState().snapshot).toBeUndefined();
  expect(native.calls).not.toContain('submit');
  expect(native.calls).not.toContain('close:acknowledged');
  store.setState({ snapshot: snapshot('previous') });
  await store.getState().resume();
  expect(store.getState().snapshot).toBeUndefined();
  expect(store.getState().snapshot030?.systemStartId).toBe('run-030');
  if (wireIntent.state.kind !== 'admitted' || wireIntent.state.admission.kind !== 'start030') throw new Error('fixture');
  wireIntent.state.admission.receipt.entryDeliveryId = 'other';
  store.setState({ snapshot030: undefined });
  await store.getState().resume();
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().intent030?.state.kind).toBe('admitted');
  expect(native.calls).not.toContain('close:acknowledged');
});
it('retains a prepared 0.3 intent without submitting it or using the historical reader', async () => {
  wireIntent = { formatVersion:'1', key:{scope:{owner,conversationId:'conversation'},intentId:'i'}, revision:'1',
    payload:{kind:'start',request:{source,profile:'macro-agsdl-030-v1',associations:{},requestId:'i',entry:null}}, state:{kind:'prepared'} };
  native.calls = [];
  await reopen();
  expect(store.getState().intent030?.state.kind).toBe('prepared');
  expect(native.calls).toEqual([]);
  await store.getState().resume();
  expect(store.getState().intent030?.state.kind).toBe('prepared');
  expect(native.calls).toEqual([]);
});
it('rejects a 0.3 admission whose captured source belongs to another owner', async () => {
  const foreign = { ...source, owner: { ...owner, projectId: 'foreign' } };
  const versions = { snapshot:'2', contract:'agsdl-0.3.0', profile:'macro-agsdl-030-v1', compiler:'c', runtime:'r', registry:'g' };
  wireIntent = { formatVersion:'1', key:{scope:{owner,conversationId:'conversation'},intentId:'i'}, revision:'1',
    payload:{kind:'start',request:{source:foreign,profile:versions.profile,associations:{},requestId:'i',entry:null}},
    state:{kind:'admitted',admission:{kind:'start030',receipt:{systemStartId:'foreign-run',flowInvocationId:'f',source:foreign,versions,entryDeliveryId:null}}} };
  let reads = 0;
  readSnapshot030 = async () => { reads++; throw new Error('Unexpected snapshot read'); };
  native.calls = [];
  await reopen();
  expect(reads).toBe(0);
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().error).toBe('agsdl.execution.error');
  expect(native.calls).not.toContain('close:acknowledged');
});
it('does not install a retained 0.3 receipt after another run is selected', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = { owner, revision: '2', sourceSha256: await sourceDigest(text) };
  const versions = { snapshot: '2' as const, contract: 'agsdl-0.3.0' as const, profile: 'macro-agsdl-030-v1' as const, compiler: 'c', runtime: 'r', registry: 'g' };
  wireIntent = { formatVersion:'1', key:{scope:{owner,conversationId:'conversation'},intentId:'i'}, revision:'1',
    payload:{kind:'start',request:{source:captured,profile:versions.profile,associations:{},requestId:'i',entry:null}},
    state:{kind:'admitted',admission:{kind:'start030',receipt:{systemStartId:'old-030',flowInvocationId:'f',source:captured,versions,entryDeliveryId:null}}} };
  store.setState({ intent030: wireIntent });
  let release!: (snapshot: PublicSnapshot030) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  readSnapshot030 = () => new Promise(resolve => { release = resolve; entered(); });
  const resume = store.getState().resume();
  await started;
  await store.getState().select('new' as SystemStartId);
  release({systemStartId:'old-030',source:captured,authoredSource:text,versions,associations:{}});
  await resume;
  expect(store.getState().snapshot030).toBeUndefined();
  expect(store.getState().snapshot?.systemStartId).toBe('new' as SystemStartId);
  expect(native.calls).not.toContain('close:acknowledged');
});
it("refuses an absent or foreign native Task resolution", async () => {
  await store.getState().select("run" as SystemStartId);
  expect(await store.getState().task('/flow/steps/start')).toBeNull();
  taskResult = { taskId: 'task', projectId: 'foreign', planId: owner.planId, branch: owner.branch, executionTarget: { projectId: 'foreign' } };
  expect(await store.getState().task('/flow/steps/start')).toBeNull();
});

it("coalesces public run refresh without Preflight or compilation and retains a pinned pagination cursor", async () => {
  await store.getState().select('run' as SystemStartId);
  const preflights = preflightCalls;
  let release!: (value: PublicProjection) => void;
  readProjection = () => new Promise(resolve => { release = resolve; });
  const first = store.getState().refreshRun(); while (!release) await Promise.resolve();
  expect(store.getState().busy).toBe(false);
  await store.getState().refreshRun(); release(projection('run', '9007199254740994')); await first;
  expect(preflightCalls).toBe(preflights); expect(store.getState().projection?.cursor).toBe('9007199254740994' as Sequence);
  store.setState({ projection: projection('run', '9007199254740994', { cursor: '9007199254740994' as Sequence, offset: 64 }) });
  readProjection = async () => projection('run', '9007199254740995');
  await store.getState().refreshRun(); expect(store.getState().stale).toBe(true);
  expect(store.getState().projection?.cursor).toBe('9007199254740994' as Sequence);
});

it("shares one bounded watcher between views and releases it when both leave", () => {
  const interval = spyOn(globalThis, 'setInterval'); const clear = spyOn(globalThis, 'clearInterval');
  try {
    const a = store.getState().watch(owner, 'conversation', 'run' as SystemStartId);
    const b = store.getState().watch(owner, 'conversation', 'run' as SystemStartId);
    expect(interval).toHaveBeenCalledTimes(1); expect(interval.mock.calls[0][1]).toBe(2000);
    a(); a(); expect(clear).not.toHaveBeenCalled(); b(); expect(clear).toHaveBeenCalledTimes(1);
  } finally { interval.mockRestore(); clear.mockRestore(); }
});

it("preserves already loaded projection and diagnostic pages while watching the same run", async () => {
  await store.getState().select('run' as SystemStartId);
  const old = projection('run');
  const agents = Array.from({ length: 65 }, (_, index) => ({ agentInstanceId: `agent-${index}` as import('../services/agsdlExecution/contracts').AgentInstanceId, agentName: `agent-${index}` }));
  store.setState({ projection: { ...old, agents } });
  await store.getState().refreshRun(); expect(store.getState().projection?.agents).toHaveLength(65);
  store.setState({ projection: old, diagnosticPinned: true });
  const through = store.getState().diagnostic!.through;
  readProjection = async () => projection('run', '9007199254740994');
  await store.getState().refreshRun();
  expect(store.getState().projection?.cursor).toBe('9007199254740994' as Sequence);
  expect(store.getState().diagnostic?.through).toBe(through);
});

it("publishes a translation key instead of private transport or invariant text", async () => {
  readProjection = async () => { throw new Error('Internal receipt identity and native details'); };
  await store.getState().select('run' as SystemStartId);
  expect(store.getState().error).toBe('agsdl.execution.error');
  selected = 'other'; await store.getState().refresh();
  expect(store.getState().error).toBe('agsdl.execution.ownerChanged');
});

const entrySource = '{"contract":"agsdl-0.2.0","flow":{"entry":"start"},"agents":{"real":{}}}';
async function ready(authored = entrySource) {
  available = true; authoredSource = authored;
  useAgsdlStore.setState(state => ({ sessions: { [agsdlSessionKey(target)]: { ...state.sessions[agsdlSessionKey(target)], source: authored } } }));
  await store.getState().refresh();
}
async function reopen() { reload(); await store.getState().open(target, selected); }

it.each(['admitted', 'closed'] as const)("retains a %s 0.3 receipt until a versioned reader can install it", async kind => {
  await ready(); native.loseSubmit = true;
  await store.getState().start('Message');
  native.loseSubmit = false;
  const original = [...native.rows.values()][0];
  // Wire fixture follows 09's generated PublicStartReceipt030; the historical
  // frontend contract has not yet incorporated this native admission variant.
  const row = JSON.parse(JSON.stringify(original));
  const admission = { kind: 'start030', receipt: { systemStartId: 'run-030', flowInvocationId: 'flow', source,
    versions: { snapshot: '2', contract: 'agsdl-0.3.0', compiler: 'c', runtime: 'r', registry: 'v', profile: 'macro-agsdl-030-v1' }, entryDeliveryId: null } };
  row.state = kind === 'admitted' ? { kind, admission } : { kind, disposition: 'acknowledged', admission };
  native.rows.set(row.key.intentId, row);
  store.setState({ intent: row, snapshot: undefined, projection: undefined });
  native.calls = []; seenPages = [];
  await store.getState().resume();
  expect(store.getState().intent?.state.kind).toBe(kind);
  expect(store.getState().snapshot).toBeUndefined();
  expect(store.getState().projection).toBeUndefined();
  expect(store.getState().error).toBe('agsdl.execution.unavailable');
  expect(native.calls).not.toContain('close:acknowledged');
  expect(seenPages).toEqual([]);
});

it("opens with reads only and never stages, submits, closes or preflights", async () => {
  expect(native.calls).toEqual(["read"]); expect(preflightCalls).toBe(0);
  await store.getState().refresh(); await store.getState().start();
  expect(native.calls).not.toContain("stage"); expect(store.getState().error).toContain("unavailable");
});
it('never stages a 0.3 document through the historical start profile even if preflight reports availability', async () => {
  await ready('{"contract":"agsdl-0.3.0","flow":{"entry":"work"},"agents":{}}');
  native.calls = [];
  await store.getState().start('Message');
  expect(store.getState().error).toBe('agsdl.execution.unavailable');
  expect(native.calls).not.toContain('stage');
});
it('refuses to stage when the source returned by the second preflight differs from the saved document', async () => {
  await ready();
  authoredSource = '{"contract":"agsdl-0.2.0","flow":{"entry":"different"}}';
  native.calls = [];
  await store.getState().start('Message');
  expect(store.getState().error).toBe('agsdl.execution.unavailable');
  expect(native.calls).not.toContain('stage');
});
it("shows the latest run read-only after an acknowledged request and a reload", async () => {
  await ready(); await store.getState().start("Message");
  expect(native.calls.at(-1)).toBe("close:acknowledged");
  native.calls = []; const preflightsBefore = preflightCalls;
  await reopen();
  expect(native.calls).toEqual(["read"]);
  expect(preflightCalls).toBe(preflightsBefore);
  expect(store.getState().intent).toBeUndefined();
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
  expect(store.getState().projection?.systemStartId).toBe("started" as SystemStartId);
});
it("opens without a run selection when the scope has no run", async () => {
  await reopen();
  expect(store.getState().runs).toEqual([]);
  expect(store.getState().snapshot).toBeUndefined();
  expect(store.getState().error).toBeUndefined();
});
it("never shows a latest run whose snapshot has another owner", async () => {
  await ready(); await store.getState().start("Message");
  snapshotOwner = { ...owner, planId: "other-plan" };
  await reopen();
  expect(store.getState().snapshot).toBeUndefined();
  expect(store.getState().projection).toBeUndefined();
  expect(store.getState().error).toBe("agsdl.execution.error");
  // A failed snapshot read must not make the same owner permanently unopenable.
  snapshotOwner = owner;
  await store.getState().open({ planId: owner.planId, branchName: owner.branch }, selected);
  expect(store.getState().error).toBeUndefined();
  expect(store.getState().loaded).toBe(true);
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
});
it("keeps an open request first at open and never submits, acknowledges or replaces it", async () => {
  await ready(); await store.getState().start("Message");
  await ready(); native.loseStage = true; await store.getState().start("Retained");
  native.loseStage = false;
  const prepared = native.open()[0];
  expect(prepared?.state.kind).toBe("prepared");
  native.calls = [];
  await reopen();
  expect(native.calls).toEqual(["read"]);
  expect(store.getState().intent?.key).toEqual(prepared.key);
  expect(store.getState().runs).toHaveLength(1);
  expect(store.getState().snapshot).toBeUndefined();
  expect(native.rows.get(prepared.key.intentId)).toEqual(prepared);
});
it("stages a new request, submits it once and acknowledges only after installing its run", async () => {
  await ready(); native.calls = [];
  await store.getState().start("A user message");
  expect(native.calls).toEqual(["stage", "submit", "close:acknowledged"]);
  const [row] = native.rows.values();
  expect(row.payload.kind).toBe("start");
  const request = row.payload.kind === "start" ? row.payload.request : undefined;
  expect(JSON.parse(request!.entry!.messageJson)).toEqual({ prompt: [{ value: "A user message", mediaType: "text/plain" }] });
  expect(request?.associations).toEqual({});
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
  expect(store.getState().runs.map(run => run.systemStartId)).toContain("started");
  expect(store.getState().intent).toBeUndefined();
  expect(row.state).toMatchObject({ kind: "closed", disposition: "acknowledged" });
});
it("does not acknowledge an admission whose run could not be installed", async () => {
  await ready(); readProjection = async () => { throw new Error("projection unavailable"); };
  await store.getState().start("Message");
  expect(native.calls).not.toContain("close:acknowledged");
  expect(store.getState().intent?.state.kind).toBe("admitted");
  readProjection = async id => projection(id);
  native.calls = []; await store.getState().resume();
  expect(native.calls).toEqual(["readOne", "close:acknowledged"]);
  expect(store.getState().intent).toBeUndefined();
});
it("finds an admitted request after a lost submit acknowledgement and reload without a second admission", async () => {
  await ready(); native.loseSubmit = true;
  await store.getState().start("Exact entry");
  const key = native.submitted[0];
  await reopen();
  expect(store.getState().intent?.key).toEqual(key);
  expect(store.getState().intent?.state.kind).toBe("admitted");
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
  expect(native.calls.filter(call => call === "stage" || call === "submit")).toEqual(["stage", "submit"]);
  expect(native.calls).not.toContain("close:acknowledged");
  native.loseSubmit = false; await store.getState().start("Another message");
  expect(native.calls.filter(call => call === "stage")).toHaveLength(1);
  expect(store.getState().error).toBe("agsdl.execution.intentOpen");
  await store.getState().resume();
  expect(native.submitted).toEqual([key]);
  expect(native.calls.at(-1)).toBe("close:acknowledged");
  expect(store.getState().intent).toBeUndefined();
});
it("resumes a prepared request found after a lost stage acknowledgement with the retained key", async () => {
  await ready(); native.loseStage = true;
  await store.getState().start("Retained message");
  expect(native.calls.filter(call => call === "submit")).toHaveLength(0);
  const [row] = native.rows.values();
  await reopen(); expect(store.getState().intent?.state.kind).toBe("prepared");
  native.loseStage = false; await ready();
  await store.getState().start("Different message");
  expect(native.calls.filter(call => call === "stage")).toHaveLength(1);
  await store.getState().resume();
  expect(native.submitted).toEqual([row.key]);
  expect(native.rows.get(row.key.intentId)!.payload).toEqual(row.payload);
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
});
it("keeps a retryable request pending and retries the same key only on an explicit resume", async () => {
  await ready(); native.outcome = "retry";
  await store.getState().start("Message");
  expect(store.getState().intent?.state).toEqual({ kind: "submissionPending", retryableFailure: "RUNTIME_UNAVAILABLE" });
  expect(store.getState().error).toBe("agsdl.execution.retryable");
  await reopen(); expect(native.submitted).toHaveLength(1);
  native.outcome = "admit"; await store.getState().resume();
  expect(native.submitted).toHaveLength(2); expect(native.submitted[1]).toEqual(native.submitted[0]);
  expect(store.getState().intent).toBeUndefined();
});
it("shows a durable refusal and allows a new request only after an explicit discard", async () => {
  await ready(); native.outcome = "refuse";
  await store.getState().start("Message");
  expect(store.getState().error).toBe("agsdl.execution.refused.SOURCE_CHANGED");
  await store.getState().start("Again"); expect(native.calls.filter(call => call === "stage")).toHaveLength(1);
  await store.getState().discard();
  expect(native.calls).toContain("close:discarded"); expect(store.getState().intent).toBeUndefined();
  native.outcome = "admit"; await store.getState().start("New");
  expect(native.calls.filter(call => call === "stage")).toHaveLength(2);
});
it("recovers a lost close acknowledgement from the closed row without another submit or close", async () => {
  await ready(); native.loseClose = true;
  await store.getState().start("Message");
  expect(store.getState().intent?.state.kind).toBe("admitted");
  native.loseClose = false; native.calls = [];
  await store.getState().resume();
  expect(native.calls).toEqual(["readOne"]);
  expect(store.getState().intent).toBeUndefined();
});
it("shows the request another observer holds instead of replacing it", async () => {
  await ready(); native.loseSubmit = true; await store.getState().start("First");
  const held = native.submitted[0];
  store.setState({ intent: undefined });
  await store.getState().start("Second");
  expect(store.getState().intent?.key).toEqual(held);
  expect(store.getState().error).toBe("agsdl.execution.intentOpen");
  expect(native.rows.size).toBe(1);
});
it("sends Stop for the exact run while a submit is blocked and leaves the request running", async () => {
  await ready('{"contract":"agsdl-0.2.0","agents":{"real":{}}}');
  await store.getState().select("run" as SystemStartId);
  readProjection = async id => ({ ...projection(id), systemStop: native.stopState });
  let release!: () => void; native.submitGate = new Promise(resolve => { release = resolve; });
  const delivering = store.getState().deliver("real", "Message");
  for (let turn = 0; turn < 50 && !native.calls.includes("submit"); turn++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(native.calls).toContain("submit");
  expect(store.getState().intentBusy).toBe(true);
  expect(store.getState().acceptedDelivery).toBeUndefined();
  await store.getState().stop();
  expect(native.stops).toEqual([{ systemStartId: "run" as SystemStartId, activationId: null }]);
  expect(store.getState().projection?.systemStop).toEqual({ kind: "requested", requestId: "native-stop-key" });
  expect(store.getState().intentBusy).toBe(true);
  release(); await delivering;
  const [row] = native.rows.values();
  expect(row.payload).toMatchObject({ kind: "deliver", source, request: { systemStartId: "run", agentName: "real" } });
  expect(store.getState().acceptedDelivery).toEqual(row.payload.kind === "deliver" ? row.payload.request : undefined);
  expect(row.state.kind).toBe("closed");
});
it("targets an activation Stop by identity without a renderer request key", async () => {
  await store.getState().select("run" as SystemStartId);
  await store.getState().stop("activation" as ActivationId); await store.getState().stop("activation" as ActivationId);
  expect(native.stops).toEqual([{ systemStartId: "run" as SystemStartId, activationId: "activation" as ActivationId }, { systemStartId: "run" as SystemStartId, activationId: "activation" as ActivationId }]);
  expect(store.getState().error).toBeUndefined();
});

it("starts when plan and document revisions differ while retaining native capture identity", async () => {
  await ready();
  const key = agsdlSessionKey(target);
  useAgsdlStore.setState({ sessions: { [key]: { ...useAgsdlStore.getState().sessions[key], persistedRevision: 7 } } });
  await store.getState().start("Synthetic input");
  expect(store.getState().error).toBeUndefined();
  expect(native.calls).toContain("stage");
  const row = [...native.rows.values()][0];
  expect(row.payload.kind).toBe("start");
  if (row.payload.kind === "start") expect(row.payload.request.source).toEqual(source);
  expect(row.state.kind).toBe("closed");
});

it("refreshes progress summaries only when the native projection advances", async () => {
  await ready(); await store.getState().start("Synthetic input");
  const before = listCalls;
  await store.getState().refreshRun();
  expect(listCalls).toBe(before);
  completedCount = "3";
  readProjection = async id => projection(id, "9007199254740994");
  await store.getState().refreshRun();
  expect(listCalls).toBe(before + 1);
  expect(store.getState().runs[0].counts.completed).toBe("3");
  expect(store.getState().snapshot?.systemStartId).toBe("started" as SystemStartId);
});

it("refreshes native totals after foreground Stop, before a poll can miss the new cursor", async () => {
  await ready(); await store.getState().start("Synthetic input");
  completedCount = "4";
  readProjection = async id => ({ ...projection(id, "9007199254740994"), systemStop: {kind: "confirmed", requestId: "stop"} });
  await store.getState().stop();
  expect(store.getState().runs[0].counts.completed).toBe("4");
  const calls = listCalls;
  await store.getState().refreshRun();
  expect(listCalls).toBe(calls);
  expect(store.getState().runs[0].counts.completed).toBe("4");
});


it("publishes delivery acceptance only after Resume installs a retained receipt", async () => {
  await ready('{"contract":"agsdl-0.2.0","agents":{"real":{}}}');
  await store.getState().select("run" as SystemStartId);
  native.loseSubmit = true;
  await store.getState().deliver("real", "Retained message");
  expect(store.getState().acceptedDelivery).toBeUndefined();
  const row = [...native.rows.values()][0];
  expect(row.payload.kind).toBe("deliver");
  await store.getState().resume();
  expect(store.getState().acceptedDelivery).toEqual(row.payload.kind === "deliver" ? row.payload.request : undefined);
  expect(native.submitted).toHaveLength(1);
});

it("delivers to a retained graphless run without preflighting the current document", async () => {
  await ready('{"contract":"agsdl-0.2.0","agents":{"real":{}}}');
  await store.getState().select("run" as SystemStartId);
  store.setState({ preflight: undefined });
  const checked = preflightCalls;
  await store.getState().deliver("real", "Message after reopening");
  expect(preflightCalls).toBe(checked);
  expect(store.getState().error).toBeUndefined();
  expect(store.getState().acceptedDelivery?.agentName).toBe("real");
  expect(store.getState().acceptedDelivery?.systemStartId).toBe("run" as SystemStartId);
});

it('keeps an explicitly selected runtime while observing another admitted intent on refresh', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = { owner, revision:'1', sourceSha256:await sourceDigest(text) };
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const request = {source:captured,profile:versions.profile,associations:{},requestId:'intent',entry:null};
  wireIntent = {formatVersion:'1',key:{scope:{owner,conversationId:'conversation'},intentId:'intent'},revision:'1',payload:{kind:'start',request},state:{kind:'admitted',admission:{kind:'start030',receipt:{systemStartId:'admitted',flowInvocationId:'flow',source:captured,versions,entryDeliveryId:null}}}};
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  readRuntime030 = async query => ({scope:{...query,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null});
  store.setState({runs030:[{systemStartId:'selected',flowInvocationId:'flow',source:captured,versions,snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'}]});
  await store.getState().select030('selected');
  expect(store.getState().runtime030).toBeDefined();
  await store.getState().refresh();
  expect(store.getState().snapshot030?.systemStartId).toBe('selected');
  expect(store.getState().runtime030?.scope.systemStartId).toBe('selected');
  expect(store.getState().intent030?.state.kind).toBe('admitted');
});
it('marks a retained runtime projection stale when its summary becomes incompatible', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = {owner,revision:'1',sourceSha256:await sourceDigest(text)};
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const run = {systemStartId:'run',flowInvocationId:'flow',source:captured,versions,snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'};
  store.setState({runs030:[run]});
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  readRuntime030 = async query => ({scope:{...query,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null});
  await store.getState().select030('run');
  store.setState({runs030:[{...run,versions:{...versions,runtime:'incompatible'}}]});
  await store.getState().refreshRuntime030();
  expect(store.getState().error).toBe('agsdl.execution.error');
  expect(store.getState().runtime030).toBeDefined();
  expect(store.getState().runtime030Stale).toBe(true);
});

it('refreshes a retained native flow after its summary leaves the current list page', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = { owner, revision:'1', sourceSha256:await sourceDigest(text) };
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const run = {systemStartId:'older',flowInvocationId:'flow',source:captured,versions,snapshotId:'capture',revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'};
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  let reads = 0;
  readRuntime030 = async query => { reads++; return {scope:{...query,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null}; };
  store.setState({runs030:[run]});
  await store.getState().select030('older');
  expect(reads).toBe(1);
  await store.getState().refreshRuns030();
  expect(store.getState().snapshot030?.systemStartId).toBe('older');
  expect(store.getState().runs030).toEqual([]);
  await store.getState().refreshRuntime030();
  expect(reads).toBe(2);
  expect(store.getState().runtime030Stale).toBe(false);
  expect(store.getState().error).toBeUndefined();
  const retained = store.getState().runtime030!;
  store.setState({runtime030:{...retained,scope:{...retained.scope,source:{...captured,revision:'foreign'}}}});
  await store.getState().refreshRuntime030();
  expect(reads).toBe(2);
  expect(store.getState().runtime030Stale).toBe(true);
});

it('reads resumed admitted and closed native receipts before the run summary is loaded', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = {owner,revision:'1',sourceSha256:await sourceDigest(text)};
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const admission = {kind:'start030' as const,receipt:{systemStartId:'older',flowInvocationId:'flow',source:captured,versions,entryDeliveryId:null}};
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  let reads = 0;
  readRuntime030 = async query => { reads++; return {scope:{...query,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null}; };
  for (const kind of ['admitted','closed'] as const) {
    const state: VersionedIntent['state'] = kind === 'admitted' ? {kind,admission} : {kind,disposition:'acknowledged',admission};
    wireIntent = {formatVersion:'1',key:{scope:{owner,conversationId:'conversation'},intentId:'i'},revision:'1',payload:{kind:'start',request:{source:captured,profile:versions.profile,associations:{},requestId:'i',entry:null}},state};
    store.setState({intent030:wireIntent,runs030:[],snapshot030:undefined,runtime030:undefined});
    const before = reads;
    await store.getState().resume();
    expect(store.getState().snapshot030?.systemStartId).toBe('older');
    await store.getState().refreshRuntime030();
    expect(reads).toBe(before + 1);
    expect(store.getState().runtime030Stale).toBe(false);
    expect(store.getState().error).toBeUndefined();
    await store.getState().select030('older');
    expect(reads).toBe(before + 2);
    expect(store.getState().error).toBeUndefined();
  }
});

it('never uses a rejected request receipt for a later runtime read and recovers with a valid receipt', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = {owner,revision:'1',sourceSha256:await sourceDigest(text)};
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const receipt = {systemStartId:'older',flowInvocationId:'good',source:captured,versions,entryDeliveryId:null};
  const request = {source:captured,profile:versions.profile,associations:{},requestId:'i',entry:null};
  wireIntent = {formatVersion:'1',key:{scope:{owner,conversationId:'conversation'},intentId:'i'},revision:'1',payload:{kind:'start',request},state:{kind:'closed',disposition:'acknowledged',admission:{kind:'start030',receipt}}};
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  store.setState({intent030:wireIntent,runs030:[],runtime030:undefined});
  await store.getState().resume();
  expect(store.getState().snapshot030?.systemStartId).toBe('older');
  wireIntent = {...wireIntent,payload:{kind:'start',request:{...request,source:{...captured,revision:'foreign'}}},state:{kind:'closed',disposition:'acknowledged',admission:{kind:'start030',receipt:{...receipt,flowInvocationId:'bad'}}}};
  await store.getState().resume();
  expect(store.getState().error).toBe('agsdl.execution.error');
  let reads=0;
  readRuntime030 = async query => { reads++; return {scope:{...query,snapshotId:'capture'},flowInvocationId:'bad',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null}; };
  await store.getState().refreshRuntime030();
  expect(reads).toBe(0);
  expect(store.getState().runtime030Stale).toBe(true);
  await store.getState().select030('older');
  expect(reads).toBe(0);
  wireIntent = {...wireIntent,payload:{kind:'start',request},state:{kind:'closed',disposition:'acknowledged',admission:{kind:'start030',receipt}}};
  readRuntime030 = async query => { reads++; return {scope:{...query,snapshotId:'capture'},flowInvocationId:'good',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null}; };
  await store.getState().resume();
  await store.getState().refreshRuntime030();
  expect(reads).toBe(1);
  expect(store.getState().error).toBeUndefined();
});

it('does not reuse an observed receipt when its captured document failed verification', async () => {
  const text = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = {owner,revision:'1',sourceSha256:await sourceDigest(text)};
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const receipt = {systemStartId:'older',flowInvocationId:'good',source:captured,versions,entryDeliveryId:null};
  const request = {source:captured,profile:versions.profile,associations:{},requestId:'i',entry:null};
  const valid: VersionedIntent = {formatVersion:'1',key:{scope:{owner,conversationId:'conversation'},intentId:'i'},revision:'1',payload:{kind:'start',request},state:{kind:'closed',disposition:'acknowledged',admission:{kind:'start030',receipt}}};
  wireIntent = valid;
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:text,associations:{},versions});
  store.setState({intent030:valid,runs030:[],runtime030:undefined});
  await store.getState().resume();
  wireIntent = {...valid,revision:'2',state:{kind:'closed',disposition:'acknowledged',admission:{kind:'start030',receipt:{...receipt,flowInvocationId:'bad'}}}};
  readSnapshot030 = async id => ({systemStartId:id,source:captured,authoredSource:'{}',associations:{},versions});
  await store.getState().resume();
  expect(store.getState().error).toBe('agsdl.execution.error');
  let reads = 0;
  readRuntime030 = async query => { reads++; return {scope:{...query,snapshotId:'capture'},flowInvocationId:'bad',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null}; };
  await store.getState().refreshRuntime030();
  expect(reads).toBe(0);
  expect(store.getState().runtime030Stale).toBe(true);
});

it('pages 0.3 history independently, retaining the 0.2 list and rejecting a repeated cursor atomically', async () => {
  const versions = {snapshot:'2',contract:'agsdl-0.3.0',profile:'macro-agsdl-030-v1',compiler:'c',runtime:'r',registry:'g'};
  const run = (id: string) => ({systemStartId:id,flowInvocationId:`flow-${id}`,snapshotId:`snapshot-${id}`,source,versions,revision:'1',stopping:false,verdict:null,ownerStatus:'revoked', interruptedAt: null,phaseCounts:[],physicalPending:'0'});
  const calls: RunListRequest030[] = [];
  listRuns030 = async request => { calls.push(request); return request.after === null ? {runs:[run('a')],nextCursor:'cursor030'} : {runs:[run('b')],nextCursor:'cursor030'}; };
  const legacy = store.getState().runs;
  store.setState({nextRuns:'cursor020'});
  await store.getState().refreshRuns030();
  expect(store.getState().runs030.map(item => item.systemStartId)).toEqual(['a']);
  expect(store.getState().runs030[0].ownerStatus).toBe('revoked');
  await store.getState().moreRuns030();
  expect(calls.map(call => call.after)).toEqual([null,'cursor030']);
  expect(calls.every(call => call.owner === owner || JSON.stringify(call.owner) === JSON.stringify(owner))).toBe(true);
  expect(store.getState().runs030.map(item => item.systemStartId)).toEqual(['a']);
  expect(store.getState().nextRuns030).toBe('cursor030');
  expect(store.getState().runs030Error).toBe(true);
  expect(store.getState().runs).toBe(legacy);
  expect(store.getState().nextRuns).toBe('cursor020');
  listRuns030 = async () => ({runs:[run('b')],nextCursor:null});
  await store.getState().moreRuns030();
  expect(store.getState().runs030.map(item => item.systemStartId)).toEqual(['a','b']);
  expect(store.getState().runs030Error).toBe(false);
});

it('rejects a foreign 0.3 owner and duplicate page without publishing partial history', async () => {
  const versions = {snapshot:'2',contract:'agsdl-0.3.0',profile:'macro-agsdl-030-v1',compiler:'c',runtime:'r',registry:'g'};
  const run = {systemStartId:'a',flowInvocationId:'flow',snapshotId:'capture',source,versions,revision:'1',stopping:false,verdict:null,ownerStatus:'active', interruptedAt: null,phaseCounts:[],physicalPending:'0'};
  listRuns030 = async () => ({runs:[run],nextCursor:'next'});
  await store.getState().refreshRuns030();
  listRuns030 = async () => ({runs:[run],nextCursor:null});
  await store.getState().moreRuns030();
  expect(store.getState().runs030).toEqual([run]);
  expect(store.getState().nextRuns030).toBe('next');
  listRuns030 = async () => ({runs:[{...run,source:{...source,owner:{...owner,projectId:'foreign'}}}],nextCursor:null});
  await store.getState().refreshRuns030();
  expect(store.getState().runs030).toEqual([run]);
  expect(store.getState().runs030Error).toBe(true);
});

it('does not publish a delayed 0.3 history page after the conversation changes', async () => {
  let release!: (page: RunPage030) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  listRuns030 = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = store.getState().refreshRuns030();
  await entered;
  selected = 'other';
  release({runs:[],nextCursor:'foreign-page'});
  await pending;
  expect(store.getState().nextRuns030).toBeNull();
  expect(store.getState().runs030).toEqual([]);
});

it('marks retained runtime stale immediately when a history page contradicts its capture or revision', async () => {
  const authoredSource = '{"contract":"agsdl-0.3.0"}';
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const source = {owner,revision:'1',sourceSha256:await sourceDigest(authoredSource)};
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const run = {systemStartId:'retained',flowInvocationId:'flow',snapshotId:'capture',source,versions,revision:'1',stopping:false,verdict:null,ownerStatus:'revoked', interruptedAt: null,phaseCounts:[],physicalPending:'0'};
  readSnapshot030 = async id => ({systemStartId:id,source,versions,authoredSource,associations:{}});
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  readRuntime030 = async scope => ({scope:{...scope,snapshotId:'capture'},flowInvocationId:'flow',revision:'1',stopping:false,verdict:null,total:'0',items:[],nextPage:null});
  const contradictory = [
    {...run,snapshotId:'another-capture'}, {...run,flowInvocationId:'another-flow'},
    {...run,source:{...source,revision:'2'}}, {...run,versions:{...versions,runtime:'another-runtime'}},
    {...run,revision:'2'},
  ];
  for (const next of contradictory) {
    for (const laterPage of [false,true]) {
      store.setState({runs030:[run],runtime030Stale:false,nextRuns030:null});
      await store.getState().select030('retained');
      const projection = store.getState().runtime030;
      expect(projection).toBeDefined();
      if (laterPage) store.setState({runs030:[],nextRuns030:'next'});
      listRuns030 = async () => ({runs:[next],nextCursor:null});
      if (laterPage) await store.getState().moreRuns030();
      else await store.getState().refreshRuns030();
      expect(store.getState().snapshot030?.systemStartId).toBe('retained');
      expect(store.getState().runtime030).toBe(projection);
      expect(store.getState().runtime030Stale).toBe(true);
    }
  }
});
it('retains a failed history indicator after an unrelated successful operation until the list is read again', async () => {
  const versions = {snapshot:'2' as const,contract:'agsdl-0.3.0' as const,profile:'macro-agsdl-030-v1' as const,compiler:'c',runtime:'r',registry:'g'};
  const run = {systemStartId:'run',flowInvocationId:'flow',snapshotId:'capture',source,versions,revision:'1',stopping:false,verdict:null,ownerStatus:'revoked', interruptedAt: null,phaseCounts:[],physicalPending:'0'};
  store.setState({runs030:[run],snapshot030:{systemStartId:'run',source,versions,authoredSource:'{}',associations:{}}});
  listRuns030 = async () => { throw new Error('Read failed'); };
  await store.getState().refreshRuns030();
  expect(store.getState().runs030Error).toBe(true);
  expect(store.getState().runs030).toEqual([run]);
  readHumans030 = async scope => ({scope,cursor:'',total:'0',requests:[],nextPage:null});
  await store.getState().refreshHumans030();
  expect(store.getState().error).toBeUndefined();
  expect(store.getState().runs030Error).toBe(true);
  expect(store.getState().runs030).toEqual([run]);
  listRuns030 = async () => ({runs:[run],nextCursor:null});
  await store.getState().refreshRuns030();
  expect(store.getState().runs030Error).toBe(false);
});
it('does not overwrite a failed scope opening with a later history read', async () => {
  let historyReads = 0;
  listRuns030 = async () => { historyReads++; return {runs:[],nextCursor:null}; };
  store.setState({loaded:false,error:undefined});
  planConversation = 'another';
  await store.getState().open030(target,selected);
  expect(historyReads).toBe(0);
  expect(store.getState().loaded).toBe(false);
  expect(store.getState().error).toBe('agsdl.execution.ownerChanged');
  planConversation = selected;
  await store.getState().open030(target,selected);
  expect(historyReads).toBe(1);
  expect(store.getState().loaded).toBe(true);
  expect(store.getState().error).toBeUndefined();
});
