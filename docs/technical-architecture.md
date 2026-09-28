# Macro - Architecture Technique

## 1. Objet du document

Ce document décrit l'architecture technique de référence de Macro.

Il couvre :
- les couches principales de l'application
- les responsabilités de chaque couche
- les flux de données entre frontend, runtime desktop et backend distant
- la persistance locale et metadata
- les mécanismes techniques reliés aux workflows du produit

Ce document n'est pas une roadmap et n'est pas une spécification fonctionnelle.

La cible fonctionnelle du produit est définie dans `docs/functional-spec.md`.
Les évolutions à venir et les écarts avec l'état courant relèvent de `docs/roadmap.md`.

---

## 2. Vue d'ensemble

Macro est une application desktop construite autour d'un frontend React TypeScript et d'un backend Rust embarqué via Tauri.

L'architecture repose sur quatre principes :

- local-first par défaut
- séparation stricte entre surface produit et détails d'implémentation
- transport interchangeable entre backend desktop et backend distant
- préservation d'un historique de travail auditable via la persistance locale et la branche metadata

Le produit actuel fonctionne en desktop local avec backend Tauri embarqué.
Les topologies client desktop ou web/mobile connecté à un kernel distant restent
des objectifs futurs. Le prototype headless et le transport remote décrits plus
bas ne constituent pas des capacités produit supportées.

Les fondations de modularité sont déjà intégrées : contrats de domaine et
adaptateurs de composition, services de workflow, registres de contributions
internes et contrats IPC générés. Les sections 5 à 7 décrivent leurs raccords
et leurs limites. Les adaptateurs délèguent encore aux propriétaires existants ;
l'extraction ne supprime pas tous les couplages historiques entre stores.
Les registres accueillent du code interne de confiance livré avec l'application.
Ils ne fournissent ni API publique de plugins ni runtime d'extensions
téléchargeables. Le contrat de [contributions du shell](workspace-shell.md)
précise cette frontière.

---

## 3. Couches principales

### 3.1 Couche interface

La couche interface est composée du frontend React dans `src/`.

Elle est responsable de :
- l'affichage des modes et des panneaux
- la gestion des interactions utilisateur
- la visualisation des plans, tâches, diffs et états
- la configuration des providers, outils et préférences

Le frontend ne doit pas contenir la logique bas niveau du système de fichiers, de Git ou de la persistance native.

### 3.2 Couche état client

La couche état client est principalement basée sur Zustand.

Elle est responsable de :
- l'état global de l'application
- les contextes de projet, plan et conversation
- l'état des tâches, changements de fichiers et outils
- la synchronisation des préférences locales côté client

Les stores centralisent les décisions d'orchestration côté interface.

### 3.3 Couche services frontend

La couche services frontend encapsule les accès aux sources de données et aux outils.

Elle fournit :
- une abstraction de provider (`ipc`, `remote` expérimental)
- des services spécialisés pour les plans, le workflow Git, la sync metadata, le streaming chat, le contexte projet et l'exécution d'outils

Elle a pour rôle d'isoler le reste de l'interface des détails du transport.

### 3.4 Couche runtime desktop

Le runtime desktop est fourni par Tauri.

Il sert de pont entre :
- le frontend web embarqué
- les commandes natives Rust
- les plugins natifs Tauri

Cette couche permet l'accès natif à :
- la fenêtre desktop
- les dialogues système
- le store natif
- le réseau natif
- les commandes IPC exposées par le backend Rust

### 3.5 Couche backend Rust

Le backend Rust est contenu dans `src-tauri/`.

Il fournit les capacités natives suivantes :
- base de données SQLite
- accès système de fichiers
- intégration Git
- gestion du workspace
- validation de politique d'outils
- exécution d'outils de workspace
- providers IA côté backend
- fondation expérimentale du kernel headless HTTP

### 3.6 Registre de configuration

Le module Rust `config` est l’unique autorité pour les réglages durables. Il
regroupe les contrats Serde, les valeurs par défaut, les JSON Schema, le
catalogue de paramètres, les migrations, la fusion, la provenance, les ETags,
les écritures atomiques, le watcher et le classement de sécurité.

Le frontend consomme un snapshot typé via `useConfigStore`. Les stores métier
ne doivent pas conserver une copie persistante concurrente d’un réglage. Le
transport utilise les mêmes contrats via IPC Tauri ou via l’API headless.

Les documents globaux vivent dans le dossier de configuration de
l’application. Les surcharges projet autorisées vivent sous
`@macro/projects/<project-id>/config`. L’état temporaire vit dans `state.json`,
les caches et données métier dans SQLite, et les secrets dans le fichier privé
`provider-secrets.json`.

Une zone privée `.runtime` conserve les baselines approuvées et les propositions
sensibles en attente. Le snapshot effectif est toujours construit depuis la
baseline approuvée, y compris après un redémarrage. Les verrous locaux sont
complétés par un verrou de fichier interprocessus ; l’ETag est relu sous ce
verrou avant toute écriture. Le watcher desktop coalesce les événements puis
rescane les documents chargés et les nouveaux documents projet.

Le watcher réconcilie les dossiers de configuration par racine canonique. Les
projets partageant une racine partagent son abonnement ; chaque racine unique
possède un backend natif indépendant, séparé du backend global. Ce choix permet
de libérer aussi une installation récursive partiellement échouée, au prix de
handles et de threads dont le nombre croît avec les racines uniques. Les quotas
du système restent applicables et la fermeture native peut être asynchrone.
La maintenance vérifie les identités des dossiers et réessaie les abonnements
avec une temporisation progressive plafonnée à trente secondes. Ce délai est
commun aux racines : une panne persistante peut donc retarder aussi le
rechargement d'une racine saine. Le manager refuse de servir un document dont
la racine a été remplacée avant le rafraîchissement de son cache.
Une dégradation de maintenance apparaît dans un diagnostic dédié, consultable
dans le snapshot. Son apparition et son rétablissement émettent
`config://changed`, sans répéter un état inchangé ni effacer les avertissements
issus des commandes workspace. Un rechargement échoué reste à réessayer après
la temporisation, même sans nouvel événement. Le diagnostic de panne est retiré
seulement après une nouvelle vérification réussie.
Une racine résolue reste surveillée si le chargement d'un document échoue ; la
maintenance réessaie ce chargement après correction du fichier. Le manager
conserve séparément la racine demandée et la configuration activée, pour que
les abonnements et les retries suivent le registre même pendant une transition
bloquée. Le retrait explicite désactive ce désiré sans effacer une intention
durable encore nécessaire lors d’un futur enregistrement. La demande est
mémorisée avant toute création, résolution ou lecture d’identité du dossier.
Une erreur à cette frontière utilise la même intention avec une cible
indisponible et bloque l’ancienne configuration. Le chemin demandé permet une
reprise lorsque le dossier redevient valide. Le besoin de résoudre cette
racine appartient à la demande elle-même ; une erreur de révocation peut changer
le diagnostic sans effacer ce travail restant.
Le chemin du dépôt fourni par le registre reste distinct de sa racine metadata.
Son indisponibilité empêche de réactiver une racine metadata encore accessible.
Si la destination metadata elle-même est inconnue, l’ancienne racine n’est plus
servie ni surveillée à sa place. Le diagnostic demande une nouvelle
réconciliation du registre pour résoudre cette destination. Une racine déjà
connue reprend automatiquement lorsque le même dépôt revient. Une purge ou une récupération du cache
émet aussi `config://changed` pour actualiser le
snapshot frontend. Une absence observée par le bootstrap invalide aussi le
consentement sans attendre la maintenance. Le watcher conserve les événements
de suppression ou de déplacement de la racine jusqu’à leur transmission au
manager, même si le dossier revient avant cette transmission. Une erreur native
ou une demande de rescan seule ne constitue pas une preuve de disparition.
Les opérations projet acquièrent
leurs verrous de document, de transaction et de publication avant le contrôle
final du chemin canonique et de l’identité ; les écritures suivantes ne
reprennent pas ces verrous. Un déplacement masqué par un lien symbolique reste
donc une transition, même si l’inode du dossier n’a pas changé.
Les propositions projet persistées lient leur identifiant d'approbation au
chemin canonique et à l'identité du dossier. Un changement de racine renouvelle
cet identifiant, même si la nouvelle racine ne contient pas le document. Ce
renouvellement persiste après redémarrage, en conservant le contenu proposé et
la baseline approuvée. Les anciennes propositions sans ce lien demandent
également une nouvelle approbation.
Une intention durable unique par projet, dans le stockage privé `.runtime`,
impose la reprise d’une transition incomplète avant toute réutilisation de sa
racine, y compris au retour au dossier initial ou après redémarrage. Elle est
persistée avant le renouvellement des propositions. Chaque proposition reçoit
atomiquement un nouvel identifiant et l’acquittement de cette intention. La
reprise parcourt tous les types de documents projet, même si leur JSON est
absent, et conserve les contenus proposés et les baselines. Une erreur sur une
proposition ne dispense pas de traiter les suivantes. L’intention n’est retirée
qu’après tous les acquittements durables ; une erreur conserve la configuration
concernée indisponible et déclenche une nouvelle tentative.
Ce protocole remplace les journaux intermédiaires de renouvellement par
proposition. Les journaux de publication des documents restent indépendants.
Le stockage ne conserve qu’une intention courante et un acquittement par
proposition, sans historique croissant ni fichier annexe dans le projet.
Si l’intention ne peut pas être persistée, Macro retourne une erreur et bloque
la configuration concernée dans le processus. La reprise après crash suppose
une intention persistée ; l’échec de cette première écriture peut perdre
l’observation au redémarrage, même si d’autres fichiers restent inscriptibles.

Si la réconciliation échoue après une mutation du registre déjà persistée, la
commande conserve son résultat métier. Un avertissement `ConfigDiagnostic`,
publié via `config://changed` et consultable dans le snapshot, distingue cet
échec de configuration de l'opération déjà terminée. Le client doit réessayer
le rechargement de configuration, pas la création, l'import ou le retrait.
Une lecture principale du registre échouée peut transmettre une erreur. En
revanche, un bootstrap ou un listage déjà lu reste fourni si seule la
réconciliation accessoire échoue ; cette dégradation utilise le même diagnostic
et le même événement, pour ne pas ouvrir un shell vide à la place des projets.

Une acceptation sensible est engagée dès que la baseline approuvée est écrite.
Si le nettoyage de la proposition échoue ensuite, le résultat reste appliqué,
avec un diagnostic de nettoyage différé. Le chargement suivant reprend ce
nettoyage sans présenter une nouvelle demande de consentement.

Chaque tour agent charge un snapshot correspondant à ses identifiants de projet
et à son projet de focus. Le modèle, le niveau de risque, les outils autorisés
et les limites issus de ce snapshot sont figés pour toute la durée du tour,
y compris lors d’un retry après overflow.

Les détails normatifs sont décrits dans `docs/configuration.md`.

---

## 4. Stack technique

### 4.1 Frontend

Le frontend utilise principalement :

- React 19
- TypeScript
- Vite
- Zustand
- Lexical pour l'éditeur de composition
- CodeMirror pour l'affichage et l'édition de code
- Mermaid et React Markdown pour le rendu enrichi
- Tailwind CSS pour la couche UI

### 4.2 Backend desktop

Le backend desktop utilise principalement :

- Rust
- Tauri v2
- Tokio
- SQLx avec SQLite
- git2
- notify
- axum pour le kernel headless expérimental et le tool host interne
- reqwest pour les providers IA distants

### 4.3 Transports

Le produit 0.1 supporte un transport côté application :

- `desktop`

Le transport `desktop` passe par Tauri IPC.
Une fondation HTTP distante existe dans le code à titre expérimental, mais elle n'est ni exposée ni supportée comme capacité produit en 0.1. La valeur interne `VITE_BACKEND_TRANSPORT=remote` sélectionne un adaptateur de développement incomplet ; ce n'est ni un sélecteur produit ni une garantie de fonctionnement de l'interface sans Tauri IPC. Cette fondation pourra servir à une future ligne remote sans modifier le contrat desktop actuel.

---

## 5. Architecture frontend

### 5.1 Organisation

Le frontend est organisé autour de :

- `components/` pour les surfaces UI
- `stores/` pour l'état global
- `services/` pour la logique d'accès et d'orchestration
- `hooks/` pour les comportements transverses
- `types/` pour les types applicatifs

### 5.2 Routage fonctionnel par mode

L'application n'utilise pas un routage classique basé sur des pages.

Les définitions d'espaces, sessions et contributions du shell sont décrites dans
[Workspace and shell contributions](workspace-shell.md). Consulter ce contrat
avant d'ajouter une vue interne, un raccourci ou une entrée de réglages.

Le cœur de l'interface repose sur une configuration centralisée qui affecte facultativement les emplacements gauche, centre et droit selon le mode actif. Le routeur, le shell, le Header et le préchargement consultent tous cette même configuration.

Lorsqu'un emplacement est absent, aucun conteneur, largeur, séparateur, bouton d'ouverture ou préchargement ne lui est associé. Le mode Architect utilise les trois emplacements : navigation projets/plans à gauche, conversation au centre et stratégie à droite.

Le navigateur Architect charge un catalogue transverse des plans, mais délègue toute activation à `useAppStore.activateArchitectPlan`. La sélection canonique reste `selectedGroupId`/`selectedProjectId` pour le contexte et `activeArchitectPlanId`/`activePlanContext` pour le plan. Les épingles et les groupes visuellement développés sont de simples préférences d'interface ; ils ne créent pas un nouvel état métier. Le basculement entre plans actifs et archivés reste également un état de vue local : il filtre le catalogue déjà chargé et ne modifie ni la portée projet ni le plan actif. Les menus contextuels réutilisent les mêmes mutations et les mêmes restrictions de types de plans que les actions primaires ; ils ne contournent ni `getCreatableArchitectPlanKinds` ni les capacités CRUD du plan.

Le shell persiste une largeur dédiée au panneau gauche Architect. Elle est bornée séparément de la largeur générique des panneaux gauche afin qu'une préférence héritée d'un autre mode ne dégrade pas la lisibilité de l'arborescence projets/plans.

Le panneau de conversations Chat conserve son mode de sélection multiple dans un état local au composant. Hors de ce mode, seul un déclencheur compact et accessible est rendu dans l'en-tête à côté de la création de conversation. L'activation rend la barre d'actions groupées et initialise la sélection à vide ; l'annulation ou un changement de vue réinitialise simultanément le mode, la sélection et les modales associées.

### 5.3 Découpage des panneaux

L'interface est structurée autour de :

- un header
- un footer
- un panneau gauche contextuel optionnel
- une zone centrale partagée
- un panneau droit contextuel optionnel

Le centre reste principalement occupé par la conversation et la coordination du travail.

