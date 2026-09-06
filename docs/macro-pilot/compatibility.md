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

Une nouvelle propriété, valeur d'énumération, commande ou forme de message
demande une nouvelle version du contrat. Chaque consommateur annonce la liste
exacte des versions qu'il comprend dans la ressource `instance`. Les deux côtés
choisissent une version commune avant d'échanger des commandes. Cette version
ne définit pas le mécanisme de découverte ou de négociation réseau.

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
`waiting_decision` ou `completed` porte `started_at`. Tout run terminal porte
`finished_at` ; un run non terminal ne le porte pas.

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

## Invariants relationnels

JSON Schema valide la forme de chaque message. Les règles suivantes complètent
la validation et font partie du contrat :

- la cible `resource` d'un événement est identique à la référence de son
  `snapshot` ;
- la référence `related_run` d'une review reprend les identifiants instance,
  workspace, tâche et run de la review ;
- la référence `waiting_on` d'un run reprend la même portée jusqu'au run ;
- les projets d'action et de contexte d'une tâche sont distincts ;
- chaque projet d'action possède exactement une cible d'exécution ;
- seul un run `waiting_decision` porte `waiting_on`, qui est alors obligatoire ;
- une décision répond une fois à chaque étape ;
- une réponse égale à un choix de son étape est un choix ; toute autre chaîne
  respecte `free_text_allowed` ;
- une commande `decision.resolve` répond au plus une fois à chaque étape ;
- seule une décision `resolved` porte une résolution, qui est alors obligatoire ;
- les identifiants d'étape et les chaînes de choix sont uniques dans leur
  portée ;
- le type de chaque élément d'une page correspond à `item_type` ;
- la révision d'un événement correspond à celle de son snapshot ;
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
- les réponses de `decision.resolve` couvrent les étapes de la décision à
  `expected_revision` et respectent leurs choix et leur règle de texte libre ;
- `review.ref.project_id` correspond à une cible `git` de la tâche liée au run ;
- `base_sha` et `head_sha` existent dans ce dépôt au moment de créer la review.

Un écart de portée produit `invalid_reference`. Une décision ou une review
ayant changé de révision produit `stale_revision`.

## Données autorisées sur le mobile

Les références sont des identifiants opaques. Les libellés servent uniquement
à l'affichage. Aucun champ stable ne représente un chemin local, une clé de
provider, un jeton GitHub, un secret de session ou des justificatifs d'accès au
dépôt. `avatar_url` accepte seulement HTTPS. Le producteur doit expurger les
données sensibles de `message`, `title`, `prompt`, `note` et des réponses avant
de créer l'enveloppe. Le relais et le mobile ne journalisent jamais l'entrée non
expurgée. `safeText` bloque des signatures courantes de chemins machine, jetons
et clés privées comme défense supplémentaire ; cette liste ne prétend pas
reconnaître tous les secrets. Le mobile reçoit des SHA Git, jamais des
identifiants d'accès au dépôt.
