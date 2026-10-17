import type { Task } from '../types';

export interface DemoBlueprint {
  id: string;
  projectIds: string[];
  shared?: boolean;
  awaitsInput?: boolean;
  title: string;
  description: string;
  fields: { id: string; label: string; value: string }[];
  agents: { title: string; prompt: string }[];
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
export function blueprintAgentTasks(use: DemoBlueprintUse): Task[] {
  return use.blueprint.agents.map((agent, index) => ({
    id: `${use.id}-${index}`, plan_id: use.blueprint.id, project_id: use.projectId,
    title: agent.title, description: use.objective && use.objective !== use.blueprint.title ? `${use.blueprint.title} · ${use.objective}` : use.blueprint.title,
    status: index === 0 ? (use.blueprint.awaitsInput ? 'AwaitingResponse' : 'InProgress') : 'Blocked',
    dependencies: index ? [`${use.id}-${index - 1}`] : [],
    blocked_by_task_ids: index ? [`${use.id}-${index - 1}`] : [],
    is_blocked: index > 0, is_ready: false, estimated_changes: [],
    task_source: 'standalone', task_kind: 'direct', standalone_kind: 'manual_feature',
    conversation_id: `${use.id}-chat-${index}`, sequence_index: index,
  }));
}
