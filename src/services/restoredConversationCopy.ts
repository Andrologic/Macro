import type { MessageImageAttachment } from '../stores/chat/chatLocalSessionState';
import type { ChatMessage } from '../types';

/** Where a source message's images are read, as the chat store hydrates them. */
export interface RestoredCopyImagePorts {
  cached: (messageId: string) => MessageImageAttachment[] | undefined;
  pilot: (messageId: string) => Promise<MessageImageAttachment[]>;
  /** Archive images are owned: the caller releases them once copied. */
  archive: (message: ChatMessage) => Promise<MessageImageAttachment[]>;
  release: (images: readonly MessageImageAttachment[]) => void;
}

/**
 * Reads each source message's images and returns plain copies keyed by the
 * copied message ID. A copy never shares an archive owner with its source,
 * and an image that cannot be copied fails the whole copy.
 */
export async function copyRestoredImages(
  messages: readonly ChatMessage[],
  copies: ReadonlyArray<readonly [string, string]>,
  ports: RestoredCopyImagePorts,
): Promise<Record<string, MessageImageAttachment[]>> {
  const byId = new Map(messages.map(message => [message.id, message]));
  const result: Record<string, MessageImageAttachment[]> = {};
  for (const [source, copy] of copies) {
    const message = byId.get(source);
    if (!message) throw new Error('restored_copy_message_missing');
    let images = ports.cached(source);
    if (!images) {
      if (message.portable_history) {
        const owned = await ports.archive(message);
        try { images = owned.map(image => plain(image)); } finally { ports.release(owned); }
      } else if (message.role === 'user') {
        images = await ports.pilot(source);
      } else {
        images = [];
      }
    }
    if (images.length) result[copy] = images.map(image => plain(image));
  }
  return result;
}

function plain(image: MessageImageAttachment): MessageImageAttachment {
  if (!image.dataUrl.startsWith('data:')) throw new Error('restored_copy_image_unavailable');
  return { ...image };
}
