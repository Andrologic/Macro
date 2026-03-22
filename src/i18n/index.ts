import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  resolveSupportedLanguage,
  type SupportedLanguage,
} from "./languages";
import { resources } from "./resources";

const syncDocumentLanguage = (language: string | null | undefined) => {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = resolveSupportedLanguage(language, DEFAULT_LANGUAGE);
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    lowerCaseLng: true,
    cleanCode: true,
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "macro_language",
      caches: ["localStorage"],
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

i18n.on("languageChanged", (language) => {
  syncDocumentLanguage(language);
});
syncDocumentLanguage(i18n.resolvedLanguage || i18n.language);

export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  await i18n.changeLanguage(lang);

  try {
    const { toast } = await import("../components/ui/Toaster");
    const languageName = SUPPORTED_LANGUAGES[lang].nativeName;
    toast.success(i18n.t("toast.languageChanged", { language: languageName }));
  } catch {
    // Toast not available.
  }

  try {
    const { savePreference, PREF_KEYS } = await import(
      "../services/preferences"
    );
    await savePreference(PREF_KEYS.LANGUAGE, lang);
  } catch {
    // localStorage persistence remains as fallback.
  }
}

export {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  resolveSupportedLanguage,
};
export type { SupportedLanguage };

export default i18n;
