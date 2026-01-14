# Backend Plan - Macro

## Architecture Backend

### Stack Technique
- **Runtime**: Tauri v2
- **Langage**: Rust
- **Base de données**: SQLite (rusqlite)
- **Git Operations**: libgit2 (git2 crate)
- **Vector DB**: LanceDB (pour indexation sémantique)
- **Sérialisation**: serde + serde_json
- **Async Runtime**: tokio

### Structure des Modules

```
src-tauri/src/
├── lib.rs                 # Point d'entrée Tauri
├── main.rs                # Fonction principale
├── commands/              # Commandes Tauri (exposées au frontend)
│   ├── mod.rs
│   ├── project.rs         # Gestion projets
│   ├── file.rs            # Opérations fichiers
│   ├── git.rs             # Opérations git
│   ├── ai.rs              # Communication IA
│   ├── plan.rs            # Gestion plans/tâches
│   └── chat.rs            # Historique chat
├── services/              # Business logic
│   ├── mod.rs
│   ├── project_service.rs
│   ├── git_service.rs
│   ├── ai_service.rs
│   ├── plan_service.rs
│   └── vector_service.rs
├── models/                # Structures de données
│   ├── mod.rs
│   ├── project.rs
│   ├── plan.rs
│   ├── task.rs
│   └── git.rs
├── db/                    # Couche base de données
│   ├── mod.rs
│   ├── connection.rs      # SQLite connection pool
│   ├── migrations.rs      # Database migrations
│   └── repositories/      # Repository pattern
│       ├── mod.rs
│       ├── project_repo.rs
│       ├── plan_repo.rs
│       └── chat_repo.rs
├── git/                   # Intégration libgit2
│   ├── mod.rs
│   ├── repository.rs      # Wrapper git2::Repository
│   ├── branch.rs          # Gestion branches
│   ├── commit.rs          # Gestion commits
│   └── diff.rs            # Comparaison fichiers
├── ai/                    # Abstraction fournisseurs IA
│   ├── mod.rs
│   ├── provider.rs        # Trait Provider
│   ├── openai.rs          # Implémentation OpenAI
│   ├── anthropic.rs       # Implémentation Anthropic
│   └── local.rs           # Implémentation Ollama/LocalAI
└── utils/
    ├── mod.rs
    ├── paths.rs           # Utilitaires chemins fichiers
    └── error.rs           # Gestion erreurs
```

---

## Modules Principaux

### 1. Commands Layer (Tauri Commands)

#### Commands/Project
```rust
#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, Error>

#[tauri::command]
async fn create_project(path: PathBuf, name: String) -> Result<Project, Error>

#[tauri::command]
async fn get_project_metadata(project_id: String) -> Result<ProjectMetadata, Error>

#[tauri::command]
async fn update_project_metadata(id: String, metadata: ProjectMetadata) -> Result<(), Error>

#[tauri::command]
async fn open_project(path: PathBuf) -> Result<Project, Error>
```

#### Commands/File
```rust
#[tauri::command]
async fn read_file(project_id: String, path: PathBuf) -> Result<String, Error>

#[tauri::command]
async fn write_file(project_id: String, path: PathBuf, content: String) -> Result<(), Error>

#[tauri::command]
async fn list_files(project_id: String, path: PathBuf) -> Result<Vec<FileInfo>, Error>

#[tauri::command]
async fn watch_project(project_id: String) -> Result<(), Error>
```

#### Commands/Git
```rust
#[tauri::command]
async fn get_git_status(project_id: String) -> Result<GitStatus, Error>

#[tauri::command]
async fn create_branch(project_id: String, branch_name: String) -> Result<String, Error>

#[tauri::command]
async fn commit_changes(project_id: String, message: String, plan_id: String, task_id: String) -> Result<String, Error>

#[tauri::command]
async fn get_diff(project_id: String, file_path: PathBuf) -> Result<Diff, Error>

#[tauri::command]
async fn get_history(project_id: String, limit: usize) -> Result<Vec<Commit>, Error>

#[tauri::command]
async fn revert_commit(project_id: String, commit_hash: String) -> Result<(), Error>
```

