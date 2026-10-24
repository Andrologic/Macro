import { expect, test } from 'bun:test';
import { fixture, policy } from './portableHistoryFixtures.testSupport';
import { normalizePortableChatHistory, normalizePortableChatHistoryTwoPass, portableDigest } from './portableChatHistory';
import { PortableWorkBudget, measurePortableJson } from './portableHistoryInspection';
import { assistantProvenance } from '../macroPilot/assistantProvenance';
import { buildAssistantProviderInputItemsFromTurn, buildChatGptProviderTurnState, buildChatGptVisibleTurnContent } from './responsesCodec';
import { buildAssistantChatCompletionProviderItem } from './chatCompletionsCodec';
const MiB = 1024 * 1024;

test('escaped metadata refuses under the original 4 MiB before inspection encodings, JSON, digest or emission', async () => {
  const parent = new PortableWorkBudget(96 * MiB), releaseInputs = parent.reserve(16 * MiB), releaseChild = parent.reserve(4 * MiB);
  const stringify = JSON.stringify, encode = TextEncoder.prototype.encode;
  let serializations = 0, encodings = 0, emissions = 0, plans = 0;
  try {
    for (const provider of ['codex', 'macro-ai'] as const) {
      const f = await fixture(provider), revision = '\u0001'.repeat(MiB), budget = new PortableWorkBudget(4 * MiB);
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        if (args[0]?.normalizer === 'macro-portable-history-1') serializations++;
        return stringify(...args);
      }) as typeof JSON.stringify;
      TextEncoder.prototype.encode = function(value = '') { if (value.includes(revision)) encodings++; return encode.call(this, value); };
      try {
        await expect(normalizePortableChatHistoryTwoPass(f.source, async () => ({ revision, secrets: [] }), budget,
          { append: async () => { emissions++; } }, async () => { plans++; })).rejects.toThrow('resource_limit');
        expect(budget.used).toBe(0); expect(serializations).toBe(0); expect(encodings).toBe(0); expect(emissions).toBe(0); expect(plans).toBe(0);
      } finally { JSON.stringify = stringify; TextEncoder.prototype.encode = encode; }
    }
  } finally { JSON.stringify = stringify; TextEncoder.prototype.encode = encode; releaseChild(); releaseInputs(); expect(parent.used).toBe(0); }
});

test('admitted ASCII, Unicode and escaped metadata stays exact through a suspended sink, digest and replay', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const parent = new PortableWorkBudget(64 * MiB), releaseInputs = parent.reserve(32 * MiB), releaseChild = parent.reserve(8 * MiB);
    const revision = 'ASCII-"\\\b\t\n\u0001é🙂'.repeat(80), id = 'id-"\\\u0001é🙂', timestamp = 'date-\t2026-é🙂';
    const f = await fixture(provider, messages => { messages[0][0] = id; messages[0][5] = timestamp; });
    const budget = new PortableWorkBudget(8 * MiB), output: string[] = [];
    const stringify = JSON.stringify, digest = crypto.subtle.digest.bind(crypto.subtle);
    let expectedDigestUnits = 0, checkedDigest = false, checkedMetadata = 0;
    let resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { resume = r; }), ready = new Promise<void>(r => { reached = r; });
    try {
      // These oracle strings/graphs belong to releaseInputs, separately from the worker.
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        if (args[0]?.normalizer === 'macro-portable-history-1') {
          const oracle = stringify(...args), bytes = Buffer.byteLength(oracle);
          expect(budget.used).toBeGreaterThanOrEqual(oracle.length * 2 + bytes);
          if (!checkedMetadata++) expectedDigestUnits = oracle.length * 2 + bytes * 3;
        }
        return stringify(...args);
      }) as typeof JSON.stringify;
      crypto.subtle.digest = async (algorithm, data) => {
        if (expectedDigestUnits && !checkedDigest) { expect(budget.used).toBeGreaterThanOrEqual(expectedDigestUnits); checkedDigest = true; }
        return digest(algorithm, data);
      };
      const pending = normalizePortableChatHistory(f.source, async () => ({ ...policy, revision }), budget, { append: async (_header, bytes) => {
        const text = new TextDecoder().decode(bytes); output.push(text);
        if (output.length === 1) { const held = budget.used; reached(); await gate; expect(budget.used).toBe(held); }
      } });
      await Promise.race([ready, pending.then(() => { throw Error('sink_not_reached'); })]); expect(budget.used).toBeGreaterThan(0); resume();
      const first = await pending; expect(budget.used).toBe(0); expect(checkedDigest).toBe(true);
      JSON.stringify = stringify; crypto.subtle.digest = digest;
      const metadata = output.filter(text => text.startsWith('{"version":1,"normalizer"')).map(text => JSON.parse(text));
      expect(metadata.every(value => value.policy === revision)).toBe(true);
      expect(metadata.some(value => value.message === id && value.timestamp === timestamp)).toBe(true);
      const replay: string[] = [];
      const second = await normalizePortableChatHistory(f.source, async () => ({ ...policy, revision }), budget, { append: async (_h, bytes) => { replay.push(new TextDecoder().decode(bytes)); } });
      expect(second).toEqual(first); expect(replay).toEqual(output); expect(budget.used).toBe(0);
      console.log('admitted_metadata', JSON.stringify({ provider, revision_chars: revision.length, records: first.records, peak: budget.peak, budget: budget.limit }));
    } finally { resume?.(); JSON.stringify = stringify; crypto.subtle.digest = digest; output.length = 0; releaseChild(); releaseInputs(); expect(parent.used).toBe(0); }
  }
});

