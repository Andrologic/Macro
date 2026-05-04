# Macro - Roadmap

## 1. Objet du document

Ce document decrit la trajectoire de livraison de Macro.

Il sert a :
- identifier les ecarts entre la cible produit et l'etat actuel
- prioriser les chantiers
- definir un ordre de livraison coherent
- servir de support de pilotage produit et technique

La cible fonctionnelle est definie dans `docs/functional-spec.md`.
L'architecture technique de reference est definie dans `docs/technical-architecture.md`.

---

## 2. Regle de lecture

Cette roadmap est organisee en trois niveaux :

- ecarts constates ou probables entre la cible et l'etat actuel
- chantiers prioritaires
- sequence de livraison recommandee

Elle doit rester vivante.
Un chantier livre doit etre retire ou marque comme termine.
Un ecart devenu obsolete doit etre supprime.

---

## 3. Etat actuel synthetique

L'application dispose deja d'une base solide :

- shell desktop React + Tauri fonctionnel
- modes `Architect`, `Implement`, `Chat` deja presents
- gestion de plans cote Architect deja avancee
- pipeline Git et metadata deja bien amorce
- taches, review et commit deja presents cote Implement
- socle desktop `Architect -> Implement -> Review -> Commit -> validation finale de plan` maintenant stabilise
- catalogue de taches `Implement` maintenant capable d'agreger plusieurs plans executables et plusieurs branches cibles cote desktop
- filtres par plan et prise en charge des taches hors plan maintenant presents dans la file de taches
- resumes de plans `Implement` maintenant fiables pour les filtres et la validation quand plusieurs plans vivants coexistent
- review Implement multi-depots maintenant explicite dans la file et dans la review, avec progression depot par depot et completion unifiee de la tache
- lifecycle des plans maintenant robuste sur le socle desktop local-first
- sync `@macro` maintenant structuree avec etats exploitables, actions explicites et erreurs remontees proprement
- merge conflicts pilotes par Macro maintenant detectes, bloques en fail-closed et traites via un workflow assiste de resolution et reprise
- couches de services, stores et IPC deja structurees
- kernel headless deja present en premiere version

En revanche, le produit cible n'est pas encore atteint sur plusieurs axes critiques :

- experience Implement encore partiellement inachevee
- automatisation et orchestration encore a fiabiliser
- notifications et supervision distante non finalisees
- articulation desktop / remote / mobile encore incomplete
- experience multi-plan et multi-projet encore a consolider de bout en bout
- documents de reference maintenant reconstitues autour d'un socle unique et d'une archive minimale non normative

---

## 4. Ecarts principaux par domaine

### 4.1 Cadrage produit et documentation

Etat attendu :
- un socle documentaire court, propre et non redondant
- une specification fonctionnelle de reference
- une architecture technique de reference
- une roadmap exploitable

Etat a consolider :
- le socle documentaire actif est maintenant recentre sur `functional-spec.md`, `technical-architecture.md` et `roadmap.md`
- l'archive documentaire a ete reduite a un historique minimal non normatif
- les nouveaux documents constituent maintenant l'unique source de verite

### 4.2 Mode Architect

Etat attendu :
- creation et gestion fluide de plusieurs plans
- conversation, besoins et strategie bien lies a chaque plan
- structuration predictive fiable
- validation automatique propre vers branches et worktrees

Etat a consolider :
- cleanup complet des structures lorsque des plans sont supprimes ou abandonnes
- robustesse multi-plans paralleles
- lisibilite du mode Architect quand plusieurs plans coexistent

### 4.3 Mode Implement

Etat attendu :
- file de taches claire, filtrable et fiable
- demarrage manuel des taches clair et fiable
- questions IA rapides a traiter
- review de fin de tache ergonomique
- commits et integration bien verrouilles

