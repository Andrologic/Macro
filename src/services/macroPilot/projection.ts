import type {
  ChatMessage,
  Conversation,
  ConversationQuestionnaireDraft,
  PendingToolApproval,
  Project,
  QuestionnairePayload,
  Task,
} from '../../types';
import type { CatalogedImplementTask } from '../implementTaskCatalog';
import { resolveProjectExecutionMode } from '../projectExecutionMode';
import { resolveTaskQueueSupervision } from '../taskQueueAttention';
import { PilotError, stableJson, type Resource, type Wire } from './protocol';

const CONTRACT_VERSION = '1.0' as const;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_TEXT = /((?:file:\/\/|\/(?:Users|home|private|var|tmp|opt|etc|root|Volumes)\/|[A-Za-z]:\\)[^\s"'<>]*|gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/gi;

type DesktopTask = Task | CatalogedImplementTask;
type ConnectionState = 'reachable' | 'unreachable' | 'revoked';
type ResolutionActor =
  | { account_id: string; session_id: string; device_id: string }
  | { origin: 'local' | 'unknown' };

export interface ProjectionRecordState {
  fingerprint: string;
  revision: number;
  firstObservedAt: string;
  stableId?: string;
  snapshot?: Resource;
  boundRunId?: string | null;
}

export interface ProjectionState {
  version: 1;
  resources: Record<string, ProjectionRecordState>;
}

export interface LocalResolutionEvidence {
  resolvedAt: string;
  resolvedBy?: ResolutionActor;
}

export interface ToolApprovalResolutionEvidence extends LocalResolutionEvidence {
  verdict: 'approve' | 'deny';
  grantScope?: 'once' | 'conversation';
  reason?: string;
}

export interface DesktopProjectionInput {
  instance: {
    instanceId: string;
    label: string;
    connectionState: ConnectionState;
  };
  workspace: {
    workspaceId: string;
    label: string;
  };
  projects: Project[];
  tasks: DesktopTask[];
  conversations: Conversation[];
  messages?: ChatMessage[];
  messagesByConversationId?: Record<string, ChatMessage[]>;
  questionnaireDraftsByConversationId?: Record<string, ConversationQuestionnaireDraft>;
  pendingToolApprovalByConversationId?: Record<string, PendingToolApproval | undefined>;
  runningTaskIds?: ReadonlySet<string> | readonly string[];
  knownRuns?: Array<{
    taskId: string;
    runId: string;
    startedAt: string;
    finishedAt?: string;
  }>;
  toolApprovalObservedAtBySourceKey?: Record<string, string | undefined>;
  localDecisionResolutionsByAssistantMessageId?: Record<string, LocalResolutionEvidence | undefined>;
  toolApprovalResolutionsBySourceKey?: Record<string, ToolApprovalResolutionEvidence | undefined>;
}

export interface DesktopProjectionSnapshots {
  instance: Resource;
  workspace: Resource;
  projects: Resource[];
  tasks: Resource[];
  runs: Resource[];
  decisions: Resource[];
  toolApprovals: Resource[];
  reviews: Resource[];
}

export interface DesktopProjectionResult {
  snapshots: DesktopProjectionSnapshots;
  state: ProjectionState;
}

export const toolApprovalSourceKey = (
  approval: Pick<PendingToolApproval, 'conversationId' | 'assistantMessageId' | 'toolCallId'>,
): string => stableJson([
  approval.conversationId,
  approval.assistantMessageId,
  approval.toolCallId,
]);

const failProjection = (): never => {
  throw new PilotError('validation_failed');
};

const normalizeTimestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) failProjection();
  return date.toISOString();
};

const assertSourceId = (value: string, opaque = false): string => {
  if (!SOURCE_ID.test(value) || value.length > (opaque ? 128 : 255) || (opaque && value.length < 8)) {
    failProjection();
  }
  return value;
};

