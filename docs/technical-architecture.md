# Macro - Architecture Technique

## 1. Objet du document

Ce document decrit l'architecture technique de reference de Macro.

Il couvre :
- les couches principales de l'application
- les responsabilites de chaque couche
- les flux de donnees entre frontend, runtime desktop et backend distant
- la persistance locale et metadata
- les mecanismes techniques relies aux workflows du produit

Ce document n'est pas une roadmap et n'est pas une specification fonctionnelle.

La cible fonctionnelle du produit est definie dans `docs/functional-spec.md`.
Les evolutions a venir et les ecarts avec l'etat courant relevent de `docs/roadmap.md`.

---

## 2. Vue d'ensemble

Macro est une application desktop construite autour d'un frontend React TypeScript et d'un backend Rust embarque via Tauri.

L'architecture repose sur quatre principes :

- local-first par defaut
- separation stricte entre surface produit et details d'implementation
- transport interchangeable entre backend desktop et backend distant
- preservation d'un historique de travail auditable via la persistence locale et la branche metadata

Macro doit pouvoir fonctionner dans trois topologies techniques :

- desktop local avec backend Tauri embarque
- desktop local avec simulation ou provider mock pour certaines phases de developpement
- client desktop connecte a un kernel distant

---

## 3. Couches principales

### 3.1 Couche interface

La couche interface est composee du frontend React dans `src/`.

Elle est responsable de :
- l'affichage des modes et des panneaux
- la gestion des interactions utilisateur
- la visualisation des plans, taches, diffs et etats
- la configuration des providers, outils et preferences

Le frontend ne doit pas contenir la logique bas niveau du systeme de fichiers, de Git ou de la persistence native.

### 3.2 Couche etat client

La couche etat client est principalement basee sur Zustand.

Elle est responsable de :
- l'etat global de l'application
- les contextes de projet, plan et conversation
- l'etat des taches, changements de fichiers et outils
- la synchronisation des preferences locales cote client

Les stores centralisent les decisions d'orchestration cote interface.

### 3.3 Couche services frontend

La couche services frontend encapsule les acces aux sources de donnees et aux outils.

Elle fournit :
- une abstraction de provider (`mock`, `ipc`, `remote`)
- des services specialises pour les plans, le git flow architecte, la sync metadata, le streaming chat, le contexte projet et l'execution d'outils

Elle a pour role d'isoler le reste de l'interface des details du transport.

### 3.4 Couche runtime desktop

Le runtime desktop est fourni par Tauri.

Il sert de pont entre :
- le frontend web embarque
- les commandes natives Rust
- les plugins natifs Tauri

Cette couche permet l'acces natif a :
- la fenetre desktop
- les dialogues systeme
- le store natif
- le reseau natif
- les commandes IPC exposees par le backend Rust

### 3.5 Couche backend Rust

Le backend Rust est contenu dans `src-tauri/`.

Il fournit les capacites natives suivantes :
- base de donnees SQLite
- acces systeme de fichiers
- integration Git
- gestion du workspace
- validation de politique d'outils
- execution d'outils de workspace
- providers IA cote backend
- kernel headless HTTP pour l'execution distante

---

## 4. Stack technique

### 4.1 Frontend

Le frontend utilise principalement :

- React 19
- TypeScript
- Vite
- Zustand
- Lexical pour l'editeur de composition
- CodeMirror pour l'affichage et l'edition de code
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
- axum pour le kernel headless
- reqwest pour les providers IA distants

### 4.3 Transports

Macro supporte deux transports logiques cote application :

- `desktop`
- `remote`

Le transport `desktop` passe par Tauri IPC.
Le transport `remote` passe par HTTP vers un kernel distant.

---

## 5. Architecture frontend

### 5.1 Organisation

Le frontend est organise autour de :

- `components/` pour les surfaces UI
- `stores/` pour l'etat global
- `services/` pour la logique d'acces et d'orchestration
- `hooks/` pour les comportements transverses
- `types/` pour les types applicatifs

### 5.2 Routage fonctionnel par mode

L'application n'utilise pas un routage classique base sur des pages.

Le coeur de l'interface repose sur un routage par mode qui affecte les panneaux gauche, centre et droit selon le contexte actif.

Cette responsabilite est concentree dans le routeur de mode.

### 5.3 Decoupage des panneaux

