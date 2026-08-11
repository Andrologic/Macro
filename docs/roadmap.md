# Macro - Roadmap

## 1. Objet du document

Ce document decrit la trajectoire de livraison de Macro.

Il sert à :
- identifier les écarts entre la cible produit et l'état actuel
- prioriser les chantiers
- définir un ordre de livraison cohérent
- servir de support de pilotage produit et technique

La cible fonctionnelle est définie dans `docs/functional-spec.md`.
L'architecture technique de référence est définie dans `docs/technical-architecture.md`.

---

## 2. Règle de lecture

Cette roadmap est organisée en trois niveaux :

- écarts constatés ou probables entre la cible et l'état actuel
- chantiers prioritaires
- séquence de livraison recommandée

Elle doit rester vivante.
Un chantier livré doit être retiré ou marqué comme terminé.
Un écart devenu obsolète doit être supprimé.

---

## 3. État actuel synthétique

L'application dispose déjà d'une base solide :

- shell desktop React + Tauri fonctionnel
- modes `Architect`, `Implement`, `Chat` déjà présents
- gestion de plans côté Architect déjà avancée
- pipeline Git et metadata déjà bien amorcé
- tâches, review et commit déjà présents côté Implement
- socle desktop `Architect -> Implement -> Review -> Commit -> validation finale de plan` maintenant stabilisé
- catalogue de tâches `Implement` maintenant capable d'agréger plusieurs plans exécutables et plusieurs branches cibles côté desktop
- filtres par plan et prise en charge des tâches hors plan maintenant présents dans la file de tâches
- résumés de plans `Implement` maintenant fiables pour les filtres et la validation quand plusieurs plans vivants coexistent
- review Implement multi-dépôts maintenant explicite dans la file et dans la review, avec progression dépôt par dépôt et complétion unifiée de la tâche
- lifecycle des plans maintenant robuste sur le socle desktop local-first
- sync `@macro` maintenant structurée avec états exploitables, actions explicites et erreurs remontées proprement
- merge conflicts pilotés par Macro maintenant détectés, bloqués en fail-closed et traités via un workflow assisté de résolution et reprise
- couches de services, stores et IPC déjà structurées
- fondation headless expérimentale présente dans le code, sans capacité produit exposée

En revanche, le produit cible n'est pas encore atteint sur plusieurs axes critiques :

- expérience Implement encore partiellement inachevée
- automatisation et orchestration encore à fiabiliser
- notifications et supervision distante non finalisées
- articulation desktop / remote / mobile encore incomplète
- expérience multi-plan et multi-projet encore à consolidér de bout en bout
- documents de référence recentrés autour d'un socle unique et d'une archive minimale non normative

---

## 4. Écarts principaux par domaine

### 4.1 Cadrage produit et documentation

État attendu :
- un socle documentaire court, propre et non redondant
- une spécification fonctionnelle de référence
- une architecture technique de référence
- une roadmap exploitable

État livre pour 0.1 :
- le socle documentaire actif est recentré sur `functional-spec.md`, `technical-architecture.md` et `roadmap.md`
- l'archive documentaire est réduite à un historique minimal non normatif
- les documents actifs constituent l'unique source de vérité

### 4.2 Mode Architect

État attendu :
- création et gestion fluide de plusieurs plans
- conversation et stratégie bien liées à chaque plan
- structuration prédictive fiable
- validation automatique propre vers branches et worktrees

État à consolidér :
- cleanup complet des structures lorsque des plans sont supprimés ou abandonnés
- robustesse multi-plans parallèles
- lisibilité du mode Architect quand plusieurs plans coexistent

### 4.3 Mode Implement

État attendu :
- file de tâches claire, filtrable et fiable
- démarrage manuel des tâches clair et fiable
- questions IA rapides à traiter
- review de fin de tâche ergonomique
- commits et intégration bien verrouillés

