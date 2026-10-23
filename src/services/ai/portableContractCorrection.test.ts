import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolContextBlock } from './toolPresentation';
import { buildAssistantProviderInputItemsFromTurn, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
import { normalizePortableChatHistoryTwoPass, portableDigest, type PortableRecord } from './portableChatHistory';
import { PortableWorkBudget } from './portableHistoryInspection';
import { PortableHistoryArchive, type PortableArchivePort, type PortableArchiveFragment } from './portableHistoryArchive';
import { validatePortableMetadata, validatePortableRedundancy, vocabulary, portableManifestInput } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { validatePortableRecipe, portableContractSha } from '../../test-utils/portableContractRecipe';
const encoder = new TextEncoder(), decoder = new TextDecoder();
type RecordValue = { header: PortableRecord; text: string; bytes?: Uint8Array };
const uuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
function portFor(records: RecordValue[]): PortableArchivePort {
  const fragments: PortableArchiveFragment[] = [];
  for (const { header, text, bytes: raw } of records) {
    const bytes = raw ?? encoder.encode(text), targetUuid = header.entry.kind === 'association' ? null : uuid(header.ordinal);
    if (!bytes.length) fragments.push({ record: header, offset: 0, bytes, targetUuid });
    for (let offset = 0; offset < bytes.length; offset += 4093) fragments.push({ record: header, offset, bytes: bytes.subarray(offset, offset + 4093), targetUuid });
  }
  return { profile: 'portable_chat_history_v1', binding: { version: 1, importKey: 'correction', manifest: 'b'.repeat(64) }, records: records.length,
    async read(cursor, limit) {
      const start = cursor ? fragments.findIndex(f => f.record.ordinal === cursor.ordinal && f.offset === cursor.offset) : 0, next = fragments[start + limit];
      return { fragments: fragments.slice(start, start + limit), next: next ? { ordinal: next.record.ordinal, offset: next.offset } : null };
    } };
}
async function replace(record: RecordValue, text: string) { record.text = text; record.header.bytes = encoder.encode(text).length; record.header.sha256 = await portableDigest(encoder.encode(text)); }
async function stage(records: RecordValue[]) {
  const directory = await mkdtemp(join(tmpdir(), 'portable-correction-')), output = join(directory, 'receiving'), budget = new PortableWorkBudget(128 * 1024 * 1024);
  try {
    const root = JSON.parse(records[0].text), headers = records.map(r => r.header), frames: unknown[] = [{ kind: 'portable_archive', format: 'portable-chat-history-1', content_contract_sha256: await portableContractSha(), records: records.length, bytes: headers.reduce((n, h) => n + h.bytes, 0), manifest_sha256: await portableDigest(portableManifestInput(root.captureManifest, root.policy, headers)) }];
    for (const r of records) {
      const bytes = r.bytes ?? encoder.encode(r.text);
      if (!bytes.length) frames.push({ header: r.header, offset: 0, data: '' });
      for (let offset = 0; offset < bytes.length; offset += 4093) frames.push({ header: r.header, offset, data: Buffer.from(bytes.subarray(offset, offset + 4093)).toString('base64') });
    }
    await writeFile(join(directory, 'input'), frames.map(f => JSON.stringify(f) + '\n').join(''), { mode: 0o600 });
    try { await validatePortableRecipe(join(directory, 'input'), output, budget, policy); }
    catch (error) { await expect(access(output)).rejects.toThrow(); throw error; }
  } finally { expect(budget.used).toBe(0); await rm(directory, { recursive: true, force: true }); }
}

test('receipt admission precedes load and every parse, including rejected shapes and both final projections', async () => {
  for (const valid of [false, true]) {
    const f = await fixture('codex'), field = f.rows.find(r => r.family === 2)!.fields[1];
    const originalRaw = decoder.decode(f.data.get(field.ordinal)), value = JSON.parse(originalRaw);
    const raw = valid ? originalRaw + ' '.repeat(80000) : JSON.stringify({ ...value, source: Array.from({ length: 10000 }, () => ({ x: 1 })) });
    const bytes = encoder.encode(raw); Object.assign(field, { bytes: bytes.length, sha256: await portableDigest(bytes) }); f.data.set(field.ordinal, bytes);
    let receiptLoads = 0; const originalRead = f.source.read.bind(f.source);
    f.source.read = async function* (selected) { if (selected.ordinal === field.ordinal) receiptLoads++; yield* originalRead(selected); };
    const tiny = new PortableWorkBudget(1024 * 1024); let appends = 0;
    await expect(normalizePortableChatHistoryTwoPass(f.source, async () => policy, tiny, { append: async () => { appends++; } })).rejects.toThrow('resource_limit');
    expect(receiptLoads).toBe(0); expect(appends).toBe(0); expect(tiny.used).toBe(0);
    const large = new PortableWorkBudget(128 * 1024 * 1024), seen: number[] = [], parse = JSON.parse;
    JSON.parse = ((text: string, ...args: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never) => { if (text === raw) seen.push(large.used); return parse(text, ...args); }) as typeof JSON.parse;
    try {
      const run = normalizePortableChatHistoryTwoPass(f.source, async () => policy, large, { append: async () => {} });
      if (valid) await run; else await expect(run).rejects.toThrow('unknown_provenance');
    } finally { JSON.parse = parse; }
    expect(seen.length).toBeGreaterThanOrEqual(valid ? 4 : 2);
    expect(seen.every(units => units >= 256 + bytes.length * 256)).toBe(true); expect(large.used).toBe(0);
  }
});

test('receipt readback and UUID cannot parse before their own JSON admission; projection never consumes receipt originals', async () => {
  const f = await fixture('codex'); await f.run();
  const receipt = f.output.find(r => r.header.origin !== undefined && f.output[r.header.origin].text.includes('"family":2'))!;
  await replace(receipt, receipt.text + ' '.repeat(80000));
  const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(f.output), async () => policy, budget);
  try {
    await archive.open(); const release = budget.reserve(budget.limit - budget.used - 1024 * 1024); let consumed = 0;
    await expect(archive.withRecord(receipt.header.ordinal, async () => { consumed++; })).rejects.toThrow('resource_limit');
    await expect(archive.withUuid(uuid(receipt.header.ordinal), async () => { consumed++; })).rejects.toThrow('resource_limit');
    expect(consumed).toBe(0); release();
    await archive.withProjection(async projection => { expect(JSON.stringify(projection)).not.toContain('provider-output'); });
  } finally { archive.dispose(); expect(budget.used).toBe(0); }
});

