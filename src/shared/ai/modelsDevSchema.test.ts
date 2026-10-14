import { describe, expect, it } from 'bun:test';
import { parseModelsDevProviders } from './modelsDevSchema';

const catalog = (metadata: Record<string, unknown>) => ({
  provider: { models: { model: { limit: { context: 1000 }, ...metadata } } },
});

describe('modelsDevSchema metadata projection', () => {
  it('retains scoped display fields and discards unused modalities and pricing', () => {
    const parsed = parseModelsDevProviders(catalog({
      id: 'model', name: 'Model', description: 'Public description', family: 'family',
      tool_call: false, modalities: { input: ['text'], output: ['image'] }, cost: { input: 5 },
    }));
    expect(parsed?.provider?.models.model).toEqual({
      id: 'model', name: 'Model', description: 'Public description', family: 'family',
      limit: { context: 1000 }, tool_call: false, modalities: { input: ['text'] },
    });
  });

  it('keeps optional metadata unknown in old caches and historical fallbacks', () => {
    const model = parseModelsDevProviders(catalog({}))?.provider?.models.model;
    expect(model).toEqual({ limit: { context: 1000 } });
  });

  it.each([
    { name: 5 }, { name: '' }, { description: [] }, { family: false },
    { tool_call: 'true' }, { modalities: [] }, { modalities: { input: 'image' } },
    { modalities: { input: ['text', 1] } },
  ])('rejects malformed display metadata %j', (metadata) => {
    expect(parseModelsDevProviders(catalog(metadata))).toBeNull();
  });
});
