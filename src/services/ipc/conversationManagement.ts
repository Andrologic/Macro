import { invoke } from '../tauriRuntimeBridge';
import type { DbMessage } from './conversations.types';
import type { ConversationMetadata, ConversationActionInput, ConversationActionResult } from '../../types/generated/ipc';
export type { ConversationMetadata, ConversationActionInput, ConversationActionResult };
export const conversationMetadata = () => invoke<ConversationMetadata[]>('db_conversation_metadata');
export const conversationResponseVersion = (messageId: string, content: string) => invoke<number>('db_conversation_response_version', { messageId, content });
export const conversationAcknowledge = (conversationId: string, observed: number) => invoke<void>('db_conversation_acknowledge', { conversationId, observed });
export const conversationAction = (input: ConversationActionInput) => invoke<ConversationActionResult>('db_conversation_action', { input });
export const conversationImportArchives = (ids: string[]) => invoke<void>('db_conversation_import_archives', { ids });
export const getMessage = (messageId: string) => invoke<DbMessage | null>('db_get_message', { messageId });

export const conversationSetArchives = (ids: readonly string[], archived: boolean) => invoke<void>('db_conversation_set_archives', { ids, archived });
