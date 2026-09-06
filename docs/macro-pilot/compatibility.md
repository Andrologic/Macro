# Compatibilité du contrat Macro Pilot

## Version prise en charge

Le contrat stable courant est `1.0`. Chaque message porte
`contract_version: "1.0"` et un champ `type` fermé. Un consommateur rejette une
version ou un type qu'il ne connaît pas. Il ne tente pas de les interpréter.

Le fichier `contracts/macro-pilot/v1/schema-set.json` est le registre portable.
Un consommateur charge chaque ressource listée, vérifie que son `$id` correspond
à l'identifiant déclaré, l'enregistre, puis compile l'identifiant `root` du
registre. `schema.json` est ce schéma racine, mais pas un bundle autonome. Les
schémas utilisent JSON Schema 2020-12. Le validateur active les assertions de
format `date-time` et `uri`. Les fixtures sont du JSON ordinaire et peuvent
donc alimenter les tests Serde en Rust, les tests TypeScript et les tests Dart
sans conversion.

Après publication de cette base initiale, une nouvelle propriété, valeur
d'énumération, commande ou forme de message demandera une nouvelle version du
contrat. Chaque consommateur annonce la liste exacte des versions qu'il comprend
dans la ressource `instance`. Les deux côtés choisissent une version commune
avant d'échanger des commandes. Cette version ne définit pas le mécanisme de
découverte ou de négociation réseau.

## Identités et portée

Le compte est indexé par le couple GitHub stable `provider` et `subject`.
`login`, `display_name` et `avatar_url` sont des données d'affichage mutables.
Ils ne servent jamais à retrouver ou autoriser le compte.

Chaque appareil reçoit son propre `device_id` et sa propre session de compte.
La session existe avant toute association à une instance et peut accéder à
plusieurs instances. Chaque autorisation utilise une ressource
`instance_access` distincte. Révoquer une session ne révoque pas les autres
sessions du compte. Une commande `session.revoke` cible explicitement la
session concernée et porte son `account_id`. Cet identifiant doit correspondre
à celui de l'acteur. Le service vérifie aussi que la session authentifiée
appartient à cet acteur. Il renvoie `forbidden` pour une cible d'un autre compte
et `unauthorized` si l'identité de l'acteur ne correspond pas à la session
authentifiée.

Les permissions distinguent la supervision, les réponses aux questionnaires,
les approbations d'outils et les reviews Git. `approve_tools` est obligatoire
pour résoudre une ressource `tool_approval` ; `respond` ne suffit pas.

Toute opération liée à une instance exige une session `active` et une
`instance_access` de cette session vers cette instance avec l'état `granted`.
La permission minimale est fermée par opération :

| Opération | Autorisation minimale |
| --- | --- |
| lire les ressources d'une instance, paginer ou reprendre ses événements | `supervise` |
| `run.start`, `run.cancel` | `supervise` |
| `decision.resolve`, `task.reply` | `respond` |
| `tool_approval.resolve` | `approve_tools` |
| `review.submit` | `review` |
| lire ou révoquer ses propres sessions et accès | session authentifiée du même compte |

Le serveur filtre aussi chaque événement avant de l'émettre. Une permission de
mutation n'accorde pas implicitement `supervise`, et inversement. Une commande
sans accès accordé ou sans permission requise produit `forbidden` ; une session
inactive produit `unauthorized` ou `session_revoked` selon son état.

Les références forment une portée hiérarchique. Une tâche appartient à une
instance et un workspace, puis liste ses projets d'action et ses projets de
contexte. Un run et une décision restent liés à cette tâche unique. Une review
Git ajoute le projet concerné à la portée du run. Un consommateur compare toute
la portée avant d'associer deux ressources.

Une ressource `project` publie `repository_state`. La valeur `not_git` est
valide. Le mode `git` ou `direct` est figé par projet dans les
`execution_targets` de la tâche.

Une session `revoked` porte `revoked_at`, alors qu'une autre session ne le porte
pas. Une session `expired` porte `expires_at`. Un run `running`,
`waiting_reply`, `waiting_decision`, `waiting_tool_approval` ou `completed` porte `started_at`.
Tout run terminal porte `finished_at` ; un run non terminal ne le porte pas.

## Révisions et commandes

