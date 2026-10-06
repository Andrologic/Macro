# Contrats du moteur AgSDL

Ce document fixe les interfaces du moteur à construire. Le lot présent ajoute
les types et des invariants purs, sans scheduler, migration SQL, commande IPC,
adaptateur fournisseur ou parcours d'exécution dans l'interface.
Les déclarations sont dans
[`contracts.ts`](../src/services/agsdlExecution/contracts.ts), les vérifications
locales dans [`invariants.ts`](../src/services/agsdlExecution/invariants.ts).

Le contrat normatif reste AgSDL 0.2.0. Les règles de contenu, de flux et de
validation publiées sont référencées par le
[NOTICE du lecteur](../src/vendor/agsdl/NOTICE.md). La validation du document,
les contrôles de records et l'exécution sont trois responsabilités distinctes.
Le profil Macro ci-dessous est volontairement plus restreint que le langage.

## Propriétaire et hébergement retenus

Un propriétaire natif unique tient les admissions, transactions et epochs.
L'adaptateur JavaScript Macro résidera dans une webview native cachée dédiée,
avec une entrée distincte de `main.tsx` et de `App`. Il réutilisera
`src/services/streamingChat.ts`, `src/services/ai/toolCallingLoop.ts` et les
adaptateurs fournisseurs existants. Ce choix conserve les contrôles Macro et
permet au travail de survivre au rechargement de la fenêtre produit pendant que
Macro tourne. Le lot d'hébergement physique reste à réaliser.

La fenêtre produit et le navigateur de débogage consomment uniquement
`ExecutionPublicPort`. Ils ne possèdent jamais le scheduler. Les commandes
`ExecutionRuntimePort` authentifient la webview appelante côté natif et vérifient
l'epoch courant dans chaque transaction. Un champ `ownerEpoch` fourni par le
JavaScript ne constitue pas une autorisation. L'acquisition et la rotation de
l'epoch appartiennent au superviseur natif, jamais à une commande publique.
Une panne du host rend les effets engagés incertains. Une nouvelle epoch bloque
les commits tardifs mais ne prouve pas que les anciens effets sont terminés.

## Identités et snapshot

| Identité | Durée et unicité |
| --- | --- |
| `systemStartId` | Un démarrage et son snapshot immuable. Seul le prochain démarrage crée une nouvelle identité ; arrêt et édition seuls ne le font pas. |
| `flowInvocationId` | Une invocation de flux. Les compteurs `maxVisits` sont propres à cette invocation et à chaque adresse de step. |
| `agentInstanceId` | Une instance par couple système démarré et nom d'Agent. Plusieurs steps utilisent la même mémoire et configuration. |
| `activationId` | Une occurrence de travail distincte. Deux entrées identiques peuvent créer deux occurrences différentes. |
| `deliveryId` | Une livraison logique. Sa retransmission récupère le reçu sans nouvelle visite. |
| `providerAttemptId` | Une tentative fournisseur dans une activation. Une nouvelle tentative ne permet pas de rejouer un effet inconnu. |
| `toolInvocationId` | Une invocation réelle de Tool ou Call, avec son admission et sa preuve de terminaison. |
| `ownerEpoch` | Jeton de fencing attribué par le natif, renouvelé à la reprise du propriétaire. |

Les adresses de steps sont des tableaux, jamais des noms concaténés avec un
séparateur ambigu. Les identités de tâche, workspace et conversation sont des
associations facultatives. Elles ne remplacent aucune identité d'exécution.
L'Agent existe indépendamment d'une tâche Implement. Un chemin sans `next`
s'arrête sans terminer la durée de vie de l'Agent.

`SystemSnapshot` retient le propriétaire projet/plan/branche, la révision, le
SHA-256 des octets UTF-8 exacts et le texte source authored, avec les versions du
snapshot, contrat, compilateur, runtime, registre et profil. Le natif lit la
source canonique du plan et vérifie propriétaire, révision et SHA avant de
capturer. Il refuse une révision obsolète. Le frontend ne fournit pas le document
qui ferait autorité. Le SHA porte sur les octets conservés, sans reformatage.

