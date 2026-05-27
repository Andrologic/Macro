# Macro - Specification Fonctionnelle

## 1. Objet du document

Ce document definit la cible fonctionnelle de Macro en tant que produit fini.

Il decrit :
- ce qu'est Macro
- ce que Macro doit permettre a un developpeur de faire
- comment les principaux workflows doivent fonctionner
- quelles regles utilisateur constituent le contrat fonctionnel du produit

Ce document n'est pas un plan d'implementation.
Les ecarts entre la cible et l'etat courant, les phases de livraison et les priorites relevent de `docs/roadmap.md`.

Sauf mention explicite contraire, les exigences de ce document decrivent le comportement produit attendu, y compris quand certaines capacites ne sont pas encore entierement stabilisees dans l'application.
Pour la ligne 0.1, le contrat public prioritaire reste le workflow desktop local-first. Les capacites remote, mobile, compte et abonnement decrites ici sont des cibles produit ou des zones best-effort tant qu'elles ne sont pas promues explicitement par la roadmap et les notes de support.

---

## 2. Positionnement du produit

### 2.1 Promesse produit

Macro est un environnement de developpement qui organise le vibe-coding en transformant le developpeur en architecte et pilote de l'execution par l'IA plutot qu'en producteur direct du code.

Utiliser Macro doit ressembler au travail d'un senior ou d'un lead technique qui briefe, coordonne et controle une equipe d'executeurs IA juniors.

### 2.2 Philosophie centrale

Macro repose sur les principes suivants :

- Le developpeur est le pilote, pas le simple redacteur du code.
- L'IA produit l'essentiel du code.
- La planification doit preceder l'execution des que le scope le justifie.
- Le travail doit rester auditable.
- La review est une activite de premier ordre.
- Le multi-projet est un cas natif, pas un cas limite.
- Le produit doit permettre une continuite d'execution entre plusieurs machines et, a terme, entre desktop, mobile et environnement distant.

### 2.3 Objectif principal

Macro doit permettre a un developpeur de definir le travail une fois, de le structurer clairement, de deleguer l'essentiel de l'implementation a l'IA et de continuer a superviser l'execution sans rester attache a une seule machine.

---

## 3. Perimetre du produit

### 3.1 Dans le perimetre

Macro doit couvrir :

- la planification et la structuration du travail d'ingenierie
- la derivation de taches executables a partir d'un plan
- l'execution de taches avec assistance IA
- la review des changements avant validation finale
- la coordination de plusieurs projets relies dans un meme espace de travail
- la conservation d'une trace d'audit des plans et de l'execution
- a terme, la poursuite de l'execution depuis une autre machine ou depuis un flux de supervision mobile ou distant

### 3.2 Hors perimetre

Macro n'a pas vocation a etre :

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

Macro organise le travail de la facon suivante :

1. l'utilisateur formule une intention
2. l'IA extrait et structure les besoins
3. l'IA genere une strategie
4. la strategie est validee
5. les taches d'implementation sont executees dans l'ordre voulu avec un maximum de parallelisme possible
6. l'utilisateur review les resultats
7. le code est committe et integre

### 5.2 Unites fonctionnelles principales

Macro s'appuie sur les unites suivantes :

- workspace
- groupe de projets
- projet
- plan
- conversation
- besoin
- noeud de strategie
- branche predictive
- tache d'implementation
- session de review

Ces unites sont definies dans la section suivante.

---

## 6. Concepts coeur

### 6.1 Workspace

Le workspace est l'environnement actif dans lequel Macro opere.

Il contient :
- un ou plusieurs groupes de projets
- un ou plusieurs projets
- l'etat local de l'application
- les metadonnees necessaires a l'audit de la planification et de l'execution

### 6.2 Groupe de projets

Un groupe de projets est un conteneur logique permettant de travailler sur plusieurs projets relies comme sur un seul systeme coherent.

Exemples :
- une application mobile et un site web
- un frontend et un backend
- plusieurs clients plateformes pour un meme produit

