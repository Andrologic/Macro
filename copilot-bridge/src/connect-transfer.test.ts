import { expect, test } from 'bun:test';
import { readFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, checkpointFixture } from '../../src/services/ai/portableHistoryFixtures.testSupport';
import { PortableWorkBudget } from '../../src/services/ai/portableHistoryInspection';
import { portableDigest } from '../../src/services/ai/portableChatHistory';
import { PNG } from '../../src/test-utils/portableNormalizationRecipe';
import { portableDescriptor, portableFragment } from '../../src/services/ai/portableArchiveWire';
import { TRANSFER_RESOURCES, TRANSFER_HELLO } from './connect-transfer-identities.generated';
import { IDENTITIES } from '../../contracts/macro-pilot/v2/transfer-transit/identities.generated.mjs';
import { TransferParent, repository } from './connect-transfer.testSupport';
import { Frame, Reject, headerBytes } from './connect-codec-framing';
import { validateRequest, validateResponse, validateStart, validateHello, validateGrant, grantBytes, encodeControl, PROJECTION_KINDS } from './connect-transfer-protocol';
import { measureValue, withEncodedValue, CONTROL_RESERVE, decimal } from './connect-transfer-values';
const local = process.platform === 'win32' ? test.skip : test;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const maximum = Number.MAX_SAFE_INTEGER, d = String(maximum), h = '18446744073709551615', hash = 'f'.repeat(64);
const field = { ordinal: maximum, bytes: maximum, sha256: hash };
const descriptor = { kind: 'portable_archive', format: 'portable-chat-history-1', content_contract_sha256: IDENTITIES.content_contract_sha256, records: maximum, bytes: maximum, manifest_sha256: hash };
const header = { ordinal: maximum, entry: { kind: 'association', from: maximum, to: maximum, position: maximum, relation: 'citation_for_message' }, bytes: 0, sha256: hash };
const target = { kind: 'target', provider_type: 'chatgpt', fields: Object.fromEntries(['conversationId', 'providerId', 'modelId', 'baseUrl', 'modePrompt', 'reasoningEffort', 'currentCheckpoint', 'contextWarning'].map(key => [key, field])),
  footprint: { modelContextWindowTokens: maximum, inputLimitTokens: maximum, outputLimitTokens: maximum, contextLimitSource: 'provider_overflow_error', contextLimitConfidence: 'configured', isContextLimitAuthoritative: false },
  risk: 'balanced', max_turns: d, budget_policy: { auto: false, prune: false, reservedTokens: maximum, preserveRecentTokens: maximum, hardStopRatio: Number.MAX_VALUE } };

test('embedded identity commits real E/preparation sources and independent canonical descriptor expectation', () => {
  for (const resource of TRANSFER_RESOURCES) expect(digest(readFileSync(resolve(repository, resource.path)))).toBe(resource.sha256);
  expect(digest(JSON.stringify(TRANSFER_RESOURCES))).toBe(TRANSFER_HELLO.preparation_set_sha256);
  expect(String(TRANSFER_HELLO.portable_contract_sha256)).toBe(digest(readFileSync(resolve(repository, 'contracts/macro-pilot/v2/portable-chat-history/portable-chat-history-contract.json'))));
  expect(IDENTITIES.content_contract_sha256).toBe(TRANSFER_HELLO.portable_contract_sha256); // Verified current resource identity, never taken from an incoming descriptor.
  const request = { op: 3, call: '1', handle: h, stage: 'begin', descriptor };
  validateRequest(request);
  for (const bad of ['0'.repeat(64), 'stale']) {
    expect(() => validateRequest({ ...request, descriptor: { ...descriptor, content_contract_sha256: bad } })).toThrow();
    expect(() => validateResponse({ op: 1, call: '1', status: 0, result: { value: { kind: 'staging', bytes: '1', sha256: hash, descriptor: { ...descriptor, content_contract_sha256: bad } }, next: null } }, { op: 1, call: '1', kind: 'root' })).toThrow();
  }
});

