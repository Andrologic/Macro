# Macro - Specification Fonctionnelle

## 1. Objet du document

Ce document definit la cible fonctionnelle de Macro en tant que produit fini.

Il decrit :
- ce qu'est Macro
- ce que Macro doit permettre à un developpeur de faire
- comment les principaux workflows doivent fonctionner
- quelles regles utilisateur constituent le contrat fonctionnel du produit

Ce document n'est pas un plan d'implementation.
Les écarts entre la cible et l'état courant, les phases de livraison et les priorités relèvent de `docs/roadmap.md`.

Sauf mention explicite contraire, les exigences de ce document decrivent le comportement produit attendu, y compris quand certaines capacites ne sont pas encore entierement stabilisees dans l'application.
Pour la ligne 0.1, le contrat public prioritaire reste le workflow desktop local-first. Les capacites remote, mobile, compte et abonnement decrites ici sont des cibles produit ou des zones best-effort tant qu'elles ne sont pas promues explicitement par la roadmap et les notes de support.

---

## 2. Positionnement du produit

### 2.1 Promesse produit

Macro est un environnement de developpement qui organise le vibe-coding en transformant le developpeur en architecte et pilote de l'exécution par l'IA plutot qu'en producteur direct du code.

Utiliser Macro doit ressembler au travail d'un senior ou d'un lead technique qui briefe, coordonne et contrôle une equipe d'executeurs IA juniors.

### 2.2 Philosophie centrale

Macro repose sur les principes suivants :

- Le developpeur est le pilote, pas le simple redacteur du code.
- L'IA produit l'essentiel du code.
- La planification doit preceder l'exécution des que le scope le justifie.
- Le travail doit rester auditable.
- La review est une activite de premier ordre.
- Le multi-projet est un cas natif, pas un cas limite.
- Le produit doit permettre une continuite d'exécution entre plusieurs machines et, a terme, entre desktop, mobile et environnement distant.

### 2.3 Objectif principal

Macro doit permettre à un developpeur de definir le travail une fois, de le structurer clairement, de deleguer l'essentiel de l'implementation a l'IA et de continuer a superviser l'exécution sans rester attache à une seule machine.

---

## 3. Perimetre du produit

### 3.1 Dans le perimetre

Macro doit couvrir :

- la planification et la structuration du travail d'ingenierie
- la derivation de tâches executables à partir d'un plan
- l'exécution de tâches avec assistance IA
- la review des changements avant validation finale
- la coordination de plusieurs projets relies dans un meme espace de travail
- la conservation d'une trace d'audit des plans et de l'exécution
- a terme, la poursuite de l'exécution depuis une autre machine ou depuis un flux de supervision mobile ou distant

### 3.2 Hors perimetre

Macro n'a pas vocation a être :

- un IDE generique centre sur l'ecriture manuelle du code
- un remplacement des plateformes classiques de gestion de depot
- un simple chat generaliste sans workflow de developpement
- une interface publique pour les outils internes de debug de l'application

Le perimetre fonctionnel public repose sur les modes `Architect`, `Implement` et `Chat`.

---

## 4. Utilisateurs cibles

Macro s'adresse principalement a des developpeurs qui :

- travaillent deja avec des IA dans leur workflow
- ont besoin de plus de structure qu'un simple chat IA
- veulent superviser l'implementation plutot que tout coder eux-memes
- travaillent sur un ou plusieurs depots relies
- peuvent avoir besoin de continuer la supervision loin de leur machine principale

Macro suppose que l'utilisateur agit comme un decideur technique, meme lorsqu'il travaille seul.

---

## 5. Modele fonctionnel general

### 5.1 Modele mental principal

Macro organise le travail de la façon suivante :

1. l'utilisateur formule une intention
2. l'IA extrait et structure les besoins
3. l'IA génère une stratégie
4. la stratégie est validee
5. les tâches d'implementation sont executees dans l'ordre voulu avec un maximum de parallelisme possible
6. l'utilisateur review les résultats
7. le code est committe et integre

