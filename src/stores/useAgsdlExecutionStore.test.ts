import { beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { SystemStartId, Sequence, PublicSnapshot, PublicProjection, SourceRevision, PublicStopState, ActivationId, PublicExecutionIntent, ExecutionIntentKey, ExecutionStageIntentRequest, ExecutionCloseIntentRequest, ExecutionEnsureStopRequest, IntentRevision, FlowInvocationId } from "../services/agsdlExecution/contracts";
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
const reload = () => store.setState({ owner: undefined, conversationId: undefined, snapshot: undefined, projection: undefined, approvals: undefined, diagnostic: undefined, preflight: undefined, intent: undefined, intentBusy: false, acceptedDelivery: undefined, stopping: false, busy: false, error: undefined, runs: [], nextRuns: null });
beforeEach(async () => {
  selected = planConversation = "conversation"; snapshotOwner = owner; seenPages = []; seenDiagnostics = []; projectionChangesCursor = false; taskResult = null; available = false; authoredSource = '{}'; listCalls = preflightCalls = 0; native.reset(); completedCount = "0";
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

const entrySource = '{"flow":{"entry":"start"},"agents":{"real":{}}}';
async function ready(authored = entrySource) {
  available = true; authoredSource = authored;
  useAgsdlStore.setState(state => ({ sessions: { [agsdlSessionKey(target)]: { ...state.sessions[agsdlSessionKey(target)], source: authored } } }));
  await store.getState().refresh();
}
async function reopen() { reload(); await store.getState().open(target, selected); }

it("opens with reads only and never stages, submits, closes or preflights", async () => {
  expect(native.calls).toEqual(["read"]); expect(preflightCalls).toBe(0);
  await store.getState().refresh(); await store.getState().start();
  expect(native.calls).not.toContain("stage"); expect(store.getState().error).toContain("unavailable");
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
  await ready('{"agents":{"real":{}}}');
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
  await ready('{"agents":{"real":{}}}');
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
