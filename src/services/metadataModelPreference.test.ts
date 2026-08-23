import { beforeEach, describe, expect, it } from 'bun:test';

let importCounter = 0;

const loadService = async () => {
  importCounter += 1;
  return import(`./metadataModelPreference.ts?test=${importCounter}`);
};

describe('metadataModelPreference', () => {
  beforeEach(async () => {
    window.localStorage.removeItem('macro_metadataModelConfig');
    window.localStorage.removeItem('macro_smartCommitModelConfig');
    const { saveMetadataModelConfig } = await loadService();
    await saveMetadataModelConfig(null);
  });

  it('ignores the legacy smart commit model preference when metadata config is absent', async () => {
    window.localStorage.setItem(
      'macro_smartCommitModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-a',
        modelId: 'model-a',
        reasoningEffort: null,
      })
    );

    const { loadMetadataModelConfig } = await loadService();

    const config = await loadMetadataModelConfig();

    expect(config).toBeNull();
    expect(window.localStorage.getItem('macro_metadataModelConfig')).toBeNull();
  });

  it('prefers the JSON-backed metadata model preference over a legacy local value', async () => {
    window.localStorage.setItem(
      'macro_smartCommitModelConfig',
      JSON.stringify({ mode: 'conversation' })
    );
    const { loadMetadataModelConfig, saveMetadataModelConfig } = await loadService();
    await saveMetadataModelConfig({
      mode: 'dedicated',
      providerId: 'provider-b',
      modelId: 'model-b',
      reasoningEffort: null,
    });

    await expect(loadMetadataModelConfig()).resolves.toEqual({
      mode: 'dedicated',
      providerId: 'provider-b',
      modelId: 'model-b',
      reasoningEffort: null,
    });
  });
});
