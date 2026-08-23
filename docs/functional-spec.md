# Macro - Spécification Fonctionnelle

## 1. Objet du document

Ce document définit la cible fonctionnelle de Macro en tant que produit fini.

Il décrit :
- ce qu'est Macro
- ce que Macro doit permettre à un développeur de faire
- comment les principaux workflows doivent fonctionner
- quelles règles utilisateur constituent le contrat fonctionnel du produit

Ce document n'est pas un plan d'implémentation.
Les écarts entre la cible et l'état courant, les phases de livraison et les priorités relèvent de `docs/roadmap.md`.

Sauf mention explicite contraire, les exigences de ce document décrivent le comportement produit attendu, y compris quand certaines capacités ne sont pas encore entièrement stabilisées dans l'application.
Pour la ligne 0.1, le contrat public est le workflow desktop local-first. Le remote et le mobile sont des pistes futures, non disponibles et non supportées dans le produit actuel. Macro 0.1 n'expose ni compte applicatif ni abonnement.

---

## 2. Positionnement du produit

### 2.1 Promesse produit

Macro est un environnement de développement qui organise le vibe-coding en transformant le développeur en architecte et pilote de l'exécution par l'IA plutôt qu'en producteur direct du code.

Utiliser Macro doit ressembler au travail d'un senior ou d'un lead technique qui briefe, coordonne et contrôle une équipe d'exécuteurs IA juniors.

### 2.2 Philosophie centrale

Macro repose sur les principes suivants :

- Le développeur est le pilote, pas le simple rédacteur du code.
- L'IA produit l'essentiel du code.
- La planification doit précéder l'exécution dès que le scope le justifie.
- Le travail doit rester auditable.
- La review est une activité de premier ordre.
- Le multi-projet est un cas natif, pas un cas limité.
- Le produit doit permettre une continuité d'exécution entre plusieurs machines et, à terme, entre desktop, mobile et environnement distant.

### 2.3 Objectif principal

Macro doit permettre à un développeur de définir le travail une fois, de le structurer clairement, de déléguer l'essentiel de l'implémentation à l'IA et de continuer à superviser l'exécution sans rester attaché à une seule machine.

---

## 3. Périmètre du produit

### 3.1 Dans le périmètre

Macro doit couvrir :

- la planification et la structuration du travail d'ingénierie
- la dérivation de tâches exécutables à partir d'un plan
- l'exécution de tâches avec assistance IA
- la review des changements avant validation finale
- la coordination de plusieurs projets reliés dans un même espace de travail
- la conservation d'une trace d'audit des plans et de l'exécution
- à terme, la poursuite de l'exécution depuis une autre machine ou depuis un flux de supervision mobile ou distant

### 3.2 Hors périmètre

Macro n'a pas vocation à être :

- un IDE générique centré sur l'écriture manuelle du code
- un remplacement des plateformes classiques de gestion de dépôt
- un simple chat generaliste sans workflow de développement
- une interface publique pour les outils internes de debug de l'application

Le périmètre fonctionnel public repose sur les modes `Architect`, `Implement` et `Chat`.

---

## 4. Utilisateurs cibles

Macro s'adresse principalement à des développeurs qui :

- travaillent déjà avec des IA dans leur workflow
- ont besoin de plus de structure qu'un simple chat IA
- veulent superviser l'implémentation plutôt que tout coder eux-mêmes
- travaillent sur un ou plusieurs dépôts reliés
- peuvent avoir besoin de continuer la supervision loin de leur machine principale

Macro suppose que l'utilisateur agit comme un décideur technique, même lorsqu'il travaille seul.

---

## 5. Modèle fonctionnel général

### 5.1 Modèle mental principal

Macro organise le travail de la façon suivante :

1. l'utilisateur formule une intention
2. l'IA inspecte le contexte utile et pose des questions ciblées si des informations importantes manquent
3. l'utilisateur demande explicitement la génération de la stratégie
4. l'IA génère la stratégie depuis la conversation, le périmètre du plan, les projets sélectionnés et le code inspecté
5. la stratégie est validée
6. les tâches d'implémentation sont exécutées dans l'ordre voulu avec un maximum de parallélisme possible
7. l'utilisateur review les résultats
8. le code est committé et intégré

### 5.2 Unités fonctionnelles principales

Macro s'appuie sur les unités suivantes :

- workspace
- groupe de projets
- projet
- plan
- conversation
- nœud de stratégie
- branche prédictive
- tâche d'implémentation
- session de review

Ces unités sont définies dans la section suivante.

---

## 6. Concepts cœur

### 6.1 Workspace

Le workspace est l'environnement actif dans lequel Macro opère.

Il contient :
- un ou plusieurs groupes de projets
- un ou plusieurs projets
- l'état local de l'application
- les métadonnées nécessaires à l'audit de la planification et de l'exécution

### 6.2 Groupe de projets

Un groupe de projets est un conteneur logique permettant de travailler sur plusieurs projets reliés comme sur un seul système cohérent.

Exemples :
- une application mobile et un site web
- un frontend et un backend
- plusieurs clients plateformes pour un même produit

Le groupe est le contexte fonctionnel principal pour le travail coordonné.

### 6.3 Projet

Un projet est une codebase technique individuelle, généralement adossée à son propre dépôt.

Un projet appartient à un groupe de projets.

### 6.4 Plan

Un plan est l'unité principale de travail en mode Architect.

Un plan contient :
- une conversation dédiée qui capture l'intention et les clarifications
- la stratégie générée directement depuis cette conversation et le contexte du projet
- la structure prédictive de branches associée à cette stratégie
- les artefacts de relais produits par les tâches planifiées pour transmettre de l'information aux tâches dépendantes

Un plan sert à définir une vague de travail cohérente.

Exemples typiques :
- une grosse fonctionnalité
- une vague d'améliorations ciblée
- un lot de livraison cohérent

Plusieurs plans peuvent exister en parallèle pour un même groupe de projets.

Plusieurs plans peuvent aussi être actifs en parallèle si leur exécution peut progresser simultanément.

Lorsqu'un plan est terminé, il est archivé.
Un plan archivé reste consultable pour l'audit et l'historique, mais n'est plus destiné à être modifié.

