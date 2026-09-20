# Workflows des tâches et des plans

Les cas d'usage Tasks/Plans prennent des ports typés. Ils ne lisent pas un store
Zustand et n'importent pas de composant ou de module de composition. Les façades
existantes restent les points d'entrée des appelants. Les contrats publics du
lot initial, notamment `TasksCommands` et `PlansCommands`, restent compatibles ;
les ports spécifiques ci-dessous précisent les dépendances internes du domaine.

## Propriété de l'état

| État ou effet | Propriétaire |
| --- | --- |
| Statut et métadonnées métier d'un plan | Plans, persistés dans `@macro` |
| Intention de mutation, journal de réplication et reprise | Plans, persistés dans SQLite |
| Lease de tâche, identité du workflow Git et approbations | Runtime natif |
| Branches, commits et worktrees réels | Git ; les caches frontend ne font pas autorité |
| Admission, préparation et séquence d'exécution | Services de workflow Tasks |
| Sélection, erreur visible, cache de catalogue et projection de revue | `useTaskStore` et adaptateurs d'interface |
| Session PTY d'une commande projet | Port d'exécution `ProjectCommandRunner` |
| Onglet, titre, focus et panneau terminal | Adaptateur de présentation terminal |

L'identité d'un projet ne change pas au passage entre ces couches. Les chemins
courants servent à résoudre un dépôt enregistré, sans reconstruire une identité
à partir d'un libellé. Les règles existantes de réconciliation sur preuve de
chemin physique restent en place.

## Démarrage et préparation

`taskStartupWorkflow` vérifie les préconditions, réserve l'opération et les
projets en édition directe, puis acquiert le lease natif. La relecture du
catalogue durable a lieu après cette acquisition. La réservation d'une tâche
indépendante utilise son statut attendu ; une restauration après échec porte
sur la révision exacte réservée par cette tentative.

`taskLifecycleLease` renouvelle le lease et attend un renouvellement en cours
avant sa libération. `taskWorkspacePreparation` valide toutes les cibles avant
la première création. En cas d'échec de préparation, seuls les worktrees créés
par cette tentative sont candidats au nettoyage. Une erreur de commande de
setup reste un avertissement, conformément au parcours existant.

La sélection est un port de projection. Une nouvelle sélection invalide la
publication de l'ancien contexte actif ; elle n'annule ni une admission durable
ni un effet Git déjà effectué. Le cache des espaces préparés peut être actualisé
sans réactiver une sélection devenue obsolète.

## Commandes projet

`ProjectCommandRunner` distingue l'exécution d'une session PTY, l'observation de
son résultat et sa présentation. Il ne remplace pas les commandes non
interactives des agents. `taskProjectCommandWorkflow` possède la séquence de
lancement et l'annulation ; le store conserve sa projection observable.

Le résultat `completed` signifie que tous les lancements ont répondu. Il ne
signifie pas que les processus PTY ont quitté. Les sessions encore actives
restent suivies, y compris si le lancement d'un projet suivant échoue. Fermer
un onglet pendant un lancement ne doit pas le faire réapparaître au retour de
ce lancement. Un échec de fermeture reste visible et réessayable.

`worktreeSetupCommands` attend, lui, la fin de la session. L'adaptateur ferme un
setup réussi et révèle un setup en échec. Son runner est injecté explicitement
par `taskCommandComposition`.

## Plans et transitions

Les lectures, mutations et synchronisations des plans ont des modules distincts,
avec une façade compatible `architectPlanService`. Une mutation qui calcule des
nœuds ou des branches depuis l'état existant doit effectuer ce calcul dans le
callback atomique, jamais avant d'entrer dans la file de mutations. La file est
indexée par branche : plusieurs plans partagent le même index durable.

`taskPlanStatusWorkflow` calcule le statut et la projection des branches depuis
le snapshot fourni sous ce verrou. La projection locale emploie le plan retourné
après persistance. Les révisions attendues, journaux et compare-and-swap restent
dans le parcours de mutation commun.

Une finalisation multi-dépôts progresse vers l'avant. Un dépôt déjà mergé n'est
pas annulé si un autre dépôt échoue ou si l'utilisateur change de sélection.
La reprise inspecte les opérations natives et le journal ; les résultats
partiels doivent conserver les dépôts terminés et préciser les suites possibles.
Aucun nouveau journal métier ou système d'event sourcing n'est introduit.

## Interface et dettes restantes

Le store demeure responsable du catalogue, de la sélection, de la traduction
des erreurs et des projections de progression. Ses parcours de brouillon,
d'archivage et de suppression des tâches indépendantes restent hors de cette
extraction. Les adaptateurs utilisent encore les capacités Git et terminal
existantes ; leur remplacement interne appartient aux domaines concernés.

Le démarrage applicatif installe `plansComposition` avant le chargement des plans
et la reprise des journaux. Les fabriques de lecture, mutation, synchronisation,
runtime et GitFlow peuvent recevoir leurs ports sans charger le store. Les
appels historiques passent par la façade compatible.

Certaines E/S de répliques et de journaux GitFlow utilisent encore l'adaptateur
Tauri global. Les fabriques n'assurent donc pas l'isolation simultanée de
plusieurs backends. Une lecture de cohérence peut reprendre une intention
journalisée ou assainir des métadonnées, comme avant cette extraction.
`architectPlanArtifactService` conserve sa dépendance historique au store et
`architectAutoPlan` à `appStateRuntime` ; leur suppression n'est pas revendiquée.

Les tests de services emploient des ports contrôlés et vérifient les décisions
et l'ordre des effets. Les tests existants du store vérifient le raccord au
produit, notamment les courses de sélection, les erreurs de commandes et les
transitions durables concurrentes. Les tests de réplication et de saga couvrent
la reprise après interruption. Ces tests ne remplacent pas un essai visuel du
runtime Tauri ni une preuve complète de concurrence entre processus natifs.
