import { invoke } from '@tauri-apps/api/core';
import type { TaskExecutionGraph } from '../services/taskExecutionGraph';

/** Only the isolated demo supplies synthetic execution snapshots. */
export function readDemoTaskExecutionGraph(taskId: string): Promise<TaskExecutionGraph | null> {
  return invoke('demo_task_execution_graph', { taskId });
}

import type { Task } from '../types';
import type { AgsdlEditorDocument } from '../types/agsdl';
import { createExampleDocument } from '../services/agsdl/examples';
import { pointerPart } from '../services/agsdl/document';

interface DemoGraphPlan { id: string; projectId: string; title: string; agsdl: AgsdlEditorDocument }
const fixturePaths: Record<string, string> = {
  'demo-transcript': '/flow/steps/clarify', 'demo-summary': '/flow/steps/summarize',
  'demo-security': '/flow/steps/security', 'demo-keyboard': '/flow/steps/accessibility',
  'demo-copy': '/flow/steps/edit', 'demo-catalog': '/flow/steps/inspect',
  'demo-deduplicate': '/flow/steps/repair', 'demo-latency': '/flow/steps/investigate',
  'demo-postmortem': '/flow/steps/conclude', 'demo-refund-review': '/flow/steps/approval',
  'demo-order-mail': '/flow/steps/notify', 'demo-archived-guide': '/flow/steps/practical',
};

/** Explicit fixture associations; unrelated standalone examples get their own one-agent graph. */
export function initialDemoTaskGraphs(plans: DemoGraphPlan[], tasks: Task[]): Map<string, TaskExecutionGraph> {
  const result = new Map<string, TaskExecutionGraph>();
  for (const task of tasks) {
    const plan = plans.find(plan => plan.id === task.plan_id && plan.projectId === task.project_id);
    const path = fixturePaths[task.id];
    if (plan && path) {
      const taskPaths = Object.fromEntries(tasks.filter(other => other.plan_id === plan.id && other.project_id === task.project_id && fixturePaths[other.id]).map(other => [fixturePaths[other.id], other.id]));
      result.set(task.id, { title: plan.title, source: plan.agsdl.source, display: structuredClone(plan.agsdl.display), migration: structuredClone(plan.agsdl.migration), taskPaths, selectedPath: path, simulated: true });
    } else {
      const example = createExampleDocument('feature');
      const source = JSON.parse(example.source);
      const agent = Object.values(source.agents)[0];
      source.agents = { task: agent };
      source.flow = { entry: 'task', steps: { task: { type: 'agent', agent: 'task', next: [] } } };
      result.set(task.id, { title: task.title, source: JSON.stringify(source), taskPaths: { '/flow/steps/task': task.id }, selectedPath: '/flow/steps/task', simulated: true });
    }
  }
  return result;
}

/** Capture the blueprint once; later Architect edits cannot change a running demo's graph. */
export function launchedDemoTaskGraph(plan: DemoGraphPlan, agents: Array<{ id?: string }>, taskIds: string[]): Omit<TaskExecutionGraph, 'selectedPath'> {
  const source = JSON.parse(plan.agsdl.source);
  const agentTasks = new Map(agents.map((agent, index) => [agent.id, taskIds[index]]));
  const taskPaths: Record<string, string> = {};
  for (const [name, step] of Object.entries(source.flow?.steps ?? {}) as Array<[string, { type: string; agent?: string }]>) {
    const taskId = step.type === 'agent' && agentTasks.get(step.agent);
    if (taskId) taskPaths[`/flow/steps/${pointerPart(name)}`] = taskId;
  }
  for (const [name, taskId] of agentTasks) if (name && taskId) taskPaths[`/agents/${pointerPart(name)}`] = taskId;
  return { title: plan.title, source: plan.agsdl.source, display: structuredClone(plan.agsdl.display), migration: structuredClone(plan.agsdl.migration), taskPaths, simulated: true };
}