La résolution du dépôt Git du footer est centralisée dans un service pur et typé. Ses entrées sont les identités durables du mode courant — tâche Implement, plan Architect et conversation Chat — ainsi que le registre de projets. Le composant ne reconstruit pas cette logique à partir de sélections globales. Le service retourne soit un dépôt unique, soit une portée ambiguë ou vide ; dans ces deux derniers cas, les actions Git restent sans cible et donc désactivées. La priorité est tâche puis projet sélectionné en Implement, et plan puis projet sélectionné en Architect. Le fallback projet n'est autorisé que si aucun identifiant de tâche ou de plan n'est actif, afin qu'un contexte en cours de chargement ou devenu invalide ne soit pas silencieusement remplacé. Pour un plan multi-projets, le seul focus implicite autorisé est le focus durable courant s'il appartient encore à la portée du plan. Une sélection manuelle reste locale au footer, limitée aux candidats retournés et invalidée par la clé d'identité du contexte. Le seul contexte hors registre accepté est un dossier Git choisi explicitement en mode Architect lorsque le registre est vide. Il est typé comme source `folder`, validé par une lecture de statut Git avant activation et exclu du service de synchronisation `@macro`.

Les commandes réseau du footer n'envoient pas de branche explicite aux wrappers Git : elles utilisent l'upstream de la branche courante, qui est la même branche que celle décrite par le statut, les compteurs et les contrôles de divergence. Une éventuelle sélection d'une autre branche doit passer par un changement de contexte ou de worktree complet, puis recalculer le statut, plutôt que détourner les paramètres optionnels de `git_pull` ou `git_push`. Le service de synchronisation des métadonnées s'appuie sur le résultat structuré du préflight `@macro` : pendant un pull, les cibles en état `missing_upstream` sont conservées dans le résultat agrégé mais ne déclenchent aucune commande réseau. Les autres cibles sont traitées normalement et les erreurs d'authentification, de réseau ou de conflit restent bloquantes. Les animations des icônes sont purement visuelles, appliquées à un élément interne borné par un cadre fixe et accompagnées d'une variante `prefers-reduced-motion`.

### 5.4 Initialisation

Le frontend initialise ses stores par priorités afin de réduire le coût de démarrage perçu.

L'initialisation se fait en plusieurs niveaux :

- bootstrap critique de l'application
- session utilisateur et contexte
- données cœur comme chat et tâches
- configuration et providers en basse priorité

### 5.5 Composition et frontières TypeScript

`main.tsx` est la racine de composition. Il installe les préférences de
notification, l'ouverture des contextes de travail et l'adaptateur de changement de langue avant l'initialisation de
la configuration. `startNotificationComposition` retourne un arrêt idempotent,
appelé par HMR. Un redémarrage reconnecte les notifications de langue en attente.
Le renderer est attaché par l'effet de montage de `Toaster` et détaché au démontage.

`src/domains/contracts.ts` définit les capacités publiques déjà utilisées :

| Domaine | Requêtes | Commandes exposées |
| --- | --- | --- |
| Chat | Conversations et messages par conversation | Sélection, arrêt du streaming |
| Plans | Nœuds du plan actif | Activation d'un plan |
| Tasks | Tâche par identifiant | Activation, passage en review |
| Projects | Projets autonomes et groupes | Changement de contexte projet |
| Tools | Identifiants d'outils Chat et MCP activés | Chargement des réglages, appel MCP |
| Providers | Providers et modèles par provider | Chargement, sélection du provider et du modèle |

Les adaptateurs de `src/composition/domainAdapters.ts` délèguent aux propriétaires
actuels à chaque appel. Ils ne copient pas l'état durable. Les effets de
configuration reçoivent les commandes Tools et Providers comme paramètres ;
ils ne connaissent plus leurs stores. Les autres adaptateurs préparent les
extractions suivantes et ne remplacent pas encore les appels internes des stores.
Les consommateurs injectés importent les interfaces du domaine, jamais la racine
de composition. Les modèles partagés résident dans `src/types/` ; les types
`Citation` et `IconName` y sont définis indépendamment de leurs consommateurs.

Le prompt de reprise après outil et la normalisation des contrats d'artefacts
résident dans `src/domains/chat/` et `src/domains/plans/`. Leur utilisation ne
charge plus l'orchestration Architect ni le service de persistance des artefacts.

L'API `notify.*`, les templates accessibles, les actions de session, l'historique
et le canal desktop restent centralisés. Les préférences sont lues par un
adaptateur typé, directement dans leur store propriétaire. Sans renderer, les
notifications destinées au toast sont conservées par identifiant en mémoire ;
une mise à jour remplace la livraison du même identifiant et une fermeture
l'annule. Leur délai d'expiration commence au montage du renderer. L'historique
et le canal desktop restent traités lors de l'émission. Cette attente est
transitoire et n'introduit aucune seconde persistance. Les anciens appels
techniques `toast.*` conservent leur comportement Sonner ; le contrat de livraison
différée concerne `notify.*`.

La garde `architecture:check`, exécutée par le profil CI frontend et le contrôle différentiel avant push, analyse les
imports locaux, distingue les types du runtime et interdit les nouvelles arêtes
contraires aux frontières ainsi que les nouveaux cycles. Les exceptions
historiques sont nommées dans le fichier de référence portable sous
`dev/architecture/`. Leur attribution organise les extractions restantes :
Chat pour l'orchestration conversationnelle, Tasks/Plans pour la persistance et
les transitions, Providers pour la sélection et les transports, Shell pour
les réglages et l'interface. `appStateRuntime` reste une dette existante ; aucun
nouveau consommateur ni service locator n'est ajouté ici. Les contrats globaux
seront consolidés au lot 15.

Mesure de cette extraction, hors tests et déclarations `.d.ts` :

| Mesure | Avant | Après |
| --- | ---: | ---: |
| Modules TypeScript | 513 | 524 |
| Arêtes runtime | 1 773 | 1 789 |
| Arêtes de types | 671 | 679 |
| Plus grande SCC statique | 25 | 16 |
| Plus grande SCC avec imports dynamiques | 34 | 24 |
| Exceptions de frontières | 40 | 36 |

Une même paire de modules peut porter une arête runtime et une arête de types.
Le graphe conserve aussi les imports dynamiques ; les déplacer ne contourne pas
la garde. Le parcours des fichiers commence dans `src/`. Les alias sont lus dans
la configuration Vite sans exécuter ses plugins. Le contrat du résolveur couvre :

- les imports relatifs, les chemins `/src/...` et les références TypeScript
  `src/...` permises par le `baseUrl` actuel ;
- les objets `resolve` et `alias` littéraux dans la configuration exportée,
  avec des clés d'alias textuelles et des cibles `/src/...`, `./...` ou `../...` ;
- l'ordre des alias et la normalisation des barres finales de Vite. La première
  correspondance décide de la cible, même si celle-ci est absente ;
- les fichiers exacts, la conversion des suffixes JavaScript en suffixes TypeScript,
  puis les extensions par défaut de Vite et les fichiers `index`. Des fixtures
  comparent ces choix au résolveur Vite installé, avec une configuration isolée.

Une cible relative d'alias part du fichier importeur. Les remplacements absolus
propres à une machine, les remplacements par un nom de paquet, les substitutions
`$`, les configurations indirectes ou ambiguës et les options de résolution
supplémentaires font échouer la garde. Les chemins symboliques, les imports qui
sortent de `src/` et la résolution d'un répertoire source par son `package.json`
demandent aussi une adaptation explicite. Les spécificateurs internes `#...`
ainsi que les champs `exports` ou `browser` des manifests de paquet du projet
sont refusés pour empêcher une redirection locale classée comme externe. L'inventaire des fichiers sous `src/`
permet de refuser un module JavaScript ou `.mts`/`.cts` qui masquerait une cible
TypeScript analysée. Les tests, déclarations et assets restent hors du graphe.
`import.meta.glob`, `globEager` et `globEagerDefault` sont refusés : leurs imports
sont produits par une transformation Vite, hors de l'analyse TypeScript.
Les règles de frontières des domaines gardent le même périmètre.

Les nouveaux modules d'adaptation augmentent le nombre total d'arêtes,
mais réduisent le groupe de modules chargés cycliquement. Le contrat pur `mentionContract` supprime le cycle séparé entre
`MentionChip` et `MentionNode`, sans changer les exports du nœud Lexical. La SCC statique restante
unit encore les stores App, Chat, Tasks, Skills et Terminal aux services Architect,
metadata, merge et worktrees ; ces extractions appartiennent aux lots suivants.
Les notifications et i18n ne participent plus aux SCC, même avec les imports
dynamiques. La baseline finale interdit leur réintroduction.

### 5.6 Lazy loading

L'application charge paresseusement :

- les composants associés aux modes
- plusieurs modales non critiques

Le but est de limiter le coût du bundle initial et d'accélérer l'affichage du shell applicatif.

---

## 6. Stores et orchestration client

### 6.1 `useAppStore`

`useAppStore` est le store pivot du frontend.

Il gère notamment :

- le mode actif
- la sélection du groupe et du projet
- le plan courant
- les plan nodes et predicted branches
- les panneaux, modales et préférences globales
- l'état de sync metadata
- le changement de contexte projet

### 6.2 `useChatStore`

`useChatStore` gère :

- les conversations
- les messages
- la projection du runtime de chaque conversation
- les pièces jointes image
- les références de contexte du composeur
- la relation entre mode actif et conversation sélectionnée

Les cas d'usage `chatSend/sendMessage`, `chatRequestPreparation`,
`chatAssistantStreamRuntime` et `chatAssistantPersistenceRuntime` coordonnent
l'envoi, la préparation de la requête, le stream et la reprise
après échec de sauvegarde. Ils reçoivent des ports typés et se testent sans React
ni mock de store. L'adaptateur capture les sélections UI avant la première
attente ; le runtime reçoit ensuite ce snapshot, ses dépendances et les
opérations de projection séparément.

Les soumissions différées utilisent le stockage local de récupération du chat.
Leur runtime, la revalidation de contexte, les instructions du plan Architect et
le panneau de récupération sont chargés à la demande pour préserver le budget du bundle initial. La capture
du contenu et des sélections reste synchrone avant ces chargements.
`chatQueuedSubmissions` conserve uniquement l'intention et le contenu acceptés,
avec un identifiant repris comme `turn_id`. Le store garde l'entrée tant que le
message utilisateur et ses images ne sont pas durables. Une reprise relit le
transcript pour reconnaître ce tour avant tout nouvel envoi. Elle recharge les
configurations et les droits sur la cible capturée ; un changement de cible
bloque la reprise. Le panneau commun de récupération porte l'action de réessai,
indépendamment des préférences de notification et sans état parallèle dans `ChatZone`.

`chatTurnRuntime` possède les identités de session, les promesses de stream,
les instructions en attente et les propriétaires de persistance. Le record des
phases reste unique, derrière un port de projection adossé au store. Le runtime
ne maintient aucune seconde copie des messages ou de la sélection. Sa transition
`beginCompletion` vers `persisting`, puis `releaseCompletion` ou `failCompletion`,
forme le point de raccord des transports. `claimStream` attribue une identité
de tentative distincte lors d'une récupération du même tour. Un stream remplacé ne libère pas son
successeur et l'attente de fin suit les remplacements dus à la récupération.

Cette identité de stream ne désigne pas une requête modèle. `toolCallingLoop`
attribue un identifiant distinct à chaque requête fournisseur, y compris les
renvois internes des transports HTTP et natif ; le
message assistant conserve son texte brut, le texte accepté et un coût
`null` tant qu'aucun coût par tentative n'est attribuable. Avant une écriture
partielle, `chatStreamOrchestrator` vide les tokens en attente et la boucle publie
le texte accepté, y compris le suffixe d'une continuation. Un échec de cette
écriture intermédiaire est journalisé sans devenir une erreur fournisseur. Quand
un utilisateur arrête le stream, la tentative en cours, suivie en mémoire au fil
des tokens ou dès l'envoi de la requête, rejoint le message avant sa sauvegarde
partielle. Si la préparation après un dépassement de contexte échoue, Macro
garde les tentatives déjà enregistrées sur le message assistant. Quand
une récupération de dépassement de contexte remplace le stream sur le même
message, ses nouvelles tentatives s'ajoutent aux précédentes par identifiant.
Si le tour aboutit, l'écriture finale réessaie de sauvegarder la réponse et ses
tentatives. Son échec utilise la récupération de réponse non sauvegardée, qui
retransmet aussi les tentatives. Un crash pendant un tour fournisseur ou après un échec d'écriture
intermédiaire peut laisser ses derniers tokens et sa tentative hors de SQLite.

`chatStreamCompaction` garde le checkpoint provisoire d'un stream ;
`chatStreamComposition` raccorde ses ports au tour capturé. Le dispatch `chatToolDispatch` valide l'identité avant et après les effets
asynchrones et transmet le contexte figé avec son signal d'annulation. La copie
MCP conserve la clé opaque de génération backend via `mcp/runtimeSnapshot`.
La récupération d'overflow transmet les capacités capturées à la préparation :
type d'agent, allowlist, catalogue et clé MCP, risque et réglages d'outils. Elle
reconstruit le contexte compacté sans résoudre une nouvelle génération MCP ni
relire les sélections de configuration du tour. Le contrôle
de tentative accompagne aussi l'exécuteur pendant ses attentes, puis les ports
Architect et terminal avant chaque nouvelle opération. Architect résout sa cible
implicite à partir du plan et de la branche capturés ; ses projections UI ne
s'appliquent que si la sélection correspond encore au tour. Une écriture déjà
engagée peut finir après Stop, sans lancer la projection suivante. Une erreur
tardive du placeholder assistant n'autorise pas l'ancien tour à remettre en
brouillon une tâche reprise par son successeur ; un échec du tour encore
propriétaire conserve sa compensation.
`chatToolExecution` charge `chatToolExecutionRuntime` au premier appel d'outil.
Ce runtime garde le routage et les contrôles de politique existants, notamment
la vérification du propriétaire après le chargement. `deferredArchitectTool`
charge le handler Architect au premier appel du port et revérifie l'autorité
du tour avant ses effets. Les ports et le contexte restent ceux capturés par
l'appelant ; ces façades n'ajoutent aucun propriétaire de workflow.

`chatToolApproval` coordonne leur approbation durable et `chatAgentTerminal`
gère les sessions terminal de l'agent. Les ports raccordent les effets des
autres domaines sans importer leurs stores. `chatPersistenceService` reste propriétaire
des adaptateurs de persistance existants.

Le store conserve la sélection, l'hydratation des conversations, les projections
de messages et diagnostics, le compositeur, les questionnaires et les dialogues
d'approbation. Les workflows de rejeu et checkpoints ainsi que les adaptateurs
Architect/Implement restent une dette distincte de l'orchestration d'un envoi.
Cette extraction ne supprime donc pas à elle seule la grande SCC historique.

En mode Implement, l'en-tête de la conversation dérive le contexte visible de la tâche cataloguée sélectionnée. Il utilise `plan_title` et `branch_name` de cette tâche, puis résout les noms de projets depuis le registre déjà chargé. Une valeur absente n'est pas remplacée par une sélection globale et aucun état d'affichage durable n'est ajouté.

### 6.3 `useTaskStore`

`useTaskStore` conserve le catalogue des tâches, la sélection et les projections
visibles des opérations. Le démarrage, la préparation, les commandes projet et
la revue/merge s'exécutent dans des services auxquels le store fournit des ports
typés. Les mutations de statut d'un plan calculent leur résultat sous le verrou
par branche du service Plans.

[Workflows des tâches et des plans](task-plan-workflows.md) décrit la propriété
de l'état, les raccords de composition, les protections de concurrence, la
reprise après effets durables et les responsabilités qui restent dans l'UI.

### 6.4 Stores spécialisés

