# Notifications de compte, contrat 2.0

Cette tranche définit les opérations `notifications.register`,
`notifications.preference`, `notifications.unregister` et
`notification.resolve`. Elle ne fournit ni gestionnaire serveur ni intégration
native. `notifications-schema-set.json` compile `notifications.schema.json`
indépendamment du registre v2 historique. Sa seule dépendance est le fichier
`v1/common.schema.json` gelé, identifié par son `$id` public réel.

Le contrat garde `contract_version: "2.0"`. Ce sont des opérations de compte
additives, sans capacité d'instance. Le routeur sélectionne ce registre pour les
quatre noms exacts. Un ancien consommateur refuse une opération inconnue avec
`validation_failed` et `retryable: false` avant tout effet. Il conserve son
registre fermé. Le contrat v1 et les anciennes formes v2 restent identiques.
Un client ne rétrograde jamais ces opérations en v1 et ne déduit pas leur support
de celui d'une instance.

## Formes et points d'intégration

Chaque requête, réponse et erreur est un objet fermé portant `contract_version`,
`type`, `request_id`, `account_id` et `operation`. La requête ajoute `body`, la
réponse `result`, et l'erreur `code` et `retryable`. Les objets imbriqués sont
également fermés. Les identifiants suivent les bornes v2 de 1 à 128 caractères
ASCII, avec le motif `[A-Za-z0-9][A-Za-z0-9._:-]*`. La définition locale
`notificationIdentity` référence `v1/common.schema.json#/$defs/questionStepId`,
qui a ces bornes. Elle n'utilise pas `opaqueId`, dont le minimum v1 est différent.
Les révisions sont des entiers de 1 à `9007199254740991`.

Le schéma expose les unions `$defs/request`, `$defs/response`, `$defs/error`
et, pour chaque opération, `request_<opération>`,
`response_<opération>` et `error_<opération>`, notamment
`request_notification.resolve`. Le parent peut
référencer ces définitions via le `$id` du schéma notifications lors d'une
intégration future. La livraison initiale n'exige aucun changement du root v2,
du générateur ou des validateurs historiques.

Les identités du compte, de la session et de l'appareil proviennent de
l'authentification courante. `account_id` dans l'enveloppe sert à la corrélation
et doit correspondre au compte authentifié. Aucun body n'accepte ces identités,
une identité d'instance, des droits ou une capacité déclarée par le client.

## Inscription et rotation

`notifications.register.body` exige `provider`, `application`, `environment`,
`token` et `idempotency_key`. `provider` vaut `apns` ou `fcm`. APNs accepte
`sandbox` et `production`. FCM accepte uniquement `production`.

`application` est un identifiant natif ASCII de 1 à 200 caractères, avec le motif
`[A-Za-z0-9][A-Za-z0-9._-]*`. Le serveur vérifie sa présence dans une liste
explicite autorisant le triplet application, fournisseur et environnement. La
syntaxe seule n'autorise aucune application. Le serveur choisit les credentials
privés correspondant au triplet ; le client n'en fournit jamais.

`token` est une chaîne opaque non vide, limitée à 4096 caractères et à 4096
octets UTF-8. Le serveur conserve exactement ses octets, sans nettoyage,
normalisation ni interprétation. Les réponses ne renvoient jamais ce token.

Une inscription initiale omet `enrollment_id` et `expected_revision`. Elle crée
une inscription avec `revision: 1` et `enabled: false`. Le résultat fermé
contient seulement `enrollment_id`, `revision` et `enabled`. Un résultat de
register ou preference désigne toujours une inscription active. Aucun champ
`status` redondant n'est ajouté.

Il existe au plus une inscription active pour le tuple compte, session,
appareil, application, fournisseur et environnement, même si elle est
désactivée. Une nouvelle clé d'idempotence visant un tuple déjà inscrit produit
`conflict`. Une inscription supprimée ne se réactive pas ; une nouvelle
inscription reçoit un nouvel identifiant et commence sans consentement.

La rotation exige `enrollment_id` et `expected_revision` ensemble. Le serveur
vérifie le propriétaire authentifié, le triplet d'application inchangé,
l'état actif et la révision courante. Il remplace atomiquement le token par un
token différent, incrémente la révision de un et conserve exactement `enabled`.
Un token identique avec une nouvelle clé produit `conflict` ; une répétition
avec la même clé suit les règles d'idempotence. La rotation conserve le
consentement seulement pour la même inscription et le même triplet. Changer
l'application, le fournisseur ou l'environnement exige une nouvelle inscription
initialement désactivée. L'ancien token cesse immédiatement d'être utilisable.

## Consentement et suppression

`notifications.preference.body` exige `enrollment_id`, `enabled`,
`expected_revision` et `idempotency_key`. Le client émet `enabled: true` après
un choix explicite de l'utilisateur et l'autorisation native du système. La
permission du système seule ne constitue pas un consentement Macro. Le serveur
vérifie le propriétaire et la révision avant la mutation. Le résultat contient
`enrollment_id`, `revision` et le booléen `enabled` demandé.

