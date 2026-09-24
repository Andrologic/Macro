# Transport natif et relais, version 1.0

> Extension A2 : les nouvelles décisions et formes publiques sont définies dans
> [content-contract-v2.md](content-contract-v2.md). Ce document décrit la base
> 1.0 ; ses anciennes questions ne limitent pas le périmètre 2.0. Aucun support
> runtime 2.0 n’est annoncé avant intégration et négociation des consommateurs.

Cette spécification publique complète les ressources A1 de
`contracts/macro-pilot/v1`. C implémente le client desktop, D les routes serveur
dans le dépôt privé du site, E le client Flutter dans le dépôt privé mobile.
Les routes ci-dessous sont relatives à une origine HTTPS configurée dans les
applications, sous `/pilot/v1`. Aucun framework ni hébergeur n'est imposé.

Macro reste ouvert et exécute le moteur et les providers existants. Il conserve
les tâches, runs, décisions, reviews et leur historique canonique. D possède
les comptes, sessions, accès et la présence des instances ; il transporte les
requêtes de supervision vers C. Il n'exécute ni outils ni providers. Le site
public ne propose aucun compte web. L'utilisation locale reste sans compte.

Pour modifier le coffre desktop ou son interface de reprise, consulter le
[cycle de vie du coffre](vault-lifecycle.md).

## Règles communes

Les corps sont du JSON UTF-8 fermé, avec `transport_version: "1.0"` pour les
objets de transport décrits ici. Les messages A1 encapsulés conservent
`contract_version: "1.0"`. Une version inconnue est rejetée avant traitement.
Les schémas A1 restent inchangés. Un objet indiqué entre accolades dans les
tables énumère tous ses champs obligatoires ; `?` marque un champ optionnel.
Les IDs suivent `opaqueId` d'A1. Les dates sont UTC RFC 3339, les durées des
secondes entières. Les libellés suivent `safeText`, limités à 120 caractères.

Chaque requête API, y compris GET et DELETE sans corps, porte `X-Request-Id`,
identifiant aléatoire du client conforme à `opaqueId` A1. S'il est absent ou
invalide, D rejette la requête avec HTTP 400 `validation_failed` et génère un
identifiant conforme pour cette erreur. D renvoie aussi `X-Request-Id` dans
toutes ses réponses, avec la valeur retenue.
Les routes authentifiées exigent `Authorization: Bearer <session_token>`.
Les preuves ne passent jamais dans les URL, cookies de compte web ou messages
A1. Réponses d'authentification et de relais : `Cache-Control: no-store`.
Les logs expurgent corps sensibles, en-têtes d'autorisation et codes GitHub.
Les clients refusent les redirections HTTP des routes API et les origines
non configurées. Les routes natives ne s'authentifient pas par cookie ; CORS
n'accorde pas d'accès à une origine web tierce.

Un corps décodé est limité à 1 048 576 octets, enveloppe comprise. Un dépassement
retourne 413 avant décodage complet, sans tronquer un message. D limite à 100
échanges en attente par instance et 10 par session ; une saturation retourne
429 et `Retry-After`. Aucun lot A1 ne dépasse ses propres bornes.

Les erreurs API utilisent l'enveloppe A1 `error`, avec `request_id` repris de
`X-Request-Id`. HTTP 400 correspond à `validation_failed`, 401 à `unauthorized`
ou `session_revoked`, 403 à `forbidden`, 404 à `not_found`, 409 à `conflict` ou
`stale_revision`, 410 à `cursor_expired` pour une reprise, 413 à
`validation_failed`, 429 et 503 à `unavailable`. `retryable` vaut true pour
429/503, false pour les autres. Une erreur de version utilise
`unsupported_version`, HTTP 400. D ne recopie aucune erreur GitHub brute.

## Connexion GitHub initiée dans une application

Le parcours utilise le Device Authorization Flow GitHub, activé côté serveur.
L'application ouvre le navigateur système sur `https://github.com/login/device`
et montre le code fourni par GitHub. Elle attend son résultat par requêtes
authentifiées par un secret temporaire. Aucun deep link ni callback de compte
sur le site n'est nécessaire. Le secret OAuth et le `device_code` GitHub
restent exclusivement chez D. Aucun scope de dépôt ou d'email n'est demandé.

