import { describe, expect, it } from 'bun:test';
import { loadWorkflowAgentTasks, projectWorkflowAgentTasks, refreshWorkflowAgentTasks, retainWorkflowTaskOrder, workflowAgentTaskId } from './workflowAgentTasks';
import { workflowCallFailureFixture, workflowTaskFixture } from './workflowAgentTasks.fixtures';
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

  it('keeps independent Agent FIFO positions and stable Tasks across repeated visits', async () => {
    const f = await workflowTaskFixture();
    const reviewer = (position: string) => {
      const activation = f.activation(position, 'terminal', 'completed', 'reviewer');
      activation.work.activationId = id(`reviewer-${position}`);
      activation.deliveryId = id(`reviewer-delivery-${position}`);
      return activation;
    };
    f.projection.activations = [f.activation('1', 'terminal', 'completed'), reviewer('1')];
    const first = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    f.projection.activations.push(f.activation('2', 'terminal', 'completed'), reviewer('2'));
    const second = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(second.map(task => task.id)).toEqual(first.map(task => task.id));
    expect(second.map(task => task.workflow_execution!.activationIds.length)).toEqual([2, 2]);
    expect(second.map(task => task.status)).toEqual(['Completed', 'Completed']);
    const duplicate = reviewer('2');
    duplicate.work.activationId = id('another-reviewer-activation');
    duplicate.deliveryId = id('another-reviewer-delivery');
    f.projection.activations.push(duplicate);
    expect(() => projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, [])).toThrow('activation identity');
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

  it('excludes other projects and confirms absence of retained runs before excluding a blueprint', async () => {
    const f = await workflowTaskFixture();
    expect(await loadWorkflowAgentTasks([f.plan], ['other'], f.ports)).toEqual([]);
    expect(f.calls).toEqual([]);
    f.plan.agsdl!.design!.kind = 'blueprint';
    f.ports.runs = async () => { f.calls.push('runs'); return { runs: [], nextCursor: null }; };
    expect(await loadWorkflowAgentTasks([f.plan], null, f.ports)).toEqual([]);
    expect(f.calls).toEqual(['runs']);
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

describe('run-level supervision without fabricated pure Tasks', () => {
  const options = { showBlockedTasks: false, showWithoutInteraction: false, showArchived: false,
    runningTaskIds: new Set<string>(), attentionByTaskId: new Map<string, unknown>(), mergeWorkflowRuntimeByTaskId: {} };
  const attentionFor = (tasks: ReturnType<typeof projectWorkflowAgentTasks>) => resolveTaskQueueAttention({ tasks,
    conversations: [], questionnaireDraftsByConversationId: {}, pendingToolApprovalByConversationId: {}, runningTaskIds: new Set() });
  it('keeps one existing row visible for a failed Call while preserving Agent outcomes and exact run identity', async () => {
    const f = await workflowCallFailureFixture();
    const tasks = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(tasks.map(task => task.status)).toEqual(['Completed', 'Blocked']);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].workflow_execution!.runAttention).toEqual({ state: 'failed', activationIds: [id('activation-2')] });
    const attention = attentionFor(tasks);
    expect([...attention.keys()]).toEqual([tasks[0].id]);
    const visible = visibleTaskQueueTasks(tasks, { ...options, attentionByTaskId: attention });
    expect(visible.map(task => task.id)).toEqual([tasks[0].id]);
    expect(visible[0].workflow_execution!.systemStartId).toBe(f.snapshot.systemStartId);
  });
  it.each(['call', 'prepare', 'condition'])('surfaces unresolved uncertainty in a %s without changing the Agent status', async kind => {
    const f = await workflowCallFailureFixture();
    const doc = JSON.parse(f.snapshot.authoredSource);
    doc.flow.steps.inspect.type = kind;
    Object.assign(f.snapshot, { authoredSource: JSON.stringify(doc) });
    const step = f.projection.activations[1];
    step.workState = 'uncertain'; step.terminalKind = null;
    const tasks = projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, []);
    expect(tasks[0].status).toBe('Completed');
    expect(tasks[0].workflow_execution!.runAttention?.state).toBe('uncertain');
    expect(visibleTaskQueueTasks(tasks, options)).toHaveLength(1);
  });
  it('clears uncertainty after recovery and does not alert on an authored onError continuation or its eventual success', async () => {
    const f = await workflowCallFailureFixture(true);
    f.projection.activations[1].workState = 'uncertain';
    f.projection.activations[1].terminalKind = null;
    let tasks = projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, []);
    expect(attentionFor(tasks).size).toBe(1);
    f.projection.activations[1].workState = 'terminal';
    f.projection.activations[1].terminalKind = 'failed';
    const recovery = f.activation('3', 'queued', null, 'reviewer');
    recovery.work.step = ['review'];
    f.projection.activations.push(recovery);
    for (const state of ['queued', 'active', 'terminal'] as const) {
      recovery.workState = state; recovery.terminalKind = state === 'terminal' ? 'completed' : null;
      tasks = projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, []);
      expect(tasks.every(task => !task.workflow_execution!.runAttention)).toBe(true);
      expect(attentionFor(tasks).size).toBe(0);
      expect(visibleTaskQueueTasks(tasks, options)).toEqual([]);
    }
    expect(tasks.map(task => task.status)).toEqual(['Completed', 'Completed']);
  });
  it('rediscovers captured runs and approvals when current provenance, kind and source change', async () => {
    const f = await workflowTaskFixture();
    const initial = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    f.plan.agsdl!.design = { version: 1, kind: 'blueprint', purpose: 'Edited', context: '', rules: [], requirements: [] };
    f.plan.agsdl!.source = '{"contract":"agsdl-0.2.0","id":"edited","agents":{},"configurations":{},"bindings":{}}';
    f.approvals.push({ approvalId: 'approval', work: f.projection.activations[0].work, toolName: 'write', summary: '', status: 'pending' });
    const reloaded = await loadWorkflowAgentTasks([f.plan], null, f.ports);
    expect(reloaded.map(task => task.id)).toEqual(initial.map(task => task.id));
    expect(reloaded[0].workflow_execution!.state).toBe('approval');
    expect(reloaded[0].workflow_execution!.source).toEqual(f.snapshot.source);
    expect(f.snapshot.authoredSource).not.toBe(f.plan.agsdl!.source);
  });
});