L'interface est structuree autour de :

- un header
- un footer
- un panneau gauche contextuel
- une zone centrale partagee
- un panneau droit contextuel

Le centre reste principalement occupe par la conversation et la coordination du travail.

### 5.4 Initialisation

Le frontend initialise ses stores par priorites afin de reduire le cout de demarrage percu.

L'initialisation se fait en plusieurs niveaux :

- bootstrap critique de l'application
- session utilisateur et contexte
- donnees coeur comme chat et taches
- configuration et providers en basse priorite

### 5.5 Lazy loading

L'application charge paresseusement :

- les composants associes aux modes
- plusieurs modales non critiques

Le but est de limiter le cout du bundle initial et d'accelerer l'affichage du shell applicatif.

---

## 6. Stores et orchestration client

### 6.1 `useAppStore`

`useAppStore` est le store pivot du frontend.

Il gere notamment :

- le mode actif
- la selection du groupe et du projet
- le plan courant
- les plan nodes et predicted branches
- les panneaux, modales et preferences globales
- l'etat de sync metadata
- le changement de contexte projet

### 6.2 `useChatStore`

`useChatStore` gere :

- les conversations
- les messages
- le streaming
- les pieces jointes image
- les references de contexte du composeur
- la relation entre mode actif et conversation selectionnee

Le store porte aussi une partie de la logique d'orchestration entre chat et mode produit.

### 6.3 `useTaskStore`

`useTaskStore` gere :

- les taches derivees de la strategie
- leur activation
- leurs transitions d'etat
- la relation entre tache, branche et worktree
- la persistance du statut d'execution dans les metadata du plan

### 6.4 Stores specialises

D'autres stores portent des responsabilites ciblees :

- `useNeedsStore` pour les besoins
- `useGitStore` pour arbres et commits Git
- `useFileChangesStore` pour la review de changements
- `useProviderStore` pour les providers et modeles IA
- `useToolsStore` pour les outils internes et MCP
- `useAuthStore` pour les futurs usages lies au compte

### 6.5 Principe d'orchestration

Le frontend ne doit pas dupliquer les decisions metier dans plusieurs composants.

La logique transverse doit etre concentree dans :

- les stores
- les services
- quelques hooks d'orchestration

Les composants doivent surtout afficher, recueillir des intentions utilisateur et appeler les actions prevues.

---

## 7. Couche services frontend

### 7.1 Abstraction provider

La couche `services/index.ts` selectionne dynamiquement le provider de donnees selon :

- le provider cible (`mock` ou `ipc`)
- le transport cible (`desktop` ou `remote`)
- la disponibilite effective du runtime Tauri

Cette abstraction permet :

- de travailler sur un frontend simule
- d'utiliser Tauri en mode desktop
- de parler a un backend distant sans reecrire le reste de l'application

### 7.2 Services de domaine

Les services frontend sont specialises par sujet.

Exemples principaux :

- `architectPlanService`
- `architectGitFlowService`
- `macroSyncService`
- `streamingChat`
- `workspaceToolExecutor`
- `remoteKernelApi`
- `toolModePolicy`
- `projectExecutionContext`

### 7.3 Contrats et DTO

Les DTO frontend servent de couche de stabilisation entre :

- les types UI
- les retours des providers
- les transports backend

Cette couche limite le couplage direct entre composants React et details de serialisation.

---

## 8. Runtime desktop et IPC

### 8.1 Role de Tauri

Tauri sert de runtime desktop et d'interface native.

Il heberge :

- la fenetre applicative
- les plugins systeme
- le frontend web
- le registre de commandes IPC Rust

### 8.2 Commandes IPC

Le backend expose de nombreuses commandes Tauri, regroupees par domaine :

- base de donnees
- workspace
- outils
- systeme de fichiers
- Git

Ces commandes sont centralisees dans le point d'entree du backend.

### 8.3 Plugins natifs utilises

Le runtime embarque des plugins Tauri pour :

- l'ouverture de ressources externes
- les requetes HTTP
- les dialogues systeme
- le stockage natif

---

## 9. Architecture backend Rust

### 9.1 Modules principaux

Le backend Rust est organise en modules de domaine.

Les blocs principaux sont :

