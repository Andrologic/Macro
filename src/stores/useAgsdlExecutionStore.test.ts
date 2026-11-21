import { beforeEach,expect,it,mock } from "bun:test";
import type { ExecutionCloseIntentRequest,ExecutionEnsureStopRequest,ExecutionIntentKey,ExecutionStageIntentRequest,FlowInvocationId,IntentRevision,PublicExecutionIntent,PublicProjection,PublicSnapshot,PublicStopState,Sequence,SourceRevision,SystemStartId } from "../services/agsdlExecution/contracts";
import type { PublicSnapshot030 } from '../services/ipc/agsdlExecution030';
import type { RunListRequest030,RunPage030 } from '../types/generated/ipc';
import type { HumanPage030 } from '../types/generated/ipc/HumanPage030';
import type { HumanScope030 } from '../types/generated/ipc/HumanScope030';
import type { PublicExecutionIntent as VersionedIntent } from '../types/generated/ipc/PublicExecutionIntent';
import type { RuntimeProjectionContinuation030 } from '../types/generated/ipc/RuntimeProjectionContinuation030';
import type { RuntimeProjectionPage030 } from '../types/generated/ipc/RuntimeProjectionPage030';
import type { RuntimeProjectionQuery030 } from '../types/generated/ipc/RuntimeProjectionQuery030';
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
let taskResult: unknown = null;
let snapshotOwner = owner;
let readSnapshot030: (id: string) => Promise<PublicSnapshot030>;
let readHumans030: (scope: HumanScope030) => Promise<HumanPage030>;
let readRuntime030: (scope: RuntimeProjectionQuery030, next?: RuntimeProjectionContinuation030) => Promise<RuntimeProjectionPage030>;
let wireIntent: VersionedIntent | undefined;
let codexCode = 'CODEX_SCOPE_CHECK_REQUIRED';
let preflightFailure: string | undefined;
let preflightDiagnostics: { code: string; pointer: string; message: string }[] = [];
let submitted030: VersionedIntent | undefined;
let stopped030: unknown;
mock.module('../services/ipc/agsdlExecution', () => ({ executionCodexStatus: async () => ({ available: codexCode === 'CODEX_SCOPE_CHECK_REQUIRED', code: codexCode }) }));
let listRuns030: (request: RunListRequest030) => Promise<RunPage030>;
mock.module("../services/architectPlanService", () => ({ getArchitectPlan: async () => ({ conversationId: planConversation, status: "draft" }), migrateArchitectPlanToAgsdl: async () => null, updateArchitectPlan: async () => {} }));
mock.module("./useChatStore", () => ({ useChatStore: { getState: () => ({ getPendingArchitectConversationTarget: () => null, selectedConversationId: selected, conversations: [{ id: "conversation", project_id: "project" }, { id: "other", project_id: "foreign" }] }) } }));
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
  stageExecutionIntentVersioned: async (request: any) => {
    native.calls.push('stage030');
    return { formatVersion:'1', key:{ scope:request.scope, intentId:request.intentId }, revision:'1', payload:request.payload, state:{ kind:'prepared' } };
  },
  submitExecutionIntentVersioned: async () => { native.calls.push('submit030'); return submitted030 ?? wireIntent; },
  closeExecutionIntentVersioned: async () => { native.calls.push('close030'); return { ...submitted030!, state:{ kind:'closed', disposition:'acknowledged', admission:(submitted030!.state as any).admission } }; },
  stopExecution030: async (request: unknown) => { stopped030 = request; },
  preflightExecution: async () => { preflightCalls++; if (preflightFailure) throw { code: preflightFailure, message: 'native refusal' }; return { source, authoredSource, diagnostics: preflightDiagnostics, staticValid: true, runtimeSupported: true, productRuntimeAvailable: available, incomplete: false }; },
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
const reload = () => store.setState({ owner: undefined, conversationId: undefined, snapshot030: undefined, humans030: undefined, humans030Stale: false, runtime030: undefined, runtime030Stale: false, preflight: undefined, intent030: undefined, intentBusy: false, stopping: false, busy: false, error: undefined, runs030: [], nextRuns030: null, runs030Error: false });
beforeEach(async () => {
  preflightDiagnostics = [];
  codexCode = 'CODEX_SCOPE_CHECK_REQUIRED'; preflightFailure = undefined; submitted030 = undefined; stopped030 = undefined;
  selected = planConversation = "conversation"; snapshotOwner = owner; seenPages = []; seenDiagnostics = []; taskResult = null; available = false; authoredSource = '{}'; listCalls = preflightCalls = 0; native.reset(); completedCount = "0"; wireIntent = undefined;
  listRuns030 = async () => ({runs:[],nextCursor:null});
  readProjection = async id => projection(id);
  reload();
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { source: '{}', annexes: {}, version: 'v1', persistedRevision: 1, status: 'draft', dirty: false, saving: false, history: [], future: [], reports: [], error: null } } });
  await store.getState().open030(target, selected);
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
  await store.getState().select030('new' as SystemStartId);
  release({ scope: requested, cursor: '', total: '0', requests: [], nextPage: null });
  await first;
  expect(store.getState().snapshot030).toBeUndefined();
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
it('submits a prepared 0.3 intent only after an explicit resume', async () => {
  wireIntent = { formatVersion:'1', key:{scope:{owner,conversationId:'conversation'},intentId:'i'}, revision:'1',
    payload:{kind:'start',request:{source,profile:'macro-agsdl-030-v1',associations:{},requestId:'i',entry:null}}, state:{kind:'prepared'} };
  native.calls = [];
  await reopen();
  expect(store.getState().intent030?.state.kind).toBe('prepared');
  expect(native.calls).toEqual([]);
  await store.getState().resume();
  expect(store.getState().intent030?.state.kind).toBe('prepared');
  expect(native.calls).toEqual(['submit030']);
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
  readSnapshot030 = id => id === 'new' ? Promise.reject(new Error('Synthetic run changed')) : new Promise(resolve => { release = resolve; entered(); });
  const resume = store.getState().resume();
  await started;
  await store.getState().select030('new' as SystemStartId);
  release({systemStartId:'old-030',source:captured,authoredSource:text,versions,associations:{}});
  await resume;
  expect(store.getState().snapshot030).toBeUndefined();
  expect(native.calls).not.toContain('close:acknowledged');
});