#### Commands/AI
```rust
#[tauri::command]
async fn generate_plan(context: PlanContext) -> Result<Plan, Error>

#[tauri::command]
async fn execute_task(task: Task, context: TaskContext) -> Result<TaskExecution, Error>

#[tauri::command]
async fn ask_ai_question(question: String, context: QueryContext) -> Result<String, Error>

#[tauri::command]
async fn stream_response(prompt: String, window: Window) -> Result<(), Error>

#[tauri::command]
async fn get_suggestions(context: CodeContext) -> Result<Vec<Suggestion>, Error>
```

#### Commands/Plan
```rust
#[tauri::command]
async fn create_plan(description: String, project_ids: Vec<String>) -> Result<Plan, Error>

#[tauri::command]
async fn get_plan(plan_id: String) -> Result<Plan, Error>

#[tauri::command]
async fn list_plans(project_id: String) -> Result<Vec<Plan>, Error>

#[tauri::command]
async fn update_plan_status(plan_id: String, status: PlanStatus) -> Result<(), Error>

#[tauri::command]
async fn predict_git_graph(plan_id: String) -> Result<PredictedGitGraph, Error>
```

---

### 2. Services Layer

#### ProjectService
```rust
pub struct ProjectService {
    db: Arc<Mutex<SqliteConnection>>,
    git_service: Arc<GitService>,
}

impl ProjectService {
    pub async fn create(&self, path: PathBuf, name: String) -> Result<Project>
    pub async fn get_metadata(&self, id: String) -> Result<ProjectMetadata>
    pub async fn validate_project(&self, path: PathBuf) -> Result<bool>
    pub async fn scan_files(&self, project_id: String) -> Result<Vec<FileInfo>>
}
```

#### GitService
```rust
pub struct GitService;

impl GitService {
    pub fn open_repository(path: PathBuf) -> Result<Repository>
    pub fn get_status(&self, repo: &Repository) -> Result<GitStatus>
    pub fn create_branch(&self, repo: &mut Repository, name: String) -> Result<String>
    pub fn commit(&self, repo: &mut Repository, message: String, metadata: CommitMetadata) -> Result<String>
    pub fn get_diff(&self, repo: &Repository, old: &str, new: &str) -> Result<Diff>
    pub fn revert(&self, repo: &mut Repository, commit_hash: String) -> Result<()>
    pub fn get_history(&self, repo: &Repository, limit: usize) -> Result<Vec<Commit>>
}
```

#### AIService
```rust
pub struct AIService {
    providers: HashMap<String, Box<dyn Provider>>,
    default_provider: String,
}

impl AIService {
    pub async fn generate_plan(&self, context: PlanContext) -> Result<Plan>
    pub async fn execute_task(&self, task: Task, context: TaskContext) -> Result<TaskExecution>
    pub async fn stream_response(&self, prompt: String, callback: impl Fn(String)) -> Result<()>
    pub async fn get_suggestions(&self, context: CodeContext) -> Result<Vec<Suggestion>>
}
```

#### PlanService
```rust
pub struct PlanService {
    db: Arc<Mutex<SqliteConnection>>,
    ai_service: Arc<AIService>,
    git_service: Arc<GitService>,
}

impl PlanService {
    pub async fn create(&self, description: String, project_ids: Vec<String>) -> Result<Plan>
    pub async fn predict_git_graph(&self, plan_id: String) -> Result<PredictedGitGraph>
    pub async fn update_status(&self, plan_id: String, status: PlanStatus) -> Result<()>
    pub async fn get_tasks(&self, plan_id: String) -> Result<Vec<Task>>
}
```

#### VectorService
```rust
pub struct VectorService {
    db: Arc<LanceDB>,
}

impl VectorService {
    pub async fn index_project(&self, project_id: String, files: Vec<FileInfo>) -> Result<()>
    pub async fn search(&self, query: String, project_id: String, limit: usize) -> Result<Vec<SearchResult>>
    pub async fn update_index(&self, project_id: String, changed_files: Vec<FileInfo>) -> Result<()>
}
```

---

### 3. Models Layer

