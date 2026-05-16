import type { ChatMessage, ConversationCompactionState } from '../types';
import { invalidateCompactionFromMessage } from './contextCompaction';

export interface ReplayCompactionMarker {
  displayAfterMessageId: string | null;
}

export interface ConversationReplayPlan<TMarker extends ReplayCompactionMarker> {
  conversationId: string;
  replayMessageId: string;
  keptMessageIds: Set<string>;
  sessionCompactionEvents: TMarker[] | undefined;
  removedSessionCompactionEventCount: number;
  shouldDeleteContextCompactionState: boolean;
  contextCompactionAction: 'none' | 'keep' | 'delete';
  diagnosticMessages: string[];
}

const sortConversationMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages
    .slice()
    .sort(
      (left, right) =>
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    );

export const pruneSessionCompactionEventsForReplay = <
  TMarker extends ReplayCompactionMarker,
>(
  events: TMarker[] | undefined,
  conversationMessages: ChatMessage[],
  replayMessageId: string,
): TMarker[] | undefined => {
  if (!events?.length) {
    return events;
  }

  const orderedMessages = sortConversationMessages(conversationMessages);
  const messageIndexById = new Map(
    orderedMessages.map((message, index) => [message.id, index]),
  );
  const replayIndex = messageIndexById.get(replayMessageId);
  if (replayIndex === undefined) {
    return undefined;
  }

  const keptEvents = events.filter((event) => {
    if (!event.displayAfterMessageId) {
      return false;
    }
    const anchorIndex = messageIndexById.get(event.displayAfterMessageId);
    return anchorIndex !== undefined && anchorIndex < replayIndex;
  });

  return keptEvents.length > 0 ? keptEvents : undefined;
};

export const shouldDeleteContextCompactionForReplay = (
  state: ConversationCompactionState | null | undefined,
  orderedMessagesAfterReplay: ChatMessage[],
  replayMessageId: string,
): boolean =>
  invalidateCompactionFromMessage(
    state,
    sortConversationMessages(orderedMessagesAfterReplay),
    replayMessageId,
  );

export const buildConversationReplayPlan = <
  TMarker extends ReplayCompactionMarker,
>(params: {
  conversationId: string;
  replayMessageId: string;
  conversationMessages: ChatMessage[];
  contextCompactionState?: ConversationCompactionState | null;
  sessionCompactionEvents?: TMarker[];
}): ConversationReplayPlan<TMarker> => {
  const orderedMessages = sortConversationMessages(
    params.conversationMessages.filter(
      (message) => message.conversation_id === params.conversationId,
    ),
  );
  const replayIndex = orderedMessages.findIndex(
    (message) => message.id === params.replayMessageId,
  );
  const keptMessageIds = new Set(
    replayIndex < 0
      ? []
      : orderedMessages.slice(0, replayIndex + 1).map((message) => message.id),
  );
  const keptEvents = pruneSessionCompactionEventsForReplay(
    params.sessionCompactionEvents,
    orderedMessages,
    params.replayMessageId,
  );
  const beforeCount = params.sessionCompactionEvents?.length ?? 0;
  const afterCount = keptEvents?.length ?? 0;
  const orderedMessagesAfterReplay = orderedMessages.filter((message) =>
    keptMessageIds.has(message.id),
  );
  const shouldDeleteContextCompactionState = shouldDeleteContextCompactionForReplay(
    params.contextCompactionState,
    orderedMessagesAfterReplay,
    params.replayMessageId,
  );
  const contextCompactionAction = params.contextCompactionState
    ? shouldDeleteContextCompactionState
      ? 'delete'
      : 'keep'
    : 'none';
  const diagnosticMessages = [
    ...(shouldDeleteContextCompactionState
      ? ['Les compactages de contexte après ce message seront recalculés.']
      : []),
    ...(beforeCount - afterCount > 0
      ? ['Les marqueurs visuels de compaction après ce message seront retirés.']
      : []),
  ];

  return {
    conversationId: params.conversationId,
    replayMessageId: params.replayMessageId,
    keptMessageIds,
    sessionCompactionEvents: keptEvents,
    removedSessionCompactionEventCount: Math.max(0, beforeCount - afterCount),
    shouldDeleteContextCompactionState,
    contextCompactionAction,
    diagnosticMessages,
  };
};
