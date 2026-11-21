import { describe, expect, it } from 'bun:test';
import { createInstance } from 'i18next';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';

describe('Git conflict count translation', () => {
  it('interpolates zero, one and multiple conflict files in English and French', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'fr', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } });
    expect(i18n.t('footer.sync.conflictedFiles', { count: 0 })).toBe('0 fichier en conflit');
    expect(i18n.t('footer.sync.conflictedFiles', { count: 1 })).toBe('1 fichier en conflit');
    expect(i18n.t('footer.sync.conflictedFiles', { count: 2 })).toBe('2 fichiers en conflit');
    await i18n.changeLanguage('en');
    expect(i18n.t('footer.sync.conflictedFiles', { count: 1 })).toBe('1 conflicted file');
    expect(i18n.t('footer.sync.conflictedFiles', { count: 2 })).toBe('2 conflicted files');
  });
});