`notifications.unregister.body` exige `enrollment_id`, `expected_revision`
et `idempotency_key`. Le serveur supprime le token et révoque les notifications
liées dans la même transaction. Le résultat fermé contient `enrollment_id`,
`revision`, `state: "removed"` et `enabled: false`. Le résultat ne contient
aucun outcome alternatif. Un nouvel unregister visant un enregistrement déjà
supprimé produit `not_found`, sauf rejeu idempotent encore admissible.

Chaque mutation réussie avec une nouvelle clé incrémente la révision de un,
y compris une préférence qui conserve le même booléen. Un rejeu retourne la
révision du reçu original et n'incrémente rien. Une révision périmée produit
`stale_revision` sans effet. Au plafond d'entier sûr, le serveur refuse toute
nouvelle mutation avec `resource_limit` plutôt que de déborder.

La révision fait aussi office de génération d'inscription. Une rotation,
une préférence ou une suppression invalide les notifications et les envois
en attente de la révision précédente. Un passage off puis on ne restaure
aucune ancienne notification. La déconnexion, la révocation de session, la
suppression du compte et un rejet permanent du token par le fournisseur
suppriment le token et invalident l'inscription concernée. Un échec temporaire
du fournisseur ne réactive ni inscription ni consentement.

## Notification générique et résolution

L'envoi affiche une notification générique fixe, définie par le produit. Son
seul champ de corrélation applicatif est `notification_id`, opaque et
imprévisible, issu d'au moins 128 bits d'aléa. Il ne contient aucun message,
titre dynamique, nom de projet, conversation, diagnostic, URL ou action.
Le token et les identités privées restent dans le transport fournisseur.

`notification.resolve.body` exige seulement `notification_id`. La réponse
contient `destination`, `observed_at` et `expires_at`. `destination` est fermé
et vaut `{ "kind": "instance_activity", "instance_id": "instance-demo" }`.
Il permet seulement l'ouverture de l'activité de cette instance. La résolution
n'approuve aucun outil, aucune décision et aucune action. Le consommateur
obtient ensuite les données courantes via leurs opérations autorisées.

Le serveur enregistre la notification avant l'envoi et lui lie le compte, la
session, l'appareil, l'inscription et sa révision, la génération de session,
l'instance, la génération d'accès et celle du producteur courant.
`observed_at` est la création originale de ce reçu serveur. `expires_at` est
strictement postérieur et au plus 15 minutes plus tard. Résoudre ou retenter
un envoi ne renouvelle jamais cette fenêtre.

Avant l'envoi et à chaque résolution, le serveur vérifie le compte et la
session actifs, l'appareil authentifié, l'inscription active et consentie,
sa révision inchangée, les générations courantes, le droit `supervise` pour
l'instance et le producteur encore courant. Un remplacement du producteur,
un changement d'accès ou de génération de session invalide les reçus existants.
La date courante doit être comprise entre `observed_at` inclus et `expires_at`
exclu. Ces vérifications et la lecture du reçu utilisent un état cohérent.
Un reçu absent, expiré ou invalidé produit `not_found`. Une identité étrangère
produit aussi `not_found` pour ne pas révéler son existence. Un acteur du compte
qui n'a plus le droit requis reçoit `forbidden`.

Le consommateur recontrôle son compte et sa session courants avant l'ouverture.
Il abandonne toute réponse arrivée après changement de compte ou session et
toute réponse expirée. Une notification déjà affichée peut subsister dans le
centre natif, mais sa résolution suit toujours les contrôles courants.

## Quotas, idempotence et rétention

Les limites suivantes sont des plafonds d'admission transactionnels.
Le serveur purge les entrées expirées avant de compter et ne supprime aucune
entrée encore protégée pour libérer de la place.

| Ressource | Limite et rétention |
| --- | --- |
| Inscriptions actives, désactivées comprises | 512 par compte, 32 par session, une par tuple d'inscription. Conservation jusqu'au retrait ou à la révocation. |
| Tokens retirés | Suppression immédiate du stockage opérationnel et des files d'envoi. |
| Tombstones d'inscription sans token | 24 heures depuis le retrait, au plus 2048 par compte. Réserver une place lors de l'inscription ; cette réservation compte dans le plafond de 2048. |
| Reçus de mutation idempotente | 24 heures depuis la première réussite, au plus 2048 par compte, toutes sessions confondues. |
| Reçus de notification | Au plus 15 minutes depuis la création, au plus 2048 par compte et 256 par session. |
| Enveloppe sérialisée | 256 Kio UTF-8 au maximum. |

