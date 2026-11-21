import { expect, test } from 'bun:test';
import vectors from '../../../contracts/macro-pilot/v2/portable-chat-history/provider-vectors.json';
import { validatePortableProviderShape, validatePortableMetadata } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { recognizePortableProviderItems } from './portableProviderHistory';
import { MAX_TOOL_RESULT_BYTES } from '../../shared/toolResultContent';
import { fixture } from './portableHistoryFixtures.testSupport';

test.each(vectors)('canon and real producer recognizer agree on $name', vector => {
  if (vector.valid) {
    expect(() => validatePortableProviderShape(vector.value)).not.toThrow();
    expect(() => recognizePortableProviderItems(vector.value)).not.toThrow();
  } else {
    expect(() => validatePortableProviderShape(vector.value)).toThrow('unknown_required_shape');
    expect(() => recognizePortableProviderItems(vector.value)).toThrow('unknown_required_shape');
  }
});

test('every emitted origin satisfies closed canon; unknown reason/classification/path cannot hide required content', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const f = await fixture(provider); await f.run();
    const origins = f.output.filter(v => v.header.entry.kind === 'historical_text' && v.header.entry.purpose === 'portable_metadata').map(v => JSON.parse(v.text));
    expect(origins.length).toBeGreaterThan(30);
    for (const origin of origins) {
      expect(validatePortableMetadata(origin)).toEqual(origin);
      expect(() => validatePortableMetadata({ ...origin, reason: 'future_required_context' })).toThrow();
    }
    const data = origins.find(o => o.reason === 'provider_tool_call')!;
    for (const mutation of [
      { ...data, source: { ...data.source, path: ['private content pretending to be a path'] } },
      { ...data, classification: 'excluded_local_metadata', reason: 'local_operational_metadata', meaning: undefined },
      { ...data, meaning: 'message' },
    ]) expect(() => validatePortableMetadata(mutation)).toThrow();
    expect(f.budget.used).toBe(0);
  }
});

test('canonical typed-result compatibility keeps the existing ordinary codec byte allowance', () => { expect(MAX_TOOL_RESULT_BYTES).toBe(8 * 1024 * 1024); });
