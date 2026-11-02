import { describe, expect, it } from 'bun:test';
import { ConsumerReader } from './consumerReader';
import { ConsumerConnections } from './consumerConnections';
import { connectReaderLimits, connectReaderRetry } from '../../composition/macroConnectConsumer';
import { createConnectConsumerFixture } from '../../../dev/fixtures/connectConsumer';
import { PilotClientError } from './clientError';
import { validateExchange, type ContentConversationCard } from './contentProtocol';
const until = async (check: () => boolean, diagnostic?: () => unknown) => { const end = Date.now() + 5000; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2)); if (!check() && diagnostic) console.error('Reader fixture timeout', JSON.stringify(diagnostic())); expect(check()).toBe(true); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const card = (reader: ConsumerReader, index = 0) => reader.getSnapshot().panels[index].catalog.page!.response.result.items[0] as ContentConversationCard;
async function setup(two = false) {
  const h = createConnectConsumerFixture(), reader = new ConsumerReader(h.ports); reader.start();
  await until(() => reader.getSnapshot().phase === 'ready'); reader.open('instance:alpha'); if (two) reader.open('instance:beta');
  try {
    await until(() => reader.getSnapshot().panels.every(p => Boolean(p.catalog.page)) || reader.getSnapshot().panels.some(p => Boolean(p.error || p.catalog.error)));
    expect(reader.getSnapshot().panels.map(p => ({ error: p.error, row: p.catalog.error, ready: Boolean(p.catalog.page) }))).toEqual(reader.getSnapshot().panels.map(() => ({ error: null, row: null, ready: true })));
  } catch (error) { reader.dispose(); throw error; }
  return { h, reader };
}
describe('dialog-owned Connect reader', () => {
  it('opens only chosen PCs, filters Chat before pagination and qualifies equal IDs', async () => {
    const { h, reader } = await setup(true);
    try {
      expect(h.owner()!.diagnostics()).toMatchObject({ targets: 2, subscribers: 2 });
      const panels = reader.getSnapshot().panels; expect(panels[0].key).not.toBe(panels[1].key); expect(card(reader).ref.conversation_id).toBe(card(reader, 1).ref.conversation_id);
      for (const p of panels) reader.select(p.key, card(reader, p.instanceId === 'instance:alpha' ? 0 : 1).ref);
      await until(() => reader.getSnapshot().panels.every(p => Boolean(p.detail.page)));
      expect(h.owner()!.diagnostics().subscribers).toBe(4);
      for (const p of reader.getSnapshot().panels) expect(p.detail.page!.response.result.items[0]).toMatchObject({ text: expect.stringContaining(p.instanceId) });
      expect(h.calls.filter(c => c.dispatch.kind === 'submit' && c.dispatch.request.operation === 'conversations.catalog').every(c => 'body' in c.dispatch.request && 'filter' in c.dispatch.request.body && c.dispatch.request.body.filter?.mode === 'Chat')).toBe(true);
      expect(() => reader.open('instance:local')).toThrow(PilotClientError);
    } finally { reader.dispose(); }
  });
  it('replaces pages without retaining their payloads and advertises the explicit cap and anchored capture', async () => {
    const { reader } = await setup();
    try {
      const key = reader.getSnapshot().panels[0].key;
      for (let i = 1; i < 10; i++) { reader.next(key, 'catalog'); await until(() => !reader.getSnapshot().panels[0].catalog.busy); }
      let p = reader.getSnapshot().panels[0]; expect(p.catalog.limited).toBe(true); expect(p.catalog.page!.response.result.page.offset).toBe(450); expect(p.catalog.page!.response.result.page.total).toBe(600);
      reader.next(key, 'catalog'); expect(reader.getSnapshot().panels[0].catalog.page).toBe(p.catalog.page);
      reader.restart(key, 'catalog'); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page));
      reader.select(key, card(reader).ref); await until(() => Boolean(reader.getSnapshot().panels[0].detail.page));
      for (let i = 1; i < 10; i++) { reader.next(key, 'detail'); await until(() => !reader.getSnapshot().panels[0].detail.busy); }
      p = reader.getSnapshot().panels[0]; const oldSnapshot = p.detail.page!.response.result.page.snapshot_id; const ref = p.selected!.ref;
      expect(p.detail.limited).toBe(true); reader.restart(key, 'detail', true); await until(() => Boolean(reader.getSnapshot().panels[0].detail.page));
      p = reader.getSnapshot().panels[0]; expect(p.freshAnchor).toBe(true); expect(p.selected!.ref).toEqual(ref); expect(p.detail.page!.response.result.page.snapshot_id).not.toBe(oldSnapshot); expect(p.detail.page!.request.body).toMatchObject({ ref, direction: 'backward', message_id: expect.any(String) });
    } finally { reader.dispose(); }
  });
  it('keeps a healthy panel usable while a read is slow and ignores a late result after close', async () => {
    const { h, reader } = await setup(true); const gate = deferred<unknown>();
    try {
      h.read(async (id, dispatch) => id === 'instance:alpha' && dispatch.kind === 'submit' && dispatch.request.operation === 'conversation.window' ? gate.promise : h.terminal(id, dispatch));
      let p = reader.getSnapshot().panels; reader.select(p[0].key, card(reader).ref); reader.select(p[1].key, card(reader, 1).ref);
      await until(() => Boolean(reader.getSnapshot().panels[1].detail.page));
      const old = h.calls.find(c => c.id === 'instance:alpha' && c.dispatch.kind === 'submit' && c.dispatch.request.operation === 'conversation.window')!;
      reader.close(p[0].key); expect(old.signal.aborted).toBe(true); gate.resolve(h.terminal(old.id, old.dispatch));
      await until(() => h.owner()!.diagnostics().activeReads === 0); p = reader.getSnapshot().panels; expect(p).toHaveLength(1); expect(p[0].detail.page!.scope.instanceId).toBe('instance:beta');
    } finally { gate.resolve({}); reader.dispose(); }
  });
  it('purges hidden/offline data, proves again on return, and retires the whole context on account change', async () => {
    const { h, reader } = await setup(true);
    try {
      reader.setAvailable(false); expect(reader.getSnapshot()).toMatchObject({ phase: 'locked', choices: [] });
      expect(reader.getSnapshot().panels.every(p => !p.catalog.page && !p.detail.page && !p.selected && !p.label)).toBe(true);
      await until(() => h.owner()!.diagnostics().activeReads === 0); expect(h.owner()!.diagnostics()).toMatchObject({ targets: 0, subscribers: 0 });
      reader.setAvailable(true); await until(() => reader.getSnapshot().phase === 'ready' && reader.getSnapshot().panels.every(p => Boolean(p.catalog.page)), () => ({
        phase: reader.getSnapshot().phase, error: reader.getSnapshot().error,
        panels: reader.getSnapshot().panels.map(p => ({ id: p.instanceId, phase: p.phase, error: p.error, catalog: { busy: p.catalog.busy, error: p.catalog.error, page: Boolean(p.catalog.page) } })),
        owner: h.owner()?.diagnostics(), waiting: [...h.waiting.keys()], listeners: h.listeners.size,
        calls: h.calls.slice(-12).map(c => ({ id: c.id, kind: c.dispatch.kind, request: c.dispatch.request, aborted: c.signal.aborted })),
      }));
      h.changeAccount(); expect(reader.getSnapshot()).toMatchObject({ phase: 'ended', panels: [], choices: [] }); expect(h.listeners.size).toBe(0);
    } finally { reader.dispose(); }
  });
  it('keeps synthetic capture lifetime canonical when the clock advances between timestamp samples on recovery', async () => {
    const { h, reader } = await setup(true); const now = Date.now;
    try {
      h.read(async (id, dispatch) => {
        try {
          Date.now = () => now() + 7;
          const response = h.terminal(id, dispatch);
          expect(validateExchange(dispatch.request, response)).toMatchObject({ valid: true });
          expect(Date.parse(response.result.page.expires_at) - Date.parse(response.result.page.observed_at)).toBe(300_000);
          return response;
        } finally { Date.now = now; }
      });
      reader.setAvailable(false); reader.setAvailable(true);
      await until(() => reader.getSnapshot().phase === 'ready' && reader.getSnapshot().panels.every(p => Boolean(p.catalog.page) || Boolean(p.error || p.catalog.error)));
      expect(reader.getSnapshot().panels.map(p => ({ ready: Boolean(p.catalog.page), error: p.error, row: p.catalog.error }))).toEqual([
        { ready: true, error: null, row: null }, { ready: true, error: null, row: null },
      ]);
    } finally { Date.now = now; reader.dispose(); }
  });
  it('does not publish a partial directory and ignores its late proof after disposal', async () => {
    const { h, reader } = await setup(true);
    h.directoryRead(async request => request.item_type === 'instance' ? h.directory(request) : { malformed: true });
    await reader.refresh(); expect(reader.getSnapshot().phase).toBe('error'); expect(reader.getSnapshot().choices).toHaveLength(0); expect(reader.getSnapshot().panels.every(p => !p.catalog.page && !p.selected)).toBe(true);
    h.directoryRead(async request => h.directory(request)); await reader.refresh();
    await until(() => reader.getSnapshot().phase === 'ready' && reader.getSnapshot().panels.every(p => Boolean(p.catalog.page)));
    const gate = deferred<unknown>(); h.directoryRead(async () => gate.promise); const pending = reader.refresh(); reader.dispose(); gate.resolve({}); await pending; expect(reader.getSnapshot().phase).toBe('ended');
  });
  it.each([false, true])('ends stale context during public proof, including after verify awaits: %s', async afterWait => {
    const h = createConnectConsumerFixture(), gate = deferred<void>(); let stale = false, hold = false, entered = false;
    const context = () => { if (stale) throw new PilotClientError('context_changed'); return h.ports.context(); };
    let owner: ConsumerConnections | undefined;
    const reader = new ConsumerReader({ ...h.ports, context, createOwner: () => owner = new ConsumerConnections({ ...h.transport, context }, {
      context, verify: async () => { if (hold) { entered = true; await gate.promise; } }, query: async (_context, request) => h.directory(request),
    }, connectReaderLimits, connectReaderRetry) });
    try {
      reader.start(); await until(() => reader.getSnapshot().phase === 'ready'); reader.open('instance:alpha'); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page));
      hold = afterWait; stale = !afterWait; const proof = reader.refresh();
      if (afterWait) { await until(() => entered); stale = true; gate.resolve(); }
      await proof; expect(reader.getSnapshot()).toMatchObject({ phase: 'ended', panels: [], choices: [] });
      expect(owner!.diagnostics()).toMatchObject({ targets: 0, subscribers: 0 }); expect(h.listeners.size).toBe(0);
    } finally { gate.resolve(); reader.dispose(); }
  });
  it('applies tombstone/reset, confines refusal to its target and purges selection on filter change', async () => {
    const { h, reader } = await setup(true);
    try {
      const p = reader.getSnapshot().panels[0], ref = card(reader).ref; reader.select(p.key, ref); await until(() => Boolean(reader.getSnapshot().panels[0].detail.page));
      h.emit('instance:alpha', [{ kind: 'conversation.removed', scope: ref, revision: 2 }]); await until(() => reader.getSnapshot().panels[0].selected === null);
      expect(reader.getSnapshot().panels[1].catalog.page).not.toBeNull(); await until(() => h.waiting.has('instance:alpha'));
      const generation = reader.getSnapshot().panels[0].catalog.page?.scope.generation; h.emit('instance:alpha', [], true); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page) && reader.getSnapshot().panels[0].catalog.page!.scope.generation !== generation);
      reader.select(p.key, card(reader).ref); await until(() => Boolean(reader.getSnapshot().panels[0].detail.page));
      reader.filter(p.key, true); expect(reader.getSnapshot().panels[0].selected).toBeNull(); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page));
      expect((reader.getSnapshot().panels[0].catalog.page!.response.result.items[0] as ContentConversationCard).archived).toBe(true);
      h.read(async (id, dispatch) => { if (id === 'instance:alpha') throw new PilotClientError('forbidden'); return h.terminal(id, dispatch); });
      reader.restart(p.key, 'catalog'); await until(() => reader.getSnapshot().panels[0].error === 'forbidden'); expect(reader.getSnapshot().panels[0].selected).toBeNull(); expect(reader.getSnapshot().panels[1].catalog.page).not.toBeNull();
    } finally { reader.dispose(); }
  });
  it('rejects non-Chat cards and refuses an unsupported capability without a legacy fallback', async () => {
    const h = createConnectConsumerFixture(), reader = new ConsumerReader(h.ports);
    h.capabilities(['network-reliability-1']); reader.start(); await until(() => reader.getSnapshot().phase === 'ready'); reader.open('instance:alpha');
    await until(() => reader.getSnapshot().panels[0].error === 'extension_unavailable');
    expect(h.calls.filter(call => call.dispatch.kind === 'submit')).toHaveLength(0); reader.dispose();
    const other = await setup();
    try {
      other.h.read(async (id, dispatch) => { const response = other.h.terminal(id, dispatch); response.result.items[0] = { ...response.result.items[0], mode: 'Architect' } as typeof response.result.items[number]; return response; });
      other.reader.restart(other.reader.getSnapshot().panels[0].key, 'catalog');
      await until(() => other.reader.getSnapshot().panels[0].catalog.error === 'invalid_response');
      expect(other.reader.getSnapshot().panels[0].catalog.page).toBeNull();
    } finally { other.reader.dispose(); }
  });
  it('fences a late active-filter response when the archived query replaces it', async () => {
    const { h, reader } = await setup(); const gate = deferred<unknown>();
    try {
      const key = reader.getSnapshot().panels[0].key;
      h.read(async (id, dispatch) => dispatch.kind === 'submit' && dispatch.request.operation === 'conversations.catalog' && dispatch.request.body.filter?.archived === 'active' ? gate.promise : h.terminal(id, dispatch));
      const count = h.calls.length; reader.restart(key, 'catalog'); await until(() => h.calls.length > count);
      const sent = h.calls.at(-1)!; reader.filter(key, true);
      await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page)); expect(sent.signal.aborted).toBe(true);
      gate.resolve(h.terminal(sent.id, sent.dispatch)); await new Promise(done => setTimeout(done, 5));
      expect((reader.getSnapshot().panels[0].catalog.page!.response.result.items[0] as ContentConversationCard).archived).toBe(true);
    } finally { gate.resolve({}); reader.dispose(); }
  });
  it('removes an expired capture rather than treating its lifetime as authority', async () => {
    const { h, reader } = await setup();
    try {
      h.read(async (id, dispatch) => { const response = h.terminal(id, dispatch); response.result.page.expires_at = new Date(Date.now() + 100).toISOString(); return response; });
      const key = reader.getSnapshot().panels[0].key; reader.restart(key, 'catalog'); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page));
      await until(() => reader.getSnapshot().panels[0].catalog.error === 'snapshot_expired');
      expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(h.owner()!.diagnostics().desiredReads).toBe(0);
    } finally { reader.dispose(); }
  });

  it('retires directory metadata on account.deleted even when the native session proof is valid', async () => {
    const { h, reader } = await setup(true);
    try {
      h.emit('instance:alpha', [{ kind: 'account.deleted', scope: { account_id: h.ports.context().accountId }, revision: 1 }]);
      await until(() => reader.getSnapshot().panels.every(p => p.phase === 'error'));
      expect(reader.getSnapshot().choices).toHaveLength(0); expect(reader.getSnapshot().panels.every(p => !p.catalog.page && !p.detail.page && !p.label)).toBe(true);
      expect(h.ports.context().accountId).toBe('account:synthetic');
    } finally { reader.dispose(); }
  });
  it('reads forward without announcing history when the producer omitted that capability', async () => {
    const h = createConnectConsumerFixture(), reader = new ConsumerReader(h.ports); h.capabilities(['conversations-1', 'network-reliability-1']); reader.start();
    try {
      await until(() => reader.getSnapshot().phase === 'ready'); reader.open('instance:alpha'); await until(() => Boolean(reader.getSnapshot().panels[0].catalog.page));
      const key = reader.getSnapshot().panels[0].key; reader.select(key, card(reader).ref); await until(() => Boolean(reader.getSnapshot().panels[0].detail.page));
      expect(reader.getSnapshot().panels[0].history).toBe(false); expect(reader.getSnapshot().panels[0].detail.page!.request.body).not.toHaveProperty('direction'); expect(reader.getSnapshot().panels[0].detail.page!.response.result.page.offset).toBe(0);
    } finally { reader.dispose(); }
  });

});