### 6.5 Nœud de stratégie

Un nœud de stratégie est une unité de la stratégie d'un plan générée par l'IA.

Un nœud peut représenter :
- une tranche fonctionnelle
- une étape technique
- un jalon de dépendance
- une unité d'exécution proche de la tâche

Les nœuds de stratégie définissent l'ordre, les dépendances et la structure d'exécution.

Un nœud peut aussi déclarer des contrats d'artefacts attendus. Ces contrats décrivent les informations critiques qu'une tâche devra produire pour ses descendantes, par exemple des résultats d'audit, une carte de migration, un contrat d'API ou un registre de risques.

### 6.6 Branche prédictive

Une branche prédictive est un artefact de planification qui représente la façon dont le travail doit être découpé dans Git pendant l'exécution.

Son but est de :
- organiser l'exécution
- maximiser le parallélisme lorsque cela reste sans risque
- conserver une branche de travail distincte par tâche exécutable
- réduire la dérive de l'IA et les changements trop volumineux

### 6.7 Tâche d'implémentation

Une tâche d'implémentation est une unité de travail exécutable dérivée de la stratégie.

La tâche est l'unité suivie dans le mode Implement.

Une tâche terminée avec succès se conclut toujours par un commit.

La plupart des tâches sont créées à partir d'un plan valide, mais Macro doit aussi supporter des tâches autonomes pour les quick fixes ou les petites features ne justifiant pas un plan complet.

### 6.8 Artefact de relais

Un artefact de relais est une information durable produite par une tâche issue d'un plan Architect.

Il sert à transmettre du contexte exploitable aux tâches qui dépendent directement ou indirectement de la tâche productrice.

Les artefacts de relais :
- sont rattachés à un plan et à une tâche productrice
- sont stockés dans les métadonnées `@macro`, pas dans le code source applicatif
- peuvent être déclarés à l'avance par la stratégie ou produits librement par l'agent Implement
- ne sont visibles que par la tâche productrice, ses descendantes et la tâche synthétique de finalisation du plan
- ne sont pas partagés entre tâches parallèles sans dépendance
- sont affichés dans le panneau des changements comme un sous-projet `Artifacts`, avec revue et validation metadata séparées du staging Git
- peuvent superséder un artefact hérité en créant une nouvelle version rattachée à la tâche courante, sans écraser la version parente
- restent limités en v1 à du contenu texte, Markdown ou JSON

---

## 7. Modes

Macro expose trois modes produits dans son périmètre public :

- Architect
- Implement
- Chat

Le mode `Debug` ne fait plus partie de l'application ni de la spécification fonctionnelle publique.

### 7.1 Mode Architect

Le mode Architect est le mode de planification et de structuration.

Son objectif est de permettre à l'utilisateur de :
- exprimer une intention dans la conversation du plan
- définir ou affiner le périmètre du travail
- répondre à des questions ciblées lorsque des informations importantes manquent
- demander explicitement la génération d'une stratégie
- valider la structure d'exécution attendue

Le mode Architect constitue le cœur méthodologique de Macro.

Fonctionnellement, il correspond au moment où un senior ou un lead technique briefe une équipe avant exécution.

Le mode Architect doit supporter :
- une conversation par plan
- l'inspection du code pour enrichir le contexte lorsque cela est utile
- une stratégie générée par l'IA depuis la conversation et le contexte du projet
- la déclaration d'artefacts critiques attendus par tâche
- une visualisation des dépendances et de la structure prédictive
- la validation d'un plan
- la préparation automatique de la structure d'exécution après validation

Le mode Architect n'est pas un simple mode descriptif.
Il doit préparer concrètement la suite de l'implémentation.

### 7.2 Mode Implement

Le mode Implement est le mode d'exécution et de review.

Son objectif est de :
- exécuter les tâches dérivées d'un ou plusieurs plans
- gérer les questions de l'IA pendant l'exécution
- présenter les changements générés pour review
- permettre un ajustement humain si nécessaire
- valider et committer le travail tâche par tâche

Le mode Implement doit supporter :
- une file de tâches issue de plusieurs plans
- une vue agrégée de toutes les tâches de tous les projets
- le filtrage des tâches par projet et par autres critères pertinents
- un résumé opérationnel par statut, utilisable comme filtre, à la place d'une progression globale ambiguë
- la sélection explicite d'un projet modifiable lors de la création d'une tâche indépendante
- la création d'une tâche indépendante typée `feature`, `bugfix` ou `hotfix`, avec choix explicite du projet et du type
- la prise en compte explicite des dépendances et de l'état de disponibilité d'une tâche
- la consultation des artefacts hérités depuis les tâches parentes et la production d'artefacts pour les tâches dépendantes
- une review en fin de tâche
- une validation globale du plan avant merge du plan vers la branche de base

Le mode Implement repose sur un démarrage manuel de l'exécution des tâches.

Lors de la création d'une tâche indépendante, l'utilisateur choisit d'abord le projet, puis un type de tâche compatible avec son workflow Git. La fenêtre ne demande pas le contenu de la tâche : celui-ci est fourni ensuite dans la conversation. Le type sélectionné détermine le modèle de nom de branche et la branche cible : la branche de développement pour une `feature` ou un `bugfix`, et la branche principale pour un `hotfix`. Un projet mainline, sans branche de développement distincte de la branche principale, permet `Feature` et `Hotfix`, mais pas `Bugfix`. La disponibilité est recalculée lorsque le projet cible change et tout choix devenu incompatible est effacé. Le type `release` reste réservé aux plans Architect.

### 7.3 Mode Chat

Le mode Chat est un mode de support indépendant.

Son objectif est de permettre à l'utilisateur de :
- poser des questions rapides d'ordre technique ou documentaire
- attacher des fichiers à une conversation
- utiliser certains outils web et MCP
- conserver une continuité de travail dans l'application sans entrer dans tout le workflow Macro

Le mode Chat n'est pas rattaché par défaut à un contexte projet autonome.

Il se distingue du mode Implement en ce que :
- il n'est pas piloté par une stratégie de plan
- il ne travaille pas par défaut sur un contexte d'exécution de projet
- il ne parcourt pas un workspace complet en mode agent
- il fonctionne conversation par conversation avec un contexte explicitement fourni

