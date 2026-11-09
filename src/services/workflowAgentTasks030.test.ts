import { afterEach, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { configureWorkflowRunAccess030, configureProductionWorkflowRunAccess030, getWorkflowRunAccess030,
  loadWorkflowAgentTasks, projectWorkflowAgentTasks030, readWorkflowRun030, workflowRunAccessSnapshot030, workflowPhaseStates030 } from './workflowAgentTasks';
import { nativeAgentRunFixture030, nativeIntentFor030, nativeTransportFor030 } from './agsdl/runAccess030.testSupport';
import { createRunInspectionAccess030 } from './agsdl/runAccess030';
import { workflowTaskFixture } from './workflowAgentTasks.fixtures';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import type { ArchitectPlanRecord } from './architectPlanService';

const plan = { id:'sample-plan',title:'Native task',targetBranch:'develop',projectIds:['sample-project'],conversationId:'design-conversation' } as ArchitectPlanRecord;
afterEach(() => { configureWorkflowRunAccess030(undefined); removeTauriRuntimeMock(); });

it('discovers actual 030 requests separately from legacy engine_systems and initializes production idempotently', async () => {
  const f = await nativeAgentRunFixture030(); const old = await workflowTaskFixture();
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command,args) => {
    seen.push(command);
    if (command === 'execution_list_runs') return {runs:args?.request.owner.projectId === 'project' ? [old.summary] : [],nextCursor:null};
    if (command === 'execution_list_runs030') return {runs:[f.summary],nextCursor:null};
    if (command === 'execution_read_snapshot') return args?.systemStartId === f.capture.systemStartId ? f.capture : old.snapshot;
    if (command === 'execution_read_intents') return [nativeIntentFor030(f)];
    if (command === 'execution_read_runtime_projection030') return f.runtime;
    if (command === 'execution_read_humans030') throw {code:'NOT_FOUND',message:'True-flow has no legacy Stored row'};
    if (command === 'execution_read_projection') return old.projection;
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
  const tasks = await loadWorkflowAgentTasks([old.plan,plan],null);
  expect(tasks).toHaveLength(3);
  const native = tasks.find(item=>item.workflow_execution?.systemStartId === f.capture.systemStartId)!;
  expect(native.status).toBe('Completed');
  expect(native.conversation_id).toBeNull(); expect(native.execution_targets).toEqual([]);
  expect(seen).toContain('execution_list_runs030');
  expect(seen).toContain('execution_read_intents');
  expect(tasks.filter(item=>item.workflow_execution?.systemStartId === old.snapshot.systemStartId)).toHaveLength(2);
  expect(f.capture.associations).toEqual({});
  expect(bundle.access.getSnapshot().runs[f.capture.systemStartId]).toMatchObject({kind:'ready',value:{state:{humans:{kind:'unavailable',gap:'human-flow-projection'}}}});
});

it('uses only receipt-attested intent correlation for captures without a conversation association', async () => {
  const f = await nativeAgentRunFixture030(); const {transport,scope} = nativeTransportFor030(f);
  configureWorkflowRunAccess030(candidate=>({access:createRunInspectionAccess030({...candidate,conversationId:candidate.conversationId!},transport)}));
  const first = await readWorkflowRun030(f.capture,scope.conversationId);
  expect(first.capture.associations).toEqual({});
  expect(first.state.scope.systemStartId).toBe(f.capture.systemStartId);
  const foreign = getWorkflowRunAccess030({...scope,conversationId:'another-conversation'})!;
  await expect(foreign.access.refreshRun(f.capture.systemStartId)).rejects.toMatchObject({code:'SCOPE_INVALID'});
  transport.readExecutionIntentsVersioned = async()=> [{...nativeIntentFor030(f),state:{kind:'prepared'}}];
  const uncorrelated = createRunInspectionAccess030(scope,transport);
  await expect(uncorrelated.refreshRun(f.capture.systemStartId)).rejects.toMatchObject({code:'SCOPE_UNAVAILABLE'});
});

it('covers exactly the nine phases published by Rust and keeps done physical work active', async () => {
  const rust = readFileSync(new URL('../../src-tauri/src/db/agsdl_execution/discovery030.rs',import.meta.url),'utf8');
  const vocabulary = rust.slice(rust.indexOf('activation.phase.as_str()'),rust.indexOf('"Flow 0.3 discovery activation phase'));
  expect(Object.keys(workflowPhaseStates030).sort()).toEqual([...vocabulary.matchAll(/"([a-z]+)"/g)].map(item=>item[1]).sort());
  const statuses = {ready:'InProgress',queued:'Pending',running:'InProgress',body:'InProgress',group:'InProgress',done:'Completed',preparing:'InProgress',barrier:'InProgress',stopping:'Blocked'} as const;
  for (const [phase,status] of Object.entries(statuses)) {
    const f = await nativeAgentRunFixture030(`native-${phase}`,phase); const {transport,scope} = nativeTransportFor030(f);
    const access = createRunInspectionAccess030(scope,transport); await access.refreshRun(f.capture.systemStartId);
    const read = access.getSnapshot().runs[f.capture.systemStartId]; if(read.kind !== 'ready') throw new Error('Run not ready');
    expect(projectWorkflowAgentTasks030(plan,read.value)[0].status).toBe(status);
    if(phase === 'done') {
      const inspection = read.value;
      const occurrences = inspection.state.occurrences; if(occurrences.kind !== 'ready') throw new Error('Occurrences not ready');
      expect(projectWorkflowAgentTasks030(plan,{...inspection,state:{...inspection.state,occurrences:{...occurrences,value:occurrences.value.map(item=>({...item,activation:{...item.activation,physical:true}}))}}})[0].status).toBe('InProgress');
    }
  }
});