Chaque ressource mutable porte une révision entière. Une commande fournit
`expected_revision`, un `command_id` et une `idempotency_key`. Le service
accepte une seule commande pour le couple `session_id` et `idempotency_key`,
puis renvoie le premier résultat lors d'une répétition identique. Réutiliser la
même clé avec un contenu différent produit `conflict`. Une révision différente
produit `stale_revision`. Une cible mal formée ou qui ne correspond pas à sa
ressource produit `invalid_reference`. Un résultat `rejected` contient une
erreur et aucune `resulting_revision`.

`review.submit` enregistre un verdict sur les SHA `base_sha` et `head_sha` de la
review. Ce contrat ne lui attribue aucun effet sur une branche, un merge ou un
push.

Une décision contient une ou plusieurs étapes. Chaque étape expose les trois
choix utilisés par `QuestionStep` et indique si une réponse libre est permise.
`decision.resolve` répond à toutes les étapes en une commande et conserve
`expected_revision`. Une réponse conserve la chaîne brute de Macro. Elle est un
choix si elle est exactement égale à une chaîne de `choices`, sinon elle est du
texte libre.

Une approbation d'outil est une ressource `tool_approval` séparée, et non un
questionnaire à trois choix. Sa cible reprend l'instance, la conversation, le
message de l'assistant et l'appel d'outil exacts. La réponse est binaire :
`approve` ou `deny`. Une approbation ajoute la portée `once` ou `conversation`,
si cette portée figure dans `allowed_scopes`. Un refus n'a aucune portée et peut porter
un motif expurgé. Une demande `interrupted` n'a plus de résolveur actif et ne
peut pas recevoir de résolution distante ; une nouvelle exécution doit produire
une nouvelle demande.

`tool_approval.resolve` porte la même révision attendue, l'idempotence et
l'acteur que les autres commandes. Le service revalide la politique, le
contexte d'exécution et la portée au moment de l'acceptation. Une portée
`conversation` ne s'applique qu'au même outil et à la même clé interne de
permission ; cette clé n'est jamais envoyée au mobile.

Une approbation liée à une tâche ajoute ensemble `workspace_id` et `task_id`.
`run_id` est ajouté seulement si le run est connu. Une conversation autonome
les omet tous. Le run
utilise alors `waiting_tool_approval` et la même référence comme `waiting_on` ;
un run en `waiting_decision` attend exclusivement une `decisionRef`.

`task.reply` répond à une attente simple, sans questionnaire. La tâche fournit
`reply_context` ou signale explicitement son absence. Les règles de projection
des anciennes tâches, les références sans run et les provenances locales ou
inconnues sont définies dans [la correspondance des types](macro-type-mapping.md).
Elles n'assouplissent pas l'authentification des commandes réseau.

Une `review` Git reste une troisième ressource distincte. Son verdict enregistre
l'état de la review et n'autorise ni merge, ni push, ni changement de branche.

## Pagination et reprise

Les listes utilisent `page_request` et `page`. Le curseur est opaque. Quand
`has_more` vaut `true`, `next_cursor` est obligatoire. Tous les éléments d'une
page ont le `type` annoncé.

Un flux attribue une séquence contiguë à chaque événement. Chaque événement
fournit un `resume_cursor`. `resume_request` reprend après le dernier couple
`after_cursor` et `after_sequence`, puis produit un `event_batch`. Tous les
événements du lot ont le même `stream_id`. Leurs séquences continuent après
`after_sequence`. `next_cursor` et `next_sequence` correspondent au dernier
événement livré. Un lot vide reprend les deux valeurs précédentes. Le contrat ne
fixe ni durée de rétention ni stockage central. Un serveur qui ne peut plus
reprendre ce couple répond avec l'erreur typée `cursor_expired`.

Les événements `decision.requested` et `decision.resolved` portent
respectivement un snapshot `pending` et `resolved`. Les événements
`tool_approval.requested`, `tool_approval.resolved`, `tool_approval.expired` et
`tool_approval.interrupted` portent l'état du même nom. Les événements génériques `task.updated`, `run.updated` et
`review.updated` peuvent porter tout état valide de leur ressource.

## Invariants relationnels

JSON Schema valide la forme de chaque message. Les règles suivantes complètent
la validation et font partie du contrat :

- la cible `resource` d'un événement est identique à la référence de son
  `snapshot` ;
- la référence `related_run` d'une review reprend les identifiants instance,
  workspace, tâche et run de la review ;
- la référence `waiting_on` d'un run reprend la même portée jusqu'à la tâche
  pour `waiting_reply`, et jusqu'au run pour les deux autres attentes ;
