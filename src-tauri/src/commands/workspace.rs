use crate::core::error::Result;
use crate::workspace;
use crate::workspace::metadata::{
	CreateProjectRequest, ImportGitRepoRequest, ProjectDto, ProjectGroupDto, WorkspaceBootstrapDto,
	WorkspaceMetadataDto,
};
use crate::WorkspaceRoot;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn workspace_get_bootstrap(
	workspace_root: State<'_, WorkspaceRoot>,
) -> Result<WorkspaceBootstrapDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::get_bootstrap(&workspace_path).await
}

#[tauri::command]
pub async fn workspace_list_projects(
	workspace_root: State<'_, WorkspaceRoot>,
) -> Result<Vec<ProjectGroupDto>> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::list_projects(&workspace_path).await
}

#[tauri::command]
pub async fn workspace_list_tasks(
	workspace_root: State<'_, WorkspaceRoot>,
) -> Result<Vec<Value>> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::list_tasks(&workspace_path).await
}

#[tauri::command]
pub async fn workspace_get_metadata(
	workspace_root: State<'_, WorkspaceRoot>,
) -> Result<WorkspaceMetadataDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::get_metadata(&workspace_path).await
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
	workspace_root: State<'_, WorkspaceRoot>,
	name: String,
	description: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	let request = CreateProjectRequest {
		name,
		description,
		group_id,
		path,
	};

	workspace::create_project(&workspace_path, request).await
}

#[tauri::command]
pub async fn workspace_import_git_repo(
	workspace_root: State<'_, WorkspaceRoot>,
	git_url: String,
	project_name: String,
	branch: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	let request = ImportGitRepoRequest {
		git_url,
		project_name,
		branch,
		group_id,
		path,
	};

	workspace::import_git_repo(&workspace_path, request).await
}

#[tauri::command]
pub async fn workspace_rename_project_group(
	workspace_root: State<'_, WorkspaceRoot>,
	group_id: String,
	name: String,
) -> Result<ProjectGroupDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::rename_project_group(&workspace_path, &group_id, &name).await
}

#[tauri::command]
pub async fn workspace_rename_project(
	workspace_root: State<'_, WorkspaceRoot>,
	project_id: String,
	name: String,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::rename_project(&workspace_path, &project_id, &name).await
}

#[tauri::command]
pub async fn workspace_archive_project_group(
	workspace_root: State<'_, WorkspaceRoot>,
	group_id: String,
) -> Result<ProjectGroupDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::archive_project_group(&workspace_path, &group_id).await
}

#[tauri::command]
pub async fn workspace_archive_project(
	workspace_root: State<'_, WorkspaceRoot>,
	project_id: String,
) -> Result<ProjectDto> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::archive_project(&workspace_path, &project_id).await
}

#[tauri::command]
pub async fn workspace_close_project(
	workspace_root: State<'_, WorkspaceRoot>,
	project_id: String,
) -> Result<Vec<ProjectGroupDto>> {
	let workspace_path = workspace_root.inner().read().await.clone();
	workspace::close_project(&workspace_path, &project_id).await
}