Etat deja consolide :
- derivation et agregation de taches depuis plusieurs plans executables cote desktop
- catalogue/backend de listing des taches maintenant decouple du seul plan actif et d'une seule branche cible
- filtrage de la file par plan
- resumes de plans maintenant coherents pour les filtres et la validation quand plusieurs plans vivent en parallele
- support des taches hors plan dans la file et dans le cycle de completion
- meilleur rattachement des taches multi-projets au projet courant
- review multi-depots cote Implement maintenant lisible dans la file et dans la review
- navigation explicite depot par depot, commits distincts par depot et completion de tache unifiee
- verrouillage des etats fantomes entre review, commit par depot et completion finale

Etat a consolider :
- UX de la review et de l'edition ciblee
- questions IA a reponses rapides reellement branchees
- articulation claire entre review de tache, commit, validation finale de plan et merge
- comportement global du mode quand plusieurs plans et plusieurs projets sont actifs en meme temps

### 4.4 Review et edition ciblee

Etat attendu :
- review principalement en lecture
- possibilite d'ajuster rapidement les modifications de l'IA
- chargement progressif de contexte puis du fichier complet si besoin

Etat a consolider :
- surface d'edition exacte
- experience de correction manuelle dans les diffs
- ergonomie de validation du code apres retouche

### 4.5 Git, plans et metadata

Etat attendu :
- workflow Git stable autour des plans, branches de feature, branche de base et `@macro`
- worktrees fiables
- metadata auditables et synchronisables
- conflicts metadata et merge conflicts techniques traites proprement

Etat deja consolide :
- finalisation, suppression logique et cleanup des plans maintenant preflightes et rejouables
- cleanup fiable des branches et worktrees de plan et de tache
- sync `@macro` maintenant exposee comme `clean / pending / failed / conflict` avec diagnostics structures
- actions explicites `commit / pull / push` pour `@macro` maintenant disponibles cote UI/store
- erreurs de divergence, remote manquant, upstream manquant, auth absente, reseau et conflit maintenant mieux remontees
- duplication coherente de la metadata de plan sur chaque depot implique pour les plans multi-projets
- lecture, restauration, archivage, suppression et sync metadata des plans multi-projets maintenant decouplees d'un `projectId` unique
- divergence entre copies metadata d'un meme plan maintenant detectee en fail-closed avec reparation explicite
- merge conflicts de finalisation de plan et de sync `@macro` maintenant detectes avant mutation avec diagnostic par depot, aide IA et reprise explicite

Etat a consolider :
- la phase coeur Git/metadata n'a plus de blocage critique cote desktop local-first
- les prochains gains structurants sur ce domaine passent surtout par l'experience multi-projet premium cote Implement et review

### 4.6 Multi-projet

Etat attendu :
- groupes de projets natifs
- execution coherente sur plusieurs depots
- vision partagee du contexte
- commits distincts par projet mais validation fonctionnelle unifiee

Etat deja consolide :
- review Implement multi-depots maintenant explicite dans les parcours quotidiens
- progression et prochaine action attendue maintenant visibles pour les taches multi-projets actives
- commits par depot maintenant mieux exposes sans perdre la completion unifiee de la tache
- catalogue Implement maintenant global a l'echelle du contexte desktop local-first, avec coexistence coherente de plusieurs plans vivants et des taches hors plan

Etat a consolider :
- lisibilite UX du multi-projet
- gestion de bout en bout des taches qui touchent plusieurs projets
- clarte globale des filtres, de la review et de la navigation

### 4.7 Mode Chat

Etat attendu :
- mode simple, leger, local
- historique conversationnel local
- pieces jointes par conversation
- outils web et MCP configurables

Etat a consolider :
- simplification assumee du mode
- separation nette avec le mode Implement
- politique d'outils clairement exposee a l'utilisateur

### 4.8 Notifications et supervision distante

Etat attendu :
- notifications desktop
- notifications mobiles
- demandes d'attention claires
- reponses rapides depuis mobile

Etat a consolider :
- systeme de notification encore absent ou incomplet
- protocole d'echange entre execution et client mobile
- definition de la supervision distante comme experience produit complete

### 4.9 Kernel distant

