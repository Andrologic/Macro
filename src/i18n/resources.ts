import type { SupportedLanguage } from "./languages";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

export type TranslationSchema = typeof en;

export const resources = {
  en: { translation: en },
  fr: { translation: fr satisfies TranslationSchema },
  es: { translation: es satisfies TranslationSchema },
  de: { translation: de satisfies TranslationSchema },
  ja: { translation: ja satisfies TranslationSchema },
  ko: { translation: ko satisfies TranslationSchema },
} satisfies Record<SupportedLanguage, { translation: TranslationSchema }>;
