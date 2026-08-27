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
  '0.1.1': {
    en: {
      version: '0.1.1',
      eyebrow: 'Maintenance release',
      title: 'Macro 0.1.1',
      summary:
        'Automatic updates, Windows ARM64 support, accurate image context estimates, and more reliable agents.',
      content: `## Automatic updates

- Fixed the missing update-channel files that caused the **Unable to check for updates** error.
- Macro now verifies signed update archives, checksums, immutable download URLs, and every platform manifest before publishing an update.
- Update notes are kept during installation and shown once after Macro restarts.

## Windows on ARM

- Added a native Windows ARM64 installer.
- The ARM64 package includes the native Macro AI runtime instead of relying on x64 emulation.

## Context and images

- Fixed image attachments being counted from their Base64 transport size, which could make Macro report a full context window far too early.
- Macro now estimates visual tokens from the image dimensions and the selected model or provider formula. A duplicated image in the visible message and provider payload is counted only once.
- Image estimates can still trigger preventive compaction, but they no longer cause a permanent pre-send block on their own.

## Agent reliability

- Tool failures are now reported as failures instead of successful-looking results, so agents can correct invalid arguments and recover from execution errors.
- Database startup checks preserve the shipped migration version.`,
    },
    fr: {
      version: '0.1.1',
      eyebrow: 'Version de maintenance',
      title: 'Macro 0.1.1',
      summary:
        'Mises à jour automatiques, prise en charge de Windows ARM64, estimation correcte des images dans le contexte et agents plus fiables.',
      content: `## Mises à jour automatiques

- Correction de l’absence des fichiers de canal qui provoquait l’erreur **Impossible de rechercher des mises à jour**.
- Macro vérifie désormais les archives signées, les sommes de contrôle, les URL de téléchargement immuables et le manifeste de chaque plateforme avant de publier une mise à jour.
- Les notes de version sont conservées pendant l’installation, puis affichées une seule fois après le redémarrage de Macro.

## Windows sur ARM

- Ajout d’un installateur Windows ARM64 natif.
- Le paquet ARM64 inclut le runtime IA natif de Macro et ne dépend pas de l’émulation x64.

## Contexte et images

- Correction des pièces jointes visuelles qui étaient comptées selon le poids de leur transport Base64. Macro pouvait alors considérer la fenêtre de contexte comme pleine beaucoup trop tôt.
- Macro estime maintenant les tokens visuels à partir des dimensions de l’image et de la formule du modèle ou du fournisseur sélectionné. Une image présente dans le message visible et dans le payload du fournisseur n’est comptée qu’une fois.
- L’estimation des images peut encore déclencher un compactage préventif, mais elle ne provoque plus à elle seule un blocage définitif avant l’envoi.

## Fiabilité des agents

- Les échecs d’outils sont maintenant signalés comme tels. Les agents peuvent ainsi corriger les arguments invalides et reprendre après une erreur d’exécution.
- Les contrôles de démarrage de la base de données préservent la version de migration livrée.`,
    },
  },
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
  if (bundledNote) return bundledNote;

  return {
    version,
    eyebrow: '',
    title: `Macro ${version}`,
    summary: '',
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
