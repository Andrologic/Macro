import { expect, test } from 'bun:test';
import { portableDigest } from './portableChatHistory';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
import { PortableHistoryArchive, type PortableArchivePort, type PortableArchiveFragment } from './portableHistoryArchive';
import { PortableWorkBudget } from './portableHistoryInspection';
import { estimateConversationFootprint, buildCompactedMessagesForRequest, buildMessagesWithCompactionState, validateCompactionState } from '../contextCompaction';
import type { ChatMessage } from '../../types';

async function archiveFixture(input?: Awaited<ReturnType<typeof fixture>>) {
  const f = input ?? await fixture('codex'); await f.run();
  const fragments: PortableArchiveFragment[] = [];
  for (const { header, text } of f.output) {
    const bytes = new TextEncoder().encode(text), targetUuid = header.entry.kind === 'association' ? null : `00000000-0000-4000-8000-${String(header.ordinal).padStart(12, '0')}`;
    if (!bytes.length) fragments.push({ record: header, offset: 0, bytes, targetUuid });
    for (let offset = 0; offset < bytes.length; offset += 4093) fragments.push({ record: header, offset, bytes: bytes.slice(offset, offset + 4093), targetUuid });
  }
  const port: PortableArchivePort = { profile: 'portable_chat_history_v1', binding: { version: 1, importKey: 'test-import', manifest: 'b'.repeat(64) }, records: f.output.length,
    async read(cursor, limit) {
      const start = cursor ? fragments.findIndex(f => f.record.ordinal === cursor.ordinal && f.offset === cursor.offset) : 0;
      if (start < 0) throw new Error('invalid_cursor');
      const page = fragments.slice(start, start + limit), after = fragments[start + page.length];
      return { fragments: page, next: after ? { ordinal: after.record.ordinal, offset: after.offset } : null };
    } };
  const budget = new PortableWorkBudget(128 * 1024 * 1024);
  const archive = new PortableHistoryArchive(port, async () => policy, budget);
  return { archive, fragments, budget, f, port };
}

test('target-owned projection reads all dependencies and reflection remains recoverable data', async () => {
  const { archive, f, budget } = await archiveFixture(); await archive.open();
  const reflection = f.output.find(v => v.text === f.reflection)!.header.ordinal;
  await archive.withRecord(reflection, async bytes => { expect(new TextDecoder().decode(bytes)).toBe(f.reflection); });
  await archive.withProjection(async projection => {
    expect(JSON.stringify(projection.messages)).toContain('PROVIDER_ONLY_FACT');
    expect(JSON.stringify(projection.messages)).toContain('HIDDEN_ONLY_FACT');
    const ordered = [...projection.messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const providerIndex = ordered.findIndex(message => message.content.includes('PROVIDER_ONLY_FACT'));
    const hiddenIndex = ordered.findIndex(message => message.content.includes('HIDDEN_ONLY_FACT'));
    expect(providerIndex).toBeGreaterThan(-1); expect(hiddenIndex).toBeGreaterThan(providerIndex);
    expect(ordered.map(message => message.id)).toEqual(projection.messages.map(message => message.id));
    expect(projection.messages.map(message => message.portable_history!.ordinal)).toEqual(projection.messages.map((_, index) => String(index)));
    expect(projection.messages.some(message => message.portable_history!.displayDate === '001')).toBe(true);
    expect(projection.citations[0].content).toBe('CITATION_FACT');
    expect(projection.citations[0].type).toBe('document'); expect(projection.citations[0].scope).toBe('context');
    expect(projection.messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(projection.messages.every(m => !m.provider_input_items && !m.provider_turn_state && !m.context_refs)).toBe(true);
  });
  archive.dispose(); expect(budget.used).toBe(0);
});

test('corrupt fact and incomplete page refuse before a projection can be consumed', async () => {
  for (const mode of ['corrupt', 'page'] as const) {
    const { archive, fragments, port, budget } = await archiveFixture(); await archive.open();
    const fact = fragments.find(f => new TextDecoder().decode(f.bytes) === 'PROVIDER_ONLY_FACT')!;
    if (mode === 'corrupt') fact.bytes[0] ^= 1;
    else { const read = port.read.bind(port); port.read = async (cursor, limit) => { const page = await read(cursor, limit); return cursor?.ordinal === fact.record.ordinal ? { ...page, fragments: page.fragments.slice(0, 0), next: null } : page; }; }
    let consumed = false;
    await expect(archive.withProjection(async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false); archive.dispose(); expect(budget.used).toBe(0);
  }
});

test('imported compaction keeps summaries in user data over reuse and refuses erased provenance', async () => {
  const binding = { version: 1 as const, importKey: 'archive', manifest: 'a'.repeat(64) };
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, task_id: '', conversation_id: 'archive', role: 'user', content: `History ${i}: ${'facts '.repeat(400)}`, timestamp: String(i), portable_history: binding }));
  let summaries = 0;
  const media = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } };
  const prepared = messages.map(m => ({ role: m.role, content: m.content })) as import('../streamingChat').StreamMessage[];
  prepared[0] = { role: 'user', content: [{ type: 'text', text: messages[0].content }, media] };
  const params = { systemMessage: 'Local trusted instructions', preparedMessages: prepared, orderedMessages: messages, citations: [], toolDefinitions: [], modelContextWindowTokens: 8000, mode: 'manual' as const, forceCompaction: true, generateSummary: async () => { summaries++; return 'IMPORTED_SUMMARY_ONLY'; } };
  const result = await buildCompactedMessagesForRequest(params);
  expect(result.compactionState).not.toBeNull(); expect(summaries).toBeGreaterThan(0);
  const state = result.compactionState!;
  expect(validateCompactionState(state, messages, params)).toBe(true);
  for (const prepared of [result.messages, buildMessagesWithCompactionState(params.systemMessage, params.preparedMessages, messages, [], state)]) {
    expect(prepared.filter(m => m.role === 'system').map(m => String(m.content)).join('\n')).not.toContain('IMPORTED_SUMMARY_ONLY');
    expect(prepared.some(m => m.role === 'user' && String(m.content).includes('IMPORTED_SUMMARY_ONLY'))).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain('authoritative prior context');
    expect(JSON.stringify(prepared)).toContain(media.image_url.url);
    expect(prepared.filter(m => m.role === 'system').map(m => String(m.content)).join('')).not.toContain(media.image_url.url);
  }
  expect(() => buildMessagesWithCompactionState(params.systemMessage, params.preparedMessages, messages.map(({ portable_history: _omitted, ...m }) => m), [], state)).toThrow('portable_provenance_missing');
  const second = await buildCompactedMessagesForRequest({ ...params, mode: 'blocking', forceCompaction: false, currentCompactionState: state });
  expect(second.usedExistingCompaction).toBe(true);
  expect(second.messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n')).not.toContain('IMPORTED_SUMMARY_ONLY');
});

