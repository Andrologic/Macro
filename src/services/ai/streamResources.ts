import { type UnlistenFn } from '../tauriRuntimeBridge';
import * as tauriIpc from '../tauriIpc';

export interface ActiveStreamResources {
  cancel?: () => void;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  stream: ReadableStream<Uint8Array> | null;
  tauriRequestId: string | null;
  tauriUnlisteners: UnlistenFn[];
}

export const DEFAULT_STREAM_SESSION_ID = '__default__';
export const activeStreamResourcesBySessionId = new Map<string, ActiveStreamResources>();

export const getStreamSessionId = (sessionId?: string): string =>
  sessionId && sessionId.trim().length > 0 ? sessionId : DEFAULT_STREAM_SESSION_ID;

export const getOrCreateActiveStreamResources = (sessionId?: string): ActiveStreamResources => {
  const resolvedSessionId = getStreamSessionId(sessionId);
  const existing = activeStreamResourcesBySessionId.get(resolvedSessionId);
  if (existing) {
    return existing;
  }
  return createActiveStreamResources(resolvedSessionId);
};

export const createActiveStreamResources = (sessionId?: string): ActiveStreamResources => {
  const created: ActiveStreamResources = {
    reader: null,
    stream: null,
    tauriRequestId: null,
    tauriUnlisteners: [],
  };
  activeStreamResourcesBySessionId.set(getStreamSessionId(sessionId), created);
  return created;
};

export const cleanupStreamListeners = (resources: ActiveStreamResources) => {
  if (resources.tauriUnlisteners.length === 0) {
    return;
  }

  resources.tauriUnlisteners.forEach((unlisten) => {
    try {
      unlisten();
    } catch {
      // Ignore listener cleanup errors
    }
  });
  resources.tauriUnlisteners = [];
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
    resources.tauriRequestId === null &&
    resources.tauriUnlisteners.length === 0
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
    cleanupStreamListeners(resources);
    pruneActiveStreamResources(activeSessionId);
  });
}

export const clearTauriListeners = (sessionId?: string) => {
  const resources = activeStreamResourcesBySessionId.get(getStreamSessionId(sessionId));
  if (!resources) {
    return;
  }

  cleanupStreamListeners(resources);
  pruneActiveStreamResources(sessionId);
};

export const getActiveStreamingSessionIds = (): string[] =>
  Array.from(activeStreamResourcesBySessionId.keys());

export const createStreamingRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