D'autres stores portent des responsabilités ciblées :

- `useGitStore` pour arbres et commits Git
- `useFileChangesStore` pour la review de changements
- `useProviderStore` pour les providers et modèles IA
- `useSpeechToTextStore` pour les fournisseurs vocaux et les préférences de dictée
- `useToolsStore` pour les outils internes et MCP
- `useSkillsStore` pour la découverte, les préférences et les activations de skills

### 6.5 Principe d'orchestration

Le frontend ne doit pas dupliquer les décisions métier dans plusieurs composants.

La logique transverse doit être concentrée dans :

- les stores
- les services
- quelques hooks d'orchestration

Les composants doivent surtout afficher, recueillir des intentions utilisateur et appeler les actions prévues.

---

## 7. Couche services frontend

### 7.1 Abstraction provider

La couche `services/index.ts` sélectionne dynamiquement le provider de données selon :

- le transport cible (`desktop` ou l'adaptateur interne `remote`)
- la disponibilité effective du runtime Tauri

Cette abstraction permet :

- d'utiliser Tauri en mode desktop ;
- d'expérimenter avec un backend headless compatible sans réécrire le reste de l'application.

Le second chemin reste une infrastructure de développement partielle et ne fait pas partie des modes supportés de Macro 0.1.

### 7.2 Services de domaine

Les services frontend sont spécialisés par sujet.

Exemples principaux :

- `architectPlanService`
- `architectGitFlowService`
- `macroSyncService`
- `streamingChat`
- `workspaceToolExecutor`
- `remoteKernelApi`
- `toolModePolicy`
- `projectExecutionContext`
- `skills` via le contrat provider et les commandes IPC dédiées
- `speech/microphoneRecorder` pour la capture audio différée côté WebView
- `speech/transcriptEnhancement` pour la correction LLM facultative et bornée
  des transcriptions

L'estimation du contexte multimodal conserve les dimensions et le type MIME des
images dans une métadonnée interne ordonnée avec les parties image du message.
Cette métadonnée n'est pas sérialisée vers le fournisseur. Le service
`contextTokenEstimation` applique la formule documentée du modèle ou du
fournisseur lorsque celle-ci est connue, puis utilise un repli fondé sur les
dimensions. Le poids Base64 reste une mesure de transport séparée et n'est
jamais compté comme du texte. Une estimation visuelle, même élevée ou
incertaine, peut déclencher une compaction préventive, mais ne peut pas à elle
seule produire un blocage définitif avant l'appel au fournisseur. Les erreurs
réelles de dépassement restent prises en charge par la récupération de
débordement du flux.

Le planificateur de compactage utilise les limites autoritatives du provider et
le budget utilisable après réserve de sortie. À la frontière `pre_send`, il
déclenche un entretien synchrone au seuil `blocking`, avant la saturation. À la
frontière `post_tool_batch`, il peut aussi agir au seuil `background` pour
absorber l'accumulation des résultats d'outils. Une limite de repli non
autoritative reste diagnostique. Le planificateur ne lance pas de résumé
spéculatif en arrière-plan.

Avant un résumé, le passage d'élagage remplace seulement les anciennes lectures
rendues obsolètes par une lecture plus récente de la même ressource. Sa clé
combine l'identité du projet, le chemin normalisé et la plage de lecture. La
frontière du checkpoint exclut les messages déjà résumés, et le suffixe chaud du
cache de prompt reste intact lorsqu'aucune reconstruction du cache n'est prévue.
Les erreurs, les plans actifs, les ressources de skill et la dernière lecture
utile restent inchangés. Les éléments provider qui portent des appels et des
résultats d'outils continuent de passer par la normalisation d'appariement du
transport.

Chaque événement de compactage enregistre la cause de fin du dernier tour connu,
la méthode appliquée, les éléments élagués, les tokens estimés gagnés, la
décision sur le checkpoint et l'effet attendu sur le cache de prompt. Les
frontières synthétiques post-outils restent transitoires jusqu'à leur
consolidation sur un identifiant de message durable.

### 7.3 Contrats et DTO

Les DTO frontend servent de couche de stabilisation entre :

- les types UI
- les retours des providers
- les transports backend

Cette couche limite le couplage direct entre composants React et détails de sérialisation.

Les wrappers natifs sont regroupés par domaine dans `src/services/ipc/`. La façade
`tauriIpc.ts` conserve les exports historiques. Les modules de domaine utilisent
`tauriRuntimeBridge` directement ; le bridge navigateur reste un transport desktop,
sans sélectionner le provider HTTP expérimental.

Les formes réseau Rust sont réexportées par domaine dans `ipc_contracts` et
générées sous `src/types/generated/ipc/`. Le générateur `generate_config` partage
son moteur entre configuration et IPC. Le registre suit les dépendances ts-rs,
vérifie les imports et les collisions, puis produit un manifeste déterministe.
`config:check` et `ipc:check` refusent les fichiers manquants, modifiés ou
surnuméraires sans écrire. Les profils CI natifs et le contrôle différentiel
exécutent ces vérifications.

Les fichiers `ipc/*.types.ts` adaptent les contrats générés aux consommateurs
existants : propriétés facultatives historiques, unions frontend plus précises
que les champs String Rust, vues partielles et normalisation du statut Git.
Ils conservent uniquement les différences de forme. Les helpers `OmitFields` et
`OptionalFields` bornent leurs clés à `keyof` du contrat natif : retirer ou renommer
un champ adapté fait échouer le typage à cette frontière. Cette contrainte vérifie
les noms de champs ; elle ne remplace pas une validation runtime ni la relecture
des adaptations sémantiques. Les parseurs et les objets
pratiques de paramètres restent frontend. Une modification de ces adaptations
exige de vérifier les consommateurs, pas seulement de régénérer les fichiers.

La génération utilise ts-rs 12 avec une représentation numérique explicite des
entiers IPC, conforme au JSON actuel. Cette représentation ne garantit pas une
précision au-delà des entiers sûrs de JavaScript. Les valeurs JSON libres utilisent
le type récursif `JsonValue`. La configuration conserve ses annotations et ses
sorties existantes. Les omissions `skip_serializing_if` sont déclarées explicitement
lorsque ts-rs ne peut pas les déduire. Les aliases Serde d'entrée et les fonctions
`deserialize_with` continuent de valider côté Rust ; les bindings décrivent les
noms canoniques et les formes, pas ces contraintes de valeurs.

Les unions de statut dont le backend renvoie encore une String, les paramètres
pratiques tels que `FrontendLogParams`, les projections de mise à jour et les
champs provider adaptés restent des contrats frontend identifiés. Le canal
`MCPRuntimeEvent` réservé au frontend n'a pas de DTO Rust à générer. Les erreurs
natives, elles, dérivent du payload effectivement sérialisé par `CommandError` ;
la normalisation des erreurs de service conserve aussi les rejets historiques
sous forme de chaîne ou d'enveloppe distante.


Les exports de `ServiceProvider` restent raccordés au chargement dynamique des
providers. L'absence d'appel direct à une méthode ne démontre pas qu'elle est
inutilisée. La façade `tauriIpc.ts` et les réexports Rust de `commands` pourront
être retirés après migration explicite de leurs appelants ; leur retrait ne doit
pas être déduit d'une recherche d'imports nommés uniquement.


### 7.4 Boucle d'outils et compatibilité des providers

Les résultats MCP conservent des blocs typés dans l’historique. Le
[contrat MCP](mcp-tool-results.md) décrit les limites, les formats transmis au
modèle, les replis explicites et le retour à une ancienne version.

`streamingChat` valide les arguments d'un outil avec le schéma publié dans le
registre avant d'appeler son exécuteur. Un échec de validation ou d'exécution
reste un résultat d'outil associé au `tool_call_id`. Il ne devient jamais un
message système ajouté au milieu de l'historique.

Pour les API Chat Completions compatibles OpenAI, la sérialisation extrait les
consignes système de l'historique et les place en tête. Le profil conservateur
`single_leading` les fusionne en un seul message, ce qui couvre les serveurs
stricts qui refusent plusieurs messages système ou un message système tardif.
Macro vérifie aussi les identifiants, l'appariement des appels et résultats
d'outils, ainsi que l'ordre des rôles avant chaque requête réseau.

Le frontend transmet au backend des diagnostics structurés sans contenu de
conversation, sans arguments d'outils, sans message d'erreur provider brut et
sans secrets. Le backend écrit des fichiers `macro.YYYY-MM-DD.log` dans le
dossier de journaux de la plateforme, notamment
`%LOCALAPPDATA%\com.macro.desktop\logs` sous Windows. La rotation est quotidienne
et conserve les sept fichiers les plus récents, avec une limite de 20 Mio par
jour. Les diagnostics navigateur globaux ne conservent que leur catégorie ;
leurs messages et piles sont retirés avant l'écriture native.
La limite de taille utilise un verrou interprocessus et rejette un événement
complet quand il ne tient plus dans le budget quotidien.
Les échecs OAuth et fournisseur conservent leur détail pour l'interface, mais
les journaux persistants n'enregistrent que le statut et la catégorie d'opération.

---

## 8. Runtime desktop et IPC

### 8.1 Rôle de Tauri

Tauri sert de runtime desktop et d'interface native.

Il héberge :

- la fenêtre applicative
- les plugins système
- le frontend web
- le registre de commandes IPC Rust

### 8.2 Commandes IPC

Le backend expose de nombreuses commandes Tauri, regroupées par domaine :

- base de données
- workspace
- outils
- skills
- système de fichiers
- Git
- reconnaissance vocale

Ces commandes sont centralisées dans le point d'entrée du backend.

### 8.3 Plugins natifs utilisés

Le runtime embarque des plugins Tauri pour :

- l'ouverture de ressources externes
- les requêtes HTTP
- les dialogues système
- le stockage natif

---

## 9. Architecture backend Rust

### 9.1 Modules principaux

Le backend Rust est organisé en modules de domaine.

Les blocs principaux sont :

- `core/`
- `db/`
- `fs/`
- `git/`
- `workspace/`
- `commands/`
- `ai/`
- `speech/`

### 9.2 `core`

Le module `core` porte :

- la configuration runtime
- la gestion d'erreurs
- le logging
- la politique d'outils

`core::workspace_execution` porte l'exécution native partagée, les montages
virtuels, l'annulation et les transactions de fichiers avec checkpoints.
`fs::operations` porte les accès confinés et `git::operations` les opérations
Git natives et WSL utilisées par ce cœur. Le dispatch des workflows et leurs
journaux résident dans `git::operations::workflow`. Ces modules ne dépendent
ni des commandes Tauri ni de State, Window ou AppHandle.

`core::command_error` conserve le contrat d'erreur sérialisé et
`core::db_state` l'état d'initialisation DB. Les identifiants de secrets MCP
sont définis dans `core::mcp_ids`, accessibles au registre de configuration
sans importer son adaptateur de commandes.

Les adaptateurs gardent leur autorité propre. Tauri conserve les décisions du
frontend et la validation native ; le tool host vérifie son bearer local et
refuse les outils terminal ; le headless vérifie le registre serveur, les
politiques de tous les projets affectés et son journal durable. Partager
l'exécuteur ne remplace aucun de ces contrôles. Les options internes de racine
et de capture des checkpoints ne deviennent pas des paramètres client.

### 9.3 `db`

Le module `db` porte :

- l'initialisation SQLite
- les migrations
- les modèles et repositories
- les commandes de persistance de conversations, messages, providers et contextes locaux

La migration `004_message_search` crée un index FTS5 externe sur le contenu des
messages. Trois triggers le synchronisent avec les insertions, modifications et
suppressions. Le repository reçoit la liste des conversations admissibles et
applique cette portée avant la pagination, puis expose une recherche bornée et
paginée ainsi qu'une reconstruction déterministe de l'index depuis `messages`.
La validation des sauvegardes compare les colonnes, les clés étrangères et leurs
actions de cascade, les définitions des tables virtuelles, les index applicatifs,
les vues et les triggers au schéma de référence de la version courante. Une clé
étrangère absente est refusée même si `integrity_check` et `foreign_key_check` ne
trouvent aucune erreur. La comparaison structurelle des tables ordinaires reste
compatible avec les différences de texte SQL dues aux migrations historiques.

Les archives locales restent hors des répertoires de données et de configuration,
y compris lorsque leur chemin passe par un alias symbolique. La préparation
publie un fichier complet, synchronisé, sans écraser une destination existante.
Au démarrage, une demande illisible est isolée et signalée par un statut de
récupération. Le bootstrap portable laisse `ConfigManager` choisir le runtime
approuvé avant d'appliquer le workspace ; il ne parse pas le fichier brut.

Avant la capture ou la restauration, les chemins gérés sont contrôlés même si
l'archive omet leurs fichiers. Les checkpoints utilisent les mêmes limites de
profondeur et de nombre de nœuds implicites lors de la validation et de la
préservation. Le rollback retire les dossiers de checkpoints devenus vides pour
rétablir une ancienne feuille fichier. La demande terminée est retirée avant le
journal de restauration pour empêcher son rejeu après récupération. Les statuts
natifs exposent un code et un chemin ; l'interface traduit le résumé et conserve
les messages techniques dans les détails du diagnostic.

### 9.4 `fs`

Le module `fs` porte :

- la lecture et l'écriture de fichiers
- la validation des chemins
- le support du watcher de fichiers
- la résolution spéciale du workspace metadata

### 9.5 `git`

Le module `git` porte :

- l'ouverture et la validation des dépôts
- les commandes de status, log, branches, diff, push, pull, merge
- la gestion des worktrees
- la branche metadata `@macro`

### 9.6 `workspace`

Le module `workspace` porte :

- le bootstrap du workspace
- la liste des groupes et projets
- la persistance du fichier `workspace.json`
- les opérations de création, import, renommage, archivage, restauration et fermeture de projets

### 9.7 `ai`

Le module `ai` porte :

- l'abstraction provider côté backend
- les implémentations OpenAI, Anthropic et local

Cette couche est encore partiellement utilisée selon les flux, mais fait partie de l'architecture cible.

### 9.8 `speech`

Le module `speech` valide la taille et la configuration des enregistrements, puis
sélectionne un adaptateur de protocole. L'adaptateur OpenAI-compatible envoie un
multipart vers `/audio/transcriptions`; l'adaptateur Deepgram envoie les octets
audio vers `/v1/listen`. Les commandes Tauri reçoivent le contenu audio dans un
corps IPC binaire afin d'éviter une sérialisation JSON ou base64 inutile. Les
adaptateurs refusent les redirections, limitent la réponse du fournisseur à 1 Mo
et imposent HTTPS aux fournisseurs distants afin que l'audio et les clés ne
transitent pas en clair.

Le provider vocal géré `andrologic-speech` cible
`https://lmstudio.andrologic.ai/v1/audio/transcriptions` avec le modèle public
`macro-transcription`. La commande native ne possède pas de secret vocal dédié :
elle résout le jeton d'installation du provider LLM `macro-ai` dans le stockage
sécurisé et déclenche son provisionnement existant s'il manque. Le WebView
capture dans un format pris en charge par `MediaRecorder`, puis
`andrologicAudio` décode, réduit en mono, rééchantillonne à 16 kHz et encapsule
en WAV PCM 16 bits avant l'IPC binaire. Le timeout Andrologic couvre jusqu'à dix
minutes de FIFO puis dix minutes de traitement. Les réponses `429` conservent
l'indication `Retry-After` dans l'erreur et les réponses `503` sont signalées
comme indisponibilités temporaires ; aucun retry automatique ne duplique
l'enregistrement.

Après la transcription native, `useSpeechDictation` peut déclencher
`speech/transcriptEnhancement`. Ce service réutilise `sendChatNonStreaming`, le
provider et le modèle actifs de la conversation, sans raisonnement avancé. La requête
emploie un identifiant de conversation éphémère, n'active aucun outil et transmet
un contexte textuel borné aux deux derniers messages et à de courts champs de
contexte. Le contrat de prompt impose une
réécriture minimale. Des garde-fous rejettent les réponses vides ou dont la
longueur indique une synthèse ou une expansion excessive ; le hook revient alors
à la transcription brute. Un changement de contexte annule aussi la requête en
cours afin qu'un résultat ne soit jamais inséré dans une autre conversation.

---

## 10. Persistance

### 10.1 Persistance locale SQLite

SQLite est la base locale principale.

Elle stocke notamment :

- conversations
- messages
- settings
- cache local de workspace
- références de dépôts Git et worktrees
- configurations des fournisseurs de reconnaissance vocale, sans les clés API

Les approbations en attente utilisent le setting SQLite versionné
`toolApprovalRecovery:v1`. Il conserve uniquement les identifiants de conversation,
de message assistant et d'appel d'outil. Le transcript est enregistré avant ce
marqueur. Les arguments, chemins et permissions ne sont pas copiés dans ce
setting. Un writer sérialise les mutations du registre. L'hydratation lit ce
registre, puis les transcripts concernés. Les données inconnues restent intactes
à la lecture. Une écriture conserve les collisions et les racines illisibles dans
`preservedData` du même document, sans bloquer une nouvelle demande. Les champs
inconnus de la racine restent présents après suppression de la dernière demande.
Un échec de lecture ou de nettoyage d'une demande est affiché sans interrompre le
démarrage de Chat. L'avertissement peut être fermé sans supprimer les données.
Si la création du marqueur échoue, le store ferme la trace enregistrée ; si cette
fermeture échoue aussi, une action de reprise reste disponible dans la session.

`PendingToolApproval.recoveryState === 'interrupted'` désigne une demande
restaurée sans resolver vivant. Le store ferme durablement la trace avant de
supprimer son marqueur. Pendant une reprise, le marqueur et son action restent
présents jusqu'à l'acceptation du nouveau message utilisateur. Une trace déjà
refusée peut donc encore porter cette intention de reprise. Une approbation live
recharge la politique projet et le runtime MCP avant toute clôture. Une politique
invérifiable laisse une action de reprise et n'autorise aucune exécution. Une
demande active n'a pas ce champ. Les permissions de conversation restent en
mémoire et ne sont jamais restaurées. Une réinitialisation retire les anciens
resolvers et attend la fin des écritures déjà engagées dans leurs files avant
l'hydratation. Une génération périmée ne peut plus autoriser l'outil ni clore
une demande restaurée. Tant qu'une demande live reste visible pendant la
revalidation ou la clôture durable, un refus révoque l'autorisation avant le
dispatch. Les approbations MCP exposent l'identité protocolaire et un aperçu des
arguments, avec champs sensibles masqués et troncature signalée.

La colonne `messages.generation_attempts_json` stocke les tentatives déjà
observées par le runtime. `toolTraceState` reclasse les traces au rechargement
et dès qu'un flux se termine ou s'interrompt : `done` et `denied` sont clos,
une trace non résolue devient `unknown`, et seul le marqueur d'approbation
restauré rend cette demande `replayable`. `live` exige un flux propriétaire
encore actif. Ces états décrivent la preuve disponible pour la trace, pas une
garantie d'exécution unique de l'effet externe.
`streamAccumulator` laisse une trace sans résultat confirmé en `running` avec
`recovery_state=unknown` à la fin du tour. Le rendu des anciens marqueurs
`[TOOL]` exige `[TOOL_DONE]` pour afficher une fin confirmée.

### 10.2 Persistance locale frontend

Le frontend utilise aussi de la persistance locale légère pour :

- certaines préférences
- les filtres structurants des listes principales : projet, statut et archives
  dans Implement, ainsi que la vue active ou archivée dans Architect et Chat
- le fournisseur vocal actif, la langue et la durée maximale de dictée
- les sélections de modèle par contexte
- l'état de session local
- certains fallback de plans
- des données temporaires de pièces jointes

La file Implement dérive sa supervision dans `taskQueueAttention` à partir du
catalogue de tâches, des liens durables vers les conversations, des
questionnaires et de `pendingToolApprovalByConversationId`. Le registre inclut
les approbations restaurées ; la file n'interprète pas leur stratégie de reprise.
Le classement reste distinct du statut durable de la tâche. Une demande active
prime sur le streaming dans l'indicateur et le compteur d'attente ; un statut
`AwaitingResponse` obsolète ne prime pas sur une exécution réelle. Une réponse
après le dernier questionnaire retire aussi cette attente du groupe et de
l’indicateur. Le chargement de messages sans cette preuve conserve l’attente
durable. La file s’abonne à la signature des demandes, sans réagir aux fragments
de texte ordinaires. Le filtre
`attention` partage la persistance du filtre de statut. Aucun index d'attention
ni résumé de review supplémentaire n'est persisté.

Ces filtres de liste utilisent des objets versionnés dans `state.json`. Le
frontend normalise chaque valeur hydratée et revient aux valeurs par défaut
pour une version inconnue. Une erreur de lecture native laisse le store non
hydraté et autorise une nouvelle tentative. Les modifications locales restent
prioritaires champ par champ lors de cette tentative ; aucune écriture issue
des valeurs par défaut ne part avant une lecture réussie. Les recherches
textuelles, les sélections multiples et les filtres propres aux boîtes de dialogue ou au terminal restent des états
de session non persistés.

### 10.3 Metadata dans la branche `@macro`

L'historique structuré de Macro est conservé dans une branche metadata dédiée.

Cette branche contient notamment :

- `workspace.json`
- `branches/<target-branch>/plans/index.json`
- `branches/<target-branch>/plans/<plan-id>/plan.json`
- `branches/<target-branch>/plans/<plan-id>/runtime.json`
- `branches/<target-branch>/plans/<plan-id>/manifest.json`
- `branches/<target-branch>/plans/<plan-id>/chat.jsonl`
- `branches/<target-branch>/plans/<plan-id>/artifacts/index.json`
- `branches/<target-branch>/plans/<plan-id>/artifacts/tasks/<task-id>/<artifact-id>.md|json|txt`

Le stockage metadata dans Git permet l'audit, la redondance et la conservation de l'historique de travail.

Les mutations d'un plan répliqué (`create`, `update`, `archive`, `restore`,
`delete`, liaison de conversation, activation, transcript, réparation et
auto-heal) utilisent une saga locale durable stockée dans SQLite. Une
intention qualifiée par workspace, branche et identifiant de plan est écrite
avant toute modification. Elle contient l'état cible complet du plan et de
l'index pour chaque scope, ainsi que le message de commit metadata. La reprise
réapplique cet état cible de façon idempotente, finalise les commits `@macro`,
puis retire seulement le journal. Les mutations d'une même branche sont
sérialisées afin que deux plans ne calculent jamais leur prochain index depuis
le même ancien snapshot. La reprise partage le même verrou de workspace que
l'application active d'une transaction et ne peut donc pas rejouer une intention
encore en cours. Les entrées d'un autre workspace restent en attente et
les entrées invalides sont mises en quarantaine sans être interprétées comme un
catalogue vide.
Les mises à jour du journal et de sa quarantaine emploient un compare-and-swap
atomique dans SQLite avec reprises bornées, afin que plusieurs processus Macro
ne puissent pas écraser leurs intentions concurrentes.