### 5.2 Unites fonctionnelles principales

Macro s'appuie sur les unites suivantes :

- workspace
- groupe de projets
- projet
- plan
- conversation
- besoin
- noeud de stratégie
- branche prédictive
- tâche d'implementation
- session de review

Ces unites sont definies dans la section suivante.

---

## 6. Concepts coeur

### 6.1 Workspace

Le workspace est l'environnement actif dans lequel Macro opere.

Il contient :
- un ou plusieurs groupes de projets
- un ou plusieurs projets
- l'état local de l'application
- les métadonnées necessaires a l'audit de la planification et de l'exécution

### 6.2 Groupe de projets

Un groupe de projets est un conteneur logique permettant de travailler sur plusieurs projets relies comme sur un seul systeme coherent.

Exemples :
- une application mobile et un site web
- un frontend et un backend
- plusieurs clients plateformes pour un meme produit

Le groupe est le contexte fonctionnel principal pour le travail coordonne.

### 6.3 Projet

Un projet est une codebase technique individuelle, generalement adossee a son propre depot.

Un projet appartient à un groupe de projets.

### 6.4 Plan

Un plan est l'unite principale de travail en mode Architect.

Un plan contient :
- une conversation dediee
- les besoins extraits pendant la phase de planification
- la stratégie generee
- la structure prédictive de branches associee a cette stratégie
- les artefacts de relais produits par les tâches planifiees pour transmettre de l'information aux tâches dependantes

Un plan sert a definir une vague de travail coherente.

Exemples typiques :
- une grosse fonctionnalite
- une vague d'ameliorations ciblee
- un lot de livraison coherent

Plusieurs plans peuvent exister en parallèle pour un meme groupe de projets.

Plusieurs plans peuvent aussi être actifs en parallèle si leur exécution peut progresser simultanément.

Lorsqu'un plan est termine, il est archivé.
Un plan archivé reste consultable pour l'audit et l'historique, mais n'est plus destiné a être modifié.

### 6.5 Besoin

Un besoin est une exigence structuree identifiee par l'IA à partir de la conversation de planification.

Les besoins ne sont pas saisis manuellement via un formulaire dedie.
L'utilisateur exprime son intention de façon conversationnelle et l'IA formalise les besoins à partir de cet échange.

Les besoins sont des artefacts historiques de planification.

### 6.6 Noeud de stratégie

Un noeud de stratégie est une unite de la stratégie d'un plan generee par l'IA.

Un noeud peut representer :
- une tranche fonctionnelle
- une etape technique
- un jalon de dependance
- une unite d'exécution proche de la tâche

Les noeuds de stratégie definissent l'ordre, les dependances et la structure d'exécution.

Un noeud peut aussi declarer des contrats d'artefacts attendus. Ces contrats decrivent les informations critiques qu'une tâche devra produire pour ses descendantes, par exemple des résultats d'audit, une carte de migration, un contrat d'API ou un registre de risques.

### 6.7 Branche prédictive

Une branche prédictive est un artefact de planification qui représente la façon dont le travail doit être découpé dans Git pendant l'exécution.

Son but est de :
- organiser l'exécution
- maximiser le parallelisme lorsque cela reste sans risque
- conserver une branche de travail distincte par tâche executable
- reduire la dérive de l'IA et les changements trop volumineux

### 6.8 Tache d'implementation

Une tâche d'implementation est une unite de travail executable derivee de la stratégie.

La tâche est l'unite suivie dans le mode Implement.

Une tâche terminee avec succes se conclut toujours par un commit.

La plupart des tâches sont creees à partir d'un plan valide, mais Macro doit aussi supporter des tâches autonomes pour les quick fixes ou les petites features ne justifiant pas un plan complet.

### 6.9 Artefact de relais

Un artefact de relais est une information durable produite par une tâche issue d'un plan Architect.

Il sert a transmettre du contexte exploitable aux tâches qui dependent directement ou indirectement de la tâche productrice.

