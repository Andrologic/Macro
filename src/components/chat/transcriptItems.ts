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

export type ChatTranscriptItem =
  | ChatTranscriptMessageItem
  | ChatTranscriptCompactionBoundaryItem;

export const buildChatTranscriptItems = (
  messages: ChatMessage[],
  compactionBoundary?: {
    upToMessageId?: string | null;
    updatedAt?: string | null;
  } | null,
): ChatTranscriptItem[] => {
  const items: ChatTranscriptItem[] = [];
  const boundaryMessageId = compactionBoundary?.upToMessageId || null;
  const boundaryIndex = boundaryMessageId
    ? messages.findIndex((message) => message.id === boundaryMessageId)
    : -1;
  const shouldInsertBoundary =
    boundaryIndex >= 0 && boundaryIndex < messages.length - 1;

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
        updatedAt: compactionBoundary?.updatedAt ?? undefined,
      });
    }
  });

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