---

## 11. Modèle metadata et plans

### 11.1 Structure des plans

Les plans sont stockés dans une structure de type :

- `branches/<target-branch>/plans/index.json`
- `branches/<target-branch>/plans/<plan-id>/plan.json`
- `branches/<target-branch>/plans/<plan-id>/runtime.json`
- `branches/<target-branch>/plans/<plan-id>/manifest.json`
- `branches/<target-branch>/plans/<plan-id>/chat.jsonl`
- `branches/<target-branch>/plans/<plan-id>/artifacts/index.json`
- `branches/<target-branch>/plans/<plan-id>/artifacts/tasks/<task-id>/<artifact-id>.md|json|txt`

Les artefacts de relais de tâches sont séparés du dossier `tasks/<task-id>/`, qui reste réservé aux rendus générés comme `planned.md` et `executed.md`.

`artifacts/index.json` contient l'index durable des artefacts et les validations metadata par couple `(artifactId, taskId)`. Une validation d'artefact ne stage aucun fichier applicatif ; elle sert uniquement à marquer la revue de l'artefact pour la tâche consommatrice courante.

Les écritures et validations d'artefacts utilisent le journal SQLite des mutations
Plans, la même file de mutations par branche et le même verrou de workspace que
la reprise Plans. L'intention `artifacts` conserve les contenus avant et après
pour chaque réplique, y compris l'index, le manifeste existant et les contenus
inchangés nécessaires à une validation. Elle précède toute écriture de fichier.
Avant le marqueur durable `files_applied`, une erreur ou une réouverture restaure
l'état antérieur. Après ce marqueur, la reprise vérifie l'état final et termine
le signalement au coordinateur metadata, sans annuler l'opération. Le journal
reste présent jusqu'au succès de cette reprise.

Chaque écriture ou suppression réutilise la révision native observée. La reprise
refuse un fichier dont le contenu diffère à la fois de l'état initial et de
l'état attendu ; elle conserve l'intention pour ne pas écraser une modification
externe. Une intention d'artefacts invalide, y compris son enveloppe, bloque
aussi la reprise et reste dans le journal actif. Le chargeur reconnaît également
une intention d'artefacts par son identifiant ou ses instantanés si le champ
`operation` manque ou a changé. Le module de persistance des artefacts est chargé
à la demande lors d'une lecture, d'une mutation ou d'une reprise d'artefact.
Si le registre des projets
change et qu'une ancienne clé de workspace chevauche la clé actuelle, la reprise
bloque explicitement l'accès plutôt que de rejouer sous un verrou différent.
Rétablir le registre initial permet alors de reprendre cette intention.
Les lectures
d'artefacts vérifient les chemins, les empreintes de contenu, le résumé du
manifeste lorsqu'il existe et l'accord des répliques avant d'exposer une
validation ou d'autoriser la fin d'une tâche. Un ancien état partiel sans journal
est donc signalé, sans inventer le contenu antérieur manquant. Ces garanties
reposent sur les écritures atomiques natives et le journal SQLite existants ;
elles n'ajoutent pas de verrou distribué entre processus.


### 11.2 Raison de cette structure

Cette structure sert à :

- conserver une représentation machine des plans
- conserver une représentation lisible par humain
- permettre une auditabilité fine tâche par tâche
- rendre la metadata consultable même hors de l'application

### 11.3 Relation avec le frontend

Le frontend lit, écrit et synchronise cette structure via :

- les services de planification
- le service d'artefacts de plan, qui calcule la fermeture transitive des dépendances et applique les droits de lecture/écriture par tâche
- les commandes FS avec scope metadata
- les commandes Git de sync `@macro`

---

## 12. Git, branches et worktrees

### 12.1 Principes

L'architecture Git de Macro repose sur trois niveaux principaux :

- branche de base de développement
- branches d'intégration de plan
- branches de feature ou d'exécution

### 12.2 Branches de plan

Pour le travail planifié, Macro utilise une branche d'intégration dédiée au plan.

Cette branche sert de point de convergence avant le merge final vers la branche de base.

Macro ajoute au rendu et à la file Implement une tâche de finalisation synthétique. Elle dépend des feuilles non archivées de la stratégie et n'est pas persistée comme un nœud Architect.

### 12.3 Branches de feature

Les tâches de la stratégie peuvent être réparties sur plusieurs branches de feature rattachées au plan afin de :

- maximiser le parallélisme
- conserver des lots de travail plus petits
- limiter les changements trop larges

Chaque tâche exécutable dispose de sa propre branche de feature par sous-projet éditable.

Les dépendances entre tâches expriment le séquentiel ; elles ne sont pas modélées par la réutilisation d'une même branche.

Une fois valide, le travail d'une tâche est merge vers la branche d'intégration du plan. Les tâches dépendantes démarrent ensuite depuis cette branche de plan mise à jour.

### 12.4 Worktrees

Les worktrees permettent d'isoler l'exécution par tâche.

Ils sont utilisés pour :

- éviter de tout faire dans un seul arbre de travail
- permettre plusieurs exécutions en parallèle
- conserver une séparation nette entre contextes d'exécution

La réparation des worktrees refuse les chemins non vides et les branches inattendues. Elle peut retirer un dossier vide avec `remove_dir`, sans suppression récursive. Avant de remplacer un enregistrement périmé, elle conserve son administration complète, dont l'index et les reflogs, sous `macro-worktree-backups` dans le répertoire Git commun. Des références sous `refs/macro-worktree-backups` protègent les objets de l'index et les commits de HEAD et de son reflog contre le nettoyage Git. Les fichiers d'un chemin refusé restent à leur emplacement ; l'utilisateur peut déplacer ce chemin vers une sauvegarde puis relancer la réparation.

Le diagnostic de tâche utilise `git_worktree_inspect` avec `readOnly: true` : les inspections n'y réparent pas les liens Git. L'action explicite utilise la création protégée existante puis inspecte de nouveau. Les capacités de projet sont centralisées dans `projectCapabilities` : les refus WSL de métadonnées, worktrees, revue et parcours de fusion ne retirent pas les opérations Git disposant d'une implémentation Linux.

Le démarrage d'une tâche réserve son opération locale et acquiert le verrou natif de cycle de vie avant la préparation. Pour les cibles directes, le bail conserve aussi des verrous par chemin canonique de projet, acquis dans un ordre stable. Ils sérialisent les démarrages de tâches différentes entre fenêtres et processus. Sous ces verrous, l'admission relit le catalogue persisté sans superposer le plan actif en mémoire et refuse les lectures incomplètes. Une tâche Architect écrit son statut avant de libérer les verrous. Les tâches autonomes réservent leur statut natif avant de préparer leurs ressources. La réservation renvoie la révision durable du workspace ; un rollback compare cette révision et le statut attendu sous le verrou d'état avant d'écrire. Une mutation ultérieure, même suivie d'un retour au même statut, invalide ce rollback. Un retour tardif peut enregistrer les worktrees préparés pour une tâche encore présente, mais ne publie le workspace actif que si la génération d'activation et la sélection sont toujours valides. Le résolveur inspecte les worktrees Git même lorsqu'un chemin est en cache. Pour une cible directe, l'activation ne fait que résoudre le chemin : elle ne crée ni ne lie de checkpoint et ne remplace pas la racine native. Le démarrage persiste d'abord l'identité du checkpoint dans la tâche autonome ou dans le nœud Architect via directCheckpointIdsByProjectId, puis initialise le checkpoint. Les mises à jour des nœuds conservent cette identité.

