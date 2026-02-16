pub mod metadata;

use crate::core::error::{BackendError, Result};
use chrono::Utc;
use metadata::{
	CreateProjectRequest, ImportGitRepoRequest, PlanDto, ProjectDto, ProjectGroupDto,
	ProjectMetadataDto, WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceState,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

const WORKSPACE_META_DIR: &str = ".macro";
const WORKSPACE_STATE_FILE: &str = "workspace.json";

pub async fn get_bootstrap(workspace_path: &PathBuf) -> Result<WorkspaceBootstrapDto> {
	let state = load_or_create_state(workspace_path).await?;
	Ok(WorkspaceBootstrapDto {
		plan: state.current_plan,
		project_groups: state.project_groups,
		plan_nodes: state.plan_nodes,
		predicted_branches: state.predicted_branches,
	})
}

pub async fn list_projects(workspace_path: &PathBuf) -> Result<Vec<ProjectGroupDto>> {
	let state = load_or_create_state(workspace_path).await?;
	Ok(state.project_groups)
}

pub async fn list_tasks(workspace_path: &PathBuf) -> Result<Vec<Value>> {
	let state = load_or_create_state(workspace_path).await?;
	Ok(state
		.current_plan
		.map(|plan| plan.tasks)
		.unwrap_or_default())
}

pub async fn get_metadata(workspace_path: &PathBuf) -> Result<WorkspaceMetadataDto> {
	let state = load_or_create_state(workspace_path).await?;
	let metadata_path = workspace_state_path(workspace_path);
	let project_count = state
		.project_groups
		.iter()
		.map(|group| group.projects.len())
		.sum();

	Ok(WorkspaceMetadataDto {
		workspace_path: workspace_path.to_string_lossy().to_string(),
		metadata_path: metadata_path.to_string_lossy().to_string(),
		project_count,
	})
}

pub async fn create_project(
	workspace_path: &PathBuf,
	request: CreateProjectRequest,
) -> Result<ProjectDto> {
	let mut state = load_or_create_state(workspace_path).await?;
	let project = build_project(
		&request.name,
		&request.description,
		request.path.as_deref(),
		workspace_path,
	);

	let project_path = resolve_project_path(workspace_path, &project.path);
	fs::create_dir_all(project_path)
		.await
		.map_err(|error| BackendError::Filesystem {
			message: format!("Failed to create project directory: {}", error),
		})?;

	upsert_project_group(&mut state.project_groups, request.group_id.as_deref(), project.clone());
	ensure_plan_has_project(&mut state, &project.id);

	persist_state(workspace_path, &state).await?;
	Ok(project)
}

pub async fn import_git_repo(
	workspace_path: &PathBuf,
	request: ImportGitRepoRequest,
) -> Result<ProjectDto> {
	let mut state = load_or_create_state(workspace_path).await?;
	let description = format!("Imported from {}", request.git_url);

	let project = build_project(
		&request.project_name,
		&description,
		request.path.as_deref(),
		workspace_path,
	);

	let project_path = resolve_project_path(workspace_path, &project.path);
	if !project_path.exists() {
		fs::create_dir_all(&project_path)
			.await
			.map_err(|error| BackendError::Filesystem {
				message: format!("Failed to create imported project directory: {}", error),
			})?;
	}

	upsert_project_group(&mut state.project_groups, request.group_id.as_deref(), project.clone());
	ensure_plan_has_project(&mut state, &project.id);

	persist_state(workspace_path, &state).await?;
	Ok(project)
}

fn workspace_state_path(workspace_path: &Path) -> PathBuf {
	workspace_path
		.join(WORKSPACE_META_DIR)
		.join(WORKSPACE_STATE_FILE)
}

async fn load_or_create_state(workspace_path: &PathBuf) -> Result<WorkspaceState> {
	let path = workspace_state_path(workspace_path);

	if path.exists() {
		let content = fs::read_to_string(&path)
			.await
			.map_err(|error| BackendError::Filesystem {
				message: format!("Failed to read workspace state: {}", error),
			})?;

		let state: WorkspaceState =
			serde_json::from_str(&content).map_err(|error| BackendError::Validation(format!(
				"Invalid workspace state format: {}",
				error
			)))?;
		return Ok(state);
	}

	let state = default_state(workspace_path)?;
	persist_state(workspace_path, &state).await?;
	Ok(state)
}

async fn persist_state(workspace_path: &PathBuf, state: &WorkspaceState) -> Result<()> {
	let metadata_dir = workspace_path.join(WORKSPACE_META_DIR);
	fs::create_dir_all(&metadata_dir)
		.await
		.map_err(|error| BackendError::Filesystem {
			message: format!("Failed to create workspace metadata directory: {}", error),
		})?;

	let serialized = serde_json::to_string_pretty(state)
		.map_err(|error| BackendError::Internal {
			message: format!("Failed to serialize workspace state: {}", error),
		})?;

	fs::write(workspace_state_path(workspace_path), serialized)
		.await
		.map_err(|error| BackendError::Filesystem {
			message: format!("Failed to write workspace state: {}", error),
		})?;

	Ok(())
}

fn default_state(workspace_path: &PathBuf) -> Result<WorkspaceState> {
	let now = Utc::now().to_rfc3339();
	let workspace_name = workspace_path
		.file_name()
		.and_then(|part| part.to_str())
		.unwrap_or("workspace")
		.to_string();

	let project_id = format!("project-{}", slugify(&workspace_name));
	let group_id = "group-main".to_string();

	let project = ProjectDto {
		id: project_id.clone(),
		name: workspace_name.clone(),
		path: ".".to_string(),
		created_at: now.clone(),
		status: "active".to_string(),
		metadata: ProjectMetadataDto {
			description: format!("Primary workspace project for {}", workspace_name),
			tags: Vec::new(),
			team_members: Vec::new(),
			api_contracts: Vec::new(),
			dependencies: Vec::new(),
		},
	};

	let group = ProjectGroupDto {
		id: group_id,
		name: "Workspace".to_string(),
		is_open: true,
		projects: vec![project.clone()],
	};

	let plan = PlanDto {
		id: "plan-main".to_string(),
		description: "Workspace execution plan".to_string(),
		created_at: now.clone(),
		updated_at: now,
		status: "Draft".to_string(),
		project_ids: vec![project_id],
		tasks: Vec::new(),
		predicted_git_trees: HashMap::new(),
	};

	Ok(WorkspaceState {
		project_groups: vec![group],
		current_plan: Some(plan),
		..WorkspaceState::default()
	})
}

fn build_project(name: &str, description: &str, path: Option<&str>, workspace_path: &PathBuf) -> ProjectDto {
	let now = Utc::now().to_rfc3339();
	let slug = slugify(name);
	let project_path = path
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| format!("projects/{}", slug));

	let project_name = name.trim();
	let normalized_name = if project_name.is_empty() {
		workspace_path
			.file_name()
			.and_then(|part| part.to_str())
			.unwrap_or("Project")
			.to_string()
	} else {
		project_name.to_string()
	};

	ProjectDto {
		id: format!("project-{}-{}", slug, Utc::now().timestamp_millis()),
		name: normalized_name,
		path: project_path,
		created_at: now,
		status: "active".to_string(),
		metadata: ProjectMetadataDto {
			description: description.to_string(),
			tags: Vec::new(),
			team_members: Vec::new(),
			api_contracts: Vec::new(),
			dependencies: Vec::new(),
		},
	}
}

