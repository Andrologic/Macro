use crate::commands::terminal::TerminalSessionStore;
use crate::commands::{CommandError, DbPool};
use crate::config::{
    ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigPatchRequest, ConfigScope,
    ConfigWatcherState, JsonPatchOperation,
};
use crate::core::error::{BackendError, Result};
use crate::db::repository;
use crate::git::GitState;
use crate::project_icon::{resolve_project_icon, ProjectIconResolutionDto};
use crate::project_path::{classify_project_path, parse_wsl_unc_path};
use crate::workspace;
use crate::workspace::metadata::{
    CreateNewProjectRepoRequest, CreateProjectRequest, DebugResetProjectReportDto,
    ImportGitRepoRequest, ManualFeatureDto, ManualFeatureMergeWorkflowDto,
    ProjectAccessChangePreviewDto, ProjectDto, ProjectGitFlowDetectionDto,
    ProjectGitFlowSettingsDto, ProjectGitSetupCommitResultDto, ProjectGroupDto,
    ProjectRegistryDiagnosticsDto, WorkspaceArchitectActivatePlanChatRequestDto,
    WorkspaceArchitectActivatePlanHeadRequestDto, WorkspaceArchitectListPlansRequestDto,
    WorkspaceArchitectPlanActivationHeadDto, WorkspaceArchitectPlanListDto,
    WorkspaceArchitectPlanTranscriptDto, WorkspaceBootstrapDto, WorkspaceMetadataDto,
    WorkspaceMetadataRecoveryReportDto, WorkspaceProjectRegistryReconcileReportDto,
    WorkspaceReconcileProjectRegistryFromHintsRequestDto,
    WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto,
    WorkspaceRecoverMissingMetadataRequestDto, WorkspaceTaskCatalogDto,
};
use crate::WorkspaceMetadataRoot;
use crate::WorkspaceRoot;
use futures::{stream, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::{watch, Mutex};

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("Workspace task join error: {}", err),
    }
}

async fn resolve_metadata_root(workspace_path: PathBuf, git_state: GitState) -> Result<PathBuf> {
    if parse_wsl_unc_path(&workspace_path.to_string_lossy()).is_some() {
        return Err(BackendError::Git {
            message: "Macro metadata is not yet available for WSL projects.".to_string(),
        });
    }

    let workspace_path_for_fallback = workspace_path.clone();
    let resolved =
        tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&workspace_path))
            .await
            .map_err(to_join_error);
    match resolved {
        Ok(Ok(metadata_root)) => Ok(metadata_root),
        Ok(Err(error)) => {
            let error_message = error.to_string();
            if let Some(metadata_worktree) =
                crate::git::find_existing_macro_metadata_worktree_root(&workspace_path_for_fallback)
            {
                tracing::warn!(
                    action = "workspace_metadata_root_existing_worktree_fallback",
                    workspace_path = %workspace_path_for_fallback.display(),
                    fallback_path = %metadata_worktree.display(),
                    reason = %error_message
                );
                return Ok(metadata_worktree);
            }
            let BackendError::GitRepositoryNotFound { message } = error else {
                return Err(error);
            };
            let fallback = workspace_path_for_fallback.join(".macro");
            tracing::warn!(
                action = "workspace_metadata_root_fallback",
                workspace_path = %workspace_path_for_fallback.display(),
                fallback_path = %fallback.display(),
                reason = %message
            );
            Ok(fallback)
        }
        Err(error) => Err(error),
    }
}