test('all fixed control variants, long field handles, encoded stage, START/HELLO/GRANT are closed', () => {
  const requests = [
    ...['root', 'field', 'detection', 'target', 'relation'].map(kind => ({ op: 1, call: d, handle: h, kind, cursor: kind === 'root' ? null : kind === 'relation' ? { from: d, kind: d, position: d } : { ordinal: d } })),
    { op: 2, call: d, handle: h, ordinal: d, offset: d, max_bytes: '65536' },
    { op: 3, call: d, handle: h, stage: 'begin', descriptor }, { op: 3, call: d, handle: h, stage: 'header', header },
    { op: 3, call: d, handle: h, stage: 'end', result: { records: d, fragments: d, bytes: d, manifest: hash } },
    { op: 4, call: d, handle: h, header, offset: d, bytes: '4093', sha256: hash },
    { op: 5, call: d, handle: h, cursor: { ordinal: d, offset: d }, limit: '32' },
    ...PROJECTION_KINDS.flatMap(kind => [{ op: 6, call: d, handle: h, kind, stage: 'begin', total: d }, { op: 6, call: d, handle: h, kind, stage: 'end', total: d },
      { op: 6, call: d, handle: h, kind, stage: 'item', index: d, units: d, upper_json_bytes: d }, { op: 6, call: d, handle: h, kind, stage: 'encoded', bytes: d, sha256: hash }]),
    { op: 7, call: d, handle: h, kind: 'imported', result: { records: d, fragments: d, bytes: d, manifest: hash } },
    { op: 7, call: d, handle: h, kind: 'prepared_ts', result: { draft_handle: h, archive_manifest: hash, storage_revision: d, mapping_sha256: hash, target_handle: h, reference: 'synthetic' } },
    { op: 7, call: d, handle: h, kind: 'recovered', result: { ordinal: d, bytes: d, sha256: hash } },
  ];
  const lengths = requests.map(request => { validateRequest(request); expect(() => validateRequest({ ...request, extra: true })).toThrow(); return encodeControl(request).length; });
  const response = { op: 1, call: d, status: 0, result: { value: target, next: null } };
  validateResponse(response, { op: 1, call: d, kind: 'root' }); lengths.push(encodeControl(response).length);
  const raw = { ordinal: maximum, row: maximum, family: maximum, tag: maximum, sql_type: 3, bytes: maximum, sha256: hash };
  const fieldResponse = { op: 1, call: d, status: 0, result: { value: raw, next: { ordinal: d } } };
  validateResponse(fieldResponse, { op: 1, call: d, kind: 'field' }); lengths.push(encodeControl(fieldResponse).length);
  const start = { op: 0, kind: 'prepare', handles: { archive: h, policy: '18446744073709551614', target: '18446744073709551613', draft: '18446744073709551612' }, child_units: d, detection_units: '1', native_units: '1' };
  // Safe aggregate is checked independently; a scalar MAX_SAFE grant plus others refuses.
  expect(() => validateStart(start)).toThrow(); start.child_units = '536870912'; validateStart(start);
  expect(() => validateStart({ ...start, unknown: 1 })).toThrow(); lengths.push(encodeControl(start).length);
  validateHello(TRANSFER_HELLO); expect(() => validateHello({ ...TRANSFER_HELLO, authority: true })).toThrow();
  for (const kind of [1, 2, 3]) {
    const bytes = grantBytes({ units: 1, call: kind === 3 ? 0n : 1n, arena: 1n, kind, direction: kind === 3 ? 0 : 1, limit: kind === 1 ? 4096 : kind === 2 ? 65536 : 0 });
    validateGrant(bytes); bytes[31] = 1; expect(() => validateGrant(bytes)).toThrow();
  }
  expect(Math.max(...lengths)).toBeLessThanOrEqual(4096);
  console.log('transfer_control_fixed_max', Math.max(...lengths));
  // A concrete exception requires a parent decision; no transcript ceiling is inferred from control size.
  const longPolicy = { op: 7, call: '1', handle: '1', kind: 'normalized', result: { records: '1', bytes: '1', manifest: hash, policy: 'r'.repeat(4097) } };
  validateRequest(longPolicy); expect(() => encodeControl(longPolicy)).toThrow();
});

