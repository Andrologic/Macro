import { useMemo } from "react";
import { useTaskStore } from "../../stores/useTaskStore";
import { useChatStore } from "../../stores/useChatStore";
import type { AgsdlTarget } from "../../stores/useAgsdlStore";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { resolveRunningTaskIds } from "../../services/taskStatusPresentation";
import { trackCardTasks } from "../../services/agsdl/taskTracking";

export function useTrackedTasks(cards: ViewerCard[], target: AgsdlTarget) {
  const tasks = useTaskStore(state => state.tasks);
  const merges = useTaskStore(state => state.mergeWorkflowRuntimeByTaskId);
  const conversations = useChatStore(state => state.conversations);
  const projectId = useChatStore(state => state.conversations.find(item => item.id === state.selectedConversationId)?.project_id ?? undefined);
  const runtime = useChatStore(state => state.conversationRuntimeById);
  const compaction = useChatStore(state => state.conversationCompactionStatusById);
  return useMemo(() => trackCardTasks(cards, { ...target, projectId }, tasks, resolveRunningTaskIds({
    tasks, conversations, conversationRuntimeById: runtime, conversationCompactionStatusById: compaction,
  }), merges), [cards, target, projectId, tasks, merges, conversations, runtime, compaction]);
}
