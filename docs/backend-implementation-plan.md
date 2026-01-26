# Macro — Plan d’implémentation du backend Tauri (exhaustif)

## 1) Objectif
Ce document décrit **tout** ce que l’implémenteur doit faire pour construire un backend Tauri solide pour Macro. Il sert de guide d’exécution étape par étape et de checklist de validation. Le backend doit :

- Fournir une couche **IPC** fiable (commandes Tauri) entre l’UI et Rust.
- Gérer **FS + Git + DB locale + Indexation + IA**.
- Être **local-first**, robuste, asynchrone, testable et sécurisé.

## 2) État actuel du backend
- `src-tauri/src/main.rs` : appelle `macro_lib::run()`.
- `src-tauri/src/lib.rs` : un seul command `greet()` + `tauri_plugin_opener`.
- `src-tauri/Cargo.toml` : seulement `tauri`, `serde`, `serde_json`.
- `src-tauri/capabilities/default.json` : permissions `core:default` + `opener:default`.

➡️ **Tout le backend est à construire.**

## 3) Principes d’architecture
- **Modulaire** : un module Rust par domaine (FS, Git, DB, IA…).
- **Non-bloquant** : pas d’opérations lourdes dans le thread UI.
- **IPC typée** : toutes les commandes ont des DTO sérialisables (`serde`).
- **Sécurité stricte** : permissions Tauri limitées aux besoins réels.
- **Local-first** : tout fonctionne offline; réseau seulement pour IA distante.

## 4) Architecture cible (vue macro)

```
UI (React)
  ↕ IPC (Tauri commands)
Backend Rust (Tauri)
  ├─ core/          -> erreurs, config, logging
  ├─ db/            -> SQLite, migrations
  ├─ fs/            -> accès fichiers + watchers
  ├─ git/           -> libgit2 wrapper
  ├─ index/         -> tree-sitter + embeddings + vectordb
  ├─ ai/            -> providers + streaming
  ├─ workspace/     -> multi-projets, metadata
  └─ commands/      -> registre des commandes IPC
```

## 5) Structure de dossiers Rust recommandée
Créer ces modules dans `src-tauri/src/` :

```
src-tauri/src/
  lib.rs
  main.rs
  commands/
    mod.rs
    fs.rs
    git.rs
    db.rs
    index.rs
    ai.rs
    workspace.rs
    plan.rs
  core/
    mod.rs
    error.rs
    config.rs
    logging.rs
  db/
    mod.rs
    schema.rs
    migrations/
  fs/
    mod.rs
    watcher.rs
  git/
    mod.rs
    repo.rs
  index/
    mod.rs
    embed.rs
    vectordb.rs
    treesitter.rs
  ai/
    mod.rs
    providers/
      mod.rs
      openai.rs
      anthropic.rs
      local.rs
  workspace/
    mod.rs
    metadata.rs
```

## 6) Conventions IPC
### 6.1 Nommage
- Commandes en `snake_case`, préfixées par domaine :
  - `fs_read_file`, `git_status`, `db_get_conversation`…

### 6.2 Résultats
Toutes les commandes renvoient :

```
Result<Payload, BackendError>
```

Avec `BackendError` sérialisable, contenant :
- `code` (string stable)
- `message`
- `details` (JSON optionnel)

### 6.3 DTOs
Créer des structs dédiés par commande.

## 7) Core: erreurs, logging, config
### Tâches
- Créer `core/error.rs` : enum `BackendError` + conversions (`thiserror`).
- Créer `core/logging.rs` : setup `tracing` (console + file optionnel).
- Créer `core/config.rs` : charge config runtime (paths, features).

### Dépendances (Rust)
- `thiserror`
- `tracing`, `tracing-subscriber`
- `config` (optionnel)

## 8) Base de données (SQLite)
### Objectif
Stocker les données locales non partagées (chat, préférences, cache, index local).

### Recommandations
- Utiliser `sqlx` (async) ou `rusqlite` + thread pool.
- Ajouter migrations versionnées.

### Schéma minimal conseillé
**tables** :
- `conversations` (id, title, created_at)
- `messages` (id, conversation_id, role, content, created_at)
- `settings` (key, value)
- `workspace_cache` (key, value)
- `index_jobs` (id, status, created_at, updated_at)

### Tâches
- Ajouter module `db/` + migrations.
- Ajouter commandes `db_*` pour chat, settings, cache.

## 9) File System (FS)
> **⚠️ TÂCHE CRITIQUE** : À implémenter manuellement sans assistance IA. Nécessite une attention particulière à la sécurité et aux permissions Tauri.