Le mode Chat doit conserver un historique local des conversations.

---

## 8. Structure générale de l'interface

### 8.1 Structure cible

L'interface desktop de Macro doit être organisée autour des zones suivantes :

- un header
- un panneau gauche
- une zone centrale
- un panneau droit
- un footer
- des modales et surfaces temporaires de consultation ou d'action

### 8.2 Header

Le header doit permettre au minimum :

- l'accès au mode actif
- l'accès au contexte projet ou groupe courant lorsque le mode s'y prête
- l'accès aux réglages
- l'accès aux commandes globales de l'application

### 8.3 Panneau gauche

La disponibilité des panneaux est définie par la configuration du mode courant.

Exemples :

- file de tâches en mode Implement
- historique ou navigation de conversations en mode Chat
- navigation directe dans les projets, groupes et plans en mode Architect

En mode Architect, le panneau gauche est la surface canonique de sélection du contexte et du plan. Il présente une seule profondeur : les groupes ou projets au premier niveau, puis leurs plans directement en dessous. La flèche et la ligne d'un projet basculent toutes deux son état développé ou réduit, même s'il ne contient encore aucun plan ; l'action « Créer le premier plan » suit cet état. Les plans épinglés sont proposés comme raccourcis sans dupliquer leur état. Le bouton d'ajout crée un projet, le bouton de gestion ouvre le navigateur de projets complet et le bouton associé à chaque projet ouvre le choix des types de plans compatibles avec son workflow Git.

En mode Chat, la sélection multiple reste compacte tant qu'elle n'est pas utilisée. Son déclencheur est un bouton à icône placé dans l'en-tête, immédiatement avant la création d'une conversation. Le bandeau indiquant le nombre de conversations sélectionnées et les actions groupées n'est rendu qu'après activation du mode ; il s'ouvre à zéro sélection et disparaît à l'annulation.

Le clic droit reprend les actions déjà disponibles sans créer une voie parallèle : sur un projet, il ouvre le choix du type de plan, l'action de développement ou de réduction et la gestion des projets ; sur un plan, il ouvre les actions d'épinglage, de renommage, d'archivage, de restauration ou de suppression selon ses capacités. Chaque ligne de plan affiche explicitement son type à la place d'un indicateur de statut non légendé.

Les archives ne constituent pas une section dépliable dans l'arborescence active. Un bouton à icône dans l'en-tête du panneau permet de basculer entre les plans actifs et une vue dédiée aux plans archivés, de façon cohérente avec le mode Implement et sans réserver une barre en bas du panneau. Les actions d'archives et de création utilisent le même bouton carré dans les deux modes ; leur intitulé reste disponible au survol et pour les technologies d'assistance. Cette vue conserve les actions de restauration et de suppression sans mélanger les plans archivés aux projets en cours.

L'état vide central dépend du catalogue du projet sélectionné. Si aucun plan n'existe et que le projet est modifiable, il propose explicitement de créer le premier plan et ouvre le choix contextuel du type de plan. Le libellé « Sélectionner un plan » n'apparaît que lorsqu'au moins un plan est réellement disponible. Le panneau central demande explicitement l'état courant au navigateur lors de son montage afin de ne pas dépendre de l'ordre de chargement des panneaux.

Sa largeur est propre au mode Architect afin de conserver une arborescence compacte, même si les panneaux des modes Implement ou Chat ont été agrandis. Le projet sélectionné et le plan actif utilisent des traitements visuels distincts : le premier définit la portée, le second représente le contenu actuellement ouvert.

Le sélecteur de projet du header reste disponible en mode Implement, mais n'est pas dupliqué en mode Architect. De la même façon, le plan actif n'est plus sélectionné depuis un menu dans la zone centrale : celle-ci affiche le contexte courant et laisse la navigation au panneau gauche.

### 8.4 Zone centrale

La zone centrale doit rester le cœur opérationnel de l'application.

Elle doit principalement accueillir :

- la conversation
- les actions de supervision
- les décisions de pilotage
- les interactions avec l'IA

### 8.5 Panneau droit

Le panneau droit doit accueillir les surfaces de lecture, de visualisation ou de validation liées au mode courant.

Exemples :

- graphe de stratégie
- review des changements
- contexte, outils ou sources

### 8.6 Footer

Le footer doit exposer les informations et actions globales de statut.

Le projet Git affiché et utilisé par les actions de synchronisation est strictement dérivé du travail actif. En mode Implement, la tâche sélectionnée fait autorité ; lorsqu'aucune tâche n'est sélectionnée, le projet explicitement manipulé dans le panneau sert de contexte. En mode Architect, le plan actif fait autorité : un plan mono-projet sélectionne directement son dépôt, tandis qu'un plan multi-projets exige un focus durable déjà présent dans sa portée ou une sélection manuelle bornée à cette portée. Lorsqu'aucun plan n'est sélectionné, le projet choisi dans le navigateur Architect sert de contexte Git. Lorsqu'aucun projet n'est enregistré, Architect permet aussi de choisir explicitement un dossier Git depuis le footer ; ce dossier temporaire expose le statut et les actions Git du code sans initialiser ni synchroniser de branche de métadonnées `@macro`. En mode Chat, la conversation active doit désigner un projet sans ambiguïté. Sans dépôt unique ou dossier explicitement choisi dans ce cas précis, le footer n'affiche aucun contexte et n'exécute aucune commande Git de repli. Toute sélection manuelle est invalidée lorsque l'identité ou la portée du contexte actif change.

Les actions fetch, pull et push ciblent toujours la branche réellement checkoutée dans le worktree affiché. Le footer expose cette branche dans les libellés de survol, mais ne propose pas de branche distante arbitraire : un pull vers une autre branche aurait pour effet de l'intégrer dans le worktree courant et rendrait les compteurs de divergence trompeurs. Lors d'un pull du code, l'absence de branche distante `@macro` est un cas normal : la synchronisation des métadonnées est simplement ignorée pour le dépôt concerné, sans erreur, tandis que les autres dépôts continuent d'être synchronisés. Les icônes de synchronisation restent dans des cadres de taille fixe ; fetch tourne, pull progresse vers le bas et push vers le haut, sans modifier l'alignement vertical. Les animations sont neutralisées lorsque la réduction des mouvements est demandée par le système.