Les configurations, settings effectifs, bindings, contenu initial, permissions
et scopes sont capturés sans secrets. Les identifiants fournisseur et modèle
sont explicites. Aucun fournisseur ni modèle par défaut n'est choisi.
Les credentials restent dans les services sécurisés Macro et sont résolus au
moment de l'invocation. L'autorité de capture native exporte explicitement les
champs publics des configurations et settings typés du catalogue ; elle ne
sérialise pas `ProviderConfig` en bloc et ne charge pas les credentials dans
le snapshot. Cette frontière doit être implémentée avant de rendre le démarrage
disponible. Le repository valide les valeurs JSON exactes sans en déduire la
confidentialité à partir des noms de propriétés. Un `password` dans un schéma
Tool ou un `authorization` dans une ressource publique reste une donnée
légitime ; source, paramètres et bindings sont conservés sans suppression ni
reformatage. Un credential issu des services sécurisés Macro doit rester
hors de la capture et des diagnostics, indépendamment de son nom de champ.

`ExactJsonText` est une chaîne JSON exacte validée par le lecteur vendor.
Les DTO transportent les valeurs durables sous cette forme, y compris arguments,
résultats, mémoire et settings. `JSON.parse`, `structuredClone` d'un arbre de
valeurs et une conversion en `number` ne sont pas des chemins de capture
acceptables. `readDocument` est un helper d'édition, pas le lecteur du moteur.
Les séquences et epochs sont des chaînes décimales canoniques, sans perte de
précision. La révision numérique des métadonnées existantes est convertie en
texte décimal canonique par l’adaptateur natif, sans changement de sa valeur. Les marques TypeScript ne remplacent pas la validation native.
`ExactValuePort` laisse les comparaisons sémantiques au lecteur exact et au lot
de conformité. Les invariants ne dupliquent pas ce lecteur.

La configuration d'une instance reste identique, même après un échec. Les
permissions capturées sont un plafond, pas un droit irrévocable. À chaque effet,
Macro vérifie aussi les permissions actuelles. Une révocation bloque l'effet ;
un ajout de droits après démarrage n'élargit pas le snapshot. Le périmètre réel
et les approbations de Tool restent évalués par Macro.

## Profil initial et assessment

Le premier profil `macro-serial-inline-v1` prévoit les steps `agent`, `prepare`,
`call` et `condition`, des configurations fixes, des contenus inline texte/JSON
et au plus un successeur sur chaque chemin normal ou d'erreur. Le flux peut
boucler avec les compteurs de visites. Les Messages externes sans graphe suivent
la même file par Agent. Le profil ne rend pas exécutables les autres formes
simplement parce que le lecteur statique les accepte.

Avant tout effet, rejeter les gates AgSDL `approval`, joins, fan-out, steering,
URI, médias, compositions, configurations dynamiques et bindings dont le support
exact n'est pas prouvé. Rejeter également les sélections de modèle, exigences,
interfaces ou publications que le registre de ce profil ne sait pas honorer.
Les capacités des points 16 à 22 du chantier restent hors de ce lot et de ce
profil. Une extension devra avoir son propre assessment et ses preuves.

`StaticAssessment.valid` décrit uniquement le document. `RuntimeAssessment`
porte sur le snapshot, le profil et la version du registre. Une assertion
frontend `supported: true` ne permet aucun effet. Le service natif d'ouverture
peut déléguer la compilation et les contrôles exacts à un service de confiance
dans le host résident avant l'ouverture durable. Ce host travaille sur la source
canonique fraîche vérifiée par le natif, avec une réponse liée à sa révision,
son SHA et ses versions. Cela n'impose pas de réimplémenter le lecteur exact en
Rust. Le frontend produit reste consultatif. Le natif vérifie cet assessment
avec le registre de confiance, refuse
les diagnostics bloquants et tout `unassessed` nécessaire à l'exécution, puis
persiste le snapshot. La vérification du support ne garantit pas la disponibilité
future d'un fournisseur ou la conservation des permissions.

Les approbations Macro des Tools internes et des Calls sont conservées. Elles
ne sont pas les gates du langage AgSDL, exclues du profil initial. Un `scope`
décrit une action ; il n'accorde pas à lui seul un droit d'exécution.

## Ports et stockage à réaliser