Le provisionnement d'un plan inscrit chaque intention de création dans le journal de cycle de vie avant la mutation Git. Il confirme ensuite le commit et le chemin obtenus. Lors d'une mutation de stratégie, l'appel public garde le journal et le verrou jusqu'au retour du callback de persistance du plan. Un échec de ce callback déclenche le rollback ; une reprise recalcule toutes les branches et tous les worktrees attendus depuis le plan persisté, vérifie les ressources existantes et complète les ressources manquantes avant de fermer le journal. Un journal vide ou partiel ne prouve jamais que le provisionnement est terminé. Si cette reprise échoue, elle conserve le journal et les ressources déjà adoptées pour la tentative suivante. Un rollback conserve les erreurs et les ressources restantes dans ce journal ; sa reprise retire les worktrees avant les branches, avec les identités attendues et sans forcer le retrait des fichiers de travail. L'intention enregistre aussi le commit source avant la création. Après une interruption avant confirmation, la reprise ne confirme une branche qu'au commit attendu ; pour un worktree, elle vérifie aussi sa branche, son chemin et sa propreté. Ces contrôles s'appliquent aussi avant l'adoption des ressources d'un plan déjà validé ou en cours. Toute différence, ou une ancienne intention dépourvue de commit attendu, bloque la reprise avant toute création, suppression ou fermeture du journal. Le backend indique si l'appel a créé un worktree, y compris pendant une réparation. Les simples réparations de liens et les ressources réutilisées restent exclues du rollback. La reprise constate les ressources déjà absentes avant de rejouer une suppression.

Les fusions de tâches passent par `git_workflow`. Le journal SQLite enregistre la tâche, la session, le dépôt Git commun, les branches et leurs commits avant la mutation. Les accès aux fichiers en conflit transportent cette identité et vérifient `HEAD` et `MERGE_HEAD` sous le verrou du dépôt. Une finalisation de plan ne peut adopter un conflit que si son journal de cycle de vie contient le checkpoint correspondant. Après intégration, la reprise vérifie le résultat avant de préparer les worktrees. Le nettoyage accepte une ressource déjà absente, refuse une branche source modifiée et garde les erreurs de suppression bloquantes. Une suppression distante utilise le commit attendu comme condition Git.

Le nettoyage natif garde les références source et cible verrouillées pendant la vérification de l'intégration et la suppression. Les commandes de fusion ordinaires refusent les dépôts possédés par un workflow actif. Toute mutation d'une session existante exige son identifiant observé ; seule la création initiale atomique peut s'en passer. L'abandon persiste d'abord un nouvel identifiant et une intention durable avant toute mutation Git. Cette intention conserve la propriété du dépôt et refuse les anciennes commandes. Après une interruption, la reprise termine uniquement l'abandon enregistré, puis le confirme en SQLite. Une nouvelle tentative doit observer le reçu d'abandon. La reprise conserve les commits enregistrés sans synchroniser la cible, et les commandes de pull ordinaires refusent un dépôt possédé par un workflow actif. Les opérations réseau du nettoyage sont non interactives et bornées à trente secondes par commande ; un échec libère les verrous. Avant un rebase, le journal conserve une intention et une marque unique de reflog ; après une interruption, seule la réécriture correspondant à cette marque peut être récupérée. Un rebase interrompu pendant un conflit peut être abandonné après vérification de son origine, de sa cible et de sa branche.

Le runtime des plans lit toutes ses répliques et distingue une absence de fichier des erreurs de lecture, de parsing ou de schéma. Chaque mutation réserve une génération dans SQLite par comparaison conditionnelle, puis écrit les fichiers avec leur révision attendue. Une intention interrompue est récupérée avant la mutation suivante. Une divergence sans intention correspondante bloque les écritures. Les previews transmettent leur révision de base jusqu'à la mutation sérialisée du plan, qui vérifie cette précondition sur la version canonique avant tout changement.

### 12.5 Branche `@macro`

La branche `@macro` sert de branche metadata dédiée.

Elle est synchronisée séparément du code métier.

Le système doit pouvoir :

- s'assurer de son existence
- connaître son état de divergence
- committer les metadata si nécessaire
- push et pull cette branche

### 12.6 Sync metadata

La sync metadata est gérée comme une couche distincte de la sync du code.

Cette séparation permet :

- de ne pas mélanger l'historique produit avec l'historique source classique
- d'exposer un état clair dans l'interface
- de gérer les conflits metadata de façon explicite

### 12.7 Exécution directe dans le dossier du projet

Le type de tâche `direct` utilise toujours `executionKind: repository_root`. Avec Git, il conserve `executionMode: git`, la branche courante et le hash du commit de départ. Cette combinaison réutilise la revue, l'index et le commit Git existants sans provisionner de worktree. La création exige un dossier propre. Le commit vérifie que la branche courante correspond encore à la branche capturée. La différence entre le commit de départ et le `HEAD` courant permet de retrouver l'état validé après un redémarrage. L'archivage, la suppression et le retour au brouillon ne suppriment jamais cette branche ni le dossier du projet.

Le résolveur typé `projectExecutionMode` est la source de vérité commune. Il retourne `git`, `direct`, `blocked` ou `invalid` à partir de l'état observé du projet et du mode persisté de la cible. Un état observé `not_git` ne devient jamais Git par défaut. Une ancienne cible sans `executionMode` suit l'état confirmé du projet. Une cible persistée valide conserve son mode pendant sa tâche, y compris si le projet est ensuite initialisé en Git ou si l'édition directe est désactivée.

Un projet `not_git` peut être marqué `directEdit`. Il est alors modifiable dans Implement et Architect. Les plans enregistrent `executionModesByProjectId` sur leurs nœuds. Un plan mixte provisionne les branches et les worktrees de ses seules cibles Git. Les cibles directes s'exécutent dans le chemin du projet, sans nom de branche ni worktree. Le filtre de capacités retire les outils Git lorsqu'aucune cible Git n'existe et les conserve pour un plan mixte. L'exécuteur vérifie ensuite le `project_id` et le mode de la cible avant tout appel backend.

Les métadonnées d'un plan direct vivent dans `<projet>/.macro` grâce au scope FS `direct`. Ce scope ne résout jamais la branche `@macro`. Si le projet est initialisé en Git après la création du plan, les lectures, les écritures et le transcript de ce plan restent dans ce dossier. Les nouveaux plans Git utilisent le scope metadata habituel. La synchronisation de fin de stream copie toujours le transcript local, puis inspecte `@macro` uniquement pour les cibles dont le mode persisté vaut `git`.

La revue repose sur un dépôt de point de restauration privé stocké dans les données applicatives de Macro. Son worktree pointe vers le dossier du projet, sans y créer de `.git`. Le premier démarrage capture une base ; les commandes natives de revue, validation, dévalidation, restauration et acceptation réutilisent ensuite le modèle de diff existant. Le dépôt privé exclut notamment `.git`, `.macro`, les dépendances, les sorties de build et les secrets usuels. L'identité du point de restauration combine l'identifiant de tâche et le chemin canonique du projet.

Comme le dossier source n'est pas isolé, le backend refuse une deuxième tâche active sur le même projet direct. La fin de tâche passe directement à `Completed` après acceptation des changements, sans workflow de merge ni synchronisation `@macro`. Une cible `blocked` ou `invalid` ne reçoit aucun répertoire de travail et propose de vérifier les réglages du projet. Le runtime distant ne prépare pas ces tâches tant que son contrat d'exécution directe n'est pas pris en charge explicitement.

### 12.8 Objets absents pendant la review

La review conserve libgit2 pour les opérations locales courantes. Si une lecture échoue avec la combinaison exacte `Odb` et `NotFound`, le backend actualise l’ODB, évince le handle `Repository` mis en cache et relance la lecture une seule fois.

Dans un clone partiel déclaré par `extensions.partialClone`, `remote.*.promisor` ou `remote.*.partialCloneFilter`, Macro demande uniquement l’objet connu à Git officiel avec une commande bornée et non interactive. Il actualise ensuite libgit2 avant la relance. Une absence persistante utilise le code stable `GIT_OBJECT_MISSING` et fournit le SHA, l’opération et une sortie Git bornée. Le chemin absolu du profil ou du dépôt n’est pas transmis dans les détails affichés. Ce chemin ne modifie ni le worktree ni l’index et ne lance aucune réparation globale.

Le hard reset natif et WSL refuse toute collision avec un chemin non suivi. Avant de remplacer un fichier suivi, Macro le renomme sans copie dans `<git-common-dir>/macro-hard-reset-recovery/<transaction>/original` et exige que cette récupération soit sur le même système de fichiers que le worktree. Les fichiers créés par le reset puis retirés pendant un rollback vont dans `rollback-target`. Macro conserve une transaction dès qu’elle contient un inode déplacé. Un éditeur qui avait déjà ouvert le fichier peut donc continuer à écrire dans cet inode sans que le reset supprime ces nouvelles données. Le répertoire Git commun conserve cette récupération après la suppression d’un worktree lié. La transaction contient aussi le `HEAD` et l’index d’origine. La publication finale compare l’index brut sous son verrou et avance `HEAD` par comparaison atomique avec sa valeur initiale.

Les projets déclarés `not_git` ne passent jamais par les commandes Git du projet. Le panneau utilise leur checkpoint privé sous `direct-checkpoints`. `ensure` initialise le checkpoint avant la première review. Les rafraîchissements suivants ouvrent directement l'identifiant persisté et vérifient le commit `HEAD`, les arbres, les blobs et l'index dans le snapshot. Cette vérification partage un budget de 256 Mio et de 100 000 objets entre l'historique et l'index. Une cible héritée sans identifiant retrouve d'abord un checkpoint existant lié à la tâche et au chemin, puis persiste cet identifiant avant les rafraîchissements suivants. Si le projet a été déplacé, Macro refuse de dériver une nouvelle base tant que l'identité précédente existe. Les identifiants déjà initialisés gardent aussi un marqueur hors du dépôt interne. Ce marqueur empêche une activation tardive de recréer une base après la suppression du checkpoint. La review actualise puis rouvre ce dépôt interne une seule fois. Une absence persistante devient `DIRECT_CHECKPOINT_MISSING`, `DIRECT_CHECKPOINT_PROJECT_MISMATCH` ou `DIRECT_CHECKPOINT_CORRUPT`, sans hydratation réseau. Macro conserve le checkpoint endommagé. Il ne crée une base que pour un identifiant neuf et sans historique. La capture initiale parcourt au plus 4 096 entrées du système de fichiers. Chaque snapshot direct reçoit aussi un identifiant opaque, conservé dix minutes dans un registre backend borné à 256 entrées. Le registre lie les révisions à la tâche, au chemin canonique du projet, au checkpoint et à une empreinte de son `HEAD` et de son index. Une validation ou une restauration ne peut donc pas ajouter un chemin, réutiliser un snapshot après une mutation du checkpoint ou fournir une empreinte calculée par le frontend. Les commandes refusent plus de 4 096 chemins avant de cloner ou de développer la liste IPC. Le calcul des révisions du worktree lit au plus 256 Mio au total, avec une vérification d'annulation entre les blocs de 64 Kio. Le nettoyage d'une restauration vérifie l'empreinte des sauvegardes et des fichiers publiés. Il ne supprime jamais récursivement une entrée remplacée pendant l'opération.

La vérification recalcule les empreintes des commits, des arbres et des blobs du checkpoint. Les trois types d'objets consomment le même budget de lecture avant leur utilisation par la revue. Les arbres acceptent les répertoires, fichiers ordinaires, exécutables et liens symboliques. L'index complet accepte ces trois types de fichiers. Les modes inconnus sont refusés explicitement ; les sous-modules gardent leur diagnostic de dépôt imbriqué non pris en charge.

`resolveProjectExecutionMode` centralise la décision du panneau droit. Un mode `direct` ou un `checkpointId` persisté reste direct. `gitSetupState: not_git` interdit le chemin Git. Une configuration sans Git qui n’autorise pas l’édition directe bloque la review avec `DIRECT_MODE_CONFIGURATION_REQUIRED`. Les anciens projets chargés sans `gitSetupState` conservent le chemin Git pour compatibilité.

---

## 13. Outils, politiques d'accès et exécution

### 13.1 Politique par mode

Macro applique une politique d'outils différente selon le mode.

L'objectif est de limiter les droits selon le contexte fonctionnel.

Exemples :

- Architect peut manipuler les metadata et certains outils de planification
- Chat reste plus restreint, mais peut recevoir l'outil terminal agentique généraliste
- Implement a accès à davantage d'outils de workspace et Git

### 13.2 Validation d'exécution

Avant exécution d'un outil, Macro peut valider :

- si l'outil est autorisé dans le mode courant
- si le chemin cible est autorisé
- si les restrictions metadata doivent s'appliquer

### 13.3 Exécution de workspace tools

La couche d'exécution d'outils encapsule :

- la résolution du bon workspace
- la différence entre scope normal et scope metadata
- le fallback entre transport Tauri et transport distant

Cette couche unifie l'exécution des outils côté produit.

### 13.4 Révisions de contenu et mutations sûres

Une lecture de fichier expose une `revision` calculée comme le SHA-256 hexadécimal minuscule des octets exacts. Les outils `write`, `edit` et `delete` acceptent cette valeur dans `expected_revision`; `apply_patch` accepte une table `expected_revisions` indexée par chemin relatif normalisé. Une mutation gardée échoue avec le code stable `REVISION_CONFLICT` si le contenu courant ne correspond plus. La valeur spéciale `absent` protège une création contre l'écrasement concurrent d'un fichier nouvellement apparu, et les sections `Add File` l'utilisent automatiquement.

Les patchs multi-fichiers vérifient toutes les préconditions avant la première écriture, puis revalident chaque cible juste avant sa mutation. La mutation, sa relecture de validation et la publication du checkpoint forment une transaction compensable : un échec sur l'une de ces étapes déclenche le rollback des seules mutations déjà appliquées. Le rollback tente toutes les restaurations, même si l'une d'elles rencontre un conflit, puis restitue l'ensemble des erreurs. Avant chaque restauration, il exige que le contenu courant corresponde encore à la révision écrite par Macro, ou que la cible soit toujours absente après une suppression. Une modification externe divergente est préservée et signalée comme conflit de rollback au lieu d'être écrasée. Les checkpoints conservent aussi les révisions afin de protéger leurs restaurations contre une modification externe intervenue après la prévisualisation.

L'historique durable des checkpoints conserve une frontière de compaction `oldestCompleteSequence`. Un replay qui élague des checkpoints sérialise toujours le document versionné complet et ne peut donc pas remettre cette frontière à `null`. Les fichiers sont indexés pendant la préparation du replay par l'identité composite projet, scope, workspace et chemin réel ; deux montages qui utilisent le même chemin relatif restent des cibles distinctes.

