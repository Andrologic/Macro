# Compatibilité du contrat Macro Pilot

## Version prise en charge

Le contrat stable courant est `1.0`. Chaque message porte
`contract_version: "1.0"` et un champ `type` fermé. Un consommateur rejette une
version ou un type qu'il ne connaît pas. Il ne tente pas de les interpréter.

Le fichier `contracts/macro-pilot/v1/schema.json` est le point d'entrée. Les
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

Chaque appareil reçoit son propre `device_id` et sa propre session. Révoquer une
session ne révoque pas les autres sessions du compte. Une commande
`session.revoke` cible explicitement la session concernée.

Les références forment une portée hiérarchique. Un run contient les identifiants
de son instance, workspace, projet et tâche. Une décision et une review ajoutent
leur identifiant à cette portée. Un consommateur compare toute la portée avant
d'associer deux ressources.

## Révisions et commandes

Chaque ressource mutable porte une révision entière. Une commande fournit
`expected_revision`, un `command_id` et une `idempotency_key`. Le service
accepte une seule commande pour le couple `session_id` et `idempotency_key`,
puis renvoie le premier résultat lors d'une répétition identique. Réutiliser la
même clé avec un contenu différent produit `conflict`. Une révision différente
produit `stale_revision`. Une cible mal formée ou qui ne correspond pas à sa
ressource produit `invalid_reference`.

`review.submit` enregistre un verdict sur les SHA `base_sha` et `head_sha` de la
review. Ce contrat ne lui attribue aucun effet sur une branche, un merge ou un
push.

## Pagination et reprise

Les listes utilisent `page_request` et `page`. Le curseur est opaque. Quand
`has_more` vaut `true`, `next_cursor` est obligatoire. Tous les éléments d'une
page ont le `type` annoncé.

Un flux ordonne ses événements avec `sequence`. Chaque événement fournit un
`resume_cursor`. `resume_request` reprend après le dernier curseur traité. Le
contrat ne fixe ni durée de rétention ni stockage central. Un serveur qui ne
peut plus reprendre ce curseur répond avec l'erreur typée `cursor_expired`.

## Invariants relationnels

JSON Schema valide la forme de chaque message. Les règles suivantes complètent
la validation et font partie du contrat :

- la cible `resource` d'un événement est identique à la référence de son
  `snapshot` ;
- la référence `related_run` d'une review reprend les identifiants instance,
  workspace, projet, tâche et run de la review ;
- la référence `waiting_on` d'un run reprend la même portée jusqu'au run ;
- le choix d'une décision résolue existe dans `choices` ;
- les identifiants de choix d'une décision sont uniques ;
- le type de chaque élément d'une page correspond à `item_type` ;
- la révision d'un événement correspond à celle de son snapshot ;
- une révision résultante ne peut pas être inférieure à la précédente.

Le validateur ciblé et les fixtures négatives vérifient ces règles. Chaque
implémentation doit les reproduire après la validation JSON Schema.

## Données autorisées sur le mobile

Les références sont des identifiants opaques. Les libellés servent uniquement
à l'affichage. Aucun message stable n'accepte un chemin local, une clé de
provider, un jeton GitHub, un secret de session ou des identifiants de dépôt.
Le mobile reçoit des SHA Git, jamais des justificatifs d'accès au dépôt. Le
producteur filtre aussi les chemins et secrets qui pourraient apparaître dans
les champs libres comme `message`, `title`, `prompt` ou `note`.
