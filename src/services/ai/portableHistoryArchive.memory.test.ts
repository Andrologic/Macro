import { expect, test } from 'bun:test';
import { vocabulary } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
import { normalizePortableChatHistoryTwoPass, portableDigest, type PortableMetadata, type PortableRecord } from './portableChatHistory';
import { PortableHistoryArchive, type PortableArchiveFragment, type PortableArchivePort } from './portableHistoryArchive';
import { PortableWorkBudget } from './portableHistoryInspection';

const MiB = 1024 * 1024;
class ObservedBudget extends PortableWorkBudget {
  rejected: { units: number; used: number } | undefined;
  override reserve(units: number): () => void {
    try { return super.reserve(units); }
    catch (error) { this.rejected = { units, used: this.used }; throw error; }
  }
}
async function measuredArchive(options: { large?: boolean; revision?: string; rewrite?: (value: PortableMetadata) => void } = {}) {
  const parent = new PortableWorkBudget(384 * MiB), releaseFixture = parent.reserve((options.large ? 40 : 16) * MiB);
  const held: (() => void)[] = [], records: { header: PortableRecord; bytes: Uint8Array }[] = [], fragments: PortableArchiveFragment[] = [];
  const textPolicy = { ...policy, revision: options.revision ?? policy.revision };
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture('codex', options.large ? messages => {
      messages[0][4] = 'RECOVERABLE_LARGE_ORIGINAL ' + 'x'.repeat(4_900_000);
      messages.splice(1, 0, ...Array.from({ length: 298 }, (_, i) => [`history-${i}`, 's', `turn-${i}`, 'user', `COMPLETE_HISTORY_${i}`, String(i + 1), null, null, null, null, null, '[]', null, null]));
    } : undefined);
    const releaseNormalizer = parent.reserve(128 * MiB), normalizer = new PortableWorkBudget(128 * MiB);
    try {
      await normalizePortableChatHistoryTwoPass(f.source, async () => textPolicy, normalizer, { append: async (input, raw) => {
        let header = input, bytes = raw;
        if (options.rewrite && header.entry.kind === 'historical_text' && header.entry.purpose === 'portable_metadata') {
          const value = JSON.parse(new TextDecoder().decode(bytes)); options.rewrite(value);
          bytes = new TextEncoder().encode(JSON.stringify(value)); header = { ...header, bytes: bytes.length, sha256: await portableDigest(bytes) };
        }
        // Header graph, raw clone and source/oracle copies are acquired before retention.
        held.push(parent.reserve(8192 + bytes.length * 2));
        records.push({ header, bytes: bytes.slice() });
      } });
      expect(normalizer.used).toBe(0);
    } finally { releaseNormalizer(); }
    const index = new Map<string, number>();
    for (const record of records) {
      for (let offset = 0; offset < record.bytes.length || offset === 0; offset += 4093) {
        held.push(parent.reserve(8192 + Math.min(4093, record.bytes.length - offset)));
        index.set(`${record.header.ordinal}:${offset}`, fragments.length);
        fragments.push({ record: record.header, offset, bytes: record.bytes.subarray(offset, offset + 4093),
          targetUuid: record.header.entry.kind === 'association' ? null : `00000000-0000-4000-8000-${String(record.header.ordinal).padStart(12, '0')}` });
        if (!record.bytes.length) break;
      }
    }
    let reads = 0;
    const port: PortableArchivePort = { binding: { version: 1, importKey: 'synthetic-import', manifest: 'b'.repeat(64) }, profile: 'portable_chat_history_v1', records: records.length,
      async read(cursor, limit) {
        reads++;
        const start = cursor ? index.get(`${cursor.ordinal}:${cursor.offset}`) : 0;
        if (start === undefined) throw Error('invalid_cursor');
        const after = fragments[start + limit];
        return { fragments: fragments.slice(start, start + limit), next: after ? { ordinal: after.record.ordinal, offset: after.offset } : null };
      } };
    const releaseArena = parent.reserve(128 * MiB), budget = new ObservedBudget(128 * MiB);
    const archive = new PortableHistoryArchive(port, async () => textPolicy, budget);
    return { archive, budget, parent, port, records, fragments, textPolicy, reads: () => reads,
      async dispose() { archive.dispose(); expect(budget.used).toBe(0); f = undefined; records.length = 0; fragments.length = 0; index.clear(); releaseArena(); for (const release of held.reverse()) release(); releaseFixture(); expect(parent.used).toBe(0); } };
  } catch (error) { f = undefined; records.length = 0; fragments.length = 0; for (const release of held.reverse()) release(); releaseFixture(); throw error; }
}