Dans un processus Macro, chaque mutation acquiert un verrou associé à la cible canonique avant de valider la révision et le conserve jusqu'à la fin de l'écriture, de la suppression ou du rollback. Les lots multi-fichiers trient et dédupliquent leurs verrous avant acquisition afin d'éviter les interblocages. Les écritures et suppressions natives confinées ouvrent la racine du workspace comme une capacité : lecture de révision, création du temporaire et renommage restent relatifs au même handle, de sorte qu'un parent remplacé simultanément par un symlink ne peut pas rediriger l'effet hors du workspace. Les checkpoints refusent aussi les lots de plus de 64 fichiers ou dont les contenus avant/après dépassent 64 Mio. Lorsqu'un agent omet la révision pour `edit`, `delete` ou une mise à jour/suppression par patch, le fallback frontend réutilise automatiquement la révision observée pendant la préparation afin de conserver la protection optimiste. Le headless lie chaque mutation à un `execution_id` et à l'empreinte exacte de sa requête. Il synchronise un enregistrement `pending` avant de détacher l'effet du cycle HTTP, puis écrit et synchronise un enregistrement `completed` avant de publier le résultat. Le client persiste l'identifiant dans le stockage du webview sous l'identité de l'invocation logique avant l'envoi, borne chaque attente et consulte `/tools/executions/{execution_id}` après une perte de transport ; un second envoi de la même invocation réutilise exactement le même identifiant et le même corps, tandis que deux invocations distinctes au contenu identique restent séparées. Un `pending` retrouvé après redémarrage n'est jamais rejoué : le serveur renvoie un état indéterminé jusqu'à résolution explicite. Le journal réserve au plus quatre résultats simultanés de 80 Mio, reste sous 512 Mio et n'évince que des résultats terminés. Si la persistance du checkpoint côté client échoue, Macro restaure chaque cible en ordre inverse avec la révision après mutation comme garde. La relecture nécessaire aux checkpoints passe par la route authentifiée `/tools/checkpoint-snapshot`, mais la restauration de code lors du replay d'un ancien message reste désactivée hors Tauri tant que son marqueur de reprise n'est pas transportable.

Les remplacements atomiques conservent les bits de permission Unix de la cible. Un nouveau fichier commençant par un shebang reçoit les bits exécutables, conformément au comportement de l'outil `write` d'Oh My Pi. Les checkpoints enregistrent également le mode Unix et le réappliquent lors d'un replay ou d'une compensation ; une restauration ne doit donc pas transformer silencieusement un script exécutable en fichier ordinaire. Sous WSL, cette garantie est appliquée au fichier temporaire avant la dernière validation de révision et le renommage.

Les chemins d'une racine virtuelle multi-projets sont toujours relatifs à un montage : les chemins absolus, préfixes de lecteur et composants parents `..` sont rejetés avant la sélection du projet. L'accès natif revalide ensuite la cible canonique avec `allow_outside_workspace=false`. Sous WSL, une vérification `realpath` du workspace et de la cible empêche aussi un lien symbolique interne de rediriger une lecture ou une mutation hors du projet.

L'état d'une mutation headless est interrogeable par `execution_id` via
`/tools/executions/{execution_id}` dans ce protocole. Cette capacité existe
pour l'invocation distante suivie par `remoteKernelApi` ; l'identifiant n'est
pas relié au `ToolTrace` SQLite et aucune interrogation générale des outils
desktop, MCP ou terminaux n'est déduite de `recovery_state`. Une intention
distante encore `pending` après redémarrage reste indéterminée.

### 13.5 Sorties bornées et reprise

Les outils de lecture du workspace et d'inspection Git ne peuvent pas injecter une sortie arbitrairement grande dans le contexte agent. Leur contrat est additif : les réponses structurées paginables ajoutent `limit`, `offset`, `truncated` et `next_cursor`. `list`, `glob` et `git_status` ajoutent aussi `total_count`, car leur résultat est complètement matérialisé avant pagination. `grep` et `git_log` exposent `total_count=null` avec `total_is_exact=false` lorsqu'ils s'arrêtent après avoir trouvé l'élément qui prouve qu'une page suivante existe.

Les limites partagées sont les suivantes :

- `read` : 500 lignes par défaut, 3 000 au maximum, 256 Kio de contenu par page et 2 000 caractères par ligne ;
- `list` : 200 entrées par défaut, 1 000 au maximum ;
- `glob` : 200 chemins par défaut, 1 000 au maximum ;
- `grep` : 50 correspondances par défaut, 200 au maximum et 512 caractères par ligne de résultat ;
- `git_status` : 200 changements par défaut, 1 000 au maximum ;
- `git_log` : 50 commits par défaut, 200 au maximum ;
- `git_diff` : 256 Kio de patch au maximum et 64 lignes de contexte par hunk.

Les lectures ont aussi une durée maximale : 5 secondes pour `list`, `read` et `glob`, 30 secondes pour `grep` et `ast_grep`. Le frontend associe un identifiant opaque à chaque exécution interruptible. Sur desktop, l'annulation d'une génération déclenche une commande Tauri dédiée qui réveille le travail enregistré et l'abandonne avec le code stable `TOOL_EXECUTION_CANCELLED`; une tombstone courte et bornée conserve aussi une annulation arrivée juste avant l'enregistrement de l'exécution. L'expiration utilise `TOOL_EXECUTION_TIMEOUT`. La recherche structurelle propage en plus un jeton coopératif jusque dans son worker bloquant et vérifie ce jeton entre les étapes de parcours ; un parse individuel reste borné par la limite de 4 Mio par fichier. Le transport distant combine le même `AbortSignal` avec une échéance propre à l'outil, et le fallback TypeScript vérifie l'annulation et l'échéance entre ses opérations asynchrones et pendant ses boucles longues.

L'annulation active reste volontairement limitée aux outils de lecture `list`, `read`, `glob`, `grep` et `ast_grep`. Macro n'interrompt pas une mutation de fichier ou de dépôt au milieu de son application : leur cohérence repose sur les préconditions de révision, les écritures atomiques et les rollbacks décrits plus haut.

`git_diff` accepte les modes `patch`, `stat` et `name_only`. Le mode patch utilise un collecteur tête-fin borné : une troncature conserve les premiers 75 % et les derniers 25 % de la capacité, insère un marqueur avec le nombre exact d'octets omis et devient une erreur si `require_complete=true`. Sous WSL, stdout et stderr sont drainés en continu dans des collecteurs bornés ; la limite s'applique donc à la mémoire capturée pendant l'exécution et pas seulement à la chaîne renvoyée. Les vues de synthèse doivent être privilégiées avant un patch portant sur une modification large.

`grep` ignore les fichiers binaires et les fichiers de plus de 4 Mio, puis rend ces omissions visibles dans `skipped_files`. Le pont Copilot relaie `list`, `read`, `glob`, `grep`, `ast_grep`, `write`, `edit`, `delete` et `apply_patch` au frontend. Ce relais transmet les arguments originaux à l'exécuteur commun afin de conserver les montages de la racine virtuelle, le projet focalisé, l'annulation, les checkpoints et la politique d'approbation. Les mutations Git suivent le même relais ; seules les inspections Git en lecture seule utilisent directement le tool host natif confiné. L'approbation technique du custom tool par le SDK Copilot autorise uniquement l'appel du handler : toute décision utilisateur nécessaire reste prise par la frontière frontend avant l'exécution. `read_file` est également relayé afin de pouvoir relire les pièces jointes et les sorties `tool-output://` avec leurs arguments de pagination brute.

`web_fetch` suit la même frontière frontend afin que la politique de sécurité Macro décide avant toute requête. Sur desktop, la récupération passe ensuite par une commande Rust dédiée : chaque hôte est résolu avant connexion, toutes ses adresses doivent être publiques, l'adresse retenue est épinglée dans le client HTTP, les redirections automatiques sont désactivées et chaque destination est résolue puis revalidée. Les hôtes locaux, privés, réservés et link-local, les URL avec identifiants, les types de contenu inattendus, les réponses trop volumineuses et plus de cinq redirections sont refusés. Le service échoue fermé hors du transport desktop sécurisé au lieu d'utiliser un fetch direct incapable de garantir ces propriétés. Les favicons traversent la même commande avec une limite plus faible.

Sous WSL, l'énumération récursive utilise une profondeur de 8 par défaut, borne toute profondeur explicite à 32 et s'arrête avant d'accumuler plus de 20 000 entrées. Si une arborescence dépasse cette limite de sécurité, l'opération échoue explicitement et demande de réduire le chemin ou la profondeur au lieu d'annoncer un total ou un scan complet erroné. Les enregistrements utilisent des champs séparés par NUL pour conserver les tabulations et retours à la ligne des noms. Le filtrage des fichiers cachés exclut aussi leurs descendants. Le champ `is_readonly` suit le contrat des permissions Unix natives : il vaut vrai lorsqu'aucun bit d'écriture propriétaire, groupe ou autres n'est présent ; il ne représente pas une évaluation des ACL.

La recherche de noms classe les candidats de chaque montage avant de limiter les résultats. Le parcours natif refuse explicitement un montage dépassant 20 000 entrées inspectées ; WSL utilise l'énumération bornée commune. La lecture native confinée ouvre le fichier via une capacité du workspace et utilise ce même descripteur pour les métadonnées et le flux borné. La classification repose sur les octets lus : les sources SVG UTF-8 restent textuelles et les contenus non UTF-8 sont omis comme binaires par la recherche.

Le curseur opaque suit actuellement le format interne `v1:<empreinte>:<offset>`. L'empreinte FNV-1a lie le curseur aux paramètres sémantiques de la requête ; elle sert à détecter une réutilisation accidentelle et n'est pas une primitive de sécurité. Un curseur de `read` inclut aussi la révision SHA-256 du fichier, celui de `git_status` une révision de l'ensemble ordonné des changements, celui de `git_log` le commit de tête résolu avec les indicateurs staged/unstaged qui déterminent ses pseudo-commits, et celui de `git_branch_list` une empreinte stable des références locales et distantes ainsi que de la branche courante. Si l'une de ces sources change entre deux pages, la reprise échoue et l'agent doit recommencer sans curseur. Les arbres de fichiers peuvent encore changer entre deux pages de `list`, `glob` ou `grep`; leur pagination reste déterministe pour un instantané logique inchangé, sans verrouiller le système de fichiers ni le dépôt.

Le backend Tauri, le fallback TypeScript et les racines virtuelles multi-projets appliquent ce contrat Git ; le pont Copilot conserve son périmètre d'outils pris en charge. Un noyau distant doit annoncer `bounded_tool_output_v1` pour `list`, `read`, `glob` et `grep`, puis `bounded_git_output_v1` pour `git_status`, `git_log`, `git_branch_list`, `git_diff` et `git_get_tree`. Macro refuse l'exécution distante si la capacité propre à la famille d'outils manque, avant qu'une sortie non bornée puisse atteindre le contexte.

Les commandes agent `terminal_run` conservent au maximum 1 Mio de sortie dans un collecteur partagé par stdout et stderr, dans l'ordre d'arrivée des blocs. Après dépassement, le résultat garde une tête de 64 Kio et la fin la plus récente, avec le nombre exact d'octets omis entre les deux. Après la fin ou l'arrêt du processus, le drainage des pipes est limité à 2 secondes ; une sortie résiduelle est abandonnée avec un marqueur explicite plutôt que de bloquer la génération indéfiniment.

Une annulation de génération appelle `terminal_kill` avec l'identifiant unique de l'exécution concernée. Le backend mémorise cette demande même si elle précède l'enregistrement de la commande, empêche deux exécutions simultanées dans une session et termine le groupe de processus complet. Une génération monotone empêche aussi la finalisation tardive d'une annulation d'écraser l'état d'une commande suivante. Un garde de durée de vie détruit le groupe si la future Rust est abandonnée avant son nettoyage normal. Les sessions interactives visibles utilisent leur propre cycle de vie et ne sont pas concernées par ce protocole agent.

La frontière frontend qui remet les résultats d'outils au flux applique une défense commune inspirée des artefacts de session d'Oh My Pi. Au-delà de 50 Kio, Macro persiste le texte complet comme citation fichier de portée conversation, sous une adresse stable `tool-output://<conversation>/<appel>.txt`, puis attend la confirmation durable avant de publier cette adresse. Le contexte ne reçoit ensuite qu'une tête et une fin de 20 Kio avec le nombre d'octets omis. Si la persistance échoue ou si le runtime ne peut pas la garantir, l'aperçu reste borné, signale que le contenu complet est indisponible et n'annonce aucune adresse de récupération.

`read_file` utilise le même contrat de pagination que `read` pour les contenus joints : empreinte de contenu liée au curseur, lignes numérotées, limite de 500 lignes par défaut, plafond de 3 000 lignes et 256 Kio de contenu avant l'enveloppe commune de spill. Son mode `raw=true` pagine au maximum 40 Kio d'octets UTF-8 sans couper de point de code afin que chaque réponse complète reste sous le seuil commun de 50 Kio ; il sert notamment à relire exactement une sortie `tool-output://` composée d'une seule ligne longue.

`ast_grep` s'appuie directement sur `ast-grep-core` et `ast-grep-language` dans le backend Rust, sans dépendre d'un binaire installé sur la machine. Les 28 parseurs intégrés couvrent les principaux langages de Macro. Une recherche est en lecture seule, limitée à 30 secondes, 16 Kio par motif, 4 Mio par fichier, 2 Kio par extrait, 512 octets par capture, 32 captures et 4 Kio de captures cumulées par correspondance, puis 200 correspondances par page. Toute capture tronquée le signale dans la correspondance. Le curseur est lié au motif, à la portée, au langage et aux options ; les kernels distants doivent annoncer `structural_search_v1`. Le frontend conserve la même politique d'observation, d'annulation et de racine virtuelle que `grep`. En mode Architect, cette lecture reste volontairement attachée aux sources du projet ; la portée metadata est réservée aux mutations `Macro/...`, afin que l'architecte puisse analyser le code qu'il planifie sans confondre les deux arbres.

### 13.6 Terminal agentique indépendant des projets

Les quatre appels techniques `terminal_create_session`, `terminal_run`, `terminal_read` et `terminal_kill` forment l'outil terminal agentique et partagent un seul interrupteur visible. Ce terminal ne passe pas par l'exécuteur de workspace et son schéma n'expose aucun `project_id`. Le frontend crée toujours ses sessions avec `project_id: null`; son répertoire initial est le dossier personnel ou tout répertoire existant demandé. Une session rattachée à un projet par le terminal manuel de l'application est refusée par l'outil agentique.

Dans chaque mode qui expose l'outil, `toolSecurityPolicy` force chaque `terminal_run` à demander une approbation avant l'exécution, quel que soit le niveau de risque, y compris YOLO et Strict. Cette décision précède l'évaluation habituelle du niveau de risque, ignore les autorisations mémorisées et désactive l'action qui autorise des appels similaires pour toute la conversation. La création, la lecture et l'arrêt d'une session agentique restent des opérations d'observation. Le bridge Copilot relaie les quatre appels au frontend afin qu'ils traversent le même contrôle. Le tool host natif refuse explicitement les appels terminal directs, car ce chemin ne possède pas de mécanisme de review utilisateur.

Le terminal manuel reste un sous-système distinct et peut conserver un rattachement à la tâche, au projet et au worktree pour la navigation de l'interface.

### 13.7 Instructions `AGENTS.md` des dépôts

`projectExecutionContext` reste la source de vérité de la portée projet. Le
store de chat transmet ses `projectIds` et ses
`workspacePathsByProjectId` à `repositoryInstructions`. Le service ne recrée
pas la sélection Architect, Implement ou Chat. Un worktree d'exécution déjà
résolu devient la racine de lecture du projet concerné.

