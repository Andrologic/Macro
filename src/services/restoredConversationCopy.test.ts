import { expect, it, mock } from 'bun:test';
import type { MessageImageAttachment } from '../stores/chat/chatLocalSessionState';
import type { ChatMessage } from '../types';
import { copyRestoredImages, type RestoredCopyImagePorts } from './restoredConversationCopy';

const image = (id: string, dataUrl = 'data:image/png;base64,YQ=='): MessageImageAttachment =>
  ({ id, mimeType: 'image/png', dataUrl, createdAt: 't' });
const message = (id: string, role: ChatMessage['role'], portable = false) => ({
  id, role, conversation_id: 'source', content: '', timestamp: 't',
  ...(portable ? { portable_history: { version: 1 } } : {}),
}) as ChatMessage;

it('copies each source image from its own path into plain images of the copy', async () => {
  const cached = image('cached');
  const archived = image('archived');
  const release = mock(() => undefined);
  const ports: RestoredCopyImagePorts = {
    cached: id => (id === 'browser' ? [cached] : undefined),
    pilot: async id => (id === 'sent' ? [image('pilot')] : []),
    archive: async () => [archived],
    release,
  };
  const copied = await copyRestoredImages(
    [message('browser', 'user'), message('sent', 'user'), message('imported', 'user', true),
      message('answer', 'assistant'), message('plain', 'user')],
    [['browser', 'b'], ['sent', 's'], ['imported', 'i'], ['answer', 'a'], ['plain', 'p']],
    ports,
  );
  expect(Object.keys(copied).sort()).toEqual(['b', 'i', 's']);
  expect(copied.b).toEqual([cached]);
  expect(copied.s.map(item => item.id)).toEqual(['pilot']);
  // The copy never shares the archive owner of its source.
  expect(copied.i).toEqual([archived]);
  expect(copied.i[0]).not.toBe(archived);
  expect(release).toHaveBeenCalledWith([archived]);
});

it('fails the copy rather than lose an image', async () => {
  const ports: RestoredCopyImagePorts = {
    cached: () => [image('remote', 'blob:native')],
    pilot: async () => [],
    archive: async () => [],
    release: () => undefined,
  };
  await expect(copyRestoredImages([message('m', 'user')], [['m', 'c']], ports))
    .rejects.toThrow('restored_copy_image_unavailable');
  await expect(copyRestoredImages([], [['m', 'c']], ports))
    .rejects.toThrow('restored_copy_message_missing');
});
