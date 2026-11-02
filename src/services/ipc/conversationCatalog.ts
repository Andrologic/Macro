import { invoke } from '../tauriRuntimeBridge';
import type { ConversationCatalogVersionInput, ConversationCatalogToken, ConversationCatalogPageInput, ConversationCatalogPage } from '../../types/generated/ipc';
export type { ConversationCatalogVersionInput, ConversationCatalogToken, ConversationCatalogAnchor, ConversationCatalogPageInput, ConversationCatalogPage } from '../../types/generated/ipc';
export const conversationCatalogVersion = (input: ConversationCatalogVersionInput) => invoke<ConversationCatalogToken>('db_conversation_catalog_version', { input });
export const conversationCatalogPage = (input: ConversationCatalogPageInput) => invoke<ConversationCatalogPage>('db_conversation_catalog_page', { input });
