import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppVersion } from '../../hooks/useAppVersion';
import {
  loadPreference,
  PREF_KEYS,
  savePreference,
  subscribePreference,
} from '../../services/preferences';
import {
  normalizePendingUpdateReleaseNote,
  normalizeSeenReleaseNoteVersions,
  resolveReleaseNote,
  shouldShowReleaseNote,
  type ReleaseNote,
} from '../../services/releaseNotes';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import {
  hasFinishedCurrentOnboarding,
  type OnboardingPreferenceState,
} from '../onboarding/onboardingPreference';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

export interface ReleaseNotesModalProps {
  enabled: boolean;
}

export const ReleaseNotesModal: React.FC<ReleaseNotesModalProps> = ({ enabled }) => {
  const { t, i18n } = useTranslation();
  const appVersion = useAppVersion();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [note, setNote] = useState<ReleaseNote | null>(null);
  const [pendingNoteVersion, setPendingNoteVersion] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [seenVersions, setSeenVersions] = useState<string[]>([]);
  const [isReady, setIsReady] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let onboardingFinished = false;
    let loadedSeenVersions: string[] = [];
    let loadedNote: ReleaseNote | null = null;
    let preferencesLoaded = false;

    setIsReady(false);
    setIsOpen(false);
    setNote(null);
    setPendingNoteVersion(null);

    const refreshVisibility = () => {
      if (cancelled || !preferencesLoaded || !onboardingFinished) return;
      setSeenVersions(loadedSeenVersions);
      setNote(loadedNote);
      setIsReady(true);
      setIsOpen(shouldShowReleaseNote(loadedNote, loadedSeenVersions));
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
      loadPreference<unknown>(PREF_KEYS.RELEASE_NOTES_PENDING_UPDATE),
    ]).then(([persistedSeenVersions, onboardingState, pendingValue]) => {
      if (cancelled) return;
      loadedSeenVersions = normalizeSeenReleaseNoteVersions(persistedSeenVersions);
      const pendingNote = normalizePendingUpdateReleaseNote(pendingValue);
      loadedNote = resolveReleaseNote(appVersion, language, pendingNote);
      setPendingNoteVersion(pendingNote?.version === appVersion ? appVersion : null);
      onboardingFinished = hasFinishedCurrentOnboarding(onboardingState);
      preferencesLoaded = true;
      refreshVisibility();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [appVersion, enabled, language]);

  const close = useCallback(() => {
    if (!note) {
      setIsOpen(false);
      return;
    }

    const nextSeenVersions = Array.from(new Set([...seenVersions, note.version]));
    setSeenVersions(nextSeenVersions);
    setIsOpen(false);
    const saves = [
      savePreference(PREF_KEYS.RELEASE_NOTES_SEEN_VERSIONS, nextSeenVersions),
    ];
    if (pendingNoteVersion === note.version) {
      setPendingNoteVersion(null);
      saves.push(savePreference(PREF_KEYS.RELEASE_NOTES_PENDING_UPDATE, null));
    }
    void Promise.all(saves);
  }, [note, pendingNoteVersion, seenVersions]);

  if (!enabled || !isReady || !isOpen || !note) return null;

  return (
    <Dialog
      title={t('releaseNotes.dialogTitle', 'Release notes')}
      onClose={close}
      initialFocusRef={closeButtonRef}
      closeOnBackdropClick
      backdropClassName="fixed inset-0 z-[12000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm animate-fade-in md:p-6"
      panelClassName="pointer-events-none flex w-full justify-center"
    >
      <article
        data-testid="release-notes-modal"
        className="pointer-events-auto flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl ring-1 ring-white/5"
      >
        <header className="relative shrink-0 overflow-hidden border-b border-border px-5 py-5 sm:px-7">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgb(var(--primary)/0.14),transparent_52%)]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                {t('releaseNotes.dialogTitle', 'Release notes')}
              </p>
              <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-foreground">
                Macro {note.version}
              </h2>
            </div>

            <button
              ref={closeButtonRef}
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

      </article>
    </Dialog>
  );
};

export default ReleaseNotesModal;
