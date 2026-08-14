import type {
  ConversationRuntimeState,
  PlanNodeStatus,
  TaskStatus,
} from '../types';
import { isPlanFinalizationTaskSource } from './planFinalization';
import {
  resolveMergeWorkflowIndicatorState,
  type MergeWorkflowIndicatorSource,
} from './mergeWorkflow';
import { resolveTaskReference } from './durableIdentity';

export type TaskStatusIndicatorState =
  | 'idle_prompt'
  | 'awaiting_response'
  | 'running'
  | 'plan_finalization'
  | 'merging'
  | 'merge_partial'
  | 'merge_blocked'
  | 'merge_failed'
  | 'in_review'
  | 'completed'
  | 'failed'
  | 'blocked';

type ConversationCompactionActivityStatus = {
  phase?: string | null;
};

interface ResolveActiveTaskIdsParams {
  conversations: Array<{
    id: string;
    task_id?: string | null;
    scope_mode?: string | null;
  }>;
  tasks?: Array<{
    id: string;
    node_id?: string | null;
    conversation_id?: string | null;
  }>;
  selectedConversationId?: string | null;
  selectedTaskId?: string | null;
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  conversationCompactionStatusById?: Record<
    string,
    ConversationCompactionActivityStatus | undefined
  >;
}

const ACTIVE_COMPACTION_PHASES = new Set([
  'compacting',
  'safety_compacting',
  'model_switch_compacting',
  'recovering_overflow',
]);

const hasUsableId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isActiveConversationRuntime = (
  runtime: ConversationRuntimeState | undefined
): boolean => runtime?.phase === 'preparing' || runtime?.phase === 'streaming';

const isActiveCompactionStatus = (
  status: ConversationCompactionActivityStatus | undefined
): boolean => Boolean(status?.phase && ACTIVE_COMPACTION_PHASES.has(status.phase));

const isImplementScopedConversation = (scopeMode: string | null | undefined): boolean =>
  scopeMode === undefined || scopeMode === 'Implement';

export const resolveActiveConversationIds = (
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>,
  conversationCompactionStatusById: Record<
    string,
    ConversationCompactionActivityStatus | undefined
  > = {}
): Set<string> => {
  const activeConversationIds = new Set(
    Object.entries(conversationRuntimeById)
      .filter(([, runtime]) => isActiveConversationRuntime(runtime))
      .map(([conversationId]) => conversationId)
  );

  for (const [conversationId, status] of Object.entries(
    conversationCompactionStatusById
  )) {
    if (isActiveCompactionStatus(status)) {
      activeConversationIds.add(conversationId);
    }
  }

  return activeConversationIds;
};

export const resolveRunningConversationIds = resolveActiveConversationIds;

const collectTaskIdsFromActiveConversations = (
  conversations: ResolveActiveTaskIdsParams['conversations'],
  activeConversationIds: Set<string>,
  tasks: NonNullable<ResolveActiveTaskIdsParams['tasks']>,
): Set<string> => new Set(conversations
  .filter((conversation) => activeConversationIds.has(conversation.id) && hasUsableId(conversation.task_id))
  .flatMap((conversation) => {
    if (tasks.length === 0) return [conversation.task_id!];
    const task = resolveTaskReference(tasks, conversation.task_id!);
    return task ? [task.id] : [];
  }));

const addTaskIdsFromTaskConversationLinks = (
  activeTaskIds: Set<string>,
  tasks: NonNullable<ResolveActiveTaskIdsParams['tasks']>,
  activeConversationIds: Set<string>
) => {
  for (const task of tasks) {
    if (task.conversation_id && activeConversationIds.has(task.conversation_id)) {
      activeTaskIds.add(task.id);
    }
  }
};

