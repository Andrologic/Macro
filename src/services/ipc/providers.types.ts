/** providers IPC DTOs. Kept separate for generated Rust binding integration. */

export interface DbProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string | null;
  has_stored_api_key: boolean;
  is_enabled: boolean;
  is_local: boolean;
  auth_status: string | null;
  auth_source: string | null;
  plan_type: string | null;
  account_label: string | null;
  token_expires_at: string | null;
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
  reasoning_efforts: string[] | null;
  default_reasoning_effort: string | null;
  context_window_tokens: number | null;
  input_limit_tokens: number | null;
  output_limit_tokens: number | null;
  context_window_source: string | null;
  context_limits_updated_at: string | null;
  is_enabled: boolean;
  is_manual: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DbProviderSettings {
  provider_id: string;
  filter_free_models: boolean;
  copilot_send_timeout_ms: number | null;
}

export interface DbProviderModelInput {
  model_id: string;
  name: string;
  description?: string | null;
  owned_by?: string | null;
  pricing_prompt?: string | null;
  pricing_completion?: string | null;
  pricing_request?: string | null;
  reasoning_efforts?: string[] | null;
  default_reasoning_effort?: string | null;
  context_window_tokens?: number | null;
  input_limit_tokens?: number | null;
  output_limit_tokens?: number | null;
  context_window_source?: string | null;
  context_limits_updated_at?: string | null;
}
