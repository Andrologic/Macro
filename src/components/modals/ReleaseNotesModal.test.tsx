import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OnboardingPreferenceState } from '../onboarding/onboardingPreference';

const preferenceKeys = {
  ONBOARDING_STATE: 'onboardingState',
  RELEASE_NOTES_SEEN_VERSIONS: 'releaseNotesSeenVersions',
  RELEASE_NOTES_PENDING_UPDATE: 'releaseNotesPendingUpdate',
} as const;

let onboardingState: OnboardingPreferenceState;
let seenVersions: string[];
let pendingUpdateNote: unknown;
let onboardingListener: ((value: OnboardingPreferenceState) => void) | null;
let currentAppVersion: string;
const savePreferenceMock = mock(async (_key: string, _value: unknown) => undefined);

mock.module('../../hooks/useAppVersion', () => ({
  useAppVersion: () => currentAppVersion,
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
    key === preferenceKeys.ONBOARDING_STATE
      ? onboardingState
      : key === preferenceKeys.RELEASE_NOTES_PENDING_UPDATE
        ? pendingUpdateNote
        : seenVersions,
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
    pendingUpdateNote = null;
    currentAppVersion = '0.1.1';
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

  const closeButton = (): HTMLButtonElement | null =>
    document.querySelector('button[aria-label="Close"]');

  it('shows the current localized note and remembers it when closed', async () => {
    await renderModal();

    const modal = document.querySelector('[data-testid="release-notes-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent ?? '').toContain('Release notes');
    expect(modal?.textContent ?? '').toContain('Macro 0.1.1');
    expect(modal?.textContent ?? '').toContain('Mises à jour automatiques');
    expect(modal?.textContent ?? '').toContain('Contexte et images');
    expect(modal?.textContent ?? '').not.toContain('Macro 0.1 est prêt');
    expect(modal?.textContent ?? '').not.toContain('Première version stable');
    expect(modal?.textContent ?? '').not.toContain(
      'Cette version pose le workflow desktop local-first',
    );
    expect(modal?.querySelector('.release-notes-markdown')).not.toBeNull();

    expect(modal?.querySelector('footer')).toBeNull();
    expect(closeButton()).not.toBeNull();

    await act(async () => closeButton()?.click());

    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();
    expect(savePreferenceMock).toHaveBeenCalledWith(
      preferenceKeys.RELEASE_NOTES_SEEN_VERSIONS,
      ['0.1.1'],
    );
  });

  it('does not show a note that has already been seen', async () => {
    seenVersions = ['0.1.1'];
    await renderModal();

    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();
  });

  it('shows release notes preserved by the updater and clears them after use', async () => {
    currentAppVersion = '0.2.0';
    pendingUpdateNote = {
      version: '0.2.0',
      content: '## Notes received from latest.json',
    };
    await renderModal();

    expect(document.body.textContent).toContain('Notes received from latest.json');
    await act(async () => closeButton()?.click());

    expect(savePreferenceMock).toHaveBeenCalledWith(
      preferenceKeys.RELEASE_NOTES_PENDING_UPDATE,
      null,
    );
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

  it('dismisses the note when the backdrop is clicked', async () => {
    await renderModal();

    const backdrop = document.querySelector<HTMLElement>('[data-macro-dialog-root]');
    expect(backdrop).not.toBeNull();

    await act(async () => backdrop?.click());

    expect(document.querySelector('[data-testid="release-notes-modal"]')).toBeNull();
    expect(savePreferenceMock).toHaveBeenCalledWith(
      preferenceKeys.RELEASE_NOTES_SEEN_VERSIONS,
      ['0.1.1'],
    );
  });
});
