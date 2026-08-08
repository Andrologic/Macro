import type { SupportedLanguage } from "./languages";
import type en from "./locales/en.json";
import type enImplement from "./locales/segments/implement-en.json";

export type TranslationSchema = typeof en & {
  implement: typeof enImplement;
};

export const baseResources = {};

const mergeTranslation = (
  base: typeof en,
  implement: typeof enImplement,
): TranslationSchema => ({
  ...base,
  implement,
});

const translationLoaders: Record<SupportedLanguage, () => Promise<TranslationSchema>> = {
  en: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/en.json"),
      import("./locales/segments/implement-en.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
  fr: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/fr.json"),
      import("./locales/segments/implement-fr.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
  es: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/es.json"),
      import("./locales/segments/implement-es.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
  de: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/de.json"),
      import("./locales/segments/implement-de.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
  ja: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/ja.json"),
      import("./locales/segments/implement-ja.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
  ko: async () => {
    const [base, implement] = await Promise.all([
      import("./locales/ko.json"),
      import("./locales/segments/implement-ko.json"),
    ]);
    return mergeTranslation(base.default, implement.default);
  },
};

export const loadTranslation = (language: SupportedLanguage): Promise<TranslationSchema> =>
  translationLoaders[language]();
