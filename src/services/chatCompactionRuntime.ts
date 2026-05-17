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

  const setConversationCompactionActivityStarted = (
    conversationId: string,
    kind: ContextCompactionKind,
    fallbackStatus?: ConversationCompactionStatus | null,
  ) => {
    const previous =
      adapters.getState().conversationCompactionStatusById[conversationId] ??
      fallbackStatus;
    setConversationCompactionStatus(
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
    adapters.setState((state) => {
      const existing =
        state.sessionCompactionEventsByConversationId[conversationId] ?? [];
      return {
        sessionCompactionEventsByConversationId: {
          ...state.sessionCompactionEventsByConversationId,
          [conversationId]: startSessionCompactionEvent({
            conversationId,
            kind,
            displayAfterMessageId: anchor,
            existingEvents: existing,
          }),
        },
      };
    });
  };

  const completeCompactionEvent = (
    conversationId: string,
    state: ConversationCompactionState,
    kind?: ContextCompactionKind,
  ) => {
    adapters.setState((runtimeState) => {
      const existing =
        runtimeState.sessionCompactionEventsByConversationId[conversationId] ??
        [];
      return {
        sessionCompactionEventsByConversationId: {
          ...runtimeState.sessionCompactionEventsByConversationId,
          [conversationId]: completeLatestSessionCompactionEvent({
            existingEvents: existing,
            state,
            kind,
          }),
        },
      };
    });
  };

  const clearCompactionEvent = (
    conversationId: string,
    kind?: ContextCompactionKind,
  ) => {
    adapters.setState((state) => {
      const existing =
        state.sessionCompactionEventsByConversationId[conversationId] ?? [];
      return {
        sessionCompactionEventsByConversationId: {
          ...state.sessionCompactionEventsByConversationId,
          [conversationId]: clearLatestRunningSessionCompactionEvent({
            existingEvents: existing,
            kind,
          }),
        },
      };
    });
  };

  return {
    setConversationCompactionStatus,
    publishPersistedCompactionStatusIfIdle: (conversationId, state) => {
      const currentStatus =
        adapters.getState().conversationCompactionStatusById[conversationId] ??
        null;
      if (isTransientCompactionStatus(currentStatus)) {
        return;
      }
      setConversationCompactionStatus(
        conversationId,
        state ? resolveCompactionStatusFromState(state) : null,
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
