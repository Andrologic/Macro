# Workflow Macro - Guide Complet

## Table des Matières

1. [Introduction](#introduction)
2. [Création d'un Projet](#création-dun-projet)
3. [Mode Architecte](#mode-architecte)
4. [Mode Implémentation](#mode-implémentation)
5. [Organisation Multi-Projets](#organisation-multi-projets)
6. [Revue et Validation](#revue-et-validation)
7. [Stockage et Collaboration](#stockage-et-collaboration)
8. [Bonnes Pratiques](#bonnes-pratiques)
9. [Exemple de Workflow](#exemple-de-workflow)

---

## Introduction

Macro est conçu pour le "vibe-coding organisé". Contrairement aux éditeurs traditionnels où vous écrivez directement le code, Macro adopte une méthodologie structurée où l'humain est l'**Architecte** et l'IA est le **Constructeur**.

### Principes Fondamentaux

1. **Architect-First** : Tout changement commence par une planification structurée
2. **Validation Itérative** : Les générations IA sont décomposées en petites tâches vérifiables
3. **Éditeur Largement en Lecture Seule** : L'humain fait de petits ajustements, pas de réécritures majeures
4. **Opérations Atomiques** : Toutes les modifications sont acceptées/rejetées ensemble

### L'Interface Macro

L'interface Macro se compose de plusieurs sections clés :

#### Header
**À gauche :**
- **Logo Macro** 
- **Nom du logiciel** 
**Au centre :**
- **Selecteur de mode** : Architecte / Implémentation / (Autres futurs modes et extensions) au centre
**À droite :**
- **Bouton de paramètres** : à droite

#### Corps Principal

- **Gestion Projets** : Liste des projets et groupes
- **Zone de Chat** : Interaction avec l'IA pour planification et exécution
- **Outils du mode** : Une sélection d'outils différents selon le mode (Architecte ou Implémentation)

#### Footer

**À gauche :**
- **Connexion** : Statut de connexion au service (en ligne/hors ligne)
- **Statut de l'IA** : Indicateur de disponibilité

**À droite :**
- **Ressources système** : Utilisation CPU et mémoire (optionnel)
- **Raccourcis clavier** : Accès rapide à la liste des raccourcis
- **Version du logiciel** : Numéro de version actuelle

### Composants supplémentaires de l'Interface

L'interface Macro utilise plusieurs types de fenêtres superposées pour différentes interactions :

#### Fenêtres Modales

Les **modales** sont des fenêtres qui s'affichent au premier plan de l'interface principale, avec un effet de flou sur le contenu en arrière-plan. Elles sont utilisées pour :

- **Paramètres** : Configurer les préférences utilisateur
- **Aide** : Afficher la documentation ou les tutoriels
- **Editeur de code** : Modifier manuellement un fichier spécifique
- **Validation** : Confirmer une action importante (suppression, merge, etc.)

Les modales nécessitent une interaction explicite pour être fermées (clic sur le bouton de fermeture, touche Escape, ou validation de l'action).

#### Tooltips

Les **infobulles** apparaissent au survol de la souris pour fournir des informations contextuelles rapides sur les éléments de l'interface.


---

## Création d'un Projet

### Étape 1 : Initialiser un Nouveau Projet

1. **Ouvrir Macro** et cliquer sur "Nouveau Projet" dans le panneau gauche
2. **Sélectionner le type de projet** :
   - Projet vide
   - Importer depuis un dépôt git existant
   - Cloner depuis GitHub/GitLab

3. **Configurer les métadonnées** :
   - Nom du projet
   - Type de projet (Frontend, Backend, Fullstack, Mobile, etc.)
   - Description
   - Extensions Macro

4. **Localisation** : Choisir le dossier où le projet sera créé

### Étape 2 : Configuration Initiale

Macro génère automatiquement :
- Une **branche `.macro` dédiée** pour les plans et métadonnées
- La **structure de dossiers** dans cette branche (voir section Stockage et Collaboration)
- La **structure de base** du projet selon le template choisi
- Le **fichier de métadonnées du projet** dans la branche `.macro`

> **Note** : Le développeur utilise Macro pour aller au bout du plan dans une session continue. Il n'y a pas de gestion de modifications externes au workflow Macro - l'application est l'environnement unique de développement.

### Exemple de Métadonnées du Projet (dans la branche `.macro`)

TODO

## Mode Architecte

Le Mode Architecte est la phase de planification où vous définissez **QUOI** faire, sans vous soucier du **COMMENT**.

### Créer un Plan

1. **Activer le Mode Architecte**
   - Cliquez sur le bouton "Architecte" dans la zone de chat
   - Ou utilisez le raccourci clavier configurable

2. **Décrire votre intention**
   - Écrivez votre demande en langage naturel dans le chat
   - Exemple : *"Je veux créer un système d'authentification avec inscription, connexion et récupération de mot de passe"*

3. **L'IA génère un plan structuré**
   - Liste des features à implémenter
   - Plan des commits nécessaires
   - Dépendances entre les tâches
   - Le plan est créé dans la branche `.macro` sous forme de fichiers Markdown

### Structure d'un Plan

L'IA crée un fichier `plan.md` dans la branche `.macro` :

```markdown
# Plan : Système d'Authentification

## Description
Implémentation complète de l'authentification utilisateur avec inscription, connexion et récupération de mot de passe.

## Features à Implémenter

### 1. Inscription utilisateur
- Formulaire email/mot de passe
- Validation côté client et serveur
- Stockage sécurisé du mot de passe (hash bcrypt)
- Confirmation par email

### 2. Connexion utilisateur
- Authentification JWT
- Gestion des sessions
- Rappel de mot de passe
- Option "Se souvenir de moi"

### 3. Interface UI
- Composant LoginForm
- Composant RegisterForm
- Page de réinitialisation
- Protection des routes

## Commits Planifiés

### feat: add user registration flow
- Création du composant RegisterForm
- API endpoint POST /api/auth/register
- Validation des données
- Tests unitaires

### feat: add login authentication
- Création du composant LoginForm
- API endpoint POST /api/auth/login
- Génération JWT
- Tests unitaires

### feat: add password reset
- Composant de demande de reset
- API endpoint POST /api/auth/forgot-password
- Gestion du token de reset
- Tests unitaires

## Dépendances

- bcrypt pour le hash des mots de passe
- jsonwebtoken pour les JWT
- nodemailer pour les emails

## Date de Création
2026-01-15T10:00:00Z
```

### Affiner le Plan

1. **Parcourir les tâches générées**
2. **Poser des questions à l'IA** pour clarifier des points
3. **Demander des modifications** :
   - Ajouter/supprimer des features
   - Changer la priorité des tâches
   - Décomposer une tâche complexe
   - Fusionner des tâches similaires

4. **Valider le plan** quand il correspond à votre vision
5. **Enregistrer le plan** dans la branche `.macro`
6. **Passer au Mode Implémentation**

### Préparer une Tâche

Pour chaque tâche du plan :

1. **Cliquer sur la tâche** pour la sélectionner
2. **Fournir des détails** à l'IA :
   - Préférences de style de code
   - Bibliothèques spécifiques à utiliser
   - Patterns à suivre ou éviter
   - Contraintes de performance

3. **Spécifier le contexte** :
   - Fichiers existants à modifier
   - Nouveaux fichiers à créer
   - Dépendances entre projets

---

## Mode Implémentation

Une fois le plan validé, passez en Mode Implémentation pour l'exécution.

### Exécuter les Tâches

1. **Activer le Mode Implémentation**
   - Cliquez sur "Implémentation" dans la zone de chat
   - Sélectionnez une tâche ou laissez l'IA choisir l'ordre optimal

2. **L'IA exécute la tâche**
   - Génère le code nécessaire
   - Crée/modifie les fichiers
   - Peut poser des questions via le chat

3. **Répondre aux questions de l'IA**
   - L'IA peut demander des clarifications
   - Fournissez des réponses directes et précises
   - L'IA ajuste son implémentation en conséquence

Il faut parfois plusieurs échanges pour finaliser une tâche. Les echanges doivent entre priorité sous forme de questions à choix pour faciliter les réponses rapides. On doit pouvoir proposer plusieurs options depuis l'interface avec des boutons.

### Exemple de Dialogue en Mode Implémentation

```
🤖 IA : Pour le formulaire d'inscription, voulez-vous inclure la confirmation du mot de passe ?

👤 Vous : Oui, avec une validation en temps réel pour s'assurer qu'ils correspondent.

🤖 IA : Préférez-vous utiliser une bibliothèque de validation comme Zod ou écrire votre propre logique ?

👤 Vous : Utilise Zod, c'est déjà dans le projet.

🤖 IA : Génère le formulaire avec validation Zod...
```

### Révision du Code Généré

Avant d'appliquer les modifications :

1. **Visualiser les changements** dans l'éditeur (read-only)
2. **Voir le diff** de chaque fichier modifié
3. **Parcourir les nouveaux fichiers créés**

L'éditeur montre :
- **Lignes ajoutées** en vert
- **Lignes supprimées** en rouge
- **Lignes modifiées** en jaune

Par défaut, l'IA sélectionne et présente les modifications les plus intéressantes à partir du diff. On peut voir tout en détail en cliquant sur un fichier.

### Valider ou Rejeter

Pour chaque fichier ou pour l'ensemble :

- **✓ Accepter** : Appliquer les modifications proposées par l'IA
- **✗ Rejeter** : Annuler les modifications
- **Modifier** : Faire de petits ajustements manuels

⚠️ **Important** : Rejeter une tâche la marque comme "Échouée" dans le plan (affichée en rouge). Le développeur interagit alors avec le chat pour comprendre et résoudre le problème, puis relance la tâche.

### Opérations Atomiques

Toutes les modifications d'une tâche sont appliquées **ensemble** :
- Si vous acceptez → tous les fichiers sont modifiés
- Si vous rejetez → aucun fichier n'est modifié
- Aucun état partiel ne peut exister

---

## Organisation Multi-Projets

Macro excelle dans la gestion de workspaces avec plusieurs projets interdépendants, inspirée du Git Flow.

### Philosophie Git Flow Multi-Branches

Chaque sous-projet du groupe possède son propre dépôt git avec sa propre branche principale.

En **Mode Architecte**, l'IA agit comme un chef de projet qui :
- Identifie les grandes features indépendantes
- Crée des branches git parallèles dans les dépôts concernés pour chaque groupe de features
- Planifie les tâches dans chaque branche selon leurs dépendances internes

En **Mode Implémentation**, l'IA agit comme une équipe de développeurs :
- Peut exécuter plusieurs tâches en parallèle sur des branches différentes
- Respecte les dépendances au sein de chaque branche
- Gère les merges successifs vers la branche principale

### Créer des Groupes de Projets

Dans le panneau gauche :

1. **Créer un groupe** : Glisser-déposer des projets dans un groupe
2. **Ajouter des projets** au groupe :
   - Projets indépendants → groupes séparés (travail simultané)
   - Projets interdépendants → même groupe

On peut séparer un projet en cliquant droit sur un projet et en sélectionnant "Séparer du groupe".

### Structure Multi-Projets

```
Groupe "E-Commerce"
├─ Frontend (React) ✓
├─ Backend (Node.js) ✓
└─ Services (Python) ✓

Groupe "Mobile"
├─ iOS App (Swift) ✓
└─ Android App (Kotlin) ✓
```

### Branches Multi-Projets

Chaque sous-projet possède son propre dépôt git. Durant la planification, l'IA crée des branches dans les dépôts concernés.

**Exemple : Feature multi-projets (Frontend + Backend)**

La feature "authentication" nécessite des modifications sur Frontend et Backend. L'IA crée une branche `feature/authentication` dans les deux dépôts :

```
Dépôt Git Frontend                   Dépôt Git Backend
main                                  develop
├─ develop                          ├─ feature/authentication
│   └─ feature/authentication       │   ├─ Commit A: login API endpoint
│       ├─ Commit A: login UI        │   ├─ Commit B: register API endpoint
│       ├─ Commit B: register UI     │   └─ Commit C: password reset API
│       └─ Commit C: password UI     └─ (sera mergé dans develop, puis release)
└─ (sera mergé dans develop, puis release)

Production release :
main                                   main
├─ tagged: v1.0.0                    ├─ tagged: v1.0.0
└─ release/1.0.0 (merge)             └─ release/1.0.0 (merge)
```

**Exemple : Feature mono-projet (Frontend uniquement)**

La feature "ui-design-refresh" ne modifie que le Frontend. Aucune branche n'est créée dans les autres dépôts :

```
Dépôt Git Frontend                   Dépôt Git Backend
develop                               develop
├─ feature/ui-refresh                (aucune branche créée)
│   ├─ Commit A: new header
│   ├─ Commit B: new footer
│   └─ Commit C: updated cards
└─ (sera mergé dans develop)
```

### Philosophie Git Flow

Macro adopte le modèle **Git Flow** pour la gestion des branches dans chaque dépôt git.

**Branches principales :**

- **`main`** : Branche de production, toujours dans un état "production-ready"
- **`develop`** : Branche d'intégration pour la prochaine release

**Branches de support :**

- **`feature/*`** : Développement de nouvelles features (partent de `develop`, fusionnent dans `develop`)
- **`release/*`** : Préparation d'une release (partent de `develop`, fusionnent dans `develop` ET `main`)
- **`hotfix/*`** : Corrections urgentes en production (partent de `main`, fusionnent dans `develop` ET `main`)

**Cycle de vie d'une feature :**

```
1. Feature créée depuis develop :
   develop → feature/authentication

2. Tâches exécutées sur la feature :
   feature/authentication → commits A, B, C

3. Feature terminée, merge dans develop :
   feature/authentication → develop

4. Release préparée quand develop est prêt :
   develop → release/1.0.0

5. Release terminée, merge dans develop ET main :
   release/1.0.0 → develop (pour les bugfixes)
   release/1.0.0 → main (tagged: v1.0.0)
```

**Avantages de Git Flow pour Macro :**

- **Séparation claire** entre développement et production
- **Releases planifiées** avec branches dédiées
- **Hotfix possibles** sans interrompre le développement
- **Collaboration d'équipe** facilitée avec des branches parallèles

### Tâches Multi-Projets

Une tâche peut affecter un ou plusieurs sous-projets :

- **Tâche multi-projets** : Affichée une seule fois dans la liste de tâches unifiée, marquée avec tous les projets concernés
- **Tâche mono-projet** : Affichée uniquement dans le contexte du sous-projet concerné

Les tâches sont visibles dans chaque graphe git des dépôts affectés.

**Exemple de tâche multi-projets (Frontend + Backend)** :

```
○ [Frontend + Backend] Implémenter l'API de produits
  ├─ Frontend : Créer le service ProductService
  ├─ Backend : Créer l'endpoint GET /api/products
  └─ Définir le contrat OpenAPI partagé
```

**Exemple de tâche mono-projet (Frontend uniquement)** :

```
○ [Frontend] Rafraîchir le design des cartes produits
  ├─ Créer le composant ProductCard
  └─ Mettre à jour les styles Tailwind
```

### Navigation Entre Projets

1. **Cliquez sur un projet** dans le panneau gauche pour le sélectionner
2. **Le panneau droit** affiche les détails contextuels selon le mode :
- En **Mode Architecte** : Le plan spécifique au projet sélectionné avec le graphe des tâches
- En **Mode Implémentation** : La liste des tâches du projet sélectionné
3. **La zone de chat** est globale à tous les projets du groupe. On peut poser des questions sur n'importe quel sous-projet et l'IA répond en contexte. L'historique est partagé au niveau du groupe de projets.

### Commits Multi-Projets

Les commits sont color-codés :
- 🟢 **Vert** : Commits effectués
- 🔵 **Bleu** : Commits planifiés (dans `.macro`)
- 🟠 **Orange** : Commits en cours

Le graphe git de chaque projet montre :
- Les branches principales (`main`, `develop`)
- Les branches de support (`feature/*`, `release/*`, `hotfix/*`)
- Les commits spécifiques à chaque branche
- Les points de merge vers `develop` puis `main`
- Les tags de release sur `main`

### Interaction avec la Branche `.macro`

La branche `.macro` est **indépendante** du workflow Git Flow des branches de code. Elle sert uniquement à stocker :

- **Les plans** de développement pour chaque branche de code (`main`, `develop`, `feature/*`, `release/*`, `hotfix/*`)
- **Les tâches** planifiées et leur état (Planned, In Progress, Success, Failed)
- **Les métadonnées** des projets Macro (type de projet, préférences, extensions)
- **Les fichiers d'exécution** (`planned.md`, `executed.md`) pour chaque commit de code

**Structure parallèle :**

```
Dépôt Git de Code                Branche .macro
main (production)                    branches/
├─ develop                        ├─ main/
│   ├─ feature/auth                │   ├─ plan.md
│   │   └─ (merge vers main)        │   └─ commits/
├─ release/1.0.0                   │       └─ hotfix-critical-bug/
│   ├─ (merge vers develop)            │           ├── planned.md
│   └─ (merge vers main, tagged)        │           └── executed.md
└─ hotfix/critical-bug               └─ develop/
    ├─ (merge vers develop)            │       └── plan.md
    └─ (merge vers main, tagged)        │       └── commits/
                                            │           └── feature-auth/
                                            │               ├── planned.md
                                            │               └── executed.md
```

**Correspondance entre branches :**

- Chaque branche de code (`feature/auth`, `release/1.0.0`, `hotfix/critical-bug`) a son dossier correspondant dans `.macro/branches/`
- Chaque commit de code a son dossier avec `planned.md` et `executed.md` dans `.macro/branches/<nom_branche>/commits/`
- Les ID de commits de code sont référencés dans les fichiers `executed.md` pour la traçabilité

**Indépendance :**

- La branche `.macro` ne contient jamais de code source
- Les branches de code ne contiennent jamais de métadonnées Macro
- Les deux sont complètement indépendantes et peuvent être manipulées séparément

---

## Revue et Validation

### Revue des Tâches

Après l'exécution d'une tâche :

1. **Vérifier la qualité du code**
2. **Tester le comportement** (si possible)
3. **Consulter les tests générés** par l'IA
4. **Valider la tâche** ou demander des révisions

### Suivi du Progrès

Dans le panneau droit :
- **En mode Architecte** : Voir l'état de chaque tâche (Planned, In Progress, Success, Failed) dans le graphe des tâches
- **En mode Implémentation** : Voir les tâches restantes et leur statut, avec des indicateurs visuels et en dessous toutes les tâches effectuées.

### Revenir en Arrière

Toutes les tâches sont **réversibles** :
- Cliquez sur "Rétablir" pour annuler une tâche
- Git revert automatique sur les commits concernés
- Les fichiers reviennent à leur état précédent

---

## Stockage et Collaboration

### Stockage Local (SQLite)

Macro stocke localement dans SQLite :
- **Historique des conversations** avec l'IA
- **Données privées utilisateur**
- **Préférences personnelles**
- **Cache contextuel**

Ces données ne sont **jamais partagées**.

### Stockage Git (Branche `.macro` Spéciale)

Macro utilise une **branche `.macro` dédiée sans code** pour stocker toutes ses métadonnées et données de planification. Cette branche ne contient que les données de Macro, pas le code source du projet.

#### Structure de la Branche `.macro`

La branche `.macro` utilise une structure de dossiers organisée en fichiers Markdown, parallèle aux branches git du projet :

```
.macro/
├── branches/
│   ├── main/
│   │   ├── plan.md                    # Plan global de la branche
│   │   └── commits/
│   │       ├── feat-cart-store/
│   │       │   ├── planned.md         # Ce qui était prévu
│   │       │   └── executed.md        # Ce qui a été fait (si fait)
│   │       ├── feat-cart-ui/
│   │       │   ├── planned.md
│   │       │   └── executed.md
│   │       └── feat-checkout/
│   │           ├── planned.md
│   │           └── executed.md
│   ├── feature-auth/
│   │   ├── plan.md
│   │   └── commits/
│   │       └── ...
│   └── feature-payment/
│       ├── plan.md
│       └── commits/
│           └── ...
└── metadata/
    ├── branches.md                     # Liste des branches et leurs états
    └── dependencies.md                 # Dépendances entre branches/tâches
```

#### Contenu des Fichiers

**plan.md** (dans chaque dossier de branche) :
```markdown
# Plan : Feature Panier d'Achat

## Description
Implémentation complète du système de panier avec gestion des articles, calcul du total et persistance.

## Tâches Planifiées
1. Créer le store Zustand pour le panier
2. Créer les composants UI (CartItem, Cart)
3. Intégrer dans ProductPage
4. Créer la page CartPage avec checkout

## Date de Création
2026-01-15T10:00:00Z
```

**planned.md** (dans chaque dossier de commit) :
```markdown
# Commit : feat(frontend): add cart store

## Description
Création du store Zustand pour gérer le panier d'achat avec persistances.

## Fichiers Planifiés
- stores/useCartStore.ts (nouveau fichier)

## Features
- State : items[], total
- Actions : addItem, removeItem, updateQuantity, clearCart
- Persistance localStorage avec Zustand persist middleware

## Dépendances
- zustand
- immer

## Statut
Planned
```

**executed.md** (dans chaque dossier de commit, créé après exécution) :
```markdown
# Exécution : feat(frontend): add cart store

## Date d'Exécution
2026-01-15T11:30:00Z

## Fichiers Créés
- stores/useCartStore.ts

## Changements par rapport au plan
- Aucun changement

## Tests
- useCartStore.test.ts : 8/8 tests passants

## Statut
Success
```

#### Avantages de cette Structure

1. **Séparation claire** : Les données Macro sont complètement séparées du code
2. **Traçabilité** : Chaque commit a son dossier avec prévision et réalisation
3. **Flexibilité** : Facile de naviguer dans l'historique et les différences
4. **Versioning git** : Tous les changements sont versionnés comme du code
5. **Collaboration** : Équipe peut voir et modifier les plans via PR

#### Branche Principale (Code Source)

La branche principale du projet contient uniquement :
- Le code source du projet
- Les fichiers de configuration standard (package.json, tsconfig.json, etc.)
- Les tests
- La documentation utilisateur

#### Flux de Collaboration

1. **Création de plan** : Architecte crée un plan dans la branche `.macro`
2. **Discussion** : L'équipe peut discuter du plan via PR sur la branche `.macro`
3. **Exécution** : Développeurs exécutent les tâches via Macro (mode implémentation)
4. **Mise à jour** : Les fichiers `executed.md` sont créés automatiquement
5. **Code review** : Revue traditionnelle sur les branches de features du code
6. **Merge** : Code merge vers la branche principale, branche `.macro` mise à jour

#### Versioning des Plans

Les plans sont entièrement versionnés via Git dans la branche `.macro` :
- Chaque modification de plan est un commit sur la branche `.macro`
- Chaque exécution de tâche met à jour les fichiers `executed.md`
- Historique complet des décisions et réalisations
- Possibilité de revenir à une version précédente du plan
- Comparaison facile entre planifié vs réalisé

#### Synchronisation Plan → Code

La branche `.macro` et les branches de code sont synchronisées par leurs commits :
- Chaque dossier de commit dans `.macro` correspond à un commit dans une branche de code
- L'ID du commit de code est référencé dans `executed.md`
- Permet de tracer exactement quelle implémentation correspond à quel plan

---

## Bonnes Pratiques

### Pour les Architectes

✅ **Faites**
- Décrivez clairement vos intentions en mode Architecte
- Décomposez les features en tâches gérables
- Précisez vos préférences de style de code
- Validez chaque étape avant de passer à la suivante

❌ **Ne faites pas**
- Écrivez directement du code (sauf petits ajustements)
- Sautez la phase de planification
- Acceptez des modifications sans les relire
- Ignorez les tests échoués

### Pour les Implémenteurs

✅ **Faites**
- Répondez précisément aux questions de l'IA
- Relisez attentivement chaque diff
- Testez les fonctionnalités après application
- Utilisez la fonction de révision si nécessaire

❌ **Ne faites pas**
- Appliquez des modifications sans vérifier
- Ignorez les avertissements de l'IA
- Modifiez manuellement du code sans comprendre

### Gestion Multi-Projets

✅ **Faites**
- Groupez les projets interdépendants
- Utilisez des tâches multi-projets quand pertinent
- Vérifiez les impacts sur tous les projets concernés
- Maintenez des contrats API partagés à jour

❌ **Ne faites pas**
- Créez des dépendances implicites entre projets
- Modifiez l'API d'un projet sans mettre à jour les autres
- Ignorez les conflits potentiels entre projets

---

## Exemple de Workflow

Voici un exemple complet de création d'une fonctionnalité dans Macro.

### Scénario

Vous voulez ajouter une fonctionnalité de "panier d'achat" à votre application e-commerce avec un Frontend React et un Backend Node.js.

**Structure des dépôts git avant la planification :**

```
Dépôt Git Frontend          Dépôt Git Backend
main                         main
```

**Les deux dépôts sont synchronisés dans le groupe "E-Commerce" dans l'interface Macro.**

### Étape 1 : Mode Architecte - Création du Plan

```
👤 Vous : Je veux ajouter un système de panier d'achat
           - Ajout/suppression de produits
           - Quantité modifiable
           - Calcul du total
           - Persistance dans localStorage côté client

🤖 IA : Voici le plan proposé. Je vais le créer dans la branche `.macro` sous branches/main/plan.md :

# Plan : Panier d'Achat

## Description
Implémentation complète du système de panier avec gestion des articles et calcul du total.

## Tâches Planifiées

### 1. Créer le store Zustand pour le panier
- State : items[], total
- Actions : addItem, removeItem, updateQuantity, clearCart
- Persistance localStorage

### 2. Créer le composant CartItem
- Affichage produit
- Contrôle quantité (+/-)
- Bouton suppression

### 3. Créer le composant Cart
- Liste des CartItem
- Affichage du total
- Bouton "Commander"

### 4. Intégrer le panier dans ProductPage
- Bouton "Ajouter au panier"
- Lien vers la page panier

### 5. Créer la page CartPage avec checkout
- Liste des items
- Récapitulatif du total
- Formulaire de checkout
- Validation avant envoi

### 6. Créer le composant CheckoutForm
- Informations de livraison
- Informations de paiement
- Validation des champs

### 7. Créer l'endpoint de commande (Backend)
- POST /api/orders
- Validation du panier
- Création de la commande en base

## Commits Planifiés

### feat(frontend): add cart store
- Fichier : stores/useCartStore.ts
- Dépendances : zustand, immer

### feat(frontend): add cart UI components
- Fichiers : components/CartItem.tsx, components/Cart.tsx

### feat(frontend): integrate cart in product page
- Fichier modifié : pages/ProductPage.tsx

### feat(frontend): add cart page with checkout
- Fichiers : pages/CartPage.tsx, components/CheckoutForm.tsx

### feat(backend): add order creation endpoint
- Fichier : api/routes/orders.ts

## Date de Création
2026-01-15T10:00:00Z

Voulez-vous que je modifie quelque chose ?

👤 Vous : C'est parfait, garde ce plan tel quel.

🤖 IA : Excellent ! Je vais créer la branche `feature-cart` dans les dépôts concernés et enregistrer le plan dans la branche `.macro`.

**Branches créées :**

```
Dépôt Git Frontend          Dépôt Git Backend
main                         main
└─ feature-cart            └─ feature-cart
```

**Plan enregistré dans la branche `.macro` :**
- `.macro/branches/feature-cart/plan.md`
- `.macro/branches/feature-cart/commits/feat-cart-store/planned.md`
- `.macro/branches/feature-cart/commits/feat-cart-ui/planned.md`
- ... (un dossier planned.md par commit prévu)

Prêt à passer en mode implémentation ?
```

👤 Vous : Oui, prêt !
```

### Étape 2 : Préparation des Tâches

```
👤 Vous : Oui, commençons par le store Zustand.

🤖 IA : Quelques questions avant de générer le store :
1. Voulez-vous utiliser immer avec Zustand pour les updates immutables ?
2. Le panier doit-il supporter des variants (couleur, taille) du même produit ?

👤 Vous :
1. Oui, utilise immer
2. Non, juste des quantités simples pour l'instant

🤖 IA : Parfait, je vais créer le store avec immer et une structure simple.

Je vais d'abord créer le fichier planned.md pour ce commit :

# Commit : feat(frontend): add cart store

## Description
Création du store Zustand pour gérer le panier d'achat avec persistance localStorage.

## Fichiers Planifiés
- stores/useCartStore.ts (nouveau fichier)

## Features
- State : items[], total
- Actions : addItem, removeItem, updateQuantity, clearCart
- Persistance localStorage avec Zustand persist middleware
- Calcul automatique du total à chaque changement

## Dépendances
- zustand
- immer
- @types/uuid

## Date de Création
2026-01-15T11:00:00Z

## Statut
Planned

Maintenant je génère le code :

// stores/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

interface CartItem {
  id: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl?: string;
}

interface CartState {
  items: CartItem[];
  total: number;
  addItem: (product: Omit<CartItem, 'id'>) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  clearCart: () => void;
}

export const useCartStore = create<CartState>()(
  persist(
    immer((set) => ({
      items: [],
      total: 0,

      addItem: (product) =>
        set((state) => {
          const existingIndex = state.items.findIndex(
            (item) => item.productId === product.productId
          );

          if (existingIndex !== -1) {
            state.items[existingIndex].quantity += product.quantity;
          } else {
            state.items.push({
              ...product,
              id: crypto.randomUUID(),
            });
          }

          state.total = state.items.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
          );
        }),

      removeItem: (id) =>
        set((state) => {
          state.items = state.items.filter((item) => item.id !== id);
          state.total = state.items.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
          );
        }),

      updateQuantity: (id, quantity) =>
        set((state) => {
          const item = state.items.find((item) => item.id === id);
          if (item) {
            item.quantity = Math.max(1, quantity);
            state.total = state.items.reduce(
              (sum, item) => sum + item.price * item.quantity,
              0
            );
          }
        }),

      clearCart: () =>
        set(() => ({
          items: [],
          total: 0,
        })),
    })),
    {
      name: 'cart-storage',
    }
  )
);

Le store inclut :
- ✅ Middleware immer pour les updates immutables
- ✅ Persistance localStorage
- ✅ Calcul automatique du total
- ✅ Type safety complète

Voulez-vous appliquer ces modifications ?

👤 Vous : Oui, c'est parfait. Applique.

🤖 IA : ✅ Modifications appliquées avec succès !

**Dépôt Git Frontend :**
- Fichier créé : stores/useCartStore.ts
- Commit créé sur la branche feature-cart : feat(frontend): add cart store
- Commit ID : abc123def456...

**Dépôt Git Backend :** (aucun changement)

**Branche `.macro` :**
- Fichier executed.md créé : .macro/branches/feature-cart/commits/feat-cart-store/executed.md

Voici le contenu du fichier executed.md créé :

# Exécution : feat(frontend): add cart store

## Date d'Exécution
2026-01-15T11:30:00Z

## Fichiers Créés
- stores/useCartStore.ts (dans dépôt Frontend)

## Changements par rapport au plan
- Aucun changement

## Tests
- useCartStore.test.ts : 8/8 tests passants

## Commit ID
abc123def456... (référence au commit sur la branche feature-cart du dépôt Frontend)

## Statut
Success

**État des dépôts après cette tâche :**

```
Dépôt Git Frontend          Dépôt Git Backend
main                         main
└─ feature-cart            └─ feature-cart
    └─ abc123: add store    (aucun commit)
```

Prêt pour la tâche suivante ?
```

### Étape 4 : Continuer avec les Tâches Suivantes

Le processus se répète pour chaque tâche, avec :
- Dialogue interactif pour clarifier les besoins
- Génération de code
- Revue et validation
- Application atomique des modifications

### Étape 5 : Finalisation

```
🤖 IA : Toutes les tâches sont terminées !

✅ Panier d'achat implémenté avec succès
✅ Tests unitaires générés et passants

## Résumé des Opérations

### Commits sur la Branche Principale
- [green] abc123: feat(frontend): add cart store
- [green] def456: feat(frontend): add cart UI components
- [green] ghi789: feat(frontend): integrate cart in product page
- [green] jkl012: feat(frontend): add cart page with checkout
- [green] mno345: feat(backend): add order creation endpoint

### Fichiers Exécution dans la Branche `.macro`
Chaque commit a son dossier avec :
- `planned.md` : Ce qui était prévu avant l'exécution
- `executed.md` : Ce qui a été réellement fait après l'exécution

Le graphe git de la branche principale montre maintenant 5 commits verts (effectués).
Le plan dans la branche `.macro` contient tous les fichiers d'exécution correspondants.

Voulez-vous tester la fonctionnalité maintenant ?

👤 Vous : Oui, testons-la.
```

---

## Conclusion

Le workflow Macro transforme la manière de développer en :
- **Planification d'abord**, exécution ensuite
- **Architecte humain**, Constructeur IA
- **Validation continue** à chaque étape
- **Opérations atomiques** et réversibles
- **Collaboration facilitée** via Git

En suivant ce workflow, vous maintenez un code de haute qualité tout en bénéficiant de la puissance de l'IA pour la génération et l'implémentation.

### À Propos de la Branche `.macro`

> **Note Importante** : La branche `.macro` contient toutes les métadonnées de Macro, indépendamment du code source. Son organisation interne est parallèle aux branches git du projet (main, feature/*, etc.).

---

## Ressources Supplémentaires

- [Vue d'ensemble du projet](01-project-overview.md)
- [Plan Frontend](02-frontend-plan.md)
- [Plan Backend](03-backend-plan.md)
- [Analyse détaillée](analysis.md)
