import { expect, mock, test } from 'bun:test';
import type { ChatMessage } from '../types';
import type { ArchiveSelector, ArchiveResource } from './ipc/connectArchive';

// Data-port fixtures only. Image validation is exercised in the native owner,
// not inferred from these already-materialized synthetic replies.
const resources: ArchiveResource[] = Array.from({ length: 12 }, (_, index) => ({
  uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  kind: 'asset', field: 'bytes', ordinal: String(index + 1), messageId: 'message',
  position: String(index), mimeType: 'image/png', bytes: '1', sha256: 'a'.repeat(64),
}));
let next = 0;
let materialized = 0;
const selectors = new Map<string, ArchiveSelector>();
const released: string[] = [];
mock.module('./ipc/connectArchive', () => ({
  connectArchiveOpen: async ({ selector }: { selector: ArchiveSelector }) => {
    const readId = `read-${next++}`; selectors.set(readId, selector);
    return { readId, conversationId: 'conversation', generation: 'generation', manifest: 'manifest' };
  },
  connectArchivePage: async ({ cursorId }: { cursorId: string | null }) => ({
    pageId: `page-${next++}`, nextCursorId: cursorId === null ? 'tail' : null,
    items: (cursorId === null ? resources.slice(0, 7) : resources.slice(7)).map(resource => ({ kind: 'resource', resource })),
  }),
  connectArchiveMaterialize: async ({ readId }: { readId: string }) => {
    const selector = selectors.get(readId);
    if (selector?.kind !== 'asset') throw new Error('wrong selection');
    materialized++;
    return { backingId: `backing-${next++}`, conversationId: 'conversation', manifest: 'manifest',
      resource: resources.find(resource => resource.uuid === selector.assetId),
      start: '0', end: '1', complete: true, text: null, readyDataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 };
  },
  connectArchiveRelease: async ({ id }: { id: string }) => { released.push(id); },
}));
const { loadArchiveMessageImages, retainArchiveImages, releaseArchiveImages, prepareArchiveImages, ownArchiveRequestResources } = await import('./archiveImages');
const { retireArchiveReaders } = await import('./conversationPortableArchive');

test('archive image hydration consumes every page, preserves position, and retains cache/render/preparation owners', async () => {
  const message = { id: 'message', conversation_id: 'conversation', timestamp: '2025-01-01' } as ChatMessage;
  const images = await loadArchiveMessageImages(message);
  expect(images.map(image => image.id)).toEqual(resources.map(resource => resource.uuid));
  expect(images).toHaveLength(12);
  expect(materialized).toBe(12);
  const unmount = retainArchiveImages(images);
  const prepared = await prepareArchiveImages({ message: images });
  expect(materialized).toBe(24);
  expect(prepared.images.message![0]).not.toBe(images[0]);
  releaseArchiveImages(images);
  prepared.release();
  let retired = false;
  const join = retireArchiveReaders('conversation').then(() => { retired = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(retired).toBe(false);
  expect(released.filter(id => id.startsWith('backing-'))).toHaveLength(12);
  unmount();
  await join;
  expect(released.filter(id => id.startsWith('backing-'))).toHaveLength(24);
  expect(new Set(released).size).toBe(released.length);
});

test('preparation reloads historical images after cache eviction and keeps independent diagnostic copies', async () => {
  const before = materialized;
  const message = { id: 'message', conversation_id: 'conversation', timestamp: '2025-01-01', portable_history: {} } as ChatMessage;
  const prepared = await prepareArchiveImages({}, undefined, [message]);
  expect(materialized - before).toBe(12);
  expect(prepared.images.message).toHaveLength(12);
  const resources = ownArchiveRequestResources(prepared.release);
  const diagnostics = resources.retain();
  const inFlightDiagnostics = diagnostics.retain();
  resources.release(); diagnostics.release();
  let retired = false;
  const join = retireArchiveReaders('conversation').then(() => { retired = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(retired).toBe(false);
  inFlightDiagnostics.release();
  await join;
  expect(retired).toBe(true);
  expect(() => resources.retain()).toThrow('released');
});