async fn register_project_config_roots(
    projects: impl IntoIterator<Item = ProjectDto>,
    git_state: GitState,
    config_manager: &ConfigManager,
    config_watcher: &ConfigWatcherState,
) {
    for project in projects {
        let project_path = PathBuf::from(&project.path);
        if parse_wsl_unc_path(&project.path).is_some() {
            continue;
        }
        let metadata_root =
            match resolve_metadata_root(project_path.clone(), git_state.clone()).await {
                Ok(root) => root,
                Err(error) => {
                    tracing::warn!(
                        project_id = %project.id,
                        %error,
                        "Impossible de résoudre la configuration @macro du projet"
                    );
                    continue;
                }
            };
        let config_file = metadata_root
            .join("projects")
            .join(&project.id)
            .join("config")
            .join("git.json");
        let initialize_git_config = !config_file.exists();
        match config_manager
            .register_project_root(&project.id, metadata_root)
            .await
        {
            Ok(config_root) => {
                if initialize_git_config {
                    let detection = workspace::detect_project_git_flow(
                        &project_path,
                        Some(project.path.as_str()),
                    );
                    let state = if detection.repo_detected && !detection.requires_confirmation {
                        "ready"
                    } else {
                        "configuration_required"
                    };
                    let mut operations = vec![JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/configurationState".to_string(),
                        from: None,
                        value: Some(json!(state)),
                    }];
                    if state == "ready" {
                        if let Some(main_branch) = detection.suggested_main_branch {
                            operations.push(JsonPatchOperation {
                                op: "add".to_string(),
                                path: "/mainBranch".to_string(),
                                from: None,
                                value: Some(json!(main_branch)),
                            });
                        }
                        if let Some(base_branch) = detection.suggested_base_branch {
                            operations.push(JsonPatchOperation {
                                op: "add".to_string(),
                                path: "/baseBranch".to_string(),
                                from: None,
                                value: Some(json!(base_branch)),
                            });
                        }
                    }
                    match config_manager
                        .get_document(
                            ConfigDocumentKind::Git,
                            ConfigScope::Project {
                                project_id: project.id.clone(),
                            },
                        )
                        .await
                    {
                        Ok(document) => {
                            if let Err(error) = config_manager
                                .apply_patch(ConfigPatchRequest {
                                    kind: ConfigDocumentKind::Git,
                                    scope: ConfigScope::Project {
                                        project_id: project.id.clone(),
                                    },
                                    expected_etag: document.etag,
                                    patch: operations,
                                    source: ConfigChangeSource::UserInterface,
                                })
                                .await
                            {
                                tracing::warn!(
                                    project_id = %project.id,
                                    code = %error.code,
                                    message = %error.message,
                                    "Impossible d’initialiser la configuration Git détectée du projet"
                                );
                            }
                        }
                        Err(error) => tracing::warn!(
                            project_id = %project.id,
                            code = %error.code,
                            message = %error.message,
                            "Impossible de préparer le document Git du projet"
                        ),
                    }
                }
                if let Err(error) = config_watcher.watch_project_root(&project.id, &config_root) {
                    tracing::warn!(
                        project_id = %project.id,
                        %error,
                        "Impossible de surveiller la configuration du projet"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    project_id = %project.id,
                    code = %error.code,
                    message = %error.message,
                    "Impossible de charger la configuration du projet"
                );
            }
        }
    }
}

fn to_backend_error(error: CommandError) -> BackendError {
    BackendError::Internal {
        message: error.message,
    }
}

#[derive(Clone, Default)]
pub struct ProjectOperationStore {
    operations: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

impl ProjectOperationStore {
    async fn register(&self, request_id: Option<&str>) -> Option<ProjectOperationGuard> {
        let request_id = request_id?.trim();
        if request_id.is_empty() {
            return None;
        }

        let (sender, receiver) = watch::channel(false);
        self.operations
            .lock()
            .await
            .insert(request_id.to_string(), sender);
        Some(ProjectOperationGuard {
            request_id: request_id.to_string(),
            store: self.clone(),
            receiver,
        })
    }

    async fn cancel(&self, request_id: &str) -> bool {
        let sender = self.operations.lock().await.get(request_id).cloned();
        if let Some(sender) = sender {
            let _ = sender.send(true);
            true
        } else {
            false
        }
    }

