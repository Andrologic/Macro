import { describe, expect, test } from 'bun:test';
import { demoPlans, demoTasks, demoExecutionGraphs } from './fixtures';
import { demoExecutionScenes } from './executionScenarios';
import { createDemoRuntime } from './runtime';
import { projectViewer } from '../services/agsdl/viewer';
import type { DemoBlueprintUse } from './blueprintLaunch';
import type { TaskExecutionGraph } from '../services/taskExecutionGraph';

describe('authored demo execution scenes', () => {
  test('covers every blueprint with exact block identities and isolated historical task links', () => {
    expect(new Set(demoExecutionScenes.map(scene => scene.planId))).toEqual(new Set(demoPlans.map(plan => plan.id)));
    const links = demoExecutionGraphs.flatMap(graph => Object.values(graph.taskPaths));
    expect(new Set(links).size).toBe(demoTasks.length);
    expect(links).toHaveLength(demoTasks.length);
    for (const graph of demoExecutionGraphs) {
      const viewer = projectViewer(graph.source, graph);
      const cards = [...viewer.graphs.flatMap(graph => graph.cards), ...viewer.declarations];
      for (const [path, taskId] of Object.entries(graph.taskPaths)) {
        expect(demoTasks.find(task => task.id === taskId)?.title).toBe(cards.find(card => card.path === path)?.title);
      }
    }
    const current = demoExecutionGraphs.find(graph => Object.values(graph.taskPaths).includes('demo-copy'))!;
    const archived = demoExecutionGraphs.find(graph => Object.values(graph.taskPaths).includes('demo-archived-guide'))!;
    expect(archived.title).toContain('Édition précédente');
    expect(Object.values(current.taskPaths).some(id => Object.values(archived.taskPaths).includes(id))).toBe(false);
  });

  test('does not classify workflow tasks as inherited Git task kinds', () => {
    for (const task of demoTasks) {
      expect(task.task_kind).toBeUndefined();
      expect(task.standalone_kind).toBeUndefined();
    }
  });

  test('declares writes as external effects with distinct approval and documentation bindings', () => {
    for (const [id, step, approval] of [['demo-quality', 'deliver', 'approval'], ['demo-refund', 'refund', 'approval'], ['demo-delivery', 'publish', 'approval'], ['demo-approvals', 'publish', 'legal'], ['demo-crisis', 'deploy', 'securityApproval']]) {
      const source = JSON.parse(demoPlans.find(plan => plan.id === id)!.agsdl.source);
      const write = source.flow.steps[step];
      const gate = source.flow.steps[approval];
      expect(source.bindings[write.binding].effects).toBe('external');
      expect(source.bindings[gate.binding].effects).toBe('none');
      expect(write.binding).not.toBe(gate.binding);
      expect(write.binding).not.toBe('knowledge');
      expect(gate.call).toBe(step);
    }
  });

  test('provides the catalogue described by the failed import conversation', async () => {
    const runtime = createDemoRuntime();
    const file = await runtime.invoke('fs_read_file', { path: '/demo/helio/fixtures/catalog.csv' }) as { content: string };
    const rows = file.content.trim().split('\n').slice(1);
    expect(rows).toHaveLength(240);
    expect(rows.filter(row => row.startsWith(','))).toHaveLength(12);
  });

  test('never starts a dependent task before its prerequisites or marks an unapproved external effect completed', () => {
    for (const task of demoTasks) {
      const remaining = task.dependencies.filter(id => demoTasks.find(other => other.id === id)?.status !== 'Completed');
      if (task.status === 'Blocked') {
        expect(remaining.length).toBeGreaterThan(0);
        expect(task.blocked_by_task_ids).toEqual(remaining);
      } else expect(remaining).toEqual([]);
    }
    expect(demoTasks.find(task => task.id === 'demo-order-mail')?.status).toBe('Blocked');
    expect(demoTasks.find(task => task.id === 'demo-publication-legal')?.status).toBe('AwaitingResponse');
    const crisis = demoExecutionGraphs.find(graph => Object.values(graph.taskPaths).includes('demo-crisis-security'))!;
    expect(crisis.activity?.['/flow/steps/deploy']).toBeUndefined();
    expect(demoTasks.find(task => task.id === 'demo-crisis-technical')?.status).toBe('Blocked');
  });
});

async function launch(blueprintId: string, projectId: string) {
  const runtime = createDemoRuntime();
  const draft = await runtime.invoke('demo_blueprint_prepare', { blueprintId, projectId }) as DemoBlueprintUse;
  const use = await runtime.invoke('demo_blueprint_start', { id: draft.id }) as DemoBlueprintUse;
  const tasks = use.taskIds.map(id => runtime.tasks.find(task => task.id === id)!);
  return { runtime, use, tasks, advance: () => runtime.invoke('demo_blueprint_advance', { id: use.id }) };
}