| Méthode et route | Corps ou résultat |
| --- | --- |
| `POST /auth/attempts` | Corps `{transport_version, client_kind, device_label, claim_challenge}` ; `client_kind` vaut `desktop` ou `mobile`, simple indication d'affichage. 201 `{transport_version, attempt_id, poll_secret, user_code, verification_uri, expires_at, interval}`. |
| `POST /auth/attempts/{id}/poll` | Corps `{transport_version}` ; `Authorization: Bearer <poll_secret>`. 202 `{transport_version, status: "pending", interval}` ou 200 `{transport_version, status: "identified", account}` avec compte A1 vérifié. |
| `POST /auth/attempts/{id}/claim` | Corps `{transport_version, account_id, claim_secret}` ; même preuve de polling. 200 `{transport_version, account, device_session, session_token}`. |
| `DELETE /auth/attempts/{id}` | Même preuve, aucun corps ; 204. Annule une tentative non réclamée. |

D génère `attempt_id` et `poll_secret` indépendamment, le secret contient 256
bits aléatoires cryptographiques encodés base64url. Le secret n'est connu que
de l'application initiatrice et de D, qui en conserve une empreinte pour
comparaison constante. L'ID seul n'autorise ni lecture, ni annulation, ni claim.
Avant la création, l'application génère indépendamment un `claim_secret` de
256 bits cryptographiques, base64url sans padding, et le garde dans son coffre
OS. Elle envoie uniquement `claim_challenge`, le SHA-256 des octets ASCII de
ce secret encodé, également base64url sans padding. D vérifie cette empreinte
en temps constant lors de chaque claim, y compris ses répétitions. Le vol du
seul `poll_secret` ne permet donc pas de réclamer ou récupérer un jeton.
Le secret de claim n'est ni retourné par D ni envoyé au navigateur.
D borne la tentative au minimum de l'expiration GitHub et de 10 minutes.
`interval` vaut au moins 5 secondes et respecte les réponses `slow_down` GitHub.
D ne poll GitHub qu'à cette fréquence, même si plusieurs requêtes natives
arrivent. Une tentative expirée ou refusée retourne HTTP 401 `unauthorized` ;
l'application propose une nouvelle connexion, sans boucle de création.

D échange le résultat GitHub et interroge `/user` pour chaque tentative. Il
crée ou retrouve le compte par `provider: github` et l'ID numérique stable
converti en chaîne, jamais par un login ou un `account_id` fourni par le client.
Il détruit ensuite le jeton GitHub, utilisé uniquement pour identifier le
compte. L'application affiche l'identité obtenue et demande confirmation avant
`claim`. Le compte envoyé à `claim` doit être exactement celui identifié.
Une tentative ne peut pas changer de compte après identification.

`claim` crée atomiquement un nouveau `device_id`, une session et un jeton
attribués par D. Le `session_token` contient 256 bits cryptographiques
indépendants, base64url sans padding. Aucun ID d'appareil soumis par le client n'est
accepté comme preuve ou réutilisé. La session expire après 30 jours, sans
renouvellement implicite ; une nouvelle connexion crée une autre session et
requiert une nouvelle association. Le jeton reste dans le stockage sécurisé
de l'OS, jamais dans Git ou les journaux. D conserve son empreinte.

Une répétition de `claim` avec les deux secrets de la même tentative retourne le même résultat
pendant 60 secondes afin de tolérer une réponse perdue. Cette unique copie
temporaire du jeton est chiffrée au repos avec une clé serveur hors Git ; après
ce délai, la tentative devient inutilisable. Si le client ne récupère pas le
résultat, il recommence la connexion ; il ne peut pas recréer des sessions par
rejeu de l'ancienne tentative. Un autre secret ne peut jamais récupérer le
résultat. Une session révoquée n'est jamais réémise par ce cache.
La copie des deux secrets ou du jeton de session permet une usurpation tant
qu'ils sont valides ; le protocole n'est pas une attestation matérielle.

Les codes sont montrés comme liés à l'application initiatrice : ne pas accepter
un code envoyé par un tiers. Ce flow résiste à la devinette et au rejeu, mais
ne prétend pas empêcher une victime d'autoriser volontairement un code de
phishing. Les tentatives sont limitées à 5 par minute par adresse réseau et
les échecs de preuve sont limités à 10 par tentative avant invalidation.

