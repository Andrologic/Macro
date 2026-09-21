import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { getTaskLifecycleCapabilities, getTaskCommandTargets, useTaskStore } from '../../stores/useTaskStore';
import { getServiceRuntimeCapabilities } from '../index';
import { readArchitectPlanSnapshot, getGitFlowBaseBranch, resolveTargetBranch } from '../architectPlanService';
import { listVisibleTaskArtifacts, readVisibleTaskArtifactContent, taskArtifactContentHash } from '../architectPlanArtifactService';
import { getTaskProjectCommand, loadTaskProjectCommandRegistry } from '../taskProjectCommands';
import { pilotToolTracesList, pilotToolTraceRead } from '../tauriIpc';
import { desktopPilotTasks } from './desktopTaskCatalog';
import { findPilotTask, pilotTaskId } from './taskIdentity';
import { assertPilotReservationCurrent, reservePilotAction } from './actionReservations';
import type { ConversationCaptures } from './conversationCaptures';
import type { ContentTaskRef, ContentTool } from './contentProtocol';
import { exportDetailText, type TaskCompletionSource, type DetailRef, type TaskAction } from './taskCompletionHost';
import { stableJson } from './protocol';
import { getTaskBusinessId, toTaskRuntimeId } from '../durableIdentity';
const fail = (code: string): never => { throw new Error(code); };

