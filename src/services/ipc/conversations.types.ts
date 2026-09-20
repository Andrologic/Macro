/** conversations IPC DTOs. Kept separate for generated Rust binding integration. */

import type {
  AppMode,
  ChatCompletionReason,
} from "../../types";

export interface DbConversation {
  id: string;
  title: string;
  description: string | null;
  scope_mode: AppMode;
  task_id: string | null;
  group_id: string | null;
  project_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  message_count: number;
  is_pinned: boolean;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  turn_id?: string | null;
  role: string;
  content: string;
  created_at: string;
  token_count: number | null;
  tool_traces_json: string | null;
  hidden_context: string | null;
  provider_input_items_json: string | null;
  provider_turn_state_json: string | null;
  context_refs_json?: string | null;
  completion_reason?: ChatCompletionReason | null;
}

export interface DbConversationCitation {
  id: string;
  conversation_id: string;
  message_id: string;
  type: string;
  scope: string;
  source: string;
  title: string;
  snippet: string | null;
  content: string | null;
  url: string | null;
  favicon: string | null;
  path: string | null;
  language: string | null;
  size_bytes: number | null;
  kind: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbUpsertConversationCitationInput {
  id: string;
  conversation_id: string;
  message_id: string;
  type: string;
  scope: string;
  source: string;
  title: string;
  snippet?: string | null;
  content?: string | null;
  url?: string | null;
  favicon?: string | null;
  path?: string | null;
  language?: string | null;
  size_bytes?: number | null;
  kind?: string | null;
  reason?: string | null;
  timestamp?: string | null;
}

export interface DbConversationToolboxState {
  conversation_id: string;
  composer_context_refs_json: string;
  created_at: string;
  updated_at: string;
}

export interface DbUpsertConversationToolboxStateInput {
  conversation_id: string;
  composer_context_refs_json: string;
  timestamp?: string | null;
}

export interface DbConversationCompactionState {
  conversation_id: string;
  up_to_message_id: string;
  summary_text: string;
  tool_digest_json: string;
  used_source_passage_ids_json: string;
  interesting_source_passage_ids_json: string;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  fingerprint: string;
  version: number;
  pruned_tool_context_message_ids_json?: string | null;
  reserved_tokens?: number | null;
  footprint_before_json?: string | null;
  footprint_after_json?: string | null;
  degraded_reason?: string | null;
  compaction_kind?: string | null;
  compaction_pass?: string | null;
  summary_format_version?: number | null;
  summary_source?: string | null;
  policy_version?: number | null;
  fingerprint_inputs_json?: string | null;
  source_hashes_json?: string | null;
  model_context_window_tokens?: number | null;
  provider_id?: string | null;
  model_id?: string | null;
  checkpoint_health?: string | null;
  last_trigger?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbImportMessageInput {
  id: string;
  turn_id?: string | null;
  role: string;
  content: string;
  created_at: string;
  completion_reason?: ChatCompletionReason | null;
}

export interface DbChatSnapshot {
  conversations: DbConversation[];
  messages: DbMessage[];
}

export interface DbChatBootstrapSnapshot {
  conversations: DbConversation[];
  messages_by_conversation_id: Record<string, DbMessage[] | undefined>;
}

export interface DbArchitectPlanConversationSync {
  conversation_id: string;
  plan_id: string;
  target_branch: string;
  transcript_revision: string | null;
  message_count: number;
  updated_at: string;
}

export interface DbUpsertArchitectPlanConversationSyncInput {
  conversation_id: string;
  plan_id: string;
  target_branch: string;
  transcript_revision?: string | null;
  message_count: number;
}

export interface DbUpsertConversationCompactionStateInput {
  conversation_id: string;
  up_to_message_id: string;
  summary_text: string;
  tool_digest_json: string;
  used_source_passage_ids_json: string;
  interesting_source_passage_ids_json: string;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  fingerprint: string;
  version: number;
  pruned_tool_context_message_ids_json?: string | null;
  reserved_tokens?: number | null;
  footprint_before_json?: string | null;
  footprint_after_json?: string | null;
  degraded_reason?: string | null;
  compaction_kind?: string | null;
  compaction_pass?: string | null;
  summary_format_version?: number | null;
  summary_source?: string | null;
  policy_version?: number | null;
  fingerprint_inputs_json?: string | null;
  source_hashes_json?: string | null;
  model_context_window_tokens?: number | null;
  provider_id?: string | null;
  model_id?: string | null;
  checkpoint_health?: string | null;
  last_trigger?: string | null;
}

export interface DbInsertConversationCompactionEventInput {
  conversation_id: string;
  trigger: string;
  provider_id?: string | null;
  model_id?: string | null;
  model_context_window_tokens?: number | null;
  tokens_before?: number | null;
  tokens_after?: number | null;
  status: string;
  error_code?: string | null;
  reason?: string | null;
  metadata_json?: string | null;
}

export interface MessageSearchResult {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  conversationDescription: string | null;
  role: string;
  snippet: string;
  createdAt: string;
}

export interface MessageSearchPage {
  results: MessageSearchResult[];
  nextOffset: number | null;
}
