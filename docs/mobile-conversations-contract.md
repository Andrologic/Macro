# Conversations v2 pour le compagnon mobile

Ce document décrit le lot desktop. Pour adapter le relais ou le mobile, utiliser
le schéma normatif `contracts/macro-pilot/v2/schema.json`, le validateur
`contracts/macro-pilot/v2/validate.mjs` et les fixtures du même répertoire.
Le générateur `dev/generate-macro-pilot-content-protocol.ts` produit les types et
le validateur navigateur. Les contrats v1 restent inchangés.

## Négociation et autorité

Proposer `conversations-1` pour une instance et conserver les capacités acceptées
par le relais. Chaque livraison de ces nouvelles opérations doit attester cette
capacité. `network-reliability-1` garde sa sélection et ses révisions indépendantes.
Les anciennes opérations `conversations.list` et `conversation.read` conservent
leurs formes et leurs règles. Un ancien relais peut rejeter la nouvelle offre.
Le producteur retire alors `conversations-1`, puis la capacité de fiabilité si
nécessaire, puis les capacités de tâches, jusqu'à retrouver une offre acceptée.

Le relais vérifie à chaque livraison et émission le compte, la session, l'accès
à l'instance et les permissions de portée. Les lectures exigent `supervise`.
`conversation.action`, `conversation.create` et `conversation.acknowledge`
exigent `respond`, attesté par `granted_permissions` dans l'autorisation.
Le desktop redemande cette autorisation avant les effets. La commande SQLite
vérifie la date d'expiration avant la transaction et avant son commit.
Une révocation ou un changement de compte ferme le propriétaire et purge les
captures et les jetons en mémoire. Les diagnostics exportés sont des codes
fermés, jamais le texte brut d'une erreur provider.

## Catalogue et filtres

Appeler `conversations.catalog` avec `instance_id`, `kind` et éventuellement
`filter`. `kind: conversation` regroupe Chat et Architect. `kind: implement`
contient seulement les conversations liées sans ambiguïté à une tâche réelle.
Les actions de gestion ne sont autorisées que pour le mode Chat.

Chaque carte fournit le titre, une description ou un aperçu contrôlé, les dates
ISO, le mode, le projet visible, l'épingle, l'archive, le non-lu, l'attention,
une révision de gestion et une révision de contenu. Le téléphone calcule les
dates relatives et les séparations temporelles. Titre, description et nom de
projet sont limités à 240, 320 et 120 caractères Unicode. Sans description, le dernier message utilisateur peut fournir un aperçu après
inspection de son texte complet. Sans message sûr, la ligne reste vide. Le champ
historique `last_message` n'est pas une preuve suffisante pour exporter une réponse, un raisonnement ou un outil.

Le desktop trie toutes les cartes par épingle, date décroissante puis identifiant.
Les filtres s'appliquent avant pagination sur le catalogue complet. `archived`
vaut `active` par défaut, ou `archived` / `all`. `attention` vaut `all` par
défaut, ou `unread`, `running`, `needs_attention`. Le projet et le mode peuvent
être combinés avec ces filtres. `needs_attention` inclut les demandes utilisateur,
les approbations d'outil et les erreurs, qui restent des états distincts.

`attention` vaut `none`, `generating`, `user_request`, `tool_approval`, `error`
ou `unknown`. Les demandes sont issues du store et des attentes persistées.
Une erreur n'accorde jamais une permission d'approbation. `provider_error`
est un diagnostic typé présent seulement pour un état d'erreur provider.
Le détail d'une attente utilise le parcours v1 existant, ou les opérations
v2 d'outils déjà négociées. L'erreur provider décrit la récupération possible. Après redémarrage, un
échec provider persisté reste une erreur distincte ; en l'absence de diagnostic
durable attesté, sa catégorie est `unknown` et invite à vérifier avant retry.

Le catalogue lit les lignes de conversation et leur état de gestion, puis au
plus le dernier message utilisateur pour composer un aperçu manquant. Il ne
charge pas toutes les transcriptions. La détection des questionnaires persistés
lit seulement les candidats indexés encore sans réponse utilisateur. Leur
contexte reste local et ne figure jamais dans les cartes.

## Recherche et accès au résultat

`conversations.search` prend `instance_id`, `kind`, `query`, le même `filter`
et une continuation optionnelle. Le desktop cherche d'abord dans les titres
et descriptions complets, puis dans son index de messages, avec casse et accents
normalisés. Les résultats de métadonnées précèdent ceux des messages. Chaque
résultat a un `hit_id` unique, une référence de conversation, un `title` requis,
une source, un
extrait de 320 caractères et un `message_id` uniquement pour un résultat de
message. `title` reprend exactement le titre contrôlé de la carte, limité à
240 caractères Unicode, pour les deux sources. Il peut être vide si la politique
retient le titre. Le client peut ainsi nommer une conversation absente des pages
de catalogue déjà chargées, sans télécharger le catalogue complet. Cette donnée
provient de la carte déjà construite et ne nécessite aucune lecture d'historique
supplémentaire. Les extraits FTS bruts ne sont jamais transmis : le desktop relit le
message concerné, vérifie sa provenance et sa politique d'export, puis compose
l'extrait à partir du texte visible. Raisonnement, payloads d'outils, contenu
non autorisé et secrets restent exclus.

