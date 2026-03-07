# Spécifications API Mobile - Macro

## Document de Conception Complète

**Version**: 1.0  
**Date**: 16 Février 2026  
**Statut**: Draft - Planification Stratégique

---

## Table des Matières

1. [Vue d'Ensemble et Objectifs](#1-vue-densemble-et-objectifs)
2. [Analyse des Workflows Macro](#2-analyse-des-workflows-macro)
3. [Architecture de l'API](#3-architecture-de-lapi)
4. [Modèle de Données](#4-modèle-de-données)
5. [Système d'Authentification](#5-système-dauthentification)
6. [Endpoints et API](#6-endpoints-et-api)
7. [Synchronisation Temps Réel](#7-synchronisation-temps-réel)
8. [Gestion Hors-Ligne](#8-gestion-hors-ligne)
9. [Sécurité](#9-sécurité)
10. [Scalabilité et Performance](#10-scalabilité-et-performance)
11. [Roadmap d'Implémentation](#11-roadmap-dimplémentation)
12. [Annexes](#12-annexes)

---

## 1. Vue d'Ensemble et Objectifs

### 1.1 Objectif Principal

Créer une API robuste et sécurisée permettant à l'application Macro de se connecter depuis un téléphone mobile et de poursuivre le développement à distance. Le chat doit pouvoir renvoyer son état complet au serveur pour synchronisation temps réel.

### 1.2 Principes Directeurs

- **Continuité d'expérience** : L'utilisateur peut passer du desktop au mobile sans perte de contexte
- **Sécurité maximale** : Toutes les communications chiffrées, authentification forte
- **Résilience** : Fonctionnement hors-ligne avec synchronisation différée
- **Performance** : Latence minimale, mise à jour temps réel
- **Atomicité** : Maintien des opérations atomiques cross-projets même sur mobile

### 1.3 Cas d'Usage Principaux

1. **Continuation de session** : L'utilisateur quitte son bureau, prend son téléphone et continue exactement où il s'était arrêté
2. **Validation rapide** : Relire et valider des tâches depuis son téléphone
3. **Réponses IA** : Répondre aux questions de l'IA pendant un déplacement
4. **Monitoring** : Suivre l'avancement des tâches et commits en temps réel
5. **Planification mobile** : Créer des plans et définir des intentions depuis le téléphone

### 1.4 Contraintes Mobiles

- Écran plus petit (simplification UI nécessaire)
- Connexion intermittente (3G/4G/5G/WiFi variable)
- Batterie limitée (optimisation requise)
- Clavier virtuel (interactions simplifiées)
- Notifications push (alertes importantes)

---

## 2. Analyse des Workflows Macro

### 2.1 Workflow Mode Architecte (Planification)

**Étapes clés**:
1. L'utilisateur entre une intention dans le chat
2. L'IA génère un plan structuré avec tâches et dépendances
3. L'IA crée des branches feature/* dans les dépôts concernés
4. L'IA prédit les graphes git pour chaque projet
5. L'utilisateur valide/modifie le plan
6. Le plan est sauvegardé dans la branche `@macro`

**Besoins API Mobile**:
- Création de plans via chat mobile
- Visualisation simplifiée des graphes git
- Validation à un clic des propositions IA
- Synchronisation des plans créés sur desktop

### 2.2 Workflow Mode Implémentation (Exécution)

**Étapes clés**:
1. L'utilisateur sélectionne une tâche
2. L'IA analyse le contexte et pose des questions
3. L'IA génère du code et montre les diffs
4. L'utilisateur approuve ou rejète (opération atomique)
5. Les modifications sont appliquées et commitées
6. Les fichiers `executed.md` sont créés dans `.macro`

**Besoins API Mobile**:
- Liste des tâches avec indicateurs visuels
- Dialogue interactif avec l'IA (questions/réponses)
- Visualisation des diffs (simplifiée)
- Approbation/Rejet atomique
- Suivi temps réel des modifications

### 2.3 Workflow Multi-Projets

**Caractéristiques**:
- Projets groupés verticalement
- Tâches cross-projets apparaissent une seule fois
- Modifications atomiques sur plusieurs projets
- Branches synchronisées entre dépôts

**Besoins API Mobile**:
- Vue unifiée des groupes de projets
- Indicateurs visuels des projets concernés par une tâche
- Synchronisation cross-projets
- Gestion des dépendances

### 2.4 Workflow Git

**Opérations supportées**:
- Status, log, branch list
- Checkout, commit, add, reset
- Diff, stash
- Worktrees pour isolation des tâches

**Besoins API Mobile**:
- Visualisation simplifiée des graphes git
- Statut des branches
- Historique des commits
- Métadonnées `.macro`

### 2.5 Workflow Chat et Conversations

**Caractéristiques**:
- Historique persistant (SQLite local)
- Streaming des réponses IA
- Outils intégrés (mark_source_passage, read_sources, etc.)
- Citations et contexte
- Pièces jointes (images)

**Besoins API Mobile**:
- **Synchronisation temps réel** des messages
- Envoi de messages avec support multimédia
- Streaming des réponses
- Gestion des outils
- Notifications pour nouveaux messages

---

## 3. Architecture de l'API

### 3.1 Choix Architectural

**Approche Hybride**:
- **REST API** pour les opérations CRUD et requêtes ponctuelles
- **WebSockets** pour le temps réel (chat, notifications)
- **SSE (Server-Sent Events)** pour le streaming IA
- **Protocol Buffers** pour la sérialisation efficace

**Pourquoi cette approche ?**
- REST : Maturité, cacheable, facilement débogable
- WebSockets : Bidirectionnel temps réel pour le chat
- SSE : Unidirectionnel, idéal pour le streaming (reconnexion automatique)
- Protobuf : Compact, rapide, typage fort

### 3.2 Stack Technique Recommandé

**Backend API**:
- **Langage**: Go (performance, concurrence, écosystème mature)
- **Framework**: Gin ou Echo (routing, middlewares)
- **WebSockets**: Gorilla WebSocket
- **Base de données**: PostgreSQL (données relationnelles) + Redis (cache/sessions temps réel)
- **Message Queue**: Redis Streams ou RabbitMQ
- **Authentification**: JWT + Refresh Tokens + OAuth2

**Alternatives**:
- Rust + Actix-web (si équipe Rust/Tauri experte)
- Node.js + NestJS (rapidité de développement)
- Python + FastAPI (pour intégration IA directe)

**Infrastructure**:
- Docker + Kubernetes (orchestration)
- Envoy ou Nginx (reverse proxy, load balancing)
- Prometheus + Grafana (monitoring)
- ELK Stack (logging)

### 3.3 Architecture de Haut Niveau

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENTS                                 │
├──────────────┬─────────────────┬────────────────────────────┤
│   Desktop    │    Mobile App   │        Web App             │
│   (Tauri)    │  (React Native) │      (Future)              │
└──────┬───────┴────────┬────────┴────────────┬───────────────┘
       │                │                     │
       └────────────────┼─────────────────────┘
                        │
       ┌────────────────▼──────────────────────┐
       │           API Gateway                 │
       │  (Auth, Rate Limiting, Routing)       │
       └────────────────┬──────────────────────┘
                        │
       ┌────────────────▼──────────────────────┐
       │        Load Balancer (Envoy)          │
       └────────────────┬──────────────────────┘
                        │
       ┌────────────────▼──────────────────────┐
       │        API Servers (Go)               │
       │  ┌─────────┐ ┌─────────┐ ┌─────────┐  │
       │  │ Server 1│ │ Server 2│ │ Server N│  │
       │  └─────────┘ └─────────┘ └─────────┘  │
       └────────┬──────────────────┬───────────┘
                │                  │
       ┌────────▼────────┐  ┌──────▼─────────┐
       │   PostgreSQL    │  │     Redis      │
       │  (Primary Data) │  │ (Cache/Queue)  │
       └─────────────────┘  └────────────────┘
```

### 3.4 Flux de Données Temps Réel

```
Mobile App                    API Server
     │                              │
     │  1. WS: /ws/connect          │
     │ ───────────────────────────> │
     │                              │
     │  2. Auth: token + device_id  │
     │ ───────────────────────────> │
     │                              │
     │  3. WS: connection confirmed │
     │ <─────────────────────────── │
     │                              │
     │  4. Subscribe: channels[]    │
     │ ───────────────────────────> │
     │                              │
     │  5. [Temps réel] messages    │
     │ <─────────────────────────── │
     │                              │
```

### 3.5 Modèle de Communication

**Canaux WebSockets**:
- `chat:{user_id}` : Messages de chat personnels
- `project:{project_id}` : Mises à jour projet
- `task:{task_id}` : Statut des tâches
- `git:{repo_id}` : Événements git
- `system:{user_id}` : Notifications système

**Events SSE**:
- `ai.stream` : Streaming des réponses IA
- `sync.progress` : Progression de la synchronisation
- `git.operation` : Opérations git en cours

---

## 4. Modèle de Données

### 4.1 Entités Principales

#### 4.1.1 Utilisateur et Sessions

```protobuf
message User {
  string id = 1;
  string email = 2;
  string name = 3;
  string avatar_url = 4;
  UserPreferences preferences = 5;
  string created_at = 6;
  string updated_at = 7;
  bool is_active = 8;
}

message UserPreferences {
  string theme = 1;           // "light", "dark", "system"
  string language = 2;        // "en", "fr"
  bool notifications_enabled = 3;
  bool email_updates = 4;
  MobilePreferences mobile = 5;
}

message MobilePreferences {
  bool sync_on_wifi_only = 1;
  bool background_sync = 2;
  int32 sync_interval_minutes = 3;
  bool push_notifications = 4;
  string data_saving_mode = 5;  // "off", "medium", "high"
}

message Session {
  string id = 1;
  string user_id = 2;
  string token = 3;
  string refresh_token = 4;
  string device_id = 5;
  string device_name = 6;
  string device_type = 7;      // "mobile", "desktop", "web"
  string ip_address = 8;
  string user_agent = 9;
  string created_at = 10;
  string expires_at = 11;
  string last_activity_at = 12;
  bool is_active = 13;
}
```

#### 4.1.2 Workspace et Projets

```protobuf
message Workspace {
  string id = 1;
  string user_id = 2;
  string name = 3;
  string description = 4;
  repeated ProjectGroup groups = 5;
  SyncState sync_state = 6;
  string created_at = 7;
  string updated_at = 8;
}

message ProjectGroup {
  string id = 1;
  string workspace_id = 2;
  string name = 3;
  bool is_open = 4;
  int32 sort_order = 5;
  repeated Project projects = 6;
  string created_at = 7;
  string updated_at = 8;
}

message Project {
  string id = 1;
  string group_id = 2;
  string name = 3;
  string path = 4;
  string remote_url = 5;        // URL du repo git
  ProjectStatus status = 6;
  ProjectMetadata metadata = 7;
  GitState git_state = 8;
  string created_at = 9;
  string updated_at = 10;
}

enum ProjectStatus {
  ACTIVE = 0;
  PAUSED = 1;
  ARCHIVED = 2;
}

message ProjectMetadata {
  string description = 1;
  repeated string tags = 2;
  repeated string team_members = 3;
  repeated ApiContract api_contracts = 4;
  repeated ProjectDependency dependencies = 5;
}

message GitState {
  string current_branch = 1;
  string head_commit = 2;
  bool is_clean = 3;
  int32 ahead_count = 4;
  int32 behind_count = 5;
  repeated string modified_files = 6;
  string last_fetch_at = 7;
}
```

#### 4.1.3 Plans et Tâches

```protobuf
message Plan {
  string id = 1;
  string workspace_id = 2;
  string description = 3;
  PlanStatus status = 4;
  repeated string project_ids = 5;
  repeated Task tasks = 6;
  map<string, PredictedGitTree> predicted_git_trees = 7;  // project_id -> tree
  repeated PlanNode nodes = 8;
  repeated PlanEdge edges = 9;
  string created_at = 10;
  string updated_at = 11;
  string validated_at = 12;
  string completed_at = 13;
}

enum PlanStatus {
  DRAFT = 0;
  VALIDATED = 1;
  IN_PROGRESS = 2;
  COMPLETED = 3;
  CANCELLED = 4;
}

message Task {
  string id = 1;
  string plan_id = 2;
  repeated string project_ids = 3;  // Multi-projets support
  string title = 4;
  string description = 5;
  TaskStatus status = 6;
  repeated string dependencies = 7;  // IDs des tâches dépendantes
  repeated string dependent_tasks = 8;  // IDs des tâches qui dépendent de celle-ci
  repeated FileChange estimated_changes = 9;
  CodeDiff code_diff = 10;
  int32 estimated_hours = 11;
  int32 actual_hours = 12;
  string assigned_branch = 13;
  string conversation_id = 14;
  string created_at = 15;
  string started_at = 16;
  string completed_at = 17;
  string failed_at = 18;
}

enum TaskStatus {
  PENDING = 0;
  IN_PROGRESS = 1;
  AWAITING_RESPONSE = 2;  // En attente de réponse utilisateur
  COMPLETED = 3;
  FAILED = 4;
  BLOCKED = 5;
}

message PlanNode {
  string id = 1;
  string title = 2;
  string description = 3;
  PlanNodeType type = 4;
  PlanNodeStatus status = 5;
  repeated string dependencies = 6;
  string assigned_branch = 7;
  string project_id = 8;
  string estimated_time = 9;
}

enum PlanNodeType {
  SPEC = 0;
  FEATURE = 1;
  TASK = 2;
  MILESTONE = 3;
}

enum PlanNodeStatus {
  NODE_PENDING = 0;
  NODE_IN_PROGRESS = 1;
  NODE_COMPLETED = 2;
  NODE_BLOCKED = 3;
}

message PlanEdge {
  string id = 1;
  string source = 2;
  string target = 3;
  EdgeType type = 4;
}

enum EdgeType {
  DEPENDS_ON = 0;
  BLOCKS = 1;
  RELATES_TO = 2;
}
```

#### 4.1.4 Conversations et Messages

```protobuf
message Conversation {
  string id = 1;
  string workspace_id = 2;
  string title = 3;
  string description = 4;
  string task_id = 5;           // Optionnel: lié à une tâche
  repeated string project_ids = 6;  // Projets concernés
  string last_message = 7;
  int32 message_count = 8;
  bool is_unread = 9;
  int32 unread_count = 10;
  string mode = 11;            // "Architect", "Implement", "Chat"
  SyncState sync_state = 12;
  string created_at = 13;
  string updated_at = 14;
}

message SyncState {
  string last_sync_at = 1;
  string device_last_modified = 2;
  bool is_syncing = 3;
  string sync_error = 4;
  int64 server_version = 5;    // Version vectorielle pour CRDT
  int64 client_version = 6;
}

message ChatMessage {
  string id = 1;
  string conversation_id = 2;
  string task_id = 3;
  MessageRole role = 4;
  string content = 5;
  repeated MessageContent parts = 6;  // Contenu multimodal
  string timestamp = 7;
  string client_timestamp = 8;  // Horodatage client pour ordre
  CodeDiff code_diff = 9;
  repeated AIChoice choices = 10;
  repeated ToolCall tool_calls = 11;
  MessageStatus status = 12;
  string error_message = 13;
  string edited_at = 14;
  string edited_by = 15;
}

enum MessageRole {
  USER = 0;
  ASSISTANT = 1;
  SYSTEM = 2;
}

enum MessageStatus {
  SENDING = 0;
  SENT = 1;
  DELIVERED = 2;
  FAILED = 3;
  STREAMING = 4;
}

message MessageContent {
  ContentType type = 1;
  string text = 2;
  ImageContent image = 3;
  FileContent file = 4;
}

enum ContentType {
  TEXT = 0;
  IMAGE = 1;
  FILE = 2;
  CODE = 3;
}

message ImageContent {
  string url = 1;
  string thumbnail_url = 2;
  int32 width = 3;
  int32 height = 4;
  string mime_type = 5;
  int64 size_bytes = 6;
}

message FileContent {
  string name = 1;
  string path = 2;
  string mime_type = 3;
  int64 size_bytes = 4;
  string url = 5;
}

message AIChoice {
  string id = 1;
  string text = 2;
  string action = 3;  // "accept", "reject", "modify"
}

message ToolCall {
  string id = 1;
  string name = 2;
  string arguments = 3;  // JSON string
  string result = 4;
  bool is_success = 5;
  string executed_at = 6;
}
```

#### 4.1.5 Git et Worktrees

```protobuf
message GitCommit {
  string id = 1;
  string hash = 2;
  string message = 3;
  string author = 4;
  string author_email = 5;
  string date = 6;
  CommitStatus status = 7;
  repeated string parent_ids = 8;
  int32 graph_depth = 9;
  bool is_branch_point = 10;
  string task_id = 11;
  string project_id = 12;
}

enum CommitStatus {
  DONE = 0;
  PLANNED = 1;
  IN_PROGRESS = 2;
}

message GitBranch {
  string id = 1;
  string project_id = 2;
  string name = 3;
  string full_name = 4;
  bool is_current = 5;
  bool is_remote = 6;
  string upstream = 7;
  int32 ahead_count = 8;
  int32 behind_count = 9;
  string last_commit = 10;
  string last_commit_date = 11;
  BranchType type = 12;
}

enum BranchType {
  MAIN = 0;
  DEVELOP = 1;
  FEATURE = 2;
  RELEASE = 3;
  HOTFIX = 4;
  MACRO = 5;  // Branche @macro spéciale
}

message GitTree {
  string project_id = 1;
  string branch = 2;
  repeated GitNode nodes = 3;
  int32 modified_files_count = 4;
  int32 total_files_count = 5;
  string last_updated = 6;
}

message GitNode {
  string name = 1;
  string path = 2;
  NodeType type = 3;
  GitNodeStatus status = 4;
  repeated GitNode children = 5;
  int64 size_bytes = 6;
  string last_modified = 7;
}

enum NodeType {
  FILE = 0;
  DIRECTORY = 1;
}

enum GitNodeStatus {
  UNCHANGED = 0;
  ADDED = 1;
  MODIFIED = 2;
  DELETED = 3;
  RENAMED = 4;
}

message Worktree {
  string id = 1;
  string project_id = 2;
  string task_id = 3;
  string path = 4;
  string branch = 5;
  bool is_active = 6;
  string created_at = 7;
  string last_accessed_at = 8;
}
```

#### 4.1.6 Fichiers et Modifications

```protobuf
message FileChange {
  string path = 1;
  FileOperation operation = 2;
  string diff_preview = 3;
  int32 lines_added = 4;
  int32 lines_removed = 5;
}

enum FileOperation {
  CREATE = 0;
  MODIFY = 1;
  DELETE = 2;
  RENAME = 3;
}

message CodeDiff {
  string id = 1;
  string file_path = 2;
  string old_content = 3;
  string new_content = 4;
  string language = 5;
  int32 lines_added = 6;
  int32 lines_removed = 7;
  DiffStatus status = 8;
  string created_at = 9;
  string applied_at = 10;
}

enum DiffStatus {
  PENDING_REVIEW = 0;
  APPROVED = 1;
  REJECTED = 2;
  APPLIED = 3;
}
```

#### 4.1.7 Configuration IA

```protobuf
message AIProvider {
  string id = 1;
  string user_id = 2;
  string name = 3;
  string provider_type = 4;     // "openai", "anthropic", "openrouter", "local"
  string base_url = 5;
  string api_key_encrypted = 6;  // Chiffré côté serveur
  bool is_local = 7;
  bool is_enabled = 8;
  int32 priority = 9;
  ProviderHealth health = 10;
  string created_at = 11;
  string updated_at = 12;
}

message ProviderHealth {
  string status = 1;           // "online", "offline", "degraded"
  int32 latency_ms = 2;
  string last_check = 3;
  string error_message = 4;
}

message AIModel {
  string id = 1;
  string provider_id = 2;
  string name = 3;
  string description = 4;
  repeated string capabilities = 5;
  string owned_by = 6;
  ModelPricing pricing = 7;
  bool is_free = 8;
  bool is_enabled = 9;
  string first_seen_at = 10;
  string last_seen_at = 11;
}

message ModelPricing {
  string prompt = 1;
  string completion = 2;
  string request = 3;
}
```

### 4.2 Schéma de Base de Données

#### 4.2.1 Tables Principales (PostgreSQL)

```sql
-- Utilisateurs
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Sessions et appareils
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    refresh_token_hash VARCHAR(255) NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(255),
    device_type VARCHAR(50),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(user_id, device_id)
);

-- Workspaces
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    sync_state JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Groupes de projets
CREATE TABLE project_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_open BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projets
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL,
    remote_url TEXT,
    status VARCHAR(50) DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    git_state JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plans
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    description TEXT,
    status VARCHAR(50) DEFAULT 'draft',
    project_ids UUID[] DEFAULT '{}',
    nodes JSONB DEFAULT '[]',
    edges JSONB DEFAULT '[]',
    predicted_git_trees JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    validated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Tâches
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    project_ids UUID[] DEFAULT '{}',
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    dependencies UUID[] DEFAULT '{}',
    estimated_changes JSONB DEFAULT '[]',
    code_diff JSONB,
    estimated_hours INTEGER,
    actual_hours INTEGER,
    assigned_branch VARCHAR(255),
    conversation_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ
);

-- Conversations
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title VARCHAR(255),
    description TEXT,
    task_id UUID,
    project_ids UUID[] DEFAULT '{}',
    last_message TEXT,
    message_count INTEGER DEFAULT 0,
    is_unread BOOLEAN DEFAULT FALSE,
    unread_count INTEGER DEFAULT 0,
    mode VARCHAR(50) DEFAULT 'Chat',
    sync_state JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    task_id UUID,
    role VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    parts JSONB DEFAULT '[]',
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    client_timestamp TIMESTAMPTZ,
    code_diff JSONB,
    choices JSONB DEFAULT '[]',
    tool_calls JSONB DEFAULT '[]',
    status VARCHAR(50) DEFAULT 'sent',
    error_message TEXT,
    edited_at TIMESTAMPTZ,
    edited_by UUID REFERENCES users(id),
    server_version BIGINT DEFAULT 0  -- Pour CRDT
);

-- Commits Git
CREATE TABLE git_commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hash VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    author VARCHAR(255),
    author_email VARCHAR(255),
    date TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'planned',
    parent_ids TEXT[],
    graph_depth INTEGER,
    is_branch_point BOOLEAN DEFAULT FALSE,
    task_id UUID,
    UNIQUE(project_id, hash)
);

-- Branches Git
CREATE TABLE git_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    is_current BOOLEAN DEFAULT FALSE,
    is_remote BOOLEAN DEFAULT FALSE,
    upstream VARCHAR(255),
    ahead_count INTEGER DEFAULT 0,
    behind_count INTEGER DEFAULT 0,
    last_commit VARCHAR(255),
    last_commit_date TIMESTAMPTZ,
    branch_type VARCHAR(50),
    UNIQUE(project_id, name)
);

-- Worktrees
CREATE TABLE worktrees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID,
    path TEXT NOT NULL,
    branch VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Providers IA
CREATE TABLE ai_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    provider_type VARCHAR(100) NOT NULL,
    base_url TEXT,
    api_key_encrypted TEXT,  -- Chiffré avec AES-256
    is_local BOOLEAN DEFAULT FALSE,
    is_enabled BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,
    health JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Modèles IA
CREATE TABLE ai_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    capabilities TEXT[],
    owned_by VARCHAR(255),
    pricing JSONB,
    is_free BOOLEAN DEFAULT FALSE,
    is_enabled BOOLEAN DEFAULT TRUE,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- Queue de synchronisation (pour offline)
CREATE TABLE sync_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    operation VARCHAR(100) NOT NULL,  -- "create", "update", "delete"
    entity_type VARCHAR(100) NOT NULL,  -- "message", "task", "plan", etc.
    entity_id UUID NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',  -- "pending", "processing", "completed", "failed"
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Index pour performance
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_workspaces_user ON workspaces(user_id);
CREATE INDEX idx_projects_group ON projects(group_id);
CREATE INDEX idx_tasks_plan ON tasks(plan_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_git_commits_project ON git_commits(project_id);
CREATE INDEX idx_git_branches_project ON git_branches(project_id);
CREATE INDEX idx_sync_queue_user ON sync_queue(user_id, status);
```

#### 4.2.2 Structure Redis

```
# Sessions temps réel
session:{token} -> hash (user_id, device_id, ws_connection_id)

# Présence utilisateur
user:{user_id}:presence -> hash (status, last_seen, device_ids[])

# Canaux WebSockets
ws:channel:{channel_name} -> set (connection_ids)

# Cache conversations récentes
conversation:{id}:messages -> sorted set (score: timestamp, member: message_json)
conversation:{id}:metadata -> hash

# Rate limiting
rate_limit:{user_id}:{endpoint} -> counter with TTL

# Queue de messages temps réel
stream:events -> Redis Stream (pour diffusion events)

# Locks distribués
lock:{entity_type}:{entity_id} -> string with TTL
```

---

## 5. Système d'Authentification

### 5.1 Flux d'Authentification

#### 5.1.1 Inscription

```
1. POST /api/v1/auth/register
   Body: { email, password, name, device_info }
   
2. Serveur:
   - Valide email (format, unicité)
   - Hash password (Argon2id)
   - Crée utilisateur
   - Envoie email de confirmation
   - Génère tokens
   
3. Response: { user, access_token, refresh_token, expires_in }
```

#### 5.1.2 Connexion

```
1. POST /api/v1/auth/login
   Body: { email, password, device_id, device_name, device_type }
   
2. Serveur:
   - Vérifie credentials
   - Génère access_token (JWT, 15 min)
   - Génère refresh_token (opaque, 7 jours)
   - Stocke session
   
3. Response: { user, access_token, refresh_token, expires_in }
```

#### 5.1.3 Rafraîchissement Token

```
1. POST /api/v1/auth/refresh
   Headers: Authorization: Bearer {refresh_token}
   
2. Serveur:
   - Vérifie refresh_token en DB
   - Génère nouveau access_token
   - Rotation optionnelle du refresh_token
   
3. Response: { access_token, expires_in }
```

#### 5.1.4 Connexion WebSocket

```
1. WS /ws/v1/connect?token={access_token}
   
2. Serveur:
   - Valide JWT
   - Vérifie session active
   - Enregistre connexion
   - Envoie confirmation
   
3. Client reçoit: { type: "connected", channels: [] }
```

### 5.2 Sécurité Multi-Facteur (MFA)

**Optionnel mais recommandé**:
- TOTP (Google Authenticator, Authy)
- WebAuthn / FIDO2 (clés physiques, Face ID, Touch ID)
- SMS (moins sécurisé, à éviter)

### 5.3 Gestion des Appareils

```protobuf
message DeviceInfo {
  string device_id = 1;      // UUID persistant par appareil
  string device_name = 2;    // "iPhone de John", "MacBook Pro"
  string device_type = 3;    // "ios", "android", "desktop"
  string os_version = 4;
  string app_version = 5;
  string push_token = 6;     // Pour notifications push
}
```

**Fonctionnalités**:
- Liste des appareils connectés
- Révocation d'appareil distant
- Synchronisation sélective par appareil
- Détection de nouvel appareil (alerte email)

### 5.4 Authentification Desktop ↔ Mobile

**Scénario** : L'utilisateur veut connecter son mobile sans taper de mot de passe.

```
Option 1: QR Code
1. Desktop affiche QR code avec session_temp_id
2. Mobile scanne et envoie: POST /api/v1/auth/link { session_temp_id, mobile_device_info }
3. Desktop reçoit confirmation via WS
4. Mobile reçoit tokens

Option 2: Lien Magique
1. Mobile demande: POST /api/v1/auth/magic-link { email }
2. Desktop affiche notification: "Connecter cet appareil ?"
3. Desktop approuve
4. Mobile reçoit tokens via deep link

Option 3: Code à 6 chiffres
1. Desktop génère code temporaire (5 min)
2. Mobile entre le code
3. Validation et connexion
```

---

## 6. Endpoints et API

### 6.1 REST API Endpoints

#### 6.1.1 Authentification

```yaml
POST   /api/v1/auth/register           # Inscription
POST   /api/v1/auth/login              # Connexion
POST   /api/v1/auth/refresh            # Rafraîchir access_token
POST   /api/v1/auth/logout             # Déconnexion
POST   /api/v1/auth/logout-all         # Déconnexion tous appareils
GET    /api/v1/auth/me                 # Profil utilisateur
PUT    /api/v1/auth/me                 # Mettre à jour profil
PUT    /api/v1/auth/password           # Changer mot de passe
POST   /api/v1/auth/magic-link         # Demander lien magique
POST   /api/v1/auth/link               # Lier appareil (QR code)
POST   /api/v1/auth/mfa/enable         # Activer MFA
POST   /api/v1/auth/mfa/verify         # Vérifier MFA
GET    /api/v1/auth/sessions           # Lister sessions
DELETE /api/v1/auth/sessions/{id}      # Révoquer session
```

#### 6.1.2 Workspaces

```yaml
GET    /api/v1/workspaces                    # Lister workspaces
POST   /api/v1/workspaces                    # Créer workspace
GET    /api/v1/workspaces/{id}               # Détails workspace
PUT    /api/v1/workspaces/{id}               # Modifier workspace
DELETE /api/v1/workspaces/{id}               # Supprimer workspace
GET    /api/v1/workspaces/{id}/sync-status   # État de synchronisation
POST   /api/v1/workspaces/{id}/sync          # Forcer synchronisation
```

#### 6.1.3 Projets

```yaml
GET    /api/v1/workspaces/{id}/groups              # Lister groupes
POST   /api/v1/workspaces/{id}/groups              # Créer groupe
PUT    /api/v1/groups/{id}                         # Modifier groupe
DELETE /api/v1/groups/{id}                         # Supprimer groupe

GET    /api/v1/groups/{id}/projects                # Lister projets
POST   /api/v1/groups/{id}/projects                # Créer projet
GET    /api/v1/projects/{id}                       # Détails projet
PUT    /api/v1/projects/{id}                       # Modifier projet
DELETE /api/v1/projects/{id}                       # Supprimer projet
GET    /api/v1/projects/{id}/git-status            # Statut git
GET    /api/v1/projects/{id}/branches              # Lister branches
GET    /api/v1/projects/{id}/commits               # Lister commits
GET    /api/v1/projects/{id}/tree                  # Arborescence
```

#### 6.1.4 Plans et Tâches

```yaml
GET    /api/v1/workspaces/{id}/plans           # Lister plans
POST   /api/v1/workspaces/{id}/plans           # Créer plan
GET    /api/v1/plans/{id}                      # Détails plan
PUT    /api/v1/plans/{id}                      # Modifier plan
DELETE /api/v1/plans/{id}                      # Supprimer plan
POST   /api/v1/plans/{id}/validate             # Valider plan
POST   /api/v1/plans/{id}/cancel               # Annuler plan

GET    /api/v1/plans/{id}/tasks                # Lister tâches
POST   /api/v1/plans/{id}/tasks                # Créer tâche
GET    /api/v1/tasks/{id}                      # Détails tâche
PUT    /api/v1/tasks/{id}                      # Modifier tâche
DELETE /api/v1/tasks/{id}                      # Supprimer tâche
POST   /api/v1/tasks/{id}/start                # Démarrer tâche
POST   /api/v1/tasks/{id}/complete             # Marquer comme complétée
POST   /api/v1/tasks/{id}/fail                 # Marquer comme échouée
POST   /api/v1/tasks/{id}/approve              # Approuver modifications
POST   /api/v1/tasks/{id}/reject               # Rejeter modifications
POST   /api/v1/tasks/{id}/revert               # Revenir en arrière
```

#### 6.1.5 Conversations et Messages

```yaml
GET    /api/v1/workspaces/{id}/conversations   # Lister conversations
POST   /api/v1/workspaces/{id}/conversations   # Créer conversation
GET    /api/v1/conversations/{id}              # Détails conversation
PUT    /api/v1/conversations/{id}              # Modifier conversation
DELETE /api/v1/conversations/{id}              # Supprimer conversation
POST   /api/v1/conversations/{id}/read         # Marquer comme lu

GET    /api/v1/conversations/{id}/messages     # Lister messages
POST   /api/v1/conversations/{id}/messages     # Envoyer message
GET    /api/v1/messages/{id}                   # Détails message
PUT    /api/v1/messages/{id}                   # Modifier message
DELETE /api/v1/messages/{id}                   # Supprimer message

POST   /api/v1/messages/{id}/stream            # Stream réponse IA (SSE)
POST   /api/v1/conversations/{id}/sync         # Synchroniser messages
```

#### 6.1.6 Git

```yaml
POST   /api/v1/projects/{id}/git/checkout      # Checkout branche
POST   /api/v1/projects/{id}/git/commit        # Créer commit
POST   /api/v1/projects/{id}/git/add           # Stage fichiers
POST   /api/v1/projects/{id}/git/reset         # Reset
POST   /api/v1/projects/{id}/git/stash         # Stash
GET    /api/v1/projects/{id}/git/diff          # Diff
POST   /api/v1/projects/{id}/git/fetch         # Fetch
POST   /api/v1/projects/{id}/git/pull          # Pull
POST   /api/v1/projects/{id}/git/push          # Push

POST   /api/v1/worktrees                      # Créer worktree
DELETE /api/v1/worktrees/{id}                 # Supprimer worktree
```

#### 6.1.7 Configuration IA

```yaml
GET    /api/v1/ai/providers                    # Lister providers
POST   /api/v1/ai/providers                    # Créer provider
GET    /api/v1/ai/providers/{id}               # Détails provider
PUT    /api/v1/ai/providers/{id}               # Modifier provider
DELETE /api/v1/ai/providers/{id}               # Supprimer provider
POST   /api/v1/ai/providers/{id}/test          # Tester connexion

GET    /api/v1/ai/providers/{id}/models        # Lister modèles
POST   /api/v1/ai/providers/{id}/sync-models   # Synchroniser modèles

GET    /api/v1/ai/chat/completions             # Chat non-streaming
POST   /api/v1/ai/chat/completions/stream      # Chat streaming (SSE)
```

#### 6.1.8 Fichiers

```yaml
GET    /api/v1/projects/{id}/files/{path}      # Lire fichier
PUT    /api/v1/projects/{id}/files/{path}      # Écrire fichier
DELETE /api/v1/projects/{id}/files/{path}      # Supprimer fichier
GET    /api/v1/projects/{id}/files             # Lister répertoire
POST   /api/v1/projects/{id}/files/move        # Déplacer fichier
POST   /api/v1/projects/{id}/files/copy        # Copier fichier
```

#### 6.1.9 Synchronisation

```yaml
GET    /api/v1/sync/status                     # État global sync
POST   /api/v1/sync/changes                   # Récupérer changements
POST   /api/v1/sync/push                      # Pousser changements
POST   /api/v1/sync/resolve                   # Résoudre conflit
GET    /api/v1/sync/queue                     # Voir queue offline
DELETE /api/v1/sync/queue/{id}                # Annuler opération
```

### 6.2 WebSocket Events

#### 6.2.1 Client → Serveur

```json
// Authentification
{
  "type": "auth",
  "token": "jwt_access_token"
}

// Souscription à un canal
{
  "type": "subscribe",
  "channels": ["chat:user_123", "project:proj_456"]
}

// Désouscription
{
  "type": "unsubscribe",
  "channels": ["chat:user_123"]
}

// Ping/Pong (keep-alive)
{
  "type": "ping",
  "timestamp": 1708012800000
}

// Envoi de message
{
  "type": "chat_message",
  "conversation_id": "conv_789",
  "content": "Hello",
  "client_timestamp": 1708012800000,
  "temp_id": "temp_msg_001"
}

// Confirmation de lecture
{
  "type": "mark_read",
  "conversation_id": "conv_789",
  "message_ids": ["msg_001", "msg_002"]
}

// Typing indicator
{
  "type": "typing",
  "conversation_id": "conv_789",
  "is_typing": true
}
```

#### 6.2.2 Serveur → Client

```json
// Confirmation de connexion
{
  "type": "connected",
  "connection_id": "conn_abc123",
  "channels": ["chat:user_123"]
}

// Pong
{
  "type": "pong",
  "timestamp": 1708012800000
}

// Nouveau message
{
  "type": "chat_message",
  "message": {
    "id": "msg_123",
    "conversation_id": "conv_789",
    "role": "assistant",
    "content": "Bonjour !",
    "timestamp": "2026-02-16T10:00:00Z"
  }
}

// Message streaming (chunk)
{
  "type": "chat_stream",
  "message_id": "msg_123",
  "chunk": "Bon",
  "is_complete": false
}

// Fin du streaming
{
  "type": "chat_stream_complete",
  "message_id": "msg_123",
  "full_content": "Bonjour ! Comment puis-je vous aider ?"
}

// Mise à jour de tâche
{
  "type": "task_update",
  "task": {
    "id": "task_456",
    "status": "in_progress",
    "updated_at": "2026-02-16T10:05:00Z"
  }
}

// Événement git
{
  "type": "git_event",
  "project_id": "proj_123",
  "event": "commit",
  "commit": {
    "hash": "abc123",
    "message": "feat: add login form"
  }
}

// Notification
{
  "type": "notification",
  "notification": {
    "id": "notif_001",
    "type": "task_completed",
    "title": "Tâche terminée",
    "message": "La tâche 'Créer store' est complétée",
    "data": { "task_id": "task_456" }
  }
}

// Erreur
{
  "type": "error",
  "code": "UNAUTHORIZED",
  "message": "Token expiré"
}
```

### 6.3 SSE (Server-Sent Events)

Utilisé pour le streaming IA et les événements unidirectionnels.

```
GET /api/v1/ai/chat/completions/stream
Headers:
  Authorization: Bearer {token}
  Accept: text/event-stream

Réponse:
event: message_start
data: {"message_id": "msg_123", "conversation_id": "conv_456"}

event: content
data: {"chunk": "Bonjour", "index": 0}

event: content
data: {"chunk": " !", "index": 1}

event: tool_call
data: {"tool": "read_file", "args": {"path": "src/app.ts"}}

event: message_complete
data: {"message_id": "msg_123", "content": "Bonjour !"}

event: done
data: {}
```

---

## 7. Synchronisation Temps Réel

### 7.1 Architecture de Synchronisation

#### 7.1.1 Approche CRDT (Conflict-free Replicated Data Types)

Pour garantir la cohérence entre desktop et mobile, nous utilisons une approche CRDT avec versions vectorielles.

**Principes**:
- Chaque entité a un `server_version` et un `client_version`
- Les modifications incrémentent la version
- Les conflits sont résolus automatiquement par les règles CRDT
- Dernier écrivain gagnant avec résolution sémantique

```protobuf
message SyncOperation {
  string entity_type = 1;      // "message", "task", "plan"
  string entity_id = 2;
  string operation = 3;        // "create", "update", "delete"
  int64 client_version = 4;    // Version côté client
  int64 server_version = 5;    // Version côté serveur (si connu)
  bytes payload = 6;           // Données sérialisées
  string device_id = 7;
  string timestamp = 8;
  string hlc = 9;              // Hybrid Logical Clock
}

message SyncResponse {
  repeated SyncOperation operations = 1;
  bool has_more = 2;
  string next_cursor = 3;
  int64 server_timestamp = 4;
}
```

#### 7.1.2 Hybrid Logical Clock (HLC)

Pour ordonner les événements dans un système distribué:

```go
type HLC struct {
    WallTime int64  // Timestamp physique (ms)
    Logical  int32  // Compteur pour événements simultanés
    NodeID   string // ID du nœud (device_id)
}

func (h *HLC) Update(remote HLC) {
    if remote.WallTime > h.WallTime {
        h.WallTime = remote.WallTime
        h.Logical = remote.Logical + 1
    } else if remote.WallTime == h.WallTime {
        if remote.Logical > h.Logical {
            h.Logical = remote.Logical + 1
        } else {
            h.Logical++
        }
    } else {
        h.Logical++
    }
}
```

#### 7.1.3 Queue Offline

Quand le mobile est hors-ligne, les opérations sont stockées localement puis synchronisées:

```typescript
interface OfflineOperation {
  id: string;
  entityType: 'message' | 'task' | 'plan' | 'conversation';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  payload: any;
  timestamp: number;
  hlc: string;
  status: 'pending' | 'syncing' | 'completed' | 'failed';
  retryCount: number;
  errorMessage?: string;
}

// Stockage local (IndexedDB)
class OfflineQueue {
  async add(operation: OfflineOperation): Promise<void>;
  async sync(): Promise<SyncResult>;
  async retryFailed(): Promise<void>;
  async resolveConflict(operation: OfflineOperation, serverVersion: any): Promise<void>;
}
```

### 7.2 Flux de Synchronisation

#### 7.2.1 Initial Load (Première Connexion)

```
1. Mobile demande: GET /api/v1/workspaces/{id}/sync-status
   Response: { last_sync_at, server_version, entities_count }

2. Mobile demande les changements depuis le début:
   POST /api/v1/sync/changes
   Body: { 
     "cursor": null,
     "batch_size": 100,
     "entities": ["conversations", "messages", "tasks", "plans"]
   }

3. Serveur retourne les données paginées:
   Response: {
     "operations": [...],
     "has_more": true,
     "next_cursor": "cursor_123",
     "server_timestamp": 1708012800000
   }

4. Mobile répète jusqu'à has_more = false

5. Mobile sauvegarde localement et met à jour cursor
```

#### 7.2.2 Synchronisation Continue

```
En temps réel (WebSocket):
- Serveur pousse les nouveaux événements immédiatement
- Mobile met à jour son état local
- Ack automatique via WebSocket

En arrière-plan (Polling intelligent):
- Si WebSocket déconnecté, mobile poll toutes les 30s
- Ou utilise Background Fetch (iOS) / WorkManager (Android)
- POST /api/v1/sync/changes avec le dernier cursor
```

#### 7.2.3 Push des Modifications Mobile

```
1. Mobile crée une opération (ex: envoi message)

2. Si online:
   a. Envoie via WS: { type: "chat_message", ... }
   b. OU POST /api/v1/conversations/{id}/messages
   c. Attend confirmation avec server_version
   d. Met à jour version locale

3. Si offline:
   a. Stocke dans IndexedDB
   b. Marque comme "pending"
   c. Affiche UI "En attente de connexion"
   d. Lance sync quand reconnecté

4. Sync offline:
   a. POST /api/v1/sync/push
   b. Body: { operations: [...] }
   c. Serveur traite chaque opération
   d. Retourne résultats et conflits
   e. Mobile résout les conflits
```

### 7.3 Résolution de Conflits

#### 7.3.1 Stratégies par Entité

| Entité | Stratégie | Détail |
|--------|-----------|--------|
| Messages | Last-Write-Wins + append | Ajoute les messages manquants |
| Conversations | Merge | Combine les métadonnées |
| Tâches | Semantic | Statut prend priorité sur description |
| Plans | Manual | Alert l'utilisateur pour décider |
| Git commits | Server wins | Git est source de vérité |
| Préférences | Device-specific | Chaque appareil garde ses prefs |

#### 7.3.2 Algorithme de Résolution

```go
func ResolveConflict(local, server *Entity, strategy ConflictStrategy) *Entity {
    switch strategy {
    case LastWriteWins:
        if local.HLC.GreaterThan(server.HLC) {
            return local
        }
        return server
        
    case Merge:
        merged := MergeFields(local, server)
        merged.Version = Max(local.Version, server.Version) + 1
        return merged
        
    case Semantic:
        // Ex: pour les tâches, le statut a plus d'importance
        if local.Status != server.Status {
            // Priorité: completed > failed > in_progress > pending
            return ResolveByPriority(local, server)
        }
        return LastWriteWins(local, server)
        
    case Manual:
        // Marque comme conflit pour résolution utilisateur
        return CreateConflictRecord(local, server)
    }
}
```

#### 7.3.3 UI de Résolution

Quand un conflit nécessite une décision humaine:

```
┌─────────────────────────────────────────────┐
│ ⚠️ Conflit détecté                          │
├─────────────────────────────────────────────┤
│                                             │
│ Tâche: "Créer store Zustand"                │
│                                             │
│ [Version Desktop]      [Version Mobile]     │
│ Statut: Completed      Statut: In Progress  │
│ Modifié: 10:05         Modifié: 10:08       │
│                                             │
│ Description:           Description:         │
│ "Store créé avec       "En cours de         │
│  persistance"          création"            │
│                                             │
├─────────────────────────────────────────────┤
│ [Garder Desktop] [Garder Mobile] [Fusionner]│
└─────────────────────────────────────────────┘
```

---

## 8. Gestion Hors-Ligne

### 8.1 Mode Hors-Ligne Complet

L'application mobile doit fonctionner entièrement hors-ligne pour certaines fonctionnalités:

**Fonctionnalités Offline**:
- ✅ Lecture des conversations et messages (cache)
- ✅ Envoi de messages (mis en file d'attente)
- ✅ Visualisation des tâches et plans (cache)
- ✅ Modification des tâches (en attente)
- ✅ Lecture des fichiers (cache limité)

**Fonctionnalités Online-Only**:
- ❌ Streaming IA
- ❌ Exécution de tâches (génération code)
- ❌ Opérations git distantes (push/pull)
- ❌ Synchronisation des providers IA

### 8.2 Stockage Local

#### 8.2.1 IndexedDB Schema

```typescript
// Version 1
db.version(1).stores({
  // Utilisateur et sessions
  user: 'id',
  sessions: 'id',
  
  // Workspaces et projets
  workspaces: 'id, updated_at',
  projectGroups: 'id, workspace_id',
  projects: 'id, group_id, updated_at',
  
  // Plans et tâches
  plans: 'id, workspace_id, updated_at',
  tasks: 'id, plan_id, status, updated_at',
  
  // Conversations et messages
  conversations: 'id, workspace_id, updated_at',
  messages: 'id, conversation_id, timestamp, server_version',
  
  // Git (cache limité)
  gitCommits: 'id, project_id, date',
  gitBranches: 'id, project_id',
  
  // File d'attente offline
  syncQueue: 'id, entity_type, status, created_at',
  
  // Cache fichiers (limité à 50MB)
  fileCache: 'path, project_id, last_accessed',
  
  // Métadonnées
  syncState: 'id',  // Dernier cursor, version, etc.
});
```

#### 8.2.2 Limites de Stockage

```typescript
const STORAGE_LIMITS = {
  messages: 10000,           // Garder 10k derniers messages
  conversations: 100,        // Garder 100 dernières conversations
  fileCache: 50 * 1024 * 1024,  // 50MB pour les fichiers
  syncQueue: 1000,           // 1000 opérations max en attente
};

// Politique de nettoyage
class StorageManager {
  async cleanup(): Promise<void> {
    // Supprimer vieux messages
    await this.db.messages
      .orderBy('timestamp')
      .reverse()
      .offset(STORAGE_LIMITS.messages)
      .delete();
    
    // Supprimer vieux fichiers cache
    const cacheSize = await this.getCacheSize();
    if (cacheSize > STORAGE_LIMITS.fileCache) {
      await this.db.fileCache
        .orderBy('last_accessed')
        .limit(100)
        .delete();
    }
  }
}
```

### 8.3 Détection de Connectivité

```typescript
class ConnectivityManager {
  private isOnline: boolean = navigator.onLine;
  private connectionType: 'wifi' | 'cellular' | 'unknown' = 'unknown';
  
  constructor() {
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    
    // Network Information API
    if ('connection' in navigator) {
      const conn = (navigator as any).connection;
      conn.addEventListener('change', () => this.handleConnectionChange());
    }
  }
  
  private handleOnline(): void {
    this.isOnline = true;
    this.triggerSync();
  }
  
  private handleOffline(): void {
    this.isOnline = false;
    this.showOfflineBanner();
  }
  
  private async triggerSync(): Promise<void> {
    // Vérifier préférences utilisateur
    const prefs = await getUserPreferences();
    
    if (prefs.syncOnWifiOnly && this.connectionType === 'cellular') {
      console.log('Sync delayed until WiFi');
      return;
    }
    
    await offlineQueue.sync();
  }
}
```

### 8.4 Background Sync

#### 8.4.1 iOS (Background Fetch)

```swift
// AppDelegate.swift
func application(_ application: UIApplication, 
                 performFetchWithCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    
    SyncManager.shared.performBackgroundSync { result in
        switch result {
        case .newData:
            completionHandler(.newData)
        case .noData:
            completionHandler(.noData)
        case .failed:
            completionHandler(.failed)
        }
    }
}
```

#### 8.4.2 Android (WorkManager)

```kotlin
// SyncWorker.kt
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    
    override suspend fun doWork(): Result {
        val hasPendingOps = checkPendingOperations()
        
        if (!hasPendingOps) {
            return Result.success()
        }
        
        return try {
            SyncManager.sync()
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }
}

// Scheduler
val syncWork = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
    .setConstraints(
        Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
    )
    .build()

WorkManager.getInstance(context).enqueueUniquePeriodicWork(
    "macro_sync",
    ExistingPeriodicWorkPolicy.KEEP,
    syncWork
)
```

---

## 9. Sécurité

### 9.1 Chiffrement

#### 9.1.1 Données en Transit

- **TLS 1.3 obligatoire** pour toutes les connexions
- **Certificate Pinning** sur mobile pour éviter MITM
- **Perfect Forward Secrecy** (ECDHE)

#### 9.1.2 Données au Repos

```
Serveur:
- Clés API IA chiffrées avec AES-256-GCM
- Clé maître dans HSM ou AWS KMS / HashiCorp Vault
- Rotation automatique des clés tous les 90 jours

Mobile:
- Données IndexedDB chiffrées avec SQLCipher
- Clé dérivée du device keychain (iOS) / Keystore (Android)
- Effacement automatique après N tentatives de déverrouillage
```

### 9.2 Authentification et Autorisation

#### 9.2.1 JWT Tokens

```go
// Structure du JWT
type Claims struct {
    UserID    string    `json:"user_id"`
    SessionID string    `json:"session_id"`
    DeviceID  string    `json:"device_id"`
    Type      string    `json:"type"`  // "access" ou "refresh"
    ExpiresAt time.Time `json:"exp"`
    IssuedAt  time.Time `json:"iat"`
}

// Configuration
const (
    AccessTokenTTL  = 15 * time.Minute
    RefreshTokenTTL = 7 * 24 * time.Hour
)
```

#### 9.2.2 Rate Limiting

```go
// Stratégie par endpoint
var rateLimits = map[string]RateLimit{
    "auth":           {Requests: 5, Window: time.Minute},      // 5/min
    "api":            {Requests: 100, Window: time.Minute},    // 100/min
    "chat":           {Requests: 30, Window: time.Minute},     // 30/min
    "sync":           {Requests: 10, Window: time.Minute},     // 10/min
    "ai_completion":  {Requests: 60, Window: time.Minute},     // 60/min
    "ws_message":     {Requests: 120, Window: time.Minute},    // 120/min
}

// Implémentation Redis
func (rl *RateLimiter) CheckLimit(userID, endpoint string) (bool, error) {
    key := fmt.Sprintf("rate_limit:%s:%s", userID, endpoint)
    limit := rateLimits[endpoint]
    
    pipe := redisClient.Pipeline()
    incr := pipe.Incr(key)
    pipe.Expire(key, limit.Window)
    
    _, err := pipe.Exec()
    if err != nil {
        return false, err
    }
    
    return incr.Val() <= int64(limit.Requests), nil
}
```

### 9.3 Validation des Données

```go
// Middleware de validation
func ValidateRequest(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // 1. Taille maximale
        if r.ContentLength > 10*1024*1024 { // 10MB
            http.Error(w, "Payload too large", http.StatusRequestEntityTooLarge)
            return
        }
        
        // 2. Content-Type
        if !strings.Contains(r.Header.Get("Content-Type"), "application/json") {
            http.Error(w, "Invalid content type", http.StatusUnsupportedMediaType)
            return
        }
        
        // 3. Validation schéma
        var payload map[string]interface{}
        if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
            http.Error(w, "Invalid JSON", http.StatusBadRequest)
            return
        }
        
        // 4. Sanitisation (XSS protection)
        sanitized := sanitizePayload(payload)
        ctx := context.WithValue(r.Context(), "payload", sanitized)
        
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### 9.4 Audit et Logs

```go
// Log structure
type AuditLog struct {
    Timestamp   time.Time       `json:"timestamp"`
    UserID      string          `json:"user_id"`
    SessionID   string          `json:"session_id"`
    Action      string          `json:"action"`       // "login", "message_sent", etc.
    Resource    string          `json:"resource"`     // "conversation:123"
    Method      string          `json:"method"`       // "POST", "WS"
    IPAddress   string          `json:"ip_address"`
    UserAgent   string          `json:"user_agent"`
    Success     bool            `json:"success"`
    ErrorCode   string          `json:"error_code,omitempty"`
    DurationMs  int64           `json:"duration_ms"`
    Metadata    json.RawMessage `json:"metadata,omitempty"`
}

// Actions sensibles à logger
var sensitiveActions = []string{
    "auth.login",
    "auth.logout",
    "auth.password_change",
    "api_key.create",
    "api_key.delete",
    "project.delete",
    "workspace.delete",
    "task.delete",
}
```

---

## 10. Scalabilité et Performance

### 10.1 Architecture Scalable

#### 10.1.1 Horizontal Scaling

```
Load Balancer (Nginx/Envoy)
    │
    ├─► API Server 1 (Go)
    ├─► API Server 2 (Go)
    ├─► API Server 3 (Go)
    └─► API Server N (Go)
    
Chaque serveur:
- Stateless (pas de session en mémoire)
- Connexions WS gérées via Redis Pub/Sub
- Cache local LRU (Redis comme source de vérité)
```

#### 10.1.2 Sharding Stratégique

```
Sharding par user_id (consistent hashing):
- User A → Shard 1
- User B → Shard 2
- User C → Shard 1

Avantages:
- Données d'un utilisateur sur un seul shard
- Requêtes cross-shard rares
- Facile à scaler
```

### 10.2 Optimisations

#### 10.2.1 Caching Strategy

```
Multi-level Cache:

L1: Client Cache (IndexedDB)
   └─ Durée: Jusqu'à invalidation
   └─ Données: Conversations, messages, tâches

L2: CDN / Edge Cache
   └─ Durée: 5 minutes
   └─ Données: Assets, fichiers statiques

L3: Redis Cache
   └─ Durée: 1-60 minutes selon données
   └─ Données: Sessions, conversations récentes, metadata

L4: Application Cache (in-memory)
   └─ Durée: Quelques secondes
   └─ Données: Résultats de requêtes fréquentes

L5: Database
   └─ Source de vérité
```

#### 10.2.2 Lazy Loading et Pagination

```typescript
// Pagination curseur pour messages
interface MessagePagination {
  cursor?: string;        // ID du dernier message
  direction: 'before' | 'after';
  limit: number;          // 50 par défaut
}

// Lazy loading des tâches
const TaskList: React.FC = () => {
  const [visibleTasks, setVisibleTasks] = useState<Task[]>([]);
  const [hasMore, setHasMore] = useState(true);
  
  const loadMore = async () => {
    if (!hasMore) return;
    
    const response = await api.getTasks({
      cursor: visibleTasks[visibleTasks.length - 1]?.id,
      limit: 20,
    });
    
    setVisibleTasks(prev => [...prev, ...response.tasks]);
    setHasMore(response.hasMore);
  };
  
  return (
    <FlatList
      data={visibleTasks}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
    />
  );
};
```

#### 10.2.3 Compression

```go
// Middleware de compression
func CompressionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // N'applique pas la compression aux WebSockets
        if isWebSocket(r) {
            next.ServeHTTP(w, r)
            return
        }
        
        // Compression gzip pour réponses > 1KB
        gz := gzip.NewWriter(w)
        defer gz.Close()
        
        w.Header().Set("Content-Encoding", "gzip")
        next.ServeHTTP(gzipResponseWriter{Writer: gz, ResponseWriter: w}, r)
    })
}
```

### 10.3 Monitoring

#### 10.3.1 Métriques Clés

```yaml
# Prometheus metrics
api_requests_total: Counter par endpoint, status
api_request_duration_seconds: Histogram de latence
active_websocket_connections: Gauge
messages_sent_total: Counter
sync_operations_total: Counter par statut
cache_hit_ratio: Gauge (Redis)
database_connections_active: Gauge
offline_queue_size: Gauge par utilisateur
```

#### 10.3.2 Alertes

```yaml
# AlertManager rules
- alert: HighErrorRate
  expr: rate(api_requests_total{status=~"5.."}[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "High error rate detected"

- alert: WebSocketConnectionsDropping
  expr: rate(websocket_connections_closed_total[5m]) > 100
  for: 2m
  labels:
    severity: warning

- alert: SyncQueueGrowing
  expr: offline_queue_size > 1000
  for: 10m
  labels:
    severity: warning
```

---

## 11. Roadmap d'Implémentation

### Phase 1: Fondation (Semaines 1-4)

**Objectif**: API basique fonctionnelle

- [ ] Setup projet Go avec architecture modulaire
- [ ] Configuration PostgreSQL + Redis
- [ ] Système d'authentification JWT
- [ ] CRUD basique (workspaces, projets, conversations)
- [ ] Tests automatisés (unit + integration)

**Endpoints prioritaires**:
- Auth (register, login, refresh)
- Workspaces (list, get)
- Conversations (list, create, get)
- Messages (list, create)

### Phase 2: Temps Réel (Semaines 5-8)

**Objectif**: Chat temps réel fonctionnel

- [ ] Implémentation WebSockets
- [ ] Système de canaux et subscriptions
- [ ] SSE pour streaming IA
- [ ] Queue de messages Redis
- [ ] Présence utilisateur (online/offline)

**Livrables**:
- Chat bidirectionnel temps réel
- Notifications push
- Streaming IA fonctionnel

### Phase 3: Workflows Macro (Semaines 9-12)

**Objectif**: Support des workflows Architecte/Implémentation

- [ ] CRUD Plans et Tâches
- [ ] Workflow validation tâches
- [ ] Intégration Git (status, commits, branches)
- [ ] Visualisation graphes git
- [ ] Multi-projets support

**Livrables**:
- Création de plans via API
- Exécution des tâches
- Visualisation git mobile

### Phase 4: Synchronisation (Semaines 13-16)

**Objectif**: Support offline et synchronisation robuste

- [ ] Implémentation CRDT
- [ ] Queue offline côté serveur
- [ ] API de synchronisation
- [ ] Résolution de conflits
- [ ] Background sync (iOS/Android)

**Livrables**:
- Mode offline complet
- Sync automatique
- UI de résolution de conflits

### Phase 5: Production (Semaines 17-20)

**Objectif**: Mise en production et optimisations

- [ ] Sécurité (audit, chiffrement, rate limiting)
- [ ] Monitoring et alerting
- [ ] Documentation API complète
- [ ] Performance tuning
- [ ] Load testing
- [ ] Déploiement Kubernetes

**Livrables**:
- API production-ready
- Documentation complète
- Monitoring en place

### Phase 6: Améliorations Futures (Post-lancement)

- [ ] Support appels vocaux IA
- [ ] Collaboration temps réel (multi-utilisateur)
- [ ] Intégrations tierces (GitHub, GitLab)
- [ ] Analytics avancés
- [ ] Optimisations ML

---

## 12. Annexes

### 12.1 Exemples de Requêtes

#### Authentification

```bash
# Inscription
curl -X POST https://api.macro.dev/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securePassword123",
    "name": "John Doe",
    "device_info": {
      "device_id": "mobile_abc123",
      "device_name": "iPhone de John",
      "device_type": "ios"
    }
  }'

# Connexion
curl -X POST https://api.macro.dev/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securePassword123",
    "device_id": "mobile_abc123"
  }'

# Response
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2g...",
  "expires_in": 900
}
```

#### Conversations

```bash
# Créer une conversation
curl -X POST https://api.macro.dev/v1/workspaces/ws_123/conversations \
  -H "Authorization: Bearer {access_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Plan Auth System",
    "mode": "Architect",
    "project_ids": ["proj_456", "proj_789"]
  }'

# Lister messages
curl "https://api.macro.dev/v1/conversations/conv_123/messages?limit=50&cursor=msg_100" \
  -H "Authorization: Bearer {access_token}"

# Envoyer message
curl -X POST https://api.macro.dev/v1/conversations/conv_123/messages \
  -H "Authorization: Bearer {access_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Je veux créer un système d\'authentification",
    "role": "user",
    "client_timestamp": 1708012800000
  }'
```

#### Synchronisation

```bash
# Récupérer changements
curl -X POST https://api.macro.dev/v1/sync/changes \
  -H "Authorization: Bearer {access_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "cursor": "cursor_abc123",
    "batch_size": 100,
    "entities": ["conversations", "messages", "tasks"]
  }'

# Pousser changements
curl -X POST https://api.macro.dev/v1/sync/push \
  -H "Authorization: Bearer {access_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "entity_type": "message",
        "entity_id": "msg_temp_001",
        "operation": "create",
        "client_version": 1,
        "payload": {
          "conversation_id": "conv_123",
          "content": "Message envoyé hors-ligne",
          "role": "user"
        },
        "timestamp": 1708012800000,
        "hlc": "1708012800000:5:mobile_abc123"
      }
    ]
  }'
```

### 12.2 Codes d'Erreur

```typescript
enum ErrorCode {
  // Auth (1000-1099)
  INVALID_CREDENTIALS = 1000,
  TOKEN_EXPIRED = 1001,
  TOKEN_INVALID = 1002,
  INSUFFICIENT_PERMISSIONS = 1003,
  RATE_LIMIT_EXCEEDED = 1004,
  DEVICE_NOT_AUTHORIZED = 1005,
  
  // Validation (1100-1199)
  INVALID_INPUT = 1100,
  MISSING_REQUIRED_FIELD = 1101,
  INVALID_FORMAT = 1102,
  PAYLOAD_TOO_LARGE = 1103,
  
  // Resources (1200-1299)
  NOT_FOUND = 1200,
  ALREADY_EXISTS = 1201,
  CONFLICT = 1202,
  RESOURCE_LOCKED = 1203,
  
  // Sync (1300-1399)
  SYNC_CONFLICT = 1300,
  VERSION_MISMATCH = 1301,
  OFFLINE_QUEUE_FULL = 1302,
  
  // Git (1400-1499)
  GIT_OPERATION_FAILED = 1400,
  MERGE_CONFLICT = 1401,
  BRANCH_NOT_FOUND = 1402,
  
  // AI (1500-1599)
  AI_PROVIDER_ERROR = 1500,
  AI_RATE_LIMIT = 1501,
  AI_CONTEXT_TOO_LARGE = 1502,
  
  // Server (9000-9099)
  INTERNAL_ERROR = 9000,
  SERVICE_UNAVAILABLE = 9001,
  DATABASE_ERROR = 9002,
}
```

### 12.3 Gestion des Versions

```
Versioning de l'API:
- URL: /api/v1/, /api/v2/, etc.
- Breaking changes = nouvelle version majeure
- Features ajoutées = nouvelle version mineure
- Durée de support: 2 versions majeures simultanées

Déprécation:
- Header "X-API-Deprecated: true"
- Header "X-API-Deprecation-Date: 2026-06-01"
- Header "X-API-Alternative: /api/v2/resource"
```

### 12.4 Checklist de Déploiement

```markdown
Pré-déploiement:
- [ ] Tous les tests passent
- [ ] Code review effectuée
- [ ] Documentation à jour
- [ ] Migration DB testée
- [ ] Secrets configurés
- [ ] SSL certificates valides

Déploiement:
- [ ] Blue-green deployment
- [ ] Health checks OK
- [ ] Migrations exécutées
- [ ] Monitoring actif
- [ ] Rollback plan prêt

Post-déploiement:
- [ ] Smoke tests
- [ ] Métriques normales
- [ ] Aucune alerte critique
- [ ] Support informé
```

---

**Document créé pour Macro - Système API Mobile**  
**Date**: 16 Février 2026  
**Auteur**: Assistant IA  
**Statut**: Spécifications complètes - Prêt pour implémentation