describe('scripted demo progression', () => {
  test('captures the prepared document and offers every authored blueprint in its own project', async () => {
    const runtime = createDemoRuntime();
    const catalog = await runtime.invoke('demo_blueprint_catalog') as import('./blueprintLaunch').DemoBlueprint[];
    expect(catalog.map(item => item.id)).toEqual(demoPlans.map(plan => plan.id));
    for (const blueprint of catalog.filter(item => item.id !== 'demo-release')) {
      const use = await runtime.invoke('demo_blueprint_prepare', { blueprintId: blueprint.id, projectId: blueprint.projectIds[0] ?? 'demo-atlas' }) as DemoBlueprintUse;
      expect((await runtime.invoke('demo_blueprint_start', { id: use.id }) as DemoBlueprintUse).taskIds).toHaveLength(blueprint.steps!.length);
      for (const task of runtime.tasks.filter(task => task.plan_id === blueprint.id)) {
        expect(task.task_kind).toBeUndefined();
        expect(task.standalone_kind).toBeUndefined();
      }
    }
    const draft = await runtime.invoke('demo_blueprint_prepare', { blueprintId: 'demo-quality', projectId: 'demo-atlas' }) as DemoBlueprintUse;
    const before = draft.blueprint.document!.source;
    runtime.plans.find(plan => plan.id === 'demo-quality')!.agsdl.source = '{}';
    const started = await runtime.invoke('demo_blueprint_start', { id: draft.id }) as DemoBlueprintUse;
    expect((await runtime.invoke('demo_task_execution_graph', { taskId: started.taskIds[0] }) as TaskExecutionGraph).source).toBe(before);
  });

  test('runs independent checks together, joins them, and waits for an explicit review decision', async () => {
    const { runtime, use, tasks, advance } = await launch('demo-quality', 'demo-atlas');
    await advance();
    expect(tasks.map(task => task.status)).toEqual(['Completed', 'InProgress', 'InProgress', 'InProgress', 'Blocked', 'Blocked']);
    await advance();
    expect(tasks.map(task => task.status)).toEqual(['Completed', 'Completed', 'Completed', 'Completed', 'InProgress', 'Blocked']);
    await advance();
    expect(tasks.at(-1)?.status).toBe('AwaitingResponse');
    await runtime.invoke('db_create_message', { params: { conversationId: tasks.at(-1)!.conversation_id, role: 'user', content: 'I have a question about this approval.' } });
    await advance();
    expect(tasks.at(-1)?.status).toBe('AwaitingResponse');
    expect((await runtime.invoke('demo_blueprint_uses') as DemoBlueprintUse[]).find(item => item.id === use.id)?.state).toBe('running');
  });

  test('keeps the persistent writer active while the observer sends steering', async () => {
    const { runtime, tasks, advance } = await launch('demo-persistent', 'demo-atlas');
    expect(tasks.map(task => task.status)).toEqual(['InProgress', 'AwaitingResponse', 'Blocked', 'Blocked']);
    await advance();
    expect(tasks[0].status).toBe('InProgress');
    await runtime.invoke('db_create_message', { params: { conversationId: tasks[1].conversation_id, role: 'user', content: 'Prefer concrete technical examples.' } });
    await advance();
    expect(tasks.map(task => task.status)).toEqual(['InProgress', 'Completed', 'InProgress', 'Blocked']);
    await advance();
    await advance();
    expect(tasks.map(task => task.status)).toEqual(['Completed', 'Completed', 'Completed', 'InProgress']);
  });

  test('keeps a graphless team independent and maps composition calls to their exact outer blocks', async () => {
    const resident = await launch('demo-resident', 'demo-meridian');
    expect(resident.tasks.every(task => task.dependencies.length === 0)).toBe(true);
    await resident.advance();
    expect(resident.tasks.map(task => task.status)).toEqual(['AwaitingResponse', 'Completed', 'AwaitingResponse']);
    const delivery = await launch('demo-delivery', 'demo-luma');
    const graph = await delivery.runtime.invoke('demo_task_execution_graph', { taskId: delivery.tasks[1].id }) as TaskExecutionGraph;
    expect(graph.taskPaths['/flow/steps/web']).toBe(delivery.tasks[1].id);
    expect(graph.taskPaths['/flow/steps/mobile']).toBe(delivery.tasks[2].id);
    expect(graph.taskPaths['/flow/steps/coordinatorReview']).toBe(delivery.tasks[3].id);
    expect(Object.keys(graph.taskPaths).some(path => path.startsWith('/compositions/'))).toBe(false);
  });
});
