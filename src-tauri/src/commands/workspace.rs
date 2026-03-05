use crate::core::error::{BackendError, Result};
use crate::git::GitState;
use crate::workspace;
use crate::workspace::metadata::{
	CreateProjectRequest, ImportGitRepoRequest, ProjectDto, ProjectGroupDto, WorkspaceBootstrapDto,
	WorkspaceMetadataDto,
};
use crate::WorkspaceMetadataRoot;
use crate::WorkspaceRoot;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
	BackendError::Internal {
		message: format!("Workspace task join error: {}", err),
	}
}

async fn resolve_metadata_root(
	workspace_path: PathBuf,
	git_state: GitState,
) -> Result<PathBuf> {
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
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::get_bootstrap(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_list_projects(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
) -> Result<Vec<ProjectGroupDto>> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::list_projects(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_list_tasks(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
) -> Result<Vec<Value>> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::list_tasks(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_get_metadata(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
) -> Result<WorkspaceMetadataDto> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::get_metadata(&workspace_path, &metadata_root).await
}

#[tauri::command]
pub async fn workspace_get_active_root(
	workspace_root: State<'_, WorkspaceRoot>,
) -> Result<String> {
	let workspace_path = workspace_root.inner().read().await.clone();
	Ok(workspace_path.to_string_lossy().to_string())
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
pub async fn workspace_create_project(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
	name: String,
	description: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	let request = CreateProjectRequest {
		name,
		description,
		group_id,
		path,
	};

	workspace::create_project(&workspace_path, &metadata_root, request).await
}

#[tauri::command]
pub async fn workspace_import_git_repo(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
	git_url: String,
	project_name: String,
	branch: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	let request = ImportGitRepoRequest {
		git_url,
		project_name,
		branch,
		group_id,
		path,
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
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
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
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::rename_project(&workspace_path, &metadata_root, &project_id, &name).await
}

#[tauri::command]
pub async fn workspace_archive_project_group(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
	group_id: String,
) -> Result<ProjectGroupDto> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::archive_project_group(&workspace_path, &metadata_root, &group_id).await
}

#[tauri::command]
pub async fn workspace_archive_project(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
	project_id: String,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::archive_project(&workspace_path, &metadata_root, &project_id).await
}

#[tauri::command]
pub async fn workspace_close_project(
	workspace_root: State<'_, WorkspaceMetadataRoot>,
	git_state: State<'_, GitState>,
	project_id: String,
) -> Result<Vec<ProjectGroupDto>> {
	let workspace_path = workspace_root.inner().0.read().await.clone();
	let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
	workspace::close_project(&workspace_path, &metadata_root, &project_id).await
}
