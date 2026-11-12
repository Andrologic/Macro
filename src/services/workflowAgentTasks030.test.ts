import { afterEach,expect,it,mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installTauriRuntimeMock,removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { createRunInspectionAccess030 } from './agsdl/runAccess030';
import { nativeAgentRunFixture030,nativeIntentFor030,nativeTransportFor030 } from './agsdl/runAccess030.testSupport';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
configureProductionWorkflowRunAccess030,
configureWorkflowRunAccess030,
getWorkflowRunAccess030,
loadWorkflowAgentTasks,projectWorkflowAgentTasks030,readWorkflowRun030,
workflowPhaseStates030,
workflowRunAccessSnapshot030
} from './workflowAgentTasks';
import { workflowTaskFixture } from './workflowAgentTasks.fixtures';

const plan = { id:'sample-plan',title:'Native task',targetBranch:'develop',projectIds:['sample-project'],conversationId:'design-conversation' } as ArchitectPlanRecord;
afterEach(() => { configureWorkflowRunAccess030(undefined); removeTauriRuntimeMock(); });

it('discovers actual 030 requests separately from legacy engine_systems and initializes production idempotently', async () => {
  const f = await nativeAgentRunFixture030(); const old = await workflowTaskFixture();
  const { transport } = nativeTransportFor030(f);
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command,args) => {
    seen.push(command);
    if (command === 'execution_list_runs') return {runs:args?.request.owner.projectId === 'project' ? [old.summary] : [],nextCursor:null};
    if (command === 'execution_list_runs030') return {runs:[f.summary],nextCursor:null};
    if (command === 'execution_read_snapshot') return args?.systemStartId === f.capture.systemStartId ? f.capture : old.snapshot;
    if (command === 'execution_read_intents') return [nativeIntentFor030(f)];
    if (command === 'execution_read_run_correlation030') return transport.readExecutionRunCorrelation030(args?.scope, args?.systemStartId);
    if (command === 'execution_read_runtime_projection030') return f.runtime;
    if (command === 'execution_read_humans030') throw {code:'NOT_FOUND',message:'True-flow has no legacy Stored row'};
    if (command === 'execution_pending_approvals') return {approvals:[],incomplete:false};
    throw new Error(command);
  }));
  configureProductionWorkflowRunAccess030();
  const bundle = getWorkflowRunAccess030({owner:f.capture.source.owner,conversationId:plan.conversationId})!;
  const registry = workflowRunAccessSnapshot030();
  configureProductionWorkflowRunAccess030();
  expect(workflowRunAccessSnapshot030()).toBe(registry);
  expect(getWorkflowRunAccess030({owner:f.capture.source.owner,conversationId:plan.conversationId})).toBe(bundle);
  expect(seen).toEqual([]);
  const tasks = await loadWorkflowAgentTasks([old.plan,{...plan,agsdl:{revision:1,source:f.capture.authoredSource,annexes:{}}}],null,{...old.ports,runs:async request=>({runs:request.owner.projectId==='project'?[old.summary]:[],nextCursor:null})});
  expect(tasks).toHaveLength(3);
  const native = tasks.find(item=>item.workflow_execution?.systemStartId === f.capture.systemStartId)!;
  expect(native.status).toBe('Completed');
  expect(native.conversation_id).toBeNull(); expect(native.execution_targets).toEqual([]);
  expect(seen).toContain('execution_list_runs030');
  expect(seen).toContain('execution_read_intents');
  expect(seen.filter(command => command === 'execution_read_run_correlation030')).toHaveLength(1);
  expect(tasks.filter(item=>item.workflow_execution?.systemStartId === old.snapshot.systemStartId)).toHaveLength(2);
  expect(f.capture.associations).toEqual({});
  expect(bundle.access.getSnapshot().runs[f.capture.systemStartId]).toMatchObject({kind:'ready',value:{state:{humans:{kind:'unavailable',gap:'human-flow-projection'}}}});
});

it('uses durable receipt-attested correlation independently of a new open intent for captures without associations', async () => {
  const f = await nativeAgentRunFixture030(); const {transport,scope,retainedIntents} = nativeTransportFor030(f);
  configureWorkflowRunAccess030(candidate=>({access:createRunInspectionAccess030({...candidate,conversationId:candidate.conversationId!},transport)}));
  const first = await readWorkflowRun030(f.capture,scope.conversationId);
  expect(first.capture.associations).toEqual({});
  expect(first.state.scope.systemStartId).toBe(f.capture.systemStartId);
  const foreign = getWorkflowRunAccess030({...scope,conversationId:'another-conversation'})!;
  await expect(foreign.access.refreshRun(f.capture.systemStartId)).rejects.toMatchObject({code:'SCOPE_INVALID'});
  const retained = retainedIntents.get(f.capture.systemStartId)!;
  if (retained.state.kind !== 'admitted') throw new Error('Expected an admitted native fixture');
  retained.state = { kind: 'closed', disposition: 'acknowledged', admission: retained.state.admission };
  const next = nativeIntentFor030(f);
  if (next.payload.kind !== 'start') throw new Error('Expected a Start fixture');
  next.key.intentId = 'next-intent'; next.payload.request.requestId = 'next-request';
  if (next.payload.request.entry) next.payload.request.entry.deliveryId = 'next-entry';
  next.state = { kind: 'prepared' };
  transport.readExecutionIntentsVersioned = async()=> [next];
  const reopened = createRunInspectionAccess030(scope,transport);
  await reopened.refreshRun(f.capture.systemStartId);
  expect(reopened.getSnapshot().runs[f.capture.systemStartId].kind).toBe('ready');
  expect(reopened.getSnapshot().retainedAdmission).toEqual({kind:'available',value:null});
  retainedIntents.delete(f.capture.systemStartId);
  const uncorrelated = createRunInspectionAccess030(scope,transport);
  await expect(uncorrelated.refreshRun(f.capture.systemStartId)).rejects.toMatchObject({code:'SCOPE_INVALID'});
});