Le groupe est le contexte fonctionnel principal pour le travail coordonne.

### 6.3 Projet

Un projet est une codebase technique individuelle, generalement adossee a son propre depot.

Un projet appartient a un groupe de projets.

### 6.4 Plan

Un plan est l'unite principale de travail en mode Architect.

Un plan contient :
- une conversation dediee
- les besoins extraits pendant la phase de planification
- la strategie generee
- la structure predictive de branches associee a cette strategie
- les artefacts de relais produits par les taches planifiees pour transmettre de l'information aux taches dependantes

Un plan sert a definir une vague de travail coherente.

Exemples typiques :
- une grosse fonctionnalite
- une vague d'ameliorations ciblee
- un lot de livraison coherent

Plusieurs plans peuvent exister en parallele pour un meme groupe de projets.

Plusieurs plans peuvent aussi etre actifs en parallele si leur execution peut progresser simultanement.

Lorsqu'un plan est termine, il est archive.
Un plan archive reste consultable pour l'audit et l'historique, mais n'est plus destine a etre modifie.

### 6.5 Besoin

Un besoin est une exigence structuree identifiee par l'IA a partir de la conversation de planification.

Les besoins ne sont pas saisis manuellement via un formulaire dedie.
L'utilisateur exprime son intention de facon conversationnelle et l'IA formalise les besoins a partir de cet echange.

Les besoins sont des artefacts historiques de planification.

### 6.6 Noeud de strategie

Un noeud de strategie est une unite de la strategie d'un plan generee par l'IA.

Un noeud peut representer :
- une tranche fonctionnelle
- une etape technique
- un jalon de dependance
- une unite d'execution proche de la tache

Les noeuds de strategie definissent l'ordre, les dependances et la structure d'execution.

Un noeud peut aussi declarer des contrats d'artefacts attendus. Ces contrats decrivent les informations critiques qu'une tache devra produire pour ses descendantes, par exemple des resultats d'audit, une carte de migration, un contrat d'API ou un registre de risques.

### 6.7 Branche predictive

Une branche predictive est un artefact de planification qui represente la facon dont le travail doit etre decoupe dans Git pendant l'execution.

Son but est de :
- organiser l'execution
- maximiser le parallelisme lorsque cela reste sans risque
- conserver une branche de travail distincte par tache executable
- reduire la derive de l'IA et les changements trop volumineux

### 6.8 Tache d'implementation

Une tache d'implementation est une unite de travail executable derivee de la strategie.

La tache est l'unite suivie dans le mode Implement.

Une tache terminee avec succes se conclut toujours par un commit.

La plupart des taches sont creees a partir d'un plan valide, mais Macro doit aussi supporter des taches autonomes pour les quick fixes ou les petites features ne justifiant pas un plan complet.

### 6.9 Artefact de relais

Un artefact de relais est une information durable produite par une tache issue d'un plan Architect.

Il sert a transmettre du contexte exploitable aux taches qui dependent directement ou indirectement de la tache productrice.

Les artefacts de relais :
- sont rattaches a un plan et a une tache productrice
- sont stockes dans les metadonnees `@macro`, pas dans le code source applicatif
- peuvent etre declares a l'avance par la strategie ou produits librement par l'agent Implement
- ne sont visibles que par la tache productrice, ses descendantes et la tache synthetique de finalisation du plan
- ne sont pas partages entre taches paralleles sans dependance
- sont affiches dans le panneau des changements comme un sous-projet `Artifacts`, avec revue et validation metadata separees du staging Git
- peuvent superseder un artefact herite en creant une nouvelle version rattachee a la tache courante, sans ecraser la version parente
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

Son objectif est de permettre a l'utilisateur de :
- exprimer une intention
- definir ou affiner le scope du travail
- laisser l'IA extraire les besoins
- generer une strategie
- valider la structure d'execution attendue

Le mode Architect constitue le coeur methodologique de Macro.

Fonctionnellement, il correspond au moment ou un senior ou un lead technique briefe une equipe avant execution.