Ouvrir un résultat de message avec `conversation.window`, en donnant sa `ref`
et son `message_id`. Le desktop renvoie une page commençant au plus cinq
messages avant le résultat. `position` reste la position réelle du message
dans le transcript. L'ouverture n'exige pas de télécharger les pages antérieures
sur le téléphone. Les continuations conservent le `message_id` d'origine.
L'absence d'un résultat supprimé ou d'une référence devenue invisible échoue
explicitement. Le parcours ne crée ni copie de conversation ni rattachement
fictif à une tâche.

## Lecture observée

Chaque page de `conversation.window` a un `read_token`, éventuellement nul.
Un jeton couvre uniquement les réponses complètes, exportables et observées
dans cette page. Le jeton conserve les versions exactes de ces réponses, sans
acquitter les réponses antérieures absentes d'une fenêtre de recherche. Le client appelle `conversation.acknowledge` avec la même
`ref` et ce jeton après affichage. Le jeton est lié au compte, à la session,
à l'instance et à la conversation, avec la durée de la capture. Une nouvelle
réponse écrite après cette observation reste non lue. SQLite vérifie aussi
l'expiration d'autorisation avant la transaction d'acquittement et avant son commit. Les acquittements répétés
ou reçus dans le désordre ne font jamais reculer la lecture.

Le desktop capture également les octets affichés avant son appel asynchrone
d'acquittement. Une réponse modifiée ou terminée entre l'affichage et la
vérification reste non lue jusqu'à une nouvelle observation. La sélection seule
ne peut pas acquitter des messages non chargés. Les états partagés sont conservés
dans SQLite, indépendamment du cache de transcript et du compte du compagnon.

## Gestion et création

`conversation.action` exige une référence Chat, `expected_revision` pris dans
la carte, un `idempotency_key` et une action : `rename`, `pin`, `unpin`,
`archive`, `restore`. `title` est requis uniquement pour `rename`. Épingler et
archiver expriment un état souhaité ; ils ne sont pas des bascules rejouables.
La mutation et son reçu sont enregistrés dans une même transaction SQLite.
Une modification desktop concurrente rend la révision distante périmée.

`conversation.create` prend `instance_id`, `idempotency_key` et éventuellement
`title`, `project_id`. Sans projet, le nouveau Chat est libre. Un projet fourni
doit appartenir au catalogue visible de l'instance. Aucun identifiant de tâche,
workspace, provider, modèle ou credential n'est accepté. Le chat créé est
persisté et ajouté au store desktop sans changer la sélection locale. Le mobile
ouvre la `ref` retournée et utilise son parcours d'envoi existant.

Conserver la même clé et le même corps après une réponse perdue. Le reçu est lié
au compte et à la session. Une répétition retourne `duplicate`, la référence
initiale et la révision d'application. Changer le corps en réutilisant la clé
retourne `conflict`. Même après redémarrage du desktop, un retry ne crée pas un
deuxième Chat. Le résultat de gestion indique la révision attendue plus un.
La création retourne la révision un. Un reçu ne remplace jamais une nouvelle
vérification des permissions.

Les archives existantes sont importées une seule fois depuis la préférence
historique. Le store d'archives et le parcours desktop écrivent ensuite l'état
partagé. Les opérations de suppression définitive, export et sélection multiple
ne font pas partie de cette capacité.

## Pagination, rafraîchissement et limites

Les pages contiennent au plus 50 éléments et restent sous le budget de transport
v2 de 256 KiB. Les captures durent au plus cinq minutes. Une continuation garde
la référence, les filtres, la requête et le curseur de la première page. Un autre
compte, une autre session ou un filtre différent ne peuvent réutiliser ce curseur.
Un catalogue modifié renvoie `stale_revision` ; une capture purgée ou expirée
renvoie `snapshot_expired`. Relancer une capture avec la requête conservée.
Le rafraîchissement peut conserver la liste déjà affichée pendant cette lecture,
puis la remplacer après une première page valide. Conserver côté mobile position,
recherche et filtre au retour du transcript. Purger ces caches lors des changements
de compte ou de la révocation, comme les autres contenus v2.

Le desktop limite les captures de gestion à 8 MiB, un catalogue à 4 MiB, une
capture de transcript à 4 MiB dans cette capacité et les résultats de recherche
à 2 000. Une recherche complète a un budget de dix secondes. Dépasser une limite
renvoie une erreur explicite, pas un résultat silencieusement tronqué. Avant
de charger une fenêtre, SQLite vérifie dans la même transaction une estimation
conservatrice du poids de tous les champs natifs. Un transcript trop lourd est
refusé avant création des objets et transfert IPC. Le lecteur v2 historique
conserve son chemin existant. Les reçus
ont un plafond de 10 000 et ne sont pas évincés pour permettre une création double.
Le parcours de transcript v2 ancien garde ses limites propres.