- `core/`
- `db/`
- `fs/`
- `git/`
- `workspace/`
- `commands/`
- `ai/`
- `index/`

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
- les modeles et repositories
- les commandes de persistence de conversations, messages, providers et contextes locaux

### 9.4 `fs`

Le module `fs` porte :

- la lecture et l'ecriture de fichiers
- la validation des chemins
- le support du watcher de fichiers
- la resolution speciale du workspace metadata

### 9.5 `git`

Le module `git` porte :

- l'ouverture et la validation des depots
- les commandes de status, log, branches, diff, push, pull, merge
- la gestion des worktrees
- la branche metadata `@macro`

### 9.6 `workspace`

Le module `workspace` porte :

- le bootstrap du workspace
- la liste des groupes et projets
- la persistence du fichier `workspace.json`
- les operations de creation, import, renommage, archivage et fermeture de projets

### 9.7 `ai`

Le module `ai` porte :

- l'abstraction provider cote backend
- les implementations OpenAI, Anthropic et local

Cette couche est encore partiellement utilisee selon les flux, mais fait partie de l'architecture cible.

### 9.8 `index`

Le module `index` prepare la couche d'indexation et de recherche.

Il existe dans l'architecture, meme si son usage produit n'est pas encore completement active.

---

## 10. Persistance

### 10.1 Persistance locale SQLite

SQLite est la base locale principale.

Elle stocke notamment :

- conversations
- messages
- settings
- cache local de workspace
- jobs d'index
- references de depots Git et worktrees

### 10.2 Persistance locale frontend

Le frontend utilise aussi de la persistence locale legere pour :

- certaines preferences
- les selections de modele par contexte
- l'etat de session local
- certains fallback de plans
- des donnees temporaires de pieces jointes

### 10.3 Metadata dans la branche `@macro`

L'historique structure de Macro est conserve dans une branche metadata dediee.

Cette branche contient notamment :

- `workspace.json`
- les index de plans
- les plans serialises
- les rendus Markdown de plans
- les fichiers `planned.md`
- les fichiers `executed.md`

Le stockage metadata dans Git permet l'audit, la redondance et la conservation de l'historique de travail.

---

## 11. Modele metadata et plans

### 11.1 Structure des plans

Les plans sont stockes dans une structure de type :

- `branches/<target-branch>/plans/index.json`
- `branches/<target-branch>/plans/<plan-id>/plan.json`
- `branches/<target-branch>/plans/<plan-id>/plan.md`
- `branches/<target-branch>/plans/<plan-id>/tasks/<task-id>/planned.md`
- `branches/<target-branch>/plans/<plan-id>/tasks/<task-id>/executed.md`

### 11.2 Raison de cette structure

Cette structure sert a :

- conserver une representation machine des plans
- conserver une representation lisible par humain
- permettre une auditabilite fine tache par tache
- rendre la metadata consultable meme hors de l'application

### 11.3 Relation avec le frontend

Le frontend lit, ecrit et synchronise cette structure via :

- les services de planification
- les commandes FS avec scope metadata
- les commandes Git de sync `@macro`

---

## 12. Git, branches et worktrees

### 12.1 Principes

L'architecture Git de Macro repose sur trois niveaux principaux :

- branche de base de developpement
- branches d'integration de plan
- branches de feature ou d'execution

### 12.2 Branches de plan

Pour le travail planifie, Macro utilise une branche d'integration dediee au plan.

Cette branche sert de point de convergence avant le merge final vers la branche de base.

### 12.3 Branches de feature

Les taches de la strategie peuvent etre reparties sur plusieurs branches de feature rattachees au plan afin de :

- maximiser le parallelisme
- conserver des lots de travail plus petits
- limiter les changements trop larges

### 12.4 Worktrees

Les worktrees permettent d'isoler l'execution par branche ou par tache.

Ils sont utilises pour :

- eviter de tout faire dans un seul arbre de travail
- permettre plusieurs executions en parallele
- conserver une separation nette entre contextes d'execution

### 12.5 Branche `@macro`

La branche `@macro` sert de branche metadata dediee.

Elle est synchronisee separatement du code metier.

Le systeme doit pouvoir :

- s'assurer de son existence
- connaitre son etat de divergence
- committer les metadata si necessaire
- push et pull cette branche

### 12.6 Sync metadata

La sync metadata est geree comme une couche distincte de la sync du code.

Cette separation permet :