Le mode Architect doit supporter :
- une conversation par plan
- des besoins generes par l'IA
- une strategie generee par l'IA
- la declaration d'artefacts critiques attendus par tache
- une visualisation des dependances et de la structure predictive
- la validation d'un plan
- la preparation automatique de la structure d'execution apres validation

Le mode Architect n'est pas un simple mode descriptif.
Il doit preparer concretement la suite de l'implementation.

### 7.2 Mode Implement

Le mode Implement est le mode d'execution et de review.

Son objectif est de :
- executer les taches derivees d'un ou plusieurs plans
- gerer les questions de l'IA pendant l'execution
- presenter les changements generes pour review
- permettre un ajustement humain si necessaire
- valider et committer le travail tache par tache

Le mode Implement doit supporter :
- une file de taches issue de plusieurs plans
- le filtrage des taches par plan et par autres criteres pertinents
- la prise en compte explicite des dependances et de l'etat de disponibilite d'une tache
- la consultation des artefacts herites depuis les taches parentes et la production d'artefacts pour les taches dependantes
- une review en fin de tache
- une validation globale du plan avant merge du plan vers la branche de base

Le mode Implement repose sur un demarrage manuel de l'execution des taches.

### 7.3 Mode Chat

Le mode Chat est un mode de support independant.

Son objectif est de permettre a l'utilisateur de :
- poser des questions rapides d'ordre technique ou documentaire
- attacher des fichiers a une conversation
- utiliser certains outils web et MCP
- conserver une continuite de travail dans l'application sans entrer dans tout le workflow Macro

Le mode Chat n'est pas rattache par defaut a un contexte projet autonome.

Il se distingue du mode Implement en ce que :
- il n'est pas pilote par une strategie de plan
- il ne travaille pas par defaut sur un contexte d'execution de projet
- il ne parcourt pas un workspace complet en mode agent
- il fonctionne conversation par conversation avec un contexte explicitement fourni

Le mode Chat doit conserver un historique local des conversations.

---

## 8. Structure generale de l'interface

### 8.1 Structure cible

L'interface desktop de Macro doit etre organisee autour des zones suivantes :

- un header
- un panneau gauche
- une zone centrale
- un panneau droit
- un footer
- des modales et surfaces temporaires de consultation ou d'action

### 8.2 Header

Le header doit permettre au minimum :

- l'acces au mode actif
- l'acces au contexte projet ou groupe courant lorsque le mode s'y prete
- l'acces aux reglages
- l'acces aux commandes globales de l'application

### 8.3 Panneau gauche

Le panneau gauche doit accueillir le contexte lateral principal du mode courant.

Exemples :

- besoins du plan en mode Architect
- file de taches en mode Implement
- historique ou navigation de conversations en mode Chat

### 8.4 Zone centrale

La zone centrale doit rester le coeur operationnel de l'application.

Elle doit principalement accueillir :

- la conversation
- les actions de supervision
- les decisions de pilotage
- les interactions avec l'IA

### 8.5 Panneau droit

Le panneau droit doit accueillir les surfaces de lecture, de visualisation ou de validation liees au mode courant.

Exemples :

- graphe de strategie
- review des changements
- contexte, outils ou sources

### 8.6 Footer

Le footer doit exposer les informations et actions globales de statut.

Exemples :

- etat Git
- etat metadata `@macro`
- actions de sync
- statut global du contexte courant

### 8.7 Modales

Les modales servent aux operations ponctuelles qui ne doivent pas surcharger la surface principale.

Exemples :

- creation de projet
- navigation projet
- visualisation de diff
- reglage de l'application
- consultation de compte

---

## 9. Structure projet et multi-projet

### 9.1 Le multi-projet comme capacite centrale

Le multi-projet est une capacite centrale du produit.

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
- eviter la perte de contexte au niveau d'un depot individuel

### 9.4 Visibilite des taches

Le mode Implement doit supporter des taches issues :
- de plusieurs plans
- de plusieurs projets
- de plusieurs depots dans un meme groupe