Les artefacts de relais :
- sont rattaches à un plan et à une tâche productrice
- sont stockes dans les métadonnées `@macro`, pas dans le code source applicatif
- peuvent être déclarés à l'avance par la stratégie ou produits librement par l'agent Implement
- ne sont visibles que par la tâche productrice, ses descendantes et la tâche synthetique de finalisation du plan
- ne sont pas partages entre tâches paralleles sans dependance
- sont affiches dans le panneau des changements comme un sous-projet `Artifacts`, avec revue et validation metadata separees du staging Git
- peuvent superseder un artefact herite en creant une nouvelle version rattachee à la tâche courante, sans ecraser la version parente
- restent limites en v1 a du contenu texte, Markdown ou JSON

---

## 7. Modes

Macro expose trois modes produits dans son perimetre public :

- Architect
- Implement
- Chat

Le mode `Debug` ne fait plus partie de l'application ni de la specification fonctionnelle publique.

### 7.1 Mode Architect

Le mode Architect est le mode de planification et de structuration.

Son objectif est de permettre à l'utilisateur de :
- exprimer une intention
- definir ou affiner le scope du travail
- laisser l'IA extraire les besoins
- generer une stratégie
- valider la structure d'exécution attendue

Le mode Architect constitue le coeur methodologique de Macro.

Fonctionnellement, il correspond au moment ou un senior ou un lead technique briefe une equipe avant exécution.

Le mode Architect doit supporter :
- une conversation par plan
- des besoins générés par l'IA
- une stratégie generee par l'IA
- la declaration d'artefacts critiques attendus par tâche
- une visualisation des dependances et de la structure prédictive
- la validation d'un plan
- la préparation automatique de la structure d'exécution après validation

Le mode Architect n'est pas un simple mode descriptif.
Il doit preparer concretement la suite de l'implementation.

### 7.2 Mode Implement

Le mode Implement est le mode d'exécution et de review.

Son objectif est de :
- executer les tâches derivees d'un ou plusieurs plans
- gérer les questions de l'IA pendant l'exécution
- presenter les changements générés pour review
- permettre un ajustement humain si necessaire
- valider et committer le travail tâche par tâche

Le mode Implement doit supporter :
- une file de tâches issue de plusieurs plans
- le filtrage des tâches par plan et par autres criteres pertinents
- la prise en compte explicite des dependances et de l'état de disponibilité d'une tâche
- la consultation des artefacts herites depuis les tâches parentes et la production d'artefacts pour les tâches dependantes
- une review en fin de tâche
- une validation globale du plan avant merge du plan vers la branche de base

Le mode Implement repose sur un demarrage manuel de l'exécution des tâches.

### 7.3 Mode Chat

Le mode Chat est un mode de support independant.

Son objectif est de permettre à l'utilisateur de :
- poser des questions rapides d'ordre technique ou documentaire
- attacher des fichiers à une conversation
- utiliser certains outils web et MCP
- conserver une continuite de travail dans l'application sans entrer dans tout le workflow Macro

Le mode Chat n'est pas rattaché par défaut à un contexte projet autonome.

Il se distingue du mode Implement en ce que :
- il n'est pas pilote par une stratégie de plan
- il ne travaille pas par défaut sur un contexte d'exécution de projet
- il ne parcourt pas un workspace complet en mode agent
- il fonctionne conversation par conversation avec un contexte explicitement fourni

Le mode Chat doit conserver un historique local des conversations.

---

## 8. Structure generale de l'interface

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

Le panneau gauche doit accueillir le contexte lateral principal du mode courant.

Exemples :

- besoins du plan en mode Architect
- file de tâches en mode Implement
- historique ou navigation de conversations en mode Chat

### 8.4 Zone centrale

La zone centrale doit rester le coeur operationnel de l'application.

Elle doit principalement accueillir :

- la conversation
- les actions de supervision
- les decisions de pilotage
- les interactions avec l'IA

### 8.5 Panneau droit