Etat attendu :
- execution continue sans GUI
- reprise entre desktop, laptop et mobile
- acces distant stable au workspace et aux outils
- base pour les offres serveur dedie ou heberge

Etat a consolider :
- enrichissement de l'API headless
- securisation et session utilisateur
- orchestration d'execution longue duree
- articulation produit entre machine locale, serveur personnel et infrastructure hebergee

### 4.10 Comptes et abonnement

Etat attendu :
- authentification utilisateur
- liaison avec mobile
- synchronisation de certaines preferences
- eventuels modes d'abonnement

Etat a consolider :
- fonctionnalite encore a introduire reellement dans le produit
- frontieres entre coeur local-first et services comptes a formaliser

---

## 5. Chantiers prioritaires

### 5.1 Priorite 1 - Stabiliser le coeur desktop

Objectif :
- rendre l'experience desktop suffisamment robuste pour servir de base produit

Chantiers :
- finir la boucle Architect -> Implement -> Review -> Commit -> Validation de plan
- durcir le workflow Git de plan
- fiabiliser les transitions de taches
- finaliser l'UX de review et d'edition ciblee
- stabiliser la lisibilite du multi-plan cote Implement dans la review et la finalisation

### 5.2 Priorite 2 - Rendre le multi-projet reellement premium

Objectif :
- faire du multi-projet une vraie force du produit plutot qu'une capacite partielle

Chantiers :
- clarifier la structure groupe / projet / plan / tache
- fiabiliser les taches multi-projets
- garantir la qualite des commits par projet
- ameliorer navigation, filtres et lisibilite de contexte
- mieux articuler finalisation de plan, review et navigation quand plusieurs plans restent actifs en parallele

### 5.3 Priorite 3 - Fiabiliser l'autonomie assistee

Objectif :
- rendre l'IA capable d'avancer longtemps sans degrader la qualite de supervision

Chantiers :
- demarrage manuel des taches bien borne
- questions IA a choix rapides
- gestion claire des points de blocage
- execution test/build observable et interpretable

### 5.4 Priorite 4 - Introduire la supervision distante

Objectif :
- permettre la poursuite du travail hors du poste principal

Chantiers :
- notifications desktop d'abord
- socle de supervision mobile ensuite
- protocoles de questions/reponses a distance
- review et validation a distance

### 5.5 Priorite 5 - Industrialiser le kernel distant

Objectif :
- transformer le kernel headless en brique produit stable

Chantiers :
- enrichir l'API headless
- fiabiliser l'execution distante
- gerer l'authentification et la securisation
- preparer les scenarios serveur personnel et heberge

### 5.6 Priorite 6 - Introduire le compte utilisateur et la monetisation

Objectif :
- ouvrir la voie au produit connecte sans casser le coeur local-first

Chantiers :
- authentification
- synchronisation selective de preferences
- liaison mobile
- modeles d'abonnement

---

## 6. Sequence de livraison recommandee

### Phase 0 - Assainissement documentaire

Livrables :
- `functional-spec.md`
- `technical-architecture.md`
- `roadmap.md`
- archivage des anciens documents non references

Critere de sortie :
- la documentation de reference devient claire et non superposee

### Phase 1 - Coeur Architect / Implement stable

Livrables :
- plans paralleles bien tenus
- derivation de taches fiable, y compris sur plusieurs plans executables cote desktop
- review de tache exploitable
- commits robustes
- validation finale de plan robuste

Critere de sortie :
- un utilisateur peut livrer un plan complet sur desktop sans bricolage majeur

Etat :
- socle documentaire de reference maintenant assaini et archive historique reduite au minimum utile
- socle desktop local-first considere comme stabilise
- les prochaines evolutions doivent preserver les contrats deja poses du flow Implement

### Phase 2 - Git flow et metadata robustes

Livrables :
- nettoyage robuste des branches et worktrees
- sync `@macro` fiable avec diagnostics et actions explicites
- lifecycle complet des plans sur le socle desktop local-first
- resolution assistee des merge conflicts pilotes par Macro

Critere de sortie :
- l'infrastructure Git de Macro est suffisamment fiable pour du travail long cours

