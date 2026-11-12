import { afterEach,expect,it,mock } from 'bun:test';
import { installTauriRuntimeMock,removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { loadTaskExecutionGraph } from './taskExecutionGraph';
afterEach(removeTauriRuntimeMock);

it('opens the native 0.3 capture through receipt-attested scope without Start associations', async () => {
  const { configureWorkflowRunAccess030, configureProductionWorkflowRunAccess030, readWorkflowRun030, projectWorkflowAgentTasks030 } = await import('./workflowAgentTasks');
  const { nativeAgentRunFixture030, nativeIntentFor030, nativeTransportFor030 } = await import('./agsdl/runAccess030.testSupport');
  const { staticReportForSource030 } = await import('./agsdl/staticSemantics030');
  const f = await nativeAgentRunFixture030();
  const { transport } = nativeTransportFor030(f);
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command, args) => {
    seen.push(command);
    if(command === 'execution_read_snapshot') return f.capture;
    if(command === 'execution_list_runs030') return {runs:[f.summary],nextCursor:null};
    if(command === 'execution_read_intents') return [nativeIntentFor030(f)];
    if(command === 'execution_read_run_correlation030') return transport.readExecutionRunCorrelation030(args?.scope, args?.systemStartId);
    if(command === 'execution_read_runtime_projection030') return f.runtime;
    if(command === 'execution_read_humans030') throw {code:'NOT_FOUND',message:'No legacy human row'};
    throw new Error(command);
  }));
  configureProductionWorkflowRunAccess030();
  try {
    const run = await readWorkflowRun030(f.capture,'design-conversation');
    const { plan } = await (await import('./workflowAgentTasks.fixtures')).workflowTaskFixture();
    const tasks = projectWorkflowAgentTasks030({...plan,id:'sample-plan',targetBranch:'develop',projectIds:['sample-project']},run);
    const result = await loadTaskExecutionGraph(tasks[0],tasks);
    expect(result?.access030).toBeDefined();
    expect(f.capture.associations).toEqual({});
    expect(seen).toContain('execution_read_intents');
    expect(seen.filter(command => command === 'execution_read_run_correlation030')).toHaveLength(1);
    expect(seen).not.toContain('execution_read_projection');
    expect(seen).not.toContain('execution_pending_approvals');
    expect(staticReportForSource030(f.capture.authoredSource,result!.reports!)).toBeDefined();
    expect(staticReportForSource030(f.capture.authoredSource+' ',result!.reports!)).toBeUndefined();
  } finally { configureWorkflowRunAccess030(undefined); }
});
