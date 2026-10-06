import { StreamStopUnconfirmedError } from "./ai/streamCancellation";
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
}) {
  const sessions = new Map<string, string>();
  const generations = new Map<string, symbol>();
  const completions = new Map<string, ChatTurnIdentity>();
  const streams = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  const unconfirmedStops = new Map<string, StreamStopUnconfirmedError>();
  const unconfirmedStates = new Map<string, ConversationRuntimeState>();
  const steers = new Map<string, Array<{ sessionId: string | null; turnId: string | null; message: import("./streamingChat").StreamMessage }>>();
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
    const current = read(id);
    if (current.sessionId === state.sessionId && current.turnId === state.turnId) {
      generations.delete(id);
      set(id, { ...current, phase: "error", lastError: failure.message,
        lastErrorOrigin: "macro", lastErrorDisplayTarget: "composer" });
    }
    // A receipt may arrive independently of another UI Stop request.
    void failure.whenStopped.then(() => {
      if (unconfirmedStops.get(id) !== failure) return;
      unconfirmedStops.delete(id);
      unconfirmedStates.delete(id);
      stopping.delete(id);
      const latest = read(id);
      if (latest.sessionId === state.sessionId && latest.turnId === state.turnId) {
        set(id, { ...latest, phase: "idle", abortController: null, lastError: null }, { globalLastError: null });
      }
      if (!streams.has(id)) ports.settled(id);
    }, () => { /* No receipt: retain the same owner and its failure. */ });
  };
  return {
    read, set, update, matches, ownsCompletion,
    assertCanSend: (id: string, input: { available: boolean; hasUnsavedResponse: boolean }) => {
      if (!input.available || ports.state.isDeleted(id)) throw new Error("This conversation is no longer available.");
      if (input.hasUnsavedResponse) throw new Error("Save or delete the unsaved assistant response before sending another message.");
      if (streams.has(id) || stopping.has(id) || unconfirmedStops.has(id) || isConversationRuntimeActive(read(id))) throw new Error("This conversation is already running. Wait for it to finish before sending again.");
    },
    latestSession: (id: string) => sessions.get(id),
    rememberSession: (id: string, session: string) => { sessions.set(id, session); },
    forgetSession: (id: string) => { sessions.delete(id); },
    forget: (id: string) => { sessions.delete(id); generations.delete(id); completions.delete(id); steers.delete(id); },
    reset: () => { sessions.clear(); generations.clear(); completions.clear(); steers.clear(); },
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
      const generation = Symbol("assistant stream");
      generations.set(identity.conversationId, generation);
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
          reserveUnconfirmed(id, state, failure);
          throw failure;
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
        steers.delete(id);
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
      expected: Pick<ConversationRuntimeState, "sessionId" | "turnId"> = read(id)) => {
      const current = read(id);
      if (ports.state.isDeleted(id) || !isConversationRuntimeActive(current) ||
          current.phase === 'persisting' || !expected.sessionId || !expected.turnId ||
          current.sessionId !== expected.sessionId || current.turnId !== expected.turnId) return false;
      steers.set(id, [...(steers.get(id) ?? []), { sessionId: expected.sessionId, turnId: expected.turnId, message }]);
      return true;
    },
    consumeSteers: (identity: ChatTurnIdentity) => {
      if (!matches(identity, "streaming")) return [];
      const pending = steers.get(identity.conversationId) ?? [];
      steers.delete(identity.conversationId);
      return pending.filter(item => item.sessionId === identity.sessionId && item.turnId === identity.turnId).map(item => item.message);
    },
  };
}

export type ChatTurnRuntime = ReturnType<typeof createChatTurnRuntime>;

export class ChatTurnSupersededError extends Error {
  constructor() { super("Assistant request preparation was superseded."); this.name = "ChatTurnSupersededError"; }
}
