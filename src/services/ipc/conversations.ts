/** conversations IPC wrappers and frontend adapters. */

import type {
  AppMode,
  ChatCompletionReason,
  ProviderTurnState,
  ToolTrace,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import type {
  DbArchitectPlanConversationSync,
  DbChatBootstrapSnapshot,
  DbChatSnapshot,
  DbConversation,
  DbConversationCitation,
  DbConversationCompactionState,
  DbConversationToolboxState,
  DbImportMessageInput,
  DbInsertConversationCompactionEventInput,
  DbMessage,
  DbUpsertArchitectPlanConversationSyncInput,
  DbUpsertConversationCitationInput,
  DbUpsertConversationCompactionStateInput,
  DbUpsertConversationToolboxStateInput,
  MessageSearchPage,
} from "./conversations.types";

export async function listConversations(): Promise<DbConversation[]> {
  return invoke<DbConversation[]>("db_list_conversations");
}

export async function getChatSnapshot(): Promise<DbChatSnapshot> {
  return invoke<DbChatSnapshot>("db_get_chat_snapshot");
}

export async function getChatBootstrapSnapshot(params?: {
  preloadConversationIds?: string[];
}): Promise<DbChatBootstrapSnapshot> {
  return invoke<DbChatBootstrapSnapshot>("db_get_chat_bootstrap_snapshot", {
    preloadConversationIds: params?.preloadConversationIds ?? [],
  });
}

export async function getConversation(
  id: string,
): Promise<DbConversation | null> {
  return invoke<DbConversation | null>("db_get_conversation", { id });
}

export async function createConversation(params?: {
  title?: string;
  scopeMode?: AppMode;
  taskId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
}): Promise<DbConversation> {
  return invoke<DbConversation>("db_create_conversation", {
    title: params?.title,
    scopeMode: params?.scopeMode ?? "Chat",
    taskId: params?.taskId ?? null,
    groupId: params?.groupId ?? null,
    projectId: params?.projectId ?? null,
    providerId: params?.providerId ?? null,
    modelId: params?.modelId ?? null,
    reasoningEffort: params?.reasoningEffort ?? null,
  });
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<void> {
  return invoke("db_rename_conversation", { id, title });
}

export async function updateConversationDetails(params: {
  id: string;
  title?: string;
  description?: string;
}): Promise<void> {
  return invoke("db_update_conversation_details", {
    id: params.id,
    title: params.title ?? null,
    description: params.description ?? null,
  });
}

export async function updateConversationScope(params: {
  id: string;
  scopeMode: AppMode;
  taskId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
}): Promise<void> {
  return invoke("db_update_conversation_scope", {
    id: params.id,
    scopeMode: params.scopeMode,
    taskId: params.taskId ?? null,
    groupId: params.groupId ?? null,
    projectId: params.projectId ?? null,
  });
}

export async function updateConversationAISelection(params: {
  id: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
}): Promise<void> {
  return invoke("db_update_conversation_ai_selection", {
    id: params.id,
    providerId: params.providerId ?? null,
    modelId: params.modelId ?? null,
    reasoningEffort: params.reasoningEffort ?? null,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  return invoke("db_delete_conversation_by_id", { id });
}

export async function deleteConversations(ids: string[]): Promise<void> {
  return invoke("db_delete_conversations_by_ids", { ids });
}

export async function togglePinConversation(id: string): Promise<boolean> {
  return invoke<boolean>("db_toggle_pin_conversation", { id });
}

export async function listMessages(
  conversationId: string,
): Promise<DbMessage[]> {
  return invoke<DbMessage[]>("db_list_messages", { conversationId });
}

export async function searchMessages(params: {
  query: string;
  conversationIds: string[];
  limit?: number;
  offset?: number;
}): Promise<MessageSearchPage> {
  return invoke<MessageSearchPage>("db_search_messages", {
    query: params.query,
    conversationIds: params.conversationIds,
    limit: params.limit ?? 25,
    offset: params.offset ?? 0,
  });
}

export async function dbGetArchitectPlanConversationSync(
  conversationId: string,
): Promise<DbArchitectPlanConversationSync | null> {
  return invoke<DbArchitectPlanConversationSync | null>(
    "db_get_architect_plan_conversation_sync",
    { conversationId },
  );
}

export async function dbGetArchitectPlanConversationSyncForPlan(params: {
  planId: string;
  targetBranch: string;
}): Promise<DbArchitectPlanConversationSync | null> {
  return invoke<DbArchitectPlanConversationSync | null>(
    "db_get_architect_plan_conversation_sync_for_plan",
    params,
  );
}

export async function dbUpsertArchitectPlanConversationSync(
  input: DbUpsertArchitectPlanConversationSyncInput,
): Promise<DbArchitectPlanConversationSync> {
  return invoke<DbArchitectPlanConversationSync>(
    "db_upsert_architect_plan_conversation_sync",
    { input },
  );
}

export async function dbDeleteArchitectPlanConversationSync(
  conversationId: string,
): Promise<void> {
  return invoke("db_delete_architect_plan_conversation_sync", {
    conversationId,
  });
}

export async function dbGetConversationCompactionState(
  conversationId: string,
): Promise<DbConversationCompactionState | null> {
  return invoke<DbConversationCompactionState | null>("db_get_conversation_compaction_state", {
    conversationId,
  });
}

export async function dbUpsertConversationCompactionState(
  input: DbUpsertConversationCompactionStateInput,
): Promise<DbConversationCompactionState> {
  return invoke<DbConversationCompactionState>("db_upsert_conversation_compaction_state", {
    input,
  });
}

export async function dbDeleteConversationCompactionState(
  conversationId: string,
): Promise<void> {
  return invoke("db_delete_conversation_compaction_state", {
    conversationId,
  });
}

export async function dbInsertConversationCompactionEvent(
  input: DbInsertConversationCompactionEventInput,
): Promise<void> {
  return invoke("db_insert_conversation_compaction_event", { input });
}

export async function listConversationCitations(
  conversationId: string,
): Promise<DbConversationCitation[]> {
  return invoke<DbConversationCitation[]>("db_list_conversation_citations", {
    conversationId,
  });
}

export async function getConversationCitationContent(
  id: string,
): Promise<string | null> {
  return invoke<string | null>("db_get_conversation_citation_content", { id });
}

export async function upsertConversationCitation(
  input: DbUpsertConversationCitationInput,
): Promise<DbConversationCitation> {
  return invoke<DbConversationCitation>("db_upsert_conversation_citation", {
    input,
  });
}

export async function deleteConversationCitation(id: string): Promise<void> {
  return invoke("db_delete_conversation_citation", { id });
}

export async function deleteConversationCitations(
  conversationId: string,
): Promise<void> {
  return invoke("db_delete_conversation_citations", { conversationId });
}

export async function getConversationToolboxState(
  conversationId: string,
): Promise<DbConversationToolboxState | null> {
  return invoke<DbConversationToolboxState | null>(
    "db_get_conversation_toolbox_state",
    { conversationId },
  );
}

export async function upsertConversationToolboxState(
  input: DbUpsertConversationToolboxStateInput,
): Promise<DbConversationToolboxState> {
  return invoke<DbConversationToolboxState>(
    "db_upsert_conversation_toolbox_state",
    { input },
  );
}

export async function deleteConversationToolboxState(
  conversationId: string,
): Promise<void> {
  return invoke("db_delete_conversation_toolbox_state", { conversationId });
}

export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  options?: {
    id?: string;
    turnId?: string | null;
    tokenCount?: number;
    toolTraces?: ToolTrace[];
    hiddenContext?: string;
    providerInputItems?: unknown[];
    providerTurnState?: ProviderTurnState;
    contextRefs?: unknown[];
    completionReason?: ChatCompletionReason;
  },
): Promise<DbMessage> {
  return invoke<DbMessage>("db_create_message", {
    params: {
      conversationId,
      id: options?.id ?? null,
      turnId: options?.turnId ?? null,
      role,
      content,
      tokenCount: options?.tokenCount ?? null,
      toolTracesJson: options?.toolTraces
        ? JSON.stringify(options.toolTraces)
        : null,
      hiddenContext: options?.hiddenContext ?? null,
      providerInputItemsJson: options?.providerInputItems
        ? JSON.stringify(options.providerInputItems)
        : null,
      providerTurnStateJson: options?.providerTurnState
        ? JSON.stringify(options.providerTurnState)
        : null,
      contextRefsJson: options?.contextRefs
        ? JSON.stringify(options.contextRefs)
        : null,
      ...(options?.completionReason
        ? { completionReason: options.completionReason }
        : {}),
    },
  });
}

export async function importMessages(
  conversationId: string,
  messages: DbImportMessageInput[],
): Promise<DbMessage[]> {
  return invoke<DbMessage[]>("db_import_messages", {
    conversationId,
    messages,
  });
}

export async function updateMessage(
  id: string,
  content: string,
  options?: {
    turnId?: string | null;
    tokenCount?: number;
    toolTraces?: ToolTrace[];
    hiddenContext?: string;
    providerInputItems?: unknown[];
    providerTurnState?: ProviderTurnState;
    contextRefs?: unknown[];
    completionReason?: ChatCompletionReason;
    generationAttempts?: import('../ai/contracts').GenerationAttempt[];
  },
): Promise<void> {
  return invoke("db_update_message", {
    params: {
      id,
      turnId: options?.turnId ?? null,
      content,
      tokenCount: options?.tokenCount ?? null,
      toolTracesJson: options?.toolTraces
        ? JSON.stringify(options.toolTraces)
        : null,
      hiddenContext: options?.hiddenContext ?? null,
      providerInputItemsJson: options?.providerInputItems
        ? JSON.stringify(options.providerInputItems)
        : null,
      providerTurnStateJson: options?.providerTurnState
        ? JSON.stringify(options.providerTurnState)
        : null,
      contextRefsJson: options?.contextRefs
        ? JSON.stringify(options.contextRefs)
        : null,
      ...(options?.completionReason
        ? { completionReason: options.completionReason }
        : {}),
      generationAttemptsJson: options?.generationAttempts
        ? JSON.stringify(options.generationAttempts)
        : null,
    },
  });
}

export async function deleteMessagesAfter(
  conversationId: string,
  afterMessageId: string,
): Promise<void> {
  return invoke("db_delete_messages_after", { conversationId, afterMessageId });
}

export async function deleteConversationTurn(
  conversationId: string,
  turnId: string,
): Promise<void> {
  return invoke("db_delete_conversation_turn", { conversationId, turnId });
}

export async function dbTrimConversationReplay(params: {
  conversationId: string;
  afterMessageId: string;
  codeCheckpointsJson?: string | null;
  deleteContextCompactionState: boolean;
}): Promise<void> {
  return invoke('db_trim_conversation_replay', params);
}

export async function dbPrepareConversationReplay(params: {
  conversationId: string;
  messageId: string;
  sessionId: string;
  turnId: string;
  replayId: string;
  content: string;
  hiddenContext?: string | null;
  providerInputItemsJson?: string | null;
  codeCheckpointsJson?: string | null;
  deleteContextCompactionState: boolean;
}): Promise<void> {
  return invoke('db_prepare_conversation_replay', { params });
}

export async function dbRestoreConversationReplay(params: {
  conversationId: string;
  replayId: string;
  sessionId: string;
  turnId: string;
}): Promise<boolean> {
  return invoke('db_restore_conversation_replay', params);
}

export async function dbCompleteConversationReplay(params: {
  conversationId: string;
  replayId: string;
}): Promise<void> {
  return invoke('db_complete_conversation_replay', params);
}

export async function dbMarkConversationReplayLaunched(params: {
  conversationId: string;
  replayId: string;
}): Promise<void> {
  return invoke('db_mark_conversation_replay_launched', params);
}

export async function dbFinalizeConversationReplay(params: {
  conversationId: string;
  replayId: string;
}): Promise<void> {
  return invoke('db_finalize_conversation_replay', params);
}