Le panneau droit doit accueillir les surfaces de lecture, de visualisation ou de validation liées au mode courant.

Exemples :

- graphe de stratégie
- review des changements
- contexte, outils ou sources

### 8.6 Footer

Le footer doit exposer les informations et actions globales de statut.

Exemples :

- état Git
- état metadata `@macro`
- actions de sync
- statut global du contexte courant

### 8.7 Modales

Les modales servent aux opérations ponctuelles qui ne doivent pas surcharger la surface principale.

Exemples :

- creation de projet
- navigation projet
- visualisation de diff
- reglage de l'application
- consultation de compte

---

## 9. Structure projet et multi-projet

### 9.1 Le multi-projet comme capacité centrale

Le multi-projet est une capacité centrale du produit.

Macro doit traiter plusieurs codebases reliees comme un contexte de developpement coordonne des que cela a du sens.

L'utilisateur doit pouvoir :
- creer un groupe logique pour un produit ou un systeme
- rattacher plusieurs sous-projets a ce groupe
- laisser l'IA travailler avec conscience des relations entre ces projets

### 9.2 Cas d'usage attendus

Exemples de cas multi-projets natifs :

- application mobile plus site web
- frontend plus backend
- application iOS plus application Android plus API partagee

Le produit doit permettre de coordonner l'implementation sur ces projets dans un seul workflow structure.

### 9.3 Comportement des plans dans un contexte multi-projet

Lorsqu'un plan concerne plusieurs projets, le plan doit exister dans l'historique metadata de chaque projet implique.

Cette duplication est volontaire.

Elle sert a :
- conserver l'auditabilite
- maintenir la trace historique meme si un sous-projet est ensuite detache
- éviter la perte de contexte au niveau d'un depot individuel

### 9.4 Visibilite des tâches

Le mode Implement doit supporter des tâches issues :
- de plusieurs plans
- de plusieurs projets
- de plusieurs depots dans un meme groupe

L'interface doit permettre d'identifier clairement :
- a quel plan appartient une tâche
- quel ou quels projets elle affecte
- quel est son état de dependance

L'interface doit aussi permettre de filtrer les tâches par plan.

---

## 10. Cycle de vie des projets

### 10.1 Creation de projet

Macro doit permettre la creation d'un projet depuis l'interface.

La creation d'un projet doit permettre au minimum de definir :

- un nom
- un groupe cible optionnel
- un chemin local optionnel

### 10.2 Import de projet Git

Macro doit permettre l'import d'un projet existant de type Git.

L'import doit permettre au minimum de definir :

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

### 10.4 Selection du contexte

Macro doit permettre de changer explicitement de contexte de travail :

- au niveau du groupe
- au niveau du projet

Le changement de contexte doit restaurer l'état local utile autant que possible, notamment pour les conversations, plans et tâches lies au projet.

---

## 11. Cycle de vie d'un plan

### 11.1 Creation du plan

L'utilisateur créé un plan depuis le mode Architect.

Creer un plan créé un nouveau contexte de planification comprenant :
- sa conversation propre
- ses besoins propres
- sa stratégie propre

### 11.2 Generation du plan

L'utilisateur exprime ses objectifs de façon conversationnelle.

L'IA doit :
- deriver les besoins à partir de la conversation
- construire une stratégie à partir de ces besoins
- organiser cette stratégie pour maximiser le parallelisme lorsque cela reste sans risque
- maintenir chaque unite d'exécution à une taille limitee pour reduire la confusion de l'IA et les changements trop larges

### 11.3 Validation du plan

Lorsqu'un plan est valide :
- la préparation des branches et des worktrees doit se faire automatiquement
- cette préparation est obligatoire
- la structure d'exécution doit être prête pour le mode Implement

### 11.4 Execution du plan

Un plan valide peut entrer en exécution pendant que d'autres plans restent actifs en parallèle.

### 11.5 Completion du plan

Un plan est considere comme termine lorsque :
- toutes les tâches requises sont completees
- la validation globale du plan est realisee
- la branche du plan est acceptee pour integration dans la branche de base configuree

