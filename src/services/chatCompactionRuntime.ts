import type { ContextCompactionKind, ConversationCompactionState } from "../types";
import {
  buildCompactionActivityStatus,
  clearLatestRunningSessionCompactionEvent,
  completeLatestSessionCompactionEvent,
  isTransientCompactionStatus,
  resolveCompactionStatusFromState,
  startSessionCompactionEvent,
  type ConversationCompactionStatus,
  type SessionCompactionEvent,
} from "./contextCompactionSession";

export interface ChatCompactionRuntimeState {
  conversationCompactionStatusById: Record<
    string,
    ConversationCompactionStatus | undefined
  >;
  sessionCompactionEventsByConversationId: Record<
    string,
    SessionCompactionEvent[] | undefined
  >;
}

export interface ChatCompactionRuntimeAdapters {
  getState: () => ChatCompactionRuntimeState;
  setState: (
    updater: (
      state: ChatCompactionRuntimeState,
    ) => Partial<ChatCompactionRuntimeState>,
  ) => void;
  getLastConversationMessageId: (conversationId: string) => string | null;
}

export interface ChatCompactionRuntime {
  setConversationCompactionStatus: (
    conversationId: string,
    status: ConversationCompactionStatus | null,
  ) => void;
  publishPersistedCompactionStatusIfIdle: (
    conversationId: string,
    state: ConversationCompactionState | null,
  ) => void;
  setConversationCompactionActivityStarted: (
    conversationId: string,
    kind: ContextCompactionKind,
    fallbackStatus?: ConversationCompactionStatus | null,
  ) => void;
  startSessionCompactionEvent: (
    conversationId: string,
    kind: ContextCompactionKind,
    displayAfterMessageId?: string | null,
  ) => void;
  completeLatestSessionCompactionEvent: (
    conversationId: string,
    state: ConversationCompactionState,
    kind?: ContextCompactionKind,
  ) => void;
  clearLatestRunningSessionCompactionEvent: (
    conversationId: string,
    kind?: ContextCompactionKind,
  ) => void;
  markConversationCompactionStarted: (
    conversationId: string,
    kind: ContextCompactionKind,
    fallbackStatus?: ConversationCompactionStatus | null,
    displayAfterMessageId?: string | null,
  ) => void;
}

export const createChatCompactionRuntime = (
  adapters: ChatCompactionRuntimeAdapters,
): ChatCompactionRuntime => {
  const setConversationCompactionStatus = (
    conversationId: string,
    status: ConversationCompactionStatus | null,
  ) => {
    adapters.setState((state) => {
      const next = { ...state.conversationCompactionStatusById };
      if (status) {
        next[conversationId] = status;
      } else {
        delete next[conversationId];
      }
      return { conversationCompactionStatusById: next };
    });
  };
  const setStatus = setConversationCompactionStatus;

  const setSessionCompactionEvents = (
    conversationId: string,
    events: SessionCompactionEvent[] | undefined,
  ) => {
    adapters.setState((state) => {
      const next = { ...state.sessionCompactionEventsByConversationId };
      if (events?.length) {
        next[conversationId] = events;
      } else {
        delete next[conversationId];
      }
      return { sessionCompactionEventsByConversationId: next };
    });
  };

  const setConversationCompactionActivityStarted = (
    conversationId: string,
    kind: ContextCompactionKind,
    fallbackStatus?: ConversationCompactionStatus | null,
  ) => {
    const previous =
      adapters.getState().conversationCompactionStatusById[conversationId] ??
      fallbackStatus;
    setStatus(
      conversationId,
      buildCompactionActivityStatus({ kind, previous }),
    );
  };

  const startCompactionEvent = (
    conversationId: string,
    kind: ContextCompactionKind,
    displayAfterMessageId?: string | null,
  ) => {
    const anchor =
      displayAfterMessageId ??
      adapters.getLastConversationMessageId(conversationId);
    const existing =
      adapters.getState().sessionCompactionEventsByConversationId[
        conversationId
      ] ?? [];
    setSessionCompactionEvents(
      conversationId,
      startSessionCompactionEvent({
        conversationId,
        kind,
        displayAfterMessageId: anchor,
        existingEvents: existing,
      }),
    );
  };

  const completeCompactionEvent = (
    conversationId: string,
    compactionState: ConversationCompactionState,
    kind?: ContextCompactionKind,
  ) => {
    const existing =
      adapters.getState().sessionCompactionEventsByConversationId[
        conversationId
      ] ?? [];
    setSessionCompactionEvents(
      conversationId,
      completeLatestSessionCompactionEvent({
        existingEvents: existing,
        state: compactionState,
        kind,
      }),
    );
  };

  const clearCompactionEvent = (
    conversationId: string,
    kind?: ContextCompactionKind,
  ) => {
    const existing =
      adapters.getState().sessionCompactionEventsByConversationId[
        conversationId
      ] ?? [];
    setSessionCompactionEvents(
      conversationId,
      clearLatestRunningSessionCompactionEvent({
        existingEvents: existing,
        kind,
      }),
    );
  };

  return {
    setConversationCompactionStatus,
    publishPersistedCompactionStatusIfIdle: (conversationId, compactionState) => {
      const currentStatus =
        adapters.getState().conversationCompactionStatusById[conversationId] ??
        null;
      if (isTransientCompactionStatus(currentStatus)) {
        return;
      }
      setStatus(
        conversationId,
        compactionState
          ? resolveCompactionStatusFromState(compactionState)
          : null,
      );
    },
    setConversationCompactionActivityStarted,
    startSessionCompactionEvent: startCompactionEvent,
    completeLatestSessionCompactionEvent: completeCompactionEvent,
    clearLatestRunningSessionCompactionEvent: clearCompactionEvent,
    markConversationCompactionStarted: (
      conversationId,
      kind,
      fallbackStatus,
      displayAfterMessageId,
    ) => {
      startCompactionEvent(conversationId, kind, displayAfterMessageId);
      setConversationCompactionActivityStarted(
        conversationId,
        kind,
        fallbackStatus,
      );
    },
  };
};