La commande Tauri `repository_instructions_load` effectue la découverte et la
lecture. Son contrat accepte une racine et un `scopePath` optionnel par projet.
Elle parcourt les dossiers de la racine vers ce périmètre, charge uniquement
`AGENTS.md`, puis renvoie les sources dans leur ordre de priorité. Le store ne
fournit pas encore de `scopePath`, car Macro ne possède pas de sous-dossier
actif fiable dans le contrat de conversation. Le comportement courant charge
donc la racine de chaque projet sans inventer de répertoire courant.

Le backend ouvre d'abord la racine avec `cap-std`, la canonicalise puis vérifie
que le handle et le chemin canonique désignent le même dossier. Il abandonne si
la racine change pendant cette préparation. Il canonicalise ensuite le périmètre
et chaque source, puis ouvre chaque fichier relativement au handle validé. Le
chemin ne peut donc pas sortir du projet entre le contrôle et la lecture. La
déduplication reste propre à chaque projet et ignore la casse dans sa clé
canonique sous Windows. Les limites sont
de 16 fichiers et 64 Kio par chargement. Les plafonds natifs empêchent le
frontend de demander plus de 32 fichiers ou 256 Kio. Le backend ouvre chaque
source une fois et borne la lecture au budget restant plus un octet. Cet octet
sert uniquement à détecter un dépassement sans charger le reste du fichier. Un
fichier rejeté consomme les budgets de fichiers inspectés et d'octets lus. La
frontière IPC refuse plus de 32 projets avant de construire le tableau en
mémoire. La commande parcourt au plus 256 dossiers par projet et conserve au
plus 64 problèmes pendant la découverte, dont un signal de troncature.
Les tailles des identifiants, noms et chemins sont contrôlées pendant la
désérialisation. Le chargeur consomme tout projet excédentaire sans construire
son objet. Il arrête aussi la construction de la chaîne d'ancêtres dès la limite
de profondeur. Enfin, il compare l'identité de chaque handle de fichier à celle
de la source canonique avant la lecture et abandonne la source si elle a changé.

Le contexte du dernier message utilisateur encode chaque source comme une
entrée JSON avec l'identité du projet, le chemin canonique, le chemin relatif,
la profondeur et le contenu. Les instructions de dépôt restent donc sous le
rôle système dans la hiérarchie du provider. Une règle système contrôlée par
Macro rappelle leur niveau de confiance sans reprendre leur contenu. Le texte
enveloppe marque les entrées comme contexte de dépôt non fiable. Il interdit le
remplacement des règles système, la modification de la politique Macro,
l'augmentation des permissions et le transfert d'une règle à un autre projet.
Si le backend renvoie une limite atteinte ou une erreur, l'enveloppe marque le
chargement comme partiel et liste les projets et chemins concernés. Les
diagnostics conservent ces problèmes avec les métadonnées des sources chargées.
Le bloc sérialisé ne dépasse pas 512 Kio. En cas de dépassement, Macro omet
toutes les entrées et signale un chargement partiel. Avant de sérialiser, Macro
calcule une borne haute de l'encodage JSON, échappements compris. Le frontend ne
construit donc jamais un bloc complet susceptible de dépasser cette limite. Le calcul de l'empreinte
inclut le contenu envoyé dans le dernier tour utilisateur. Macro ne persiste pas
ce bloc dans les éléments provider du message. Chaque tour le reconstruit depuis
les fichiers présents et la portée projet courante.

---

## 14. Skills

### 14.1 Rôle

Les skills sont une couche de contexte agent distincte de MCP.

Une skill fournit des instructions réutilisables à l'agent. Elle ne crée pas de nouveaux outils arbitraires. Les outils externes restent portés par MCP et par la politique d'outils Macro.

### 14.2 Format local

La version locale supporte des dossiers contenant :

- `SKILL.md` prioritaire, avec `skill.md` accepté en mode compatibilité
- frontmatter YAML AgentSkills avec `name`, `description`, `license`, `compatibility`, `allowed-tools` et `metadata`
- dossiers optionnels `references/`, `assets/` et `scripts/`

Les sources supportées en 0.1 sont :

- `.agents/skills`, `.codex/skills`, `.opencode/skills`, `.opencode/skill` et `.claude/skills` dans les projets visibles par Macro
- `~/.agents/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.config/opencode/skill`, `~/.opencode/skills`, `~/.opencode/skill` et `~/.claude/skills` pour les skills utilisateur globales

La découverte ignore les dossiers cachés internes, `.git`, `node_modules`, les racines symlinkées et applique des limites de profondeur et de volume. La validation sépare `isValid` (chargeable par Macro) de `specCompliant` (strict AgentSkills) et expose les diagnostics au frontend.

Le validateur suit la logique `skills-ref` pour les noms : comparaison après normalisation Unicode NFKC, lettres/chiffres Unicode acceptés avec tirets, et lowercase Unicode. Les écarts d'usage courants (uppercase, underscores, tirets en début/fin, doubles tirets, mismatch dossier) restent des warnings lenient tant que la skill est chargeable. Tout champ de frontmatter hors `name`, `description`, `license`, `compatibility`, `metadata` et `allowed-tools` génère le diagnostic `unexpected_frontmatter_field`.

Les collisions sont résolues de façon déterministe : projet avant global, puis namespace `.agents`, `.codex`, `.opencode`, `.claude`, puis chemin lexical stable. La skill gagnante est la seule exposée au catalogue agent et à la résolution `$skill-name`. Les skills shadowed restent listées dans Settings et peuvent être chargées par sélection explicite/id exact.

### 14.3 Chargement progressif

Le chargement doit rester progressif :

- au bootstrap, Macro ne charge que le manifeste compact
- dans le prompt, Macro injecte seulement le catalogue des skills activées, chargeables et non-shadowed
- le corps body-only de `SKILL.md` est chargé via `skill_activate` dans un bloc `<skill_content ...>` structuré
- les fichiers de `references/` et `assets/` sont lus via `skill_read_resource`
- les scripts de `scripts/` sont exécutés via `skill_run_script`

`skill_activate` liste les ressources et scripts mais ne les lit pas. Les activations sont dédupliquées par conversation et rechargées seulement si le hash de contenu change. Les outils `skill_*` ne sont enregistrés auprès du modèle que lorsqu'une skill activée et chargeable existe; `skill_run_script` exige en plus une skill trusted avec scripts activés et un niveau de risque compatible.

Les préférences d'activation sont persistées comme préférences Macro côté client, pas dans les dossiers de skills.

### 14.4 Sécurité

Les skills découvertes sont désactivées par défaut.

L'exécution de scripts exige :

- skill activée
- skill marquée comme trusted
- scripts activés pour cette skill
- passage par la politique d'approbation d'outils à risque

Le backend bloque les chemins hors skill, les traversals, les fichiers cachés non autorisés et les symlinks sortants. Les scripts s'exécutent sans secrets injectés par défaut, avec timeout, sortie tronquée et répertoire temporaire par défaut.

`allowed-tools` est exposé comme metadata informative. Il ne modifie jamais la politique d'outils Macro, les modes, les approvals ou le niveau de risque.

### 14.5 Fondation de transport remote (expérimentale)

Cette couche reste interne et hors du contrat produit 0.1. Les détails ci-dessous documentent le prototype existant, pas un mode sélectionnable dans l'application.

Les DTO de skills sont transport-neutres. Le manifeste conserve les champs historiques locaux (`rootPath`, `skillFilePath`) pour compatibilité UI/cache quand ils existent, mais ils sont optionnels. La source principale est une `location` opaque (`local`, `remote` ou `bundled`) que les clients doivent privilégier quand le runtime n'est pas local. La déduplication utilise `contentHash`, puis `location.uri` comme fallback stable.

Le provider remote expose les opérations équivalentes `list`, `get`, `readResource` et `runScript` via HTTP (`POST /skills/list`, `POST /skills/get`, `POST /skills/read-resource`, `POST /skills/run-script`, sous le préfixe workspace quand applicable). Les payloads frontend sont en camelCase et le backend remote doit rester tolérant. Un kernel distant peut fournir des skills projet, utilisateur ou registry sans filesystem local. S'il ne supporte pas encore cette surface, il doit répondre `unsupported` ou 404/405/501; l'UI présente alors que le runtime courant ne supporte pas la capacité précise.

Les capabilities remote distinguent `skills` et `skillScripts`. `skills=true` permet `skill_activate` et `skill_read_resource`; `skillScripts=true` est requis en plus des réglages trusted/scripts et de la politique Macro pour proposer `skill_run_script`. Par défaut, le profil remote minimal a `skills=false` et `skillScripts=false`. Le bootstrap peut annoncer les capacités effectivement disponibles.

La surface complète reste supportée par le desktop local via Tauri IPC.

---

## 15. Streaming IA et orchestration conversationnelle

### 15.1 Chat streaming

`streamingChat.ts` conserve la façade publique, les estimateurs synchrones et
l'annulation. Au premier envoi, il charge `streamingChatExecution.ts`, qui
choisit le transport et conserve la boucle existante. Avant cette attente,
la façade capture les options, les callbacks et le mode de raisonnement résolu
(y compris son absence), puis réserve les ressources dans le registre unique
`streamResources`. L'annulation interrompt cette attente même sans signal
fourni par l'appelant ; un chargement tardif ne lance aucun transport. Un échec
de chargement est évincé du cache pour permettre une nouvelle tentative.

Le même objet de ressources accompagne tous les tours natifs ou HTTP d'un
envoi. Deux appels non annulés d'une même session peuvent s'exécuter, mais seul
le plus récent occupe la clé du registre. Un ancien appel ne réinscrit jamais
sa clé et ne nettoie jamais les ressources de son successeur. Les callbacks de
compatibilité fournisseur sont injectés par la façade ; l'exécution différée
ne relit pas le store pour choisir le mode de raisonnement. Les
types métier purs sont dans `services/ai/contracts.ts`. `toolCallingLoop.ts`
possède les tours, le rejeu, le compactage inter-tours, le steering, les limites
et les interruptions. `nativeAdapter.ts` et `chatCompletionsAdapter.ts` lui
fournissent un tour et sa projection dans le format du fournisseur. Les codecs
Responses, Chat Completions et Copilot gardent leurs représentations propres.

`toolCallRunner.ts` applique la validation Macro, l'allowlist et l'ordre du lot
séquentiel, puis délègue les effets au callback métier du Chat. Une chaîne vide
est un résultat explicite. Le repli historique `read_file` conserve l'identifiant
de l'appel et accepte le résultat structuré de `read`. Les replis web partagent
`fallbackTools.ts` et le signal de la tentative. Les demandes vivantes Copilot
réutilisent la validation et la normalisation sans attendre la fin du stream.
Le lot séquentiel refuse les questionnaires multiples ; le relais vivant
accepte le premier, puis refuse les suivants.

`streamAccumulator.ts` garde l'ordre d'insertion des traces et leur contexte
visible/caché. La priorité des statuts protégés vient de `toolTraceState.ts`.
L'approbation, la persistance et l'identité de tentative restent aux modules
Chat. Chaque transport nettoie ses propres ressources, y compris les listeners
acquis après un échec partiel, sans toucher à celles d'une requête suivante.

Les DTO IA communs sont définis dans `src-tauri/src/ai/types.rs`, avec le chemin
ChatGPT historique réexporté. Les contrats du processus Copilot sont dans
`ai/copilot/protocol.rs`. Le payload `tool_result` réellement sérialisé fournit
le type du décodeur bridge via le générateur Config/IPC commun. Le décodeur
vérifie encore les valeurs et les deux identifiants à l'exécution. Le bridge
conserve `is_error` et `error_kind` jusqu'au résultat SDK, où un refus devient
`denied` et une erreur devient `failure`. Une panne du canal rejette l'appel.
`bun run typecheck:copilot` vérifie tous ses modules avec le SDK installé ; les
efforts de raisonnement hors de son contrat sont refusés explicitement.
Le catalogue Copilot exclut les outils `config_*`, `skill_*`, `task_artifact_*`
et `task_todo_*`, dont le bridge ne possède pas de gestionnaire. Les outils
internes remis au SDK sont l’intersection du catalogue fourni dans `request.tools`,
de l’allowlist et des routes prises en charge. Leurs schémas filtrés sont conservés,
sans reconstruction depuis le registre statique. La liste `availableTools` et
l’approbation technique du SDK utilisent cette même intersection ; la politique
frontend continue de décider des autorisations d’exécution.

Les profils de capacités techniques suivent le type de fournisseur configuré,
comme le dispatch natif. L'identifiant sert de repli quand ce type est absent ;
l'URL OpenCode ne spécialise qu'un transport OpenAI compatible. Une matrice de
fixtures partagée vérifie cette précédence en TypeScript et Rust. Ces capacités
n'accordent aucun droit d'outil et restent distinctes des profils de protocole
de raisonnement et des capacités capturées du tour Chat.

Les transports conservent la cause de fin fournie par le modèle. Une fin par
limite de sortie devient `length`, y compris quand Responses la signale par
`response.incomplete` avec `max_output_tokens`. `streamingChat` tente alors une
seule continuation dans la session et le tour courants. Cette requête ne publie
aucun outil, demande uniquement le suffixe manquant et retire un éventuel
chevauchement textuel. Une seconde réponse incomplète reste persistée comme
telle et place le tour en erreur au lieu de déclencher les effets d'une fin
normale. Les motifs de filtrage et les motifs inconnus restent explicites dans
le transcript, y compris après rechargement, et ne déclenchent pas les effets
d’une fin normale.

L’arrêt d’un tour transmet son signal aux outils `web_search` et `web_fetch`,
y compris les lectures de favicon. Chaque appel natif annulable porte un
identifiant d’exécution ; la commande d’annulation interrompt l’attente réseau
et la lecture du corps. Le registre conserve temporairement les annulations
reçues avant le démarrage de la commande.

### 15.2 Couplage avec les plans

En mode Architect, la synchronisation de fin de tour attend la réussite de
l’écriture finale du message. Elle conserve le plan, la branche et la
conversation capturés à l’envoi ou au rejeu. Le service vérifie encore
l’association plan/conversation avant de remplacer le transcript. Un changement
de sélection ne redirige pas cette écriture vers un autre plan.

La scission d’une conversation partagée attribue de nouveaux identifiants aux
messages copiés et vérifie leurs rôles et contenus avant d’associer la copie au
plan. La réconciliation compare aussi les contenus lorsque les identifiants
sont inchangés ; elle n’enregistre pas de stamp après un échec de synchronisation.
Les validations de plan et restaurations de sélection IA vérifient leur contexte
avant d’appliquer un résultat asynchrone à la sélection visible.

### 15.3 Couplage avec le mode Implement

En mode Implement, le chat sert aussi de couche d'interaction pour :

- les clarifications de tâche
- les questions de l'IA
- le kickoff d'exécution

Le chat n'est donc pas seulement un canal textuel, mais une couche d'orchestration utilisateur.

### 15.4 Sous-agents

Les sous-agents sont des exécutions enfants rattachées à une conversation parente. Ils ne sont pas des tâches Macro supplémentaires et ne créent pas de worktree dans leur première version.

Le socle est séparé en quatre couches :

- `subagentPolicy` calcule les permissions effectives par intersection, construit un contexte explicite et applique les limites de profondeur, de concurrence et de budget ;
- `subagentRuntime` gère la file par conversation, les transitions, le timeout et l'annulation autour d'un `ChildTurnExecutor` injecté ;
- la table SQLite `agent_runs` conserve le cycle de vie durable, la filiation, les résultats, les erreurs et la consommation ;
- `conversationGoalAudit` spécialise ces contrats pour produire et valider un verdict structuré du profil `goal_auditor`.

