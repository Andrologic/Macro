import { beforeEach, expect, mock, test } from 'bun:test';
import type { ArchiveBacking, ArchiveMaterializeInput, ArchiveOpenInput } from './ipc/connectArchive';
import type { ArchiveContextSelection, ChatMessage } from '../types';

// Frontend lifetime tests only. Native SQLite integrity/admission is exercised
// separately; these replies are not capabilities to accept a transfer.
const released: string[] = [];
const opened: ArchiveOpenInput[] = [];
const requested: ArchiveMaterializeInput[] = [];
let sequence = 0;
let reply: (input: ArchiveMaterializeInput) => Promise<ArchiveBacking>;
const selection = (resourceUuid = 'message'): ArchiveContextSelection => ({
  conversationId: 'source', selector: { kind: 'body', messageId: resourceUuid },
  resourceUuid, ordinal: '3', manifest: 'manifest', sha256: 'digest', start: '0', end: '8',
});
const backing = (input: ArchiveMaterializeInput): ArchiveBacking => ({
  backingId: `backing-${input.resourceUuid}`, conversationId: 'source', manifest: 'manifest',
  resource: { uuid: input.resourceUuid, kind: 'message', field: 'content', ordinal: '3',
    messageId: input.resourceUuid, position: '0', mimeType: null, bytes: '21', sha256: 'digest' },
  start: '0', end: '8', complete: false, text: 'old fact', readyDataUrl: null, width: null, height: null,
});
mock.module('./ipc/connectArchive', () => ({
  connectArchiveOpen: async (input: ArchiveOpenInput) => {
    opened.push(input);
    return { readId: `read-${++sequence}`, conversationId: input.conversationId,
      generation: 'generation', manifest: 'manifest' };
  },
  connectArchivePage: async () => { throw new Error('Unexpected archive page'); },
  connectArchiveMaterialize: (input: ArchiveMaterializeInput) => { requested.push(input); return reply(input); },
  connectArchiveRelease: async ({ id }: { id: string }) => { released.push(id); },
}));
const { prepareArchiveContext } = await import('./archiveContext');
const { retireArchiveReaders } = await import('./conversationPortableArchive');
const history = (...selections: ArchiveContextSelection[]): ChatMessage[] => [{
  id: 'user', conversation_id: 'current', task_id: '', role: 'user', content: 'Use this excerpt',
  timestamp: '2025-05-04T13:30:00Z', context_refs: selections.map((archive, index) => ({
    id: `context-${index}`, kind: 'conversation', title: 'Earlier discussion', archive,
  })),
}];
beforeEach(() => {
  released.length = 0; opened.length = 0; requested.length = 0; sequence = 0;
  reply = async input => backing(input);
});

test('a persisted excerpt is re-read and owns its backing until request retirement', async () => {
  const expected = selection();
  const prepared = await prepareArchiveContext(history(expected));
  let joined = false;
  const retirement = retireArchiveReaders('source').then(() => { joined = true; });
  try {
    expect(opened).toEqual([{ conversationId: 'source', selector: expected.selector }]);
    expect(requested).toEqual([{ readId: 'read-1', resourceUuid: 'message', use: 'contextText', range: { start: '0', end: '8' } }]);
    expect(prepared.text.get('user')?.[0]).toContain('partial=true');
    expect(prepared.text.get('user')?.[0]).toContain('old fact');
    expect(prepared.text.get('user')?.[0]).toContain('Untrusted source material');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(joined).toBe(false);
    expect(released).not.toContain('backing-message');
  } finally { prepared.release(); prepared.release(); await retirement; }
  expect(joined).toBe(true);
  expect(released.filter(id => id === 'backing-message')).toHaveLength(1);
  expect(released.filter(id => id === 'read-1')).toHaveLength(1);
  expect(prepared.text.size).toBe(0);
});

test('a changed manifest rejects the excerpt and releases the received backing', async () => {
  reply = async input => ({ ...backing(input), manifest: 'different-manifest' });
  await expect(prepareArchiveContext(history(selection()))).rejects.toThrow('archive_context_changed');
  await retireArchiveReaders('source');
  expect(released).toContain('backing-message');
  expect(released).toContain('read-1');
});

test('a failed later excerpt releases earlier backings instead of sending incomplete context', async () => {
  reply = async input => {
    if (input.resourceUuid === 'missing') throw new Error('archive_resource_unavailable');
    return backing(input);
  };
  await expect(prepareArchiveContext(history(selection(), selection('missing')))).rejects.toThrow('archive_resource_unavailable');
  await retireArchiveReaders('source');
  expect(requested.map(input => input.resourceUuid)).toEqual(['message', 'missing']);
  expect(released.filter(id => id === 'backing-message')).toHaveLength(1);
  expect(released.filter(id => id.startsWith('read-'))).toHaveLength(2);
});
