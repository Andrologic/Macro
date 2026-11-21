import type { Conversation, TaskStatus } from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import {
  detectNewConversationAttentionEvents,
  type ConversationAttentionContext,
  type ConversationAttentionEvent,
  type ConversationAttentionState,
} from './conversationAttention';
import {
  resolveTaskReference,
  taskReferenceMatches,
} from './durableIdentity';

export {
  getActiveChatAttentionKeys,
  hasChatAttentionStateChanged,
  type ConversationAttentionState as WorkflowChatAttentionState,
} from './conversationAttention';

export interface WorkflowAttentionContext extends ConversationAttentionContext {
  selectedTaskId: string | null;
  tasks: CatalogedImplementTask[];
  taskCatalogLoadId?: string | null;
}

export type WorkflowAttentionEvent = ConversationAttentionEvent
  | {
      kind: 'review';
      key: string;
      taskId: string;
      taskTitle: string;
      conversationId: string | null;
      catalogScope: {
        selectedGroupId: string | null;
        selectedProjectId: string | null;
      };
      catalogLoadId: string | null;
    };

export const hasReviewAttentionStateChanged = (
  previous: CatalogedImplementTask[],
  next: CatalogedImplementTask[],
): boolean => {
  if (previous === next) return false;
  if (previous.length !== next.length) return true;

  return previous.some((task, index) => {
    const candidate = next[index];
    return !candidate ||
      task.id !== candidate.id ||
      task.node_id !== candidate.node_id ||
      task.status !== candidate.status ||
      task.title !== candidate.title ||
      task.conversation_id !== candidate.conversation_id;
  });
};

const isImplementConversationInScope = (
  context: WorkflowAttentionContext,
  conversation: Conversation,
): boolean => {
  if (!context.selectedTaskId) {
    return !conversation.task_id;
  }

  const selectedTask = resolveTaskReference(context.tasks, context.selectedTaskId);
  return Boolean(
    selectedTask &&
    taskReferenceMatches(context.tasks, selectedTask, conversation.task_id),
  );
};

export const detectNewChatAttentionEvents = (
  previousState: ConversationAttentionState,
  nextState: ConversationAttentionState,
  context: WorkflowAttentionContext,
): WorkflowAttentionEvent[] =>
  detectNewConversationAttentionEvents(previousState, nextState, context, (conversation) =>
    conversation.scope_mode === 'Implement' && isImplementConversationInScope(context, conversation),
  );

const indexTaskStatuses = (
  tasks: Array<Pick<CatalogedImplementTask, 'id' | 'status'>>,
): Map<string, TaskStatus> =>
  new Map(tasks.map((task) => [task.id, task.status]));

export const detectNewReviewAttentionEvents = (
  previousTasks: CatalogedImplementTask[],
  nextTasks: CatalogedImplementTask[],
  context: WorkflowAttentionContext,
  conversations: Conversation[],
): WorkflowAttentionEvent[] => {
  const previousStatuses = indexTaskStatuses(previousTasks);

  const selectedTask = context.selectedTaskId
    ? resolveTaskReference(nextTasks, context.selectedTaskId)
    : undefined;

  return nextTasks.flatMap<WorkflowAttentionEvent>((task) => {
    if (
      task.status !== 'InReview' ||
      previousStatuses.get(task.id) === undefined ||
      previousStatuses.get(task.id) === 'InReview' ||
      (context.appForeground && context.mode === 'Implement' && selectedTask?.id === task.id)
    ) {
      return [];
    }

    const conversationId =
      task.conversation_id ??
      conversations.find(
        (conversation) =>
          conversation.scope_mode === 'Implement' &&
          taskReferenceMatches(nextTasks, task, conversation.task_id),
      )?.id ??
      null;

    return [
      {
        kind: 'review',
        key: `workflow-attention:review:${task.id}`,
        taskId: task.id,
        taskTitle: task.title,
        conversationId,
        catalogScope: {
          selectedGroupId: context.selectedGroupId,
          selectedProjectId: context.selectedProjectId,
        },
        catalogLoadId: context.taskCatalogLoadId ?? null,
      },
    ];
  });
};
