import { describe, expect, it } from 'bun:test';
import { SUPPORTED_LANGUAGE_CODES } from './languages';
import { loadTranslation } from './resources';

const REQUIRED_UI_KEYS = [
  'startup.metadataRecovery.restoredWithCommit',
  'startup.metadataRecovery.restored',
  'startup.metadataRecovery.restoredDescription',
  'startup.metadataRecovery.reconstructed',
  'startup.metadataRecovery.reconstructedDescription',
  'startup.metadataRecovery.skipped',
  'startup.metadataRecovery.blockedConflictDescription',
  'startup.metadataRecovery.blockedDirtyDescription',
  'notifications.mcpServersUnavailable',
] as const;

const readTranslationKey = (translation: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return (value as Record<string, unknown>)[segment];
  }, translation);

describe('UI audit translation keys', () => {
  it('defines metadata recovery and MCP warning text in every supported locale', async () => {
    for (const language of SUPPORTED_LANGUAGE_CODES) {
      const translation = await loadTranslation(language);

      for (const key of REQUIRED_UI_KEYS) {
        const value = readTranslationKey(translation, key);
        expect(typeof value).toBe('string');
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the French recovery and MCP messages properly accented', async () => {
    const french = await loadTranslation('fr');

    expect(readTranslationKey(french, 'startup.metadataRecovery.restored')).toContain(
      'Métadonnées'
    );
    expect(readTranslationKey(french, 'startup.metadataRecovery.skipped')).toContain(
      'Récupération'
    );
    expect(readTranslationKey(french, 'notifications.mcpServersUnavailable')).toContain(
      'indisponibles'
    );
  });
});