test('measurement matches UTF-8/UTF-16 serialization and retains reservation across a suspended consumer', async () => {
  const value = { text: 'é🙂\n\u0000"\\'.repeat(20000), absent: undefined, fields: Array.from({ length: 30 }, (_, i) => ({ index: i })) };
  const size = measureValue(value); expect(size.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(value))); expect(size.jsonChars).toBe(JSON.stringify(value).length);
  const budget = new PortableWorkBudget(8 * 1024 * 1024); let resume!: () => void, reached!: () => void;
  const ready = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { resume = r; });
  const pending = withEncodedValue(value, budget, async bytes => { expect(bytes.length).toBe(size.jsonBytes); reached(); await gate; expect(budget.used).toBeGreaterThan(0); });
  await ready; expect(budget.used).toBeGreaterThan(0); resume(); await pending; expect(budget.used).toBe(0);
  await expect(withEncodedValue(value, new PortableWorkBudget(1), async () => { throw Error('must not allocate'); })).rejects.toThrow('resource_limit');
  for (const bad of ['\ud800', NaN, { get x() { throw Error('getter must not run'); } }]) expect(() => measureValue(bad)).toThrow();
});

async function sourceCase(provider: 'codex' | 'macro-ai', mutate?: Parameters<typeof fixture>[1], childUnits?: number) {
  const budget = new PortableWorkBudget(256 * 1024 * 1024);
  // Covers fixture/oracle graphs, strings and byte maps before fixture builds them. Fixed recipe <=16K source; large recipes supply an explicit larger scope below.
  const fixtureRelease = budget.reserve(16 * 1024 * 1024);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let parent: TransferParent | undefined;
  try {
    f = await fixture(provider, mutate);
    const image = Buffer.from(PNG, 'base64'), assetRow = f.rows.length;
    await f.appendRow(8, ['owned-image', 'u', 'synthetic.png', 'image/png', BigInt(image.length), await portableDigest(image), image]);
    const sendRow = f.rows.length;
    await f.appendRow(9, ['u', 'turn', 'confirmed', 1n, '["owned-image"]', 'a', 'ready']);
    parent = await TransferParent.create(budget);
    parent.relations = [{ from: sendRow, kind: 13, position: 0, to: assetRow, status: 0 }];
    await parent.start('normalize', childUnits); parent.source(f.rows, f.source.manifest, f.source.limits, f.data);
    const status = await parent.run(); await parent.finish();
    return { status, parent, budget, dispose: async () => { f = undefined; await parent!.cleanup(); fixtureRelease(); expect(budget.used).toBe(0); } };
  } catch (error) { f = undefined; await parent?.cleanup(); fixtureRelease(); throw error; }
}

local('real child runs two real passes for Codex and Macro AI without SDK/IPC/provider and keeps tool facts', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const result = await sourceCase(provider);
    try {
      expect(result.status).toBe(0); expect(result.parent.appended).toBeGreaterThan(0);
      const texts = result.parent.records.map(r => new TextDecoder().decode(r.bytes)).join('\n');
      expect(texts).toContain('PROVIDER_ONLY_FACT'); expect(texts).toContain('HIDDEN_ONLY_FACT'); expect(texts).toContain('read_sources'); expect(texts).toContain('9007199254740993');
    } finally { await result.dispose(); }
  }
}, 30000);

local('failed pass 1 and changed pass 2 cannot report normalized success', async () => {
  const failed = await sourceCase('codex', messages => { messages[0][4] = '/Users/synthetic/private'; });
  try { expect(failed.status).not.toBe(0); expect(failed.parent.appended).toBe(0); } finally { await failed.dispose(); }
  const budget = new PortableWorkBudget(256 * 1024 * 1024), fixtureRelease = budget.reserve(16 * 1024 * 1024);
  let f: Awaited<ReturnType<typeof fixture>> | undefined = await fixture('codex'); const parent = await TransferParent.create(budget);
  try {
    await parent.start('normalize'); parent.source(f.rows, f.source.manifest, f.source.limits, f.data);
    parent.beforeRequest = async request => {
      if (request.op === 3 && request.stage === 'begin') {
        const field = f!.rows.find(row => row.family === 1)!.fields[4];
        f!.data.set(field.ordinal, new TextEncoder().encode('X'.repeat(field.bytes)));
      }
    };
    expect(await parent.run()).not.toBe(0); await parent.finish();
  } finally { f = undefined; await parent.cleanup(); fixtureRelease(); expect(budget.used).toBe(0); }
}, 30000);

