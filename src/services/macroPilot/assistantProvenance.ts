import { dbCompareAndSwapAppSetting, dbGetAppSetting } from '../tauriIpc';

export interface AssistantProvenanceStorage {
  load(key: string): Promise<string | null>;
  compareAndSwap(key: string, previous: string | null, next: string): Promise<boolean>;
}
export interface AssistantProvenance {
  recordFinal(messageId: string, content: string): Promise<void>;
  verifies(messageId: string, content: string): Promise<boolean>;
}
const nativeStorage: AssistantProvenanceStorage = {
  load: async key => (await dbGetAppSetting(key))?.value_json ?? null,
  compareAndSwap: async (key, previous, next) => (await dbCompareAndSwapAppSetting({ key, expectedValueJson: previous, valueJson: next })).applied,
};
async function fingerprint(messageId: string, content: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([messageId, content]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Written only by the final stream persistence boundary, after its message write.
 * Records no text, provider payload or secret. A changed message cannot reuse its
 * receipt; a failed or interrupted receipt write leaves export withheld. */
export function assistantProvenance(storage: AssistantProvenanceStorage = nativeStorage): AssistantProvenance {
  const keyFor = (messageId: string) => `chat:assistant-visible-provenance:v1:${messageId}`;
  return {
    recordFinal: async (messageId, content) => {
      const key = keyFor(messageId);
      const next = JSON.stringify({ version: 1, source: 'stream-completion-visible', fingerprint: await fingerprint(messageId, content) });
      for (let attempt = 0; attempt < 2; attempt++) {
        const previous = await storage.load(key);
        if (await storage.compareAndSwap(key, previous, next)) return;
      }
      throw new Error('Assistant provenance persistence unavailable');
    },
    verifies: async (messageId, content) => {
      const raw = await storage.load(keyFor(messageId));
      if (raw === null) return false;
      try {
        const record: unknown = JSON.parse(raw);
        return Boolean(record && typeof record === 'object' && 'version' in record && record.version === 1 &&
          'source' in record && record.source === 'stream-completion-visible' && 'fingerprint' in record &&
          record.fingerprint === await fingerprint(messageId, content));
      } catch { return false; }
    },
  };
}