### 11.6 Archivage du plan

Les plans terminés doivent être archivés.

Les plans archivés doivent rester accessibles pour :
- la lecture
- l'audit
- l'analyse retrospective

Ils ne sont plus destinés a être modifiés.

---

## 12. Regles de generation de stratégie

### 12.1 L'IA est responsable de la formalisation

Les besoins et la stratégie sont générés par l'IA et non saisis manuellement dans un formalisme rigide.

L'utilisateur peut influencer le resultat par la conversation et les prompts, mais l'IA reste responsable de la structuration.

### 12.2 Objectifs de la stratégie

La stratégie doit :
- refleter l'intention utilisateur
- definir un ordre d'exécution realiste
- maximiser le parallelisme lorsque c'est sur
- exprimer le sequentiel par des dependances explicites entre tâches
- minimiser les commits trop volumineux et les frontieres de tâches floues

### 12.3 Structuration par branches

La stratégie doit organiser le travail de sorte que :
- plusieurs branches puissent progresser en parallèle
- chaque tâche executable dispose de sa propre branche de travail
- les tâches sequentielles soient reliees par des dependances explicites
- les branches de tâche convergent vers la branche d'integration du plan

Cette structuration existe pour reduire le risque et ameliorer la qualité des reviews.

---

## 13. Modele de tâche

### 13.1 Taches planifiees

La plupart des tâches sont derivees automatiquement d'un plan valide.

Ces tâches heritent :
- du contexte du plan
- de l'ordre d'exécution
- de la structure de branche
- des associations projet

### 13.2 Taches autonomes

Macro doit aussi supporter des tâches autonomes en dehors de tout plan.

Ces tâches servent aux :
- petits correctifs
- oublis mineurs
- petites features ne justifiant pas un cycle complet de planification

Les tâches autonomes doivent tout de meme supporter :
- l'exécution par IA
- la review
- le commit

Les tâches autonomes sont mergees directement vers la branche de base configuree plutot que via une branche de plan.

### 13.3 Regle de completion

Une tâche ne peut pas être considérée comme complète sans commit.

---

## 14. Comportement du mode Implement

### 14.1 Conditions de demarrage

Dans le mode Implement :
- les tâches ne se lancent pas toutes seules
- l'utilisateur déclenche explicitement le début de la tâche
- l'utilisateur peut fournir un prompt initial ou un cadrage complementaire avant l'exécution

### 14.2 Gestion des questions

Au début d'une tâche, l'IA peut :
- poser des questions de clarification si necessaire
- ne poser aucune question si la tâche est suffisamment claire

Quand l'IA pose des questions, Macro doit privilégier une interaction rapide.

Le modèle privilegie est :
- trois reponses suggerees
- une quatrieme voie libre pour une reponse personnalisee

Ce modèle existe pour reduire le frottement utilisateur et faciliter la supervision depuis mobile.

### 14.3 Travail d'exécution

Pendant l'exécution d'une tâche, l'IA peut :
- inspecter le contexte necessaire
- modifier des fichiers
- lancer des tests
- lancer un build
- preparer des changements pour review

### 14.4 Review humaine

Une review humaine est obligatoire à la fin de chaque tâche.

La review de tâche doit presenter :
- la liste des fichiers modifiés
- l'accès aux diffs
- suffisamment de contexte fichier pour comprendre le changement

L'utilisateur doit pouvoir :
- inspecter les changements
- approuver le resultat
- demander des ameliorations
- apporter de petits ajustements manuels

### 14.5 Edition manuelle autorisee pendant la review

Macro doit rester majoritairement en lecture seule.

Cependant, la review doit permettre un ajustement manuel cible.

L'experience de review doit prioriser :
- l'edition des lignes modifiees par l'IA

Elle doit aussi permettre :
- de charger davantage de contexte autour du changement
- de charger le fichier complet si necessaire
- de modifier en dehors de la zone initialement changee lorsque cela s'impose

