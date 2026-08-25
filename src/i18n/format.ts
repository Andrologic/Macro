import i18n from "./index";
import {
  DEFAULT_LANGUAGE,
  resolveSupportedLanguage,
  type SupportedLanguage,
} from "./languages";

const asDate = (value: Date | string | number): Date =>
  value instanceof Date ? value : new Date(value);

export const getActiveLocale = (
  language: string | null | undefined = i18n.resolvedLanguage || i18n.language
): SupportedLanguage => resolveSupportedLanguage(language, DEFAULT_LANGUAGE);

export const compareLocalized = (
  left: string,
  right: string,
  language: string | null | undefined = getActiveLocale(),
  options?: Intl.CollatorOptions
): number =>
  left.localeCompare(right, getActiveLocale(language), {
    sensitivity: "base",
    ...options,
  });

export const formatDate = (
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  language: string | null | undefined = getActiveLocale()
): string => {
  const date = asDate(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(getActiveLocale(language), options).format(date);
};

export const formatRelativeTimeShort = (
  value: Date | string | number,
  now = Date.now(),
  language: string | null | undefined = getActiveLocale()
): string => {
  const date = asDate(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const deltaSeconds = Math.round((date.getTime() - now) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(getActiveLocale(language), {
    numeric: "auto",
    style: "short",
  });

  if (absoluteSeconds < 5) return formatter.format(0, "second");
  if (absoluteSeconds < 60) return formatter.format(deltaSeconds, "second");

  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");

  const deltaDays = Math.round(deltaHours / 24);
  return formatter.format(deltaDays, "day");
};