### Objectif
Accès sécurisé à l’arborescence du workspace + watchers.

### Tâches
- `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_stat`.
- Watcher pour déclencher re-index.
- Normalisation chemins + sandboxing dans workspace.

### Sécurité
- Limiter l’accès aux dossiers du workspace.
- Ajout permissions Tauri nécessaires dans `capabilities`.

## 10) Git (libgit2)
> **⚠️ TÂCHE CRITIQUE** : À implémenter manuellement sans assistance IA. Nécessite une expertise approfondie en libgit2 et gestion d'erreurs complexes.

### Objectif
Opérations Git robustes et rapides (multi-repo).

### Tâches
- `git_status`, `git_log`, `git_branch_list`, `git_checkout`, `git_commit`, `git_diff`.
- Support multi-repo : chaque projet = repo.
- Abstraction par repository path.

### Dépendances
- `git2`

## 11) Indexation & recherche sémantique
### Objectif
Indexation codebase (tree-sitter) + recherche sémantique (vectordb).

### Pipeline recommandé
1. Scan fichiers → parse tree-sitter
2. Chunking de code
3. Embeddings
4. Stockage dans vectordb

### Options vectordb
- LanceDB (si crate Rust stable)
- Alternative: SQLite + embeddings + index local (fallback)

### Tâches
- Service `indexer` en background.
- Job queue (table `index_jobs`).
- Commandes : `index_start`, `index_status`, `index_search`.

## 12) IA (providers)
### Objectif
Abstraction pour OpenAI, Anthropic et Local.

### Tâches
- Interface `AiProvider` : `stream_chat`, `embed`, `health`.
- Provider OpenAI (API compatible).
- Provider Anthropic.
- Provider Local (base URL).
- Gestion streaming vers UI.

### Sécurité
- Chargement clés via `.env` (local) + stockage sécurisé à terme.

## 13) Workspace & multi-projets
### Objectif
Support multi-repo, metadata, relations entre projets.

### Tâches
- `workspace_open`, `workspace_list_projects`, `workspace_get_metadata`.
- Charger `.project-meta.yaml` (si présent) + fallback.
- Stockage local des relations dans SQLite.

## 14) Sécurité Tauri
### Tâches
- Étendre `src-tauri/capabilities/default.json` avec permissions minimales.
- Éviter `csp: null` en prod; définir CSP ciblée.
- Filtrer toute commande sensible.

## 15) Plan d’implémentation (phases)

> **⚠️ NOTE IMPORTANTE** : Les phases 2 (FS) et 3 (Git) sont des **tâches critiques** à implémenter manuellement sans assistance IA. Elles nécessitent une expertise spécialisée en sécurité système et gestion d'erreurs complexes.

### Phase 0 — Bootstrap technique
- Ajouter dépendances Rust de base.
- Créer modules + wiring `lib.rs`.
- Supprimer `greet()` après création des commandes réelles.

### Phase 1 — Core + DB + Logging
- Implémenter `BackendError`.
- Init logging.
- Setup SQLite + migrations.
- Commandes DB basiques.

### Phase 2 — FS + Watchers
- Commandes FS.
- Watcher file system.

### Phase 3 — Git
- Wrapper libgit2.
- Commandes Git essentielles.

### Phase 4 — Indexation
- Parser tree-sitter.
- Embeddings (provider stub).
- Vector DB.

### Phase 5 — IA providers
- Abstraction providers.
- Streaming vers UI.
- Stockage sécurisé clé (phase suivante).

### Phase 6 — Sécurité & stabilisation
- Capabilities ajustées.
- Tests et perf.

## 16) Checklist d’acceptation
- [ ] Toutes les commandes IPC sont documentées et testées.
- [ ] DB locale opérationnelle avec migrations.
- [ ] FS sécurisé et sandboxé.
- [ ] Git fonctionne sur repos multiples.
- [ ] Indexation + recherche sémantique OK.
- [ ] IA streaming OK.
- [ ] Pas de permissions inutiles dans capabilities.
- [ ] Logs structurés activés.

## 17) Tests
- Tests unitaires par module.
- Tests d’intégration sur DB, Git et Indexation.
- Tests IPC end-to-end (UI → Rust).

## 18) Livrables attendus
- Modules Rust prêts.
- Documentation des commandes IPC.
- Migrations DB.
- Config sécurité Tauri à jour.
- Tests verts.

---

**Note finale** : ce plan doit être suivi dans l’ordre des phases. Chaque phase doit être validée avant d’attaquer la suivante.
