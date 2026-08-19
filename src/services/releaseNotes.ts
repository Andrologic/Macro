export interface ReleaseNote {
  version: string;
  eyebrow: string;
  title: string;
  summary: string;
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
        'This release establishes the local-first desktop workflow for planning, implementing, reviewing, and integrating agentic software work.',
      content: `## A complete desktop workflow

- Plan work in **Architect**, run isolated tasks in **Implement**, and keep lightweight conversations in **Chat**.
- Coordinate plans across several projects with dedicated branches, worktrees, and task checklists.
- Review and edit generated changes before creating separate commits for each repository.

## Built for longer sessions

- Conversation compaction keeps long-running agent sessions usable.
- The integrated terminal, provider controls, and structured clarification questions stay close to the active task.
- The \`@macro\` metadata flow preserves plans, conversations, and execution history outside product branches.

## Reliability and safety

- Task, plan, review, commit, and cleanup transitions now reject stale or conflicting operations.
- Streaming, provider recovery, database migrations, and workspace restoration have broader regression coverage.
- Provider secrets remain in Macro private local storage, and workspace operations reject paths outside their authorized roots.`,
    },
    fr: {
      version: '0.1.0',
      eyebrow: 'Première version stable',
      title: 'Macro 0.1 est prêt',
      summary:
        'Cette version pose le workflow desktop local-first pour planifier, implémenter, relire et intégrer du travail logiciel réalisé avec des agents.',
      content: `## Un workflow desktop complet

- Planifiez dans **Architect**, exécutez des tâches isolées dans **Implement** et gardez les échanges légers dans **Chat**.
- Coordonnez des plans sur plusieurs projets avec des branches, des worktrees et des checklists dédiés.
- Relisez et modifiez les changements générés avant de créer des commits séparés pour chaque dépôt.

## Pensé pour les sessions longues

- Le compactage des conversations maintient les longues sessions d’agent exploitables.
- Le terminal intégré, les réglages des fournisseurs et les questions structurées restent proches de la tâche active.
- Le flux de métadonnées \`@macro\` conserve les plans, les conversations et l’historique d’exécution hors des branches produit.

## Fiabilité et sécurité

- Les transitions de tâche, de plan, de review, de commit et de nettoyage refusent désormais les opérations obsolètes ou conflictuelles.
- Le streaming, la récupération des fournisseurs, les migrations de base de données et la restauration du workspace ont une couverture de régression plus large.
- Les secrets des fournisseurs restent dans le stockage local privé de Macro, et les opérations sur le workspace refusent les chemins qui sortent des racines autorisées.`,
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
