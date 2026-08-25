import { describe, expect, it } from 'bun:test';
import type { MetadataModelConfig } from '../../../../services/metadataModelConfig';
import { MetadataModelConfigPersistence } from './metadataModelConfigPersistence';

const config = (modelId: string): MetadataModelConfig => ({
  mode: 'dedicated',
  providerId: 'provider-a',
  modelId,
  reasoningEffort: null,
});

describe('MetadataModelConfigPersistence', () => {
  it('keeps the latest selection when an older serialized save echoes afterwards', async () => {
    const applied: Array<MetadataModelConfig | null> = [];
    let releaseFirstSave: () => void = () => undefined;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCount = 0;
    let persistence: MetadataModelConfigPersistence;
    persistence = new MetadataModelConfigPersistence({
      save: async (value) => {
        saveCount += 1;
        if (saveCount === 1) await firstSave;
        persistence.acceptExternal(value);
      },
      applyConfig: (value) => applied.push(value),
      onSaveError: () => undefined,
    });

    const older = persistence.persist(config('model-b'));
    const latest = persistence.persist(config('model-c'));
    releaseFirstSave();
    await Promise.all([older, latest]);

    expect(applied.at(-1)).toEqual(config('model-c'));
  });

  it('accepts an external update after the current local save rejects', async () => {
    const applied: Array<MetadataModelConfig | null> = [];
    const persistence = new MetadataModelConfigPersistence({
      save: async () => {
        throw new Error('preference write failed');
      },
      applyConfig: (value) => applied.push(value),
      onSaveError: () => undefined,
    });
    persistence.hydrate(config('model-a'), persistence.getVersion());

    await persistence.persist(config('model-c'));
    expect(applied.at(-1)).toEqual(config('model-a'));

    expect(persistence.acceptExternal({ mode: 'conversation' })).toBe(true);
    expect(applied.at(-1)).toEqual({ mode: 'conversation' });
  });
});
