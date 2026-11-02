import { invoke } from '../tauriRuntimeBridge';
import type { DbMessage } from './conversations.types';
import type { ConversationMetadata, ConversationActionInput, ConversationActionResult } from '../../types/generated/ipc';
export type { ConversationMetadata, ConversationActionInput, ConversationActionResult };
export const conversationMetadata = () => invoke<ConversationMetadata[]>('db_conversation_metadata');
export const conversationResponseVersion = (messageId: string, content: string, completionReason?: string | null) => invoke<number>('db_conversation_response_version', { messageId, content, completionReason: completionReason ?? null });
export const conversationAcknowledge = (conversationId: string, observed: number[], executeBefore?: string) => invoke<void>('db_conversation_acknowledge', { conversationId, observed, executeBefore: executeBefore ?? null });
export const conversationAction = (input: ConversationActionInput) => invoke<ConversationActionResult>('db_conversation_action', { input });
export const conversationImportArchives = (ids: string[]) => invoke<void>('db_conversation_import_archives', { ids });
export const getMessage = (messageId: string) => invoke<DbMessage | null>('db_get_message', { messageId });
export const listMessagesBounded = (conversationId: string) => invoke<DbMessage[]>('db_list_messages_bounded', { conversationId });

export const conversationSetArchives = (ids: readonly string[], archived: boolean) => invoke<void>('db_conversation_set_archives', { ids, archived });

export type { PilotReflectionMessage, PilotReflectionMessageRead, PilotReflectionToolAnchor } from '../../types/generated/ipc';
import type { PilotReflectionMessageRead } from '../../types/generated/ipc';

/** Native reader preserves raw content; questionnaire presentation happens in projection. */
export const getPilotReflectionMessage = (conversationId: string, messageId: string) =>
  invoke<PilotReflectionMessageRead>('db_get_pilot_reflection_message', { conversationId, messageId });