async function reopen() { reload(); await store.getState().open030(target, selected); }

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

it('pages 0.3 history and rejects a repeated cursor atomically', async () => {
  const versions = {snapshot:'2',contract:'agsdl-0.3.0',profile:'macro-agsdl-030-v1',compiler:'c',runtime:'r',registry:'g'};
  const run = (id: string) => ({systemStartId:id,flowInvocationId:`flow-${id}`,snapshotId:`snapshot-${id}`,source,versions,revision:'1',stopping:false,verdict:null,ownerStatus:'revoked', interruptedAt: null,phaseCounts:[],physicalPending:'0'});
  const calls: RunListRequest030[] = [];
  listRuns030 = async request => { calls.push(request); return request.after === null ? {runs:[run('a')],nextCursor:'cursor030'} : {runs:[run('b')],nextCursor:'cursor030'}; };
  await store.getState().refreshRuns030();
  expect(store.getState().runs030.map(item => item.systemStartId)).toEqual(['a']);
  expect(store.getState().runs030[0].ownerStatus).toBe('revoked');
  await store.getState().moreRuns030();
  expect(calls.map(call => call.after)).toEqual([null,'cursor030']);
  expect(calls.every(call => call.owner === owner || JSON.stringify(call.owner) === JSON.stringify(owner))).toBe(true);
  expect(store.getState().runs030.map(item => item.systemStartId)).toEqual(['a']);
  expect(store.getState().nextRuns030).toBe('cursor030');
  expect(store.getState().runs030Error).toBe(true);
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

function prepare030() {
  authoredSource = '{"contract":"agsdl-0.3.0","id":"start-test","agents":{"writer":{"harness":"codex","permissions":"read-only"}},"flow":{"entry":"write","steps":{"write":{"type":"agent","agent":"writer"}}}}'; available = true;
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: { source: authoredSource, annexes: {}, version: 'v1', persistedRevision: 1, status: 'draft', dirty: false, saving: false, history: [], future: [], reports: [], error: null } } });
}
it('reports native 0.3 preflight and Codex failures without staging a run', async () => {
  prepare030();
  for (const [code, key] of [['UNSUPPORTED_030_FEATURE','unsupported030'], ['CODEX_LOGIN_REQUIRED','codexLoginRequired'], ['CODEX_NOT_INSTALLED','codexNotInstalled'], ['CODEX_VERSION_UNQUALIFIED','codexUnsupported'], ['CODEX_PLATFORM_UNQUALIFIED','codexUnsupported'], ['CALL_PLATFORM_UNQUALIFIED','callPlatform030'], ['CALL_PERMISSIONS_UNSUPPORTED','callPermissions030'], ['OTHER','error']]) {
    preflightFailure = code;
    await store.getState().start030('write');
    expect(store.getState().error).toBe(`agsdl.execution.${key}`);
    expect(native.calls).not.toContain('stage030');
  }
});
it('distinguishes unsupported Codex status before staging an intent', async () => {
  prepare030();
  for (const code of ['CODEX_VERSION_UNQUALIFIED', 'CODEX_PLATFORM_UNQUALIFIED']) {
    codexCode = code;
    await store.getState().start030('write');
    expect(store.getState().error).toBe('agsdl.execution.codexUnsupported');
    expect(native.calls).not.toContain('stage030');
  }
});
it('announces a native read-only ceiling before admission and clears it on a fresh check', async () => {
  prepare030();
  preflightDiagnostics = [{ code: 'READ_ONLY_CEILING', pointer: '/agsdlHostPermissions', message: 'Workspace writes will be denied' }];
  codexCode = 'CODEX_LOGIN_REQUIRED';
  await store.getState().start030('write');
  expect(store.getState().notice030).toBe('agsdl.execution.readOnly030');
  expect(native.calls).not.toContain('stage030');
  preflightDiagnostics = [];
  await store.getState().start030('write');
  expect(store.getState().notice030).toBeUndefined();
});
it('starts a 0.3 run through a versioned intent and stops the selected run', async () => {
  prepare030();
  const versions = { snapshot:'2' as const, contract:'agsdl-0.3.0' as const, compiler:'c', runtime:'r', registry:'g', profile:'macro-agsdl-030-v1' as const };
  const { sourceDigest } = await import('../services/agsdlExecution/compiler');
  const captured = { ...source, sourceSha256: await sourceDigest(authoredSource) };
  const request = { source: captured, profile:'macro-agsdl-030-v1', associations:{}, requestId:'request', entry:{ deliveryId:'delivery', messageJson:'{}' } };
  readSnapshot030 = async id => ({ systemStartId:id, source:captured, authoredSource, associations:{}, versions });
  submitted030 = { formatVersion:'1', key:{ scope:{ owner, conversationId:'conversation' }, intentId:'intent' }, revision:'2', payload:{ kind:'start', request }, state:{ kind:'admitted', admission:{ kind:'start030', receipt:{ systemStartId:'run', flowInvocationId:'flow', source:captured, versions, entryDeliveryId:'delivery' } } } };
  await store.getState().start030('write');
  expect(native.calls).toEqual(['stage030','submit030','close030']);
  expect(store.getState().launched030).toBe('run');
  await store.getState().stop030('run');
  expect(stopped030).toMatchObject({ systemStartId:'run' });
});

it('stages a command-only 0.3 flow without requiring a Codex installation', async () => {
  prepare030();
  authoredSource = '{"contract":"agsdl-0.3.0","agents":{},"flow":{"entry":"check","steps":{"check":{"type":"call","command":"true"}}}}';
  useAgsdlStore.setState(state => ({ sessions: { [agsdlSessionKey(target)]: { ...state.sessions[agsdlSessionKey(target)], source: authoredSource } } }));
  codexCode = 'CODEX_NOT_INSTALLED';
  await store.getState().start030('check');
  expect(native.calls).toContain('stage030');
  expect(store.getState().error).not.toBe('agsdl.execution.codexNotInstalled');
});

it('retains the precise unsupported-feature launch diagnosis without staging an intent', async () => {
  prepare030();
  preflightDiagnostics = [{ code: 'UNSUPPORTED_030_FEATURE', pointer: '/agents/writer/harness', message: 'The selected writer harness cannot run this document.' }];
  await store.getState().start030('write');
  expect(store.getState().error).toBe('agsdl.execution.unsupported030');
  expect(store.getState().launchDiagnostics030).toEqual(preflightDiagnostics);
  expect(native.calls).not.toContain('stage030');
});