L'interface doit permettre d'identifier clairement :
- a quel plan appartient une tache
- quel ou quels projets elle affecte
- quel est son etat de dependance

L'interface doit aussi permettre de filtrer les taches par plan.

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

Macro doit permettre les operations de base suivantes sur les projets et groupes :

- renommer un groupe
- renommer un projet
- archiver un groupe
- archiver un projet
- fermer un projet

### 10.4 Selection du contexte

Macro doit permettre de changer explicitement de contexte de travail :

- au niveau du groupe
- au niveau du projet

Le changement de contexte doit restaurer l'etat local utile autant que possible, notamment pour les conversations, plans et taches lies au projet.

---

## 11. Cycle de vie d'un plan

### 11.1 Creation du plan

L'utilisateur cree un plan depuis le mode Architect.

Creer un plan cree un nouveau contexte de planification comprenant :
- sa conversation propre
- ses besoins propres
- sa strategie propre

### 11.2 Generation du plan

L'utilisateur exprime ses objectifs de facon conversationnelle.

L'IA doit :
- deriver les besoins a partir de la conversation
- construire une strategie a partir de ces besoins
- organiser cette strategie pour maximiser le parallelisme lorsque cela reste sans risque
- maintenir chaque unite d'execution a une taille limitee pour reduire la confusion de l'IA et les changements trop larges

### 11.3 Validation du plan

Lorsqu'un plan est valide :
- la preparation des branches et des worktrees doit se faire automatiquement
- cette preparation est obligatoire
- la structure d'execution doit etre prete pour le mode Implement

### 11.4 Execution du plan

Un plan valide peut entrer en execution pendant que d'autres plans restent actifs en parallele.

### 11.5 Completion du plan

Un plan est considere comme termine lorsque :
- toutes les taches requises sont completees
- la validation globale du plan est realisee
- la branche du plan est acceptee pour integration dans la branche de base configuree

### 11.6 Archivage du plan

Les plans termines doivent etre archives.

Les plans archives doivent rester accessibles pour :
- la lecture
- l'audit
- l'analyse retrospective

Ils ne sont plus destines a etre modifies.

---

## 12. Regles de generation de strategie

### 12.1 L'IA est responsable de la formalisation

Les besoins et la strategie sont generes par l'IA et non saisis manuellement dans un formalisme rigide.

L'utilisateur peut influencer le resultat par la conversation et les prompts, mais l'IA reste responsable de la structuration.

### 12.2 Objectifs de la strategie

La strategie doit :
- refleter l'intention utilisateur
- definir un ordre d'execution realiste
- maximiser le parallelisme lorsque c'est sur
- exprimer le sequentiel par des dependances explicites entre taches
- minimiser les commits trop volumineux et les frontieres de taches floues

### 12.3 Structuration par branches

La strategie doit organiser le travail de sorte que :
- plusieurs branches puissent progresser en parallele
- chaque tache executable dispose de sa propre branche de travail
- les taches sequentielles soient reliees par des dependances explicites
- les branches de tache convergent vers la branche d'integration du plan

Cette structuration existe pour reduire le risque et ameliorer la qualite des reviews.

---

## 13. Modele de tache

### 13.1 Taches planifiees

La plupart des taches sont derivees automatiquement d'un plan valide.

Ces taches heritent :
- du contexte du plan
- de l'ordre d'execution
- de la structure de branche
- des associations projet

### 13.2 Taches autonomes

Macro doit aussi supporter des taches autonomes en dehors de tout plan.

Ces taches servent aux :
- petits correctifs
- oublis mineurs
- petites features ne justifiant pas un cycle complet de planification

Les taches autonomes doivent tout de meme supporter :
- l'execution par IA
- la review
- le commit

Les taches autonomes sont mergees directement vers la branche de base configuree plutot que via une branche de plan.

### 13.3 Regle de completion

Une tache ne peut pas etre consideree comme complete sans commit.

---

## 14. Comportement du mode Implement