async function targetFields(parent: TransferParent, provider: 'chatgpt' | 'openai', modePrompt = 'Local trusted Chat instructions.'): Promise<void> {
  const h = parent.starts[0].handles.target, data = new Map<number, Uint8Array>(), fields: Record<string, unknown> = {};
  const values = { conversationId: 'target-conversation', providerId: 'synthetic-provider', modelId: 'synthetic-model', baseUrl: '', modePrompt,
    reasoningEffort: 'medium', currentCheckpoint: null, contextWarning: null };
  let ordinal = 0;
  for (const [name, value] of Object.entries(values)) {
    if (value === null) { fields[name] = null; continue; }
    const bytes = new TextEncoder().encode(value); data.set(ordinal, bytes); fields[name] = { ordinal: ordinal++, bytes: bytes.length, sha256: await portableDigest(bytes) };
  }
  parent.data.set(h, data); parent.roots.set(h, { ...target, fields, provider_type: provider, max_turns: '3',
    footprint: { modelContextWindowTokens: 100000, inputLimitTokens: null, outputLimitTokens: 1000,
      contextLimitSource: 'provider_metadata', contextLimitConfidence: 'verified', isContextLimitAuthoritative: true },
    budget_policy: { auto: false, prune: true, reservedTokens: 1000, preserveRecentTokens: 1000, hardStopRatio: 1 } });
}

local('four provider pairs run actual archive projection and shared reference preparation, retaining output after page ACK', async () => {
  for (const source of ['codex', 'macro-ai'] as const) for (const targetProvider of ['chatgpt', 'openai'] as const) {
    const input = await sourceCase(source);
    const parent = await TransferParent.create(input.budget);
    try {
      await parent.start('prepare', 64 * 1024 * 1024); await parent.archive(input.parent.records); await targetFields(parent, targetProvider);
      let delayed = 0;
      parent.delayAck = async () => { expect(parent.draftHeld).toBeGreaterThan(0); expect(input.budget.used).toBeGreaterThan(parent.draftHeld); if (!delayed++) await Bun.sleep(10); };
      const status = await parent.run(); await parent.finish(); expect(status).toBe(0);
      const messages = parent.retained.filter(v => v.kind === 'message').map(v => v.value);
      const native = parent.retained.filter(v => v.kind === 'prepared-message').map(v => v.value);
      expect(JSON.stringify(messages)).toContain('PROVIDER_ONLY_FACT'); expect(JSON.stringify(messages)).toContain('HIDDEN_ONLY_FACT');
      expect(JSON.stringify(messages)).toContain('read_sources'); expect(JSON.stringify(messages)).toContain('9007199254740993');
      expect(JSON.stringify(native)).toContain('PROVIDER_ONLY_FACT'); expect(JSON.stringify(native)).toContain('CITATION_FACT'); expect(JSON.stringify(native)).toContain(PNG);
      expect(parent.retained.find(v => v.kind === 'image')?.value.images[0].dataUrl).toBe(`data:image/png;base64,${PNG}`);
      expect(parent.retained.find(v => v.kind === 'request-metadata')?.value.native_builder_required).toBe(true);
      expect(parent.retained.find(v => v.kind === 'request-metadata')?.value.provider_type).toBe(targetProvider);
      expect(parent.retained.find(v => v.kind === 'reference-message')?.value.content).toContain('synthetic local preparation reference');
      expect(parent.retained.find(v => v.kind === 'effect-draft')?.value.providerInputItems).toHaveLength(1);
      expect(parent.draftHeld).toBeGreaterThan(0); // PAGE_CONSUMED did not return retained projection credit.
      expect(native.filter(v => v.role === 'system').map(v => v.content).join('')).not.toContain('PROVIDER_ONLY_FACT');
    } finally { await parent.cleanup(); await input.dispose(); }
  }
}, 60000);