Exemples :

- état Git
- état metadata `@macro`
- actions de sync
- statut global du contexte courant

### 8.7 Modales

Les modales servent aux opérations ponctuelles qui ne doivent pas surcharger la surface principale.

Exemples :

- création de projet
- navigation projet
- visualisation de diff
- réglage de l'application

---

## 9. Structure projet et multi-projet

### 9.1 Le multi-projet comme capacité centrale

Le multi-projet est une capacité centrale du produit.

Macro doit traiter plusieurs codebases reliées comme un contexte de développement coordonné dès que cela a du sens.

L'utilisateur doit pouvoir :
- créer un groupe logique pour un produit ou un système
- rattacher plusieurs sous-projets à ce groupe
- laisser l'IA travailler avec conscience des relations entre ces projets

### 9.2 Cas d'usage attendus

Exemples de cas multi-projets natifs :

- application mobile plus site web
- frontend plus backend
- application iOS plus application Android plus API partagée

Le produit doit permettre de coordonner l'implémentation sur ces projets dans un seul workflow structuré.

### 9.3 Comportement des plans dans un contexte multi-projet

Lorsqu'un plan concerne plusieurs projets, le plan doit exister dans l'historique metadata de chaque projet impliqué.

Cette duplication est volontaire.

Elle sert à :
- conserver l'auditabilité
- maintenir la trace historique même si un sous-projet est ensuite détaché
- éviter la perte de contexte au niveau d'un dépôt individuel

### 9.4 Visibilité des tâches

Le mode Implement doit supporter des tâches issues :
- de plusieurs plans
- de plusieurs projets
- de plusieurs dépôts dans un même groupe

L'interface doit permettre d'identifier clairement :
- à quel plan appartient une tâche
- quel ou quels projets elle affecte
- quel est son état de dépendance

L'interface doit afficher toutes les tâches de tous les projets par défaut et permettre de les filtrer par projet.
Le mode Implement ne dépend pas du sélecteur de projet global du header.

---

## 10. Cycle de vie des projets

### 10.1 Création de projet

Macro doit permettre la création d'un projet depuis l'interface.

La création d'un projet doit permettre au minimum de définir :

- un nom
- un groupe cible optionnel
- un chemin local optionnel

### 10.2 Import de projet Git

Macro doit permettre l'import d'un projet existant de type Git.

L'import doit permettre au minimum de définir :

- l'URL Git
- le nom du projet
- la branche cible
- le groupe cible optionnel
- un chemin local optionnel

### 10.3 Gestion du projet

Macro doit permettre les opérations de base suivantes sur les projets et groupes :

- renommer un groupe
- renommer un projet
- archiver un groupe
- archiver un projet
- fermer un projet

### 10.4 Sélection du contexte

Macro doit permettre de changer explicitement de contexte de travail :

- au niveau du groupe
- au niveau du projet

Le changement de contexte doit restaurer l'état local utile autant que possible, notamment pour les conversations, plans et tâches liés au projet.

---

## 11. Cycle de vie d'un plan

### 11.1 Création du plan

L'utilisateur crée un plan depuis le mode Architect.

Créer un plan crée un nouveau contexte de planification comprenant :
- sa conversation propre
- sa stratégie propre

### 11.2 Génération du plan

L'utilisateur exprime ses objectifs de façon conversationnelle.

L'IA doit :
- discuter avec l'utilisateur et inspecter le code lorsque cela apporte du contexte
- poser des questions ciblées avec l'outil `question` lorsque des informations importantes manquent
- attendre une demande explicite avant de générer la stratégie
- construire la stratégie depuis la conversation du plan, l'intention exprimée, le périmètre, les projets sélectionnés et le code inspecté
- organiser cette stratégie pour maximiser le parallélisme lorsque cela reste sans risque
- maintenir chaque unité d'exécution à une taille limitée pour réduire la confusion de l'IA et les changements trop larges

### 11.3 Validation du plan

Lorsqu'un plan est valide :
- la préparation des branches et des worktrees doit se faire automatiquement
- cette préparation est obligatoire
- la structure d'exécution doit être prête pour le mode Implement

### 11.4 Exécution du plan

Un plan valide peut entrer en exécution pendant que d'autres plans restent actifs en parallèle.

### 11.5 Complétion du plan

Un plan est considéré comme terminé lorsque :
- toutes les tâches requises sont complétées
- la validation globale du plan est réalisée
- la branche du plan est acceptée pour intégration dans la branche de base configurée

### 11.6 Archivage du plan

Les plans termines doivent être archives.

Les plans archives doivent rester accessibles pour :
- la lecture
- l'audit
- l'analyse rétrospective

Ils ne sont plus destinés à être modifiés.

---

## 12. Règles de génération de stratégie

### 12.1 L'IA est responsable de la formalisation

La stratégie est générée par l'IA et non saisie manuellement dans un formalisme rigide.

L'utilisateur peut influencer le résultat par la conversation et les prompts, mais l'IA reste responsable de la structuration.

### 12.2 Objectifs de la stratégie

La stratégie doit :
- refleter l'intention utilisateur
- définir un ordre d'exécution réaliste
- maximiser le parallélisme lorsque c'est sûr
- exprimer le séquentiel par des dépendances explicites entre tâches
- minimiser les commits trop volumineux et les frontières de tâches floues

### 12.3 Structuration par branches

La stratégie doit organiser le travail de sorte que :
- plusieurs branches puissent progresser en parallèle
- chaque tâche exécutable dispose de sa propre branche de travail
- les tâches séquentielles soient reliées par des dépendances explicites
- les branches de tâche convergent vers la branche d'intégration du plan

Cette structuration existe pour réduire le risque et améliorer la qualité des reviews.

---

## 13. Modèle de tâche

### 13.1 Tâches planifiées

La plupart des tâches sont dérivées automatiquement d'un plan valide.

Ces tâches heritent :
- du contexte du plan
- de l'ordre d'exécution
- de la structure de branche
- des associations projet