L'edition manuelle est secondaire, mais elle doit exister.

### 14.6 Perimetre de validation

La validation humaine porte principalement sur la qualité et la justesse du code généré.

Les résultats des tests et du build doivent être visibles pour l'utilisateur, mais ils ne constituent pas la surface principale de review.

Les messages de commit doivent être générés automatiquement par l'IA après validation utilisateur.

---

## 15. Modele de review et d'integration

### 15.1 Validation a l'echelle de la tâche

Chaque tâche completee doit se conclure par :
- une review du code
- une validation utilisateur
- la generation d'un commit

### 15.2 Validation a l'echelle du plan

Lorsque toutes les tâches d'un plan sont terminees, Macro doit imposer une validation globale du plan avant merge du plan vers la branche de base configuree.

Cette validation est distincte de la review tâche par tâche.

### 15.3 Generation des commits

Apres acceptation de la review :
- l'IA doit generer le message de commit
- le commit doit être créé sur la branche appropriee

### 15.4 Structure des merges

Pour le travail dérivé d'un plan, le flux par défaut est :

- chaque tâche se fait sur une branche feature dediee rattachee au plan
- le travail valide est merge vers la branche d'integration du plan
- le plan valide est ensuite merge vers la branche de base configuree

Pour les tâches autonomes :

- le travail valide est merge directement vers la branche de base configuree

### 15.5 Merge conflicts

Macro doit supporter une résolution automatique assistée par IA des merge conflicts produits par ses propres opérations de merge automatisees.

Cette résolution automatique ne concerne que les conflits issus des merges pilotés par le logiciel et non les situations externes arbitraires.

---

## 16. Regles Git et exécution

### 16.1 Le lien entre planification et Git

Dans Macro, la planification n'est pas séparée de la structure d'exécution Git.

La validation d'un plan doit preparer :
- les branches
- les worktrees
- la trace metadata correspondante

### 16.2 Exigence de proprete

Lorsqu'un plan ou une structure d'exécution de plan est supprime avant reel demarrage, Macro doit nettoyer les branches associees et les structures temporaires afin d'éviter les artefacts parasites.

### 16.3 Commits multi-projets

Quand une meme tâche affecte plusieurs projets :
- la validation reste une seule action coherente du point de vue du produit
- les commits peuvent être créés separement par projet
- chaque message de commit doit refleter les changements effectifs du projet concerne

---

## 17. Regles du mode Chat

### 17.1 Objectif

Le mode Chat existe pour des interactions legeres et independantes des projets.

### 17.2 Modele de contexte

Le mode Chat ne doit pas supposer un contexte agent autonome a l'echelle d'un workspace.

Il doit fonctionner sur :
- la conversation courante
- les fichiers explicitement attaches
- les outils externes explicitement autorises

### 17.3 Pieces jointes

Les fichiers attaches en mode Chat sont scopes à la conversation.

Il n'y a pas d'exigence de bibliotheque de contexte reutilisable entre plusieurs conversations.

### 17.4 Historique

Le mode Chat doit conserver un historique local des conversations.

Une future synchronisation de cet historique peut exister plus tard, mais ne fait pas partie du comportement local minimal.

### 17.5 Acces outils

Le mode Chat peut acceder :
- au web
- a certains outils MCP
- aux skills activees par l'utilisateur

La disponibilité de ces outils doit être configurable.

---

## 18. Skills

### 18.1 Objectif fonctionnel

Les skills permettent à l'utilisateur d'ajouter des instructions agent reutilisables sans modifier le code de Macro.

Elles servent a orienter le comportement de l'IA dans Architect, Implement et Chat. Elles ne remplacent pas MCP et ne doivent pas creer de nouveaux outils externes arbitraires.

### 18.2 Format et sources

Une skill locale est un dossier contenant :

- `SKILL.md` prioritaire (`skill.md` est accepté en compatibilité avec diagnostic)
- frontmatter YAML AgentSkills avec `name` et `description`
- champs optionnels `license`, `compatibility`, `allowed-tools` et `metadata`
- dossiers optionnels `references/`, `assets/` et `scripts/`

