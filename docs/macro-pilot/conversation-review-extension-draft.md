# Projet d'extension : conversations et diff de review

## Statut et portée

Projet de conception non adopté, fondé sur le code public au commit
`03eb9c25fe08867dbf85dd28c2141043ee6606c4`. Ce document ne crée aucune version
consommable et ne modifie ni les schémas A1, ni les routes, ni les fixtures.
C, D et E continuent de consommer leur contrat figé. Les noms ci-dessous sont
des propositions, à enregistrer dans une future version seulement après
validation et synchronisation des consommateurs. Aucun champ nouveau ne doit
être ajouté silencieusement à un message `1.0`.

But : combler la lecture des conversations de tâche et du diff réel des
critères 5 et 7. Macro reste ouvert et canonique ; D relaie sans constituer
d'historique canonique. Le verdict mobile ne committe, ne merge et ne pousse
rien. La sélection des projets autorisés et le cycle de vie du compte restent
hors de ce document. Toute lecture ci-dessous passe par les droits effectifs
au moment de la requête et du retour, jamais par une permission supposée.

Tout objet filaire, champ, borne ou transition décrit comme **nouveau** est du
travail à réaliser, pas une capacité du runtime actuel. Les autres données
renvoient aux sources vérifiées suivantes. Les numéros de ligne sont ceux du
commit de référence ; les symboles servent au repérage après déplacement.

## Sources canoniques vérifiées

