use crate::core::error::Result;
use crate::workspace;
use crate::workspace::metadata::{
	CreateProjectRequest, ImportGitRepoRequest, ProjectDto, ProjectGroupDto, WorkspaceBootstrapDto,
	WorkspaceMetadataDto,
};
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn workspace_get_bootstrap(
	workspace_path: State<'_, PathBuf>,
) -> Result<WorkspaceBootstrapDto> {
	workspace::get_bootstrap(&workspace_path.inner().clone()).await
}

#[tauri::command]
pub async fn workspace_list_projects(
	workspace_path: State<'_, PathBuf>,
) -> Result<Vec<ProjectGroupDto>> {
	workspace::list_projects(&workspace_path.inner().clone()).await
}

#[tauri::command]
pub async fn workspace_list_tasks(
	workspace_path: State<'_, PathBuf>,
) -> Result<Vec<Value>> {
	workspace::list_tasks(&workspace_path.inner().clone()).await
}

#[tauri::command]
pub async fn workspace_get_metadata(
	workspace_path: State<'_, PathBuf>,
) -> Result<WorkspaceMetadataDto> {
	workspace::get_metadata(&workspace_path.inner().clone()).await
}

#[tauri::command]
pub async fn workspace_create_project(
	workspace_path: State<'_, PathBuf>,
	name: String,
	description: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let request = CreateProjectRequest {
		name,
		description,
		group_id,
		path,
	};

	workspace::create_project(&workspace_path.inner().clone(), request).await
}

#[tauri::command]
pub async fn workspace_import_git_repo(
	workspace_path: State<'_, PathBuf>,
	git_url: String,
	project_name: String,
	branch: String,
	group_id: Option<String>,
	path: Option<String>,
) -> Result<ProjectDto> {
	let request = ImportGitRepoRequest {
		git_url,
		project_name,
		branch,
		group_id,
		path,
	};

	workspace::import_git_repo(&workspace_path.inner().clone(), request).await
}