test('same 300-message source opens and recovers under 128 MiB; projection keeps its independent tariff', async () => {
  const f = await measuredArchive({ large: true });
  try {
    expect(f.records).toHaveLength(6070); expect(f.records.filter(r => r.header.entry.kind === 'message')).toHaveLength(300);
    const metadata = f.records.filter(r => r.header.entry.kind === 'historical_text' && r.header.entry.purpose === 'portable_metadata');
    const oldUnits = metadata.reduce((n, r) => n + 512 + r.bytes.length * 256, 0);
    expect(oldUnits).toBe(265388800);
    console.log('archive_legacy_metadata_units', oldUnits);
    try { await f.archive.open(); } catch (error) { console.log('archive_open_refusal', JSON.stringify({ rejected: f.budget.rejected, parentPeak: f.parent.peak })); throw error; }
    const retained = f.budget.used;
    const original = f.records.find(r => r.bytes.length > 4_900_000)!;
    let resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { resume = r; }), ready = new Promise<void>(r => { reached = r; });
    const pending = f.archive.withRecord(original.header.ordinal, async bytes => {
      expect(new TextDecoder().decode(bytes).startsWith('RECOVERABLE_LARGE_ORIGINAL ')).toBe(true);
      expect(Buffer.compare(bytes, original.bytes)).toBe(0);
      reached(); await gate; expect(f.budget.used).toBeGreaterThan(retained);
    });
    await ready; const recoveryHeld = f.budget.used; expect(recoveryHeld).toBeGreaterThan(retained); resume(); await pending; expect(f.budget.used).toBe(retained);
    let projected = false;
    await expect(f.archive.withProjection(async () => { projected = true; })).rejects.toThrow('resource_limit');
    expect(projected).toBe(false); expect(f.budget.used).toBe(retained);
    const headersHeld = f.records.reduce((n, record) => n + 512 + JSON.stringify(record.header).length * 8, 0);
    const policyHeld = 512 + f.textPolicy.secrets.reduce((n, value) => n + value.length * 4 + 32, 0);
    console.log('archive_memory', JSON.stringify({ records: f.records.length, metadataRetained: retained - headersHeld - policyHeld, headersHeld, policyHeld, retained, peak: f.budget.peak, recoveryHeld, projectionRefusal: f.budget.rejected, parentPeak: f.parent.peak, parentLimit: f.parent.limit, arena: f.budget.limit }));
  } finally { await f.dispose(); }
}, 240000);

test('long canonical values and all admitted array slots survive; suspended projection owns its copies', async () => {
  const revision = 'r'.repeat(4097), message = 'm'.repeat(4097), timestamp = 'é🙂'.repeat(1500);
  const f = await measuredArchive({ revision, rewrite(value) {
    if (value.message === 'u') value.message = message;
    if (value.timestamp !== undefined) value.timestamp = timestamp;
    if (value.captureManifest) { value.sourceLimits = [...new Set([...vocabulary.sourceLimits, ...vocabulary.remainingLimits])]; value.remainingLimits = [...value.sourceLimits]; }
    if (value.source.family === 1 && value.source.tag === 9 && ['recognized_identical_text', 'provider_final_matches_attributed_message', 'provider_display_matches_attributed_message'].includes(value.reason)) value.source.path = [0, 'content', 0, 'text'];
  } });
  try {
    expect(f.records.some(record => record.header.entry.kind === 'historical_text' && record.header.entry.purpose === 'portable_metadata' && JSON.parse(new TextDecoder().decode(record.bytes)).source.path?.length === 4)).toBe(true);
    await f.archive.open(); const retained = f.budget.used;
    let resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { resume = r; }), ready = new Promise<void>(r => { reached = r; });
    const pending = f.archive.withProjection(async projection => { expect(projection.messages.some(m => m.content.includes('PROVIDER_ONLY_FACT'))).toBe(true); reached(); await gate; throw Error('cancelled_consumer'); });
    await ready; expect(f.budget.used).toBeGreaterThan(retained); resume(); await expect(pending).rejects.toThrow('cancelled_consumer'); expect(f.budget.used).toBe(retained);
    await f.archive.withProjection(async projection => { expect(projection.messages.some(m => m.content.includes('HIDDEN_ONLY_FACT'))).toBe(true); });
    console.log('archive_long_metadata', JSON.stringify({ revision: revision.length, message: message.length, timestamp: timestamp.length, retained, peak: f.budget.peak }));
  } finally { await f.dispose(); }
});

test('shape, Unicode, policy, integrity and insufficient admission refuse and clean retained metadata', async () => {
  for (const mode of ['shape', 'unicode', 'policy', 'integrity', 'budget'] as const) {
    const f = await measuredArchive({ rewrite(value) {
      if (value.source.ordinal > 5) {
        if (mode === 'shape') Object.assign(value, { ['foreign'.repeat(1000)]: 'x' });
        if (mode === 'unicode') value.policy = '\ud800';
        if (mode === 'policy') value.policy = 'stale-revision';
      }
    } });
    try {
      if (mode === 'integrity') f.records.find(record => record.header.entry.kind === 'historical_text' && record.header.entry.purpose === 'portable_metadata' && JSON.parse(new TextDecoder().decode(record.bytes)).source.ordinal > 5)!.bytes[0] ^= 1;
      if (mode === 'budget') {
        const tiny = new ObservedBudget(1), archive = new PortableHistoryArchive(f.port, async () => f.textPolicy, tiny);
        await expect(archive.open()).rejects.toThrow('resource_limit'); expect(f.reads()).toBe(0); expect(tiny.used).toBe(0);
        await f.archive.open(); const limit = f.budget.peak - 1; f.archive.dispose();
        const insufficient = new ObservedBudget(limit), constrained = new PortableHistoryArchive(f.port, async () => f.textPolicy, insufficient);
        await expect(constrained.open()).rejects.toThrow('resource_limit'); expect(insufficient.used).toBe(0); expect(insufficient.rejected).toBeDefined();
        constrained.dispose(); expect(insufficient.used).toBe(0);
      } else {
        await expect(f.archive.open()).rejects.toThrow(mode === 'shape' ? 'invalid_portable_shape' : mode === 'unicode' ? 'invalid_portable_unicode' : mode === 'policy' ? 'policy_changed' : 'integrity_failed');
        expect(f.budget.used).toBe(0);
      }
    } finally { await f.dispose(); }
  }
});
