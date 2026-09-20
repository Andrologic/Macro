/** speech IPC wrappers and frontend adapters. */

import type {
  SpeechProviderConfig,
  SpeechTranscriptionResult,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";

export async function listSpeechProviderConfigs(): Promise<SpeechProviderConfig[]> {
  return invoke<SpeechProviderConfig[]>("speech_list_provider_configs");
}

export async function createSpeechProviderConfig(params: {
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  isLocal: boolean;
  isEnabled: boolean;
}): Promise<SpeechProviderConfig> {
  return invoke<SpeechProviderConfig>("speech_create_provider_config", {
    name: params.name,
    providerType: params.providerType,
    baseUrl: params.baseUrl,
    model: params.model,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal,
    isEnabled: params.isEnabled,
  });
}

export async function updateSpeechProviderConfig(params: {
  id: string;
  name?: string;
  providerType?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  isLocal?: boolean;
  isEnabled?: boolean;
}): Promise<void> {
  return invoke("speech_update_provider_config", {
    params: {
      id: params.id,
      name: params.name ?? null,
      providerType: params.providerType ?? null,
      baseUrl: params.baseUrl ?? null,
      model: params.model ?? null,
      apiKey: params.apiKey ?? null,
      isLocal: params.isLocal ?? null,
      isEnabled: params.isEnabled ?? null,
    },
  });
}

export async function deleteSpeechProviderConfig(id: string): Promise<void> {
  return invoke("speech_delete_provider_config", { id });
}

export async function transcribeSpeech(params: {
  providerId: string;
  audio: Uint8Array;
  mimeType: string;
  fileName: string;
  language?: string | null;
}): Promise<SpeechTranscriptionResult> {
  return invoke<SpeechTranscriptionResult>("speech_transcribe", params.audio, {
    headers: {
      "x-macro-speech-provider-id": params.providerId,
      "x-macro-speech-mime-type": params.mimeType,
      "x-macro-speech-file-name": params.fileName,
      "x-macro-speech-language": params.language ?? "auto",
    },
  });
}
