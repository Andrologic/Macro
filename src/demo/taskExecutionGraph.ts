import { invoke } from '@tauri-apps/api/core';
import type { TaskExecutionGraph } from '../services/taskExecutionGraph';
import type { AgsdlEditorDocument } from '../types/agsdl';
import type { DemoWorkflowStep } from './blueprintLaunch';

/** Only the isolated demo supplies synthetic execution snapshots. */
export function readDemoTaskExecutionGraph(taskId: string): Promise<TaskExecutionGraph | null> {
  return invoke('demo_task_execution_graph', { taskId });
}

interface DemoGraphPlan { title: string; agsdl: AgsdlEditorDocument }

/** Each authored scene owns its capture; two uses of a blueprint never share task links. */
export function initialDemoTaskGraphs(executions: TaskExecutionGraph[]): Map<string, TaskExecutionGraph> {
  const result = new Map<string, TaskExecutionGraph>();
  for (const execution of executions) for (const [selectedPath, taskId] of Object.entries(execution.taskPaths)) {
    result.set(taskId, { ...structuredClone(execution), selectedPath });
  }
  return result;
}

/** Capture the blueprint once; later Architect edits cannot change a running demo's graph. */
export function launchedDemoTaskGraph(plan: DemoGraphPlan, steps: DemoWorkflowStep[], taskIds: string[]): Omit<TaskExecutionGraph, 'selectedPath'> {
  const taskPaths = Object.fromEntries(steps.map((step, index) => [step.path, taskIds[index]]));
  return { title: plan.title, source: plan.agsdl.source, display: structuredClone(plan.agsdl.display), migration: structuredClone(plan.agsdl.migration), taskPaths, simulated: true };
}