| Repère | Source publique | Ce qu'elle établit, et sa limite |
| --- | --- | --- |
| S1 | [ChatMessage, Conversation](../../src/types/index.ts#L1235), [DbMessage](../../src/services/tauriIpc.ts#L102) | IDs, rôles, texte, date, relation conversation/tâche, champs internes. Pas de révision publique de transcript. |
| S2 | [listMessages](../../src/services/tauriIpc.ts#L1506), [list_messages](../../src-tauri/src/db/repository.rs#L787) | Lecture persistée, ordre SQL `created_at ASC, id ASC`. L'API actuelle charge toute la liste, sans snapshot paginé. |
| S3 | [chatDbMappers](../../src/services/chatDbMappers.ts#L110) | Présentation des questionnaires et réponses depuis contenu/contexte interne. Le mapper conserve aussi des champs privés : ce n'est pas un sérialiseur réseau sûr. |
| S4 | [ChatStore](../../src/stores/useChatStore.ts#L1046), [ConversationRuntimeState](../../src/types/index.ts#L1087) | Messages par conversation, phase et ID du message assistant actif. Le runtime est volatil ; `idle` ne prouve pas une réponse complète. |
| S5 | [buildChatGptVisibleTurnContent](../../src/services/streamingChat.ts#L2296), [raisonnement natif](../../src/services/streamingChat.ts#L2311), [ChatCompletionReason](../../src/types/index.ts#L19) | Du raisonnement peut être inclus dans `content` sous `<think>`. Les motifs de fin incluent des interruptions et des valeurs ouvertes. |
| S6 | [TaskExecutionTarget](../../src/types/index.ts#L204), [mapping A1](macro-type-mapping.md#projet-et-tâche) | Projet, branche, cible, mode, worktree et parfois base connue. Les chemins restent locaux ; un run ou SHA absent n'est pas à inventer. |
| S7 | [gitDiff](../../src/services/tauriIpc.ts#L2498), [git_diff](../../src-tauri/src/commands/git.rs#L6932), [diff_repo](../../src-tauri/src/commands/git.rs#L5684) | Diff tree-to-tree si base et head sont fournis. Sans head, comparaison du répertoire de travail et de l'index : impropre à une review immuable. |
| S8 | [wsl_git_diff](../../src-tauri/src/commands/git.rs#L2322), [wsl_diff_range](../../src-tauri/src/commands/git.rs#L2552), [DiffTextSink](../../src-tauri/src/commands/git.rs#L5642), [borne Git](../../src-tauri/src/commands/tool_output.rs#L37) | WSL résout les commits et utilise `base..head`. Sortie texte bornable à 256 Kio ; `requireComplete` refuse le dépassement. Ce n'est pas une pagination. |
| S9 | [GitReviewChangeDto](../../src/services/tauriIpc.ts#L424), [git_review_snapshot](../../src-tauri/src/commands/git.rs#L7041), [review.rs](../../src-tauri/src/commands/git/review.rs#L8), [gitDiffParser](../../src/services/gitDiffParser.ts#L1) | Formes locales de fichiers/hunks, marqueurs binaire et trop grand. Snapshot HEAD/index/worktree, non snapshot arbitraire de deux SHA. Le parseur texte n'est pas une preuve de complétude Git. |
| S10 | [review A1](../../contracts/macro-pilot/v1/supervision.schema.json#L317), [review.submit](../../contracts/macro-pilot/v1/protocol.schema.json#L188), [compatibilité](compatibility.md#révisions-et-commandes), [transport](native-transport.md#acheminement-http-des-messages-a1) | Référence de review, deux SHA, révision, verdict, idempotence, droits et flux existants. Pas de contenu de conversation/diff ni de déclencheurs complets d'obsolescence. |

Les couches restent celles de [l'architecture](../technical-architecture.md#3-couches-principales) :
projection et orchestration dans C, Git et persistance derrière les wrappers
typés, rendu dans E. Ce projet ne copie aucun code des dépôts privés dans Macro
et ne modifie pas sa [licence AGPL](../../LICENSE).

## Conversation de tâche

### Sélection et contenu

Choix minimal proposé : uniquement les conversations `Implement` rattachées
sans ambiguïté à une tâche exportable, via `Conversation.task_id` ou la
relation de tâche vérifiée par C. S1 et S6 fournissent les identités ; la
validation croisée est nouvelle. Une sélection globale de l'interface ne doit
jamais rattacher une ancienne conversation à une autre tâche. Plusieurs
conversations d'une même tâche restent distinctes. Architect et Chat autonomes
ne sont pas couverts par ce premier projet ; leur inclusion demanderait un
périmètre explicite, pas une identité de tâche artificielle.

C construit une liste blanche de texte utilisateur et de réponse assistant.
Il utilise localement S3 pour séparer les marqueurs de questionnaire, mais
n'exporte que le texte résultant contrôlé. Les décisions et approbations restent
les ressources A1 dédiées ; le fil n'ajoute aucune voie de résolution.

Protection nouvelle à réaliser avant tout export :

- Exclure `hidden_context`, `provider_input_items`, `provider_turn_state`,
  `tool_traces`, `context_refs`, citations, pièces jointes, brouillons non
  envoyés et résumés internes de compaction. Aucun objet S1 n'est copié en bloc.
- S5 prouve que `content` n'est pas automatiquement du texte public. Séparer
  les canaux de sortie au niveau de l'adaptateur provider quand ils existent.
  Pour le contenu historique balisé, supprimer les blocs de raisonnement
  complets et toute fin ouverte. Une provenance ambiguë ou un balisage
  malformé entraîne un contenu retenu, pas une tentative de deviner la réponse.
  Une expression régulière sur `<think>` seule ne garantit pas cette séparation.
- Ne publier aucun delta brut pendant la génération. Pour un assistant actif,
  publier seulement l'existence du message. Exposer son texte après observation
  d'un état durable stabilisé et vérification de sa provenance. Après crash ou
  pour une ancienne réponse sans preuve de canal sûr, retenir le texte.
- Appliquer la politique déterministe d'export définie ci-dessous avant toute
  sérialisation. Les regex `safeText` ne sont pas une preuve d'absence de secrets.
- E affiche du texte inerte, sans HTML, chargement automatique d'URL/image,
  accès fichier ou exécution de contenu. D et E ne journalisent aucun corps.

Politique nouvelle proposée, versionnée localement par `export_policy_revision` :
les catégories candidates sont uniquement titre, texte utilisateur envoyé,
texte assistant de canal final identifié, chemins relatifs et lignes de contenu
Git ou index/worktree textuel capturé. Aucun autre champ ne peut être promu par
détection heuristique. Le texte utilisateur est aussi contrôlé ; l'appareil et
les projets doivent être explicitement autorisés. Pour l'historique balisé, un parseur strict
reconnaît seulement la grammaire de raisonnement documentée par l'adaptateur ;
forme inconnue, balise déséquilibrée ou rôle inconnu donnent withheld.

Avant découpage, C analyse chaque texte candidat entier et chaque blob entier
des deux côtés, ainsi que les deux chemins d'un fichier. Il recherche la liste
locale de secrets configurés sous leurs représentations déclarées, les clés
privées, les signatures de jetons et chemins de la politique et `safeText`.
Une détection, une erreur d'analyse ou un dépassement du budget entraîne la
rétention de tout le texte candidat, ou de tout le fichier pour un diff. Il
ne remplace pas seulement la moitié d'une signature sur deux lignes. Les
fichiers de secrets connus sont exclus de l'export par catégorie de chemin
avant analyse de présentation ou génération de hunks. Cette exclusion ne
prohibe pas le calcul local isolé de leur empreinte de fraîcheur : le lecteur
natif peut parcourir leurs octets en flux, sans les conserver dans le cache,
les transmettre au frontend ou les journaliser. La liste exacte des signatures et chemins doit devenir une
fixture normative A lors de l'adoption, identifiée par la révision de politique.

L'autorisation d'accès de l'appareil aux projets est la frontière produit.
Lorsque les droits courants sont valides et que ces contrôles passent, C exporte
automatiquement ces catégories, y compris les nouveaux messages et fichiers.
Aucune confirmation locale par texte, fichier ou empreinte n'est demandée.
Un changement de contenu ou de politique déclenche un nouveau contrôle et
invalide les snapshots concernés, pas l'autorisation d'accès de l'appareil.
Les droits retirés interrompent l'export ; une provenance ambiguë, une catégorie
interdite ou une détection conserve le traitement withheld.

L'absence de détection ne signifie pas absence de secret arbitraire : un texte
libre peut contenir un secret inconnu des filtres. Ce risque résiduel est déclaré,
sans garantie absolue ni approbation locale ajoutée pour prétendre le supprimer.
La séparation du dépôt public Macro et des dépôts privés D/E concerne le code
et les configurations ; elle ne remplace ni n'interdit l'export des données
autorisées via le relais privé. Les schémas de droits projet restent à définir
dans leur propre chantier ; ce document n'accorde aucun droit implicite.

### Champs proposés

Tous les objets de projection sont nouveaux ; la colonne source indique
l'origine des valeurs réutilisées. `?` signifie champ facultatif.

| Objet/champs | Définition proposée | Source ou travail nouveau |
| --- | --- | --- |
| `conversation_ref` | `type: conversation`, `instance_id`, `workspace_id`, `task_id`, `conversation_id` ; aucun `run_id` requis | Identités A1 + S1 ; nouvelle référence filaire, relation validée par C |
| `conversation_summary.ref`, `title?` | Référence ci-dessus ; titre expurgé, absent si retenu | S1, nouvel expurgateur |
| `conversation_summary.revision` | Entier de projection durable, incrémenté pour toute modification exportable, suppression ou changement d'état | Nouveau ; ni `message_count` ni date ne constituent cette révision |
| `conversation_summary.activity` | `busy`, `idle`, `error`, `unknown` | Nouveau mapping S4 : preparing/overflow_recovery/streaming → busy ; idle → idle ; error → error ; runtime absent → unknown ; aucun détail d'erreur brut |
| `conversation_summary.observed_at` | Date réelle de lecture C | Nouveau, pas une date de modification historique |
| `conversation_summary.export_policy_revision` | Révision de la politique appliquée à la projection | Nouveau ; les changements imposent un nouveau contrôle et invalident les snapshots, pas les droits de l'appareil |
| `message.ref` | Champs d'identité de conversation_ref + `message_id`, avec `type: message` | ID exact S1/S2 ; jamais dérivé du texte ou de sa position |
| `message.role` | `user` ou `assistant` | S1 ; toute autre valeur persistée est écartée, pas forcée en assistant |
| `message.created_at?` | Date source valide, sans réécriture | S1/S2 ; absente si donnée historique invalide, observation portée par la page |
| `message.position` | Entier à partir de zéro dans le snapshot, après filtrage, ordre de S2 | Nouveau ordinal local au snapshot ; ce n'est pas une séquence durable de run |
| `message.text` | Texte UTF-8 contrôlé, éventuellement vide | S1/S3 puis protection nouvelle ci-dessus |
| `message.content_state` | `complete`, `excerpt`, `withheld`, `pending` | Nouveau : entier exportable, extrait plafonné, retenu pour sécurité/provenance, ou assistant actif ; complete qualifie le texte public autorisé, pas l'ensemble des champs privés |
| `message.redacted` | Booléen, vrai si le texte public a été expurgé | Nouveau ; ne révèle ni valeur supprimée ni empreinte du secret |
| `message.completion` | `complete`, `incomplete`, `unknown` | Nouveau mapping S5 : completed/length_recovered/incomplete_recovered → complete ; length/incomplete/tool_turn_limit/post_tool_empty_fallback → incomplete ; absent/autre → unknown ; pending → unknown |

L'état de fin ne débloque jamais à lui seul la sécurité du texte. Une réponse
peut être `completion: complete` et `content_state: withheld`. Le texte est vide
pour `pending` et `withheld`. Un texte réellement vide contrôlé peut être
`complete`. `excerpt` signifie perte assumée, sans bouton qui promettrait un
contenu intégral indisponible. Choix nouveau : plafond de 16 Kio UTF-8 par
message, coupe entre caractères après expurgation, sans nombre de tokens ou
taille du texte privé. Un suffixe de troncature est du rendu E, pas une fausse
phrase de l'auteur.

### Lecture, pagination et changements

Propositions nouvelles, non reconnues par le transport `1.0` :

1. Une lecture `conversation.list` cible une `taskRef`, puis une lecture
   `conversation.read` cible une `conversation_ref`. Ce sont des lectures,
   sans `issued_by` fourni par le client ; D transmet l'acteur authentifié
   comme pour les lectures A1. `supervise` et les droits effectifs sur la tâche
   sont requis. Les futures règles de projets s'appliqueront ici sans être
   décidées par ce document.
2. Chaque requête accepte `cursor?` et `limit` de 1 à 25. La réponse contient
   `snapshot_id`, `scope`, `revision`, `observed_at`, `items`, `has_more`,
   `next_cursor?` et `resume_point`. Tous sont nouveaux sauf les concepts de
   révision et reprise S10. Pour list, revision porte sur le catalogue de la
   tâche ; pour read, sur la conversation. `scope` reprend exactement la cible.
3. C capture un point du flux avant une vue cohérente persistée de S2 et S4.
   Les pages suivantes conservent la vue, les positions et le même point.
   Nouveau curseur opaque lié à acteur, instance, scope, snapshot et position ;
   il ne donne aucun droit. Son expiration après 5 minutes est proposée, ainsi
   que la possibilité d'expirer plus tôt sous pression mémoire. Toute perte
   de vue ou du journal requis retourne `cursor_expired`, jamais une page
   combinant deux vues. Une lecture paginée native est nouvelle pour éviter
   le chargement intégral de S2 sur les grands historiques.
4. Un événement nouveau `conversation.changed` porte un snapshot d'invalidation
   défini dans la section des formes filaires, dans la séquence de S10. Il invalide la vue E, qui
   recommence une lecture sans curseur ; aucun append aveugle de fragments.
   Création, modification/suppression d'un message, changement d'activité,
   titre ou politique d'expurgation font avancer la révision. Toute modification
   de summary, notamment titre, activité, révision de conversation ou politique,
   avance aussi la révision de chaque catalogue de tâche qui la contient et
   émet conversation.catalog_changed. Un changement d'appartenance invalide
   l'ancien catalogue et le nouveau. observed_at est une métadonnée de capture
   figée pour les pages du snapshot ; une observation seule n'avance pas les
   révisions et ne déclenche aucun événement. C persiste
   révision et invalidation ensemble, ou invalide le flux en cas d'incertitude.
5. `conversation.removed` porte un snapshot tombstone de même référence et oblige E à retirer le
   cache concerné. Une révocation purge les caches autorisés sans livrer un
   événement privé à une session révoquée. Le bootstrap et ses invalidations
   couvrent aussi une insertion tardive dont la date source est ancienne.
6. Une fois la vue chargée, E applique les invalidations postérieures au point.
   Une révision déjà vue est ignorée. Un trou impose le bootstrap. Pendant une
   nouvelle lecture ou une coupure, E conserve éventuellement l'ancien rendu
   avec une indication périmée ; il ne marque pas sa date comme actuelle.
   La perte du journal au redémarrage expire les curseurs. Aucune génération
   n'est rejouée pour reconstruire un fil.

L'absence d'export de tokens en direct est un choix minimal raisonnable, pas
une affirmation que S4 ne sait pas streamer. Les états de tâche et d'activité
assurent le suivi pendant que la réponse reste en préparation.

## Diff d'une review Git

### Production canonique et limites des API actuelles

C résout localement le projet et la cible de S6, jamais un `repoPath` reçu du
mobile. Nouvelle sélection de source explicite dans l'UI : `commits`, `staged`,
`unstaged` ou `local_total`. Le choix est enregistré dans la review et affiché
sur mobile. Il ne donne aucun droit supplémentaire. La liaison locale nouvelle
contient tâche, projet, dépôt réel, cible S6, run s'il est connu, source choisie
et preuves capturées. Aucun run ni SHA historique n'est inventé.

Pour `commits`, l'UI choisit une comparaison de branche ou deux références
vérifiées du projet. C enregistre la sélection et résout les deux OID complets
dans le dépôt canonique : `base_sha == selected_base_oid` et
`head_sha == selected_head_oid`. Le rendu précise comparaison directe des arbres,
sans merge-base implicite. Une option merge-base éventuelle doit être explicite
et enregistrer son OID résolu. `baseCommitHash` S6 n'est utilisé que si le
workflow choisit cette base ; le début de tâche n'est pas imposé. La preuve
porte sur la sélection de source, pas sur l'attribution de tous les commits à
un seul run. Une sélection absente ou des SHA différents de ceux enregistrés
produisent missing_provenance. Une paire divergente reste comparable.

Les références de branches suivies et leurs OID sont conservés localement pour
détecter l'obsolescence ; des OID choisis explicitement sont fixes. Cette
distinction évite de rendre périmée une comparaison historique à chaque
modification sans rapport du répertoire de travail.

S7/S8 permettent déjà cette comparaison pour un patch court avec base et head
explicites, `ignoreWhitespace: false`, contexte de trois lignes,
`maxBytes` explicite et `requireComplete: true`. Les modes stat/name_only ne
remplacent pas le contenu. Un refus de taille n'est jamais converti en diff vide.

Pour une pagination robuste, il faut une nouvelle lecture native typée de
deux arbres, avec catalogue de deltas et hunks bornés. Le chemin libgit2 de S7
ne demande pas actuellement la détection de similarité ; le parseur S9 peut
lire un renommage présent dans un patch mais ne le détecte pas. Le nouveau
producteur doit normaliser libgit2 et WSL, avec détection de renommage explicite
à seuil de similarité 50 %, sans détection de copie pour ce minimum. Il doit
traiter correctement les noms Git cités, tabulations, retours ligne et octets
non UTF-8. Pas de découpage naïf d'une liste `name_only` par retour ligne.

S9 lit aussi des fichiers HEAD/index/worktree. Ces résultats ne doivent jamais
être présentés comme le contenu exact de deux SHA. Le lecteur commits utilise
uniquement des objets Git ; le lecteur local capture les octets comme décrit
ci-dessous. Aucun des deux ne suit les liens symboliques et ne lance ni
diff externe ni filtre textconv. Il signale les sous-modules par leurs OID,
sans ouvrir leur dépôt ni suivre une URL. Les sorties Git brutes et leurs
erreurs restent locales.

### Variante immuable index/worktree

Source vérifiée supplémentaire S11 :
[build_git_review_snapshot_with_cancellation](../../src-tauri/src/commands/git/review.rs#L1046)
énumère les changements et retourne des entrées `requires_hydration` sans
contenu ; [build_git_review_file](../../src-tauri/src/commands/git/review.rs#L1000)
produit les trois côtés HEAD/index/worktree, pending_diff index→worktree et
full_diff HEAD→worktree. Ni ces lectures séparées ni leurs DTO ne garantissent
une vue atomique, une empreinte durable ou une relecture immuable. Ces garanties
sont nouvelles et ne peuvent être obtenues en conservant seulement le catalogue.

Les sources locales ont une sémantique précise : staged compare HEAD→index,
unstaged index→worktree avec non suivis non ignorés, local_total HEAD→worktree
pour l'union des chemins staged/unstaged/non suivis. Une entrée redevenue
identique dans local_total reste identifiable avec zéro hunk si elle figure
dans le catalogue S11. L'UI nomme cette différence, pas "tous les changements"
sans précision. HEAD absent dans un dépôt unborn est un côté vide marqué
`head_oid: null`, pas un faux commit ; un dossier sans Git reste not_git.

Nouveau producteur C, derrière un wrapper natif typé :

1. Sérialiser les mutations Macro par cible. Capturer HEAD symbolique et OID,
   l'index logique complet avec modes/OID/stages, le catalogue de chemins
   concernés et les indicateurs conflit/merge. Les conflits rendent la review
   indisponible `unsupported_target` ; aucun verdict ne les résout.
2. Lire les côtés nécessaires par des handles sûrs inspirés de S9, sans suivre
   de symlink. Pour les côtés autorisés par la politique de contenu, conserver
   les octets lus dans un snapshot privé local, séparé du répertoire de travail.
   Les fichiers exclus par chemin sont seulement hachés en flux localement,
   sans cache de contenu. Si l'analyse de contenu détecte un secret, abandonner
   les octets candidats avant leur mise en cache ; ne garder que l'empreinte
   et les métadonnées locales. Pas de stage, write-tree, stash ou commit automatique.
   Pour une limite dépassée, conserver un marqueur too_large/withheld plutôt
   qu'un faux contenu vide ; calculer l'empreinte en flux dans le budget, sinon
   refuser la capture avec resource_limit.
3. Construire une empreinte locale SHA-256 sur un encodage canonique versionné,
   avec longueur de chaque champ : identité de cible et source, HEAD, index,
   chemins Git bruts triés, présence, mode, taille et SHA-256 des octets de
   chaque côté, états conflit/merge et dirty des sous-modules. Inclure tous les chemins du catalogue,
   même retenus ; mtime/size seuls ne suffisent pas. Les octets privés et cette
   empreinte ne sont jamais transmis à D/E ; snapshot_id opaque les désigne.
4. Relire indépendamment les mêmes entrées, index, HEAD et catalogue ; comparer
   leurs empreintes à la capture. En cas de différence, abandonner et réessayer
   une fois dans le budget de dix secondes, puis unavailable. La comparaison
   sur octets réduit les courses, mais un programme externe ignorant les
   verrous peut toujours écrire après la vérification. Le snapshot expose les
   octets capturés et vérifiés, pas une promesse d'atomicité du système de fichiers.
5. Générer les hunks et pages uniquement à partir de cette copie. Recalculer la
   signature courante avant première page, continuation et verdict. Si elle
   diffère, superseded/stale_revision ; ne jamais hydrater une ancienne page
   depuis le fichier courant. Si le snapshot est perdu ou expire, cursor_expired
   et nouvelle capture avec nouvelle review, pas reconstruction sous le même ID.

Les fichiers ignorés hors catalogue ne déclenchent pas d'obsolescence ; un
changement des règles ignore qui change le catalogue en déclenche une. Les
liens sont capturés sans déréférencement et sans export de leur cible ; un
sous-module conserve son OID, et son état dirty rend le contenu local partiel,
sans prétendre capturer ses fichiers internes. S9 refuse actuellement les API
git_review_snapshot/read_file_pair sous WSL : cette capture WSL est un lecteur
nouveau, avec les mêmes tests, ou une indisponibilité explicite jusqu'à livraison.

Le cache local est privé, borné et détruit à expiration ; les octets autorisés
capturés n'entrent ni dans Git ni dans le relais brut. Pour les contenus retenus
par la politique, seule l'empreinte locale subsiste, jamais leurs octets. Si
le lecteur ne peut calculer cette empreinte dans son budget, il refuse toute
la capture plutôt que déclarer sa fraîcheur vérifiée. Sa réalisation
doit limiter le stockage agrégé, proposé à 64 Mio par instance, puis refuser
resource_limit. La sécurité d'export s'applique avant toute création de page.

### Champs proposés et lecture

Tous les champs qui ne proviennent pas de S10 sont de nouvelles projections.
La réutilisation des formes de S9 ne signifie pas servir son snapshot mutable.
La future ressource review garde état/révision S10, utilise review_ref V et
source ci-dessous ; related_run devient facultatif et doit correspondre à
run_id s'il est présent. Cette modification n'est pas permise dans A1 1.0.

| Objet/champs | Définition proposée | Source ou travail nouveau |
| --- | --- | --- |
| `review_ref` V | `type: review`, instance_id, workspace_id, task_id, project_id, review_id ; run_id? seulement s'il est connu | Nouvelle variante de S10 pour ne pas fabriquer de run historique ; C valide la liaison tâche/projet et run quand présent |
| `review.source` et `diff_ref.source` | Union fermée : `{kind: commits, base_sha, head_sha}` ou `{kind: staged/unstaged/local_total, head_oid: SHA ou null}` | Nouvelle union, remplace git_revision dans la future ressource review ; SHA S10 seulement pour commits, HEAD observé S11 ou null pour unborn |
| `diff_ref` | `review_ref`, `review_revision`, `source`, `snapshot_id` | Référence/révision S10 adaptées en V ; snapshot opaque nouveau lié au dépôt, sélection et empreinte locale ; aucun faux SHA pour les côtés index/worktree |
| `diff_summary.availability` | `available`, `partial`, `unavailable` | Nouveau ; partial si contenu retenu, binaire, taille ou type non affichable ; unavailable si aucun snapshot fiable |
| `diff_summary.reason?` | `not_git`, `missing_provenance`, `git_object_missing`, `repository_unavailable`, `unsupported_target`, `resource_limit` | Nouveaux codes fermés : sélection/capture non prouvée, commit/arbre/blob référencé absent, dépôt inaccessible ; absents quand available. La révision de review périmée produit stale_revision, jamais un de ces codes |
| `file.file_id` | Identifiant opaque stable dans le snapshot | Nouveau ; correspondance locale vers les chemins Git bruts, jamais hash public d'un chemin sensible |
| `file.old_path?`, `new_path?` | Chemins relatifs d'affichage validés et expurgés ; absents si supprimés pour sécurité ou côté inexistant | Deltas Git S7 ; encodage sûr nouveau. Jamais chemin machine, `..`, absolu ou chemin servant d'autorité à une lecture |
| `file.change` | `added`, `deleted`, `modified`, `renamed`, `type_changed`, `unchanged` | Statuts inspirés de S9 ; nouveau mapping : chmod seul → modified ; changement de catégorie de mode regular/symlink/submodule → type_changed ; renommage → renamed ; unchanged uniquement pour un chemin du catalogue local_total dont présence, mode et octets HEAD/worktree sont identiques, avec zéro hunk |
| `file.old_mode?`, `new_mode?` | Mode Git octal des côtés existants | Nouveau lecteur de deltas ; un chmod seul n'est pas un diff vide |
| `file.kind` | `text`, `binary`, `unsupported_encoding`, `submodule`, `symlink` | Nouveau classement exclusif depuis S9 : submodule puis symlink selon modes ; sinon binary si un côté binaire ; sinon unsupported_encoding si un côté non UTF-8 ; sinon text. Un côté absent n'affecte pas ce classement |
| `file.too_large`, `file.withheld` | Deux booléens indépendants du kind | Nouveau ; taille excessive d'un côté ou ligne, et rétention par politique/provenance. Aucun hunk si un booléen est vrai ou kind n'est pas text |
| `file.old_oid?`, `new_oid?` | OID Git des côtés existants pour sous-modules seulement | Nouveau ; aucune récupération distante |
| `file.local_dirty?` | Booléen, uniquement pour un sous-module dans une source locale | Nouveau depuis son état Git observé ; true impose une disponibilité partielle, sans prétendre montrer ses changements internes |
| `file.redacted` | Booléen indiquant une altération du texte ou du chemin | Nouveau, pas de détail permettant de reconstituer les secrets |
| `hunk.hunk_index`, `line_offset` | Index et offset dans le hunk pour une page pouvant continuer le même hunk | Nouveau, lié au snapshot et au fichier |
| `hunk.old_start`, `old_count`, `new_start`, `new_count` | Coordonnées du hunk complet | S9 comme forme ; valeurs produites entre les deux arbres ou côtés immuables de la source choisie |
| `hunk.lines[]` | `kind: context/added/removed/no_newline`, `text`, `old_line?`, `new_line?` | Forme S9 ; marqueur no_newline nouveau, sans faux numéro de ligne |

Le contexte libre du header `@@ ... @@ nom_de_fonction` n'est pas exporté.
Les coordonnées sont numériques. Le texte des lignes et les chemins passent
par la même protection locale que les messages, avant tout découpage. Un
fichier retenu ne livre ni lignes ni chemins interdits par les filtres. Ce rendu est une
projection de consultation, pas une API d'application de patch.

Lectures nouvelles proposées : `review.diff.list` prend `review_ref`,
`expected_revision`, `cursor?`, `limit` de 1 à 25 ; `review.diff.read` prend
`diff_ref`, `file_id`, `cursor?` et `limit` de 1 à 200 lignes. Aucune lecture
n'accepte de chemin ou de SHA arbitraire. Les résultats disponibles contiennent `diff_ref`,
`items`, `has_more`, `next_cursor?` et, pour le catalogue, `diff_summary`.
La variante de catalogue indisponible contient uniquement `diff_summary`,
`items: []` et `has_more: false` : ni diff_ref ni curseur, puisqu'aucun snapshot
fiable n'existe. La référence de review reste dans target de l'enveloppe.
Une lecture de fichier dont le snapshot devient indisponible retourne une
erreur, pas cette variante de catalogue ni un diff_ref inventé.
La fin d'une page n'est pas une troncature du fichier. Un fichier trop grand
ou retenu est une entrée explicite sans hunks ; il n'est pas omis du catalogue.

Pour list, `items` est une liste de file. Pour read, `items` est une liste de
fragments de hunk : chaque fragment répète les coordonnées du hunk complet,
son `hunk_index`, le `line_offset` de son premier enregistrement et `lines`.
L'offset compte tous les enregistrements, y compris no_newline qui a un texte
vide et aucun numéro de ligne. Les lignes normales sont celles de S9, avec
numéros des seuls côtés concernés. Un fragment est non vide. La limite de
200 compte ces enregistrements sur toute la page. Un même hunk peut continuer
à la page suivante ; le curseur porte hunk_index et prochain offset. Après sa
dernière ligne, il passe au hunk suivant, offset zéro. `has_more` signifie
qu'il reste un enregistrement, pas que les comptes old/new du hunk sont faux.
Les marqueurs no_newline suivent immédiatement la ligne concernée ; ils
peuvent être premiers dans une page de continuation. Un fichier sans hunk
retourne items vide et has_more false.

Bornes nouvelles proposées : 200 Kio par côté de fichier pour l'affichage,
comme ordre de grandeur S9, appliqués aux blobs ou côtés capturés ; 4 Kio par ligne
UTF-8 après protection. Une ligne plus longue rend le fichier `too_large`
plutôt que fabriquer un hunk complet avec une ligne amputée. Un blob non UTF-8
est `unsupported_encoding`, jamais converti silencieusement avec perte.
Un nom non représentable est retenu avec `file_id`, `withheld: true` et
`redacted: true`. Un binaire trop grand garde kind binary et too_large true ;
un sous-module au chemin retenu garde kind submodule et withheld true. Dans un
type_changed, la priorité des catégories ci-dessus s'applique aux deux côtés.
Un renommage sans changement de texte conserve ses deux noms et modes, avec
zéro hunk. L'ordre catalogue est celui des chemins Git bruts comparés par
octets puis statut, figé par snapshot ; les noms expurgés ne servent pas au tri.

C impose aussi un budget de calcul nouveau : dix secondes et au plus 10 000
entrées de catalogue par snapshot. Si le catalogue complet ne peut être
établi, résultat `unavailable/resource_limit`, pas un catalogue apparemment
exhaustif amputé. Le temps CPU de détection de renommage doit respecter ce
budget. Un snapshot vit au plus cinq minutes ; sa perte retourne
`cursor_expired`. La reprise refait le même diff uniquement si la review reste
courante ; pour une source locale perdue, une nouvelle capture a une nouvelle
identité de review. Aucun commit de checkpoint automatique n'est créé.

Si la tâche est sans Git, si un commit nécessaire manque ou si le dépôt
est inaccessible, conserver le marqueur A1 de projection partielle de S6/S10.
Sans review existante, aucune `diff_ref` artificielle n'est créée : E affiche
l'indisponibilité depuis la tâche. Avec review existante mais objet disparu,
la lecture renvoie une indisponibilité typée et le verdict est refusé jusqu'à
revalidation. Un dépôt redevenu disponible ne change jamais la source capturée.
L'absence de run durable n'interdit pas une review V liée à la tâche et au
projet lorsque sa source est vérifiable ; A1 1.0 conserve sa restriction actuelle.

### Obsolescence et verdict

La review décrit exactement la source affichée : comparaison commits ou côtés
locaux capturés. C conserve, en plus de S10, une
liaison locale nouvelle : identité du dépôt, cible d'exécution S6, branche
source, branches suivies si applicables, OID capturés et run courant s'il est connu.
Ces noms/chemins restent locaux. Les transitions suivantes sont nouvelles :

| Événement vérifié par C | Transition proposée |
| --- | --- |
| Nouveau run pour la tâche, reprise d'exécution après review, ou changement du run auquel la review est liée | `superseded`, révision avancée ; nouvelle review avec nouvelle identité lorsque les preuves sont disponibles |
| Tâche supprimée, annulée, ou projet retiré de ses cibles ; changement de mode, branche source/cible, worktree ou identité réelle du dépôt | Même transition, invalidation de tous les snapshots de cette review |
| Branche suivie pour commits ne résout plus l'OID capturé | superseded ; des OID historiques fixes ne suivent pas HEAD et restent valides si les objets existent |
| Source locale : HEAD, index logique, catalogue, modes ou empreintes de côtés diffèrent, conflit/merge apparaît | superseded ; le fait que le worktree soit sale n'est pas une erreur, seule une différence avec la capture compte |
| Source commits fixe : seuls index/worktree changent | Aucune obsolescence de la comparaison historique ; E rappelle qu'elle ne couvre pas ces changements locaux |
| Titre, marqueur de lecture, date d'observation ou état d'affichage seul change | Aucune obsolescence, tant que la liaison d'exécution et les preuves Git restent identiques |
| Révocation des droits ou perte réseau | Refus d'accès/indisponibilité, sans réécriture de la review canonique |
| Objet Git temporairement introuvable ou erreur de lecture | Verdict suspendu avec git_object_missing ou repository_unavailable ; aucune reconstruction à partir du répertoire courant |

Un état `superseded` ne revient jamais à pending, même si HEAD revient à sa
valeur précédente. C émet `review.updated` avec la nouvelle révision selon S10.
Un changement non observé ne peut être garanti par un simple watcher : C
refait les contrôles avant chaque première lecture, reprise de page et verdict.

Avant `review.submit`, ordre nouveau à imposer dans C : autorisation actuelle,
idempotence S10, verrou de sérialisation par cible, comparaison
`expected_revision`, review encore pending, liaison tâche/run éventuel/cible identique,
sélection de source inchangée, preuves disponibles. Pour commits, vérifier
les égalités aux OID sélectionnés, les objets et les branches suivies ; pour
une source locale, vérifier la signature complète courante contre la capture,
sans exiger un worktree propre. Comparer aussi diff_ref.source à review.source,
puis enregistrement durable du seul verdict. Toute divergence sémantique
avance d'abord la review en superseded et retourne `stale_revision`.
Un défaut d'accès ou de disponibilité ne simule pas un changement de révision.

Les opérations Git locales Macro partagent cette sérialisation. Un outil Git
externe ne respecte pas le verrou applicatif : C relit la signature Git après
l'enregistrement, publie aussitôt superseded si elle a changé, et ne présente
jamais le verdict comme une autorisation d'intégration. Le point de décision
est la dernière vérification réussie, pas une promesse que HEAD restera fixe.
Tout futur mécanisme de merge devra revalider lui-même et reste hors périmètre.

Une répétition authentifiée de la même commande retrouve son résultat durable
S10, même si la review a changé depuis ; E relit son état courant, le résultat
historique n'annule pas superseded. `changes_requested` et `approved` clôturent
la review pour ce projet ; un nouveau verdict requiert une nouvelle review.

## Transport, budgets et responsabilités

### Formes filaires proposées

Tous les objets suivants sont nouveaux, fermés aux propriétés inconnues.
`V` et `T` sont des variables de conception pour les futures versions A1 et
transport, pas des chaînes à envoyer. Aucune valeur de version n'est adoptée.

| Message | Champs obligatoires et variantes |
| --- | --- |
| Lecture | `{contract_version: V, type: read_request, request_id, kind, target, limit}` ; `cursor?` facultatif ; aucune idempotency_key de mutation |
| Cible conversation.list | `target` est taskRef A1 ; limite 1 à 25 |
| Cible conversation.read | `target` est conversation_ref ; limite 1 à 25 |
| Cible review.diff.list | `target` est review_ref V ; `expected_revision` obligatoire ; limite 1 à 25 |
| Cible review.diff.read | `target` est `{diff_ref, file_id}` ; limite 1 à 200 ; la révision attendue est diff_ref.review_revision |
| Succès | `{contract_version: V, type: read_result, request_id, kind, target, data}` ; identité et kind exactement ceux de la lecture |
| Erreur | Forme A1 `{contract_version: V, type: error, request_id, error}` ; même request_id ; error conserve code/message/retryable/resource? et ajoute `reason?` fermé aux raisons d'indisponibilité du tableau diff |

`request_id` est un identifiant opaque choisi par l'application, distinct de
la séquence du flux. `kind` est l'un des quatre noms de lecture ci-dessus.
Le champ `data` d'une lecture conversation contient exactement la page
snapshot définie plus haut ; items vaut conversation_summary pour list, message
pour read. Celui d'une lecture diff disponible contient exactement diff_ref,
items, has_more, next_cursor? et diff_summary pour list seulement. Un catalogue
indisponible contient exactement diff_summary avec availability unavailable
et reason obligatoire, items vide et has_more false ; diff_ref et next_cursor
sont interdits. Sa review est identifiée par target, sans snapshot fictif. Si
aucune review n'existe, not_found, sans diff_ref inventée.

Les erreurs de validation, droits, absence de ressource et curseur utilisent
les codes A1 existants ; unavailable porte une reason définie si elle concerne
Git. `missing_provenance` signifie sélection de source ou capture non prouvée,
`git_object_missing` signifie commit/arbre/blob absent malgré sa référence
connue, `repository_unavailable` signifie dépôt inaccessible. Une différence
d'expected_revision reste stale_revision. Aucune erreur ne renvoie du texte Git.

La future enveloppe T conserve les champs exchange/delivery/delivery_result
actuels. `exchange.message` puis `delivery.message` acceptent read_request ;
`delivery_result.message` accepte read_result ou error. D associe
exchange_id/delivery_id à request_id, kind et target, et rejette toute réponse
qui ne correspond pas, y compris une autre portée d'instance. `X-Request-Id`
reste l'ID HTTP distinct utilisé pour une erreur avant admission de l'échange.
Le polling de résultat et les contrôles d'acteur restent ceux du transport.
Le resume_point des nouvelles pages de conversation est dans data, jamais
dans le champ externe réservé aux pages task de la version précédente.

Les événements proposés conservent la forme complète S10 : contract_version V,
type event, event_type, stream_id, sequence, resume_cursor, emitted_at,
resource, revision, snapshot. Pour conversation.changed/removed, resource est
conversation_ref ; snapshot est `{type: conversation_invalidation, ref,
revision, state: changed|removed}`. Pour un ajout, retrait, changement de
relation ou de summary du catalogue, un nouvel événement conversation.catalog_changed
utilise taskRef comme resource et snapshot `{type: conversation_catalog_invalidation,
ref, revision}`. Références/révisions sont identiques entre enveloppe et
snapshot. Ce sont des invalidations, jamais des snapshots de contenu déguisés.
Chaque catalogue affecté reçoit sa propre révision. Les batches, curseurs et
contrôles de continuité S10 sont conservés dans la future version ; les unions
de références et snapshots devront accepter explicitement ces formes.

### Budgets

Choix nouveaux : au plus 128 Kio de texte contrôlé cumulé par page ou événement,
et vérification finale du JSON UTF-8 sérialisé avec tous ses en-têtes logiques.
La borne existante de 1 048 576 octets concerne l'enveloppe entière. C réduit le
nombre d'items avant sérialisation ; il ne coupe jamais le JSON. Les chaînes
échappées et caractères multioctets comptent dans cette dernière mesure.
D garde sa limite existante et refuse un dépassement, sans le réparer.

Une réponse vide avec `has_more: true` est interdite : si un item ne tient pas,
utiliser son état explicite excerpt/withheld/too_large ou une erreur de budget.
Les nouveaux curseurs ne contiennent aucun secret ou chemin lisible ; leurs
preuves et droits sont revalidés à chaque page. Les permissions de lecture
restent distinctes de `review` pour le verdict. Les droits projet futurs sont
un point de contrôle commun, pas une décision prise dans ce projet.

| Lot | Changement minimal après adoption, tous nouveaux sauf réemploi indiqué |
| --- | --- |
| A | Version négociée, références/listes/lectures et événements nouveaux, erreurs, schémas et fixtures ; rattachement explicite aux enveloppes de transport ; préciser les bornes et invariants hors JSON Schema |
| C | Export automatique whitelist sous droits appareil/projets, classification provider, révisions de conversation ; lecteurs immuables commits et index/worktree, capture/copie/empreinte/cache/fraîcheur manquants à S11, wrappers typés, sélection et liaison de source, obsolescence et verdict ; réemploi S1 à S11 sans copie aveugle |
| D | Accepter la future version négociée, relayer lectures/invalidation, revalider droits et révocation, conserver les limites ; aucun stockage canonique des messages ou du code |
| E | Catalogue/fil automatique, reprise et état périmé ; sélection parmi reviews de sources offertes par C, libellé précis commits/staged/unstaged/local_total, hunks liés au snapshot, bannière binaire/renommage/taille, blocage superseded ; aucun rendu actif |

## Choix raisonnables et décisions produit

Les champs minimaux, la lecture de messages stabilisés, les limites chiffrées,
le texte inerte, la comparaison directe de deux arbres, la pagination par
snapshot et l'obsolescence conservatrice sont des propositions techniques
testables. Elles n'exigent pas d'inventer des règles de compte ou d'accès projet.

Les choix produit suivants doivent être acceptés ou remplacés avant adoption :

- Ce minimum suit le texte des conversations Implement liées aux tâches, pas
  les chats autonomes ni les pièces jointes. Si le critère 5 exige davantage,
  définir cette portée avant de figer une version.
- Le choix par défaut de source dans l'UI, staged/unstaged/local_total ou
  comparaison de branche, doit suivre le workflow réel. Les quatre variantes
  sont conçues ici, sans obliger à committer ni choisir une base de début de
  tâche. La capture cohérente manquante de S11 est du travail technique, pas
  un motif pour exclure les changements locaux du besoin produit.

L'export automatique après autorisation de l'appareil et des projets est la
direction produit demandée. La confirmation par contenu n'est ni proposée ni
en attente d'arbitrage. Le risque résiduel des filtres reste décrit ; il ne
justifie pas de bloquer tous les textes jusqu'à une validation locale.

Proposition prudente supplémentaire : désactiver `approve` si le catalogue est
incomplet ou si un fichier est binaire, retenu, trop grand ou non représentable ;
permettre seulement `request_changes` avec avertissement. Autoriser l'approbation
d'un diff partiellement visible est un vrai choix produit, à confirmer. La
sécurité d'export, l'absence de raisonnement privé et l'absence de merge implicite
ne sont pas des options à assouplir pour débloquer ce choix.

## Tests de référence à ajouter après adoption

Ces tests ne sont pas présents dans le contrat figé. Leurs données seront
synthétiques et publiques ; le présent travail de documentation ne les exécute pas.

- Conversations : deux tâches et deux conversations distinctes ; dates égales
  avec ordre ID ; insertion antidatée, modification et suppression entre pages ;
  reprise après expiration/redémarrage ; absence de run historique ; contexte
  contradictoire refusé ; phase idle sans preuve de fin ne devenant pas complete.
- Sécurité : champs internes exclus, raisonnement balisé complet/ouvert et
  provenance inconnue retenus ; aucun delta brut ; secrets répartis près d'une
  limite de coupe ; caractères multioctets/JSON échappé ; titre sensible ; liens
  et HTML inertes ; aucune URL de pièce jointe chargée. Chaque provider existant
  doit prouver sa séparation des canaux ou produire withheld.
  Tester aussi droits appareil/projets absents ou révoqués, nouveau message
  exporté automatiquement sans intervention locale, politique changée, secret
  sur plusieurs lignes ou limite de page, détection rendant tout le fichier
  withheld et absence d'empreinte privée dans le résultat.
- État du texte : réponse complète, fin length, motif inconnu, vrai texte vide,
  excerpt et withheld distincts ; erreurs runtime jamais exportées brutes.
- Git sur dépôt temporaire : deux SHA divergents prouvant comparaison directe
  et non merge-base ; ajout/suppression/modification/renommage pur/modification
  de mode ; binaire, symlink, sous-module, nom avec tabulation ou retour ligne,
  UTF-8 invalide, ligne longue, limite de blob et catalogue hors budget. Exécuter
  le même attendu sur le producteur natif et WSL si cette cible est supportée.
- Review : changement de HEAD, cible, tâche ou run pendant pagination et avant
  verdict ; index/worktree sale, HEAD revenu après superseded ; titre seul sans
  invalidation ; objet manquant et projet sans Git ; aucune lecture de fichier
  mutable utilisée comme preuve d'un SHA ; aucune mutation Git par lecture/verdict.
  Une paire existante différente de la sélection enregistrée est refusée ;
  une comparaison de branche ou d'OID fixes ne nécessite pas de preuve de
  début de tâche. Vérifier staged HEAD→index, unstaged index→worktree et
  local_total HEAD→worktree, y compris différences annulées, non suivis,
  dépôt unborn sans faux SHA, run historique absent et worktree sale inchangé.
  Écriture pendant hydratation, remplacement à taille/mtime identiques,
  changement d'index après page1, nouveau fichier et règle ignore modifiée
  doivent invalider la capture ; pages servies uniquement depuis sa copie.
  Empreintes et octets privés ne sont pas exportés, quotas/expiration du cache
  fonctionnent, et aucun commit/stash/stage/write-tree n'est créé.
  Vérifier change unchanged quand staged/unstaged s'annulent, ainsi que fichier
  secret connu haché localement sans cache de contenu ni export ; son changement
  invalide la review. Une impossibilité de hachage refuse la capture entière.
  Distinguer preuve absente, objet Git absent et dépôt inaccessible. Vérifier
  chmod pur, binaire trop grand, sous-module au chemin retenu, fragments de hunk
  et marqueur no_newline à cheval sur deux pages.
- Concurrence : deux verdicts, répétition idempotente, révocation avant retour,
  modification externe après contrôle et nouvel événement superseded ; résultat
  historique n'effaçant pas l'état courant ; approbation partielle bloquée selon
  la politique adoptée.
- Transport : schéma ancien rejetant l'extension, négociation explicite, scopes
  croisés refusés, curseur volé inutilisable, pas de page JSON amputée, budget
  enveloppe entière respecté et distinction fin de page/troncature du contenu.
  Vérifier corrélation request_id/kind/target dans les succès et erreurs,
  invalidations avec enveloppe complète et révision du bon catalogue.
  Tester titre/activité/politique modifiés sans changement d'appartenance,
  observation seule sans boucle d'invalidation, et catalogue Git indisponible
  sans diff_ref ni curseur suivi d'une lecture de fichier en erreur.

Le document est un livrable de conception seulement. Sa validation autorise
une discussion d'adoption, pas le branchement de ces messages sur C/D/E.
