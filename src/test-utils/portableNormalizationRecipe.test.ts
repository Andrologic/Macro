import { expect, test } from 'bun:test';
import { open, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePortableChatHistoryTwoPass } from '../services/ai/portableChatHistory';
import { PortableWorkBudget } from '../services/ai/portableHistoryInspection';
import { policy } from '../services/ai/portableHistoryFixtures.testSupport';
import { readNativeSourceSpool, readNativeTargetSpool } from './portableNormalizationRecipe';
const root = process.env.MACRO_PORTABLE_NORMALIZATION_DIR;
test.skipIf(!root || process.env.MACRO_PORTABLE_NORMALIZATION_PHASE !== 'normalize')('portable normalization uses immutable native readback in two matching passes', async () => {
  const measures: unknown[] = [];
  for (const provider of ['codex', 'macro-ai']) {
    const budget = new PortableWorkBudget(1024 * 1024 * 1024);
    const source = await readNativeSourceSpool(join(root!, `source-${provider}.ndjson`), budget);
    try {
    let splitUtf8Boundary = false;
    const releaseProbe = budget.reserve(65536);
    try {
      for await (const row of source.source.rows()) {
        const long = row.fields.find(field => field.bytes === 4_900_000); if (!long) continue;
        let checked = 0;
        for await (const chunk of source.source.read(long)) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(chunk); } catch { splitUtf8Boundary = true; }
          if (++checked === 6) break;
        }
        break;
      }
      expect(splitUtf8Boundary).toBe(true);
    } finally { releaseProbe(); }
    const path = join(root!, `normalized-${provider}.ndjson`), output = await open(path, 'wx', 0o600);
    // Test-only disk allowance, independent of native E and of JS working units.
    const spoolAllowance = 128 * 1024 * 1024;
    const started = performance.now(); let spoolBytes = 0, fragments = 0, maxLineBytes = 0;
    try {
      const result = await normalizePortableChatHistoryTwoPass(source.source, async () => policy, budget, { append: async (header, bytes) => {
        const write = async (offset: number, chunk: Uint8Array) => {
          const line = JSON.stringify({ header, offset, data: Buffer.from(chunk).toString('base64') }) + '\n';
          const length = Buffer.byteLength(line); expect(length).toBeLessThanOrEqual(8192);
          expect(spoolBytes + length).toBeLessThanOrEqual(spoolAllowance);
          maxLineBytes = Math.max(maxLineBytes, length); spoolBytes += length; fragments++; await output.write(line);
        };
        if (!bytes.length) await write(0, bytes);
        for (let offset = 0; offset < bytes.length; offset += 4093) await write(offset, bytes.subarray(offset, offset + 4093));
      } });
      measures.push({ source: provider, splitUtf8Boundary, ...source.stats, ...result, normalizedSpoolBytes: spoolBytes, normalizedFragments: fragments, maxNormalizedLineBytes: maxLineBytes, elapsedMs: performance.now() - started, logicalWorkPeak: budget.peak, logicalWorkAdmissions: budget.admissions });
    } catch (error) { await output.close(); await unlink(path); throw error; }
    finally { await output.close(); }
    } finally { source.dispose(); expect(budget.used).toBe(0); }
  }
  await writeFile(join(root!, 'normalization-measures.json'), JSON.stringify(measures, null, 2), { mode: 0o600 });
}, 180_000);

test.skipIf(!root || process.env.MACRO_PORTABLE_NORMALIZATION_PHASE !== 'validate-source')('complete captured checkpoint refuses a missing source message or citation before target writes', async () => {
  for (const missing of ['message', 'citation']) {
    const budget = new PortableWorkBudget(1024 * 1024 * 1024);
    const native = await readNativeSourceSpool(join(root!, 'source-codex.ndjson'), budget);
    let writes = 0;
    try {
      let omitted = -1;
      for await (const row of native.source.rows()) {
        if (row.family !== (missing === 'message' ? 1 : 6)) continue;
        const field = row.fields[0], bytes = new Uint8Array(field.bytes); let offset = 0;
        for await (const chunk of native.source.read(field)) { bytes.set(chunk, offset); offset += chunk.length; }
        if (new TextDecoder().decode(bytes) === (missing === 'message' ? 'u001' : 'used-citation')) omitted = row.row;
      }
      expect(omitted).toBeGreaterThan(-1);
      const source = { ...native.source, async *rows() { for await (const row of native.source.rows()) if (row.row !== omitted) yield row; } };
      await expect(normalizePortableChatHistoryTwoPass(source, async () => policy, budget, { append: async () => { writes++; } })).rejects.toThrow('checkpoint_source_missing');
      expect(writes).toBe(0);
    } finally { native.dispose(); expect(budget.used).toBe(0); }
  }
}, 180_000);

test('private NDJSON bridge refuses oversized and unterminated frames before a complete line is assembled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portable-framing-'));
  try {
    for (const [name, value, error] of [['long', 'x'.repeat(20000) + '\n', 'fixture_frame_too_large'], ['unfinished', '{}', 'incomplete_fixture_frame']]) {
      const path = join(dir, name); await writeFile(path, value, { mode: 0o600 });
      const budget = new PortableWorkBudget(1024 * 1024);
      await expect(readNativeTargetSpool(path, budget)).rejects.toThrow(error); expect(budget.used).toBe(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
