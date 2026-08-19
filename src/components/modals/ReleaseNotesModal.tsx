import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppVersion } from '../../hooks/useAppVersion';
import {
  loadPreference,
  PREF_KEYS,
  savePreference,
  subscribePreference,
} from '../../services/preferences';
import {
  getReleaseNote,
  normalizeSeenReleaseNoteVersions,
  shouldShowReleaseNote,
} from '../../services/releaseNotes';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import {
  hasFinishedCurrentOnboarding,
  type OnboardingPreferenceState,
} from '../onboarding/onboardingPreference';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

export interface ReleaseNotesModalProps {
  enabled: boolean;
}

export const ReleaseNotesModal: React.FC<ReleaseNotesModalProps> = ({ enabled }) => {
  const { t, i18n } = useTranslation();
  const appVersion = useAppVersion();
  const note = useMemo(
    () => getReleaseNote(appVersion, i18n.resolvedLanguage ?? i18n.language),
    [appVersion, i18n.language, i18n.resolvedLanguage],
  );
  const [isOpen, setIsOpen] = useState(false);
  const [seenVersions, setSeenVersions] = useState<string[]>([]);
  const [isReady, setIsReady] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let onboardingFinished = false;
    let loadedSeenVersions: string[] = [];
    let preferencesLoaded = false;

    const refreshVisibility = () => {
      if (cancelled || !preferencesLoaded || !onboardingFinished) return;
      setSeenVersions(loadedSeenVersions);
      setIsReady(true);
      setIsOpen(shouldShowReleaseNote(note, loadedSeenVersions));
    };

    const unsubscribe = subscribePreference<OnboardingPreferenceState>(
      PREF_KEYS.ONBOARDING_STATE,
      (state) => {
        onboardingFinished = hasFinishedCurrentOnboarding(state);
        refreshVisibility();
      },
    );

    void Promise.all([
      loadPreference<unknown>(PREF_KEYS.RELEASE_NOTES_SEEN_VERSIONS),
      loadPreference<OnboardingPreferenceState>(PREF_KEYS.ONBOARDING_STATE),
    ]).then(([persistedSeenVersions, onboardingState]) => {
      if (cancelled) return;
      loadedSeenVersions = normalizeSeenReleaseNoteVersions(persistedSeenVersions);
      onboardingFinished = hasFinishedCurrentOnboarding(onboardingState);
      preferencesLoaded = true;
      refreshVisibility();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, note]);

  const close = useCallback(() => {
    if (!note) {
      setIsOpen(false);
      return;
    }

    const nextSeenVersions = Array.from(new Set([...seenVersions, note.version]));
    setSeenVersions(nextSeenVersions);
    setIsOpen(false);
    void savePreference(PREF_KEYS.RELEASE_NOTES_SEEN_VERSIONS, nextSeenVersions);
  }, [note, seenVersions]);

  if (!enabled || !isReady || !isOpen || !note) return null;

  return (
    <Dialog
      title={t('releaseNotes.dialogTitle', 'What’s new in Macro')}
      onClose={close}
      initialFocusRef={closeButtonRef}
      backdropClassName="fixed inset-0 z-[12000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm animate-fade-in md:p-6"
    >
      <article
        data-testid="release-notes-modal"
        className="flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl ring-1 ring-white/5"
      >
        <header className="relative shrink-0 overflow-hidden border-b border-border px-5 py-5 sm:px-7 sm:py-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgb(var(--primary)/0.16),transparent_48%)]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-sm">
                <Icon name="sparkles" size={20} />
              </div>
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                    {note.eyebrow}
                  </span>
                  <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    v{note.version}
                  </span>
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                  {note.title}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {note.summary}
                </p>
              </div>
            </div>

            <button
              type="button"
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
              onClick={close}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <MarkdownRenderer
            content={note.content}
            className="release-notes-markdown mx-auto max-w-2xl"
          />
        </div>

        <footer className="flex shrink-0 flex-col gap-3 border-t border-border bg-background/35 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p className="text-xs text-muted-foreground">
            {t(
              'releaseNotes.shownOnce',
              'This note is shown once for each installed version.',
            )}
          </p>
          <Button ref={closeButtonRef} type="button" size="sm" onClick={close}>
            {t('releaseNotes.continue', 'Continue to Macro')}
          </Button>
        </footer>
      </article>
    </Dialog>
  );
};

export default ReleaseNotesModal;