| Port | Responsabilité et auteur attendu |
| --- | --- |
| `SnapshotCapturePort` | Compilation/capture et assessment, appelé exclusivement derrière le démarrage natif. |
| `ExecutionRepositoryPort` | Stockage natif transactionnel, admission FIFO, compteurs et persistance atomique. |
| `ExecutionPublicPort` | Façade produit start/deliver/stop/lecture/projection ; aucun commit ni admission privée. |
| `ExecutionRuntimePort` | Admission, commit, confirmation d'arrêt et incertitude du host authentifié. |
| `MacroAgentExecutionPort` | Adaptateur résident du moteur Macro, mémoire persistante et collection des réponses. |
| `MacroInvocationPort` | Calls et Tools avec binding exact, arguments, permissions et scope réels. |
| `ResponseCollectionPort` | Attribution, ordre, déduplication, publications typées et fermeture des réponses. |
| `ProjectionPort` | Projection déterministe des événements, sans déclencher de travail. |
| `ExactValuePort` | Comparaison exacte déléguée aux règles vendor lors de la conformité. |

Le stockage natif devra conserver snapshots, invocations de flux, instances
Agents, livraisons et ordre FIFO, activations et compteurs, tentatives fournisseur,
invocations d'outils, checkpoints mémoire, réponses et publications, arrêt,
événements et curseurs. Ces données appartiennent au workflow de métadonnées
Macro ; aucun fichier sidecar ad hoc n'est créé. Les contraintes uniques doivent
protéger notamment système/Agent, delivery, activation, terminal et séquence de
file. Le présent document ne choisit pas de schéma SQL.

`start` est idempotent par `requestId` et requête identique. Un conflit est
`CORRELATION`. Un flux avec entrée exige un Message fourni explicitement ;
`entry: null` permet le démarrage sans flux et ne transforme pas le prompt
initial d'un Agent en travail implicite. Le repository attribue les identités
initiales et persiste l'entrée dans la même ouverture.

La façade `deliver` accepte seulement un Agent et un Message externes. Elle
attribue l'activation et l'invocation graphless, impose l'origine `entry`, puis
appelle le repository. Le profil initial refuse ce canal pour injecter du travail
dans un graphe en cours. Une retransmission retrouve exactement les identités
déjà attribuées. Les livraisons internes sont produites uniquement par le runtime
et validées contre les routes du snapshot.

`acceptDelivery` attribue et persiste un ordre total par instance Agent avant
confirmation, y compris pour un batch arrivé sans ordre. Une retransmission
identique rend le même reçu. Un même identifiant avec une autre occurrence,
origine ou valeur échoue avec `CORRELATION`. Les occurrences distinctes gardent
des identifiants distincts même si leurs valeurs sont égales. L'ordre entre
Agents indépendants n'est pas imposé.

`beginActivation` vérifie atomiquement l'epoch, la file la plus ancienne,
l'absence de travail actif ou incertain, l'arrêt et les visites. `maxVisits`
se consomme au démarrage, jamais à la mise en file ni sur retransmission.
Un rejet `VISIT_LIMIT` résout cette occurrence via sa frontière terminale sans
lancer de fournisseur. Le natif réserve cette résolution pour empêcher un autre
propriétaire de la traiter. Le résultat `rejected` n'autorise jamais un effet.
Un refus d'autorité `CORRELATION` laisse le travail légitime intact.

`commitTerminalAndDeliveries` persiste dans une même transaction le résultat,
le checkpoint mémoire, les livraisons sortantes, le curseur des réponses et les
événements associés. Aucun successeur ne démarre avant ce commit. Le repository
vérifie que les routes correspondent à l'unique issue retenue et à la source
capturée, que la mémoire appartient à l'instance et que le curseur est fermé.
Le champ `outgoing` ne donne pas au host le droit d'inventer des destinations.

Un doublon terminal égal est idempotent. Le repository compare aussi mémoire,
curseur et livraisons à la transaction retenue ; le helper de résultat seul ne
valide pas une transaction entière. Une contradiction produit `CORRELATION`
et ne déclenche aucune seconde route. Une route normale et une route d'erreur
ne peuvent jamais être dispatchées pour la même occurrence.

`registerEffect` persiste la corrélation avant chaque tentative fournisseur ou
invocation Tool/Call. `settleEffect` conserve une preuve de fin ou une incertitude.
Le commit terminal exige que tous les effets enregistrés soient terminés. Une
retransmission de cet enregistrement ne relance jamais un effet.