### 14.1 Conditions de demarrage

Dans le mode Implement :
- les taches ne se lancent pas toutes seules
- l'utilisateur declenche explicitement le debut de la tache
- l'utilisateur peut fournir un prompt initial ou un cadrage complementaire avant l'execution

### 14.2 Gestion des questions

Au debut d'une tache, l'IA peut :
- poser des questions de clarification si necessaire
- ne poser aucune question si la tache est suffisamment claire

Quand l'IA pose des questions, Macro doit privilegier une interaction rapide.

Le modele privilegie est :
- trois reponses suggerees
- une quatrieme voie libre pour une reponse personnalisee

Ce modele existe pour reduire le frottement utilisateur et faciliter la supervision depuis mobile.

### 14.3 Travail d'execution

Pendant l'execution d'une tache, l'IA peut :
- inspecter le contexte necessaire
- modifier des fichiers
- lancer des tests
- lancer un build
- preparer des changements pour review

### 14.4 Review humaine

Une review humaine est obligatoire a la fin de chaque tache.

La review de tache doit presenter :
- la liste des fichiers modifies
- l'acces aux diffs
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

La validation humaine porte principalement sur la qualite et la justesse du code genere.

Les resultats des tests et du build doivent etre visibles pour l'utilisateur, mais ils ne constituent pas la surface principale de review.

Les messages de commit doivent etre generes automatiquement par l'IA apres validation utilisateur.

---

## 15. Modele de review et d'integration

### 15.1 Validation a l'echelle de la tache

Chaque tache completee doit se conclure par :
- une review du code
- une validation utilisateur
- la generation d'un commit

### 15.2 Validation a l'echelle du plan

Lorsque toutes les taches d'un plan sont terminees, Macro doit imposer une validation globale du plan avant merge du plan vers la branche de base configuree.

Cette validation est distincte de la review tache par tache.

### 15.3 Generation des commits

Apres acceptation de la review :
- l'IA doit generer le message de commit
- le commit doit etre cree sur la branche appropriee

### 15.4 Structure des merges

Pour le travail derive d'un plan, le flux par defaut est :

- chaque tache se fait sur une branche feature dediee rattachee au plan
- le travail valide est merge vers la branche d'integration du plan
- le plan valide est ensuite merge vers la branche de base configuree

Pour les taches autonomes :

- le travail valide est merge directement vers la branche de base configuree

### 15.5 Merge conflicts

Macro doit supporter une resolution automatique assistee par IA des merge conflicts produits par ses propres operations de merge automatisees.

Cette resolution automatique ne concerne que les conflits issus des merges pilotes par le logiciel et non les situations externes arbitraires.

---

## 16. Regles Git et execution

### 16.1 Le lien entre planification et Git

Dans Macro, la planification n'est pas separee de la structure d'execution Git.

La validation d'un plan doit preparer :
- les branches
- les worktrees
- la trace metadata correspondante

### 16.2 Exigence de proprete

Lorsqu'un plan ou une structure d'execution de plan est supprime avant reel demarrage, Macro doit nettoyer les branches associees et les structures temporaires afin d'eviter les artefacts parasites.

### 16.3 Commits multi-projets

Quand une meme tache affecte plusieurs projets :
- la validation reste une seule action coherente du point de vue du produit
- les commits peuvent etre crees separement par projet
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

Les fichiers attaches en mode Chat sont scopes a la conversation.

Il n'y a pas d'exigence de bibliotheque de contexte reutilisable entre plusieurs conversations.

### 17.4 Historique

Le mode Chat doit conserver un historique local des conversations.

Une future synchronisation de cet historique peut exister plus tard, mais ne fait pas partie du comportement local minimal.

### 17.5 Acces outils

Le mode Chat peut acceder :
- au web
- a certains outils MCP
- aux skills activees par l'utilisateur

La disponibilite de ces outils doit etre configurable.

---

## 18. Skills

### 18.1 Objectif fonctionnel