- les projets d'action et de contexte d'une tâche sont distincts ;
- chaque projet d'action possède exactement une cible d'exécution ;
- seuls les runs `waiting_reply`, `waiting_decision` et `waiting_tool_approval` portent
  `waiting_on`, qui est alors obligatoire et du type correspondant ;
- une tâche `waiting_reply` porte soit `reply_context`, soit le marqueur
  `projection.missing: ["reply_context"]`, éventuellement avec d'autres
  marqueurs ; les autres états ne portent ni l'un ni l'autre ;
- une décision répond une fois à chaque étape ;
- une réponse égale à un choix de son étape est un choix ; toute autre chaîne
  respecte `free_text_allowed` ;
- une commande `decision.resolve` répond au plus une fois à chaque étape ;
- seule une décision `resolved` porte une résolution, qui est alors obligatoire ;
- les identifiants d'étape et les chaînes de choix sont uniques dans leur
  portée ;
- une approbation d'outil expose seulement `approve` ou `deny` ; seule une
  approbation porte une portée, qui appartient à `allowed_scopes` ;
- seule une approbation d'outil `resolved` porte une résolution ;
- une approbation peut identifier sa tâche sans run ; lorsqu'un run
  l'attend, ses identifiants instance, workspace, tâche et run sont identiques ;
- le type de chaque élément d'une page correspond à `item_type` ;
- la révision d'un événement correspond à celle de son snapshot ;
- le nom d'un événement de décision ou d'approbation correspond à l'état de son
  snapshot ;
- une révocation de session cible le compte de l'acteur ;
- les événements d'un lot appartiennent au flux annoncé et leurs séquences
  continuent sans doublon ni trou ;
- le curseur et la séquence suivants correspondent au dernier événement livré ;
- une révision résultante ne peut pas être inférieure à la précédente.

Le validateur ciblé et les fixtures négatives vérifient ces règles. Chaque
implémentation doit les reproduire après la validation JSON Schema.

## Validations contre l'état courant

Certaines références demandent les ressources courantes du service. Le service
effectue ces contrôles après la validation du message :

- une `instance_access` référence une session active du même compte ;
- l'acteur d'une commande correspond à la session authentifiée ;
- `task.reply` cible une tâche `waiting_reply` à la révision attendue ; la
  conversation correspond au `reply_context` courant et appartient à la tâche ;
  sans contexte exploitable, la réponse est refusée avec `invalid_reference` ;
- chaque changement d'attente ou de contexte avance la révision de tâche ; C
  sérialise les réponses locales et distantes et enregistre l'idempotence avant
  l'effet desktop ; une attente déjà consommée produit `stale_revision` ;
- une décision sans run identifie une conversation et un message appartenant
  à la tâche ; si un run est indiqué, cette appartenance est aussi vérifiée ;
- les réponses de `decision.resolve` couvrent les étapes de la décision à
  `expected_revision` et respectent leurs choix et leur règle de texte libre ;
- `tool_approval.resolve` cible une demande `pending` inchangée, l'acteur possède
  `approve_tools`, la portée demandée est autorisée et le contexte d'exécution
  correspond encore à celui enregistré par Macro ;
- une demande d'approbation `interrupted`, `expired` ou déjà `resolved` est
  refusée ;
- la conversation et l'appel d'outil de la demande appartiennent encore au run
  indiqué par sa référence, lorsqu'elle porte une portée de run ;
- `review.ref.project_id` correspond à une cible `git` de la tâche liée au run ;
- `base_sha` et `head_sha` existent dans ce dépôt au moment de créer la review.

Un écart de portée produit `invalid_reference`. Une décision, une approbation
d'outil ou une review ayant changé de révision produit `stale_revision`.

## Données autorisées sur le mobile

Les références sont des identifiants opaques. Les libellés servent uniquement
à l'affichage. Aucun champ stable ne représente un chemin local, une clé de
provider, un jeton GitHub, un secret de session ou des justificatifs d'accès au
dépôt. `avatar_url` accepte seulement HTTPS. Les champs internes `args`,
`detail` et `rememberKey` d'une approbation d'outil ne sont jamais exportés. Le
producteur construit à leur place un `summary` expurgé. Il doit aussi expurger
les données sensibles de `message`, `title`, `prompt`, `note` et des réponses
avant de créer l'enveloppe. Le relais et le mobile ne journalisent jamais
l'entrée non expurgée. `safeText` bloque des signatures courantes de chemins
machine, jetons et clés privées comme défense supplémentaire ; cette liste ne prétend pas
reconnaître tous les secrets. Le mobile reçoit des SHA Git, jamais des
identifiants d'accès au dépôt.
