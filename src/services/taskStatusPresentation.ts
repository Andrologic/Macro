import type { PlanNodeStatus, TaskStatus } from '../types';

export type TaskStatusIndicatorState =
  | 'idle_prompt'
  | 'awaiting_response'
  | 'running'
  | 'in_review'
  | 'completed'
  | 'failed'
  | 'blocked';

interface ResolveStreamingTaskIdParams {
  conversations: Array<{
    id: string;
    task_id?: string | null;
  }>;
  isStreaming: boolean;
  selectedConversationId: string | null | undefined;
}

export const resolveStreamingTaskId = ({
  conversations,
  isStreaming,
  selectedConversationId,
}: ResolveStreamingTaskIdParams): string | null => {
  if (!isStreaming || !selectedConversationId) {
    return null;
  }

  return (
    conversations.find((conversation) => conversation.id === selectedConversationId)?.task_id ??
    null
  );
};

export const resolveTaskStatusIndicatorState = (
  status: TaskStatus,
  isAssistantRunning: boolean
): TaskStatusIndicatorState => {
  if (isAssistantRunning) {
    return 'running';
  }

  switch (status) {
    case 'AwaitingResponse':
      return 'awaiting_response';
    case 'Pending':
    case 'InProgress':
      return 'idle_prompt';
    case 'InReview':
      return 'in_review';
    case 'Completed':
      return 'completed';
    case 'Failed':
      return 'failed';
    case 'Blocked':
      return 'blocked';
    default:
      return 'idle_prompt';
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
