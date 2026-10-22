import * as tauriIpc from '../tauriIpc';

export interface ActiveStreamResources {
  cancel?: () => void | Promise<void>;
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
export function cancelStream(sessionId?: string): Promise<void> {
  const sessionIds = sessionId
    ? [getStreamSessionId(sessionId)]
    : Array.from(activeStreamResourcesBySessionId.keys());
  const pending = sessionIds.map(async (activeSessionId) => {
    const resources = activeStreamResourcesBySessionId.get(activeSessionId);
    if (!resources) return;
    if (resources.cancel) {
      // The invocation owns signal propagation, native joining and cleanup.
      await resources.cancel();
      return;
    }
    await resources.reader?.cancel();
    resources.reader = null;
    await resources.stream?.cancel();
    resources.stream = null;
    if (resources.tauriRequestId && tauriIpc.isTauriAvailable()) {
      await tauriIpc.aiCancelStream(resources.tauriRequestId);
    }
    resources.tauriRequestId = null;
    pruneActiveStreamResources(activeSessionId, resources);
  });
  const stopped = Promise.all(pending).then(() => undefined);
  // Legacy callers request Stop without awaiting it; an awaiting owner still
  // receives any failure and must keep its admission barrier closed.
  void stopped.catch(() => undefined);
  return stopped;
}

export const getActiveStreamingSessionIds = (): string[] =>
  Array.from(activeStreamResourcesBySessionId.keys());

export const createStreamingRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