Les méthodes rejettent les requêtes invalides avec des erreurs structurées
au format `ExecutionFailure`, conservant le code et le pointeur. Les échecs de travail sont des résultats
terminaux corrélés. Une panne de transport ou un rejet de Promise d'adaptateur
ne prouve pas la terminaison : le superviseur marque alors l'occurrence incertaine.
Les lecteurs d'événements utilisent un curseur exclusif, un ordre croissant et
une limite bornée côté natif. Une page vide conserve le dernier curseur.

## Frontières de données et réponses

Condition conserve la valeur et son origine. Agent vers Agent livre le texte
visible dans une ressource `result` de type `text/plain`, sans prompt implicite.
Call livre son `data` dans une ressource `result` JSON, même si cette valeur
ressemble à un Message. Seul Prepare applique la transformation de rôles
explicitement authored ; ses sélecteurs ne consultent que l'entrée courante.
Les erreurs restent des informations, jamais une instruction implicite de retry.

La collection utilise une identité stable par Message et l'ordre d'émission
persisté, pas l'ordre d'arrivée réseau. Elle attribue chaque partie à l'activation
et à la tentative fournisseur. Les doublons identiques sont ignorés ; un conflit,
un trou d'ordre à la fermeture ou une attribution ambiguë donnent `CORRELATION`.
Une collection fermée ne peut pas être rouverte par un événement tardif.

Pour chaque Message visible, concaténer les parties texte sans séparateur.
Retirer uniquement les Messages dont le texte est exactement vide, puis joindre
les autres avec un LF. Ne pas trim, normaliser les fins de ligne, incorporer le
raisonnement, les échanges bruts de Tools ou l'historique. Sans texte, le résultat
est la chaîne vide. Une explication visible d'un résultat de Tool compte comme
texte ; le résultat brut du Tool ne compte pas.

`TypedPublication` transporte les résultats nommés et le choix selon un contrat
explicitement déclaré dans le registre. Le texte libre ne suffit pas à publier
un résultat ou choisir une route. La collection valide leur déclaration,
format, contraintes et attribution avant fermeture. Le lot de conformité
réutilisera les règles exactes vendor, sans parser une chaîne texte en JSON.

## Arrêt, reprise et limites

`WorkState` et `StopState` sont indépendants. Un arrêt demandé ou incertain
conserve le verrou d'un travail actif ou incertain. `AbortError`, un signal
AbortController et un accusé de réception de cancel ne confirment pas que les
effets sont terminés. `confirmStop` exige une preuve corrélée de terminaison et
committe le checkpoint et le curseur sans successeur. Un travail peut aussi se
terminer normalement pendant une demande d'arrêt ; le natif retient une seule
issue terminale selon l'ordre transactionnel.

L'arrêt système ferme les admissions, résout les entrées encore en attente sans
les exécuter et attend la terminaison de tous les travaux admis. La confirmation
système n'est publiée qu'après cette attente. L'arrêt d'une seule activation
ne prouve pas que les autres sont terminées. Un arrêt non supporté reste en
attente avec sa raison ; il ne fabrique pas une terminaison.

Les lectures natives `readAgent`, `readInvocation` et `readEffects` fournissent
les checkpoints, compteurs et effets non résolus sans introduire un second
service de stockage.

La reprise recharge exactement le snapshot et ses versions, configurations et
checkpoints. Une version indisponible bloque la reprise, sans recompilation
silencieuse. Une activité externe dont les effets sont inconnus n'est jamais
rejouée automatiquement. Une nouvelle epoch conserve ses verrous jusqu'à une
preuve explicite de terminaison ou une résolution opérateur documentée.
L'atomicité locale ne promet pas un effet externe exactement une fois.

Les tests de ce lot vérifient les invariants purs, pas ces garanties natives.
La persistance, les permissions effectives, l'hébergement, la compilation,
l'exécution, les crashs et la reprise doivent être prouvés dans leurs lots avant
que l'interface annonce le moteur disponible.

## Repository natif durable

Les migrations 10 et 11 ajoutent les résultats du journal conversation et le
repository AgSDL. `tool_invocations` conserve ses clés et sa relation à une
conversation existante. Un système AgSDL peut fonctionner sans conversation,
donc `engine_effects` porte les clés système, activation et effet fournisseur ou
outil. Les deux journaux enregistrent l'intention avant dispatch, ne réautorisent
jamais une intention existante et conservent le résultat exact avec sa preuve
dans la même transaction. Les anciens reçus sans résultat restent sans résultat.