local('canonical staging preflight reuses real validator but absent native inactive storage refuses before append', async () => {
  const input = await sourceCase('codex'); const parent = await TransferParent.create(input.budget);
  try {
    const start = await parent.start('import', 32 * 1024 * 1024);
    const records = input.parent.records, stats = { records: records.length, bytes: records.reduce((sum, r) => sum + r.bytes.length, 0), manifest: '' };
    // Exact TS manifest comes from the real source child's terminal calculation.
    stats.manifest = input.parent.finalResult!.manifest;
    const descriptor = portableDescriptor(stats, IDENTITIES.content_contract_sha256);
    const text = JSON.stringify(descriptor) + '\n' + records.map(record => {
      if (!record.bytes.length) return portableFragment(record.header, 0, record.bytes);
      let result = ''; for (let offset = 0; offset < record.bytes.length; offset += 4093) result += portableFragment(record.header, offset, record.bytes.subarray(offset, offset + 4093)); return result;
    }).join('');
    const bytes = new TextEncoder().encode(text);
    parent.data.set(start.handles.staging, new Map([[0, bytes]])); parent.roots.set(start.handles.staging, { kind: 'staging', bytes: decimal(bytes.length), sha256: await portableDigest(bytes), descriptor });
    expect(await parent.run()).toBe(1); await parent.finish(); expect(parent.appended).toBe(0);
  } finally { await parent.cleanup(); await input.dispose(); }
}, 30000);

local('cancel at a real callback joins the child before returning reservations', async () => {
  const budget = new PortableWorkBudget(128 * 1024 * 1024), releaseFixture = budget.reserve(16 * 1024 * 1024);
  let f: Awaited<ReturnType<typeof fixture>> | undefined = await fixture('codex'); const parent = await TransferParent.create(budget);
  try {
    await parent.start('normalize', 64 * 1024 * 1024); parent.source(f.rows, f.source.manifest, f.source.limits, f.data);
    parent.beforeRequest = async () => { await parent.send(Frame.CANCEL); return true; };
    expect(await parent.run()).toBe(2); await parent.finish(); expect(parent.appended).toBe(0); expect(budget.used).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  } finally { f = undefined; await parent.cleanup(); releaseFixture(); expect(budget.used).toBe(0); }
});

local('300 messages and a 4.9 MB field normalize without transcript caps; real archive refuses an insufficient admitted lease', async () => {
  const budget = new PortableWorkBudget(384 * 1024 * 1024);
  const fixtureRelease = budget.reserve(40 * 1024 * 1024); // 2 UTF-16 source views + UTF-8 map + row/oracle metadata, before construction.
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const parents: TransferParent[] = [];
  try {
    f = await fixture('codex', messages => {
      messages[0][4] = 'RECOVERABLE_LARGE_ORIGINAL ' + 'x'.repeat(4_900_000);
      messages.splice(1, 0, ...Array.from({ length: 298 }, (_, i) => [`history-${i}`, 's', `turn-${i}`, 'user', `COMPLETE_HISTORY_${i}`, String(i + 1), null, null, null, null, null, '[]', null, null]));
    });
    const source = await TransferParent.create(budget); parents.push(source); await source.start('normalize', 128 * 1024 * 1024);
    source.source(f.rows, f.source.manifest, f.source.limits, f.data);
    expect(await source.run()).toBe(0); await source.finish();
    expect(source.records.filter(record => record.header.entry.kind === 'message')).toHaveLength(300);
    const original = source.records.find(record => record.bytes.length > 4_900_000)!; expect(original).toBeDefined();
    const recover = await TransferParent.create(budget); parents.push(recover); const start = await recover.start('recover', 128 * 1024 * 1024); await recover.archive(source.records);
    recover.roots.set(start.handles.selector, { kind: 'selector', ordinal: decimal(original.header.ordinal), uuid: `00000000-0000-4000-8000-${String(original.header.ordinal).padStart(12, '0')}` });
    expect(await recover.run()).toBe(1); await recover.finish(); expect(recover.retained).toHaveLength(0);
    const metadataUnits = source.records.filter(record => record.header.entry.kind === 'historical_text' && record.header.entry.purpose === 'portable_metadata').reduce((sum, record) => sum + 512 + 256 * record.bytes.length, 0);
    expect(metadataUnits).toBeGreaterThan(128 * 1024 * 1024);
    console.log('transfer_large_archive_metadata_units', metadataUnits, 'admitted_child_units', 128 * 1024 * 1024);
    console.log('transfer_large_parent_peak', budget.peak, 'work_limit', budget.limit, 'source_records', source.records.length);
  } finally {
    f = undefined; for (const parent of parents.reverse()) await parent.cleanup(); fixtureRelease(); expect(budget.used).toBe(0);
  }
}, 240000);

