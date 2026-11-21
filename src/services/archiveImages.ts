import type { MessageImageAttachment } from '../stores/chat/chatLocalSessionState';
import type { ChatMessage } from '../types';
import { ArchiveReaderSession, type ArchiveValue } from './conversationPortableArchive';
import type { ArchiveBacking, ArchiveResource } from './ipc/connectArchive';
import type { LifecycleContext } from './lifecycleScope';
import type { ChatRequestResources } from './chatStreamContracts';

/** Each consumer releases its own reference, after its last asynchronous use. */
export function ownArchiveRequestResources(dispose: () => void): ChatRequestResources {
  let references = 0;
  let disposed = false;
  const acquire = (): ChatRequestResources => {
    if (disposed) throw new Error('archive_resources_released');
    references++;
    let released = false;
    return {
      retain: () => {
        if (released) throw new Error('archive_resources_released');
        return acquire();
      },
      release: () => {
        if (released) return;
        released = true;
        if (--references === 0) { disposed = true; dispose(); }
      },
    };
  };
  return acquire();
}

const images = new WeakMap<MessageImageAttachment, ArchiveValue<ArchiveBacking>>();

/** Keep the native decoded/encoded reservation through each application use. */
export function retainArchiveImages(values: readonly MessageImageAttachment[]): () => void {
  const held: ArchiveValue<ArchiveBacking>[] = [];
  try {
    for (const value of values) {
      const owner = images.get(value);
      if (owner) held.push(owner.retain());
    }
  } catch (error) { held.forEach(owner => owner.release()); throw error; }
  return () => { held.splice(0).forEach(owner => owner.release()); };
}

/** Called after removing the cache's references. Render/request owners persist. */
export function releaseArchiveImages(values: readonly MessageImageAttachment[]): void {
  for (const value of values) images.get(value)?.release();
}

export function isArchiveImage(value: MessageImageAttachment): boolean { return images.has(value); }
export function archiveImageConversation(value: MessageImageAttachment): string | undefined {
  return images.get(value)?.value.conversationId;
}

async function loadImage(conversationId: string, resource: ArchiveResource, timestamp: string,
  lifecycle?: LifecycleContext): Promise<MessageImageAttachment> {
  const session = await ArchiveReaderSession.open({ conversationId,
    selector: { kind: 'asset', assetId: resource.uuid } }, lifecycle);
  try {
    const owner = await session.materialize({ resourceUuid: resource.uuid, use: 'image', range: null });
    try {
      const data = owner.value;
      if (!data.complete || !data.readyDataUrl || !data.width || !data.height ||
          data.resource.sha256 !== resource.sha256 || data.resource.ordinal !== resource.ordinal) {
        throw new Error('archive_image_integrity');
      }
      lifecycle?.assertActive();
      const image: MessageImageAttachment = { id: data.resource.uuid, mimeType: data.resource.mimeType!,
        dataUrl: data.readyDataUrl, width: data.width, height: data.height, createdAt: timestamp };
      images.set(image, owner);
      return image;
    } catch (error) { owner.release(); throw error; }
  } finally { session.close(); }
}

/** Every resource page is consumed. Capacity failure is an error, never EOF. */
export async function loadArchiveMessageImages(message: ChatMessage,
  lifecycle?: LifecycleContext): Promise<MessageImageAttachment[]> {
  const session = await ArchiveReaderSession.open({ conversationId: message.conversation_id,
    selector: { kind: 'resources', messageId: message.id } }, lifecycle);
  const result: MessageImageAttachment[] = [];
  try {
    let cursor: string | null = null;
    do {
      const page = await session.page(cursor);
      try {
        for (const item of page.value.items) {
          lifecycle?.assertActive();
          if (item.kind === 'resource' && item.resource.kind === 'asset' &&
              ['image/png', 'image/jpeg', 'image/webp'].includes(item.resource.mimeType ?? '')) {
            result.push(await loadImage(message.conversation_id, item.resource, message.timestamp, lifecycle));
          }
        }
        cursor = page.value.nextCursorId;
      } finally { page.release(); }
    } while (cursor !== null);
    return result;
  } catch (error) { releaseArchiveImages(result); throw error; }
  finally { session.close(); }
}

/** A new preparation gets a newly admitted backing before making more copies. */
export async function prepareArchiveImages(values: Record<string, MessageImageAttachment[]>,
  lifecycle?: LifecycleContext, history: readonly ChatMessage[] = []): Promise<{ images: Record<string, MessageImageAttachment[]>; release(): void }> {
  const owned: MessageImageAttachment[] = [];
  const prepared: Record<string, MessageImageAttachment[]> = {};
  try {
    const archived = new Set<string>();
    // Cache eviction/restart cannot omit historical images from preparation.
    // Read each native resource selection anew, with fresh admission.
    for (const message of history) if (message.portable_history) {
      const attachments = await loadArchiveMessageImages(message, lifecycle);
      owned.push(...attachments);
      prepared[message.id] = attachments;
      archived.add(message.id);
    }
    for (const [message, attachments] of Object.entries(values)) {
      if (archived.has(message)) continue;
      prepared[message] = [];
      for (const attachment of attachments) {
        const original = images.get(attachment);
        if (!original) { prepared[message]!.push(attachment); continue; }
        const identity = original.value;
        const image = await loadImage(identity.conversationId, identity.resource, attachment.createdAt, lifecycle);
        owned.push(image);
        prepared[message]!.push(image);
      }
    }
    return { images: prepared, release: () => { releaseArchiveImages(owned.splice(0)); } };
  } catch (error) { releaseArchiveImages(owned); throw error; }
}
