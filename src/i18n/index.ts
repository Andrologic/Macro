import type { LifecycleContext } from '../types/lifecycle';
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { reportLanguageChange } from "./languageNotifications";
import { loadPreference, PREF_KEYS, savePreference } from "../services/preferences";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  resolveSupportedLanguage,
  type SupportedLanguage,
} from "./languages";
import { baseResources, loadTranslation } from "./resources";
import { createSerialQueue } from "../services/serialQueue";

const syncDocumentLanguage = (language: string | null | undefined) => {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = resolveSupportedLanguage(language, DEFAULT_LANGUAGE);
};

const resolveInitialLanguage = async (): Promise<SupportedLanguage> =>
  resolveSupportedLanguage(
    await loadPreference<string>(PREF_KEYS.LANGUAGE),
    DEFAULT_LANGUAGE,
  );

const ensureLanguageResources = async (language: SupportedLanguage, context?: LifecycleContext): Promise<void> => {
  context?.assertActive();
  if (i18n.hasResourceBundle(language, "translation")) {
    return;
  }

  const translation = await loadTranslation(language);
  context?.assertActive();
  i18n.addResourceBundle(language, "translation", translation, true, true);
};

i18n
  .use(initReactI18next)
  .init({
    resources: baseResources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    showSupportNotice: false,
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    lowerCaseLng: true,
    cleanCode: true,
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

let initializationPromise: Promise<void> | null = null;
const enqueueLanguageChange = createSerialQueue();

export const initializeI18n = (context?: LifecycleContext): Promise<void> => {
  context?.assertActive();
  if (initializationPromise) {
    return initializationPromise;
  }

  const currentInitialization = (async () => {
    const initialLanguage = await resolveInitialLanguage();
    context?.assertActive();
    await ensureLanguageResources(DEFAULT_LANGUAGE, context);
    context?.assertActive();

    if (initialLanguage !== DEFAULT_LANGUAGE) {
      await ensureLanguageResources(initialLanguage, context);
      context?.assertActive();
      await i18n.changeLanguage(initialLanguage);
    } else {
      await i18n.changeLanguage(DEFAULT_LANGUAGE);
      syncDocumentLanguage(DEFAULT_LANGUAGE);
    }
  })();
  initializationPromise = currentInitialization;
  void currentInitialization.catch(() => {
    if (initializationPromise === currentInitialization) {
      initializationPromise = null;
    }
  });

  return currentInitialization;
};

i18n.on("languageChanged", (language) => {
  syncDocumentLanguage(language);
});
syncDocumentLanguage(i18n.resolvedLanguage || i18n.language || DEFAULT_LANGUAGE);

export function changeLanguage(lang: SupportedLanguage): Promise<void> {
  return enqueueLanguageChange(async () => {
    await ensureLanguageResources(lang);
    await i18n.changeLanguage(lang);

    const languageName = SUPPORTED_LANGUAGES[lang].nativeName;
    reportLanguageChange(i18n.t("toast.languageChanged", { language: languageName }));

    try {
      await savePreference(PREF_KEYS.LANGUAGE, lang);
    } catch {
      // La langue active reste utilisable pour la session si l’écriture échoue.
    }
  });
}

export async function applyConfiguredLanguage(lang: SupportedLanguage, context?: LifecycleContext): Promise<void> {
  await ensureLanguageResources(lang, context);
  context?.assertActive();
  if (i18n.resolvedLanguage !== lang) {
    await i18n.changeLanguage(lang);
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