### 13.2 Tâches autonomes

Macro doit aussi supporter des tâches autonomes en dehors de tout plan.

Ces tâches servent aux :
- petits correctifs
- oublis mineurs
- petites features ne justifiant pas un cycle complet de planification

Les tâches autonomes doivent tout de même supporter :
- l'exécution par IA
- la review
- le commit

Les tâches autonomes sont mergées directement vers la branche de base configurée plutôt que via une branche de plan.

### 13.3 Règle de complétion

Une tâche ne peut pas être considérée comme complète sans commit.

---

## 14. Comportement du mode Implement

### 14.1 Conditions de démarrage

Dans le mode Implement :
- les tâches ne se lancent pas toutes seules
- l'utilisateur déclenche explicitement le début de la tâche
- l'utilisateur peut fournir un prompt initial ou un cadrage complémentaire avant l'exécution

### 14.2 Gestion des questions

Au début d'une tâche, l'IA peut :
- poser des questions de clarification si nécessaire
- ne poser aucune question si la tâche est suffisamment claire

Quand l'IA pose des questions, Macro doit privilégier une interaction rapide.

Le modèle privilégié est :
- trois réponses suggérées
- une quatrième voie libre pour une réponse personnalisée

Ce modèle existe pour réduire le frottement utilisateur et faciliter la supervision depuis mobile.

### 14.3 Travail d'exécution

Pendant l'exécution d'une tâche, l'IA peut :
- inspecter le contexte nécessaire
- modifier des fichiers
- lancer des tests
- lancer un build
- préparer des changements pour review

### 14.4 Review humaine

Une review humaine est obligatoire à la fin de chaque tâche.

La review de tâche doit présenter :
- la liste des fichiers modifiés
- l'accès aux diffs
- suffisamment de contexte fichier pour comprendre le changement

L'utilisateur doit pouvoir :
- inspecter les changements
- approuver le résultat
- demander des améliorations
- apporter de petits ajustements manuels

### 14.5 Édition manuelle autorisée pendant la review

Macro doit rester majoritairement en lecture seule.

Cependant, la review doit permettre un ajustement manuel ciblé.

L'expérience de review doit prioriser :
- l'édition des lignes modifiées par l'IA

Elle doit aussi permettre :
- de charger davantage de contexte autour du changement
- de charger le fichier complet si nécessaire
- de modifier en dehors de la zone initialement changée lorsque cela s'impose

L'édition manuelle est secondaire, mais elle doit exister.

### 14.6 Périmètre de validation

La validation humaine porte principalement sur la qualité et la justesse du code généré.

Les résultats des tests et du build doivent être visibles pour l'utilisateur, mais ils ne constituent pas la surface principale de review.

Les messages de commit doivent être générés automatiquement par l'IA après validation utilisateur.

### 14.7 Sorties des outils de workspace

Les outils `list`, `read`, `glob`, `grep`, `git_status`, `git_log` et `git_diff` doivent produire des sorties bornées. Lorsqu'une réponse paginable est incomplète, elle doit l'indiquer explicitement et fournir un curseur permettant de continuer la même requête sans répéter ni sauter volontairement des résultats.

Les outils de lecture `list`, `read` et `glob` doivent expirer après 5 secondes, et `grep` après 30 secondes. Une annulation de la génération en cours doit interrompre réellement leur exécution desktop ou distante et produire une erreur stable, distincte d'un dépassement de délai. Après une expiration, l'agent doit réduire le chemin, le motif ou la requête. Cette interruption ne s'applique pas aux mutations, qui ne doivent jamais être abandonnées à mi-écriture.

Une lecture paginée doit rester liée à la révision du fichier qu'elle a commencé à lire. De même, la pagination de `git_status` doit être liée à l'ensemble exact des changements observés. Si la source change, Macro doit refuser le curseur devenu obsolète plutôt que de composer silencieusement une vue incohérente. Les recherches doivent signaler les fichiers binaires ou trop gros qu'elles n'ont pas inspectés, et les lignes exceptionnellement longues doivent être tronquées de façon visible.

La pagination de `git_log` doit lier son curseur au commit de tête résolu et à la présence des pseudo-commits staged/unstaged. Un changement de cet instantané invalide le curseur afin d'éviter de répéter ou de sauter des commits réels lorsque les pseudo-commits apparaissent ou disparaissent.

`git_diff` doit proposer des vues de synthèse `stat` et `name_only` en plus du patch. Un patch trop volumineux conserve un début et une fin identifiables, annonce explicitement les octets omis et peut échouer à la demande avec `require_complete` lorsque l'appelant interdit une réponse partielle.

Le comportement doit rester équivalent dans le backend desktop, les workspaces virtuels multi-projets, le fallback frontend, le noyau distant et le pont Copilot. Un transport qui ne sait pas garantir ces bornes ne doit pas exécuter ces outils.

Une limite de sécurité interne atteinte pendant l'énumération doit produire une erreur récupérable qui invite à réduire le périmètre. Macro ne doit jamais convertir une énumération interne incomplète en `total_count`, `scan_complete` ou `total_is_exact` affirmatif.

Les commandes lancées par les outils terminal doivent borner leur durée, leur mémoire de sortie et le temps consacré au drainage final de stdout/stderr. Une sortie tronquée conserve un début et une fin identifiables, avec le volume omis. L'annulation de la génération doit terminer le groupe de processus et ses descendants, y compris lorsqu'elle arrive pendant le démarrage, sans interrompre les terminaux interactifs ouverts par l'utilisateur.

Tout résultat textuel d'outil dépassant 50 Kio doit être remplacé dans le contexte par un aperçu borné conservant son début et sa fin. Le contenu complet reste attaché à la conversation sous une adresse `tool-output://…` et peut être relu par pages avec `read_file`. Les fichiers joints et ces sorties récupérables doivent exposer des pages numérotées et un curseur opaque ; le mode brut paginé doit permettre de récupérer sans perte les contenus constitués d'une seule ligne très longue.

---

## 15. Modèle de review et d'intégration

### 15.1 Validation à l'échelle de la tâche

Chaque tâche complétée doit se conclure par :
- une review du code
- une validation utilisateur
- la génération d'un commit