La première politique est volontairement restrictive : enfants en lecture seule, profondeur maximale de un et aucune délégation agent-visible. Un verdict de goal n'est appliqué que si l'identifiant et la révision attendue sont encore courants.

Le transport fournisseur et l'adaptateur IPC de `agent_runs` restent des ports explicites. Tant qu'ils ne sont pas raccordés, le coordinateur `goal_auditor` est exécutable avec un transport injecté et un journal mémoire, mais sa durabilité n'est pas complète de bout en bout.

---

## 16. Fondation expérimentale : backend distant et kernel headless

Cette section documente du code exploratoire interne. Ce code n'est pas exposé comme mode produit, n'est pas supporté en 0.1 et ne constitue pas un engagement de compatibilité.

Trois surfaces doivent rester distinguées :

- le **tool host desktop**, démarré par `lib.rs`, sert uniquement des intégrations locales de confiance comme le pont Copilot sur un port éphémère de `127.0.0.1` ;
- le **kernel headless expérimental**, démarré par l'exemple `macro-headless`, porte le prototype d'API HTTP décrit ci-dessous ;
- le **transport frontend remote** est un adaptateur interne et incomplet vers une API headless compatible. Sa sélection par variable Vite ne l'intègre pas au contrat produit.

Le tool host et le kernel headless partagent le contrat de validation du bearer token afin d'éviter une dérive de leur authentification, mais restent deux serveurs, deux cycles de vie et deux surfaces HTTP distincts.

Les builds de débogage peuvent aussi démarrer le bridge navigateur vendored `tauri-remote-ui`. Ce bridge reste local et interne. Son arrêt signale les connexions déjà acceptées, envoie une fermeture WebSocket, puis attend leurs tâches dans un délai borné. Un démarrage qui échoue après l'ouverture du listener compense les ressources déjà créées avant de renvoyer l'erreur.

### 16.1 Rôle du kernel headless

Le prototype de kernel headless est une version sans GUI du backend Macro.

Il explore la possibilité pour un futur client Macro distant de :

- récupérer l'état du workspace
- récupérer les tâches
- interroger les politiques d'outils
- exécuter certains outils
- consulter l'état Git

### 16.2 Exposition HTTP

Le kernel headless expose une API HTTP basée sur axum.

Cette API couvre au minimum :

- `GET /health`
- `GET /v1/tools/mode-policy?mode=<mode>&projectId=<project-id>`
- `POST /v1/tools/validate`
- `POST /v1/tools/execute`
- `GET /api/v1/tools/mode-policy?mode=<mode>&projectId=<project-id>`
- `POST /api/v1/tools/validate`
- `POST /api/v1/tools/execute`
- `GET /api/v1/workspace/bootstrap`
- `GET /api/v1/workspaces/{workspace_id}/bootstrap`
- `GET /api/v1/workspace/tasks`
- `GET /api/v1/workspaces/{workspace_id}/tasks`
- `GET /api/v1/projects/{project_id}/git/tree`
- `GET /api/v1/projects/{project_id}/git/commits`
- `POST /api/v1/workspaces/{workspace_id}/skills/list`
- `POST /api/v1/workspaces/{workspace_id}/skills/get`
- `POST /api/v1/workspaces/{workspace_id}/skills/read-resource`
- `POST /api/v1/workspaces/{workspace_id}/skills/run-script`

Pour les routes préfixées par `/workspaces/{workspace_id}`, `workspace_id` désigne un identifiant de projet enregistré dans les métadonnées du workspace principal. Le kernel résout cet identifiant dans son registre autoritaire, puis exécute la commande avec le chemin canonique correspondant. Un identifiant vide ou inconnu est refusé sans fallback vers le workspace principal.

Cette surface HTTP est une fondation expérimentale incomplète. Elle ne fait pas partie de la surface produit 0.1 et ne remplace aucune commande IPC desktop.

Les capabilities runtime séparent les skills en deux niveaux : `skills` pour la découverte, l'activation et la lecture de ressources ; `skillScripts` pour l'exécution de scripts. Un provider remote peut supporter les manifests et ressources sans autoriser les scripts cloud.

### 16.3 Protection expérimentale

Le kernel headless peut être protégé par un bearer token. Le token est facultatif uniquement sur une adresse loopback et obligatoire sur toute autre adresse. Lorsqu'il est configuré, il protège aussi `/health`. Sans token sur loopback, `/health` est public comme le reste du prototype local. Sa politique n'est évaluée que pour les projets réellement touchés après routage : une cible explicite utilise son projet, un patch utilise l'union de ses cibles et une recherche globale conserve l'intersection de tous les montages parcourus. Le registre serveur conserve le chemin canonique et l'état de lecture seule de chaque projet ; un client ne peut pas déclarer un montage plus permissif et toute mutation d'un projet autoritairement en lecture seule est refusée. `web_fetch` et les outils terminal restent retirés de la politique tant que le transport headless ne possède pas leurs exécuteurs confinés, approuvables et annulables.

Les patches de configuration headless sont toujours attribués à une source agent. L’acceptation ou le rejet d’un changement sensible exige un second bearer défini par `MACRO_HEADLESS_APPROVAL_TOKEN`, différent de `MACRO_HEADLESS_BEARER_TOKEN`. Ce second secret représente une décision utilisateur ponctuelle et n’est jamais remplacé par le bearer agent. Les décisions de politique d’outils sont fermées par défaut : elles exigent un projet chargé et une exécution multi-projet doit être autorisée par chaque projet affecté.

Le tool host desktop est toujours limité à `127.0.0.1`, génère un token éphémère et exige ce token pour tous ses endpoints d'outils. Son endpoint `/health` reste volontairement public : il n'expose qu'un état de vie non sensible et ne doit pas devenir accessible hors localhost.

Ces bearer tokens protègent uniquement leurs surfaces HTTP internes. Ils n'impliquent aucun compte applicatif, aucune session utilisateur Macro et aucun abonnement.

### 16.4 Position architecturale

Si cette exploration devient un jour une capacité produit, elle pourrait servir de base à :

- l'exécution distante
- la continuité entre plusieurs clients
- la supervision mobile future
- les offres éventuelles d'hébergement dédié

---

## 17. Configuration

### 17.1 Configuration frontend

Le frontend dépend notamment de variables d'environnement pour :

- choisir le provider de données
- choisir le transport backend
- configurer l'accès au backend distant

### 17.2 Configuration backend

Le backend Rust charge une configuration runtime pour :

- le chemin du workspace
- le chemin de la base SQLite
- les options de runtime

### 17.3 Configuration utilisateur

Les préférences utilisateur sont réparties entre :

- persistance locale frontend
- settings backend
- configurations providers et modèles
- configurations des fournisseurs vocaux
- règles de workflow Git et d'automatisation
- préférences de skills activées, trusted et scripts

Les clés API de reconnaissance vocale sont conservées dans le stockage natif des
secrets sous un namespace dédié. SQLite ne stocke qu'un booléen indiquant qu'une
clé est présente. La suppression ou la modification d'un fournisseur sérialise
les mutations et compense les écritures partielles entre SQLite et le stockage
de secrets.
### 17.4 Provider géré Andrologic

Le provider `macro-ai`, affiché sous le nom Andrologic, est créé par le backend
et ne peut pas être modifié ou supprimé depuis l'interface. Au premier démarrage,
le backend Tauri génère une
identité d'installation aléatoire, appelle le service d'activation Macro AI,
puis conserve le jeton propre à cette installation dans le stockage local des
secrets. Aucun jeton maître d'inférence n'est intégré à l'exécutable.

Le service expose un unique modèle public `macro-ai`. Le nom du modèle réel et
le routage vLLM restent internes à la passerelle. Pour chaque requête Macro AI,
le backend ajoute l'identifiant local de conversation ; la passerelle peut
ainsi rapprocher les tours, les métriques de tokens et les erreurs sans exposer
d'endpoint d'administration public.

La passerelle journalise le contenu envoyé, la réponse reconstruite et les
métriques d'usage. Cette collecte ne concerne que le provider Andrologic et
doit rester signalée dans l'interface. Les autres providers conservent leur
propre politique de données.

---

## 18. Principes de séparation entre documents

Le présent document doit décrire :

- comment Macro est construit
- quelles couches existent
- comment elles communiquent
- où les données vivent

Le présent document ne doit pas décrire en détail :

- la philosophie produit générale
- les workflows utilisateur comme contrat principal
- les priorités de développement

Ces sujets appartiennent respectivement à :

- `docs/functional-spec.md`
- `docs/roadmap.md`

---

## 19. Règles de maintenance du document

Ce document doit être mis à jour lorsque :

- une couche architecturale change
- un transport ou un flux de données change
- une responsabilité système change de place
- un mécanisme de persistance ou de sync change

Ce document ne doit pas être mis à jour pour :

- des ajustements purement visuels
- des détails d'UX sans impact d'architecture
- des idées produit non encore traduites en architecture cible

## 20. Durées de vie des ressources frontend

`LifecycleContext` exprime la validité d'un consommateur ; il ne remplace ni
l'identité d'un tour Chat, ni les versions de mutation et identifiants de requête.
`createLifecycleScope` révoque le contexte avant de libérer les ressources. Un
handle acquis après cette révocation est libéré immédiatement, une seule fois.
`track` et `drain` attendent les opérations déjà admises : arrêter un consommateur
ne constitue pas un retour arrière d'une écriture durable.

- **Application et bootstrap.** `applicationStartup`, consommé par `main.tsx`,
  possède le pipeline de restauration, la configuration et les compositions.
  Une génération HMR retirée ne peut ni lancer l'étape suivante, ni installer
  les effets de configuration, ni rendre une application ou un écran de reprise.
  La génération suivante attend le drainage de la précédente. Les ports Plans
  restent installés jusqu'à la fin des opérations admises. Le bootstrap possède
  son ordonnanceur différé et ses abonnements Task/Chat ; son redémarrage révoque
  d'abord l'ancien contexte et attend ses effets avant de réhydrater.
- **Sessions de domaine.** Les conversations, tâches et plans restent possédés
  par leurs stores et runtimes. Monter ou retirer un panneau ne termine pas un
  tour Chat ni une opération de métadonnées. Les captures immuables de Chat et
  les leases et journaux des mutations gardent leur rôle. Une saga admise finit
  son unité durable avant que son consommateur constate le retrait.
- **Vues et opérations.** Les lectures du pied de page capturent la cible Git et
  la génération de vue ; changer de cible permet une nouvelle lecture sans
  attendre l'ancienne et sans recevoir son résultat. La dictée conserve son
  identité d'opération après chaque préparation asynchrone de l'audio et avant
  l'envoi au fournisseur. La fin d'une ancienne dictée ne réinitialise pas celle
  du contexte suivant. Les nettoyages existants des fenêtres et de CodeMirror
  restent en place, ainsi que la barrière globale de fermeture de page.
- **Terminaux.** La composition injecte un port de rendu typé dans le store,
  sans import du rendu depuis le store. Les fermetures locales et événements
  natifs passent par une finalisation commune. Les réponses tardives ne peuvent
  pas recréer un onglet fermé. L'arrêt frontend libère les listeners, timers,
  observers et ressources xterm et attend les appels admis, sans fermer les PTY
  natifs. Le détachement d'une vue conserve au plus six rendus détachés ; il
  n'introduit aucune expiration de session native.
  La composition d'entrée installe un port léger. Le renderer et xterm restent
  chargés avec le panneau Terminal ; le premier attachement acquiert ce port.
  Après l'arrêt de l'application, un attachement tardif est refusé avant toute
  création xterm. Le nettoyage d'un onglet non rendu ne charge pas le renderer.
- **Caches.** L'identité de la requête protège les publications des caches Plans
  et panneaux après invalidation. Le registre des projets possède l'éviction
  ciblée des caches Git frontend lorsqu'un projet disparaît ou change de chemin.
  Ces règles décrivent la propriété des données ; elles ne constituent pas une
  mesure de fuite mémoire ni une nouvelle politique de TTL.

Cette frontière frontend ne rend pas annulable un IPC natif déjà envoyé.

Le watcher de fichiers de `src-tauri/src/fs/watcher.rs` possède son propre arrêt,
distinct du watcher de configuration. Il révoque la publication, abandonne les
événements de debounce en attente, puis attend la tâche et la destruction du
callback natif. `Drop` révoque aussi la publication et demande l'arrêt de la tâche.
La sortie acceptée de l'application attend ce nettoyage pendant au plus deux
secondes ; une demande de fermeture encore annulable ne l'engage pas. Le délai
expiré produit un avertissement et laisse le nettoyage continuer tant que le
processus vit. Il ne constitue pas une preuve de fin du nettoyage natif.

Les opérations natives Terminal possèdent un verrou par identifiant d'onglet.
La reconnexion le conserve de la lecture persistée à l'installation du PTY ; la
fermeture le conserve jusqu'à la suppression durable. Une fermeture révoque les
sauvegardes différées et attend celles déjà admises. Son intention `closed` est
persistée avant la terminaison du processus. Si la suppression échoue, une
nouvelle fermeture peut la reprendre et la reconnexion reste refusée, y compris
après redémarrage lorsque cette intention a été persistée. Une écriture initiale
échouée ne garantit pas la conservation de l'intention après crash. Le fence en
mémoire reste détenu jusqu'à la reprise ; les propriétaires ordinaires sont
retirés du registre lorsqu'ils ne servent plus. EOF retire le droit de sauvegarde
du runtime et persiste son état final sous le même verrou de persistance.
Une tâche différée de ce runtime ne peut donc pas remplacer la session reconnectée,
même si son compteur de révision est plus récent. Les événements et DTO actifs
vérifient aussi ce propriétaire au moment de leur publication. Une commande déjà
envoyée continue son effet natif ; un retour après retrait signale la session
retirée sans annoncer une annulation ou une remise en état. Une terminaison ou
une persistance initiale échouée conserve le propriétaire natif pour une nouvelle
tentative de fermeture. Les protections `Drop` du PTY et
les annulations par identifiant d'exécution restent indépendantes.
Les lecteurs natifs présentent les propriétaires conservés pour nettoyage comme
des onglets `closed` inactifs. Ils restent visibles après rechargement, y compris
pour une préparation de worktree, afin de reprendre le nettoyage avec le bouton
de fermeture existant. Leur synchronisation de métadonnées est suspendue. Un
`closed` persisté sans propriétaire natif est omis de la liste et refusé en lecture.
À EOF, la révocation précède l'événement de déconnexion et l'attente du verrou
de persistance ; la sauvegarde finale et les sorties déjà admises sont conservées.

Le cache Git natif appartient à `GitState`, partagé par les opérations. Ses
handles restent utilisables par une opération admise après leur retrait du cache.
`invalidate_repo_if_same` retire seulement le handle attendu du chemin canonique,
sans retirer un remplacement ou un autre dépôt. Les racines metadata en cache
sont revalidées avant réutilisation et retirées après nettoyage du projet. Cette
propriété native ne fait pas dépendre un handle Git du montage d'un panneau et
n'ajoute ni TTL ni affirmation de fuite mesurée.
