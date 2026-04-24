import type { SupportedLanguage } from "./languages";
import type en from "./locales/en.json";

export type TranslationSchema = typeof en;

export const baseResources = {};

const translationLoaders: Record<SupportedLanguage, () => Promise<TranslationSchema>> = {
  en: async () => (await import("./locales/en.json")).default satisfies TranslationSchema,
  fr: async () => (await import("./locales/fr.json")).default satisfies TranslationSchema,
  es: async () => (await import("./locales/es.json")).default satisfies TranslationSchema,
  de: async () => (await import("./locales/de.json")).default satisfies TranslationSchema,
  ja: async () => (await import("./locales/ja.json")).default satisfies TranslationSchema,
  ko: async () => (await import("./locales/ko.json")).default satisfies TranslationSchema,
};

export const loadTranslation = (language: SupportedLanguage): Promise<TranslationSchema> =>
  translationLoaders[language]();