État déjà consolidé :
- derivation et agrégation de tâches depuis plusieurs plans exécutables côté desktop
- catalogue/backend de listing des tâches maintenant découplé du seul plan actif et d'une seule branche cible
- filtrage de la file par plan
- résumés de plans maintenant cohérents pour les filtres et la validation quand plusieurs plans vivent en parallèle
- support des tâches hors plan dans la file et dans le cycle de complétion
- meilleur rattachement des tâches multi-projets au projet courant
- review multi-dépôts côté Implement maintenant lisible dans la file et dans la review
- navigation explicite dépôt par dépôt, commits distincts par dépôt et complétion de tâche unifiée
- verrouillage des états fantômes entre review, commit par dépôt et complétion finale

État à consolidér :
- UX de la review et de l'édition ciblée
- questions IA à réponses rapides réellement branchées
- articulation claire entre review de tâche, commit, validation finale de plan et merge
- comportement global du mode quand plusieurs plans et plusieurs projets sont actifs en même temps

### 4.4 Review et édition ciblée

État attendu :
- review principalement en lecture
- possibilité d'ajuster rapidement les modifications de l'IA
- chargement progressif de contexte puis du fichier complet si besoin

État à consolidér :
- surface d'édition exacte
- expérience de correction manuelle dans les diffs
- ergonomie de validation du code après retouche

### 4.5 Git, plans et metadata

État attendu :
- workflow Git stable autour des plans, branches de feature, branche de base et `@macro`
- worktrees fiables
- metadata auditables et synchronisables
- conflicts metadata et merge conflicts techniques traités proprement

État déjà consolidé :
- finalisation, suppression logique et cleanup des plans maintenant préflightés et rejouables
- cleanup fiable des branches et worktrees de plan et de tâche
- sync `@macro` maintenant exposée comme `clean / pending / failed / conflict` avec diagnostics structurés
- actions explicites `commit / pull / push` pour `@macro` maintenant disponibles côté UI/store
- erreurs de divergence, remote manquant, upstream manquant, auth absente, réseau et conflit maintenant mieux remontées
- duplication cohérente de la metadata de plan sur chaque dépôt impliqué pour les plans multi-projets
- lecture, restauration, archivage, suppression et sync metadata des plans multi-projets maintenant découplées d'un `projectId` unique
- divergence entre copies metadata d'un même plan maintenant détectée en fail-closed avec réparation explicite
- merge conflicts de finalisation de plan et de sync `@macro` maintenant détectés avant mutation avec diagnostic par dépôt, aide IA et reprise explicite

État à consolidér :
- la phase cœur Git/metadata n'a plus de blocage critique côté desktop local-first
- les prochains gains structurants sur ce domaine passent surtout par l'expérience multi-projet premium côté Implement et review

### 4.6 Multi-projet

État attendu :
- groupes de projets natifs
- exécution cohérente sur plusieurs dépôts
- vision partagée du contexte
- commits distincts par projet mais validation fonctionnelle unifiée

État déjà consolidé :
- review Implement multi-dépôts maintenant explicite dans les parcours quotidiens
- progression et prochaine action attendue maintenant visibles pour les tâches multi-projets actives
- commits par dépôt maintenant mieux exposés sans perdre la complétion unifiée de la tâche
- catalogue Implement maintenant global à l'échelle du contexte desktop local-first, avec coexistence cohérente de plusieurs plans vivants et des tâches hors plan

État à consolidér :
- lisibilité UX du multi-projet
- gestion de bout en bout des tâches qui touchent plusieurs projets
- clarté globale des filtres, de la review et de la navigation

### 4.7 Mode Chat

État attendu :
- mode simple, léger, local
- historique conversationnel local
- pièces jointes par conversation
- outils web et MCP configurables

État à consolidér :
- simplification assumée du mode
- séparation nette avec le mode Implement
- politique d'outils clairement exposée à l'utilisateur

### 4.8 Notifications et supervision distante

État attendu :
- notifications desktop
- notifications mobiles
- demandes d'attention claires
- réponses rapides depuis mobile

État à consolidér :
- système de notification encore absent ou incomplet
- protocole d'échange entre exécution et client mobile
- définition de la supervision distante comme expérience produit complète

### 4.9 Kernel distant

État attendu :
- exécution continue sans GUI
- reprise entre desktop, laptop et mobile
- accès distant stable au workspace et aux outils
- base pour les offres serveur dédié ou hébergé

