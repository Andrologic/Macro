/**
 * Tauri IPC Bridge
 * Type-safe wrapper around Tauri's invoke function
 */

import { invoke } from '@tauri-apps/api/core';

// ============ Types ============

export interface DbConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  message_count: number;
  is_pinned: boolean;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  token_count: number | null;
}

export interface DbProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string | null;
  is_enabled: boolean;
  is_local: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbAiModel {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  description: string | null;
  owned_by: string | null;
  pricing_prompt: string | null;
  pricing_completion: string | null;
  pricing_request: string | null;
  is_enabled: boolean;
  is_manual: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DbProviderSettings {
  provider_id: string;
  filter_free_models: boolean;
}

export interface DbProviderModelInput {
  model_id: string;
  name: string;
  description?: string | null;
  owned_by?: string | null;
  pricing_prompt?: string | null;
  pricing_completion?: string | null;
  pricing_request?: string | null;
}

// ============ Conversations ============

export async function listConversations(): Promise<DbConversation[]> {
  return invoke<DbConversation[]>('db_list_conversations');
}

export async function getConversation(id: string): Promise<DbConversation | null> {
  return invoke<DbConversation | null>('db_get_conversation', { id });
}

export async function createConversation(title?: string): Promise<DbConversation> {
  return invoke<DbConversation>('db_create_conversation', { title });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  return invoke('db_rename_conversation', { id, title });
}

export async function deleteConversation(id: string): Promise<void> {
  return invoke('db_delete_conversation_by_id', { id });
}

export async function togglePinConversation(id: string): Promise<boolean> {
  return invoke<boolean>('db_toggle_pin_conversation', { id });
}

// ============ Messages ============

export async function listMessages(conversationId: string): Promise<DbMessage[]> {
  return invoke<DbMessage[]>('db_list_messages', { conversationId });
}

export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  tokenCount?: number
): Promise<DbMessage> {
  return invoke<DbMessage>('db_create_message', {
    conversationId,
    role,
    content,
    tokenCount: tokenCount ?? null,
  });
}

export async function updateMessage(
  id: string,
  content: string,
  tokenCount?: number
): Promise<void> {
  return invoke('db_update_message', {
    id,
    content,
    tokenCount: tokenCount ?? null,
  });
}

export async function deleteMessagesAfter(
  conversationId: string,
  afterMessageId: string
): Promise<void> {
  return invoke('db_delete_messages_after', { conversationId, afterMessageId });
}

// ============ Provider Configs ============

export async function listProviderConfigs(): Promise<DbProviderConfig[]> {
  return invoke<DbProviderConfig[]>('db_list_provider_configs');
}

export async function getProviderConfig(id: string): Promise<DbProviderConfig | null> {
  return invoke<DbProviderConfig | null>('db_get_provider_config', { id });
}

export async function updateProviderConfig(params: {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isEnabled?: boolean;
}): Promise<void> {
  return invoke('db_update_provider_config', {
    id: params.id,
    name: params.name ?? null,
    baseUrl: params.baseUrl ?? null,
    apiKey: params.apiKey ?? null,
    isEnabled: params.isEnabled ?? null,
  });
}

export async function createProviderConfig(params: {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
}): Promise<DbProviderConfig> {
  return invoke<DbProviderConfig>('db_create_provider_config', {
    name: params.name,
    providerType: params.providerType,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal,
  });
}

export async function deleteProviderConfig(id: string): Promise<void> {
  return invoke('db_delete_provider_config', { id });
}

// ============ Provider Models ============

export async function listProviderModels(providerId: string): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_list_provider_models', { providerId });
}

export async function upsertProviderModels(params: {
  providerId: string;
  models: DbProviderModelInput[];
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_upsert_provider_models', {
    providerId: params.providerId,
    models: params.models,
  });
}

export async function registerManualModel(params: {
  providerId: string;
  modelId: string;
  name: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_register_manual_model', {
    providerId: params.providerId,
    modelId: params.modelId,
    name: params.name,
  });
}

export async function setProviderModelEnabled(params: {
  providerId: string;
  modelId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke('db_set_provider_model_enabled', {
    providerId: params.providerId,
    modelId: params.modelId,
    enabled: params.enabled,
  });
}

export async function setAllProviderModelsEnabled(params: {
  providerId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke('db_set_all_provider_models_enabled', {
    providerId: params.providerId,
    enabled: params.enabled,
  });
}

// ============ Provider Settings ============

export async function getProviderSettings(providerId: string): Promise<DbProviderSettings> {
  return invoke<DbProviderSettings>('db_get_provider_settings', { providerId });
}

export async function updateProviderSettings(params: {
  providerId: string;
  filterFreeModels: boolean;
}): Promise<void> {
  return invoke('db_update_provider_settings', {
    providerId: params.providerId,
    filterFreeModels: params.filterFreeModels,
  });
}

// ============ Utility ============

/**
 * Check if we're running in Tauri
 */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Wrapper that falls back gracefully when Tauri is not available
 */
export async function safeInvoke<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (!isTauriAvailable()) {
    console.warn('Tauri not available, using fallback');
    return fallback;
  }
  
  try {
    return await fn();
  } catch (error) {
    console.error('Tauri invoke error:', error);
    throw error;
  }
}