Le choix s'appuie sur le
[Device flow GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
Les précautions générales suivent le
[BCP OAuth 2.0](https://www.rfc-editor.org/rfc/rfc9700.html).

## Instance desktop et association explicite

| Méthode et route | Corps ou résultat |
| --- | --- |
| `GET /me` | 200 `{transport_version, account, device_session}` pour la session authentifiée. |
| `POST /directory/query` | Corps `page_request` A1, types limités à `device_session`, `instance_access`, `instance`. Retour `page` A1, limité au compte courant. |
| `POST /instances` | Corps `{transport_version, creation_id, label, instance_key_hash}`. 201 `{transport_version, instance, instance_access}`. |
| `POST /instances/{id}/attach` | Corps `{transport_version}` et preuve producteur. 200 `{transport_version, instance, instance_access}` ; lie une nouvelle session du propriétaire au desktop existant. |
| `POST /instances/{id}/access-requests` | Corps `{transport_version}`. 201 `{transport_version, access_request_id, expires_at}`. |
| `GET /instances/{id}/access-requests` | Preuve producteur. 200 `{transport_version, requests}` ; liste de `{access_request_id, device_session, device_label, expires_at}`. |
| `POST /instances/{id}/access-requests/{request}/resolve` | Preuve producteur ; corps `{transport_version, verdict, permissions?}`. Verdict `grant` exige liste de permissions A1, verdict `deny` l'interdit. 200 `{transport_version, status}` où status vaut `granted` ou `denied`. |
| `POST /instances/{id}/access/{session}/revoke` | Preuve producteur ; corps `{transport_version, expected_revision}`. 200 ressource `instance_access` A1 révoquée. |

Avant la création, C génère une `instance_key` de 256 bits cryptographiques,
base64url sans padding, et la conserve dans son coffre OS avec `creation_id`.
Il transmet uniquement `instance_key_hash`, SHA-256 des octets ASCII de la clé
encodée, base64url sans padding. D attribue l'ID d'instance,
avec toutes les permissions A1 à la session créatrice. Le compte propriétaire
est immuable. La preuve producteur combine le jeton d'une session active de ce
compte et `X-Instance-Key`. Cette clé de 256 bits appartient à cette installation
desktop, stockée dans le coffre OS ; D en conserve l'empreinte. Elle est un
identifiant client propre à l'installation, pas un secret OAuth serveur.
L'annonce `client_kind: desktop` ne donne aucun pouvoir sur une instance
existante. Un mobile malveillant peut créer sa propre instance, jamais prendre
celle d'un autre client par son ID. En cas de perte de la clé, C crée une nouvelle
instance ; le protocole ne fournit pas de récupération par connaissance de l'ID.

D traite `creation_id` comme clé d'idempotence liée à la session et conserve
durablement le résultat non secret jusqu'au `expires_at` de la session
créatrice, fixé à 30 jours lors du claim. Sa révocation interdit immédiatement
tout retry, même si le résultat est encore conservé. Après expiration, l'ancien
jeton est refusé ; une nouvelle session ne réutilise pas cette clé de création.
Un retry de même corps pendant la session active retourne
la même instance et le même accès ; un corps différent retourne 409. C garde
la clé localement avant l'envoi et peut donc retrouver le résultat après perte
de réponse sans créer une instance orpheline. D ne retourne jamais la clé.

`attach` exige cette clé et le même compte. Il rétablit l'accès producteur après
une nouvelle connexion, sans transférer les droits d'une session mobile.
`directory/query` montre les instances du compte pour permettre l'association,
mais ne donne pas accès à leur contenu. Un autre compte reçoit 404 pour l'ID.
Les curseurs de directory sont liés au compte et au type de liste.

La demande d'accès cible uniquement la session authentifiée, expire après
5 minutes, au plus une demande en cours par session et instance. Le desktop
présente l'appareil et choisit explicitement les permissions. D recontrôle les
deux sessions et le compte commun, puis résout une seule fois la demande.
Une répétition identique retourne le même statut ; un verdict différent ou une
demande expirée retourne 409. Le mobile relit sa liste `instance_access` après
confirmation. La possession d'un ID d'appareil ne suffit jamais pour s'associer.
Un retry de création pendant ces cinq minutes retourne la même demande et
le même `access_request_id`, même si elle est déjà résolue. Après expiration,
la même route crée une nouvelle demande. Le délai n'est jamais prolongé par
un retry. Le mobile peut toujours retrouver un accès accordé via directory.

## Acheminement HTTP des messages A1

Tous les appels viennent des applications vers D. C maintient un long polling
sortant de 25 secondes, aucun port entrant sur le desktop. Les objets
`exchange`, `delivery` et `delivery_result` sont définis par le schéma public
`contracts/macro-pilot/transport/schema.json` ; les secrets restent en en-têtes.

| Méthode et route | Corps ou résultat |
| --- | --- |
| `POST /instances/{id}/exchanges` | Corps `exchange`, session cliente autorisée. 202 `{transport_version, exchange_id, expires_at}`. |
| `GET /instances/{id}/exchanges/{exchange}` | Session créatrice de l'échange uniquement. 202 même objet pendant l'attente, ou 200 `delivery_result`. |
| `POST /instances/{id}/deliveries/poll` | Preuve producteur, corps `{transport_version}`. 200 `delivery` ou 204 après 25 secondes. |
| `POST /instances/{id}/deliveries/{delivery}/authorize` | Preuve producteur, corps `{transport_version}`. 200 `{transport_version, execute_before}`. |
| `POST /instances/{id}/deliveries/{delivery}/result` | Preuve producteur, corps `delivery_result`. 204 après validation et enregistrement temporaire. |
| `POST /instances/{id}/disconnect` | Preuve producteur, corps `{transport_version}`. 204, instance immédiatement `unreachable`. |
| `POST /commands` | Corps commande A1 `session.revoke` exclusivement. Résultat A1 ; D traite sans desktop. |

`exchange.message` est une commande A1 autre que `session.revoke`, un
`page_request` de supervision ou un `resume_request`. Le client choisit
`exchange_id` aléatoirement. D lie cet ID à la session et à l'instance ; même
ID et contenu retourne la même réponse, autre contenu retourne 409. Une
commande conserve aussi sa propre clé d'idempotence A1. Un échange en attente
expire après 60 secondes. Aucun échange n'est accepté si C n'est pas joignable.

D vérifie le compte propriétaire, la session active, l'accès `granted` et la
permission de la matrice A1 avant mise en file, avant livraison, avant
autorisation et avant retour du résultat. `issued_by` d'une commande doit
égaler exactement l'acteur dérivé du jeton ; sinon 403, aucune correction
silencieuse. Les références `instance_id` doivent correspondre à la route.
Une page de supervision exige un scope A1 de cette instance. Un flux est
enregistré pour cette instance ; un `stream_id` fourni ne change pas le routage.

Les pages relayées acceptent uniquement `workspace`, `project`, `task`, `run`,
`decision`, `tool_approval` et `review`. D traite comptes, sessions, accès et
instances dans ses routes d'identité et de directory. Une demande de reprise
exige `supervise` sur l'instance ; D compare le flux avec le point de reprise
publié par C. Pour toutes ces lectures, D contrôle aussi que les ressources du
résultat appartiennent à l'instance ciblée avant de les transmettre.

`delivery.actor` vient de D, jamais du corps non vérifié du client.
`delivery.message` est le message A1 original. C vérifie références, version,
révision et invariants contre son état canonique. La possession de la clé
producteur autorise uniquement la livraison et les réponses de cette instance.
Les permissions d'utilisateur ne permettent pas de publier un résultat.

Avant chaque effet, C appelle `authorize`. D vérifie que la livraison existe,
est encore en attente, que la session et les droits sont valides et fixe
`execute_before` à maintenant plus 5 secondes. C enregistre durablement la
clé A1 et son état d'exécution avant l'effet, sous exclusion mutuelle avec
les commandes locales. Une autorisation expirée requiert une nouvelle
vérification. La révocation interdit toute nouvelle autorisation ; une
opération autorisée avant la révocation peut déjà être en cours et finir.
D ne peut pas annuler rétroactivement cet effet. Une réponse à une session
désormais révoquée n'est pas livrée.

Une livraison non terminée peut être redélivrée, avec le même `delivery_id`,
le même acteur et le même message. C ne réexécute jamais une commande dont le
résultat est connu. Une exécution interrompue de résultat indéterminé reste
bloquée jusqu'à réconciliation locale, sans rejouer automatiquement l'outil.
Le registre d'idempotence de C est durable pour toute la durée de la session
et refuse les clés d'une session expirée. Une commande répétée avec une autre
révision ou un autre contenu produit `conflict`, avant vérification de cette
révision. D transporte le résultat canonique ; HTTP 202 signifie seulement
mise en attente, jamais acceptation de la commande.

`delivery_result` doit correspondre à la livraison, à l'instance et au type de
requête. Une commande retourne `command_result` avec ses IDs et cible exacts,
ou une erreur A1 ; une page retourne le même `item_type`, une reprise le même
flux et les mêmes valeurs `after_*`. D refuse les réponses non corrélées.
Une répétition du même résultat est admise ; un résultat différent retourne
409. Une erreur A1 utilise l'ID d'échange comme `request_id`.

Le relais garde uniquement les échanges et résultats en mémoire jusqu'à leur
expiration de 60 secondes, au plus 60 secondes après complétion pour un résultat.
Un redémarrage peut les perdre ; un échange perdu retourne 404, et le client
resoumet une commande avec la même clé A1, jamais une nouvelle intention.
Ces bornes définissent un transport transitoire, pas un historique canonique.
Une rétention durable supplémentaire reste à arbitrer.

## Présence, reprise et déconnexion

Chaque poll producteur authentifié renouvelle une présence de 40 secondes.
C relance immédiatement après 204, avec une seule boucle par instance. D
refuse un second poll concurrent par 409. Sans renouvellement, l'instance
devient `unreachable` ; fermeture normale appelle `disconnect`. Le mobile
affiche cet état et les requêtes retournent 503, sans file d'exécution différée
pour la prochaine ouverture de Macro. C peut continuer son travail local sans
réseau, mais ne traite plus de nouvelle intention distante sans autorisation.

E suit les changements en envoyant un `resume_request` A1 par échange, au plus
une reprise en cours par flux et au moins 2 secondes entre deux lots vides.
C conserve le flux de supervision et ses curseurs. Si le curseur n'est plus
disponible, il retourne `cursor_expired`. E relit des pages de snapshots puis
reprend un nouveau flux. Pour amorcer sans course, une page de bootstrap de
type `task` inclut dans l'enveloppe de transport du résultat un point de reprise
`stream_id`, `after_cursor`, `after_sequence` capturé avant sa lecture ; E
applique ensuite les événements après ce point en ne gardant que les révisions
plus récentes. Ce point et la pagination se rapportent au même scope.

Concrètement, toute première requête `page_request` de type `task`, sans
`cursor`, exige `delivery_result.resume_point`. Les pages suivantes conservent
le même point et la même vue paginée, identifiés par les curseurs opaques de C.
C conserve les événements postérieurs au point durant la pagination ; s'il ne
peut plus le garantir, la page ou la reprise échoue avec `cursor_expired` et E
recommence. Le `resume_point` est interdit sur les autres types de résultat.
Les noms `requested` des événements correspondent à l'état `pending` d'A1.

La déconnexion utilisateur envoie `session.revoke` à D puis efface le jeton
local. Si le réseau manque, l'application efface le jeton et indique que la
révocation serveur n'a pas été confirmée ; l'expiration serveur reste applicable.
D révoque les accès de cette session, invalide ses requêtes en attente et coupe
sa présence producteur. Les autres sessions restent actives. `attach` après
une nouvelle authentification exige encore la clé d'instance. Une révocation
concurrente à `claim` ou à une livraison ne restaure jamais l'ancienne session.

## Vérifications d'acceptation C, D et E

Les fixtures A1 et le test du transport sont publics et hors réseau. Les
consommateurs ajoutent les scénarios d'intégration suivants avec faux GitHub et
horloge contrôlée, puis un essai natif réel avant publication :

- un résultat GitHub stable produit le même compte et deux sessions distinctes ;
  faux login, faux compte au claim, ID seul et mauvais poll secret sont refusés ;
- une tentative expirée, refusée ou réclamée hors fenêtre ne produit aucun jeton ;
  une réponse perdue au claim ne crée pas une seconde session ;
- un poll secret volé sans claim secret ne retourne aucun jeton, même pendant
  la fenêtre de répétition ; une empreinte différente échoue ;
- la perte de réponse à la création d'instance restitue la même instance avec
  la clé déjà conservée par C ; une association répétée retrouve sa demande ;
- un autre compte, un appareil auto-déclaré ou un client sans clé producteur ne
  peut ni attacher l'instance ni accorder des accès ni publier de résultats ;
- un `issued_by` falsifié, une cible étrangère ou un accès révoqué est refusé
  avant exécution ; même intention rejouée ne produit qu'un effet ;
- perte réseau avant/après effet, résultat perdu et crash du relais préservent
  l'idempotence ; un état local indéterminé ne déclenche aucun rejeu ;
- questionnaire, approbation et review passent par le moteur desktop ouvert,
  avec concurrence locale/mobile et rejet de révision périmée ;
- fermeture desktop, expiration de présence, session ou curseur sont visibles ;
  reconnexion reprend les révisions sans inventer d'historique côté relais.

Les tests du lot A valident les enveloppes, pas ces effets serveur ou desktop.
La review Git conserve son verdict seul. La spécification ne choisit ni une
opération merge/push supplémentaire ni une rétention durable du relais.
