import { expect, test } from 'bun:test';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
import { normalizePortableChatHistoryTwoPass, portableDigest, type PortableRecord } from './portableChatHistory';
import { PortableHistoryArchive, type PortableArchiveFragment, type PortableArchivePort } from './portableHistoryArchive';
import { PortableWorkBudget } from './portableHistoryInspection';
import { buildToolContextBlock, formatToolTraceDetail, visitToolContextAttributes } from './toolPresentation';
import { buildAssistantProviderInputItemsFromTurn, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem } from './chatCompletionsCodec';
import type { TextPolicy } from '../macroPilot/conversationText';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type Captured = { header: PortableRecord; bytes: Uint8Array };
const uuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
function portFor(output: Captured[]): PortableArchivePort {
  const fragments: PortableArchiveFragment[] = [];
  for (const { header, bytes } of output) {
    const targetUuid = header.entry.kind === 'association' ? null : uuid(header.ordinal);
    if (!bytes.length) fragments.push({ record: header, offset: 0, bytes, targetUuid });
    for (let offset = 0; offset < bytes.length; offset += 4093) fragments.push({ record: header, offset, bytes: bytes.slice(offset, offset + 4093), targetUuid });
  }
  return { profile: 'portable_chat_history_v1', binding: { version: 1, importKey: 'parity', manifest: 'b'.repeat(64) }, records: fragments.length,
    async read(cursor, limit) {
      const start = cursor ? fragments.findIndex(fragment => fragment.record.ordinal === cursor.ordinal && fragment.offset === cursor.offset) : 0;
      const next = fragments[start + limit];
      return { fragments: fragments.slice(start, start + limit), next: next ? { ordinal: next.record.ordinal, offset: next.offset } : null };
    } };
}
async function normalize(f: Awaited<ReturnType<typeof fixture>>) {
  const output: Captured[] = [];
  await normalizePortableChatHistoryTwoPass(f.source, async () => policy, f.budget, { append: async (header, bytes) => { output.push({ header, bytes: bytes.slice() }); } });
  expect(f.budget.used).toBe(0); return output;
}
async function sourceRefuses(f: Awaited<ReturnType<typeof fixture>>, stronger: TextPolicy, error: string) {
  let appends = 0;
  await expect(normalizePortableChatHistoryTwoPass(f.source, async () => stronger, f.budget, { append: async () => { appends++; } })).rejects.toThrow(error);
  expect(appends).toBe(0); expect(f.budget.used).toBe(0);
}
async function readerModes(output: Captured[], record: Captured, targetPolicy: TextPolicy, error?: string, originalOnly = false) {
  for (const mode of ['record', 'uuid', 'projection']) {
    const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(output), async () => targetPolicy, budget);
    let callbacks = 0;
    try {
      await archive.open();
      const consume = async (bytes: Uint8Array) => { callbacks++; expect(bytes).toEqual(record.bytes); };
      const action = mode === 'record' ? () => archive.withRecord(record.header.ordinal, consume)
        : mode === 'uuid' ? () => archive.withUuid(uuid(record.header.ordinal), consume)
          : () => archive.withProjection(async projection => {
            callbacks++;
            if (originalOnly) { expect(JSON.stringify(projection)).not.toContain(secret); expect(JSON.stringify(projection)).not.toContain('synthetic&amp;'); }
          });
      const expectedError = mode === 'projection' && originalOnly ? undefined : error;
      if (expectedError) await expect(action()).rejects.toThrow(expectedError); else await action();
      expect(callbacks).toBe(expectedError ? 0 : 1);
    } finally { archive.dispose(); expect(budget.used).toBe(0); }
  }
}