Les skills permettent a l'utilisateur d'ajouter des instructions agent reutilisables sans modifier le code de Macro.

Elles servent a orienter le comportement de l'IA dans Architect, Implement et Chat. Elles ne remplacent pas MCP et ne doivent pas creer de nouveaux outils externes arbitraires.

### 18.2 Format et sources

Une skill locale est un dossier contenant :

- `SKILL.md` prioritaire (`skill.md` est accepte en compatibilite avec diagnostic)
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
- les diagnostics distinguent erreurs bloquantes et warnings de compatibilite
- les noms de skills sont compares apres normalisation Unicode NFKC
- les lettres et chiffres Unicode minuscules sont acceptes; uppercase, underscores, tirets en debut/fin, doubles tirets et mismatch avec le dossier restent des warnings lenient
- tout champ de frontmatter hors `name`, `description`, `license`, `compatibility`, `metadata` et `allowed-tools` produit un warning `unexpected_frontmatter_field`

### 18.3 Activation et contexte

Les skills decouvertes sont desactivees par defaut.

L'utilisateur peut les activer dans les reglages Skills. Il peut aussi referencer une skill dans le composeur via selection explicite ou mention `$skill-name`.

Macro doit charger les skills progressivement :

- catalogue compact au tour agent
- contenu complet de `SKILL.md` seulement sur activation
- ressources et scripts seulement via les outils dedies

En cas de collision de nom, Macro choisit une skill effective de facon deterministe : projet avant global, puis `.agents`, `.codex`, `.opencode`, `.claude`, puis chemin lexical stable. Le catalogue agent et `$skill-name` ne voient que cette skill effective. Les skills shadowed restent visibles dans les reglages et selectionnables explicitement par id/source.

Les manifests sont transport-neutres. Les chemins locaux (`rootPath`, `skillFilePath`) restent presents pour les skills locales mais sont optionnels; `location.kind`, `location.uri` et `contentHash` sont les identifiants preferes pour les skills remote ou bundled.

### 18.4 Securite

Une skill peut etre activee sans etre trusted.

Les scripts restent indisponibles tant que la skill n'est pas trusted et que l'option scripts n'est pas activee pour cette skill.

`allowed-tools` est une information declarative de la skill. Elle ne contourne jamais les modes Macro, la politique d'approbation, le niveau de risque ou les reglages utilisateur.

Toute execution de script doit passer par la politique d'approbation Macro des outils a risque, capturer la sortie, appliquer un timeout et eviter l'injection de secrets par defaut.

Les chemins hors dossier skill, traversals, fichiers caches non autorises et symlinks sortants doivent etre refuses.

### 18.5 Remote et cloud

Un runtime remote peut exposer les skills sans filesystem local lisible par le frontend. Le contrat provider utilise les operations :

- `POST /skills/list`
- `POST /skills/get`
- `POST /skills/read-resource`
- `POST /skills/run-script`

Les payloads publics cote frontend utilisent le camelCase. Les kernels distants doivent pouvoir repondre `unsupported`; 404, 405 et 501 sont presentes a l'utilisateur comme une capacite indisponible precise.

La capacite `skills` controle `skill_activate` et `skill_read_resource`. La capacite separee `skillScripts` controle `skill_run_script`; elle est false par defaut en remote et doit etre declaree explicitement avant qu'un script cloud soit propose au modele.

---

## 19. Modele d'automatisation et de notification

### 19.1 Appels d'attention

Lorsque l'IA a besoin de l'utilisateur, Macro doit rendre cette demande d'attention explicite.

Exemples :
- question de clarification
- review requise
- blocage d'execution
- probleme d'integration

### 19.2 Continuite desktop et mobile

La cible produit inclut une supervision distante depuis une application mobile compagnon.

L'utilisateur doit pouvoir :
- suivre l'avancement des taches
- recevoir les questions
- repondre aux decisions attendues
- reviewer et valider a distance