Les trois mutations exigent `idempotency_key`. Sa portée est le compte,
la session et l'appareil authentifiés, plus l'opération. Le serveur compare
l'empreinte du body complet, y compris la révision et le token pour register.
Il utilise une empreinte authentifiée avec une clé privée, sans garder le token
brut dans le reçu. Une clé répétée avec un body différent produit `conflict`.
L'inscription, le CAS et le reçu sont persistés atomiquement avant le succès.
La première réponse réussie fixe l'expiration, que les rejeux ne prolongent pas.
Les erreurs ne réservent pas de clé.

Le serveur recontrôle l'acteur avant tout rejeu. Pour register et preference,
il retourne le reçu seulement si l'inscription existe encore, avec la révision
et l'état exacts du reçu. Pour unregister, il exige le tombstone correspondant.
Un état ayant évolué produit `stale_revision`, un reçu supprimé `not_found`.
Le rejeu ne ressuscite donc ni token ni consentement. Après expiration, la clé
peut servir à une nouvelle tentative soumise aux règles ordinaires de tuple,
d'inscription et de CAS.

Une admission qui dépasserait un quota produit `resource_limit`, sans mutation
partielle. L'inscription réserve son futur tombstone pour que la suppression
reste possible. Les révocations de session et de compte ne dépendent pas d'une place dans le
registre d'idempotence. Si ce registre est plein, le client peut utiliser la
révocation de session existante pour retirer immédiatement les inscriptions.

## Erreurs et confidentialité

Les codes fermés sont `validation_failed`, `not_found`, `conflict`,
`stale_revision`, `resource_limit`, `forbidden` et `unavailable`.
`retryable` vaut false sauf pour `unavailable`, qui peut valoir true si le
serveur sait qu'une répétition avec la même clé peut aboutir. Un conflit, une
révision périmée ou une limite exigent une décision ou un nouvel état du client.
Les erreurs n'ajoutent aucun message ni détail fournisseur.

Le stockage privé chiffre les tokens et limite leur lecture au gestionnaire
d'inscription et à l'émetteur. Les credentials APNs/FCM, clés d'empreinte et
paramètres locaux restent hors dépôt. Les logs, traces, métriques, diagnostics,
reçus publics et erreurs ne contiennent jamais les tokens ou credentials,
y compris lors d'une validation échouée. Les logs techniques utilisent le code
d'erreur, l'opération et des corrélations privées bornées. Les fixtures utilisent
uniquement le token synthétique de 64 caractères.

## Restauration d'une sauvegarde

Une restauration invalide toutes les inscriptions sauvegardées avant de rendre
le service disponible. Le serveur supprime leurs tokens du stockage restauré,
retire leurs consentements, et invalide les reçus de notification et de mutation
associés. Il change les générations de session, d'accès et de producteur selon
les règles d'authentification existantes. Aucun ancien token, reçu ou retry ne
peut donc reprendre après restauration. Le mobile doit effectuer une nouvelle
inscription initialement désactivée, puis recueillir un nouveau consentement.
La validation de sauvegarde et la procédure de restauration doivent appliquer
cette règle, y compris si une sauvegarde contient encore un token chiffré.

## Validation de la tranche

Exécuter `node contracts/macro-pilot/test/validate-notifications.mjs` ou la même
commande avec Bun. Le test compile directement le registre avec AJV, vérifie
les fixtures propres à cette tranche, les invariants sémantiques, les échanges,
les bornes et le refus par le registre v1 gelé. Il n'importe aucun validateur
historique v2 ni définition du lot fichiers.

`notifications-validate.mjs` exporte quatre points d'entrée synchrones :

- `validateMessage(message)` vérifie la forme, les octets du token, la durée
  du reçu et la sémantique de `retryable`.
- `validateExchange(request, response)` ajoute la corrélation, le consentement
  initial off, l'incrément CAS et la concordance des résultats de mutation.
- `validateResolution(request, response, context)` vérifie le reçu contre un
  instantané serveur courant et authentifié. `context` contient `now` en
  millisecondes, `actor`, `enrollment`, `notification`, `access` et `producer`.
  Le test fournit la structure précise de cet instantané avec des exemples
  synthétiques. Ce contexte reste interne et ne traverse jamais le protocole.
- `createNotificationsValidator(shape)` construit ces trois fonctions à partir
  d'un validateur AJV compilé. Le corps de cette factory utilise uniquement
  JavaScript standard, `TextEncoder` et `structuredClone`, et peut être repris
  par le générateur navigateur. Le chargement public de ce module utilise
  `node:fs` et AJV pour Node et Bun ; il ne constitue pas encore un module
  navigateur généré.

Ces helpers ne prouvent ni l'authenticité de l'instantané, ni l'atomicité du
serveur, ni la liste d'applications autorisées, ni la conservation du consentement
pendant la rotation, ni les quotas et la purge. Les futurs gestionnaires doivent
vérifier ces règles avec leur stockage courant. La validation du message seul
ne suffit jamais à autoriser une inscription, un envoi ou une résolution.
