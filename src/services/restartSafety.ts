import type {
  ConversationRuntimeState,
  Conversation,
  Task,
} from "../types";
import {
  isTransientCompactionStatus,
  type ConversationCompactionStatus,
} from "./contextCompactionSession";
import { isConversationRuntimeActive } from "../stores/chat/chatRuntimeState";

export type RestartSafetyActivityKind = "agent" | "implement";

export interface RestartSafetyActivity {
  id: string;
  kind: RestartSafetyActivityKind;
  phase: string;
  title: string | null;
}

export interface RestartSafetySnapshot {
  activeAgents: RestartSafetyActivity[];
  activeImplementations: RestartSafetyActivity[];
  activeAgentCount: number;
  activeImplementationCount: number;
  activeWorkCount: number;
  hasActiveWork: boolean;
}

export interface RestartSafetyTaskCommandRun {
  taskId: string;
  status: "running" | "cancelling";
}

export interface RestartSafetySelectorInput {
  conversations: ReadonlyArray<Pick<Conversation, "id" | "title">>;
  conversationRuntimeById: Readonly<
    Record<string, ConversationRuntimeState | undefined>
  >;
  conversationCompactionStatusById?: Readonly<
    Record<string, Pick<ConversationCompactionStatus, "phase"> | undefined>
  >;
  tasks?: ReadonlyArray<Pick<Task, "id" | "title">>;
  taskCommandRuns?: Readonly<
    Record<string, RestartSafetyTaskCommandRun | undefined>
  >;
}

const hasUsableId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeTitle = (title: string | undefined, id: string): string | null => {
  const normalized = title?.trim();
  return normalized ? normalized : id || null;
};

const getConversationTitle = (
  conversations: RestartSafetySelectorInput["conversations"],
  conversationId: string,
): string | null => {
  const conversation = conversations.find(
    (candidate) => candidate.id === conversationId,
  );
  return normalizeTitle(conversation?.title, conversationId);
};

const getTaskTitle = (
  tasks: NonNullable<RestartSafetySelectorInput["tasks"]>,
  taskId: string,
): string | null => {
  const task = tasks.find((candidate) => candidate.id === taskId);
  return normalizeTitle(task?.title, taskId);
};

const collectActiveAgentActivities = (
  input: RestartSafetySelectorInput,
): RestartSafetyActivity[] => {
  const activitiesByConversationId = new Map<string, RestartSafetyActivity>();

  for (const [conversationId, runtime] of Object.entries(
    input.conversationRuntimeById,
  )) {
    if (!hasUsableId(conversationId) || !isConversationRuntimeActive(runtime)) {
      continue;
    }

    activitiesByConversationId.set(conversationId, {
      id: conversationId,
      kind: "agent",
      phase: runtime?.phase ?? "unknown",
      title: getConversationTitle(input.conversations, conversationId),
    });
  }

  for (const [conversationId, status] of Object.entries(
    input.conversationCompactionStatusById ?? {},
  )) {
    if (
      !hasUsableId(conversationId) ||
      !status ||
      !isTransientCompactionStatus(status)
    ) {
      continue;
    }

    if (!activitiesByConversationId.has(conversationId)) {
      activitiesByConversationId.set(conversationId, {
        id: conversationId,
        kind: "agent",
        phase: status.phase,
        title: getConversationTitle(input.conversations, conversationId),
      });
    }
  }

  return Array.from(activitiesByConversationId.values());
};

const collectActiveImplementations = (
  input: RestartSafetySelectorInput,
): RestartSafetyActivity[] => {
  const activitiesByTaskId = new Map<string, RestartSafetyActivity>();

  for (const [recordId, run] of Object.entries(input.taskCommandRuns ?? {})) {
    const taskId = hasUsableId(run?.taskId)
      ? run.taskId
      : hasUsableId(recordId)
        ? recordId
        : null;
    if (!taskId || !run || (run.status !== "running" && run.status !== "cancelling")) {
      continue;
    }

    activitiesByTaskId.set(taskId, {
      id: taskId,
      kind: "implement",
      phase: run.status,
      title: getTaskTitle(input.tasks ?? [], taskId),
    });
  }

  return Array.from(activitiesByTaskId.values());
};

/**
 * Returns the serializable work snapshot used to guard an application restart.
 * Only transient agent runtimes, compaction work, and active Implement command
 * runs block the restart. Durable task statuses alone do not.
 */
export const selectRestartSafetySnapshot = (
  input: RestartSafetySelectorInput,
): RestartSafetySnapshot => {
  const activeAgents = collectActiveAgentActivities(input);
  const activeImplementations = collectActiveImplementations(input);

  return {
    activeAgents,
    activeImplementations,
    activeAgentCount: activeAgents.length,
    activeImplementationCount: activeImplementations.length,
    activeWorkCount: activeAgents.length + activeImplementations.length,
    hasActiveWork: activeAgents.length > 0 || activeImplementations.length > 0,
  };
};