it('covers exactly the nine phases published by Rust and keeps done physical work active', async () => {
  const rust = readFileSync(new URL('../../src-tauri/src/db/agsdl_execution/discovery030.rs',import.meta.url),'utf8');
  const vocabulary = rust.slice(rust.indexOf('activation.phase.as_str()'),rust.indexOf('"Flow 0.3 discovery activation phase'));
  expect(Object.keys(workflowPhaseStates030).sort()).toEqual([...vocabulary.matchAll(/"([a-z]+)"/g)].map(item=>item[1]).sort());
  const statuses = {queued:'InProgress',running:'InProgress',done:'Completed',preparing:'InProgress',stopping:'Blocked'} as const;
  for (const [phase,status] of Object.entries(statuses)) {
    const f = await nativeAgentRunFixture030(`native-${phase}`,phase); const {transport,scope} = nativeTransportFor030(f);
    const access = createRunInspectionAccess030(scope,transport); await access.refreshRun(f.capture.systemStartId);
    const read = access.getSnapshot().runs[f.capture.systemStartId]; if(read.kind !== 'ready') throw new Error('Run not ready');
    expect(projectWorkflowAgentTasks030(plan,read.value)[0].status).toBe(status);
    if(phase === 'done') {
      const inspection = read.value;
      const occurrences = inspection.state.occurrences; if(occurrences.kind !== 'ready') throw new Error('Occurrences not ready');
      expect(projectWorkflowAgentTasks030(plan,{...inspection,state:{...inspection.state,verdict:null,physicalPending:'1',instances:inspection.state.instances.map(instance=>({...instance,discarded:false,currentActivationId:'activation-1'})),occurrences:{...occurrences,value:occurrences.value.map(item=>({...item,activation:{...item.activation,physical:true}}))}}})[0].status).toBe('InProgress');
    }
  }
});

it('never reads 030 intents for conversations without a 030 source and always loads their historical tasks', async () => {
  const old = await workflowTaskFixture(); let factories = 0;
  configureWorkflowRunAccess030(() => { factories++; throw new Error('No 030 reader should be created'); });
  for (const agsdl of [undefined, {revision:1,source:'{"contract":"agsdl-0.2.0"}',annexes:{}}, {revision:1,source:'{',annexes:{}}]) {
    const tasks = await loadWorkflowAgentTasks([{...old.plan,conversationId:'design-conversation',agsdl}],null,old.ports);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(item=>item.workflow_execution?.systemStartId===old.snapshot.systemStartId)).toBe(true);
  }
  expect(factories).toBe(0);
});

it('keeps a native 030 scope failure local while returning the independently read historical tasks', async () => {
  const old=await workflowTaskFixture();const f=await nativeAgentRunFixture030();const {transport,scope}=nativeTransportFor030(f);
  transport.readExecutionIntentsVersioned=async()=>{throw {code:'SCOPE_INVALID',message:'Native intent scope rejected'};};
  configureWorkflowRunAccess030(candidate=>({access:createRunInspectionAccess030({...candidate,conversationId:candidate.conversationId!},transport)}));
  const legacyPorts={...old.ports,runs:async(request:Parameters<typeof old.ports.runs>[0])=>request.owner.projectId==='project'?{runs:[old.summary],nextCursor:null}:{runs:[],nextCursor:null}};
  const nativePlan={...plan,agsdl:{revision:1,source:f.capture.authoredSource,annexes:{}}};
  const tasks=await loadWorkflowAgentTasks([nativePlan,old.plan],null,legacyPorts);
  expect(tasks).toHaveLength(2);
  expect(tasks.every(item=>item.workflow_execution?.systemStartId===old.snapshot.systemStartId)).toBe(true);
  expect(getWorkflowRunAccess030(scope)?.catalogError).toMatchObject({code:'SCOPE_INVALID',message:'Native intent scope rejected'});
  transport.readExecutionIntentsVersioned=async()=>[nativeIntentFor030(f)];
  expect(await loadWorkflowAgentTasks([nativePlan,old.plan],null,legacyPorts)).toHaveLength(3);
  expect(getWorkflowRunAccess030(scope)?.catalogError).toBeUndefined();
});

it('treats physical_end retirement of a new instance as normal completion, independent of its discarded flag', async () => {
  const f=await nativeAgentRunFixture030();const {transport,scope}=nativeTransportFor030(f);
  const access=createRunInspectionAccess030(scope,transport);await access.refreshRun(f.capture.systemStartId);
  const read=access.getSnapshot().runs[f.capture.systemStartId];if(read.kind!=='ready')throw new Error('Run not ready');
  expect(read.value.state).toMatchObject({verdict:'succeeded',physicalPending:'0',instances:[{selectorKind:'new',discarded:true,currentActivationId:null,queueActivationIds:[]}]});
  expect(projectWorkflowAgentTasks030(plan,read.value)[0]).toMatchObject({status:'Completed',is_blocked:false});
});