local('secret expansion is admitted before any value read, and real bundle forms block a private fact in pass 1', async () => {
  for (const mode of ['budget', 'detector'] as const) {
    const budget = new PortableWorkBudget(160 * 1024 * 1024), releaseFixture = budget.reserve(16 * 1024 * 1024);
    let f: Awaited<ReturnType<typeof fixture>> | undefined = await fixture('codex', messages => { messages[0][4] = 'PRIVATE_SYNTHETIC_VALUE'; });
    const parent = await TransferParent.create(budget);
    try {
      const secret = new TextEncoder().encode('{"token":"PRIVATE_SYNTHETIC_VALUE"}');
      const start = await parent.start('normalize', 64 * 1024 * 1024, mode === 'budget' ? 65536 : 65536 + 4096 * (secret.length + 1) + 512 + 8 * 'policy-1'.length);
      parent.source(f.rows, f.source.manifest, f.source.limits, f.data);
      const root = parent.roots.get(start.handles.policy)!; root.count = '1'; root.bytes = mode === 'budget' ? '1000000' : decimal(secret.length);
      parent.data.get(start.handles.policy)!.set(1, secret);
      let reads = 0; parent.beforeRequest = async request => { if (request.op === 2) reads++; };
      expect(await parent.run()).toBe(1); await parent.finish(); expect(parent.appended).toBe(0);
      if (mode === 'budget') expect(reads).toBe(0); else expect(reads).toBeGreaterThan(0);
    } finally { f = undefined; await parent.cleanup(); releaseFixture(); expect(budget.used).toBe(0); }
  }
}, 30000);

local('native callback refusal during archive pagination prevents projection, and target fields can exceed 4K controls', async () => {
  const input = await sourceCase('codex');
  for (const mode of ['revoked', 'long-target'] as const) {
    const parent = await TransferParent.create(input.budget);
    try {
      await parent.start('prepare', 64 * 1024 * 1024); await parent.archive(input.parent.records); await targetFields(parent, 'openai', 'Local prompt '.repeat(1000));
      let pages = 0;
      parent.beforeRequest = async request => {
        if (mode === 'revoked' && request.op === 5 && ++pages === 2) { await parent.response(request, undefined, 3); await parent.scope(request, 3); return true; }
      };
      expect(await parent.run()).toBe(mode === 'revoked' ? 1 : 0); await parent.finish();
      if (mode === 'revoked') expect(parent.retained).toHaveLength(0);
      else expect(parent.retained.filter(v => v.kind === 'prepared-message' && v.value.role === 'system')[0].value.content).toContain('Local prompt '.repeat(1000));
    } finally { await parent.cleanup(); }
  }
  await input.dispose();
}, 30000);

local('real source checkpoint retains recoverable pre-compaction facts through the same archive owner', async () => {
  const budget = new PortableWorkBudget(320 * 1024 * 1024), releaseFixture = budget.reserve(24 * 1024 * 1024);
  let f: Awaited<ReturnType<typeof checkpointFixture>> | undefined = await checkpointFixture();
  const parents: TransferParent[] = [];
  try {
    const source = await TransferParent.create(budget); parents.push(source); await source.start('normalize', 96 * 1024 * 1024); source.source(f.rows, f.source.manifest, f.source.limits, f.data);
    expect(await source.run()).toBe(0); await source.finish();
    const original = source.records.find(record => new TextDecoder().decode(record.bytes).startsWith('history-0 '))!;
    expect(source.records.some(record => new TextDecoder().decode(record.bytes).includes('Historical checkpoint summary'))).toBe(true);
    const recover = await TransferParent.create(budget); parents.push(recover); const start = await recover.start('recover', 96 * 1024 * 1024); await recover.archive(source.records);
    recover.roots.set(start.handles.selector, { kind: 'selector', ordinal: decimal(original.header.ordinal), uuid: null });
    expect(await recover.run()).toBe(0); await recover.finish();
    const restored = recover.retained[0].value; expect(Buffer.from(restored.base64, 'base64').toString()).toContain('history-0 '); expect(restored.sha256).toBe(original.header.sha256);
    await recover.cleanup();
    const prepare = await TransferParent.create(budget); parents.push(prepare); await prepare.start('prepare', 96 * 1024 * 1024); await prepare.archive(source.records); await targetFields(prepare, 'chatgpt');
    const target = prepare.roots.get(prepare.starts[0].handles.target)!; target.footprint.modelContextWindowTokens = 8000; target.budget_policy.auto = true;
    expect(await prepare.run()).toBe(1); await prepare.finish(); expect(prepare.retained).toHaveLength(0); // A fresh summary is necessary; no fallback/network summary is made.
  } finally { f = undefined; for (const parent of parents.reverse()) await parent.cleanup(); releaseFixture(); expect(budget.used).toBe(0); }
}, 60000);

