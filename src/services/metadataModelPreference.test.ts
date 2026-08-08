import { afterEach, describe, expect, it } from 'bun:test';

let importCounter = 0;

const loadService = async () => {
  importCounter += 1;
  return import(`./metadataModelPreference.ts?test=${importCounter}`);
};

describe('metadataModelPreference', () => {
  afterEach(() => {
    window.localStorage.removeItem('macro_metadataModelConfig');
    window.localStorage.removeItem('macro_smartCommitModelConfig');
  });

  it('migrates the legacy smart commit model preference when metadata config is absent', async () => {
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

    expect(config).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: null,
    });
    expect(window.localStorage.getItem('macro_metadataModelConfig')).toContain('provider-a');
  });

  it('prefers the new metadata model preference over the legacy commit preference', async () => {
    window.localStorage.setItem(
      'macro_smartCommitModelConfig',
      JSON.stringify({ mode: 'conversation' })
    );
    window.localStorage.setItem(
      'macro_metadataModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-b',
        modelId: 'model-b',
        reasoningEffort: null,
      })
    );

    const { loadMetadataModelConfig } = await loadService();

    await expect(loadMetadataModelConfig()).resolves.toEqual({
      mode: 'dedicated',
      providerId: 'provider-b',
      modelId: 'model-b',
      reasoningEffort: null,
    });
  });
});
