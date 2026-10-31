import { describe, expect, it } from 'bun:test';
import { loadWorkflowAgentTasks, projectWorkflowAgentTasks, refreshWorkflowAgentTasks, retainWorkflowTaskOrder, workflowAgentTaskId } from './workflowAgentTasks';
import { workflowTaskFixture } from './workflowAgentTasks.fixtures';
import { id } from './agsdlExecution/conformanceFixtures';
import { visibleTaskQueueTasks } from './taskQueueVisibility';
import { resolveTaskQueueAttention } from './taskQueueAttention';
import { resolveActiveTaskIds, resolveTaskStatusIndicatorState } from './taskStatusPresentation';

describe('native workflow Agent Task projection', () => {
  it('uses one Task per run and native instance, across loops, retries and completed visits', async () => {
    const f = await workflowTaskFixture();
    f.projection.activations = [f.activation('1', 'terminal', 'completed'), f.activation('9007199254740993', 'queued')];
    const first = await loadWorkflowAgentTasks([f.plan, f.plan], null, f.ports);
    const second = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(first.map(task => task.id)).toEqual(second.map(task => task.id));
    expect(first).toHaveLength(2);
    expect(first[0].status).toBe('Pending');
    expect(first[0].workflow_execution!.activationIds).toHaveLength(2);
    f.projection.activations = [f.activation('1', 'terminal', 'failed'), f.activation('9007199254740993', 'terminal', 'completed')];
    expect((await loadWorkflowAgentTasks([f.plan], null, f.ports))[0].status).toBe('Completed');
    expect(workflowAgentTaskId('one:two', 'three')).not.toBe(workflowAgentTaskId('one', 'two:three'));
  });

  it('derives active, approval, uncertainty, failure and Stop without changing native state', async () => {
    const f = await workflowTaskFixture();
    const states = async () => (await loadWorkflowAgentTasks([f.plan], null, f.ports))[0];
    expect((await states()).status).toBe('InProgress');
    f.approvals.push({ approvalId: 'approval', work: f.projection.activations[0].work, toolName: 'write', summary: 'Synthetic write', status: 'pending' });
    expect((await states()).status).toBe('AwaitingResponse');
    expect((await states()).workflow_execution!.interactionRequired).toBe(true);
    f.projection.activations[0].workState = 'uncertain';
    expect((await states()).workflow_execution!.state).toBe('uncertain');
    f.approvals.length = 0;
    f.projection.activations = [f.activation('1', 'terminal', 'failed')];
    expect((await states()).status).toBe('Failed');
    f.projection.activations = [f.activation('1')];
    f.projection.systemStop = { kind: 'requested', requestId: 'stop' };
    expect((await states()).workflow_execution!.state).toBe('stopRequested');
    f.projection.activations = [f.activation('1', 'terminal', 'stopped')];
    f.projection.systemStop = { kind: 'confirmed', requestId: 'stop' };
    expect((await states()).workflow_execution!.state).toBe('stopped');
    expect((await states()).status).toBe('Blocked');
    expect(f.projection.activations[0].terminalKind).toBe('stopped');
  });

  it('loads every projection page before deriving a completed state', async () => {
    const f = await workflowTaskFixture();
    f.ports.projection = async (_system, page) => !page ? { ...f.projection,
      activations: [f.activation('1', 'terminal', 'completed')], nextPage: { cursor: id('10'), offset: 64 } } :
      { ...f.projection, agents: [], activations: [f.activation('2', 'queued')] };
    expect((await loadWorkflowAgentTasks([f.plan], null, f.ports))[0].status).toBe('Pending');
    f.ports.projection = async () => ({ ...f.projection, nextPage: { cursor: id('10'), offset: 64 } });
    await expect(loadWorkflowAgentTasks([f.plan], null, f.ports)).rejects.toThrow('stale');
  });

  it('allows more than 64 activations after all native pages were verified', async () => {
    const f = await workflowTaskFixture();
    const all = Array.from({ length: 65 }, (_, index) => f.activation(String(index + 1), 'terminal', 'completed'));
    f.ports.projection = async (_id, page) => ({ ...f.projection, agents: page ? [] : f.projection.agents,
      activations: page ? all.slice(64) : all.slice(0, 64), nextPage: page ? null : { cursor: id('10'), offset: 64 } });
    const tasks = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(tasks[0].status).toBe('Completed');
    expect(tasks[0].workflow_execution!.activationIds).toHaveLength(65);
  });

  it('keeps separate runs separate and refuses repeated run pages or foreign source identities', async () => {
    const f = await workflowTaskFixture();
    f.ports.runs = async ({ after }) => ({ runs: [{ ...f.summary, systemStartId: after ? 'second' : 'run' }], nextCursor: after ? null : 'next' });
    f.ports.snapshot = async system => ({ ...f.snapshot, systemStartId: system });
    f.ports.projection = async system => ({ ...f.projection, systemStartId: system, activations: [] });
    const tasks = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(tasks).toHaveLength(4);
    expect(new Set(tasks.map(task => task.id)).size).toBe(4);
    f.ports.runs = async () => ({ runs: [f.summary], nextCursor: 'same' });
    await expect(loadWorkflowAgentTasks([f.plan], null, f.ports)).rejects.toThrow('Repeated');
    f.ports.runs = async () => ({ runs: [{ ...f.summary, source: { ...f.summary.source, owner: { ...f.summary.source.owner, projectId: 'foreign' } } }], nextCursor: null });
    await expect(loadWorkflowAgentTasks([f.plan], null, f.ports)).rejects.toThrow('capture differs');
  });

  it('excludes blueprints and other projects before any native read', async () => {
    const f = await workflowTaskFixture();
    expect(await loadWorkflowAgentTasks([f.plan], ['other'], f.ports)).toEqual([]);
    f.plan.agsdl!.design!.kind = 'blueprint';
    expect(await loadWorkflowAgentTasks([f.plan], null, f.ports)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('fails closed on incomplete approvals, duplicate instances or mismatched activations', async () => {
    const f = await workflowTaskFixture();
    f.ports.approvals = async () => ({ approvals: [], incomplete: true });
    await expect(loadWorkflowAgentTasks([f.plan], null, f.ports)).rejects.toThrow('Incomplete');
    f.projection.agents.push(f.projection.agents[0]);
    expect(() => projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, [])).toThrow('Duplicate');
    f.projection.agents.pop();
    f.projection.activations[0].work = { ...f.projection.activations[0].work, agentInstanceId: id('foreign') };
    expect(() => projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, [])).toThrow('activation identity');
  });

  it('polls only known captures and refuses a late projection that would overwrite a newer state', async () => {
    const f = await workflowTaskFixture();
    const initial = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    f.calls.length = 0;
    f.projection.activations[0] = f.activation('1', 'terminal', 'completed');
    f.projection.cursor = id('11');
    const completed = await refreshWorkflowAgentTasks(initial, f.ports);
    expect(f.calls).toEqual(['snapshot', 'projection', 'approvals']);
    expect(completed[0].id).toBe(initial[0].id);
    expect(completed[0].status).toBe('Completed');
    expect(() => retainWorkflowTaskOrder(completed, initial)).toThrow('regressed');
  });

  it('uses native activity and approval for existing queue filters and indicators', async () => {
    const f = await workflowTaskFixture();
    let tasks = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    const options = { showBlockedTasks: false, showWithoutInteraction: false, showArchived: false,
      runningTaskIds: new Set<string>(), attentionByTaskId: new Map<string, unknown>(), mergeWorkflowRuntimeByTaskId: {} };
    expect(visibleTaskQueueTasks(tasks, options)).toEqual([]);
    expect(resolveActiveTaskIds({ tasks, conversations: [], conversationRuntimeById: {} }).has(tasks[0].id)).toBe(true);
    expect(resolveTaskStatusIndicatorState(tasks[0].status, false, 'agsdl')).toBe('running');
    const selected = { tasks, conversations: [], conversationRuntimeById: {}, selectedTaskId: tasks[1].id,
      selectedConversationId: 'visible-chat', isStreaming: true };
    expect(resolveActiveTaskIds(selected).has(tasks[1].id)).toBe(false);
    tasks[0].workflow_execution!.stale = true;
    expect(resolveActiveTaskIds(selected).has(tasks[0].id)).toBe(false);
    f.approvals.push({ approvalId: 'approval', work: f.projection.activations[0].work, toolName: 'write', summary: '', status: 'pending' });
    tasks = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    const attention = resolveTaskQueueAttention({ tasks, conversations: [], questionnaireDraftsByConversationId: {},
      pendingToolApprovalByConversationId: {}, runningTaskIds: new Set() });
    expect(attention.get(tasks[0].id)?.kind).toBe('approval');
    expect(visibleTaskQueueTasks(tasks, { ...options, attentionByTaskId: attention }).map(task => task.id)).toEqual([tasks[0].id]);
  });
});