local('hostile headers, EOF and wrong grants retire the real child without draining a body or returning early credit', async () => {
  for (const mode of ['hostile-length', 'eof', 'credit', 'ids'] as const) {
    const budget = new PortableWorkBudget(96 * 1024 * 1024), parent = await TransferParent.create(budget);
    try {
      if (mode === 'hostile-length') await parent.writer.bytes(headerBytes({ type: Frame.BEGIN, job: 1n, lease: 0n, sequence: 0, length: 0xffffffff }));
      else if (mode === 'eof') { await parent.writer.bytes(new Uint8Array([0x4d, 0x43, 0x46])); closeSync(parent.inputFd); }
      else {
        await parent.start('normalize', 64 * 1024 * 1024);
        const requestFrame = await parent.receive(); expect(requestFrame.header.type).toBe(Frame.BEGIN);
        const request = JSON.parse(new TextDecoder().decode(requestFrame.payload));
        await parent.send(Frame.GRANT, grantBytes({ units: mode === 'credit' ? CONTROL_RESERVE - 1 : CONTROL_RESERVE,
          call: BigInt(request.call), arena: mode === 'ids' ? 2n : 1n, limit: 4096, kind: 1, direction: 1 }), 2n);
      }
      const rejected = await parent.receive(); expect(rejected.header.type).toBe(Frame.REJECT); expect(rejected.payload.length).toBe(4);
      expect(new DataView(rejected.payload.buffer, rejected.payload.byteOffset).getUint32(0)).toBe(mode === 'hostile-length' ? Reject.limit : mode === 'eof' ? Reject.framing : Reject.credit);
      expect(await parent.process.exited).toBe(1); expect(budget.used).toBeGreaterThan(0);
    } finally { await parent.cleanup(); expect(budget.used).toBe(0); }
  }
});

local('a parent STOP retires startup, and missing indispensable context refuses before any append', async () => {
  const budget = new PortableWorkBudget(16 * 1024 * 1024), parent = await TransferParent.create(budget);
  try { for (const byte of headerBytes({ type: Frame.STOP, job: 0n, lease: 0n, sequence: 0, length: 0 })) await parent.writer.bytes(new Uint8Array([byte])); expect((await parent.receive()).header.type).toBe(Frame.STOPPED); await parent.finish(); }
  finally { await parent.cleanup(); expect(budget.used).toBe(0); }
  const missing = await sourceCase('codex', messages => { messages[0][11] = JSON.stringify([{ id: 'missing', kind: 'source', title: 'Required missing context' }]); });
  try { expect(missing.status).toBe(1); expect(missing.parent.appended).toBe(0); } finally { await missing.dispose(); }
});