const cleanText = (value: string, maxLength: number): string => {
  const cleaned = value.replace(UNSAFE_TEXT, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
  return cleaned || '[redacted]';
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const fingerprintValue = (value: Wire): string => {
  const semantic = { ...value };
  delete semantic.revision;
  delete semantic.observed_at;
  delete semantic.last_seen_at;
  return stableJson(semantic);
};

const stableHash = (value: string): string => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(36)}${right.toString(36)}`;
};

interface ProjectionContext {
  now: string;
  previous: ProjectionState;
  next: ProjectionState;
}

const materializeResource = (
  context: ProjectionContext,
  key: string,
  draft: Wire,
  stableIdFactory?: () => string,
  persistSnapshot = false,
  boundRunId?: string | null,
): Resource => {
  const previous = context.previous.resources[key];
  const stableId = previous?.stableId ?? stableIdFactory?.();
  const withIdentity = stableId ? { ...draft, __stable_id: stableId } : draft;
  const fingerprint = fingerprintValue(withIdentity);
  const revision = previous ? previous.revision + Number(previous.fingerprint !== fingerprint) : 1;
  const firstObservedAt = previous?.firstObservedAt ?? context.now;
  const resource = { ...draft, revision } as Resource;
  if ('observed_at' in resource) resource.observed_at = firstObservedAt;
  context.next.resources[key] = {
    fingerprint,
    revision,
    firstObservedAt,
    ...(stableId ? { stableId } : {}),
    ...(persistSnapshot ? { snapshot: resource } : {}),
    ...(boundRunId !== undefined
      ? { boundRunId }
      : previous && Object.hasOwn(previous, 'boundRunId')
        ? { boundRunId: previous.boundRunId ?? null }
        : {}),
  };
  return resource;
};

const resolveRunBinding = (
  input: DesktopProjectionInput,
  previous: ProjectionRecordState | undefined,
  taskId: string,
  sourceTimestamp: string | undefined,
): string | null => {
  if (previous && Object.hasOwn(previous, 'boundRunId')) return previous.boundRunId ?? null;
  if (!sourceTimestamp) return null;
  const sourceTime = normalizeTimestamp(sourceTimestamp);
  const candidates = (input.knownRuns ?? []).flatMap((run) => {
    assertSourceId(run.taskId, true);
    assertSourceId(run.runId, true);
    const startedAt = normalizeTimestamp(run.startedAt);
    const finishedAt = run.finishedAt ? normalizeTimestamp(run.finishedAt) : undefined;
    if (run.taskId !== taskId || startedAt > sourceTime || (finishedAt && sourceTime > finishedAt)) return [];
    return [{ runId: run.runId, startedAt }];
  });
  candidates.sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt) || left.runId.localeCompare(right.runId));
  return candidates[0]?.runId ?? null;
};

const messagesForConversation = (
  input: DesktopProjectionInput,
  conversationId: string,
): ChatMessage[] => {
  const indexed = input.messagesByConversationId?.[conversationId];
  if (indexed) return indexed;
  return (input.messages ?? []).filter((message) => message.conversation_id === conversationId);
};

const mapRepositoryState = (state: Project['gitSetupState']): 'ready' | 'not_git' | 'unborn' | 'unknown' => {
  if (state === 'ready' || state === 'not_git' || state === 'unborn') return state;
  return 'unknown';
};

const resolveExecutionTargets = (
  task: DesktopTask,
  projectsById: Map<string, Project>,
): Array<{ project_id: string; execution_mode: 'git' | 'direct' }> => {
  const projectIds = unique(task.project_ids?.length ? task.project_ids : [task.project_id]);
  if (projectIds.length === 0) failProjection();
  const explicitByProjectId = new Map((task.execution_targets ?? []).map((target) => [target.projectId, target]));
  if ((task.execution_targets?.length ?? 0) > 0 && explicitByProjectId.size !== task.execution_targets!.length) {
    failProjection();
  }
  if (task.execution_targets?.some((target) => !projectIds.includes(target.projectId))) failProjection();

  return projectIds.map((projectId) => {
    assertSourceId(projectId, true);
    const target = explicitByProjectId.get(projectId);
    if (task.execution_targets?.length && !target) failProjection();
    const resolution = resolveProjectExecutionMode({ project: projectsById.get(projectId), target });
    if (resolution.mode !== 'git' && resolution.mode !== 'direct') failProjection();
    const executionMode: 'git' | 'direct' = resolution.mode === 'git' ? 'git' : 'direct';
    return { project_id: projectId, execution_mode: executionMode };
  });
};

const mapTaskState = (
  task: DesktopTask,
  attentionKind: 'approval' | 'questionnaire' | 'reply' | 'review' | undefined,
): string => {
  if (attentionKind === 'approval') return 'waiting_tool_approval';
  if (attentionKind === 'questionnaire') return 'waiting_decision';
  if (attentionKind === 'reply') return 'waiting_reply';
  if (attentionKind === 'review') return 'review_ready';
  switch (task.status) {
    case 'Pending': return 'queued';
    case 'InProgress': return 'running';
    case 'AwaitingResponse': return 'waiting_reply';
    case 'InReview': return 'review_ready';
    case 'Blocked': return 'blocked';
    case 'Completed': return 'completed';
    case 'Failed': return 'failed';
  }
};

const projectQuestionnaire = (questionnaire: QuestionnairePayload): Wire[] => {
  const ids = new Set<string>();
  return questionnaire.questions.map((question) => {
    assertSourceId(question.id);
    if (ids.has(question.id)) failProjection();
    ids.add(question.id);
    const choices = question.choices.map((choice) => cleanText(choice, 160));
    if (new Set(choices).size !== 3) failProjection();
    return {
      step_id: question.id,
      prompt: cleanText(question.prompt, 4000),
      choices,
      free_text_allowed: true,
      ...(question.free_text_placeholder
        ? { free_text_placeholder: cleanText(question.free_text_placeholder, 300) }
        : {}),
    };
  });
};

const decisionResources = (
  input: DesktopProjectionInput,
  context: ProjectionContext,
  tasksById: Map<string, DesktopTask>,
): Resource[] => {
  const decisions: Resource[] = [];
  for (const conversation of input.conversations) {
    assertSourceId(conversation.id);
    const transcript = messagesForConversation(input, conversation.id);
    for (const assistantMessage of transcript) {
      if (assistantMessage.role !== 'assistant' || !assistantMessage.questionnaire) continue;
      assertSourceId(assistantMessage.id);
      const taskId = assistantMessage.task_id || conversation.task_id;
      if (!taskId || !tasksById.has(taskId)) continue;
      assertSourceId(taskId, true);
      const sourceKey = `decision:${conversation.id}:${assistantMessage.id}`;
      const stateEntry = context.previous.resources[sourceKey];
      const runId = resolveRunBinding(input, stateEntry, taskId, assistantMessage.timestamp);
      const response = transcript.find((message) =>
        message.role === 'user' &&
        message.questionnaire_response_summary?.assistantMessageId === assistantMessage.id,
      );
      const summary = response?.questionnaire_response_summary;
      const evidence = input.localDecisionResolutionsByAssistantMessageId?.[assistantMessage.id];
      const decisionId = stateEntry?.stableId ?? `decision:${stableHash(sourceKey)}`;
      const steps = projectQuestionnaire(assistantMessage.questionnaire);
      const ref = {
        type: 'decision',
        instance_id: input.instance.instanceId,
        workspace_id: input.workspace.workspaceId,
        task_id: taskId,
        ...(runId ? { run_id: runId } : {}),
        decision_id: decisionId,
        conversation_id: conversation.id,
        assistant_message_id: assistantMessage.id,
      };
      const resolution = summary ? {
        answers: steps.map((step) => {
          const item = summary.items.find((candidate) => candidate.id === step.step_id) ??
            summary.items.find((candidate) => cleanText(candidate.prompt, 4000) === step.prompt);
          const answer = item?.answer ?? '';
          if (!answer.trim()) failProjection();
          return { step_id: step.step_id, answer: cleanText(answer, 4000) };
        }),
        resolved_by: evidence?.resolvedBy ?? (evidence ? { origin: 'local' } : { origin: 'unknown' }),
        ...(evidence ? { resolved_at: normalizeTimestamp(evidence.resolvedAt) } : {}),
      } : undefined;
      const createdAt = assistantMessage.timestamp ? normalizeTimestamp(assistantMessage.timestamp) : undefined;
      decisions.push(materializeResource(context, sourceKey, {
        contract_version: CONTRACT_VERSION,
        type: 'decision',
        ref,
        state: summary ? 'resolved' : 'pending',
        steps,
        ...(resolution ? { resolution } : {}),
        ...(createdAt ? { created_at: createdAt } : { observed_at: context.now }),
      }, () => decisionId, false, runId));
    }
  }
  return decisions;
};

const approvalResources = (
  input: DesktopProjectionInput,
  context: ProjectionContext,
  tasksById: Map<string, DesktopTask>,
): Resource[] => {
  const approvals: Resource[] = [];
  const currentSourceKeys = new Set<string>();
  const conversationsById = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  for (const approval of Object.values(input.pendingToolApprovalByConversationId ?? {})) {
    if (!approval) continue;
    const sourceKey = toolApprovalSourceKey(approval);
    currentSourceKeys.add(sourceKey);
    const conversation = conversationsById.get(approval.conversationId);
    const taskId = conversation?.task_id && tasksById.has(conversation.task_id)
      ? conversation.task_id
      : [...tasksById.values()].find((task) => task.conversation_id === approval.conversationId)?.id;
    assertSourceId(approval.conversationId);
    assertSourceId(approval.assistantMessageId);
    assertSourceId(approval.toolCallId);
    assertSourceId(approval.toolId);
    if (taskId) assertSourceId(taskId, true);
    const evidence = input.toolApprovalResolutionsBySourceKey?.[sourceKey];
    const resourceKey = `approval:${sourceKey}`;
    const runId = taskId
      ? resolveRunBinding(
          input,
          context.previous.resources[resourceKey],
          taskId,
          input.toolApprovalObservedAtBySourceKey?.[sourceKey],
        )
      : null;
    if (evidence?.verdict === 'approve' && !evidence.grantScope) failProjection();
    const allowedScopes = approval.canApproveForConversation ? ['once', 'conversation'] : ['once'];
    if (evidence?.grantScope && !allowedScopes.includes(evidence.grantScope)) failProjection();
    const resolution = evidence ? {
      verdict: evidence.verdict,
      ...(evidence.verdict === 'approve' ? { grant_scope: evidence.grantScope } : {}),
      ...(evidence.verdict === 'deny' && evidence.reason ? { reason: cleanText(evidence.reason, 500) } : {}),
      resolved_by: evidence.resolvedBy ?? { origin: 'local' },
      resolved_at: normalizeTimestamp(evidence.resolvedAt),
    } : undefined;
    const ref = {
      type: 'tool_approval',
      instance_id: input.instance.instanceId,
      ...(taskId ? {
        workspace_id: input.workspace.workspaceId,
        task_id: taskId,
        ...(runId ? { run_id: runId } : {}),
      } : {}),
      conversation_id: approval.conversationId,
      assistant_message_id: approval.assistantMessageId,
      tool_call_id: approval.toolCallId,
    };
    approvals.push(materializeResource(context, resourceKey, {
      contract_version: CONTRACT_VERSION,
      type: 'tool_approval',
      ref,
      state: evidence ? 'resolved' : approval.recoveryState === 'interrupted' ? 'interrupted' : 'pending',
      tool_id: approval.toolId,
      action_group: approval.actionGroup,
      risk_level: approval.riskLevel,
      is_destructive: approval.isDestructive === true,
      summary: cleanText(approval.summary, 1000),
      allowed_scopes: allowedScopes,
      ...(resolution ? { resolution } : {}),
      observed_at: context.now,
    }, undefined, true, runId));
  }

  for (const [sourceKey, evidence] of Object.entries(input.toolApprovalResolutionsBySourceKey ?? {})) {
    if (!evidence || currentSourceKeys.has(sourceKey)) continue;
    const resourceKey = `approval:${sourceKey}`;
    const previousSnapshot = context.previous.resources[resourceKey]?.snapshot;
    if (!previousSnapshot || previousSnapshot.type !== 'tool_approval') continue;
    const allowedScopes = Array.isArray(previousSnapshot.allowed_scopes)
      ? previousSnapshot.allowed_scopes
      : [];
    if (evidence.verdict === 'approve' &&
      (!evidence.grantScope || !allowedScopes.includes(evidence.grantScope))) {
      failProjection();
    }
    const draft: Wire = { ...previousSnapshot };
    delete draft.revision;
    draft.state = 'resolved';
    draft.resolution = {
      verdict: evidence.verdict,
      ...(evidence.verdict === 'approve' ? { grant_scope: evidence.grantScope } : {}),
      ...(evidence.verdict === 'deny' && evidence.reason ? { reason: cleanText(evidence.reason, 500) } : {}),
      resolved_by: evidence.resolvedBy ?? { origin: 'local' },
      resolved_at: normalizeTimestamp(evidence.resolvedAt),
    };
    approvals.push(materializeResource(context, resourceKey, draft, undefined, true));
  }
  return approvals;
};

export const projectDesktopSnapshots = (
  input: DesktopProjectionInput,
  persistedProjectionState: ProjectionState | null | undefined,
  now: string | Date,
): DesktopProjectionResult => {
  const observedAt = normalizeTimestamp(now);
  assertSourceId(input.instance.instanceId, true);
  assertSourceId(input.workspace.workspaceId, true);
  const previous = persistedProjectionState?.version === 1
    ? persistedProjectionState
    : { version: 1 as const, resources: {} };
  const context: ProjectionContext = {
    now: observedAt,
    previous,
    next: { version: 1, resources: { ...previous.resources } },
  };
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  if (projectsById.size !== input.projects.length || tasksById.size !== input.tasks.length) failProjection();

  const pendingApprovals = input.pendingToolApprovalByConversationId ?? {};
  const questionnaireDrafts = input.questionnaireDraftsByConversationId ?? {};
  const runningTaskIds = input.runningTaskIds instanceof Set
    ? new Set(input.runningTaskIds)
    : new Set(input.runningTaskIds ?? []);
  const supervision = resolveTaskQueueSupervision({
    tasks: input.tasks,
    conversations: input.conversations,
    messages: input.messages,
    messagesByConversationId: input.messagesByConversationId,
    questionnaireDraftsByConversationId: questionnaireDrafts,
    pendingToolApprovalByConversationId: pendingApprovals,
    runningTaskIds,
  });

  const instance = materializeResource(context, `instance:${input.instance.instanceId}`, {
    contract_version: CONTRACT_VERSION,
    type: 'instance',
    ref: { type: 'instance', instance_id: input.instance.instanceId },
    label: cleanText(input.instance.label, 120),
    connection_state: input.instance.connectionState,
    supported_contract_versions: [CONTRACT_VERSION],
  });
  const workspace = materializeResource(context, `workspace:${input.workspace.workspaceId}`, {
    contract_version: CONTRACT_VERSION,
    type: 'workspace',
    ref: {
      type: 'workspace',
      instance_id: input.instance.instanceId,
      workspace_id: input.workspace.workspaceId,
    },
    label: cleanText(input.workspace.label, 120),
  });
  const projects = input.projects.map((project) => {
    assertSourceId(project.id, true);
    return materializeResource(context, `project:${project.id}`, {
      contract_version: CONTRACT_VERSION,
      type: 'project',
      ref: {
        type: 'project',
        instance_id: input.instance.instanceId,
        workspace_id: input.workspace.workspaceId,
        project_id: project.id,
      },
      label: cleanText(project.name, 120),
      state: project.status,
      repository_state: mapRepositoryState(project.gitSetupState),
    });
  });
  const tasks = input.tasks.map((task) => {
    assertSourceId(task.id, true);
    const projectIds = unique(task.project_ids?.length ? task.project_ids : [task.project_id]);
    const contextProjectIds = unique(task.context_project_ids ?? []);
    if (contextProjectIds.some((id) => projectIds.includes(id))) failProjection();
    contextProjectIds.forEach((id) => assertSourceId(id, true));
    const attention = supervision.attentionByTaskId.get(task.id);
    const state = mapTaskState(task, attention?.kind);
    const missing = ['run_history'];
    if (state === 'waiting_reply' && !attention?.conversationId && !task.conversation_id) missing.push('reply_context');
    if (state === 'review_ready') missing.push('review');
    const conversationId = attention?.conversationId ?? task.conversation_id ?? undefined;
    if (conversationId) assertSourceId(conversationId);
    const prompt = conversationId
      ? messagesForConversation(input, conversationId).filter((message) => message.role === 'assistant').at(-1)?.content
      : undefined;
    return materializeResource(context, `task:${task.id}`, {
      contract_version: CONTRACT_VERSION,
      type: 'task',
      ref: {
        type: 'task',
        instance_id: input.instance.instanceId,
        workspace_id: input.workspace.workspaceId,
        task_id: task.id,
      },
      project_ids: projectIds,
      ...(contextProjectIds.length ? { context_project_ids: contextProjectIds } : {}),
      execution_targets: resolveExecutionTargets(task, projectsById),
      title: cleanText(task.title, 300),
      state,
      ...(state === 'waiting_reply' && conversationId ? {
        reply_context: {
          conversation_id: conversationId,
          ...(prompt?.trim() ? { prompt: cleanText(prompt, 4000) } : {}),
        },
      } : {}),
      projection: { missing },
      observed_at: context.now,
    });
  });

  return {
    snapshots: {
      instance,
      workspace,
      projects,
      tasks,
      runs: [],
      decisions: decisionResources(input, context, tasksById),
      toolApprovals: approvalResources(input, context, tasksById),
      reviews: [],
    },
    state: context.next,
  };
};
