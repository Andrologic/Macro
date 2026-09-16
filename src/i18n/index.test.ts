import { afterEach, describe, expect, it, mock } from 'bun:test';

const loadTranslationMock = mock(async (_language: string) => ({}));
const savePreferenceMock = mock(async (_key: string, _value: string) => undefined);

mock.module('./resources', () => ({
  baseResources: {
    en: { translation: { toast: { languageChanged: 'Language changed' } } },
  },
  loadTranslation: loadTranslationMock,
}));

mock.module('../services/preferences', () => ({
  PREF_KEYS: { LANGUAGE: 'language' },
  loadPreference: mock(async () => 'en'),
  savePreference: savePreferenceMock,
}));

mock.module('../components/ui/toastService', () => ({
  notify: { success: mock(() => undefined) },
}));

let importCounter = 0;

describe('language changes', () => {
  afterEach(() => {
    mock.restore();
  });

  it('keeps the latest choice when an earlier translation load is slower', async () => {
    let releaseJapanese: ((translation: Record<string, unknown>) => void) | undefined;
    loadTranslationMock.mockClear();
    savePreferenceMock.mockClear();
    loadTranslationMock.mockImplementation(async (language) => {
      if (language === 'ja') {
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseJapanese = resolve;
        });
      }
      return { language };
    });
    importCounter += 1;
    const languageModule = await import(`./index.ts?language-order=${importCounter}`);
    languageModule.default.removeResourceBundle('ja', 'translation');
    languageModule.default.removeResourceBundle('ko', 'translation');

    const japanese = languageModule.changeLanguage('ja');
    const korean = languageModule.changeLanguage('ko');
    await Promise.resolve();
    await Promise.resolve();

    expect(loadTranslationMock.mock.calls.map((call) => call[0])).toEqual(['ja']);
    releaseJapanese?.({ language: 'ja' });
    await Promise.all([japanese, korean]);

    expect(languageModule.default.resolvedLanguage).toBe('ko');
    expect(savePreferenceMock.mock.calls.map((call) => call[1])).toEqual(['ja', 'ko']);
  });
});
