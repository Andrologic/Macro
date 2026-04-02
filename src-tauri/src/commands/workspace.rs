use crate::core::error::{BackendError, Result};
use crate::git::GitState;
use crate::workspace;
use crate::workspace::metadata::{
    CreateProjectRequest, ImportGitRepoRequest, ManualFeatureDto, ProjectDto,
    ProjectGitFlowDetectionDto, ProjectGitFlowSettingsDto, ProjectGroupDto,
    ProjectRegistryDiagnosticsDto, WorkspaceBootstrapDto, WorkspaceMetadataDto,
    WorkspaceTaskCatalogDto,
};
use crate::WorkspaceMetadataRoot;
use crate::WorkspaceRoot;
use std::path::PathBuf;
use tauri::State;

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("Workspace task join error: {}", err),
    }
}

async fn resolve_metadata_root(workspace_path: PathBuf, git_state: GitState) -> Result<PathBuf> {
    tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&workspace_path))
        .await
        .map_err(to_join_error)?
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
pub async fn workspace_get_active_root(workspace_root: State<'_, WorkspaceRoot>) -> Result<String> {
    let workspace_path = workspace_root.inner().read().await.clone();
    Ok(workspace_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn workspace_detect_project_git_flow(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    path: Option<String>,
) -> Result<ProjectGitFlowDetectionDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    Ok(workspace::detect_project_git_flow(
        &workspace_path,
        path.as_deref(),
    ))
}

#[tauri::command]
pub async fn workspace_prepare_project_git(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    path: String,
) -> Result<ProjectGitFlowDetectionDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    workspace::prepare_project_git(&workspace_path, &path).await
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
pub async fn workspace_update_project_access(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    project_id: String,
    user_read_only: bool,
) -> Result<ProjectDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    workspace::update_project_access(&workspace_path, &metadata_root, &project_id, user_read_only)
        .await
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