Pour le profil sériel initial, `engine_systems` conserve un snapshot immuable et
un état transactionnel par système. Cet état contient instances, checkpoints,
activations, compteurs, arrêt et fermetures de réponses. Les livraisons ont des
clés SQL uniques pour livraison et activation. Les événements et effets ont
leurs propres tables. `BEGIN IMMEDIATE` sérialise les modifications, avec
`synchronous=FULL` avant confirmation. Les chaînes JSON exactes restent des
chaînes, y compris les valeurs numériques hors de la précision JavaScript.

Le repository n'est pas un scheduler. Sa capture et ses routes exigent des
autorités Rust internes. La capture native lit `agsdl.source` dans `plan.json`
après résolution du projet par les métadonnées existantes et vérifie révision
et SHA. L'autorité de capture doit garder le verrou des métadonnées pendant
la vérification finale et le commit. Le futur superviseur doit authentifier
sa webview avant d'exposer les méthodes privées. Aucune de ces méthodes, ni
la rotation d'epoch, n'est une commande produit dans ce lot.

Les commandes produit exposent lecture, pagination et arrêt. `execution_start`
refuse `RUNTIME_UNAVAILABLE` jusqu'au raccordement du host de confiance.
La reprise compare toutes les versions capturées aux versions disponibles.
Elle rend les activités engagées incertaines, conserve leurs verrous et fence
les anciens propriétaires. Une résolution opérateur native avec preuve reste
nécessaire pour libérer un effet dont la terminaison est inconnue.

### Résolution native après une perte du propriétaire

Une reprise renouvelle l’epoch et conserve l’incarnation admise dans les
activations et les intentions d’effets. Les lectures d’effets exposent leur
statut durable `pending`, `uncertain` ou `ended`. Un ancien host ne peut plus
committer, même s’il reçoit tardivement une réponse valide.

`resolve_recovered` est une frontière Rust privée. Le nouveau propriétaire
présente les versions exactes et une preuve portant sur le travail, l’epoch
initiale, chaque effet enregistré, sa terminaison et la fermeture des réponses.
Une `RecoveryAuthority` native vérifie cette preuve. La transaction vérifie
l’attribution originale, termine les effets prouvés, conserve leurs résultats,
committe le checkpoint et le terminal puis admet l’unique route validée. Un
échec de cette transaction laisse tous les verrous et résultats antérieurs
intacts. Une répétition équivalente conserve le premier texte et ne route rien
une seconde fois. Aucun effet incertain n’est réenregistré ni redispatché.
La confirmation d’un arrêt exige cette même preuve de terminaison.

Un refus `VISIT_LIMIT` réserve une résolution sans effet au propriétaire.
Le commit terminal commun vérifie le refus, garde la mémoire inchangée et
résout la route d’erreur éventuelle une seule fois. La réservation ne consomme
pas de visite supplémentaire et interdit tout fournisseur ou outil.

Les reçus comparent les JSON par structure et valeur numérique exacte,
sans flottants. L’ordre des clés et la notation numérique ne changent pas la
valeur ; les booléens restent distincts des nombres. Le texte du premier reçu
reste intact. Les objets aux clés dupliquées sont rejetés. Le lecteur des
valeurs externes impose une profondeur maximale de 128 niveaux avant toute
descente récursive supplémentaire ; cette borne ne change pas l’égalité.

La capture finale retourne un `LockedExecutionSource` qui garde les verrous
natifs de contenu des `plan.json`, également pris par le vrai writer
`fs_write_file`. Le writer de l’éditeur AgSDL ne prend pas le verrou de cycle
de vie. La capture conserve aussi les verrous de cycle de vie et du registre
projet pour leurs opérations respectives. Elle résout les racines avant les
verrous, puis prend les verrous de cycle de vie, les clés de contenu canoniques
triées, le registre workspace et enfin SQLite. Les mutations natives par batch
trient les mêmes clés de contenu ; le writer direct ne prend que son verrou de
contenu. La capture ne résout plus de racine et ne reprend plus de verrou de
cycle de vie pendant cette période. `CaptureAuthority::CommitGuard` reste
vivant entre la revérification et le commit SQL. Le host, le compilateur et
l’autorité de preuve restent à raccorder ; aucun IPC produit ne peut fournir
ces autorités et `execution_start` reste indisponible.
