import * as tauriIpc from '../tauriIpc';

export interface ActiveStreamResources {
  cancel?: () => void;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  stream: ReadableStream<Uint8Array> | null;
  tauriRequestId: string | null;
}

export const DEFAULT_STREAM_SESSION_ID = '__default__';
export const activeStreamResourcesBySessionId = new Map<string, ActiveStreamResources>();

export const getStreamSessionId = (sessionId?: string): string =>
  sessionId && sessionId.trim().length > 0 ? sessionId : DEFAULT_STREAM_SESSION_ID;

export const createActiveStreamResources = (sessionId?: string): ActiveStreamResources => {
  const created: ActiveStreamResources = {
    reader: null,
    stream: null,
    tauriRequestId: null,
  };
  activeStreamResourcesBySessionId.set(getStreamSessionId(sessionId), created);
  return created;
};

export const pruneActiveStreamResources = (sessionId?: string, owner?: ActiveStreamResources) => {
  const resolvedSessionId = getStreamSessionId(sessionId);
  const resources = activeStreamResourcesBySessionId.get(resolvedSessionId);
  if (!resources || (owner && resources !== owner)) {
    return;
  }

  if (
    resources.reader === null &&
    resources.stream === null &&
    resources.tauriRequestId === null
  ) {
    activeStreamResourcesBySessionId.delete(resolvedSessionId);
  }
};

/**
 * Cancel the currently active stream
 */
export function cancelStream(sessionId?: string): void {
  const sessionIds = sessionId
    ? [getStreamSessionId(sessionId)]
    : Array.from(activeStreamResourcesBySessionId.keys());

  sessionIds.forEach((activeSessionId) => {
    const resources = activeStreamResourcesBySessionId.get(activeSessionId);
    if (!resources) {
      return;
    }

    resources.cancel?.();

    if (resources.reader) {
      resources.reader.cancel().catch(() => {
        // Ignore errors during cancel
      });
      resources.reader = null;
    }
    if (resources.stream) {
      resources.stream.cancel().catch(() => {
        // Ignore errors during cancel
      });
      resources.stream = null;
    }
    if (resources.tauriRequestId && tauriIpc.isTauriAvailable()) {
      void tauriIpc.aiCancelStream(resources.tauriRequestId).catch(() => {
        // Ignore backend cancel failures
      });
    }
    resources.tauriRequestId = null;
    pruneActiveStreamResources(activeSessionId, resources);
  });
}

export const getActiveStreamingSessionIds = (): string[] =>
  Array.from(activeStreamResourcesBySessionId.keys());

export const createStreamingRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
