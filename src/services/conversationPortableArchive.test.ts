import { expect, mock, test } from 'bun:test';

const released: string[] = [];
let openReply = async (input: { conversationId: string }) => ({
  readId: `read-${input.conversationId}`, conversationId: input.conversationId, generation: 'generation', manifest: 'manifest',
});
let pageReply = async () => ({ pageId: 'page', items: [], nextCursorId: null });
mock.module('./ipc/connectArchive', () => ({
  connectArchiveOpen: (input: { conversationId: string }) => openReply(input),
  connectArchivePage: () => pageReply(),
  connectArchiveMaterialize: async () => ({ backingId: 'image', readyDataUrl: 'data:image/png;base64,AA==' }),
  connectArchiveRelease: async ({ id }: { id: string }) => { released.push(id); },
}));
const { ArchiveReaderSession, retireArchiveReaders, activateArchiveReaders } = await import('./conversationPortableArchive');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const input = (conversationId: string) => ({ conversationId, selector: { kind: 'records' as const, ordinal: null, uuid: null } });

test('local archive backings outlive registry consumers and retirement joins late IPC replies', async () => {
  const session = await ArchiveReaderSession.open(input('first'));
  const page = await session.page(null);
  const consumer = page.retain();
  let retired = false;
  const retirement = retireArchiveReaders('first').then(() => { retired = true; });
  page.release();
  await tick();
  expect(retired).toBe(false);
  expect(consumer.value.pageId).toBe('page');
  expect(released).not.toContain('page');
  consumer.release();
  await retirement;
  expect(released.filter(id => id === 'page')).toHaveLength(1);
  expect(released.filter(id => id === 'read-first')).toHaveLength(1);
  expect(() => consumer.value).toThrow();

  const late = await ArchiveReaderSession.open(input('late'));
  let finishPage!: (value: Awaited<ReturnType<typeof pageReply>>) => void;
  pageReply = () => new Promise(resolve => { finishPage = resolve; });
  const pending = late.page(null);
  const rejected = pending.then(() => null, error => error);
  let joined = false;
  const close = retireArchiveReaders('late').then(() => { joined = true; });
  await tick();
  expect(joined).toBe(false);
  finishPage({ pageId: 'late-page', items: [], nextCursorId: null });
  expect(await rejected).toBeInstanceOf(Error);
  await close;
  expect(released).toContain('late-page');
  expect(released).toContain('read-late');

  let finishOpen!: (value: Awaited<ReturnType<typeof openReply>>) => void;
  openReply = () => new Promise(resolve => { finishOpen = resolve; });
  const opening = ArchiveReaderSession.open(input('opening'));
  const rejectedOpen = opening.then(() => null, error => error);
  const closingOpen = retireArchiveReaders('opening');
  finishOpen({ readId: 'late-open', conversationId: 'opening', generation: 'generation', manifest: 'manifest' });
  expect(await rejectedOpen).toBeInstanceOf(Error);
  await closingOpen;
  expect(released).toContain('late-open');

  await retireArchiveReaders();
  expect(() => ArchiveReaderSession.open(input('retired-profile'))).toThrow('stopped');
  await activateArchiveReaders();
});