État à consolidér :
- enrichissement de l'API headless
- sécurisation et session utilisateur
- orchestration d'exécution longue durée
- articulation produit entre machine locale, serveur personnel et infrastructure hébergée

### 4.10 Comptes et abonnement

État attendu :
- authentification utilisateur
- liaison avec mobile
- synchronisation de certaines préférences
- eventuels modes d'abonnement

État à consolidér :
- fonctionnalité encore à introduire réellement dans le produit
- frontières entre cœur local-first et services comptes à formaliser

---

## 5. Chantiers prioritaires

### 5.1 Priorité 1 - Stabiliser le cœur desktop

Objectif :
- rendre l'expérience desktop suffisamment robuste pour servir de base produit

Chantiers :
- finir la boucle Architect -> Implement -> Review -> Commit -> Validation de plan
- durcir le workflow Git de plan
- fiabiliser les transitions de tâches
- finaliser l'UX de review et d'édition ciblée
- stabiliser la lisibilité du multi-plan côté Implement dans la review et la finalisation

### 5.2 Priorité 2 - Rendre le multi-projet réellement premium

Objectif :
- faire du multi-projet une vraie force du produit plutôt qu'une capacité partielle

Chantiers :
- clarifier la structure groupe / projet / plan / tâche
- fiabiliser les tâches multi-projets
- garantir la qualité des commits par projet
- améliorer navigation, filtres et lisibilité de contexte
- mieux articuler finalisation de plan, review et navigation quand plusieurs plans restent actifs en parallèle

### 5.3 Priorité 3 - Fiabiliser l'autonomie assistée

Objectif :
- rendre l'IA capable d'avancer longtemps sans degrader la qualité de supervision

Chantiers :
- démarrage manuel des tâches bien borne
- questions IA à choix rapides
- gestion claire des points de blocage
- exécution test/build observable et interprétable

### 5.4 Priorité 4 - Introduire la supervision distante

Objectif :
- permettre la poursuite du travail hors du poste principal

Chantiers :
- notifications desktop d'abord
- socle de supervision mobile ensuite
- protocoles de questions/réponses à distance
- review et validation à distance

### 5.5 Priorité 5 - Industrialiser le kernel distant

Objectif :
- transformer le kernel headless en brique produit stable

Chantiers :
- enrichir l'API headless
- fiabiliser l'exécution distante
- gérer l'authentification et la sécurisation
- préparer les scenarios serveur personnel et hébergé

### 5.6 Priorité 6 - Introduire le compte utilisateur et la monétisation

Objectif :
- ouvrir la voie au produit connecté sans casser le cœur local-first

Chantiers :
- authentification
- synchronisation sélective de préférences
- liaison mobile
- modèles d'abonnement

---

## 6. Séquence de livraison recommandée

### Phase 0 - Assainissement documentaire

Livrables :
- `functional-spec.md`
- `technical-architecture.md`
- `roadmap.md`
- archivage des anciens documents non références

Critère de sortie :
- la documentation de référence devient claire et non superposée

État :
- phase livrée pour 0.1
- l'ancienne spécification API mobile / remote à été retiree de l'archive pour éviter une lecture contractuelle

### Phase 1 - Cœur Architect / Implement stable

Livrables :
- plans parallèles bien tenus
- derivation de tâches fiable, y compris sur plusieurs plans exécutables côté desktop
- review de tâche exploitable
- commits robustes
- validation finale de plan robuste

Critère de sortie :
- un utilisateur peut livrer un plan complet sur desktop sans bricolage majeur

État :
- socle documentaire de référence assaini et archive historique réduite au minimum utile
- socle desktop local-first considéré comme stabilisé
- les prochaines évolutions doivent préserver les contrats déjà posés du flow Implement

### Phase 2 - Git flow et metadata robustes

Livrables :
- nettoyage robuste des branches et worktrees
- sync `@macro` fiable avec diagnostics et actions explicites
- lifecycle complet des plans sur le socle desktop local-first
- résolution assistée des merge conflicts pilotés par Macro

Critère de sortie :
- l'infrastructure Git de Macro est suffisamment fiable pour du travail long cours

