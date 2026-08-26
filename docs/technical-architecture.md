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
- préservation d'un historique de travail auditable via la persistence locale et la branche metadata

Macro doit pouvoir fonctionner dans trois topologies techniques :

- desktop local avec backend Tauri embarqué
- client desktop connecté à un kernel distant
- client web/mobile connecté à un kernel distant

---

## 3. Couches principales

### 3.1 Couche interface

La couche interface est composée du frontend React dans `src/`.

Elle est responsable de :
- l'affichage des modes et des panneaux
- la gestion des interactions utilisateur
- la visualisation des plans, tâches, diffs et états
- la configuration des providers, outils et préférences

Le frontend ne doit pas contenir la logique bas niveau du système de fichiers, de Git ou de la persistence native.

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

### 5.5 Lazy loading

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
- le streaming
- les pièces jointes image
- les références de contexte du composeur
- la relation entre mode actif et conversation sélectionnée

Le store porte aussi une partie de la logique d'orchestration entre chat et mode produit.

### 6.3 `useTaskStore`

`useTaskStore` gère :

- les tâches dérivées de la stratégie
- leur activation
- leurs transitions d'état
- la relation entre tâche, branche et worktree
- la persistance du statut d'exécution dans les metadata du plan

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

### 7.3 Contrats et DTO

Les DTO frontend servent de couche de stabilisation entre :

- les types UI
- les retours des providers
- les transports backend

Cette couche limite le couplage direct entre composants React et détails de sérialisation.

### 7.4 Boucle d'outils et compatibilité des providers

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
et conserve les sept fichiers les plus récents.

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

### 9.3 `db`

Le module `db` porte :

- l'initialisation SQLite
- les migrations
- les modèles et repositories
- les commandes de persistence de conversations, messages, providers et contextes locaux

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
- la persistence du fichier `workspace.json`
- les opérations de création, import, renommage, archivage et fermeture de projets

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

### 10.2 Persistance locale frontend

Le frontend utilise aussi de la persistence locale légère pour :

- certaines préférences
- le fournisseur vocal actif, la langue et la durée maximale de dictée
- les sélections de modèle par contexte
- l'état de session local
- certains fallback de plans
- des données temporaires de pièces jointes

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

### 12.5 Branche `@macro`

La branche `@macro` sert de branche metadata dédiée.

Elle est synchronisée separatement du code métier.

Le système doit pouvoir :

- s'assurer de son existence
- connaitre son état de divergence
- committer les metadata si nécessaire
- push et pull cette branche

### 12.6 Sync metadata

La sync metadata est gérée comme une couche distincte de la sync du code.

Cette séparation permet :

- de ne pas mélanger l'historique produit avec l'historique source classique
- d'exposer un état clair dans l'interface
- de gérer les conflits metadata de façon explicite

### 12.7 Exécution directe sans dépôt Git

Un projet `not_git` peut être marqué `directEdit`. Il est alors modifiable dans Implement, mais reste non actionnable dans Architect. Les tâches directes s'exécutent dans le chemin du projet, sans provisionnement de branche ou de worktree, et le filtre de capacités retire tous les outils Git du runtime agent.

La revue repose sur un dépôt de point de restauration privé stocké dans les données applicatives de Macro. Son worktree pointe vers le dossier du projet, sans y créer de `.git`. Le premier démarrage capture une base ; les commandes natives de revue, validation, dévalidation, restauration et acceptation réutilisent ensuite le modèle de diff existant. Le dépôt privé exclut notamment `.git`, `.macro`, les dépendances, les sorties de build et les secrets usuels. L'identité du point de restauration combine l'identifiant de tâche et le chemin canonique du projet.

Comme le dossier source n'est pas isolé, le backend refuse une deuxième tâche active sur le même projet direct. La fin de tâche passe directement à `Completed` après acceptation des changements, sans workflow de merge ni synchronisation `@macro`.

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

Sous WSL, l'énumération récursive utilise une profondeur de 8 par défaut, borne toute profondeur explicite à 32 et s'arrête avant d'accumuler plus de 20 000 entrées. Si une arborescence dépasse cette limite de sécurité, l'opération échoue explicitement et demande de réduire le chemin ou la profondeur au lieu d'annoncer un total ou un scan complet erroné.

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

Les capabilities remote distinguent `skills` et `skillScripts`. `skills=true` permet `skill_activate` et `skill_read_resource`; `skillScripts=true` est requis en plus des réglages trusted/scripts et de la politique Macro pour proposer `skill_run_script`. Par défaut, le profil remote minimal a `skills=true` et `skillScripts=false`.

La surface complète reste supportée par le desktop local via Tauri IPC.

---

## 15. Streaming IA et orchestration conversationnelle

### 15.1 Chat streaming

Le streaming des réponses IA est géré côté frontend par un service dédié.

Cette couche s'occupe de :

- envoyer le contexte conversationnel
- recevoir les tokens ou chunks
- mettre à jour la conversation en cours
- annuler un stream si nécessaire

### 15.2 Couplage avec les plans

En mode Architect, certaines actions conversationnelles déclenchent une sync metadata à la fin du stream.

L'objectif est d'ancrer les changements de plan dans la branche metadata de façon régulière.

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

- persistence locale frontend
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