test('redundancies require recoverable compatible payload in canon, native reader and real staging', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const f = await fixture(provider); await f.run(); await stage(f.output);
    const redundancy = f.output.find(r => r.text.includes('"reason":"provider_final_matches_attributed_message"'))!;
    const root = f.output[0], original = f.output.find(r => r.header.entry.kind === 'historical_text' && r.header.entry.purpose === 'original_text')!, association = f.output.find(r => r.header.entry.kind === 'association')!;
    for (const target of [root.header.ordinal, JSON.parse(redundancy.text).retained - 1, original.header.ordinal, association.header.ordinal, 999999]) {
      const records = structuredClone(f.output), changed = records[redundancy.header.ordinal], origin = JSON.parse(changed.text); origin.retained = target;
      await replace(changed, JSON.stringify(origin));
      await expect(stage(records)).rejects.toThrow('invalid_portable_origin');
      const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(records), async () => policy, budget);
      try { await expect(archive.open()).rejects.toThrow('invalid_portable_origin'); } finally { archive.dispose(); expect(budget.used).toBe(0); }
    }
    const origin = JSON.parse(redundancy.text), payload = f.output[origin.retained].header;
    expect(() => validatePortableRedundancy(origin, payload, { ...JSON.parse(f.output[payload.origin!].text), classification: 'excluded_local_metadata' }, redundancy.header.ordinal)).toThrow('invalid_portable_origin');
  }
});

test('all observed SQL column categories match normative type/nullability and NULL reason', async () => {
  const f = await fixture('codex'), assetRow = f.rows.length;
  await f.appendRow(8, ['asset', 'u', 'note.txt', 'text/plain', 4n, await portableDigest(encoder.encode('note')), encoder.encode('note')]);
  const sendRow = f.rows.length; await f.appendRow(9, ['u', 'turn', 'confirmed', 1n, '["asset"]', 'a', 'ready']);
  f.source.relations = async function* () { yield { from: sendRow, kind: 13, position: 0, to: assetRow, status: 0 }; }; await f.run();
  const origins = f.output.filter(r => r.header.entry.kind === 'historical_text' && r.header.entry.purpose === 'portable_metadata').map(r => JSON.parse(r.text));
  for (const origin of origins) {
    expect(() => validatePortableMetadata(origin)).not.toThrow();
    for (const sqlType of [0, 1, 2, 3]) {
      const family = vocabulary.families[origin.source.family], column = family.columns[origin.source.tag];
      const expected = family.integers.includes(column) ? 1 : family.blobs?.includes(column) ? 3 : 2;
      const valid = sqlType === 0 ? family.nullable.includes(column) && origin.reason === 'sql_null' : sqlType === expected && origin.reason !== 'sql_null';
      const check = () => validatePortableMetadata({ ...origin, source: { ...origin.source, sqlType } });
      if (valid) expect(check).not.toThrow(); else expect(check).toThrow('invalid_portable_metadata');
    }
  }
  const message = f.output.find(r => r.text.includes('"meaning":"message"'))!;
  for (const sqlType of [0, 1, 3]) {
    const records = structuredClone(f.output), changed = records[message.header.ordinal], origin = JSON.parse(changed.text); origin.source.sqlType = sqlType; await replace(changed, JSON.stringify(origin));
    await expect(stage(records)).rejects.toThrow('invalid_portable_metadata');
    const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(records), async () => policy, budget);
    try { await expect(archive.open()).rejects.toThrow('invalid_portable_metadata'); } finally { archive.dispose(); expect(budget.used).toBe(0); }
  }
});


