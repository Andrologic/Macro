/** web IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  NativeWebFetchResource,
  NativeWebSearchResult,
  WebSearchSecretStatus,
} from "./web.types";

export async function webSearchGetSecretStatus(
  provider: 'tavily' | 'brave',
): Promise<WebSearchSecretStatus> {
  return invoke<WebSearchSecretStatus>('web_search_get_secret_status', { provider });
}

export async function webSearchSetSecret(input: {
  provider: 'tavily' | 'brave';
  value: string | null;
}): Promise<WebSearchSecretStatus> {
  return invoke<WebSearchSecretStatus>('web_search_set_secret', { input });
}

export async function webSearchExecute(input: {
  query: string;
  includeRawContent?: boolean;
  executionId?: string | null;
}): Promise<NativeWebSearchResult[]> {
  return invoke<NativeWebSearchResult[]>('web_search_execute', {
    query: input.query,
    includeRawContent: input.includeRawContent ?? false,
    executionId: input.executionId ?? null,
  });
}

export async function webFetchExecute(input: {
  url: string;
  resourceKind: "page" | "favicon";
  executionId?: string | null;
}): Promise<NativeWebFetchResource> {
  return invoke<NativeWebFetchResource>("web_fetch_execute", {
    url: input.url,
    resourceKind: input.resourceKind,
    executionId: input.executionId ?? null,
  });
}

export async function cancelWebSearchExecution(executionId: string): Promise<boolean> {
  return invoke<boolean>("web_search_cancel_execution", { executionId });
}
