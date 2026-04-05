use crate::commands::terminal::TerminalSessionStore;
use crate::commands::{CommandError, DbPool};
use crate::core::error::{BackendError, Result};
use crate::db::repository;
use crate::git::GitState;
use crate::workspace;
use crate::workspace::metadata::{
    CreateProjectRequest, ImportGitRepoRequest, ManualFeatureDto, ProjectAccessChangePreviewDto,
    ProjectDto, ProjectGitFlowDetectionDto, ProjectGitFlowSettingsDto,
    ProjectGitSetupCommitResultDto, ProjectGroupDto, ProjectRegistryDiagnosticsDto,
    WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceMetadataRecoveryReportDto,
    WorkspaceRecoverMissingMetadataRequestDto, WorkspaceTaskCatalogDto,
};
use crate::WorkspaceMetadataRoot;
use crate::WorkspaceRoot;
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::State;

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("Workspace task join error: {}", err),
    }
}

async fn resolve_metadata_root(workspace_path: PathBuf, git_state: GitState) -> Result<PathBuf> {
    let workspace_path_for_fallback = workspace_path.clone();
    let resolved =
        tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&workspace_path))
            .await
            .map_err(to_join_error);
    match resolved {
        Ok(Ok(metadata_root)) => Ok(metadata_root),
        Ok(Err(BackendError::GitRepositoryNotFound { message })) => {
            let fallback = workspace_path_for_fallback.join(".macro");
            tracing::warn!(
                action = "workspace_metadata_root_fallback",
                workspace_path = %workspace_path_for_fallback.display(),
                fallback_path = %fallback.display(),
                reason = %message
            );
            Ok(fallback)
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(error),
    }
}

fn to_backend_error(error: CommandError) -> BackendError {
    BackendError::Internal {
        message: error.message,
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
) -> Result<WorkspaceBootstrapDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::get_bootstrap(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_list_projects(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
) -> Result<Vec<ProjectGroupDto>> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::list_projects(&workspace_path, &metadata_root).await
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
pub async fn workspace_get_active_root(workspace_root: State<'_, WorkspaceRoot>) -> Result<String> {
    let workspace_path = workspace_root.inner().read().await.clone();
    Ok(workspace_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn workspace_preview_project_git_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    path: Option<String>,
) -> Result<ProjectGitFlowDetectionDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    Ok(workspace::preview_project_git_setup(
        &workspace_path,
        path.as_deref(),
    ))
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
    let candidate = PathBuf::from(path);
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
    name: String,
    description: String,
    group_id: Option<String>,
    group_name: Option<String>,
    path: Option<String>,
    git_flow_settings: Option<ProjectGitFlowSettingsDto>,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let request = CreateProjectRequest {
        name,
        description,
        group_id,
        group_name,
        path,
        git_flow_settings,
    };

    workspace::create_project(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_create_project_with_git_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
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
) -> Result<ProjectGitSetupCommitResultDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let request = CreateProjectRequest {
        name,
        description,
        group_id,
        group_name,
        path: Some(path),
        git_flow_settings,
    };

    workspace::create_project_with_git_setup(
        &workspace_path,
        &metadata_root,
        request,
        &git_setup_actions,
        expected_repo_root_path.as_deref(),
        &expected_setup_state,
        &expected_recommended_action_sequence,
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
#[allow(clippy::too_many_arguments)]
pub async fn workspace_update_project_git_flow_with_setup(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    git_flow_settings: ProjectGitFlowSettingsDto,
    git_setup_actions: Vec<String>,
    expected_repo_root_path: Option<String>,
    expected_setup_state: String,
    expected_recommended_action_sequence: Vec<String>,
) -> Result<ProjectGitSetupCommitResultDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_project_git_flow_with_setup(
        &workspace_path,
        &metadata_root,
        &project_id,
        &git_flow_settings,
        &git_setup_actions,
        expected_repo_root_path.as_deref(),
        &expected_setup_state,
        &expected_recommended_action_sequence,
    )
    .await
}

#[tauri::command]
pub async fn workspace_update_project_access(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    project_id: String,
    user_read_only: bool,
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
    let access_preview = workspace::preview_project_access_change(
        &workspace_path,
        &metadata_root,
        &project_id,
        user_read_only,
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
        confirmed_migration,
        Some(&access_preview),
    )
    .await?;
    if user_read_only {
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