Macro decouvre les sources projet et utilisateur suivantes :

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

Les chemins hors dossier skill, traversals, fichiers cachés non autorises et symlinks sortants doivent être refusés.

### 18.5 Remote et cloud

Un runtime remote peut exposer les skills sans filesystem local lisible par le frontend. Le contrat provider utilise les opérations :

- `POST /skills/list`
- `POST /skills/get`
- `POST /skills/read-resource`
- `POST /skills/run-script`

Les payloads publics cote frontend utilisent le camelCase. Les kernels distants doivent pouvoir repondre `unsupported`; 404, 405 et 501 sont presentes à l'utilisateur comme une capacité indisponible precise.

La capacité `skills` contrôle `skill_activate` et `skill_read_resource`. La capacité séparée `skillScripts` contrôle `skill_run_script`; elle est false par défaut en remote et doit être déclarée explicitement avant qu'un script cloud soit propose au modèle.

---

## 19. Modele d'automatisation et de notification

### 19.1 Appels d'attention

Lorsque l'IA a besoin de l'utilisateur, Macro doit rendre cette demande d'attention explicite.

Exemples :
- question de clarification
- review requise
- blocage d'exécution
- probleme d'integration

### 19.2 Continuite desktop et mobile

La cible produit inclut une supervision distante depuis une application mobile compagnon.

L'utilisateur doit pouvoir :
- suivre l'avancement des tâches
- recevoir les questions
- repondre aux decisions attendues
- reviewer et valider a distance

La creation complète de plans depuis mobile n'est pas un besoin central initial.
La supervision distante du mode Implement est la priorite.
Dans la ligne 0.1, cette continuite reste une cible produit : le support stable concerne d'abord l'experience desktop local-first.

### 19.3 Perimetre des notifications

Le systeme de notification fait partie de la cible produit meme s'il n'est pas encore entierement implemente.

Les notifications doivent au minimum couvrir :
- besoin d'attention sur une tâche
- review requise
- exécution bloquee
- exécution terminee

---

## 20. Kernel distant et continuite d'exécution

### 20.1 Le kernel distant est une capacité produit

Le kernel distant fait partie de la specification produit, et pas seulement de l'architecture technique.

Son role est de permettre a l'exécution Macro de continuer independamment d'une seule session GUI locale.
Dans la ligne 0.1, le kernel distant existe comme socle technique minimal et reste best-effort par rapport au workflow desktop local-first.

### 20.2 Resultats fonctionnels attendus

Le kernel doit rendre possibles :
- l'exécution distante des IA
- la continuite entre plusieurs machines desktop
- l'exécution continue sur une machine dediee ou un serveur heberge
- la supervision distante depuis un client Macro ou mobile

### 20.3 Scenarios utilisateurs cibles

Le produit doit supporter au minimum les scenarios suivants :

- l'utilisateur demarre sur un desktop puis reprend la supervision sur un laptop
- l'utilisateur quitte son poste et poursuit la supervision depuis mobile
- l'utilisateur execute Macro sur un serveur dedie au lieu d'un poste local unique

---

## 21. Reglages et contrôle utilisateur

Macro doit exposer un contrôle utilisateur sur au moins les dimensions suivantes :

- fournisseurs et modeles IA
- disponibilité des outils par mode
- activation, confiance et scripts des skills
- niveau d'automatisation de l'implementation
- configuration du workflow Git
- préférences d'apparence et d'interaction
- raccourcis
- prompts et cadrage du comportement systeme

Le produit doit permettre à l'utilisateur de modeler le comportement de l'IA sans necessiter de modification de code.

Tout raccourci clavier configurable dans les réglages doit correspondre à une
action runtime cablee et à une regle de disponibilité explicite. Si un raccourci
est visible dans les réglages, son effet attendu doit être verifie par un test
automatise couvrant le contexte nominal et les contextes ou il doit rester inactif.

