import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { notify } from "../components/ui/toastService";
import { loadPreference, PREF_KEYS, savePreference } from "../services/preferences";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  resolveSupportedLanguage,
  type SupportedLanguage,
} from "./languages";
import { baseResources, loadTranslation } from "./resources";

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

const ensureLanguageResources = async (language: SupportedLanguage): Promise<void> => {
  if (i18n.hasResourceBundle(language, "translation")) {
    return;
  }

  const translation = await loadTranslation(language);
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

export const initializeI18n = (): Promise<void> => {
  if (initializationPromise) {
    return initializationPromise;
  }

  const currentInitialization = (async () => {
    const initialLanguage = await resolveInitialLanguage();
    await ensureLanguageResources(DEFAULT_LANGUAGE);

    if (initialLanguage !== DEFAULT_LANGUAGE) {
      await ensureLanguageResources(initialLanguage);
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

export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  await ensureLanguageResources(lang);
  await i18n.changeLanguage(lang);

  try {
    const languageName = SUPPORTED_LANGUAGES[lang].nativeName;
    notify.success(i18n.t("toast.languageChanged", { language: languageName }));
  } catch {
    // Toast not available.
  }

  try {
    await savePreference(PREF_KEYS.LANGUAGE, lang);
  } catch {
    // La langue active reste utilisable pour la session si l’écriture échoue.
  }
}

export async function applyConfiguredLanguage(lang: SupportedLanguage): Promise<void> {
  await ensureLanguageResources(lang);
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
