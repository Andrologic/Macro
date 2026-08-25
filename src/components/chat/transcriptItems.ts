import type { ChatMessage } from '../../types';

export type ChatTranscriptMessageItem = {
  kind: 'message';
  key: string;
  message: ChatMessage;
  messageIndex: number;
};

export type ChatTranscriptCompactionBoundaryItem = {
  kind: 'compaction_boundary';
  key: string;
  eventId: string;
  afterMessageId: string;
  logicalUpToMessageId?: string;
  updatedAt?: string;
};

export type ChatTranscriptCompactionProgressPhase =
  | 'compacting'
  | 'safety_compacting'
  | 'model_switch_compacting'
  | 'recovering_overflow';

export type ChatTranscriptCompactionProgressItem = {
  kind: 'compaction_progress';
  key: string;
  eventId: string;
  phase: ChatTranscriptCompactionProgressPhase;
  afterMessageId?: string;
  updatedAt?: string;
};

export type ChatTranscriptCompactionEventStatus = 'running' | 'completed';

export type ChatTranscriptCompactionEventInput = {
  id: string;
  status: ChatTranscriptCompactionEventStatus;
  displayAfterMessageId?: string | null;
  logicalUpToMessageId?: string | null;
  kind?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
};

export type ChatTranscriptItem =
  | ChatTranscriptMessageItem
  | ChatTranscriptCompactionBoundaryItem
  | ChatTranscriptCompactionProgressItem;

export const isChatTranscriptCompactionProgressPhase = (
  phase: string | null | undefined,
): phase is ChatTranscriptCompactionProgressPhase =>
  phase === 'compacting' ||
  phase === 'safety_compacting' ||
  phase === 'model_switch_compacting' ||
  phase === 'recovering_overflow';

const resolveCompactionProgressPhase = (
  event: ChatTranscriptCompactionEventInput,
): ChatTranscriptCompactionProgressPhase => {
  if (event.kind === 'safety_prestream') {
    return 'safety_compacting';
  }
  if (event.kind === 'model_switch') {
    return 'model_switch_compacting';
  }
  if (event.kind === 'stream_overflow' || event.kind === 'overflow_recovery') {
    return 'recovering_overflow';
  }
  return 'compacting';
};

const buildCompactionEventItem = (
  event: ChatTranscriptCompactionEventInput,
): ChatTranscriptCompactionBoundaryItem | ChatTranscriptCompactionProgressItem => {
  const key = `compaction-event:${event.id}`;
  const displayAfterMessageId = event.displayAfterMessageId ?? undefined;

  if (event.status === 'running') {
    return {
      kind: 'compaction_progress',
      key,
      eventId: event.id,
      phase: resolveCompactionProgressPhase(event),
      afterMessageId: displayAfterMessageId,
      updatedAt: event.updatedAt ?? event.startedAt ?? undefined,
    };
  }

  return {
    kind: 'compaction_boundary',
    key,
    eventId: event.id,
    afterMessageId: displayAfterMessageId ?? 'end',
    logicalUpToMessageId: event.logicalUpToMessageId ?? undefined,
    updatedAt: event.completedAt ?? event.updatedAt ?? event.startedAt ?? undefined,
  };
};

export const buildChatTranscriptItems = (
  messages: ChatMessage[],
  compactionState?: {
    conversationId?: string | null;
    compactionEvents?: ChatTranscriptCompactionEventInput[] | null;
  } | null,
): ChatTranscriptItem[] => {
  const items: ChatTranscriptItem[] = [];
  const messageIds = new Set(messages.map((message) => message.id));
  const eventsByAnchor = new Map<string, ChatTranscriptCompactionEventInput[]>();
  const eventsAtEnd: ChatTranscriptCompactionEventInput[] = [];
  const eventsById = new Map<string, ChatTranscriptCompactionEventInput>();
  const eventsByVisualSlot = new Map<string, ChatTranscriptCompactionEventInput>();

  for (const event of compactionState?.compactionEvents ?? []) {
    if (!event.id) {
      continue;
    }
    eventsById.set(event.id, event);
  }

  for (const event of eventsById.values()) {
    const anchor = event.displayAfterMessageId;
    const visualSlot = anchor && messageIds.has(anchor) ? `message:${anchor}` : 'end';
    eventsByVisualSlot.set(visualSlot, event);
  }

  for (const event of eventsByVisualSlot.values()) {
    const anchor = event.displayAfterMessageId;
    if (anchor && messageIds.has(anchor)) {
      const existing = eventsByAnchor.get(anchor) ?? [];
      eventsByAnchor.set(anchor, [...existing, event]);
    } else {
      eventsAtEnd.push(event);
    }
  }

  messages.forEach((message, messageIndex) => {
    items.push({
      kind: 'message',
      key: `message:${message.id}`,
      message,
      messageIndex,
    });

    const anchoredEvents = eventsByAnchor.get(message.id) ?? [];
    for (const event of anchoredEvents) {
      items.push(buildCompactionEventItem(event));
    }
  });

  for (const event of eventsAtEnd) {
    items.push(buildCompactionEventItem(event));
  }

  return items;
};

export const getTranscriptMessageIndexById = (
  items: ChatTranscriptItem[],
  messageId: string,
): number | null => {
  const index = items.findIndex(
    (item) => item.kind === 'message' && item.message.id === messageId,
  );
  return index >= 0 ? index : null;
};