La creation complete de plans depuis mobile n'est pas un besoin central initial.
La supervision distante du mode Implement est la priorite.
Dans la ligne 0.1, cette continuite reste une cible produit : le support stable concerne d'abord l'experience desktop local-first.

### 19.3 Perimetre des notifications

Le systeme de notification fait partie de la cible produit meme s'il n'est pas encore entierement implemente.

Les notifications doivent au minimum couvrir :
- besoin d'attention sur une tache
- review requise
- execution bloquee
- execution terminee

---

## 20. Kernel distant et continuite d'execution

### 20.1 Le kernel distant est une capacite produit

Le kernel distant fait partie de la specification produit, et pas seulement de l'architecture technique.

Son role est de permettre a l'execution Macro de continuer independamment d'une seule session GUI locale.
Dans la ligne 0.1, le kernel distant existe comme socle technique minimal et reste best-effort par rapport au workflow desktop local-first.

### 20.2 Resultats fonctionnels attendus

Le kernel doit rendre possibles :
- l'execution distante des IA
- la continuite entre plusieurs machines desktop
- l'execution continue sur une machine dediee ou un serveur heberge
- la supervision distante depuis un client Macro ou mobile

### 20.3 Scenarios utilisateurs cibles

Le produit doit supporter au minimum les scenarios suivants :

- l'utilisateur demarre sur un desktop puis reprend la supervision sur un laptop
- l'utilisateur quitte son poste et poursuit la supervision depuis mobile
- l'utilisateur execute Macro sur un serveur dedie au lieu d'un poste local unique

---

## 21. Reglages et controle utilisateur

Macro doit exposer un controle utilisateur sur au moins les dimensions suivantes :

- fournisseurs et modeles IA
- disponibilite des outils par mode
- activation, confiance et scripts des skills
- niveau d'automatisation de l'implementation
- configuration du workflow Git
- preferences d'apparence et d'interaction
- raccourcis
- prompts et cadrage du comportement systeme

Le produit doit permettre a l'utilisateur de modeler le comportement de l'IA sans necessiter de modification de code.

---

## 22. Donnees, audit et trace historique

### 22.1 Auditabilite

Macro doit conserver suffisamment de metadonnees pour auditer :
- ce qui a ete planifie
- comment cela a ete structure
- ce qui a ete execute
- ou un eventuel probleme a pu apparaitre

### 22.2 Nature historique des artefacts de planification

Les besoins, noeuds de strategie et branches predictives sont durables comme historique, mais pas comme objets pilotes du futur une fois le plan clos.

Leur utilite principale apres execution est :
- l'audit
- la retrospective
- la tracabilite

### 22.3 Persistance des metadonnees

Les metadonnees liees aux plans doivent etre stockees dans la structure metadata de Macro afin que l'historique ne soit pas perdu.

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
- Le mode Implement est pilote par les taches et oriente review-first.
- Le mode Chat est leger et independant.
- Le multi-projet est une capacite de premier plan.
- Un plan contient sa conversation, ses besoins et sa strategie.
- Plusieurs plans peuvent coexister en parallele.
- Les plans archives restent lisibles mais non modifiables.
- Les besoins et la strategie sont generes par l'IA a partir de la conversation.
- La validation d'un plan prepare automatiquement branches et worktrees.
- Toute tache completee se termine par un commit.
- Une review humaine est obligatoire a la fin de chaque tache.
- Une tache de finalisation synthetique converge depuis les feuilles de la strategie et pilote l'integration finale.
- L'edition manuelle du code existe, mais comme mecanisme secondaire d'ajustement en review.
- Les skills guident l'agent sans contourner la politique d'outils.
- Le support du kernel distant fait partie de la cible produit.

---

## 25. Regles de maintenance du document

Ce document doit etre mis a jour lorsque :
- un workflow utilisateur change
- une regle produit change
- une nouvelle capacite publique devient une partie du contrat fonctionnel

Ce document ne doit pas etre modifie pour :
- des details d'implementation bas niveau
- des refactors internes sans impact produit
- des experimentations temporaires qui ne font pas partie de la cible produit
