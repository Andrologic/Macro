import type {
  ChatMessage,
  Conversation,
  PersistedContextReference,
  ReasoningEffort,
} from "../types";
import type { DbConversation, DbMessage } from "./tauriIpc";
import { parseMessageQuickReplies } from "./chatQuickReplies";
import {
  parseAssistantQuestionnaireState,
  parseUserQuestionnaireResponseState,
} from "./chatQuestionnaires";
import { parseToolTracesJson } from "./toolTraceState";

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const normalizeReasoningEffort = (
  value: unknown,
): ReasoningEffort | null =>
  typeof value === "string" &&
  REASONING_EFFORT_VALUES.has(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : null;

export const mapDbConversationToConversation = (
  conversation: DbConversation,
): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  description: conversation.description || "",
  scope_mode: conversation.scope_mode,
  task_id: conversation.task_id,
  group_id: conversation.group_id,
  project_id: conversation.project_id,
  provider_id: conversation.provider_id,
  model_id: conversation.model_id,
  reasoning_effort: normalizeReasoningEffort(conversation.reasoning_effort),
  last_message: conversation.last_message || "",
  message_count: conversation.message_count,
  updated_at: conversation.updated_at,
  is_unread: false,
});

export const parseDbProviderTurnState = (
  raw: string | null,
): ChatMessage["provider_turn_state"] | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as ChatMessage["provider_turn_state"] | null;
    if (
      !parsed ||
      parsed.provider !== "chatgpt" ||
      !Array.isArray(parsed.output_items)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

export const parseDbProviderInputItems = (
  raw: string | null,
): ChatMessage["provider_input_items"] | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const parseDbContextRefs = (
  raw: string | null | undefined,
): PersistedContextReference[] | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const refs = parsed.filter((item): item is PersistedContextReference => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<PersistedContextReference>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.kind === "string" &&
        typeof candidate.title === "string"
      );
    });
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
};

export const buildAssistantMessagePresentation = (
  content: string,
  hiddenContext?: string,
): Pick<
  ChatMessage,
  "content" | "choices" | "allow_free_response" | "questionnaire"
> => {
  const questionnaireState = parseAssistantQuestionnaireState(
    content,
    hiddenContext,
  );
  const legacyQuickReplies = parseMessageQuickReplies(content);

  return {
    content: questionnaireState.content,
    choices: legacyQuickReplies.choices,
    allow_free_response: legacyQuickReplies.allowFreeResponse,
    questionnaire: questionnaireState.questionnaire,
  };
};

export const assistantTurnRequiresUserReply = (
  content: string,
  hiddenContext?: string,
): boolean =>
  parseAssistantQuestionnaireState(content, hiddenContext).requiresUserReply;

export const buildUserMessagePresentation = (
  content: string,
  hiddenContext?: string,
): Pick<ChatMessage, "content" | "questionnaire_response_summary"> => {
  const questionnaireResponseState = parseUserQuestionnaireResponseState(
    content,
    hiddenContext,
  );

  return {
    content: questionnaireResponseState.content,
    questionnaire_response_summary:
      questionnaireResponseState.questionnaireResponseSummary,
  };
};

export const mapDbMessageToChatMessage = (
  message: DbMessage,
  conversationById: Map<string, Conversation>,
): ChatMessage => {
  const taskId = conversationById.get(message.conversation_id)?.task_id ?? "";
  if (message.role === "assistant") {
    const presentation = buildAssistantMessagePresentation(
      message.content,
      message.hidden_context ?? undefined,
    );
    return {
      id: message.id,
      turn_id: message.turn_id ?? null,
      task_id: taskId,
      conversation_id: message.conversation_id,
      role: message.role as "user" | "assistant",
      content: presentation.content,
      timestamp: message.created_at,
      choices: presentation.choices,
      allow_free_response: presentation.allow_free_response,
      questionnaire: presentation.questionnaire,
      tool_traces: parseToolTracesJson(message.tool_traces_json),
      hidden_context: message.hidden_context ?? undefined,
      provider_input_items: parseDbProviderInputItems(
        message.provider_input_items_json,
      ),
      provider_turn_state: parseDbProviderTurnState(
        message.provider_turn_state_json,
      ),
      context_refs: parseDbContextRefs(message.context_refs_json),
      completion_reason: message.completion_reason ?? undefined,
    };
  }

  const userPresentation = buildUserMessagePresentation(
    message.content,
    message.hidden_context ?? undefined,
  );
  return {
    id: message.id,
    turn_id: message.turn_id ?? null,
    task_id: taskId,
    conversation_id: message.conversation_id,
    role: message.role as "user" | "assistant",
    content: userPresentation.content,
    timestamp: message.created_at,
    questionnaire_response_summary:
      userPresentation.questionnaire_response_summary,
    tool_traces: parseToolTracesJson(message.tool_traces_json),
    hidden_context: message.hidden_context ?? undefined,
    provider_input_items: parseDbProviderInputItems(
      message.provider_input_items_json,
    ),
    provider_turn_state: parseDbProviderTurnState(
      message.provider_turn_state_json,
    ),
    context_refs: parseDbContextRefs(message.context_refs_json),
    completion_reason: message.completion_reason ?? undefined,
  };
};