async function provenanceFixture(provider: 'codex' | 'macro-ai', final: string) {
  const f = await fixture(provider), visible = buildChatGptVisibleTurnContent(final, f.reflection);
  const message = f.rows.find(row => row.family === 1 && new TextDecoder().decode(f.data.get(row.fields[0].ordinal)) === 'a')!;
  const items = JSON.parse(new TextDecoder().decode(f.data.get(message.fields[9].ordinal)));
  const finalItems = buildAssistantProviderInputItemsFromTurn(final, []);
  items[items.length - 1] = provider === 'codex' ? finalItems[0] : buildAssistantChatCompletionProviderItem({ visibleContent: visible, apiContent: final, reasoningContent: f.reflection, reasoningDetails: [], toolCalls: [] });
  const receipts = new Map<string, string>();
  await assistantProvenance({ load: async key => receipts.get(key) ?? null, compareAndSwap: async (key, _old, value) => { receipts.set(key, value); return true; } }).recordFinal('a', visible, finalItems);
  const update = async (field: typeof message.fields[number], text: string) => {
    const bytes = new TextEncoder().encode(text); Object.assign(field, { bytes: bytes.length, sha256: await portableDigest(bytes) }); f.data.set(field.ordinal, bytes);
  };
  await update(message.fields[4], visible); await update(message.fields[9], JSON.stringify(items));
  if (provider === 'codex') await update(message.fields[10], JSON.stringify(buildChatGptProviderTurnState('local-session', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: f.reflection }], encrypted_content: 'synthetic-private-token' }, ...finalItems])));
  await update(f.rows.find(row => row.family === 2)!.fields[1], [...receipts.values()][0]);
  return { f, visible };
}

test('the real provenance fingerprint owns escaped display copies independently of its small receipt', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) for (const refused of [true, false]) {
    const parent = new PortableWorkBudget(256 * MiB), releaseInputs = parent.reserve(64 * MiB), releaseChild = parent.reserve(16 * MiB);
    const { f, visible } = await provenanceFixture(provider, '\u0001'.repeat(refused ? MiB : 4097));
    const budget = new PortableWorkBudget(16 * MiB), stringify = JSON.stringify;
    let fingerprints = 0, emitted = 0, planned = 0;
    try {
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        if (Array.isArray(args[0]) && args[0].length === 2 && args[0][0] === 'a' && args[0][1] === visible) {
          const oracle = stringify(...args), bytes = Buffer.byteLength(oracle);
          expect(budget.used).toBeGreaterThanOrEqual(oracle.length * 2 + bytes * 2); fingerprints++;
        }
        return stringify(...args);
      }) as typeof JSON.stringify;
      const pending = normalizePortableChatHistoryTwoPass(f.source, async () => policy, budget, { append: async () => { emitted++; } }, async () => { planned++; });
      if (refused) { await expect(pending).rejects.toThrow('resource_limit'); expect(fingerprints).toBe(0); expect(emitted).toBe(0); expect(planned).toBe(0); }
      else { await pending; expect(fingerprints).toBeGreaterThan(0); expect(emitted).toBeGreaterThan(0); expect(planned).toBe(1); }
      expect(budget.used).toBe(0);
    } finally { JSON.stringify = stringify; releaseChild(); releaseInputs(); expect(parent.used).toBe(0); }
  }
});

test('the reused JSON measure counts raw and escaped UTF8 separately without serializing a graph', () => {
  for (const value of ['plain', '\u0001"\\', 'é🙂', '\b\n\t', '\ud800', '\udfff']) {
    const measured = measurePortableJson(value), json = JSON.stringify(value);
    expect(measured.textBytes).toBe(new TextEncoder().encode(value).length); expect(measured.jsonBytes).toBe(Buffer.byteLength(json)); expect(measured.jsonChars).toBe(json.length);
  }
  let nested: unknown = Number('1e400');
  for (let depth = 0; depth < 64; depth++) nested = { value: nested };
  expect(measurePortableJson(nested).jsonBytes).toBe(Buffer.byteLength(JSON.stringify(nested)));
});
