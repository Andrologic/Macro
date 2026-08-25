export interface ReleaseNote {
  version: string;
  eyebrow: string;
  title: string;
  summary: string;
  content: string;
}

export interface PendingUpdateReleaseNote {
  version: string;
  content: string;
}

type ReleaseNoteLocale = 'en' | 'fr';

const RELEASE_NOTES: Record<string, Record<ReleaseNoteLocale, ReleaseNote>> = {
  '0.1.0': {
    en: {
      version: '0.1.0',
      eyebrow: 'First stable release',
      title: 'Macro 0.1 is ready',
      summary:
        'Turn a plan into isolated changes, review every diff, then commit only what you want.',
      content: `## One place to run the work

- Move from a plan in **Architect** to an isolated task in **Implement** without rebuilding the context.
- Inspect and edit every change before it reaches your repository history.

## Sessions that stay usable

- Macro compacts long conversations before they become unwieldy.
- The terminal, model controls, and agent questions stay attached to the task you are working on.

## Your repository stays yours

- Tasks run in dedicated branches and worktrees, away from your current changes.
- Provider secrets stay in Macro's local storage, and workspace operations cannot leave authorized project roots.`,
    },
    fr: {
      version: '0.1.0',
      eyebrow: 'Première version stable',
      title: 'Macro 0.1 est prêt',
      summary:
        'Transformez un plan en changements isolés, relisez chaque diff, puis commitez uniquement ce que vous voulez garder.',
      content: `## Tout le travail au même endroit

- Passez d’un plan dans **Architect** à une tâche isolée dans **Implement** sans reconstruire le contexte.
- Inspectez et modifiez chaque changement avant qu’il entre dans l’historique du dépôt.

## Des sessions qui restent lisibles

- Macro compacte les longues conversations avant qu’elles deviennent difficiles à suivre.
- Le terminal, le choix du modèle et les questions de l’agent restent liés à la tâche en cours.

## Votre dépôt reste sous votre contrôle

- Les tâches s’exécutent dans des branches et des worktrees dédiés, à l’écart de vos changements en cours.
- Les secrets restent dans le stockage local de Macro, et les opérations ne peuvent pas sortir des racines autorisées du projet.`,
    },
  },
};

const normalizeLanguage = (language: string | null | undefined): ReleaseNoteLocale =>
  language?.toLowerCase().split('-')[0] === 'fr' ? 'fr' : 'en';

export const getReleaseNote = (
  version: string,
  language: string | null | undefined,
): ReleaseNote | null => {
  const localizedNotes = RELEASE_NOTES[version];
  return localizedNotes?.[normalizeLanguage(language)] ?? null;
};

export const normalizePendingUpdateReleaseNote = (
  value: unknown,
): PendingUpdateReleaseNote | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingUpdateReleaseNote>;
  const version = typeof candidate.version === 'string' ? candidate.version.trim() : '';
  const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
  return version && content ? { version, content } : null;
};

export const resolveReleaseNote = (
  version: string,
  language: string | null | undefined,
  pendingValue: unknown,
): ReleaseNote | null => {
  const bundledNote = getReleaseNote(version, language);
  const pendingNote = normalizePendingUpdateReleaseNote(pendingValue);
  if (!pendingNote || pendingNote.version !== version) return bundledNote;

  return {
    version,
    eyebrow: bundledNote?.eyebrow ?? '',
    title: bundledNote?.title ?? `Macro ${version}`,
    summary: bundledNote?.summary ?? '',
    content: pendingNote.content,
  };
};

export const normalizeSeenReleaseNoteVersions = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (version): version is string =>
          typeof version === 'string' && version.trim().length > 0,
      ),
    ),
  );
};

export const shouldShowReleaseNote = (
  note: ReleaseNote | null,
  seenVersions: readonly string[],
): note is ReleaseNote => Boolean(note && !seenVersions.includes(note.version));
