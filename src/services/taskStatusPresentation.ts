import type {
  ConversationRuntimeState,
  PlanNodeStatus,
  TaskStatus,
} from '../types';
import { isPlanFinalizationTaskSource } from './planFinalization';

export type TaskStatusIndicatorState =
  | 'idle_prompt'
  | 'awaiting_response'
  | 'running'
  | 'plan_finalization'
  | 'in_review'
  | 'completed'
  | 'failed'
  | 'blocked';

interface ResolveRunningTaskIdsParams {
  conversations: Array<{
    id: string;
    task_id?: string | null;
  }>;
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
}

export const resolveRunningConversationIds = (
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>
): Set<string> =>
  new Set(
    Object.entries(conversationRuntimeById)
      .filter(([, runtime]) => runtime?.phase === 'streaming')
      .map(([conversationId]) => conversationId)
  );

export const resolveRunningTaskIds = ({
  conversations,
  conversationRuntimeById,
}: ResolveRunningTaskIdsParams): Set<string> => {
  const runningConversationIds = resolveRunningConversationIds(conversationRuntimeById);

  return new Set(
    conversations
      .filter((conversation) => runningConversationIds.has(conversation.id))
      .map((conversation) => conversation.task_id)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
  );
};

export const resolveTaskStatusIndicatorState = (
  status: TaskStatus,
  isAssistantRunning: boolean,
  taskSource?: string | null
): TaskStatusIndicatorState => {
  const isPlanFinalizationTask = isPlanFinalizationTaskSource(taskSource);

  if (isAssistantRunning) {
    return 'running';
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
