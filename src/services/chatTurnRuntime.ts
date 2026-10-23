import type { ChatIntentAdmission, ChatIntentReceipt } from "./ipc/chatAdmission";
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
  cancelTransport(sessionId: string): void;
  settled(conversationId: string): void;
}) {
  const sessions = new Map<string, string>();
  const generations = new Map<string, symbol>();
  const completions = new Map<string, ChatTurnIdentity>();
  const streams = new Map<string, Promise<void>>();
  const steers = new Map<string, Array<{ sessionId: string | null; turnId: string | null; message: import("./streamingChat").StreamMessage; admission?: ChatIntentAdmission }>>();
  const consumedSteers = new Map<string, Array<{ sessionId: string; turnId: string | null; receipt: ChatIntentReceipt }>>();
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
  return {
    read, set, update, matches, ownsCompletion,
    assertCanSend: (id: string, input: { available: boolean; hasUnsavedResponse: boolean }) => {
      if (!input.available || ports.state.isDeleted(id)) throw new Error("This conversation is no longer available.");
      if (input.hasUnsavedResponse) throw new Error("Save or delete the unsaved assistant response before sending another message.");
      if (isConversationRuntimeActive(read(id))) throw new Error("This conversation is already running. Wait for it to finish before sending again.");
    },
    latestSession: (id: string) => sessions.get(id),
    rememberSession: (id: string, session: string) => { sessions.set(id, session); },
    forgetSession: (id: string) => { sessions.delete(id); },
    forget: (id: string) => { sessions.delete(id); generations.delete(id); completions.delete(id); steers.delete(id); consumedSteers.delete(id); },
    reset: () => { sessions.clear(); generations.clear(); completions.clear(); steers.clear(); consumedSteers.clear(); },
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
    stop: (id: string) => {
      const state = read(id);
      if (!isConversationRuntimeActive(state)) return;
      if (state.phase === "persisting" && !ports.state.isDeleted(id)) return;
      // Abort listeners flush and capture progress synchronously before ownership is released.
      state.abortController?.abort();
      if (state.sessionId) ports.cancelTransport(state.sessionId);
      // A synchronous abort listener may have installed a successor.
      if (read(id) !== state) return;
      set(id, { ...state, phase: "idle", abortController: null, lastError: null }, { globalLastError: null });
    },
    track: (id: string, promise: Promise<void>) => {
      streams.set(id, promise);
      const release = () => {
        if (streams.get(id) !== promise) return;
        streams.delete(id);
        steers.delete(id);
        consumedSteers.delete(id);
        queueMicrotask(() => ports.settled(id));
      };
      void promise.then(release, release);
    },
    drain: async (id: string) => {
      // Overflow recovery can replace the transport while its predecessor unwinds.
      let pending = streams.get(id);
      while (pending) {
        await pending;
        const next = streams.get(id);
        if (next === pending) return;
        pending = next;
      }
    },
    enqueueSteer: (id: string, message: import("./streamingChat").StreamMessage,
      expected: Pick<ConversationRuntimeState, "sessionId" | "turnId"> = read(id), admission?: ChatIntentAdmission) => {
      const current = read(id);
      if (ports.state.isDeleted(id) || !isConversationRuntimeActive(current) ||
          current.phase === 'persisting' || !expected.sessionId || !expected.turnId ||
          current.sessionId !== expected.sessionId || current.turnId !== expected.turnId) return false;
      steers.set(id, [...(steers.get(id) ?? []), { sessionId: expected.sessionId, turnId: expected.turnId, message, admission }]);
      return true;
    },
    consumeSteers: (identity: ChatTurnIdentity) => {
      if (!matches(identity, "streaming")) return [];
      const pending = steers.get(identity.conversationId) ?? [];
      steers.delete(identity.conversationId);
      const selected = pending.filter(item => item.sessionId === identity.sessionId && item.turnId === identity.turnId);
      const receipts = selected.flatMap(item => item.admission?.kind === 'globalChat'
        ? [{ sessionId: identity.sessionId, turnId: identity.turnId, receipt: item.admission.receipt }] : []);
      consumedSteers.set(identity.conversationId, [...(consumedSteers.get(identity.conversationId) ?? []), ...receipts]);
      return selected.map(item => item.message);
    },
    providerSteerReceipts: (identity: ChatTurnIdentity): ChatIntentReceipt[] =>
      (consumedSteers.get(identity.conversationId) ?? [])
        .filter(item => item.sessionId === identity.sessionId && item.turnId === identity.turnId)
        .map(item => item.receipt),
  };
}

export type ChatTurnRuntime = ReturnType<typeof createChatTurnRuntime>;

export class ChatTurnSupersededError extends Error {
  constructor() { super("Assistant request preparation was superseded."); this.name = "ChatTurnSupersededError"; }
}