### 15.2 Validation à l'échelle du plan

Lorsque toutes les tâches d'un plan sont terminées, Macro doit imposer une validation globale du plan avant merge du plan vers la branche de base configurée.

Cette validation est distincte de la review tâche par tâche.

### 15.3 Génération des commits

Après acceptation de la review :
- l'IA doit générer le message de commit
- le commit doit être créé sur la branche appropriée

### 15.4 Structure des merges

Pour le travail dérivé d'un plan, le flux par défaut est :

- chaque tâche se fait sur une branche feature dédiée rattachée au plan
- le travail valide est merge vers la branche d'intégration du plan
- le plan valide est ensuite merge vers la branche de base configurée

Pour les tâches autonomes :

- le travail valide est merge directement vers la branche de base configurée

### 15.5 Merge conflicts

Macro doit supporter une résolution automatique assistée par IA des merge conflicts produits par ses propres opérations de merge automatisées.

Cette résolution automatique ne concerne que les conflits issus des merges pilotés par le logiciel et non les situations externes arbitraires.

---

## 16. Règles Git et exécution

### 16.1 Le lien entre planification et Git

Dans Macro, la planification n'est pas séparée de la structure d'exécution Git.

La validation d'un plan doit préparer :
- les branches
- les worktrees
- la trace metadata correspondante

### 16.2 Exigence de propreté

Lorsqu'un plan ou une structure d'exécution de plan est supprimé avant réel démarrage, Macro doit nettoyer les branches associées et les structures temporaires afin d'éviter les artefacts parasites.

### 16.3 Commits multi-projets

Quand une même tâche affecte plusieurs projets :
- la validation reste une seule action cohérente du point de vue du produit
- les commits peuvent être créés séparément par projet
- chaque message de commit doit refléter les changements effectifs du projet concerné

---

## 17. Règles du mode Chat

### 17.1 Objectif

Le mode Chat existe pour des interactions légères et indépendantes des projets.

### 17.2 Modèle de contexte

Le mode Chat ne doit pas supposer un contexte agent autonome à l'échelle d'un workspace.

Il doit fonctionner sur :
- la conversation courante
- les fichiers explicitement attachés
- les outils externes explicitement autorisés

### 17.3 Pièces jointes

Les fichiers attachés en mode Chat sont limités à la conversation.

Il n'y a pas d'exigence de bibliothèque de contexte réutilisable entre plusieurs conversations.

### 17.4 Historique

Le mode Chat doit conserver un historique local des conversations.

Une future synchronisation de cet historique peut exister plus tard, mais ne fait pas partie du comportement local minimal.

### 17.5 Accès outils

Le mode Chat peut accéder :
- au web
- à certains outils MCP
- aux skills activées par l'utilisateur

La disponibilité de ces outils doit être configurable.

---

## 18. Skills

### 18.1 Objectif fonctionnel

Les skills permettent à l'utilisateur d'ajouter des instructions agent réutilisables sans modifier le code de Macro.

Elles servent à orienter le comportement de l'IA dans Architect, Implement et Chat. Elles ne remplacent pas MCP et ne doivent pas créer de nouveaux outils externes arbitraires.

### 18.2 Format et sources

Une skill locale est un dossier contenant :

- `SKILL.md` prioritaire (`skill.md` est accepté en compatibilité avec diagnostic)
- frontmatter YAML AgentSkills avec `name` et `description`
- champs optionnels `license`, `compatibility`, `allowed-tools` et `metadata`
- dossiers optionnels `references/`, `assets/` et `scripts/`

Macro découvre les sources projet et utilisateur suivantes :

- les skills projet dans `.agents/skills`
- les skills globales utilisateur dans `~/.agents/skills`
- les variantes compatibles Codex dans `.codex/skills` et `~/.codex/skills`
- les variantes compatibles OpenCode dans `.opencode/skills`, `.opencode/skill`, `~/.config/opencode/skills`, `~/.config/opencode/skill`, `~/.opencode/skills` et `~/.opencode/skill`
- les variantes compatibles Claude dans `.claude/skills` et `~/.claude/skills`
- l'import local par copie vers `~/.agents/skills/<skill-name>`

Elle ne supporte pas encore :

- l'installation directe depuis GitHub
- une marketplace

La validation est lenient pour l'usage mais explicite dans l'UI :

- `isValid` signifie que Macro peut charger la skill
- `specCompliant` signifie que la skill respecte strictement les contraintes AgentSkills
- les diagnostics distinguent erreurs bloquantes et warnings de compatibilité
- les noms de skills sont comparés après normalisation Unicode NFKC
- les lettres et chiffres Unicode minuscules sont acceptés; uppercase, underscores, tirets en début/fin, doubles tirets et mismatch avec le dossier restent des warnings lenient
- tout champ de frontmatter hors `name`, `description`, `license`, `compatibility`, `metadata` et `allowed-tools` produit un warning `unexpected_frontmatter_field`

### 18.3 Activation et contexte

Les skills découvertes sont désactivées par défaut.

L'utilisateur peut les activer dans les réglages Skills. Il peut aussi référencer une skill dans le composeur via sélection explicite ou mention `$skill-name`.

Macro doit charger les skills progressivement :

- catalogue compact au tour agent
- contenu complet de `SKILL.md` seulement sur activation
- ressources et scripts seulement via les outils dédiés

En cas de collision de nom, Macro choisit une skill effective de façon déterministe : projet avant global, puis `.agents`, `.codex`, `.opencode`, `.claude`, puis chemin lexical stable. Le catalogue agent et `$skill-name` ne voient que cette skill effective. Les skills shadowed restent visibles dans les réglages et sélectionnables explicitement par id/source.

Les manifests sont transport-neutres. Les chemins locaux (`rootPath`, `skillFilePath`) restent présents pour les skills locales mais sont optionnels; `location.kind`, `location.uri` et `contentHash` sont les identifiants préférés pour les skills remote ou bundled.

### 18.4 Sécurité

Une skill peut être activée sans être trusted.

Les scripts restent indisponibles tant que la skill n'est pas trusted et que l'option scripts n'est pas activée pour cette skill.