const canUseSelectedTaskFallback = (
  params: Pick<
    ResolveActiveTaskIdsParams,
    'conversations' | 'tasks' | 'selectedConversationId' | 'selectedTaskId'
  >,
  activeConversationIds: Set<string>
): boolean => {
  if (!params.selectedConversationId || !params.selectedTaskId) {
    return false;
  }

  const selectedConversation = params.conversations.find(
    (conversation) => conversation.id === params.selectedConversationId
  );
  const selectedTask = params.tasks
    ? resolveTaskReference(params.tasks, params.selectedTaskId)
    : undefined;

  if (!selectedConversation || !selectedTask) {
    return false;
  }

  const conversationHasNoConflictingTask =
    !selectedConversation.task_id ||
    resolveTaskReference(params.tasks || [], selectedConversation.task_id)?.id === selectedTask.id;
  const taskHasNoConflictingConversation =
    !selectedTask.conversation_id ||
    selectedTask.conversation_id === selectedConversation.id;

  return (
    isImplementScopedConversation(selectedConversation.scope_mode) &&
    conversationHasNoConflictingTask &&
    taskHasNoConflictingConversation &&
    activeConversationIds.has(selectedConversation.id)
  );
};

export const resolveActiveTaskIds = ({
  conversations,
  tasks = [],
  selectedConversationId,
  selectedTaskId,
  conversationRuntimeById,
  conversationCompactionStatusById,
}: ResolveActiveTaskIdsParams): Set<string> => {
  const activeConversationIds = resolveActiveConversationIds(
    conversationRuntimeById,
    conversationCompactionStatusById
  );

  const activeTaskIds = collectTaskIdsFromActiveConversations(
    conversations,
    activeConversationIds,
    tasks,
  );

  addTaskIdsFromTaskConversationLinks(activeTaskIds, tasks, activeConversationIds);

  // Standalone tasks can be linked to their conversation after the UI already
  // knows the selected pair. Use that pair only when it has no conflicting links.
  if (
    selectedTaskId &&
    canUseSelectedTaskFallback(
      { conversations, tasks, selectedConversationId, selectedTaskId },
      activeConversationIds
    )
  ) {
    activeTaskIds.add(selectedTaskId);
  }

  return activeTaskIds;
};

export const resolveRunningTaskIds = resolveActiveTaskIds;

export const resolveTaskStatusIndicatorState = (
  status: TaskStatus,
  isAssistantRunning: boolean,
  taskSource?: string | null,
  mergeWorkflowRuntime?: MergeWorkflowIndicatorSource | null
): TaskStatusIndicatorState => {
  const isPlanFinalizationTask = isPlanFinalizationTaskSource(taskSource);

  if (isAssistantRunning) {
    return 'running';
  }

  const mergeWorkflowIndicatorState = resolveMergeWorkflowIndicatorState(
    mergeWorkflowRuntime
  );
  if (mergeWorkflowIndicatorState) {
    return mergeWorkflowIndicatorState;
  }

  switch (status) {
    case 'AwaitingResponse':
      return 'awaiting_response';
    case 'Pending':
    case 'InProgress':
      return isPlanFinalizationTask ? 'plan_finalization' : 'idle_prompt';
    case 'InReview':
      return 'in_review';
    case 'Completed':
      return 'completed';
    case 'Failed':
      return 'failed';
    case 'Blocked':
      return 'blocked';
    default:
      return isPlanFinalizationTask ? 'plan_finalization' : 'idle_prompt';
  }
};

export const mapPlanNodeStatusToTaskStatus = (
  status: PlanNodeStatus
): TaskStatus => {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'blocked':
      return 'Blocked';
    case 'in-progress':
      return 'InProgress';
    case 'pending':
    default:
      return 'Pending';
  }
};

interface ResolvePlanNodeStatusIndicatorStateParams {
  nodeStatus: PlanNodeStatus;
  taskStatus?: TaskStatus | null;
  isAssistantRunning: boolean;
}

export const resolvePlanNodeStatusIndicatorState = ({
  nodeStatus,
  taskStatus,
  isAssistantRunning,
}: ResolvePlanNodeStatusIndicatorStateParams): TaskStatusIndicatorState =>
  resolveTaskStatusIndicatorState(
    taskStatus ?? mapPlanNodeStatusToTaskStatus(nodeStatus),
    isAssistantRunning
  );