local('CANCEL while an output consumer is suspended keeps parent copies charged until child and pipes join', async () => {
  const input = await sourceCase('codex'), parent = await TransferParent.create(input.budget);
  let wake!: () => void, ready!: () => void;
  const gate = new Promise<void>(resolve => { wake = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
  let serving: Promise<unknown> | undefined;
  try {
    await parent.start('prepare', 64 * 1024 * 1024); await parent.archive(input.parent.records); await targetFields(parent, 'chatgpt');
    parent.delayAck = async () => { ready(); await gate; throw Error('synthetic_parent_cancelled'); };
    serving = parent.run().catch(error => error);
    await entered; const held = input.budget.used; expect(parent.draftHeld).toBeGreaterThan(0);
    await parent.send(Frame.CANCEL);
    const terminal = await parent.receive(); expect(terminal.header.type).toBe(Frame.JOB_FINISHED); expect(new DataView(terminal.payload.buffer, terminal.payload.byteOffset).getUint32(0)).toBe(2);
    expect(input.budget.used).toBe(held); expect(parent.retained).toHaveLength(0);
    wake(); expect(await serving).toBeInstanceOf(Error); await parent.finish(); expect(parent.draftHeld).toBeGreaterThan(0);
  } finally { wake(); await serving; await parent.cleanup(); await input.dispose(); }
}, 30000);

local('a stale staging root or actual first descriptor refuses before any plan or append', async () => {
  const input = await sourceCase('codex');
  try {
    for (const mode of ['root', 'body'] as const) {
      const parent = await TransferParent.create(input.budget);
      try {
        const start = await parent.start('import', 32 * 1024 * 1024);
        const good = portableDescriptor({ records: input.parent.records.length, bytes: Number(input.parent.finalResult!.bytes), manifest: input.parent.finalResult!.manifest }, IDENTITIES.content_contract_sha256);
        const bad = { ...good, content_contract_sha256: '0'.repeat(64) };
        const bytes = new TextEncoder().encode(JSON.stringify(mode === 'body' ? bad : good) + '\n');
        parent.data.set(start.handles.staging, new Map([[0, bytes]])); parent.roots.set(start.handles.staging, { kind: 'staging', bytes: decimal(bytes.length), sha256: await portableDigest(bytes), descriptor: mode === 'root' ? bad : good });
        let plans = 0;
        // For a hostile root, bypass the fixture's own validator to test the child boundary.
        parent.beforeRequest = async request => {
          if (request.op === 3) plans++;
          if (mode === 'root' && request.op === 1 && request.handle === start.handles.staging) {
            const lease = ++parent.lease; parent.control = lease;
            await parent.send(Frame.GRANT, grantBytes({ units: CONTROL_RESERVE, call: BigInt(request.call), arena: 1n, limit: 4096, kind: 1, direction: 1 }), lease);
            await parent.send(Frame.BEGIN, encodeControl({ op: 1, call: request.call, status: 0, result: { value: parent.roots.get(start.handles.staging), next: null } }));
            return true;
          }
        };
        expect(await parent.run()).toBe(1); await parent.finish(); expect(plans).toBe(0); expect(parent.appended).toBe(0);
      } finally { await parent.cleanup(); }
    }
  } finally { await input.dispose(); }
}, 30000);

local('declared source counts and empty-record cursors cannot create an unbounded private iteration', async () => {
  const budget = new PortableWorkBudget(160 * 1024 * 1024), releaseFixture = budget.reserve(16 * 1024 * 1024);
  let f: Awaited<ReturnType<typeof fixture>> | undefined = await fixture('codex');
  const source = await TransferParent.create(budget);
  try {
    await source.start('normalize', 64 * 1024 * 1024); source.source(f.rows, f.source.manifest, f.source.limits, f.data);
    source.relations = [{ from: 0, kind: 0, position: 0, to: 0, status: 0 }]; // Contradicts already captured count zero.
    expect(await source.run()).toBe(1); await source.finish(); expect(source.appended).toBe(0);
  } finally { f = undefined; await source.cleanup(); releaseFixture(); expect(budget.used).toBe(0); }
  const input = await sourceCase('codex'), parent = await TransferParent.create(input.budget);
  try {
    await parent.start('prepare', 64 * 1024 * 1024); await parent.archive(input.parent.records); await targetFields(parent, 'chatgpt');
    let repeated = false;
    parent.transform = (request, result) => {
      if (request.op === 5 && result.stage === 'end' && request.cursor && parent.fragments.find(fragment => fragment.record.ordinal === Number(request.cursor.ordinal))?.record.bytes === 0) {
        repeated = true; return { ...result, next: request.cursor };
      }
      return result;
    };
    expect(await parent.run()).toBe(1); await parent.finish(); expect(repeated).toBe(true); expect(parent.retained).toHaveLength(0);
  } finally { await parent.cleanup(); await input.dispose(); }
}, 30000);