`allowed-tools` est une information déclarative de la skill. Elle ne contourne jamais les modes Macro, la politique d'approbation, le niveau de risque ou les réglages utilisateur.

Toute exécution de script doit passer par la politique d'approbation Macro des outils à risque, capturer la sortie, appliquer un timeout et éviter l'injection de secrets par défaut.

Les chemins hors dossier skill, traversals, fichiers cachés non autorisés et symlinks sortants doivent être refusés.

### 18.5 Cible future : remote et cloud

Cette section décrit un contrat technique potentiel pour une future ligne remote. Elle ne correspond à aucune capacité produit disponible en 0.1. Un runtime remote pourrait exposer les skills sans filesystem local lisible par le frontend avec les opérations :

- `POST /skills/list`
- `POST /skills/get`
- `POST /skills/read-resource`
- `POST /skills/run-script`

Les payloads publics côté frontend utilisent le camelCase. Les kernels distants doivent pouvoir répondre `unsupported`; 404, 405 et 501 sont présentés à l'utilisateur comme une capacité indisponible précise.

La capacité `skills` contrôle `skill_activate` et `skill_read_resource`. La capacité séparée `skillScripts` contrôle `skill_run_script`; elle est false par défaut en remote et doit être déclarée explicitement avant qu'un script cloud soit proposé au modèle.

---

## 19. Modèle d'automatisation et de notification

### 19.1 Appels d'attention

Lorsque l'IA a besoin de l'utilisateur, Macro doit rendre cette demande d'attention explicite.

Exemples :
- question de clarification
- review requise
- blocage d'exécution
- problème d'intégration

### 19.2 Continuité desktop et mobile

La cible produit inclut une supervision distante depuis une application mobile compagnon.

L'utilisateur doit pouvoir :
- suivre l'avancement des tâches
- recevoir les questions
- répondre aux décisions attendues
- reviewer et valider à distance

La création complète de plans depuis mobile n'est pas un besoin central initial.
La supervision distante du mode Implement est la priorité.
Dans la ligne 0.1, cette continuité reste une cible produit : le support stable concerne d'abord l'expérience desktop local-first.

### 19.3 Périmètre des notifications

Le système de notification desktop fait partie du produit actuel. L'activation globale des notifications in-app est une préférence locale, sans compte applicatif. Chaque catégorie importante peut aussi être configurée par canal.

Les notifications doivent au minimum couvrir :
- besoin d'attention sur une tâche
- review requise
- exécution bloquée
- exécution terminée

Si le runtime ne supporte pas les notifications bureau, les modes bureau ne doivent pas être proposés et une configuration bureau déjà persistée doit retomber sur une notification in-app plutôt que perdre l'événement.

---

## 20. Cible future : kernel distant et continuité d'exécution

### 20.1 Périmètre

Le kernel distant n'est pas une capacité du produit 0.1. Aucun mode remote ne doit être présenté comme disponible ou supporté dans l'application actuelle.

Une future ligne produit pourra permettre à l'exécution Macro de continuer indépendamment d'une seule session GUI locale. La fondation présente dans le dépôt reste expérimentale et interne jusque-là.

### 20.2 Résultats fonctionnels attendus

Un futur kernel produit devra rendre possibles :
- l'exécution distante des IA
- la continuité entre plusieurs machines desktop
- l'exécution continue sur une machine dédiée ou un serveur hébergé
- la supervision distante depuis un client Macro ou mobile

### 20.3 Scénarios utilisateurs cibles

Une future ligne remote pourra viser les scénarios suivants :

- l'utilisateur démarre sur un desktop puis reprend la supervision sur un laptop
- l'utilisateur quitte son poste et poursuit la supervision depuis mobile
- l'utilisateur exécute Macro sur un serveur dédié au lieu d'un poste local unique

---

## 21. Réglages et contrôle utilisateur

Macro doit exposer un contrôle utilisateur sur au moins les dimensions suivantes :

- fournisseurs et modèles IA
- disponibilité des outils par mode
- activation, confiance et scripts des skills
- niveau d'automatisation de l'implémentation
- configuration du workflow Git
- préférences d'apparence et d'interaction
- raccourcis
- prompts et cadrage du comportement système

La dictée vocale est une action propre du composer, placée immédiatement à
gauche du bouton d'envoi. Un premier clic démarre l'enregistrement et remplace
temporairement la zone d'édition par une visualisation audio. L'utilisateur peut
ensuite arrêter la capture pour transcrire et insérer le texte à la position
d'édition courante, ou arrêter, transcrire et envoyer immédiatement avec l'action
d'envoi dédiée. Dès l'arrêt, la forme d'onde enregistrée reste visible avec une
variation d'amplitude progressive, sans changement de couleur, jusqu'à la
réception de la transcription. Si le nettoyage est activé, le texte brut apparaît
ensuite immédiatement dans le composer avec un balayage discret
sur le texte jusqu'à son remplacement par la version corrigée. L'envoi demandé
attend cette correction ou son fallback vers la transcription brute. Durant ce
nettoyage, le texte reste non modifiable, mais le composer demeure défilable.

Les réglages de dictée doivent permettre de choisir la langue, la durée maximale
d'enregistrement et un fournisseur activé. Les fournisseurs de reconnaissance
vocale sont distincts des fournisseurs de chat. Macro prend en charge les
protocoles OpenAI-compatible et Deepgram, y compris les endpoints locaux
configurables. L'interface doit indiquer clairement si l'audio reste local ou est
envoyé à un service distant. Un fournisseur déclaré local ou sans clé peut utiliser
HTTP pour joindre un service de confiance sur la machine ou le réseau local ; tout
fournisseur distant authentifié doit utiliser HTTPS.

Un nettoyage intelligent facultatif peut faire relire le texte transcrit par le
modèle actif de la conversation. Il corrige les erreurs probables de
reconnaissance, les hésitations, les répétitions et la ponctuation, et peut
reformuler librement les phrases pour rendre le prompt clair et fluide. Il
s'appuie sur un contexte compact : mode actif, projet, plan, tâche, brouillon et
au maximum les deux derniers messages, tous limités à de courts extraits. Il ne
doit ni répondre au prompt, ni le traduire, inventer des informations ou modifier
son intention et ses contraintes. Cette option est désactivée par défaut. Les
blocs de raisonnement éventuels du fournisseur sont ignorés. Une réponse vide,
une erreur réseau ou un modèle indisponible ne doit jamais faire perdre la
dictée : Macro conserve alors la transcription brute et peut tout de même
l'insérer ou l'envoyer.