test('persisted attachment positions override record and remapped UUID order', async () => {
  const f = await fixture('codex'), rows: number[] = [];
  for (const [id, text] of [['a-second', 'ORDER_SECOND'], ['z-first', 'ORDER_FIRST']]) {
    const bytes = new TextEncoder().encode(text); rows.push(f.rows.length);
    await f.appendRow(8, [id, 'u', `${id}.txt`, 'text/plain', BigInt(bytes.length), await portableDigest(bytes), bytes]);
  }
  const send = f.rows.length;
  await f.appendRow(9, ['u', 'turn', 'confirmed', 1n, '["z-first","a-second"]', 'a', 'ready']);
  f.source.relations = async function* () {
    yield { from: send, kind: 13, position: 0, to: rows[1], status: 0 };
    yield { from: send, kind: 13, position: 1, to: rows[0], status: 0 };
  };
  const { archive, budget } = await archiveFixture(f); await archive.open();
  try {
    await archive.withProjection(async projection => {
      const data = projection.messages.filter(message => message.content.includes('; asset]'));
      expect(data).toHaveLength(2); expect(data[0].content).toContain('ORDER_FIRST'); expect(data[1].content).toContain('ORDER_SECOND');
      expect(Date.parse(data[0].timestamp)).toBeLessThan(Date.parse(data[1].timestamp));
    });
  } finally { archive.dispose(); expect(budget.used).toBe(0); }
});

test('one footprint estimate checks portable provenance in linear metadata reads', () => {
  for (const count of [20, 40]) {
    let reads = 0;
    const binding = { version: 1 as const, importKey: 'archive', manifest: 'a'.repeat(64) };
    const messages: ChatMessage[] = Array.from({ length: count }, (_, index) => ({ id: String(index), task_id: '', conversation_id: 'archive', role: 'user', content: 'historical data', timestamp: String(index), get portable_history() { reads++; return binding; } }));
    estimateConversationFootprint({ systemMessage: 'Local instructions', preparedMessages: messages.map(message => ({ role: message.role, content: message.content })), orderedMessages: messages, citations: [], toolDefinitions: [], modelContextWindowTokens: 8000 });
    expect(reads).toBeLessThanOrEqual(count * 3);
  }
});