export function desktopTaskCompletionSource(instanceId: string, workspaceId: string, conversations: ConversationCaptures, signal?: AbortSignal): TaskCompletionSource {
  const taskFor = (ref: DetailRef) => {
    if (ref.instance_id !== instanceId || !('workspace_id' in ref) || ref.workspace_id !== workspaceId || !('task_id' in ref)) return fail('not_found');
    const task = findPilotTask(desktopPilotTasks(), ref.task_id);
    if (!task || !useAppStore.getState().getProjectById(task.project_id)) return fail('not_found');
    return task;
  };
  return {
    cards: async policy => desktopPilotTasks().map(task => ({
      ref: { instance_id: instanceId, workspace_id: workspaceId, task_id: pilotTaskId(task.id) },
      title: exportDetailText(task.title, policy), description: exportDetailText(task.description, policy),
      source: task.task_source, status: task.status, draft: task.draft,
      plan_title: task.plan_title ? exportDetailText(task.plan_title, policy) : null,
      feature: task.feature_slug ? exportDetailText(task.feature_slug, policy) : null,
      task_kind: task.task_kind ?? null, archived: Boolean(task.archived_at), merged: Boolean(task.merged_at),
      finalization: task.task_source === 'plan_finalization', merge_state: task.merge_workflow_summary?.phase ?? null,
    })),
    load: async (kind, ref, policy) => {
      const text = (value: string) => exportDetailText(value, policy);
      if (kind === 'tools') {
        if (!('conversation_id' in ref) || ref.instance_id !== instanceId) return fail('not_found');
        const catalog = await conversations.refreshCatalogMetadata();
        if (!catalog.refs.some(candidate => stableJson(candidate) === stableJson(ref))) return fail('not_found');
        const metadata = await pilotToolTracesList(ref.conversation_id);
        const items: ContentTool[] = [];
        const details = new Map<string, { messageId: string; traceIndex: number }>();
        for (const trace of metadata.traces) {
          const traceId = pilotTaskId(`trace/${JSON.stringify([trace.message_id, trace.tool_call_id])}`);
          if (details.has(traceId)) return fail('content_unavailable');
          details.set(traceId, { messageId: trace.message_id, traceIndex: trace.trace_index });
          items.push({ trace_id: traceId, message_id: pilotTaskId(trace.message_id), position: items.length,
            tool_name: text(trace.tool_name), status: trace.status, has_detail: trace.has_detail });
        }
        const current = await conversations.refreshCatalogMetadata();
        if (!current.refs.some(candidate => stableJson(candidate) === stableJson(ref))) return fail('not_found');
        return { fingerprint: [metadata.revision, metadata.traces], items, read: async id => {
          const target = details.get(id); if (!target) return null;
          const result = await pilotToolTraceRead({ conversationId: ref.conversation_id, ...target, expectedRevision: metadata.revision });
          if (result.revision !== metadata.revision) return fail('stale_revision');
          return result.detail;
        } };
      }
      const task = taskFor(ref);
      if (kind === 'artifacts') {
        if (!task.plan_id || !['architect', 'plan_finalization'].includes(task.task_source)) return { fingerprint: task, items: [], read: async () => null };
        const branchName = resolveTargetBranch(task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch());
        const plan = await readArchitectPlanSnapshot(branchName, task.plan_id);
        if (!plan || plan.status === 'deleted') return fail('content_unavailable');
        const nodeIds = new Map(plan.nodes.map(node => [toTaskRuntimeId({ branchName, planId: plan.id, nodeId: node.id }), node.id]));
        const artifactTask = { ...task, id: getTaskBusinessId(task), dependencies: task.dependencies.map(id => nodeIds.get(id) ?? id) };
        const target = { branchName, plan, task: artifactTask, existingMetadataOnly: true };
        const artifacts = await listVisibleTaskArtifacts({ ...target, includeOwn: true, includeInherited: true });
        if (artifacts.length > 2000) return fail('resource_limit');
        const ids = new Map(artifacts.map(artifact => [pilotTaskId(`artifact/${artifact.id}`), artifact.id]));
        return { fingerprint: [task, artifacts], items: artifacts.map((artifact, position) => ({
          artifact_id: pilotTaskId(`artifact/${artifact.id}`), position, title: text(artifact.title), summary: text(artifact.summary),
          visibility: artifact.visibility, content_type: artifact.contentType,
        })), read: async id => {
          const artifactId = ids.get(id); if (!artifactId) return null;
          if (stableJson(taskFor(ref)) !== stableJson(task)) return fail('stale_revision');
          const result = await readVisibleTaskArtifactContent({ ...target, artifactId });
          if (taskArtifactContentHash(result.content) !== result.artifact.contentHash) return fail('stale_revision');
          return result.content;
        } };
      }
      const store = useTaskStore.getState();
      const capabilities = getServiceRuntimeCapabilities();
      const lifecycle = getTaskLifecycleCapabilities(task, store.publishedStandaloneTasks[task.id] ?? false);
      const commandTargets = getTaskCommandTargets(task);
      const projectIds = commandTargets.map(target => target.projectId);
      const projects = projectIds.map(id => useAppStore.getState().getProjectById(id));
      if (projects.length > 32) return fail('resource_limit');
      const registry = await loadTaskProjectCommandRegistry(projectIds);
      const configured = projects.map(project => project ? { project, settings: getTaskProjectCommand(registry, project.path) } : null);
      const setupCommands = configured.flatMap((entry, index) => {
        if (!entry?.settings) return [];
        const target = commandTargets[index];
        const setup = target?.executionMode === 'direct' ? '' : entry.settings.worktreeSetupCommand?.trim();
        return [
          ...(setup ? [{ project_id: entry.project.id, project_name: text(`${entry.project.name} (setup)`), command: text(setup) }] : []),
        ];
      });
      const commands = [...setupCommands, ...configured.flatMap(entry => entry?.settings?.command ? [{ project_id: entry.project.id, project_name: text(entry.project.name), command: text(entry.settings.command) }] : [])];
      if (commands.length > 32) return fail('resource_limit');
      const conversation = useChatStore.getState().conversations.find(c => c.task_id === task.id || c.id === task.conversation_id);
      const runtime = conversation ? useChatStore.getState().getConversationRuntime(conversation.id) : null;
      const busy = runtime && !['idle', 'error'].includes(runtime.phase);
      const actions: TaskAction[] = [];
      if (!busy && capabilities.taskMutation) {
        if (lifecycle.canRename) actions.push('rename');
        if (lifecycle.canArchive) actions.push('archive');
        if (lifecycle.canDelete) actions.push('delete');
      }
      if (!busy && capabilities.taskProjectCommands && !task.draft && !task.archived_at && task.task_source !== 'plan_finalization' &&
        configured.length && configured.every(entry => entry?.settings?.command.trim()) && commands.every(command => command.command.content_state === 'complete')) actions.push('run_commands');
      return { fingerprint: [task, configured, busy, capabilities, lifecycle], task: {
        title: text(task.title), description: text(task.description), source: task.task_source, status: task.status,
        draft: task.draft, plan_title: task.plan_title ? text(task.plan_title) : null, feature: task.feature_slug ? text(task.feature_slug) : null,
        task_kind: task.task_kind ?? null, archived: Boolean(task.archived_at), merged: Boolean(task.merged_at),
        finalization: task.task_source === 'plan_finalization', merge_state: task.merge_workflow_summary?.phase ?? null, actions, commands,
      } };
    },
    execute: async (ref: ContentTaskRef, action, title, beforeEffect) => {
      const task = taskFor(ref);
      const reservation = reservePilotAction({ taskId: task.id, conversationId: task.conversation_id ?? undefined });
      try {
        if (action === 'delete' && task.conversation_id) useChatStore.getState().assertPilotConversationDeletionReady(task.conversation_id, reservation.token);
        const projectIds = [...new Set([task.project_id, ...(task.project_ids ?? []), ...(task.execution_targets ?? []).map(target => target.projectId)])];
        const projectScope = () => stableJson(projectIds.map(id => { const project = useAppStore.getState().getProjectById(id); return project ? { id, path: project.path, directEdit: project.directEdit, gitSetupState: project.gitSetupState } : { id }; }));
        const expectedProjectScope = projectScope();
        const assertProjectScope = () => { if (projectScope() !== expectedProjectScope) fail('stale_revision'); };
        const commandProjectIds = getTaskCommandTargets(task).map(target => target.projectId);
        const commandRegistry = action === 'run_commands' ? stableJson(await loadTaskProjectCommandRegistry(commandProjectIds)) : null;
        const options = { signal, pilotActionToken: reservation.token, beforeEffect: async () => {
          if (signal?.aborted) return fail('unavailable');
          assertPilotReservationCurrent(reservation); assertProjectScope();
          if (commandRegistry !== null && stableJson(await loadTaskProjectCommandRegistry(commandProjectIds)) !== commandRegistry) return fail('stale_revision');
          await beforeEffect(); assertPilotReservationCurrent(reservation); assertProjectScope();
        } };
        const store = useTaskStore.getState();
        if (action === 'rename') await store.renameTask(task.id, title!, options);
        else if (action === 'archive') await store.archiveTask(task.id, options);
        else if (action === 'delete') await store.deleteTask(task.id, options);
        else {
          const result = await store.runTaskCommands(task.id, options);
          if (!result || result.status !== 'completed') return fail('content_unavailable');
        }
        if (useTaskStore.getState().lastError) return fail('content_unavailable');
      } finally { reservation.release(); }
    },
  };
}
