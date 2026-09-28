import type {
ArchitectPlanConversationSyncRecord as NativeDbArchitectPlanConversationSync,
ChatBootstrapSnapshot as NativeDbChatBootstrapSnapshot,
ChatSnapshot as NativeDbChatSnapshot,
Conversation as NativeDbConversation,
ConversationCitation as NativeDbConversationCitation,
ConversationCompactionStateRecord as NativeDbConversationCompactionState,
ConversationToolboxStateRecord as NativeDbConversationToolboxState,
ImportMessageInput as NativeDbImportMessageInput,
InsertConversationCompactionEventInput as NativeDbInsertConversationCompactionEventInput,
Message as NativeDbMessage,
UpsertArchitectPlanConversationSyncInput as NativeDbUpsertArchitectPlanConversationSyncInput,
UpsertConversationCitationInput as NativeDbUpsertConversationCitationInput,
UpsertConversationCompactionStateInput as NativeDbUpsertConversationCompactionStateInput,
UpsertConversationToolboxStateInput as NativeDbUpsertConversationToolboxStateInput,
MessageSearchPage as NativeMessageSearchPage,
MessageSearchResult as NativeMessageSearchResult
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** conversations IPC contracts and explicit frontend adaptations of generated native bindings. */

import type {
AppMode,
ChatCompletionReason,
} from "../../types";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbConversation = OmitFields<NativeDbConversation, "scope_mode"> & {
  scope_mode: AppMode;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbMessage = OptionalFields<OmitFields<NativeDbMessage, "completion_reason">, "turn_id" | "context_refs_json" | "generation_attempts_json"> & {
  completion_reason?: ChatCompletionReason | null;
};

export type DbConversationCitation = NativeDbConversationCitation;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbUpsertConversationCitationInput = OptionalFields<NativeDbUpsertConversationCitationInput,
  | "snippet"
  | "content"
  | "url"
  | "favicon"
  | "path"
  | "language"
  | "size_bytes"
  | "kind"
  | "reason"
  | "timestamp"
>;

export type DbConversationToolboxState = NativeDbConversationToolboxState;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbUpsertConversationToolboxStateInput = OptionalFields<NativeDbUpsertConversationToolboxStateInput, "timestamp">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbConversationCompactionState = OptionalFields<NativeDbConversationCompactionState,
  | "pruned_tool_context_message_ids_json"
  | "reserved_tokens"
  | "footprint_before_json"
  | "footprint_after_json"
  | "degraded_reason"
  | "compaction_kind"
  | "compaction_pass"
  | "summary_format_version"
  | "summary_source"
  | "policy_version"
  | "fingerprint_inputs_json"
  | "source_hashes_json"
  | "model_context_window_tokens"
  | "provider_id"
  | "model_id"
  | "checkpoint_health"
  | "last_trigger"
>;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbImportMessageInput = OptionalFields<OmitFields<NativeDbImportMessageInput, "completion_reason">, "turn_id"> & {
  completion_reason?: ChatCompletionReason | null;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbChatSnapshot = OmitFields<NativeDbChatSnapshot, "conversations" | "messages"> & {
  conversations: DbConversation[];
  messages: DbMessage[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbChatBootstrapSnapshot = OmitFields<NativeDbChatBootstrapSnapshot, "conversations" | "messages_by_conversation_id"> & {
  conversations: DbConversation[];
  messages_by_conversation_id: Record<string, DbMessage[] | undefined>;
};

export type DbArchitectPlanConversationSync = NativeDbArchitectPlanConversationSync;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbUpsertArchitectPlanConversationSyncInput = OptionalFields<NativeDbUpsertArchitectPlanConversationSyncInput, "transcript_revision">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbUpsertConversationCompactionStateInput = OptionalFields<NativeDbUpsertConversationCompactionStateInput,
  | "pruned_tool_context_message_ids_json"
  | "reserved_tokens"
  | "footprint_before_json"
  | "footprint_after_json"
  | "degraded_reason"
  | "compaction_kind"
  | "compaction_pass"
  | "summary_format_version"
  | "summary_source"
  | "policy_version"
  | "fingerprint_inputs_json"
  | "source_hashes_json"
  | "model_context_window_tokens"
  | "provider_id"
  | "model_id"
  | "checkpoint_health"
  | "last_trigger"
>;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbInsertConversationCompactionEventInput = OptionalFields<NativeDbInsertConversationCompactionEventInput,
  | "provider_id"
  | "model_id"
  | "model_context_window_tokens"
  | "tokens_before"
  | "tokens_after"
  | "error_code"
  | "reason"
  | "metadata_json"
>;

export type MessageSearchResult = NativeMessageSearchResult;

export type MessageSearchPage = NativeMessageSearchPage;
