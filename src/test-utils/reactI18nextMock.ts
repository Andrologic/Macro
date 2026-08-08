import { mock } from 'bun:test';
import React from 'react';

type InterpolationValues = Record<string, string | number | boolean | null | undefined>;

export interface TranslationMock {
  t: (
    key: string,
    fallbackOrOptions?: string | { defaultValue?: string } & InterpolationValues,
    maybeOptions?: { defaultValue?: string } & InterpolationValues
  ) => string;
}

const interpolate = (template: string, values?: InterpolationValues): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, token) => String(values?.[token] ?? `{{${token}}}`));

export const createTranslationMock = (
  explicitTranslations: Record<string, string> = {}
): TranslationMock => ({
  t: (key, fallbackOrOptions, maybeOptions) => {
    if (key in explicitTranslations) {
      return interpolate(explicitTranslations[key]!, maybeOptions as InterpolationValues);
    }
    if (typeof fallbackOrOptions === 'string') {
      return interpolate(fallbackOrOptions, maybeOptions as InterpolationValues);
    }
    return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
  },
});

export const installReactI18nextMock = (translationMock = createTranslationMock()): void => {
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      ...translationMock,
      i18n: {
        language: 'en',
        changeLanguage: mock(() => Promise.resolve()),
      },
    }),
    initReactI18next: {
      type: '3rdParty',
      init: mock(() => undefined),
    },
    Trans: passthrough,
    I18nextProvider: passthrough,
    Translation: ({ children }: { children: (t: TranslationMock['t']) => React.ReactNode }) =>
      React.createElement(React.Fragment, null, children(translationMock.t)),
  }));
};