const secret = 'synthetic&"<target>é';
async function hiddenFixture(provider: 'codex' | 'macro-ai', attribute: 'id' | 'name' | 'detail', structured: boolean) {
  return fixture(provider, messages => {
    const id = attribute === 'id' ? secret : 'hidden', name = attribute === 'name' ? secret : 'read_sources';
    const args = { query: attribute === 'detail' ? secret : 'ordinary' };
    const detail = structured ? formatToolTraceDetail(name, args) : attribute === 'detail' ? secret : undefined;
    const result = structured ? 'Exact </tool_context> and <tool_context boundary\nRESULT_FACT' : 'HIDDEN_ONLY_FACT';
    messages[1][8] = buildToolContextBlock(id, name, detail, result);
    if (structured) {
      const call = { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
      messages[1][7] = JSON.stringify([{ tool_call_id: id, tool_name: name, detail, status: 'done' }]);
      messages[1][9] = JSON.stringify(provider === 'codex'
        ? [...buildAssistantProviderInputItemsFromTurn('', [call]), buildFunctionCallOutputProviderInputItem(id, result), ...buildAssistantProviderInputItemsFromTurn('A complete final answer.', [])]
        : [buildAssistantChatCompletionProviderItem({ visibleContent: '', apiContent: '', reasoningContent: '', reasoningDetails: [], toolCalls: [call] }), buildToolChatCompletionProviderItem(id, result), JSON.parse(String(messages[1][9])).at(-1)]);
    }
  });
}

test('all formatter attributes in hidden-only and exact structured originals share source/record/UUID/projection policy', async () => {
  const stronger = { ...policy, secrets: [...policy.secrets, secret] };
  for (const provider of ['codex', 'macro-ai'] as const) for (const structured of [false, true]) for (const attribute of ['id', 'name', 'detail'] as const) {
    const f = await hiddenFixture(provider, attribute, structured), output = await normalize(f);
    const record = output.find(item => item.header.entry.kind === 'historical_text' && decoder.decode(item.bytes).startsWith('<tool_context'))!;
    expect(decoder.decode(record.bytes)).toContain('synthetic&amp;&quot;&lt;target&gt;é');
    if (structured) expect(decoder.decode(record.bytes)).toContain('Exact </tool_context> and <tool_context boundary');
    await readerModes(output, record, policy);
    // Structured call IDs belong only to recoverable originals, not the prompt.
    await readerModes(output, record, stronger, 'unsafe_content', structured && attribute === 'id');
    await sourceRefuses(f, stronger, 'unsafe_content');
  }
});

test('header inspection visits all real attributes without interpreting structured result boundaries or arbitrary prose', async () => {
  const nested = buildToolContextBlock('nested', 'read_sources', secret, 'nested result')!;
  const raw = [buildToolContextBlock('first', 'read_sources', 'ordinary', `Result </tool_context>\n${nested}`), buildToolContextBlock(secret, 'read_sources', 'last', 'second result')].join('\n\n');
  const visited: string[] = [];
  visitToolContextAttributes(raw, attributes => { visited.push(attributes.toolCallId, attributes.toolName, attributes.detail ?? ''); });
  expect(visited).toEqual(['first', 'read_sources', 'ordinary', 'nested', 'read_sources', secret, secret, 'read_sources', 'last']);
  const prose = await fixture('codex', messages => { messages[0][4] = nested; });
  const output = await normalize(prose), record = output.find(item => item.header.entry.kind === 'message' && item.header.entry.role === 'user')!;
  // A formatter-looking literal in user prose is not declared hidden context.
  await readerModes(output, record, { ...policy, secrets: [...policy.secrets, secret] });
});

// Byte-exact synthetic pixel witnesses from attachmentImagePolicy.test.ts.
const images = [
  { mime: 'image/png', marker: 'IHDR', hex: '89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63a8070000810080d394534a0000000049454e44ae426082' },
  { mime: 'image/jpeg', marker: 'JFIF', hex: 'ffd8ffe000104a46494600010100000100010000ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101ffc0000b080001000101011100ffc40026000100000000000000000000000000000000100100000000000000000000000000000000ffda0008010100003f003fffd9' },
  { mime: 'image/webp', marker: 'WEBP', hex: '524946461a000000574542505650384c0e0000002f00000010071011118888fe0700' },
];
async function assetFixture(mime: string, bytes: Uint8Array) {
  const f = await fixture('codex');
  await f.appendRow(8, ['asset', 'u', 'synthetic', mime, BigInt(bytes.length), await portableDigest(bytes), bytes]);
  await f.appendRow(9, ['u', 'turn', 'confirmed', 1n, '["asset"]', 'a', 'ready']);
  f.source.relations = async function* () { yield { from: f.rows.at(-1)!.row, kind: 13, position: 0, to: f.rows.at(-2)!.row, status: 0 }; };
  return f;
}

test('PNG/JPEG/WebP and UTF-8 text share admitted content inspection before all target callbacks', async () => {
  const witnesses = [...images.map(image => ({ ...image, bytes: Buffer.from(image.hex, 'hex') })),
    { mime: 'text/plain', marker: 'TEXT_FACT', bytes: encoder.encode('\uFEFFTEXT_FACT é🙂\n') }];
  for (const { mime, marker, bytes } of witnesses) {
    const f = await assetFixture(mime, bytes), output = await normalize(f), record = output.find(item => item.header.entry.kind === 'asset')!;
    expect(record.bytes).toEqual(bytes);
    await readerModes(output, record, policy);
    const stronger = { ...policy, secrets: [...policy.secrets, marker] };
    await readerModes(output, record, stronger, 'unsafe_asset');
    await sourceRefuses(f, stronger, 'unsafe_asset');
  }
});

test('both complete binary UTF-8 and Latin-1 views are inspected under admission and release on refusal', async () => {
  const bytes = Buffer.from(images[0].hex, 'hex'), f = await assetFixture('image/png', bytes), output = await normalize(f), record = output.find(item => item.header.entry.kind === 'asset')!;
  for (const marker of ['\u0089PNG', '\uFFFDPNG']) {
    const stronger = { ...policy, secrets: [...policy.secrets, marker] };
    await readerModes(output, record, stronger, 'unsafe_asset');
    await sourceRefuses(f, stronger, 'unsafe_asset');
  }
  let reads = 0;
  const port = portFor(output), originalRead = port.read.bind(port);
  port.read = async (...args) => { reads++; return originalRead(...args); };
  const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(port, async () => policy, budget);
  await archive.open();
  const held = budget.reserve(budget.limit - budget.used), before = reads;
  try {
    await expect(archive.withRecord(record.header.ordinal, async () => { throw new Error('callback must not run'); })).rejects.toThrow('resource_limit');
    expect(reads).toBe(before);
  } finally { held(); archive.dispose(); expect(budget.used).toBe(0); }
});