État :
- phase considérée comme livrée sur le socle desktop local-first
- finalisation, suppression logique, cleanup, preflights et sync `@macro` maintenant robustes
- cohérence metadata par projet maintenant livrée pour les plans multi-projets côté desktop local-first
- merge conflicts pilotés par Macro maintenant détectés, bloqués en fail-closed et traitables via un workflow assisté avec reprise explicite
- les prochaines évolutions prioritaires basculent sur l'expérience multi-projet premium

### Phase 3 - Expérience multi-projet premium

Livrables :
- UX multi-projet lisible
- tâches multi-projets bien gérées
- filtres par plan et par projet complets
- intégration cohérente des commits par dépôt

Critère de sortie :
- le multi-projet devient un vrai avantage produit visible

État :
- tranche `review multi-projet premium côté Implement` considérée comme livrée sur le socle desktop local-first
- tranche `catalogue global multi-plan / multi-projet côté Implement` considérée comme livrée sur le socle desktop local-first
- la file de tâches et la review exposent maintenant les dépôts impliqués, la progression dépôt par dépôt et la prochaine action attendue
- commits distincts par dépôt et complétion unifiée de la tâche maintenant tenus sans états fantômes dans le flow Implement stabilisé
- le catalogue charge maintenant tous les plans exécutables pertinents sans dépendre du seul plan actif ni d'une seule branche cible
- la synthèse de plans, la file de tâches et les filtres restent maintenant cohérents quand plusieurs plans vivants coexistent dans un même groupe, sans régression sur les tâches hors plan
- le prochain verrou majeur de la phase redevient la lisibilité UX du multi-projet et l'articulation review / finalisation quand plusieurs plans restent actifs

Prochaine tranche recommandée après merge 0.1 :
- lisibilité UX groupe / projet / plan / tâche côté Implement
- clarté des filtres, de la navigation et de la review quand plusieurs plans et plusieurs dépôts restent actifs en parallèle
- meilleure articulation entre review de tâche multi-projet, validation globale de plan et finalisation

### Phase 4 - Automatisation et supervision

Livrables :
- démarrage manuel des tâches abouti
- notifications desktop
- système de questions/réponses rapides

Critère de sortie :
- l'utilisateur peut laisser Macro avancer puis reprendre la main efficacement

### Phase 5 - Remote kernel et mobile supervision

Livrables :
- API headless élargie
- supervision distante fiable
- première intégration mobile utile pour Implement
- exécution continue entre plusieurs machines

Critère de sortie :
- Macro n'est plus lié à un unique poste allumé en permanence

### Phase 6 - Comptes, sync et offres connectées

Livrables :
- authentification
- liaison compte / mobile / serveur
- synchronisation sélective
- base des offres abonnement

Critère de sortie :
- le produit connecté existe sans fragiliser le cœur desktop local-first

---

## 7. Decisions produit encore à verrouiller

Les sujets suivants doivent rester visibles tant qu'ils ne sont pas totalement figés :

- niveau exact d'autonomie acceptable dans le mode Implement
- UX précise de la review et de l'édition manuelle
- politique exacte de merge automatique
- modélisation définitive des tâches hors plan
- profondeur fonctionnelle du mobile à la V1
- frontière entre exécution locale, serveur personnel et hébergement Macro
- niveau de synchronisation associé au compte utilisateur

---

## 8. Anti-objectifs de la roadmap

La roadmap ne doit pas devenir :

- une copie de la spécification fonctionnelle
- un inventaire de tickets trop fins
- un changelog
- un document purement technique de bas niveau

Elle doit rester un outil de pilotage.

---

## 9. Règles de maintenance du document

Cette roadmap doit être mise à jour lorsque :

- une phase est terminée
- une priorité change
- un nouveau chantier majeur apparait
- une décision produit ferme un sujet ouvert

Chaque entrée importante de roadmap doit pouvoir être reliée à :

- une exigence de `docs/functional-spec.md`
- un impact sur `docs/technical-architecture.md`

Lorsqu'un chantier est livre, son état doit être mis à jour plutôt que laisse implicite.