#### Project Model
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub metadata: ProjectMetadata,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectMetadata {
    pub description: String,
    pub tags: Vec<String>,
    pub team_members: Vec<String>,
    pub api_contracts: Vec<ApiContract>,
    pub dependencies: Vec<ProjectDependency>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiContract {
    pub name: String,
    pub version: String,
    pub file_path: PathBuf,
    pub contract_type: ContractType, // OpenAPI, GraphQL
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDependency {
    pub project_id: String,
    pub dependency_type: DependencyType, // API, SharedTypes, Library
}
```

#### Plan Model
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Plan {
    pub id: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: PlanStatus,
    pub project_ids: Vec<String>,
    pub tasks: Vec<Task>,
    pub predicted_git_graphs: HashMap<String, PredictedGitGraph>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum PlanStatus {
    Draft,
    Validated,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub plan_id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub dependencies: Vec<String>, // Task IDs
    pub estimated_changes: Vec<FileChange>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum TaskStatus {
    Pending,
    InProgress,
    AwaitingResponse,
    Completed,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileChange {
    pub path: PathBuf,
    pub operation: ChangeOperation, // Create, Modify, Delete
    pub diff_preview: Option<String>,
}
```

#### Git Model
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<GitFile>,
    pub unstaged: Vec<GitFile>,
    pub untracked: Vec<GitFile>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitFile {
    pub path: PathBuf,
    pub status: FileStatus, // Added, Modified, Deleted, Renamed
    pub worktree_status: FileStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: DateTime<Utc>,
    pub plan_id: Option<String>,
    pub task_id: Option<String>,
    pub changed_files: Vec<String>,
    pub status: CommitStatus, // vert (faits), bleu (planifiés), orange (en cours)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum CommitStatus {
    Completed,    // vert - commits faits
    Planned,      // bleu - commits planifiés
    InProgress,   // orange - commits en cours
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Diff {
    pub old_file: Option<PathBuf>,
    pub new_file: Option<PathBuf>,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
}
```

#### AI Model
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanContext {
    pub description: String,
    pub project_contexts: Vec<ProjectContext>,
    pub existing_plans: Vec<Plan>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectContext {
    pub project_id: String,
    pub structure: DirectoryInfo,
    pub relevant_files: Vec<FileInfo>,
    pub api_contracts: Vec<ApiContract>,
    pub dependencies: Vec<ProjectDependency>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskContext {
    pub task_id: String,
    pub project_id: String,
    pub plan_context: PlanContext,
    pub chat_history: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskExecution {
    pub task_id: String,
    pub status: TaskStatus,
    pub changes: Vec<FileChange>,
    pub questions: Vec<AIQuestion>,
    pub explanation: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIQuestion {
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
    pub multiple_choice: bool,
}
```

---

### 4. Database Schema (SQLite)

#### Tables

```sql
-- Projects
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(name, path)
);

-- Project Metadata (git-synced via .project-meta.yaml)
CREATE TABLE project_metadata (
    project_id TEXT PRIMARY KEY,
    description TEXT,
    tags TEXT, -- JSON array
    team_members TEXT, -- JSON array
    api_contracts TEXT, -- JSON array
    dependencies TEXT, -- JSON array
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Plans (git-synced via .macro-plans branch)
CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    project_ids TEXT NOT NULL, -- JSON array
);

-- Tasks (git-synced via .macro-plans branch)
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    dependencies TEXT, -- JSON array of task IDs
    estimated_changes TEXT, -- JSON array
    FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- Chat Messages (SQLite only - local)
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    role TEXT NOT NULL, -- 'user' or 'assistant'
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Git Commits Tracking (SQLite only - local cache)
CREATE TABLE git_commits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    plan_id TEXT,
    task_id TEXT,
    hash TEXT NOT NULL,
    message TEXT NOT NULL,
    author TEXT NOT NULL,
    date TEXT NOT NULL,
    changed_files TEXT, -- JSON array
    status TEXT NOT NULL, -- 'completed' (vert), 'planned' (bleu), 'in_progress' (orange)
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Predicted Git Graphs (SQLite only - local cache)
CREATE TABLE predicted_git_graphs (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    graph_structure TEXT NOT NULL, -- JSON
    created_at TEXT NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES plans(id),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

---

### 5. AI Provider Abstraction

#### Provider Trait
```rust
#[async_trait]
pub trait Provider: Send + Sync {
    async fn generate_plan(&self, context: PlanContext) -> Result<Plan>;
    async fn execute_task(&self, task: Task, context: TaskContext) -> Result<TaskExecution>;
    async fn stream_response(&self, prompt: String, callback: Box<dyn Fn(String) + Send>) -> Result<()>;
    async fn get_suggestions(&self, context: CodeContext) -> Result<Vec<Suggestion>>;
    fn name(&self) -> &str;
}
```

#### OpenAI Implementation
```rust
pub struct OpenAIProvider {
    api_key: String,
    model: String, // gpt-4, gpt-3.5-turbo, etc.
    client: reqwest::Client,
}

#[async_trait]
impl Provider for OpenAIProvider {
    async fn generate_plan(&self, context: PlanContext) -> Result<Plan> {
        let prompt = self.build_plan_prompt(context);
        let response = self.call_chat_completion(&prompt).await?;
        self.parse_plan_response(response)
    }

    // ... autres méthodes
}
```

#### Local LLM Implementation (Ollama)
```rust
pub struct OllamaProvider {
    base_url: String,
    model: String, // llama2, mistral, codellama, etc.
}

#[async_trait]
impl Provider for OllamaProvider {
    async fn generate_plan(&self, context: PlanContext) -> Result<Plan> {
        let prompt = self.build_plan_prompt(context);
        let response = self.call_ollama_api(&prompt).await?;
        self.parse_plan_response(response)
    }

    // ... autres méthodes
}
```

---

## Implémentation Phase par Phase

### Phase 1.1: Foundation
- [ ] Structure des modules
- [ ] Configuration SQLite avec migrations
- [ ] Repository pattern de base
- [ ] Gestion erreurs custom

### Phase 1.2: Project Management
- [ ] Commands: list_projects, create_project, get_project_metadata
- [ ] ProjectService implementation
- [ ] Git validation des projets
- [ ] Scan fichiers projet

### Phase 1.3: File System
- [ ] Commands: read_file, write_file, list_files
- [ ] File watching (debounced)
- [ ] Validation chemins sécurisés

### Phase 1.4: Git Integration
- [ ] GitService avec libgit2
- [ ] Commands: get_git_status, get_diff, get_history
- [ ] Branch creation et management
- [ ] Commit avec métadonnées plan/task

### Phase 1.5: AI Abstraction
- [ ] Provider trait
- [ ] OpenAI provider
- [ ] Ollama provider
- [ ] Streaming responses

### Phase 1.6: Plan & Task Management
- [ ] Commands: create_plan, get_plan, list_plans
- [ ] PlanService avec génération IA
- [ ] Task management et tracking
- [ ] Prédiction arbre git

### Phase 2: Advanced Features
- [ ] Vector indexing (LanceDB)
- [ ] Recherche sémantique
- [ ] Quality gates automation
- [ ] Shell command runner sécurisé

---

## Gestion des Erreurs

```rust
#[derive(Debug, thiserror::Error)]
pub enum MacroError {
    #[error("Project not found: {0}")]
    ProjectNotFound(String),

    #[error("Git operation failed: {0}")]
    GitError(#[from] git2::Error),

    #[error("Database error: {0}")]
    DatabaseError(#[from] rusqlite::Error),

    #[error("AI provider error: {0}")]
    AIProviderError(String),

    #[error("File operation failed: {0}")]
    FileError(#[from] std::io::Error),

    #[error("Plan not found: {0}")]
    PlanNotFound(String),

    #[error("Task execution failed: {0}")]
    TaskExecutionError(String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, MacroError>;
```

---

## Sécurité

- Validation de tous les chemins fichiers (path traversal prevention)
- Sandboxing des commandes shell
- Encryption des API keys dans OS Keyring
- Rate limiting pour appels IA
- Validation des entrées utilisateur

---

## Performance

- Connection pooling SQLite
- Async operations avec tokio
- File watching debounced
- Git operations optimisées
- Vector indexing incremental
- Cache intelligent pour opérations fréquentes

---

## Testing Strategy

- Unit tests pour services
- Integration tests pour commands
- Mock providers IA pour tests
- Tests E2E avec Tauri testing utilities
- Benchmarking pour opérations lourdes (git, indexation)
