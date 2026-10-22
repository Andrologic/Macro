import { StreamStopUnconfirmedError, preserveStreamStopError } from "./ai/streamCancellation";
import type { ConversationRuntimeState } from "../types";
import { isConversationRuntimeActive } from "../domains/chat/runtimeState";

export interface ChatTurnIdentity {
  conversationId: string;
  sessionId: string;
  turnId: string | null;
  assistantMessageId: string;
}

export interface ChatRuntimeProjectionOptions { globalLastError?: string | null }

/** One state record, projected by the adapter. No shadow copy of chat messages or UI selection. */
export interface ChatTurnStatePort {
  read(conversationId: string): ConversationRuntimeState;
  project(conversationId: string, state: ConversationRuntimeState | null, options?: ChatRuntimeProjectionOptions): void;
  isDeleted(conversationId: string): boolean;
}

export function createChatTurnRuntime(ports: {
  state: ChatTurnStatePort;
  cancelTransport(sessionId: string): void | Promise<void>;
  settled(conversationId: string): void;
  directions?: {
    attempt(ids: string[], identity: ChatTurnIdentity, requestId: string): void;
    ended(ids: string[], identity: ChatTurnIdentity, requestId: string): void;
    confirmed(ids: string[], identity: ChatTurnIdentity): void;
    recover(conversationId: string): void;
    pending?(conversationId: string): boolean;
  };
}) {
  const sessions = new Map<string, string>();
  const generations = new Map<string, symbol>();
  const completions = new Map<string, ChatTurnIdentity>();
  const streams = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  const unconfirmedStops = new Map<string, StreamStopUnconfirmedError>();
  const unconfirmedStates = new Map<string, ConversationRuntimeState>();
  const steers = new Map<string, Array<{
    sessionId: string | null; turnId: string | null; assistantMessageId: string | null;
    directionId?: string; message: import("./streamingChat").StreamMessage;
  }>>();
  const delivered = new Map<string, Array<{ ids: string[]; identity: ChatTurnIdentity; requestId: string }>>();
  const generationNumbers = new Map<string, number>();
  const recoverDirections = (id: string) => {
    if ((steers.get(id)?.length ?? 0) || (delivered.get(id)?.length ?? 0)) ports.directions?.recover(id);
  };
  const targets = (item: { sessionId: string | null; turnId: string | null; assistantMessageId: string | null }, identity: ChatTurnIdentity) =>
    item.sessionId === identity.sessionId && item.turnId === identity.turnId &&
    (item.assistantMessageId === null || item.assistantMessageId === identity.assistantMessageId);
  const read = ports.state.read;
  const set = ports.state.project;
  const matches = (identity: ChatTurnIdentity, phase?: ConversationRuntimeState["phase"]) => {
    const current = read(identity.conversationId);
    return !ports.state.isDeleted(identity.conversationId) &&
      current.sessionId === identity.sessionId && current.turnId === identity.turnId &&
      current.assistantMessageId === identity.assistantMessageId &&
      (!phase || current.phase === phase);
  };
  const update = (id: string, sessionId: string, updater: (state: ConversationRuntimeState) => ConversationRuntimeState | null) => {
    const current = read(id);
    if (current.sessionId !== sessionId) return false;
    set(id, updater(current));
    return true;
  };
  const ownsCompletion = (identity: ChatTurnIdentity) => {
    const owner = completions.get(identity.conversationId);
    return !ports.state.isDeleted(identity.conversationId) &&
      sessions.get(identity.conversationId) === identity.sessionId &&
      owner?.sessionId === identity.sessionId && owner.turnId === identity.turnId &&
      owner.assistantMessageId === identity.assistantMessageId;
  };
  const reserveUnconfirmed = (id: string, state: ConversationRuntimeState, failure: StreamStopUnconfirmedError) => {
    unconfirmedStops.set(id, failure);
    unconfirmedStates.set(id, state);
    try {
      const current = read(id);
      if (current.sessionId === state.sessionId && current.turnId === state.turnId) {
        generations.delete(id);
        set(id, { ...current, phase: "error", lastError: failure.message,
          lastErrorOrigin: "macro", lastErrorDisplayTarget: "composer" });
      }
    } catch (secondary) {
      failure = preserveStreamStopError(failure, secondary);
      unconfirmedStops.set(id, failure);
    }
    // A receipt may arrive independently of another UI Stop request.
    void failure.whenStopped.then(() => {
      if (unconfirmedStops.get(id) !== failure) return;
      unconfirmedStops.delete(id);
      unconfirmedStates.delete(id);
      stopping.delete(id);
      try {
        const latest = read(id);
        if (latest.sessionId === state.sessionId && latest.turnId === state.turnId) {
          set(id, { ...latest, phase: "idle", abortController: null, lastError: null }, { globalLastError: null });
        }
        if (!streams.has(id)) ports.settled(id);
      } catch (secondary) {
        if (secondary instanceof StreamStopUnconfirmedError && !secondary.stopped) {
          reserveUnconfirmed(id, state, secondary);
        } else {
          preserveStreamStopError(failure, secondary);
        }
      }
    }, () => { /* No receipt: retain the same owner and its failure. */ });
    return failure;
  };
  return {
    read, set, update, matches, ownsCompletion,
    assertCanSend: (id: string, input: { available: boolean; hasUnsavedResponse: boolean }) => {
      if (!input.available || ports.state.isDeleted(id)) throw new Error("This conversation is no longer available.");
      if (input.hasUnsavedResponse) throw new Error("Save or delete the unsaved assistant response before sending another message.");
      if (streams.has(id) || stopping.has(id) || unconfirmedStops.has(id) || isConversationRuntimeActive(read(id))) throw new Error("This conversation is already running. Wait for it to finish before sending again.");
    },
    latestSession: (id: string) => sessions.get(id),
    rememberSession: (id: string, session: string) => {
      if (sessions.has(id) && sessions.get(id) !== session) {
        recoverDirections(id);
        generations.delete(id); steers.delete(id); delivered.delete(id);
      }
      sessions.set(id, session);
    },
    forgetSession: (id: string) => { sessions.delete(id); },
    forget: (id: string) => {
      recoverDirections(id);
      sessions.delete(id); generations.delete(id); completions.delete(id); steers.delete(id); delivered.delete(id);
      generationNumbers.set(id, (generationNumbers.get(id) ?? 0) + 1);
    },
    reset: () => {
      for (const id of new Set([...steers.keys(), ...delivered.keys()])) recoverDirections(id);
      for (const id of sessions.keys()) generationNumbers.set(id, (generationNumbers.get(id) ?? 0) + 1);
      sessions.clear(); generations.clear(); completions.clear(); steers.clear(); delivered.clear();
    },
    hasDirections: (id: string) => ports.directions?.pending?.(id) ?? false,
    captureSteerOwner: (id: string) => {
      const expected = { ...read(id) };
      const generation = generationNumbers.get(id) ?? 0;
      return { expected, isCurrent: () => {
        const current = read(id);
        const number = generationNumbers.get(id) ?? 0;
        return !current.abortController?.signal.aborted && !ports.state.isDeleted(id) && sessions.get(id) === expected.sessionId &&
          current.sessionId === expected.sessionId && current.turnId === expected.turnId &&
          (!expected.assistantMessageId || current.assistantMessageId === expected.assistantMessageId) &&
          (number === generation || (expected.phase === 'preparing' && !expected.assistantMessageId && number === generation + 1));
      } };
    },
    transfer: (previous: string, next: string, session: string) => {
      if (ports.state.isDeleted(next) || sessions.get(previous) !== session) return false;
      const existing = sessions.get(next);
      if (existing && existing !== session) return false;
      sessions.set(next, session);
      sessions.delete(previous);
      return true;
    },
    claimStream: (identity: ChatTurnIdentity, controller: AbortController): (() => boolean) | null => {
      if (controller.signal.aborted || !matches(identity, "preparing") ||
        read(identity.conversationId).abortController !== controller) return null;
      if (generations.has(identity.conversationId)) {
        recoverDirections(identity.conversationId);
        steers.delete(identity.conversationId);
        delivered.delete(identity.conversationId);
      }
      const generation = Symbol("assistant stream");
      generations.set(identity.conversationId, generation);
      generationNumbers.set(identity.conversationId, (generationNumbers.get(identity.conversationId) ?? 0) + 1);
      set(identity.conversationId, {
        phase: "streaming", sessionId: identity.sessionId, turnId: identity.turnId,
        assistantMessageId: identity.assistantMessageId, abortController: controller, lastError: null,
      }, { globalLastError: null });
      return () => generations.get(identity.conversationId) === generation &&
        matches(identity, "streaming") && read(identity.conversationId).abortController === controller;
    },
    failLaunch: (id: string, sessionId: string, message: string) => {
      const current = read(id);
      if (current.sessionId !== sessionId || !isConversationRuntimeActive(current)) return false;
      set(id, {
        phase: "error", sessionId, turnId: current.turnId ?? null,
        assistantMessageId: null, abortController: null, lastError: message,
        lastErrorOrigin: "macro", lastErrorDisplayTarget: "composer",
      }, { globalLastError: message });
      return true;
    },
    beginCompletion: (identity: ChatTurnIdentity) => {
      if (!matches(identity, "streaming")) return false;
      recoverDirections(identity.conversationId);
      completions.set(identity.conversationId, identity);
      update(identity.conversationId, identity.sessionId, state => ({
        ...state, phase: "persisting", abortController: null,
        lastError: null, lastErrorOrigin: null, lastErrorDisplayTarget: null,
      }));
      return true;
    },
    releaseCompletion: (identity: ChatTurnIdentity) => {
      if (!ownsCompletion(identity)) return;
      completions.delete(identity.conversationId);
      if (matches(identity, "persisting")) set(identity.conversationId, null);
    },
    failCompletion: (identity: ChatTurnIdentity, fail: () => void) => {
      if (!ownsCompletion(identity) || !matches(identity, "persisting")) return;
      completions.delete(identity.conversationId);
      fail();
    },
    stop: (id: string): Promise<void> => {
      const pendingStop = stopping.get(id);
      if (pendingStop && !unconfirmedStops.has(id)) return pendingStop;
      const projected = read(id);
      const state = projected.sessionId ? projected : unconfirmedStates.get(id) ?? projected;
      if (!isConversationRuntimeActive(state) && !unconfirmedStops.has(id)) return Promise.resolve();
      if (state.phase === "persisting" && !ports.state.isDeleted(id)) return Promise.resolve();
      recoverDirections(id);
      const stream = streams.get(id);
      const generation = generations.get(id);
      // Abort first flushes visible progress synchronously; then revoke late callbacks.
      state.abortController?.abort();
      if (generations.get(id) === generation) generations.delete(id);
      let transport: void | Promise<void>;
      try { transport = state.sessionId ? ports.cancelTransport(state.sessionId) : undefined; }
      catch (error) { transport = Promise.reject(error); }
      if (!stream && !transport) {
        const failure = unconfirmedStops.get(id);
        if (failure) {
          const rejected = Promise.reject(failure);
          void rejected.catch(() => undefined);
          return rejected;
        }
        if (read(id) === state) set(id, { ...state, phase: "idle", abortController: null, lastError: null }, { globalLastError: null });
        return Promise.resolve();
      }
      const stopped = Promise.allSettled([stream, transport]).then((results) => {
        if (stopping.get(id) !== stopped) return;
        const transportResult = results[1];
        const streamResult = results[0];
        const unresolved = new Set<StreamStopUnconfirmedError>();
        const retained = unconfirmedStops.get(id);
        if (retained && !retained.stopped) unresolved.add(retained);
        if (streamResult.status === "rejected" && streamResult.reason instanceof StreamStopUnconfirmedError && !streamResult.reason.stopped) unresolved.add(streamResult.reason);
        if (transportResult.status === "rejected") {
          const reason = transportResult.reason;
          const failure = reason instanceof StreamStopUnconfirmedError ? reason :
            new StreamStopUnconfirmedError(`Stream stop was not confirmed: ${String(reason)}. Its owner remains reserved.`);
          if (!failure.stopped) unresolved.add(failure);
        }
        if (unresolved.size) {
          // A successful provider cancellation cannot discharge another tool's
          // outstanding receipt. Keep every previously reserved owner joined.
          const failures = [...unresolved];
          const failure = failures.length === 1 ? failures[0] : new StreamStopUnconfirmedError(
            failures.map(error => error.message).join("; "),
            Promise.all(failures.map(error => error.whenStopped)).then(() => undefined),
          );
          throw reserveUnconfirmed(id, state, failure);
        }
        // Other stream failures ended locally and retain their original error
        // projection. Only cancellation uncertainty keeps admission reserved.
        unconfirmedStops.delete(id);
        unconfirmedStates.delete(id);
        stopping.delete(id);
        const current = read(id);
        if (current.sessionId === state.sessionId && current.turnId === state.turnId &&
          current.abortController === state.abortController && current.phase !== "persisting") {
          set(id, { ...current, phase: "idle", abortController: null, lastError: null }, { globalLastError: null });
        }
        ports.settled(id);
      });
      stopping.set(id, stopped);
      void stopped.catch(() => undefined);
      return stopped;
    },
    track: (id: string, promise: Promise<void>) => {
      streams.set(id, promise);
      const identity = read(id);
      const release = (error?: unknown) => {
        if (streams.get(id) !== promise) return;
        streams.delete(id);
        if (error instanceof StreamStopUnconfirmedError && !error.stopped) reserveUnconfirmed(id, identity, error);
        recoverDirections(id);
        steers.delete(id);
        delivered.delete(id);
        if (!stopping.has(id) && !unconfirmedStops.has(id)) queueMicrotask(() => ports.settled(id));
      };
      void promise.then(() => release(), error => release(error));
    },
    drain: async (id: string) => {
      try { await stopping.get(id); }
      catch (error) {
        if (!(error instanceof StreamStopUnconfirmedError)) throw error;
        await error.whenStopped;
      }
      await unconfirmedStops.get(id)?.whenStopped;
      // Overflow recovery can replace the transport while its predecessor unwinds.
      let pending = streams.get(id);
      while (pending) {
        try { await pending; }
        catch (error) {
          if (error instanceof StreamStopUnconfirmedError) await error.whenStopped;
          // Finite stream errors ended locally and have their own projection.
        }
        await unconfirmedStops.get(id)?.whenStopped;
        const next = streams.get(id);
        if (next === pending) return;
        pending = next;
      }
    },
    enqueueSteer: (id: string, message: import("./streamingChat").StreamMessage,
      expected: Pick<ConversationRuntimeState, "sessionId" | "turnId"> & Partial<Pick<ConversationRuntimeState, "assistantMessageId">> = read(id),
      directionId?: string) => {
      const current = read(id);
      if (ports.state.isDeleted(id) || !isConversationRuntimeActive(current) ||
          current.phase === 'persisting' || !expected.sessionId || !expected.turnId ||
          current.sessionId !== expected.sessionId || current.turnId !== expected.turnId ||
          (expected.assistantMessageId && current.assistantMessageId !== expected.assistantMessageId)) return false;
      steers.set(id, [...(steers.get(id) ?? []), {
        sessionId: expected.sessionId, turnId: expected.turnId,
        assistantMessageId: expected.assistantMessageId ?? null, directionId, message,
      }]);
      return true;
    },
    consumeSteers: (identity: ChatTurnIdentity) => {
      if (!matches(identity, "streaming")) return [];
      const pending = steers.get(identity.conversationId) ?? [];
      const selected = pending.filter(item => targets(item, identity) && !item.directionId);
      steers.set(identity.conversationId, pending.filter(item => !selected.includes(item)));
      return selected.map(item => item.message);
    },
    hasPendingSteers: (identity: ChatTurnIdentity) => matches(identity, 'streaming') &&
      (steers.get(identity.conversationId) ?? []).some(item => targets(item, identity)),
    deliverSteers: (identity: ChatTurnIdentity, requestId: string, accepts: () => boolean) => {
      if (read(identity.conversationId).abortController?.signal.aborted || !accepts() || !matches(identity, 'streaming')) return [];
      const pending = steers.get(identity.conversationId) ?? [];
      const selected = pending.filter(item => targets(item, identity));
      const ids = selected.flatMap(item => item.directionId ? [item.directionId] : []);
      if (ids.length) ports.directions?.attempt(ids, identity, requestId);
      // Storage observers may synchronously Stop or replace the owner.
      if (read(identity.conversationId).abortController?.signal.aborted || !accepts() || !matches(identity, 'streaming')) { recoverDirections(identity.conversationId); return []; }
      steers.set(identity.conversationId, pending.filter(item => !selected.includes(item)));
      if (ids.length) delivered.set(identity.conversationId, [
        ...(delivered.get(identity.conversationId) ?? []), { ids, identity, requestId },
      ]);
      return selected.map(item => item.message);
    },
    steerRequestEnded: (identity: ChatTurnIdentity, requestId: string) => {
      if (!matches(identity, 'streaming')) return;
      const ids = (delivered.get(identity.conversationId) ?? []).filter(batch =>
        targets(batch.identity, identity) && batch.requestId === requestId).flatMap(batch => batch.ids);
      ports.directions?.ended(ids, identity, requestId);
    },
    confirmSteers: (identity: ChatTurnIdentity) => {
      if (!ownsCompletion(identity)) return;
      const batches = delivered.get(identity.conversationId) ?? [];
      const selected = batches.filter(batch => targets(batch.identity, identity));
      ports.directions?.confirmed(selected.flatMap(batch => batch.ids), identity);
      delivered.set(identity.conversationId, batches.filter(batch => !selected.includes(batch)));
    },
  };
}

export type ChatTurnRuntime = ReturnType<typeof createChatTurnRuntime>;

export class ChatTurnSupersededError extends Error {
  constructor() { super("Assistant request preparation was superseded."); this.name = "ChatTurnSupersededError"; }
}
