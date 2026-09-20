import type {
AiModel as NativeDbAiModel,
ProviderConfig as NativeDbProviderConfig,
ProviderModelInput as NativeDbProviderModelInput,
ProviderSettings as NativeDbProviderSettings
} from '../../types/generated/ipc';
import type { OptionalFields } from './compatibility.types';

/** providers IPC contracts and explicit frontend adaptations of generated native bindings. */

export type DbProviderConfig = NativeDbProviderConfig;

export type DbAiModel = NativeDbAiModel;

export type DbProviderSettings = NativeDbProviderSettings;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DbProviderModelInput = OptionalFields<NativeDbProviderModelInput,
  | "description"
  | "owned_by"
  | "pricing_prompt"
  | "pricing_completion"
  | "pricing_request"
  | "reasoning_efforts"
  | "default_reasoning_effort"
  | "context_window_tokens"
  | "input_limit_tokens"
  | "output_limit_tokens"
  | "context_window_source"
  | "context_limits_updated_at"
>;
