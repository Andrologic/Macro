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
import { Button } from '../ui/Button';
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
      title={t('releaseNotes.dialogTitle', 'What’s new in Macro')}
      onClose={close}
      initialFocusRef={closeButtonRef}
      backdropClassName="fixed inset-0 z-[12000] flex items-center justify-center bg-black/75 p-3 backdrop-blur-md animate-fade-in md:p-6"
    >
      <article
        data-testid="release-notes-modal"
        className="relative flex max-h-[min(88vh,720px)] w-full max-w-4xl flex-col overflow-hidden rounded-[20px] border border-border/80 bg-card text-card-foreground shadow-2xl ring-1 ring-white/[0.04]"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-primary/70" />

        <header className="relative shrink-0 overflow-hidden border-b border-border/70 px-5 pb-5 pt-4 sm:px-8 sm:pb-6 sm:pt-5">
          <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-primary/[0.12] blur-3xl" />
          <div className="relative mb-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                <Icon name="sparkles" size={14} />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                {note.eyebrow || t('releaseNotes.dialogTitle', 'What’s new in Macro')}
              </span>
            </div>

            <button
              type="button"
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
              onClick={close}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold tracking-[-0.025em] text-foreground sm:text-[30px] sm:leading-9">
                {note.title}
              </h2>
              {note.summary ? (
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {note.summary}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-baseline gap-2 border-l-2 border-primary/50 pl-3 sm:block sm:min-w-20">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {t('releaseNotes.version', 'Version')}
              </span>
              <div className="font-mono text-sm font-semibold text-foreground">{note.version}</div>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 sm:py-7">
          <MarkdownRenderer
            content={note.content}
            className={`release-notes-markdown mx-auto max-w-3xl ${
              pendingNoteVersion ? '' : 'release-notes-markdown--cards'
            }`}
          />
        </div>

        <footer className="flex shrink-0 justify-end border-t border-border/70 bg-background/25 px-5 py-4 sm:px-8">
          <Button ref={closeButtonRef} type="button" size="sm" onClick={close} className="min-w-32">
            {t('releaseNotes.continue', 'Open Macro')}
          </Button>
        </footer>
      </article>
    </Dialog>
  );
};

export default ReleaseNotesModal;
