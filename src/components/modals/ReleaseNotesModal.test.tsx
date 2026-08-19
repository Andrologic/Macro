import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OnboardingPreferenceState } from '../onboarding/onboardingPreference';

const preferenceKeys = {
  ONBOARDING_STATE: 'onboardingState',
  RELEASE_NOTES_SEEN_VERSIONS: 'releaseNotesSeenVersions',
} as const;

let onboardingState: OnboardingPreferenceState;
let seenVersions: string[];
let onboardingListener: ((value: OnboardingPreferenceState) => void) | null;
const savePreferenceMock = mock(async (_key: string, _value: unknown) => undefined);

mock.module('../../hooks/useAppVersion', () => ({
  useAppVersion: () => '0.1.0',
}));

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'fr', resolvedLanguage: 'fr-FR' },
  }),
}));

mock.module('../../services/preferences', () => ({
  PREF_KEYS: preferenceKeys,
  loadPreference: async (key: string) =>
    key === preferenceKeys.ONBOARDING_STATE ? onboardingState : seenVersions,
  savePreference: savePreferenceMock,
  subscribePreference: (
    key: string,
    listener: (value: OnboardingPreferenceState) => void,
  ) => {
    if (key === preferenceKeys.ONBOARDING_STATE) onboardingListener = listener;
    return () => {
      onboardingListener = null;
    };
  },
}));

const releaseNotesModulePath = './ReleaseNotesModal.tsx?release-notes-modal-tests';
const { default: ReleaseNotesModal } = await import(releaseNotesModulePath);

describe('ReleaseNotesModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    onboardingState = {
      version: 1,
      completedAt: '2026-08-19T00:00:00.000Z',
      dismissedAt: null,
      lastStepId: 'finish',
    };
    seenVersions = [];
    onboardingListener = null;
    savePreferenceMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderModal = async () => {
    await act(async () => {
      root.render(<ReleaseNotesModal enabled />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('shows the current localized note and remembers it when closed', async () => {
    await renderModal();

    const modal = document.querySelector('[data-testid="release-notes-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent ?? '').toContain('Macro 0.1 est prêt');

    const continueButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continue to Macro',
    );
    expect(continueButton).toBeDefined();

    await act(async () => continueButton?.click());

    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();
    expect(savePreferenceMock).toHaveBeenCalledWith(
      preferenceKeys.RELEASE_NOTES_SEEN_VERSIONS,
      ['0.1.0'],
    );
  });

  it('does not show a note that has already been seen', async () => {
    seenVersions = ['0.1.0'];
    await renderModal();

    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();
  });

  it('waits until onboarding is completed or dismissed', async () => {
    onboardingState = {
      version: 1,
      completedAt: null,
      dismissedAt: null,
      lastStepId: 'welcome',
    };
    await renderModal();
    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();

    await act(async () => {
      onboardingListener?.({
        ...onboardingState,
        dismissedAt: '2026-08-19T00:00:00.000Z',
      });
    });

    expect(document.querySelector('[data-testid="release-notes-modal"]')).not.toBeNull();
  });
});
