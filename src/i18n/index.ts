/**
 * i18n Configuration
 *
 * Internationalization setup with react-i18next.
 * Supports language detection and persistence.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Import translation resources
import en from "./locales/en.json";
import fr from "./locales/fr.json";

// Supported languages
export const SUPPORTED_LANGUAGES = {
  en: { nativeName: "English", flag: "🇬🇧" },
  fr: { nativeName: "Français", flag: "🇫🇷" },
  // Future languages can be added here:
  // es: { nativeName: "Español", flag: "🇪🇸" },
  // de: { nativeName: "Deutsch", flag: "🇩🇪" },
  // ja: { nativeName: "日本語", flag: "🇯🇵" },
  // zh: { nativeName: "中文", flag: "🇨🇳" },
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;

// Translation resources
const resources = {
  en: { translation: en },
  fr: { translation: fr },
};

// Initialize i18next
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),

    // Language detection options
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "macro_language",
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false, // React already escapes
    },

    // React specific options
    react: {
      useSuspense: false, // Disable suspense to avoid loading states
    },
  });

// Helper to change language and persist
export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  await i18n.changeLanguage(lang);
  
  // Show toast notification
  try {
    const { toast } = await import("../components/ui/Toaster");
    const languageName = SUPPORTED_LANGUAGES[lang].nativeName;
    toast.success(i18n.t("toast.languageChanged", { language: languageName }));
  } catch {
    // Toast not available
  }

  // Also save to Tauri store if available
  try {
    const { savePreference, PREF_KEYS } = await import(
      "../services/preferences"
    );
    await savePreference(PREF_KEYS.LANGUAGE, lang);
  } catch {
    // Fallback already handled by i18next localStorage detection
  }
}

export default i18n;
