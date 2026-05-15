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
  afterMessageId: string;
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
  phase: ChatTranscriptCompactionProgressPhase;
  updatedAt?: string;
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

export const buildChatTranscriptItems = (
  messages: ChatMessage[],
  compactionState?: {
    conversationId?: string | null;
    upToMessageId?: string | null;
    updatedAt?: string | null;
    phase?: string | null;
  } | null,
): ChatTranscriptItem[] => {
  const items: ChatTranscriptItem[] = [];
  const boundaryMessageId = compactionState?.upToMessageId || null;
  const boundaryIndex = boundaryMessageId
    ? messages.findIndex((message) => message.id === boundaryMessageId)
    : -1;
  const shouldInsertBoundary = boundaryIndex >= 0;
  const progressPhase = isChatTranscriptCompactionProgressPhase(
    compactionState?.phase,
  )
    ? compactionState.phase
    : null;

  messages.forEach((message, messageIndex) => {
    items.push({
      kind: 'message',
      key: `message:${message.id}`,
      message,
      messageIndex,
    });

    if (shouldInsertBoundary && messageIndex === boundaryIndex) {
      items.push({
        kind: 'compaction_boundary',
        key: `compaction-boundary:${message.id}`,
        afterMessageId: message.id,
        updatedAt: compactionState?.updatedAt ?? undefined,
      });
    }
  });

  if (progressPhase) {
    items.push({
      kind: 'compaction_progress',
      key: `compaction-progress:${compactionState?.conversationId ?? 'active'}`,
      phase: progressPhase,
      updatedAt: compactionState?.updatedAt ?? undefined,
    });
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