- de ne pas melanger l'historique produit avec l'historique source classique
- d'exposer un etat clair dans l'interface
- de gerer les conflits metadata de facon explicite

---

## 13. Outils, politiques d'acces et execution

### 13.1 Politique par mode

Macro applique une politique d'outils differente selon le mode.

L'objectif est de limiter les droits selon le contexte fonctionnel.

Exemples :

- Architect peut manipuler les metadata et certains outils de planification
- Chat reste plus restreint
- Implement a acces a davantage d'outils de workspace et Git

### 13.2 Validation d'execution

Avant execution d'un outil, Macro peut valider :

- si l'outil est autorise dans le mode courant
- si le chemin cible est autorise
- si les restrictions metadata doivent s'appliquer

### 13.3 Execution de workspace tools

La couche d'execution d'outils encapsule :

- la resolution du bon workspace
- la difference entre scope normal et scope metadata
- le fallback entre transport Tauri et transport distant

Cette couche unifie l'execution des outils cote produit.

---

## 14. Streaming IA et orchestration conversationnelle

### 14.1 Chat streaming

Le streaming des reponses IA est gere cote frontend par un service dedie.

Cette couche s'occupe de :

- envoyer le contexte conversationnel
- recevoir les tokens ou chunks
- mettre a jour la conversation en cours
- annuler un stream si necessaire

### 14.2 Couplage avec les plans

En mode Architect, certaines actions conversationnelles declenchent une sync metadata a la fin du stream.

L'objectif est d'ancrer les changements de plan dans la branche metadata de facon reguliere.

### 14.3 Couplage avec le mode Implement

En mode Implement, le chat sert aussi de couche d'interaction pour :

- les clarifications de tache
- les questions de l'IA
- le kickoff d'execution

Le chat n'est donc pas seulement un canal textuel, mais une couche d'orchestration utilisateur.

---

## 15. Backend distant et kernel headless

### 15.1 Role du kernel headless

Le kernel headless est la version sans GUI du backend Macro.

Il doit permettre a un client Macro distant de :

- recuperer l'etat du workspace
- recuperer les taches
- interroger les politiques d'outils
- executer certains outils
- consulter l'etat Git

### 15.2 Exposition HTTP

Le kernel headless expose une API HTTP basee sur axum.

Cette API couvre au minimum :

- healthcheck
- tool mode policy
- validation d'outil
- execution d'outil
- bootstrap workspace
- liste des taches
- arbre Git par projet
- historique Git par projet

### 15.3 Authentification

Le kernel headless peut etre protege par un bearer token.

Cette securisation est la base du modele de connexion distante, meme si le modele complet de compte et d'abonnement depasse l'etat courant du code.

### 15.4 Position architecturale

Le kernel headless n'est pas un service annexe.

Il constitue la base de :

- l'execution distante
- la continuite entre plusieurs clients
- la supervision mobile future
- les offres eventuelles d'hebergement dedie

---

## 16. Configuration

### 16.1 Configuration frontend

Le frontend depend notamment de variables d'environnement pour :

- choisir le provider de donnees
- choisir le transport backend
- configurer l'acces au backend distant

### 16.2 Configuration backend

Le backend Rust charge une configuration runtime pour :

- le chemin du workspace
- le chemin de la base SQLite
- les options de runtime

### 16.3 Configuration utilisateur

Les preferences utilisateur sont reparties entre :

- persistence locale frontend
- settings backend
- configurations providers et modeles
- regles de git flow et d'automatisation

---

## 17. Principes de separation entre documents

Le present document doit decrire :

- comment Macro est construit
- quelles couches existent
- comment elles communiquent
- ou les donnees vivent

Le present document ne doit pas decrire en detail :

- la philosophie produit generale
- les workflows utilisateur comme contrat principal
- les priorites de developpement

Ces sujets appartiennent respectivement a :

- `docs/functional-spec.md`
- `docs/roadmap.md`

---

## 18. Regles de maintenance du document

Ce document doit etre mis a jour lorsque :

- une couche architecturale change
- un transport ou un flux de donnees change
- une responsabilite systeme change de place
- un mecanisme de persistance ou de sync change

Ce document ne doit pas etre mis a jour pour :

- des ajustements purement visuels
- des details d'UX sans impact d'architecture
- des idees produit non encore traduites en architecture cible
