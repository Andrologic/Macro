import { fingerprint, projectFinalProvenance } from './assistantProvenanceProjection';
export { projectFinalProvenance } from './assistantProvenanceProjection';
import { dbCompareAndSwapAppSetting, dbGetAppSetting } from '../tauriIpc';

export interface AssistantProvenanceStorage {
  load(key: string): Promise<string | null>;
  compareAndSwap(key: string, previous: string | null, next: string): Promise<boolean>;
}
export interface AssistantProvenance {
  recordFinal(messageId: string, content: string, providerItems?: readonly unknown[]): Promise<void>;
  recordInterrupted(messageId: string, content: string, providerDeltaText: string): Promise<void>;
  readFinal(messageId: string, content: string): Promise<string | null>;
}
const nativeStorage: AssistantProvenanceStorage = {
  load: async key => (await dbGetAppSetting(key))?.value_json ?? null,
  compareAndSwap: async (key, previous, next) => (await dbCompareAndSwapAppSetting({ key, expectedValueJson: previous, valueJson: next })).applied,
};

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The last replay item must itself be assistant output, not a tool result/call.
 * These two grammars are built by streamingChat's native and generic adapters.
 * visible_content and reasoning fields are deliberately not output evidence. */
function finalProviderText(items?: readonly unknown[]): string | null {
  const item = object(items?.at(-1));
  if (!item || item.role !== 'assistant' || (item.channel !== undefined && item.channel !== 'final') ||
      (item.status !== undefined && item.status !== 'completed') ||
      (item.tool_calls !== undefined && (!Array.isArray(item.tool_calls) || item.tool_calls.length > 0))) return null;
  if (item.type === 'chat_completion_message') return typeof item.content === 'string' ? item.content : null;
  if (item.type !== 'message' || !Array.isArray(item.content) || !item.content.length) return null;
  const parts: string[] = [];
  for (const part of item.content) {
    const value = object(part);
    if (value?.type !== 'output_text' || typeof value.text !== 'string') return null;
    parts.push(value.text);
  }
  return parts.join('');
}

/** Written only after final stream persistence. The receipt binds exact display
 * bytes and a provider-output range, excluding system chunks in the accumulator.
 * No text, provider payload or secret is stored in this metadata. */
export function assistantProvenance(storage: AssistantProvenanceStorage = nativeStorage): AssistantProvenance {
  const keyFor = (messageId: string) => `chat:assistant-visible-provenance:v1:${messageId}`;
  const recordRange = async (messageId: string, content: string, candidate: string | null | undefined) => {
      if (!candidate) return;
      const start = content.lastIndexOf(candidate);
      if (start < 0) return;
      const key = keyFor(messageId);
      const next = JSON.stringify({ version: 2, source: 'provider-output', fingerprint: await fingerprint(messageId, content), start, end: start + candidate.length });
      for (let attempt = 0; attempt < 2; attempt++) {
        const previous = await storage.load(key);
        if (await storage.compareAndSwap(key, previous, next)) return;
      }
      throw new Error('Assistant provenance persistence unavailable');
  };
  return {
    recordFinal: async (messageId, content, providerItems) => recordRange(messageId, content, finalProviderText(providerItems)?.trim()),
    // Only the live accumulator's provider range may enter here at an explicit
    // stop. The regular export policy still rejects reasoning and private text.
    recordInterrupted: async (messageId, content, providerDeltaText) => recordRange(messageId, content, providerDeltaText.trim()),
    readFinal: async (messageId, content) => {
      const raw = await storage.load(keyFor(messageId));
      return projectFinalProvenance(messageId, content, raw);
    },
  };
}