Le fournisseur vocal géré `andrologic-speech`, affiché sous le nom Andrologic,
est sélectionné par défaut lorsqu'aucun choix vocal n'a encore été persisté. Il
utilise le modèle public `macro-transcription` sur le gateway Andrologic et
réemploie le jeton d'installation sécurisé du fournisseur `macro-ai`. Aucune clé
utilisateur supplémentaire n'est demandée et aucun secret statique n'est inclus
dans le dépôt ou l'exécutable. Avant l'envoi, Macro convertit la capture en WAV
mono PCM 16 bits à 16 kHz. Le gateway ne conserve jamais l'audio brut ; le texte
transcrit et les métadonnées opérationnelles de la requête figurent dans ses
journaux. En cas de saturation ou d'indisponibilité temporaire, Macro présente
l'erreur renvoyée par le gateway sans envoyer automatiquement une seconde fois
le même enregistrement.

Andrologic est le fournisseur sélectionné par défaut lorsqu'il a pu être activé
et qu'aucune sélection de conversation existante ne doit être restaurée. Il
présente un seul modèle nommé `Macro AI`, inclus dans la bêta. L'interface doit
indiquer clairement que les conversations envoyées à ce fournisseur ainsi que
les métriques d'usage en tokens sont journalisées sur le serveur d'inférence.
L'utilisateur reste libre de sélectionner un autre fournisseur configuré. Le
menu de sélection compact le présente comme une IA incluse avec la bêta, tandis
que les réglages du fournisseur conservent l'information complète sur la
journalisation.

Le produit doit permettre à l'utilisateur de modeler le comportement de l'IA sans nécessiter de modification de code.

Tout raccourci clavier configurable dans les réglages doit correspondre à une
action runtime câblée et à une règle de disponibilité explicite. Si un raccourci
est visible dans les réglages, son effet attendu doit être vérifié par un test
automatisé couvrant le contexte nominal et les contextes où il doit rester inactif.

Matrice fonctionnelle des raccourcis configurables :

| Raccourci | Effet attendu | Contexte |
| --- | --- | --- |
| Ouvrir les réglages | Ouvre les réglages généraux | Global |
| Fermer les réglages | Ferme la modale de réglages | Réglages ouverts |
| Nouvelle conversation | Crée une conversation Chat | Mode Chat |
| Passer en Architect | Active le mode Architect | Hors réglages |
| Passer en Implement | Active le mode Implement | Hors réglages |
| Passer en Chat | Active le mode Chat | Hors réglages |
| Basculer panneau gauche | Ouvre ou ferme le panneau gauche | Global |
| Basculer panneau droit | Ouvre ou ferme le panneau droit | Global |
| Fournisseur suivant | Sélectionne le fournisseur IA suivant disponible | Global |
| Modèle suivant | Sélectionne le modèle IA suivant disponible | Global |
| Stopper le streaming | Arrête la réponse assistant en cours | Réponse en cours |
| Focus input Chat | Place le focus dans le compositeur Chat | Global |
| Prompt précédent | Navigue dans l'historique de prompts vers le précédent | Compositeur focus et mode historique par raccourci |
| Prompt suivant | Navigue dans l'historique de prompts vers le suivant | Compositeur focus et mode historique par raccourci |

---

## 22. Données, audit et trace historique

### 22.1 Auditabilité

Macro doit conserver suffisamment de métadonnées pour auditer :
- ce qui a été planifié
- comment cela a été structuré
- ce qui a été exécuté
- où un éventuel problème a pu apparaître

### 22.2 Nature historique des artefacts de planification

La conversation, les nœuds de stratégie et les branches prédictives sont durables comme historique, mais pas comme objets pilotés du futur une fois le plan clos.

Leur utilité principale après exécution est :
- l'audit
- la rétrospective
- la traçabilité

### 22.3 Persistance des métadonnées

Les métadonnées liées aux plans doivent être stockées dans la structure metadata de Macro afin que l'historique ne soit pas perdu.

---

## 23. Exclusions publiques

Les éléments suivants sont exclus de la surface fonctionnelle publique tant qu'ils ne sont pas promus explicitement :

- les workflows internes de debug
- les outils d'inspection réservés au développement de Macro
- les détails internes d'implémentation runtime ou backend

Ces éléments peuvent exister dans l'application, mais ils ne font pas partie du contrat produit utilisateur.

---

## 24. Règles produit non négociables

Les règles suivantes sont fondatrices :

- Le développeur est le pilote ; l'IA est l'exécutant.
- Le mode Architect est le cœur structurant du produit.
- Le mode Implement est piloté par les tâches et orienté review-first.
- Le mode Chat est léger et independant.
- Le multi-projet est une capacité de premier plan.
- Un plan contient sa conversation et sa stratégie.
- Plusieurs plans peuvent coexister en parallèle.
- Les plans archives restent lisibles mais non modifiables.
- La stratégie est générée par l'IA à partir de la conversation et du contexte du projet, après une demande explicite.
- La validation d'un plan prépare automatiquement branches et worktrees.
- Toute tâche complétée se termine par un commit.
- Une review humaine est obligatoire à la fin de chaque tâche.
- Une tâche de finalisation synthétique converge depuis les feuilles de la stratégie et pilote l'intégration finale.
- L'édition manuelle du code existe, mais comme mécanisme secondaire d'ajustement en review.
- Les skills guident l'agent sans contourner la politique d'outils.
- Le support du kernel distant fait partie de la cible produit.

---

## 25. Règles de maintenance du document

Ce document doit être mis à jour lorsque :
- un workflow utilisateur change
- une règle produit change
- une nouvelle capacité publique devient une partie du contrat fonctionnel

Ce document ne doit pas être modifié pour :
- des détails d'implémentation bas niveau
- des refactors internes sans impact produit
- des expérimentations temporaires qui ne font pas partie de la cible produit
