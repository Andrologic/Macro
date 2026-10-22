import { invoke } from '../tauriRuntimeBridge';
import type { ConversationContentToken, ConversationContentMetadataInput, ConversationContentMetadataPage, ConversationContentWindowInput, ConversationContentWindow } from '../../types/generated/ipc';
export type { ConversationContentToken, ConversationContentDescriptor, ConversationContentItem, ConversationContentMetadataInput, ConversationContentMetadataPage, ConversationContentWindowInput, ConversationContentWindow } from '../../types/generated/ipc';
export const conversationContentVersion = (conversationId: string) => invoke<ConversationContentToken>('db_conversation_content_version', { conversationId });
export const conversationContentMetadata = (input: ConversationContentMetadataInput) => invoke<ConversationContentMetadataPage>('db_conversation_content_metadata', { input });
export const conversationContentWindow = (input: ConversationContentWindowInput) => invoke<ConversationContentWindow>('db_conversation_content_window', { input });