fn upsert_project_group(groups: &mut Vec<ProjectGroupDto>, group_id: Option<&str>, project: ProjectDto) {
	if let Some(group_id) = group_id {
		if let Some(group) = groups.iter_mut().find(|group| group.id == group_id) {
			group.projects.push(project);
			return;
		}
	}

	let new_group_name = group_id
		.map(|value| value.to_string())
		.unwrap_or_else(|| project.name.clone());

	groups.push(ProjectGroupDto {
		id: format!("group-{}", Utc::now().timestamp_millis()),
		name: new_group_name,
		is_open: true,
		projects: vec![project],
	});
}

fn ensure_plan_has_project(state: &mut WorkspaceState, project_id: &str) {
	if state.current_plan.is_none() {
		let now = Utc::now().to_rfc3339();
		state.current_plan = Some(PlanDto {
			id: "plan-main".to_string(),
			description: "Workspace execution plan".to_string(),
			created_at: now.clone(),
			updated_at: now,
			status: "Draft".to_string(),
			project_ids: vec![project_id.to_string()],
			tasks: Vec::new(),
			predicted_git_trees: HashMap::new(),
		});
		return;
	}

	if let Some(plan) = state.current_plan.as_mut() {
		if !plan.project_ids.iter().any(|id| id == project_id) {
			plan.project_ids.push(project_id.to_string());
		}
		plan.updated_at = Utc::now().to_rfc3339();
	}
}

fn resolve_project_path(workspace_path: &PathBuf, project_path: &str) -> PathBuf {
	let candidate = PathBuf::from(project_path);
	if candidate.is_absolute() {
		candidate
	} else {
		workspace_path.join(candidate)
	}
}

fn slugify(input: &str) -> String {
	let slug: String = input
		.to_lowercase()
		.chars()
		.map(|character| {
			if character.is_ascii_alphanumeric() {
				character
			} else {
				'-'
			}
		})
		.collect();

	slug.trim_matches('-').to_string()
}