Matrice fonctionnelle des raccourcis configurables :

| Raccourci | Effet attendu | Contexte |
| --- | --- | --- |
| Ouvrir les réglages | Ouvre les réglages generaux | Global |
| Fermer les réglages | Ferme la modale de réglages | Reglages ouverts |
| Nouvelle conversation | Cree une conversation Chat | Mode Chat |
| Passer en Architect | Active le mode Architect | Hors réglages |
| Passer en Implement | Active le mode Implement | Hors réglages |
| Passer en Chat | Active le mode Chat | Hors réglages |
| Basculer panneau gauche | Ouvre ou ferme le panneau gauche | Global |
| Basculer panneau droit | Ouvre ou ferme le panneau droit | Global |
| Fournisseur suivant | Selectionne le fournisseur IA suivant disponible | Global |
| Modele suivant | Selectionne le modèle IA suivant disponible | Global |
| Stopper le streaming | Arrete la reponse assistant en cours | Reponse en cours |
| Focus input Chat | Place le focus dans le compositeur Chat | Global |
| Prompt precedent | Navigue dans l'historique de prompts vers le precedent | Compositeur focus et mode historique par raccourci |
| Prompt suivant | Navigue dans l'historique de prompts vers le suivant | Compositeur focus et mode historique par raccourci |

---

## 22. Donnees, audit et trace historique

### 22.1 Auditabilite

Macro doit conserver suffisamment de métadonnées pour auditer :
- ce qui a ete planifie
- comment cela a ete structure
- ce qui a ete execute
- ou un eventuel probleme a pu apparaitre

### 22.2 Nature historique des artefacts de planification

Les besoins, noeuds de stratégie et branches predictives sont durables comme historique, mais pas comme objets pilotés du futur une fois le plan clos.

Leur utilité principale après exécution est :
- l'audit
- la retrospective
- la tracabilite

### 22.3 Persistance des métadonnées

Les métadonnées liées aux plans doivent être stockées dans la structure metadata de Macro afin que l'historique ne soit pas perdu.

---

## 23. Exclusions publiques

Les elements suivants sont exclus de la surface fonctionnelle publique tant qu'ils ne sont pas promus explicitement :

- les workflows internes de debug
- les outils d'inspection reserves au developpement de Macro
- les details internes d'implementation runtime ou backend

Ces elements peuvent exister dans l'application, mais ils ne font pas partie du contrat produit utilisateur.

---

## 24. Regles produit non negociables

Les regles suivantes sont fondatrices :

- Le developpeur est le pilote ; l'IA est l'executant.
- Le mode Architect est le coeur structurant du produit.
- Le mode Implement est pilote par les tâches et oriente review-first.
- Le mode Chat est leger et independant.
- Le multi-projet est une capacité de premier plan.
- Un plan contient sa conversation, ses besoins et sa stratégie.
- Plusieurs plans peuvent coexister en parallèle.
- Les plans archivés restent lisibles mais non modifiables.
- Les besoins et la stratégie sont générés par l'IA à partir de la conversation.
- La validation d'un plan prepare automatiquement branches et worktrees.
- Toute tâche completee se termine par un commit.
- Une review humaine est obligatoire à la fin de chaque tâche.
- Une tâche de finalisation synthetique converge depuis les feuilles de la stratégie et pilote l'integration finale.
- L'edition manuelle du code existe, mais comme mecanisme secondaire d'ajustement en review.
- Les skills guident l'agent sans contourner la politique d'outils.
- Le support du kernel distant fait partie de la cible produit.

---

## 25. Regles de maintenance du document

Ce document doit être mis à jour lorsque :
- un workflow utilisateur change
- une regle produit change
- une nouvelle capacité publique devient une partie du contrat fonctionnel

Ce document ne doit pas être modifié pour :
- des details d'implementation bas niveau
- des refactors internes sans impact produit
- des experimentations temporaires qui ne font pas partie de la cible produit