Etat :
- phase consideree comme livree sur le socle desktop local-first
- finalisation, suppression logique, cleanup, preflights et sync `@macro` maintenant robustes
- coherence metadata par projet maintenant livree pour les plans multi-projets cote desktop local-first
- merge conflicts pilotes par Macro maintenant detectes, bloques en fail-closed et traitables via un workflow assiste avec reprise explicite
- les prochaines evolutions prioritaires basculent sur l'experience multi-projet premium

### Phase 3 - Experience multi-projet premium

Livrables :
- UX multi-projet lisible
- taches multi-projets bien gerees
- filtres par plan et par projet complets
- integration coherente des commits par depot

Critere de sortie :
- le multi-projet devient un vrai avantage produit visible

Etat :
- tranche `review multi-projet premium cote Implement` consideree comme livree sur le socle desktop local-first
- tranche `catalogue global multi-plan / multi-projet cote Implement` consideree comme livree sur le socle desktop local-first
- la file de taches et la review exposent maintenant les depots impliques, la progression depot par depot et la prochaine action attendue
- commits distincts par depot et completion unifiee de la tache maintenant tenus sans etats fantomes dans le flow Implement stabilise
- le catalogue charge maintenant tous les plans executables pertinents sans dependre du seul plan actif ni d'une seule branche cible
- la synthese de plans, la file de taches et les filtres restent maintenant coherents quand plusieurs plans vivants coexistent dans un meme groupe, sans regression sur les taches hors plan
- le prochain verrou majeur de la phase redevient la lisibilite UX du multi-projet et l'articulation review / finalisation quand plusieurs plans restent actifs

Prochaine tranche recommandee apres merge :
- lisibilite UX groupe / projet / plan / tache cote Implement
- clarte des filtres, de la navigation et de la review quand plusieurs plans et plusieurs depots restent actifs en parallele
- meilleure articulation entre review de tache multi-projet, validation globale de plan et finalisation

### Phase 4 - Automatisation et supervision

Livrables :
- demarrage manuel des taches abouti
- notifications desktop
- systeme de questions/reponses rapides

Critere de sortie :
- l'utilisateur peut laisser Macro avancer puis reprendre la main efficacement

### Phase 5 - Remote kernel et mobile supervision

Livrables :
- API headless elargie
- supervision distante fiable
- premiere integration mobile utile pour Implement
- execution continue entre plusieurs machines

Critere de sortie :
- Macro n'est plus lie a un unique poste allume en permanence

### Phase 6 - Comptes, sync et offres connectees

Livrables :
- authentification
- liaison compte / mobile / serveur
- synchronisation selective
- base des offres abonnement

Critere de sortie :
- le produit connecte existe sans fragiliser le coeur desktop local-first

---

## 7. Decisions produit encore a verrouiller

Les sujets suivants doivent rester visibles tant qu'ils ne sont pas totalement figes :

- niveau exact d'autonomie acceptable dans le mode Implement
- UX precise de la review et de l'edition manuelle
- politique exacte de merge automatique
- modelisation definitive des taches hors plan
- profondeur fonctionnelle du mobile a la V1
- frontiere entre execution locale, serveur personnel et hebergement Macro
- niveau de synchronisation associe au compte utilisateur

---

## 8. Anti-objectifs de la roadmap

La roadmap ne doit pas devenir :

- une copie de la specification fonctionnelle
- un inventaire de tickets trop fins
- un changelog
- un document purement technique de bas niveau

Elle doit rester un outil de pilotage.

---

## 9. Regles de maintenance du document

Cette roadmap doit etre mise a jour lorsque :

- une phase est terminee
- une priorite change
- un nouveau chantier majeur apparait
- une decision produit ferme un sujet ouvert

Chaque entree importante de roadmap doit pouvoir etre reliee a :

- une exigence de `docs/functional-spec.md`
- un impact sur `docs/technical-architecture.md`

Lorsqu'un chantier est livre, son etat doit etre mis a jour plutot que laisse implicite.