    async fn remove(&self, request_id: &str) {
        self.operations.lock().await.remove(request_id);
    }
}

pub struct ProjectOperationGuard {
    request_id: String,
    store: ProjectOperationStore,
    receiver: watch::Receiver<bool>,
}

impl ProjectOperationGuard {
    fn receiver(&self) -> watch::Receiver<bool> {
        self.receiver.clone()
    }
}

impl Drop for ProjectOperationGuard {
    fn drop(&mut self) {
        let request_id = self.request_id.clone();
        let store = self.store.clone();
        tauri::async_runtime::spawn(async move {
            store.remove(&request_id).await;
        });
    }
}

fn to_backend_db_error(error: crate::db::DbError) -> BackendError {
    BackendError::Internal {
        message: error.to_string(),
    }
}

async fn load_db_pool(pool: &State<'_, DbPool>) -> Result<sqlx::SqlitePool> {
    crate::commands::get_pool(pool)
        .await
        .map_err(to_backend_error)
}

async fn load_live_terminal_project_ids(
    db_pool: &sqlx::SqlitePool,
    terminal_store: &TerminalSessionStore,
) -> Result<HashSet<String>> {
    let stored_tabs = repository::list_terminal_tabs(db_pool)
        .await
        .map_err(to_backend_db_error)?;
    let live_tab_ids = terminal_store
        .live_tab_ids()
        .await
        .into_iter()
        .collect::<HashSet<_>>();

    Ok(stored_tabs
        .into_iter()
        .filter(|tab| live_tab_ids.contains(&tab.id))
        .map(|tab| tab.project_id)
        .collect())
}

#[tauri::command]
pub async fn workspace_get_bootstrap(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    config_manager: State<'_, ConfigManager>,
    config_watcher: State<'_, ConfigWatcherState>,
) -> Result<WorkspaceBootstrapDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let bootstrap = workspace::get_bootstrap(&workspace_path, &metadata_root).await?;
    let projects = bootstrap
        .standalone_projects
        .iter()
        .chain(
            bootstrap
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .cloned()
        .collect::<Vec<_>>();
    register_project_config_roots(
        projects,
        git_state.inner().clone(),
        config_manager.inner(),
        config_watcher.inner(),
    )
    .await;
    Ok(bootstrap)
}

#[tauri::command]
pub async fn workspace_resolve_project_icons(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectIconResolutionDto>> {
    if project_ids.len() > 256 {
        return Err(BackendError::Validation(
            "At most 256 project icons can be resolved at once.".to_string(),
        ));
    }

    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let bootstrap = workspace::get_bootstrap(&workspace_path, &metadata_root).await?;
    let projects_by_id = bootstrap
        .standalone_projects
        .iter()
        .chain(
            bootstrap
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .map(|project| (project.id.clone(), project.path.clone()))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let requested_ids = project_ids
        .into_iter()
        .map(|project_id| project_id.trim().to_string())
        .filter(|project_id| !project_id.is_empty() && seen.insert(project_id.clone()))
        .collect::<Vec<_>>();

    Ok(stream::iter(requested_ids)
        .map(|project_id| {
            let project_path = projects_by_id
                .get(&project_id)
                .map(|path| classify_project_path(&workspace_path, path));
            async move {
                let icon = match project_path {
                    Some(project_path) => match resolve_project_icon(project_path).await {
                        Ok(icon) => icon,
                        Err(error) => {
                            tracing::warn!(
                                action = "workspace_resolve_project_icon_failed",
                                project_id = %project_id,
                                error = %error
                            );
                            None
                        }
                    },
                    None => None,
                };
                ProjectIconResolutionDto { project_id, icon }
            }
        })
        .buffered(4)
        .collect::<Vec<_>>()
        .await)
}

#[tauri::command]
pub async fn workspace_list_projects(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    config_manager: State<'_, ConfigManager>,
    config_watcher: State<'_, ConfigWatcherState>,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let groups = workspace::list_projects(&workspace_path, &metadata_root).await?;
    let projects = groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .cloned()
        .collect::<Vec<_>>();
    register_project_config_roots(
        projects,
        git_state.inner().clone(),
        config_manager.inner(),
        config_watcher.inner(),
    )
    .await;
    Ok(groups)
}

#[tauri::command]
pub async fn workspace_list_tasks(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
) -> Result<WorkspaceTaskCatalogDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::list_tasks(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_get_metadata(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
) -> Result<WorkspaceMetadataDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::get_metadata(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_get_project_registry_diagnostics(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
) -> Result<ProjectRegistryDiagnosticsDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::get_project_registry_diagnostics(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_recover_missing_metadata(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceRecoverMissingMetadataRequestDto,
) -> Result<WorkspaceMetadataRecoveryReportDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::recover_missing_metadata(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_reconcile_project_registry_from_hints(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceReconcileProjectRegistryFromHintsRequestDto,
) -> Result<WorkspaceProjectRegistryReconcileReportDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::reconcile_project_registry_from_hints(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_discover_recoverable_projects(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto,
) -> Result<WorkspaceProjectRegistryReconcileReportDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::discover_recoverable_projects(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_get_active_root(workspace_root: State<'_, WorkspaceRoot>) -> Result<String> {
    let workspace_path = workspace_root.inner().read().await.clone();
    Ok(workspace_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn workspace_architect_list_plans(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceArchitectListPlansRequestDto,
) -> Result<WorkspaceArchitectPlanListDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::architect::list_plans(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_architect_activate_plan_head(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceArchitectActivatePlanHeadRequestDto,
) -> Result<Option<WorkspaceArchitectPlanActivationHeadDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::architect::activate_plan_head(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_architect_activate_plan_chat(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    request: WorkspaceArchitectActivatePlanChatRequestDto,
) -> Result<Option<WorkspaceArchitectPlanTranscriptDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::architect::activate_plan_chat(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_architect_invalidate(branch_name: Option<String>) -> Result<()> {
    workspace::architect::invalidate(branch_name).await;
    Ok(())
}

#[tauri::command]
pub async fn workspace_preview_project_git_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    project_operations: State<'_, ProjectOperationStore>,
    path: Option<String>,
    request_id: Option<String>,
) -> Result<ProjectGitFlowDetectionDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let operation = project_operations.register(request_id.as_deref()).await;
    workspace::preview_project_git_setup_async(
        &workspace_path,
        path.as_deref(),
        operation.as_ref().map(ProjectOperationGuard::receiver),
    )
    .await
}

#[tauri::command]
pub async fn workspace_cancel_project_operation(
    project_operations: State<'_, ProjectOperationStore>,
    request_id: String,
) -> Result<bool> {
    Ok(project_operations.cancel(&request_id).await)
}

#[tauri::command]
pub async fn workspace_preview_project_access_change(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    project_id: String,
    target_read_only: bool,
) -> Result<ProjectAccessChangePreviewDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let db_pool = load_db_pool(&pool).await?;
    let worktrees = repository::list_git_worktrees_by_project(&db_pool, &project_id)
        .await
        .map_err(to_backend_db_error)?;
    let live_terminal_project_ids =
        load_live_terminal_project_ids(&db_pool, terminal_store.inner()).await?;

    workspace::preview_project_access_change(
        &workspace_path,
        &metadata_root,
        &project_id,
        target_read_only,
        &worktrees,
        &live_terminal_project_ids,
    )
    .await
}

#[tauri::command]
pub async fn workspace_set_active_root(
    workspace_root: State<'_, WorkspaceRoot>,
    path: String,
) -> Result<String> {
    let trimmed_path = path.trim();
    if parse_wsl_unc_path(trimmed_path).is_some() {
        let mut guard = workspace_root.inner().write().await;
        *guard = PathBuf::from(trimmed_path);
        return Ok(trimmed_path.to_string());
    }

    let candidate = PathBuf::from(trimmed_path);
    let base = workspace_root.inner().read().await.clone();
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    };
    let resolved = candidate.canonicalize().map_err(|_| {
        crate::core::error::BackendError::FilesystemNotFound {
            message: "Workspace path not found".to_string(),
        }
    })?;

    if !resolved.is_dir() {
        return Err(crate::core::error::BackendError::FilesystemIsFile {
            message: "Workspace path must be a directory".to_string(),
        });
    }

    let mut guard = workspace_root.inner().write().await;
    *guard = resolved.clone();
    Ok(resolved.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_create_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_operations: State<'_, ProjectOperationStore>,
    name: String,
    description: String,
    group_id: Option<String>,
    group_name: Option<String>,
    path: Option<String>,
    git_flow_settings: Option<ProjectGitFlowSettingsDto>,
    direct_edit: Option<bool>,
    request_id: Option<String>,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let operation = project_operations.register(request_id.as_deref()).await;
    let request = CreateProjectRequest {
        name,
        description,
        group_id,
        group_name,
        path,
        git_flow_settings,
        direct_edit: direct_edit.unwrap_or(false),
    };

    workspace::create_project_with_cancel(
        &workspace_path,
        &metadata_root,
        request,
        operation.as_ref().map(ProjectOperationGuard::receiver),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_create_project_with_git_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_operations: State<'_, ProjectOperationStore>,
    name: String,
    description: String,
    group_id: Option<String>,
    group_name: Option<String>,
    path: String,
    git_flow_settings: Option<ProjectGitFlowSettingsDto>,
    git_setup_actions: Vec<String>,
    expected_repo_root_path: Option<String>,
    expected_setup_state: String,
    expected_recommended_action_sequence: Vec<String>,
    request_id: Option<String>,
) -> Result<ProjectGitSetupCommitResultDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let operation = project_operations.register(request_id.as_deref()).await;
    let request = CreateProjectRequest {
        name,
        description,
        group_id,
        group_name,
        path: Some(path),
        git_flow_settings,
        direct_edit: false,
    };

    workspace::create_project_with_git_setup(
        &workspace_path,
        &metadata_root,
        request,
        &git_setup_actions,
        expected_repo_root_path.as_deref(),
        &expected_setup_state,
        &expected_recommended_action_sequence,
        operation.as_ref().map(ProjectOperationGuard::receiver),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_create_new_project_repo(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_operations: State<'_, ProjectOperationStore>,
    repo_name: String,
    parent_path: String,
    folder_name: String,
    group_id: Option<String>,
    group_name: Option<String>,
    git_flow_settings: Option<ProjectGitFlowSettingsDto>,
    request_id: Option<String>,
) -> Result<ProjectGitSetupCommitResultDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let operation = project_operations.register(request_id.as_deref()).await;
    let request = CreateNewProjectRepoRequest {
        repo_name,
        parent_path,
        folder_name,
        group_id,
        group_name,
        git_flow_settings,
    };

    workspace::create_new_project_repo_with_cancel(
        &workspace_path,
        &metadata_root,
        request,
        operation.as_ref().map(ProjectOperationGuard::receiver),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_import_git_repo(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    git_url: String,
    project_name: String,
    branch: String,
    group_id: Option<String>,
    group_name: Option<String>,
    path: Option<String>,
    git_flow_settings: Option<ProjectGitFlowSettingsDto>,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let request = ImportGitRepoRequest {
        git_url,
        project_name,
        branch,
        group_id,
        group_name,
        path,
        git_flow_settings,
    };

    workspace::import_git_repo(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_rename_project_group(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    group_id: String,
    name: String,
) -> Result<ProjectGroupDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::rename_project_group(&workspace_path, &metadata_root, &group_id, &name).await
}

#[tauri::command]
pub async fn workspace_create_project_group(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    name: String,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::create_project_group(&workspace_path, &metadata_root, &name, &project_ids).await
}

#[tauri::command]
pub async fn workspace_move_project_to_group(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    group_id: Option<String>,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::move_project_to_group(
        &workspace_path,
        &metadata_root,
        &project_id,
        group_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn workspace_rename_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    name: String,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::rename_project(&workspace_path, &metadata_root, &project_id, &name).await
}

#[tauri::command]
pub async fn workspace_update_project_git_flow(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    git_flow_settings: ProjectGitFlowSettingsDto,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_project_git_flow(
        &workspace_path,
        &metadata_root,
        &project_id,
        &git_flow_settings,
    )
    .await
}

#[tauri::command]
pub async fn workspace_update_project_git_flow_with_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    params: WorkspaceUpdateProjectGitFlowWithSetupParams,
) -> Result<ProjectGitSetupCommitResultDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_project_git_flow_with_setup(
        &workspace_path,
        &metadata_root,
        workspace::UpdateProjectGitFlowWithSetupInput {
            project_id: &params.project_id,
            git_flow_settings: &params.git_flow_settings,
            git_setup_actions: &params.git_setup_actions,
            expected_repo_root_path: params.expected_repo_root_path.as_deref(),
            expected_setup_state: &params.expected_setup_state,
            expected_recommended_action_sequence: &params.expected_recommended_action_sequence,
        },
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdateProjectGitFlowWithSetupParams {
    project_id: String,
    git_flow_settings: ProjectGitFlowSettingsDto,
    git_setup_actions: Vec<String>,
    expected_repo_root_path: Option<String>,
    expected_setup_state: String,
    expected_recommended_action_sequence: Vec<String>,
}

#[tauri::command]
pub async fn workspace_update_project_access(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    project_id: String,
    user_read_only: bool,
    direct_edit: Option<bool>,
    confirmed_migration: bool,
) -> Result<ProjectDto> {
    tracing::info!(
        action = "workspace_update_project_access_command_started",
        project_id = %project_id,
        user_read_only = user_read_only,
        confirmed_migration = confirmed_migration
    );
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let db_pool = load_db_pool(&pool).await?;
    let worktrees = repository::list_git_worktrees_by_project(&db_pool, &project_id)
        .await
        .map_err(to_backend_db_error)?;
    let live_terminal_project_ids =
        load_live_terminal_project_ids(&db_pool, terminal_store.inner()).await?;
    let current_project = workspace::get_project(&workspace_path, &metadata_root, &project_id)
        .await?
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    let next_direct_edit = direct_edit.unwrap_or(current_project.direct_edit);
    let target_read_only = user_read_only
        || (current_project.git_setup_state != "ready"
            && !(current_project.git_setup_state == "not_git" && next_direct_edit));
    let access_preview = workspace::preview_project_access_change(
        &workspace_path,
        &metadata_root,
        &project_id,
        target_read_only,
        &worktrees,
        &live_terminal_project_ids,
    )
    .await?;
    tracing::info!(
        action = "workspace_update_project_access_command_preview",
        project_id = %project_id,
        user_read_only = user_read_only,
        confirmed_migration = confirmed_migration,
        worktree_count = worktrees.len(),
        live_terminal_project_count = live_terminal_project_ids.len(),
        preview_can_apply = access_preview.can_apply,
        preview_requires_confirmation = access_preview.requires_confirmation,
        preview_blocking_reasons = ?access_preview.blocking_reasons
    );
    let project = workspace::update_project_access(
        &workspace_path,
        &metadata_root,
        &project_id,
        user_read_only,
        Some(next_direct_edit),
        confirmed_migration,
        Some(&access_preview),
    )
    .await?;
    if target_read_only {
        repository::update_git_worktree_project_access(&db_pool, &project_id, false, true)
            .await
            .map_err(to_backend_db_error)?;
    }
    tracing::info!(
        action = "workspace_update_project_access_command_succeeded",
        project_id = %project_id,
        user_read_only = project.user_read_only,
        is_read_only = project.is_read_only,
        git_setup_state = %project.git_setup_state,
        read_only_reason = ?project.read_only_reason
    );
    Ok(project)
}

#[tauri::command]
pub async fn workspace_archive_project_group(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    group_id: String,
) -> Result<ProjectGroupDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::archive_project_group(&workspace_path, &metadata_root, &group_id).await
}

#[tauri::command]
pub async fn workspace_archive_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::archive_project(&workspace_path, &metadata_root, &project_id).await
}

#[tauri::command]
pub async fn workspace_remove_project_group(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    group_id: String,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::remove_project_group(&workspace_path, &metadata_root, &group_id).await
}

#[tauri::command]
pub async fn workspace_close_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::close_project(&workspace_path, &metadata_root, &project_id).await
}

#[tauri::command]
pub async fn workspace_remove_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::remove_project(&workspace_path, &metadata_root, &project_id).await
}

#[tauri::command]
pub async fn workspace_debug_reset_project(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    force: Option<bool>,
) -> Result<DebugResetProjectReportDto> {
    if !cfg!(debug_assertions) {
        return Err(BackendError::Validation(
            "Project debug reset is only available in debug builds.".to_string(),
        ));
    }

    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::debug_reset_project(
        &workspace_path,
        &metadata_root,
        git_state.inner().clone(),
        &project_id,
        force.unwrap_or(false),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_create_manual_feature_draft(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    conversation_id: String,
    group_id: Option<String>,
    project_ids: Vec<String>,
    context_project_ids: Vec<String>,
    base_branch: Option<String>,
    title: Option<String>,
    description: Option<String>,
    task_kind: String,
    existing_branch_name: Option<String>,
    base_commit_hash: Option<String>,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let _ = group_id;
    workspace::create_manual_feature_draft(
        &workspace_path,
        &metadata_root,
        &task_id,
        &conversation_id,
        &project_ids,
        &context_project_ids,
        base_branch.as_deref(),
        title.as_deref(),
        description.as_deref(),
        &task_kind,
        existing_branch_name.as_deref(),
        base_commit_hash.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn workspace_finalize_manual_feature(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    conversation_id: Option<String>,
    title: String,
    description: String,
    feature_slug: String,
    task_kind: String,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::finalize_manual_feature(
        &workspace_path,
        &metadata_root,
        &task_id,
        conversation_id.as_deref(),
        &title,
        &description,
        &feature_slug,
        &task_kind,
    )
    .await
}

#[tauri::command]
pub async fn workspace_revert_manual_feature_to_draft(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    conversation_id: Option<String>,
    title: Option<String>,
    description: Option<String>,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::revert_manual_feature_to_draft(
        &workspace_path,
        &metadata_root,
        &task_id,
        conversation_id.as_deref(),
        title.as_deref(),
        description.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn workspace_delete_manual_feature_draft(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
) -> Result<()> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::delete_manual_feature_draft(&workspace_path, &metadata_root, &task_id).await
}

#[tauri::command]
pub async fn workspace_rename_manual_feature(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    title: String,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::rename_manual_feature(&workspace_path, &metadata_root, &task_id, &title).await
}

#[tauri::command]
pub async fn workspace_archive_manual_feature(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    reason: Option<String>,
    merged_at: Option<String>,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::archive_manual_feature(
        &workspace_path,
        &metadata_root,
        &task_id,
        reason.as_deref(),
        merged_at.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn workspace_restore_manual_feature(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::restore_manual_feature(&workspace_path, &metadata_root, &task_id).await
}

#[tauri::command]
pub async fn workspace_delete_manual_feature(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
) -> Result<()> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::delete_manual_feature(&workspace_path, &metadata_root, &task_id).await
}

#[tauri::command]
pub async fn workspace_update_standalone_task_status(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    status: String,
) -> Result<()> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_standalone_task_status(&workspace_path, &metadata_root, &task_id, &status)
        .await
}

#[tauri::command]
pub async fn workspace_update_manual_feature_merge_workflow(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    task_id: String,
    merge_workflow: Option<ManualFeatureMergeWorkflowDto>,
) -> Result<ManualFeatureDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_manual_feature_merge_workflow(
        &workspace_path,
        &metadata_root,
        &task_id,
        merge_workflow,
    )
    .await
}
