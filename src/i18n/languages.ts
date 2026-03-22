export interface LanguageMetadata {
  code: SupportedLanguage;
  nativeName: string;
  englishName: string;
  flag: string;
}

export type SupportedLanguage = "en" | "fr" | "es" | "de" | "ja" | "ko";

export const SUPPORTED_LANGUAGE_METADATA = [
  { code: "en", nativeName: "English", englishName: "English", flag: "🇬🇧" },
  { code: "fr", nativeName: "Français", englishName: "French", flag: "🇫🇷" },
  { code: "es", nativeName: "Español", englishName: "Spanish", flag: "🇪🇸" },
  { code: "de", nativeName: "Deutsch", englishName: "German", flag: "🇩🇪" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", flag: "🇯🇵" },
  { code: "ko", nativeName: "한국어", englishName: "Korean", flag: "🇰🇷" },
] as const satisfies readonly LanguageMetadata[];

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGE_METADATA.map(
  (language) => language.code
) as SupportedLanguage[];

export const SUPPORTED_LANGUAGES = Object.fromEntries(
  SUPPORTED_LANGUAGE_METADATA.map((language) => [language.code, language])
) as Record<SupportedLanguage, (typeof SUPPORTED_LANGUAGE_METADATA)[number]>;

export const isSupportedLanguage = (
  value: string | null | undefined
): value is SupportedLanguage =>
  Boolean(value) && SUPPORTED_LANGUAGE_CODES.includes(value as SupportedLanguage);

export const resolveSupportedLanguage = (
  value: string | null | undefined,
  fallback: SupportedLanguage = DEFAULT_LANGUAGE
): SupportedLanguage => {
  if (!value) return fallback;

  const normalized = value.trim().toLowerCase();
  if (isSupportedLanguage(normalized)) {
    return normalized;
  }

  const baseCode = normalized.split("-")[0];
  return isSupportedLanguage(baseCode) ? baseCode : fallback;
};
