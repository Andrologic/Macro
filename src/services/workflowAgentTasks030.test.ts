import { afterEach, expect, it } from 'bun:test';
import { configureWorkflowRunAccess030, getWorkflowRunAccess030, loadWorkflowAgentTasks, projectWorkflowAgentTasks030, readWorkflowRun030, type WorkflowAgentTaskPorts } from './workflowAgentTasks';
import { inspectionFixture030, monitorFixture030, ready } from './agsdl/runInspection030.testSupport';
import { sourceDigest } from './agsdlExecution/compiler';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { PublicSnapshot } from './agsdlExecution/contracts';
afterEach(() => configureWorkflowRunAccess030(undefined));
const plan = { id:'sample-plan', title:'Sample', targetBranch:'develop', projectIds:['sample-project'] } as ArchitectPlanRecord;
it('shares one injected access per durable scope and keeps captured history after blueprint replacement', async () => {
  const run = {...inspectionFixture030()}; const access = monitorFixture030(run); let factories = 0;
  configureWorkflowRunAccess030(() => { factories++; return { access }; });
  const scope = { owner: run.capture.source.owner, conversationId:'sample-chat' };
  expect(getWorkflowRunAccess030(scope)).toBe(getWorkflowRunAccess030(scope));
  expect(factories).toBe(1);
  expect(await readWorkflowRun030(run.capture)).toBe(run);
  expect(access.reads).toEqual(['run-current']);
  access.publish({ ...access.snapshot, runs: { 'run-current': { kind:'loading', retained:run } } });
  await expect(readWorkflowRun030(run.capture)).rejects.toThrow('Incomplete');
});
it('routes 0.3 run tasks through their own projection, including a plan without current AgSDL', async () => {
  const run = {...inspectionFixture030()};
  run.capture = { ...run.capture, source: { ...run.capture.source, sourceSha256: await sourceDigest(run.capture.authoredSource) } };
  run.state = { ...run.state, scope:{...run.state.scope, source:run.capture.source} };
  if (run.state.occurrences.kind === 'ready') run.state = {...run.state,occurrences:{...run.state.occurrences,value:run.state.occurrences.value.map(item=>({...item,scope:run.state.scope}))}};
  const access = monitorFixture030(run);
  configureWorkflowRunAccess030(() => ({ access }));
  const ports: WorkflowAgentTaskPorts = {
    runs: async () => ({ runs:[{ systemStartId:run.capture.systemStartId, source:run.capture.source }], nextCursor:null }) as Awaited<ReturnType<WorkflowAgentTaskPorts['runs']>>,
    snapshot: async () => run.capture as unknown as PublicSnapshot,
    projection: async () => { throw new Error('Legacy projection must not run'); },
    approvals: async () => { throw new Error('Legacy approval reader must not run'); },
  };
  const tasks = await loadWorkflowAgentTasks([plan], null, ports);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].conversation_id).toBeNull();
  expect(tasks[0].execution_targets).toEqual([]);
  expect(tasks[0].task_source).toBe('agsdl');
  expect(access.reads).toEqual(['run-current']);
});
it('keeps two native instances of the same agent separate, without one task per visit', () => {
  const run = {...inspectionFixture030()};
  const occurrences = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value : [];
  run.state = { ...run.state, instances:[{...run.state.instances[0], id:'one'}, {...run.state.instances[0], id:'two'}],
    occurrences:ready(occurrences.map(item => ({...item, activation:{...item.activation, instanceId:'one'}}))) };
  if (run.state.occurrences.kind === 'ready') run.state = {...run.state,occurrences:{...run.state.occurrences,value:run.state.occurrences.value.map(item=>({...item,scope:run.state.scope}))}};
  const tasks = projectWorkflowAgentTasks030(plan, run);
  expect(tasks).toHaveLength(2);
  expect(tasks[0].id).not.toBe(tasks[1].id);
  expect(tasks[0].workflow_execution?.activationIds).toHaveLength(2);
  run.state = { ...run.state, occurrences:{kind:'loading', retained:null} };
  expect(() => projectWorkflowAgentTasks030(plan, run)).toThrow('Incomplete');
});
