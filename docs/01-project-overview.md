# Macro - L'Éditeur de Code Organisé

## Vision du Projet

Macro est un éditeur de code conçu pour le "vibe-coding organisé". Contrairement aux outils qui se concentrent uniquement sur la génération AI, Macro met l'accent sur la **méthodologie** du codage assisté par IA — en veillant à ce que la génération rapide ne mène pas à une dette technique ou à un code non maintenable.

---

## La Philosophie "Macro Method"

### 1. Architect-First
Chaque changement commence par une planification structurée en mode Architecte.

### 2. Validation Itérative
Les générations IA sont décomposées en petites tâches vérifiables.

### 3. Boucle Humaine
Le développeur humain est l'"Architecte" en mode Architecte, l'IA exécute comme "Constructeur" en mode Implémentation.

### 4. Raisonnel Persistant
Le "pourquoi" derrière chaque décision IA est tracé avec le code.

---

## Architecture Technique

### Stack Frontend
- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite
- **UI Framework**: TailwindCSS + Shadcn/ui
- **State Management**: Zustand (global) + Jotai (composant)
- **Éditeur**: CodeMirror 6
- **Backend**: Tauri v2 (Rust)

### Stack Backend
- **Runtime**: Tauri v2
- **Langage**: Rust
- **Base de données**: SQLite (données locales)
- **Git**: libgit2 (opérations git)
- **Indexation**: Vector DB (LanceDB) pour la recherche sémantique

---

## Concepts Clés

### Modes de Travail

**Mode Architecte**
- Création de plans de haut niveau
- Définition des features et structure git prédite
- Validation avant exécution

**Mode Implémentation**
- Exécution des tâches planifiées
- L'IA pose des questions via chat
- Révision des modifications avant application

### Multi-Projet

**Layout**
- **Panneau gauche**: Groupes d'onglets verticaux pour les projets
- **Centre**: Chat toujours visible avec liste de tâches unifiée
- **Panneau droit**: Graphes du dépôt git multiples (un par projet)
  - Commits faits : affichés en vert
  - Commits planifiés : affichés en bleu
  - Commits en cours : affichés en orange

**Organisation**
- Projets indépendants → groupes séparés (travail simultané)
- Projets interdépendants → même groupe vertical
- Tâches affectant plusieurs projets apparaissent une fois dans la liste mais reflétées dans chaque graphe du dépôt git

### Principes de Conception

- **Éditeur majoritairement en lecture seule**: L'humain ne fait que de petits ajustements
- **Opérations atomiques multi-projets**: Toutes les modifications acceptées/rejetées ensemble
- **Sécurité de la structure** > Vitesse d'exécution
- **IA architecture-aware**: Comprend les relations entre projets et suggère les changements appropriés

---

## Stratégie de Stockage

### Données Locales (SQLite)
- Historique des conversations
- Données privées utilisateur

### Données Partagées (Git)
- Plans et tâques → branche `.macro`
- Métadonnées projet → `.project-meta.yaml`
- Contrats API → fichiers OpenAPI/GraphQL par projet
- Graphe du dépôt git prédit → commité dans `.macro`

---

## Roadmap d'Implémentation

### Phase 1: Foundation
- [x] Structure Tauri v2
- [x] React + TypeScript + Vite
- [ ] TailwindCSS + Shadcn/ui
- [ ] CodeMirror 6 + highlighting
- [ ] Système d'onglets (Zustand)
- [ ] Bridge système de fichiers (Tauri fs + path)

### Phase 2: Workflow Organisé
- [ ] Mode Architecte UI
- [ ] Mode Implémentation UI
- [ ] Interface de chat
- [ ] Quality gates (linting/testing automatisé)

### Phase 3: Intelligence Projet
- [ ] Indexation codebase (tree-sitter)
- [ ] Recherche sémantique (Vector DB)
- [ ] Abstraction fournisseurs IA (OpenAI/Anthropic/Local)
- [ ] Intégration git profonde (libgit2)

---

## Avantages Concurrentiels

### vs Cursor AI
- ✅ Open-source
- ✅ Support local-first
- ✅ Outils d'organisation projet intégrés prévenant le "mess"

### vs VS Code
- ✅ Architecture neuve et légère (pas de legacy)
- ✅ IA comme cœur de l'architecture (pas une extension)
- ✅ Workflow structuré intégré

---

## Métriques de Succès

**Cible d'utilisateurs**: Développeurs professionnels et débutants
**Approche**: Sécurité de la structure avant vitesse
**Objectif**: Prévenir la dette technique tout en maintenant la productivité
