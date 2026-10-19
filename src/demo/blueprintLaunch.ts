import type { Task } from '../types';
import type { AgsdlEditorDocument } from '../types/agsdl';

export interface DemoWorkflowStep {
  key: string;
  path: string;
  title: string;
  prompt: string;
  after: string[];
  interaction?: 'question' | 'approval';
  reviewAfter?: boolean;
  finishAfter?: string[];
}

export interface DemoBlueprint {
  id: string;
  projectIds: string[];
  shared?: boolean;
  awaitsInput?: boolean;
  title: string;
  description: string;
  fields: { id: string; label: string; value: string }[];
  agents: { id?: string; title: string; prompt: string }[];
  steps?: DemoWorkflowStep[];
  document?: AgsdlEditorDocument;
}
export interface DemoBlueprintUse {
  id: string;
  blueprint: DemoBlueprint;
  projectId: string;
  objective: string;
  values: Record<string, string>;
  taskIds: string[];
  state: 'prepared' | 'running' | 'completed';
}
export function missingBlueprintFields(blueprint: DemoBlueprint, values: Record<string, string>) {
  return blueprint.fields.filter(field => !(values[field.id] ?? field.value).trim()).map(field => field.id);
}
export function blueprintWorkflowSteps(blueprint: DemoBlueprint): DemoWorkflowStep[] {
  return blueprint.steps ?? blueprint.agents.map((agent, index) => ({
    key: agent.id ?? String(index), path: `/agents/${(agent.id ?? String(index)).replaceAll('~', '~0').replaceAll('/', '~1')}`,
    title: agent.title, prompt: agent.prompt, after: index ? [blueprint.agents[index - 1].id ?? String(index - 1)] : [],
    interaction: index === 0 && blueprint.awaitsInput ? 'question' : undefined,
  }));
}
export function blueprintAgentTasks(use: DemoBlueprintUse): Task[] {
  const steps = blueprintWorkflowSteps(use.blueprint);
  const ids = new Map(steps.map((step, index) => [step.key, `${use.id}-${index}`]));
  return steps.map((step, index) => {
    const dependencies = step.after.map(key => {
      const id = ids.get(key);
      if (!id) throw new Error('Missing demo prerequisite');
      return id;
    });
    return {
      id: `${use.id}-${index}`, plan_id: use.blueprint.id, project_id: use.projectId,
      title: step.title, description: use.objective && use.objective !== use.blueprint.title ? `${use.blueprint.title} · ${use.objective}` : use.blueprint.title,
      status: dependencies.length ? 'Blocked' : step.interaction ? 'AwaitingResponse' : 'InProgress',
      dependencies, blocked_by_task_ids: dependencies, is_blocked: dependencies.length > 0, is_ready: false, estimated_changes: [],
      task_source: 'standalone',
      conversation_id: `${use.id}-chat-${index}`, sequence_index: index,
    };
  });
}
