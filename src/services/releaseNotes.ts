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
  '0.1.4': {
    en: {
      version: '0.1.4',
      eyebrow: "Desktop supervision",
      title: 'Macro 0.1.4',
      summary: "Pending requests, interrupted approvals, persistent filters, and clearer review guidance.",
      content: `## Notifications and pending requests

- Questionnaires, tool approvals, and reviews can trigger notifications while the window is inactive, according to your settings. The notification center preserves their destinations across restarts and removes resolved requests.
- The Needs attention filter groups pending questionnaires, approvals, and reviews. It works with project filtering and search and survives restarts.
- A pending approval shows that a reply is needed instead of an execution spinner. Dependency blocks remain distinct.

## Resume an interrupted approval

- After a restart, choose to resume work in a new turn or dismiss the interrupted request.
- Resuming uses the current context and tool policy. The old request grants no permission to execute, and session permissions are not restored. The agent is instructed to check previous effects before repeating an action.

## Navigation and review

- Task cards show the next action using loaded review data: validate or commit a project, accept direct changes, or open the review. Finalization tasks point to plan finalization.
- Implement shows the active task context, provides access to project management, and remembers project, status, and archive filters. Architect and Chat remember their archive filters.
- Architect empty states reflect available plans and editing permissions. Project icon dimensions and several French translations have been corrected.`,
    },
    fr: {
      version: '0.1.4',
      eyebrow: "Supervision desktop",
      title: 'Macro 0.1.4',
      summary: "Demandes en attente, approbations interrompues, filtres persistants et prochaines actions de review.",
      content: `## Notifications et demandes en attente

- Les questionnaires, approbations d'outils et reviews peuvent déclencher une notification lorsque la fenêtre est inactive, selon vos réglages. Le centre de notifications conserve leur destination après redémarrage et retire les demandes résolues.
- Le filtre « À traiter » regroupe les questionnaires, approbations et reviews en attente. Il se combine au projet et à la recherche et reste mémorisé après redémarrage.
- Une approbation en attente affiche une demande de réponse plutôt qu'un indicateur d'exécution. Les blocages de dépendances restent distincts.

## Reprendre une approbation interrompue

- Après redémarrage, choisissez de reprendre le travail dans un nouveau tour ou d'ignorer la demande interrompue.
- La reprise utilise le contexte et la politique d'outils actuels. L'ancienne demande n'autorise aucune exécution et les droits de session ne sont pas restaurés. L'agent reçoit l'instruction de vérifier les effets précédents avant de répéter une action.

## Navigation et review

- Les cartes de tâches indiquent la prochaine action selon les données de review chargées : valider ou committer un projet, accepter des changements directs ou ouvrir la review. Les tâches de finalisation renvoient vers la finalisation du plan.
- Implement affiche le contexte de la tâche active, donne accès à la gestion des projets et conserve les filtres de projet, de statut et d'archives. Architect et Chat conservent leur filtre d'archives.
- Les états vides Architect tiennent compte des plans et des droits de modification. Les dimensions des icônes de projet et plusieurs traductions françaises ont été corrigées.`,
    },
  },
  '0.1.2': {
    en: {
      version: '0.1.2',
      eyebrow: 'Workflow update',
      title: 'Macro 0.1.2',
      summary:
        'Direct tasks, repository instructions, safer long conversations, and background updates.',
      content: `## Direct work without a worktree

- Run a direct task in the current checkout of a Git repository when a separate branch and worktree would get in the way.
- Folders without Git can now take part in Architect plans. A plan can mix Git projects and directly edited folders while keeping the right review and recovery flow for each one.
- Direct work keeps its original execution mode after restarts or later Git setup, which prevents tasks from silently switching workflows.

## Repository instructions

- Macro now loads the applicable \`AGENTS.md\` instructions for every project in a conversation.
- Instructions stay scoped to their own project. The context diagnostics report files that were loaded and warn when a limit or read error makes the result incomplete.

## Longer, safer conversations

- Conversation compaction can run before the provider limit is reached and can remove file reads that a newer read replaced.
- If a model stops because it reached its output limit, Macro can request the missing continuation once without repeating completed text.
- Compaction and recovery preserve tool-call pairs, errors, checkpoints, and the real reason a response ended.

## Updates and interface fixes

- Signed updates download in the background. Macro can install them on the next launch, or immediately after checking that no agent or implementation is still running.
- Update-channel settings are easier to scan and show the current download or install state directly.
- Fixed inconsistent archive state, provider forms, focus indicators, modal borders, and several settings screens.`,
    },
    fr: {
      version: '0.1.2',
      eyebrow: 'Mise à jour des workflows',
      title: 'Macro 0.1.2',
      summary:
        'Tâches directes, instructions de dépôt, conversations longues plus sûres et mises à jour en arrière-plan.',
      content: `## Travail direct sans worktree

- Lancez une tâche directe dans le checkout courant d’un dépôt Git lorsqu’une branche et un worktree séparés seraient gênants.
- Les dossiers sans Git peuvent maintenant participer aux plans Architect. Un plan peut mélanger des projets Git et des dossiers modifiés directement, tout en conservant le bon parcours de revue et de récupération pour chaque cible.
- Le travail direct conserve son mode d’exécution après un redémarrage ou une initialisation Git ultérieure. Une tâche ne change donc pas de workflow en silence.

## Instructions de dépôt

- Macro charge maintenant les instructions \`AGENTS.md\` applicables à chaque projet d’une conversation.
- Les instructions restent limitées à leur propre projet. Les diagnostics de contexte indiquent les fichiers chargés et signalent lorsqu’une limite ou une erreur de lecture rend le résultat incomplet.

## Conversations longues plus sûres

- Le compactage peut intervenir avant d’atteindre la limite du fournisseur et retirer les lectures de fichiers remplacées par une lecture plus récente.
- Si un modèle s’arrête parce qu’il a atteint sa limite de sortie, Macro peut demander une fois la suite manquante sans répéter le texte déjà reçu.
- Le compactage et la reprise préservent les paires d’appels d’outils, les erreurs, les checkpoints et la cause réelle de fin d’une réponse.

## Mises à jour et corrections d’interface

- Les mises à jour signées se téléchargent en arrière-plan. Macro peut les installer à la prochaine ouverture ou immédiatement après avoir vérifié qu’aucun agent ni aucune implémentation n’est encore en cours.
- Les réglages du canal de mise à jour sont plus lisibles et affichent directement l’état du téléchargement ou de l’installation.
- Correction d’incohérences dans les archives, les formulaires de fournisseurs, les indicateurs de focus, les contours des modales et plusieurs écrans de réglages.`,
    },
  },
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
