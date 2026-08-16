import type { AppMode, Conversation, Project, ProjectGroup, Task } from '../types';
import type { ArchitectPlanSummary } from './architectPlanService';

export interface FooterGitProject {
  id: string;
  name: string;
  path: string;
  source: 'project' | 'folder';
}

export interface FooterGitFolder {
  name: string;
  path: string;
}

export interface ResolveFooterGitContextInput {
  mode: AppMode;
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  selectedTaskId: string | null;
  tasks: Task[];
  activeArchitectPlanId: string | null;
  visibleArchitectPlans: ArchitectPlanSummary[];
  selectedConversationId: string | null;
  conversations: Conversation[];
  durableFocusProjectId?: string | null;
  manualProjectId?: string | null;
  selectedFolder?: FooterGitFolder | null;
}

export interface FooterGitContext {
  contextKey: string;
  candidates: FooterGitProject[];
  project: FooterGitProject | null;
  reason: 'resolved' | 'missing_context' | 'ambiguous';
}

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim() ?? '').filter(Boolean)));

const getTaskProjectIds = (task: Task | null): string[] => {
  if (!task) return [];
  return uniqueStrings([
    ...(task.execution_targets ?? []).map((target) => target.projectId),
    ...(task.project_ids ?? []),
    task.project_id,
  ]);
};

const resolveCandidates = (
  projectIds: string[],
  projectsById: Map<string, Project>
): FooterGitProject[] => projectIds.flatMap((projectId) => {
  const project = projectsById.get(projectId);
  const path = project?.path?.trim();
  return project && path
    ? [{ id: project.id, name: project.name, path, source: 'project' }]
    : [];
});

export const resolveFooterGitContext = (
  input: ResolveFooterGitContextInput
): FooterGitContext => {
  const allProjects = [
    ...input.standaloneProjects,
    ...input.projectGroups.flatMap((group) => group.projects),
  ];
  const projectsById = new Map(allProjects.map((project) => [project.id, project]));
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));

  let identity = 'none';
  let projectIds: string[] = [];

  if (input.mode === 'Implement') {
    const task = input.selectedTaskId ? tasksById.get(input.selectedTaskId) ?? null : null;
    identity = task ? task.id : 'none';
    projectIds = getTaskProjectIds(task);
  } else if (input.mode === 'Architect') {
    const plan = input.activeArchitectPlanId
      ? input.visibleArchitectPlans.find((candidate) => candidate.id === input.activeArchitectPlanId) ?? null
      : null;
    identity = plan ? plan.id : 'none';
    projectIds = plan
      ? uniqueStrings([...(plan.projectIds ?? []), plan.projectId])
      : [];
  } else if (input.mode === 'Chat') {
    const conversation = input.selectedConversationId
      ? input.conversations.find((candidate) => candidate.id === input.selectedConversationId) ?? null
      : null;
    identity = conversation ? conversation.id : 'none';
    if (conversation) {
      const linkedTask = conversation.task_id ? tasksById.get(conversation.task_id) ?? null : null;
      const linkedTaskProjectIds = getTaskProjectIds(linkedTask);
      projectIds = conversation.project_id
        ? uniqueStrings([conversation.project_id])
        : linkedTaskProjectIds;
    }
  }

  const canUseSelectedProjectFallback =
    (input.mode === 'Architect' && !input.activeArchitectPlanId) ||
    (input.mode === 'Implement' && !input.selectedTaskId);
  if (canUseSelectedProjectFallback && input.durableFocusProjectId) {
    identity = `project:${input.durableFocusProjectId}`;
    projectIds = [input.durableFocusProjectId];
  }

  let candidates = resolveCandidates(projectIds, projectsById);
  if (
    input.mode === 'Architect' &&
    allProjects.length === 0 &&
    candidates.length === 0 &&
    input.selectedFolder?.path.trim()
  ) {
    const path = input.selectedFolder.path.trim();
    candidates = [{
      id: `folder:${path}`,
      name: input.selectedFolder.name.trim() || path,
      path,
      source: 'folder',
    }];
    identity = `folder:${path}`;
  }
  const contextKey = `${input.mode}:${identity}:${candidates.map((project) => `${project.id}@${project.path}`).join(',')}`;
  const eligibleFocusProjectId = input.manualProjectId ?? (
    input.mode === 'Architect' ? input.durableFocusProjectId : null
  );
  const manuallySelected = eligibleFocusProjectId
    ? candidates.find((project) => project.id === eligibleFocusProjectId) ?? null
    : null;
  const project = candidates.length === 1 ? candidates[0] : manuallySelected;

  return {
    contextKey,
    candidates,
    project: project ?? null,
    reason: project ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'missing_context',
  };
};