test('real inline and durable owned asset redundancy retains one recoverable asset', async () => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63a8070000810080d394534a0000000049454e44ae426082', 'hex');
  const f = await fixture('codex', messages => { messages[0][9] = JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + bytes.toString('base64') }] }]); });
  const assetRow = f.rows.length; await f.appendRow(8, ['asset', 'u', 'pixel.png', 'image/png', BigInt(bytes.length), await portableDigest(bytes), bytes]);
  const sendRow = f.rows.length; await f.appendRow(9, ['u', 'turn', 'confirmed', 1n, '["asset"]', 'a', 'ready']);
  f.source.relations = async function* () { yield { from: sendRow, kind: 13, position: 0, to: assetRow, status: 0 }; };
  const output: RecordValue[] = [];
  await normalizePortableChatHistoryTwoPass(f.source, async () => policy, f.budget, { append: async (header, bytes) => { output.push({ header, text: header.entry.kind === 'asset' ? '' : decoder.decode(bytes), bytes: bytes.slice() }); } });
  expect(output.filter(r => r.header.entry.kind === 'asset')).toHaveLength(1);
  expect(output.some(r => r.text.includes('"reason":"identical_owned_asset"'))).toBe(true); await stage(output);
  const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(output), async () => policy, budget);
  try { await archive.open(); await archive.withProjection(async projection => { expect(projection.images[projection.messages[0].id][0].dataUrl).toContain(bytes.toString('base64')); }); }
  finally { archive.dispose(); expect(budget.used).toBe(0); }
});


test('structured hidden reparsing admits the saved argument graph after provider scope, even with a short hidden field', async () => {
  const args = JSON.stringify({ unused: Array.from({ length: 10000 }, () => ({ x: 1 })) });
  const make = () => fixture('codex', messages => {
    const call = { id: 'large', type: 'function' as const, function: { name: 'read_sources', arguments: args } };
    messages[1][7] = JSON.stringify([{ tool_call_id: 'large', tool_name: 'read_sources', status: 'done' }]);
    messages[1][8] = buildToolContextBlock('large', 'read_sources', undefined, 'short');
    messages[1][9] = JSON.stringify([...buildAssistantProviderInputItemsFromTurn('', [call]), buildFunctionCallOutputProviderInputItem('large', 'short'), ...buildAssistantProviderInputItemsFromTurn('A complete final answer.', [])]);
  });
  const f = await make(), budget = new PortableWorkBudget(128 * 1024 * 1024), seen: number[] = [], parse = JSON.parse;
  JSON.parse = ((text: string, ...argsForParse: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never) => { if (text === args) seen.push(budget.used); return parse(text, ...argsForParse); }) as typeof JSON.parse;
  try { await normalizePortableChatHistoryTwoPass(f.source, async () => policy, budget, { append: async () => {} }); } finally { JSON.parse = parse; }
  expect(seen.length).toBeGreaterThanOrEqual(6); expect(seen.every(n => n >= 256 + encoder.encode(args).length * 256)).toBe(true); expect(budget.used).toBe(0);
  const constrained = await make(), limited = new PortableWorkBudget(128 * 1024 * 1024), read = constrained.source.read.bind(constrained.source);
  let release: (() => void) | undefined, writes = 0;
  constrained.source.read = async function* (field) {
    if (field.family === 1 && field.tag === 8 && field.bytes && !release) release = limited.reserve(limited.limit - limited.used - 1024 * 1024);
    yield* read(field);
  };
  try { await expect(normalizePortableChatHistoryTwoPass(constrained.source, async () => policy, limited, { append: async () => { writes++; } })).rejects.toThrow('resource_limit'); }
  finally { release?.(); }
  expect(writes).toBe(0); expect(limited.used).toBe(0);
});
