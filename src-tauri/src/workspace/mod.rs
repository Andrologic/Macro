pub mod metadata;

use crate::core::error::{BackendError, Result};
use chrono::Utc;
use metadata::{
    CreateProjectRequest, ImportGitRepoRequest, PlanDto, ProjectDto, ProjectGroupDto,
    ProjectMetadataDto, WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceState,
    WorkspaceTaskCatalogDto, WorkspaceTaskPlanSummaryDto,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

const WORKSPACE_STATE_FILE: &str = "workspace.json";
const LEGACY_WORKSPACE_META_DIR: &str = ".macro";

pub async fn get_bootstrap(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceBootstrapDto> {
    let _ = workspace_path;
    let state = load_or_default_state(metadata_root).await?;
    Ok(WorkspaceBootstrapDto {
        plan: state.current_plan,
        project_groups: state.project_groups,
        plan_nodes: state.plan_nodes,
        predicted_branches: state.predicted_branches,
    })
}

pub async fn list_projects(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<Vec<ProjectGroupDto>> {
    let _ = workspace_path;
    let state = load_or_default_state(metadata_root).await?;
    Ok(state.project_groups)
}

pub async fn list_tasks(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceTaskCatalogDto> {
    let _ = workspace_path;
    let state = load_or_default_state(metadata_root).await?;
    let Some(plan) = state.current_plan else {
        return Ok(WorkspaceTaskCatalogDto {
            tasks: Vec::new(),
            plans: Vec::new(),
            has_standalone_tasks: false,
            source: "empty".to_string(),
        });
    };

    let task_count = plan.tasks.len();
    let completed_task_count = plan
        .tasks
        .iter()
        .filter(|task| task_status_matches(task, &["Completed"]))
        .count();
    let active_task_count = plan
        .tasks
        .iter()
        .filter(|task| task_status_matches(task, &["InProgress", "AwaitingResponse"]))
        .count();
    let in_review_task_count = plan
        .tasks
        .iter()
        .filter(|task| task_status_matches(task, &["InReview"]))
        .count();
    let is_executable_plan = matches!(plan.status.as_str(), "Validated" | "InProgress");

    let plans = if is_executable_plan {
        vec![WorkspaceTaskPlanSummaryDto {
            id: plan.id.clone(),
            title: plan.description.clone(),
            status: plan.status.clone(),
            target_branch: get_git_flow_target_branch(&plan),
            project_ids: plan.project_ids.clone(),
            task_count,
            completed_task_count,
            active_task_count,
            in_review_task_count,
            ready_for_validation: task_count > 0 && completed_task_count == task_count,
        }]
    } else {
        Vec::new()
    };

    let has_standalone_tasks = !is_executable_plan && task_count > 0;
    let source = if is_executable_plan {
        "architect".to_string()
    } else if has_standalone_tasks {
        "fallback".to_string()
    } else {
        "empty".to_string()
    };

    Ok(WorkspaceTaskCatalogDto {
        tasks: plan.tasks,
        plans,
        has_standalone_tasks,
        source,
    })
}

pub async fn get_metadata(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceMetadataDto> {
    let state = load_or_default_state(metadata_root).await?;
    let metadata_path = workspace_state_path(metadata_root);
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
    metadata_root: &PathBuf,
    request: CreateProjectRequest,
) -> Result<ProjectDto> {
    let mut state = load_or_create_state(metadata_root).await?;
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

    upsert_project_group(
        &mut state.project_groups,
        request.group_id.as_deref(),
        project.clone(),
    );
    ensure_plan_has_project(&mut state, &project.id);

    persist_state(metadata_root, &state).await?;
    Ok(project)
}

pub async fn import_git_repo(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    request: ImportGitRepoRequest,
) -> Result<ProjectDto> {
    let mut state = load_or_create_state(metadata_root).await?;
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

    upsert_project_group(
        &mut state.project_groups,
        request.group_id.as_deref(),
        project.clone(),
    );
    ensure_plan_has_project(&mut state, &project.id);

    persist_state(metadata_root, &state).await?;
    Ok(project)
}

pub async fn rename_project_group(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    group_id: &str,
    name: &str,
) -> Result<ProjectGroupDto> {
    let _ = workspace_path;
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Project group name cannot be empty".to_string(),
        ));
    }

    let mut state = load_or_create_state(metadata_root).await?;
    let group = state
        .project_groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;

    group.name = trimmed_name.to_string();
    let updated_group = group.clone();

    persist_state(metadata_root, &state).await?;
    Ok(updated_group)
}

pub async fn rename_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
    name: &str,
) -> Result<ProjectDto> {
    let _ = workspace_path;
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Project name cannot be empty".to_string(),
        ));
    }

    let mut state = load_or_create_state(metadata_root).await?;
    let mut updated_project: Option<ProjectDto> = None;

    for group in state.project_groups.iter_mut() {
        if let Some(project) = group
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.name = trimmed_name.to_string();
            updated_project = Some(project.clone());
            break;
        }
    }

    let updated_project = updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    persist_state(metadata_root, &state).await?;
    Ok(updated_project)
}

pub async fn archive_project_group(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    group_id: &str,
) -> Result<ProjectGroupDto> {
    let _ = workspace_path;
    let mut state = load_or_create_state(metadata_root).await?;
    let group = state
        .project_groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;

    for project in group.projects.iter_mut() {
        project.status = "archived".to_string();
    }

    let updated_group = group.clone();
    persist_state(metadata_root, &state).await?;
    Ok(updated_group)
}

pub async fn archive_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> Result<ProjectDto> {
    let _ = workspace_path;
    let mut state = load_or_create_state(metadata_root).await?;
    let mut updated_project: Option<ProjectDto> = None;

    for group in state.project_groups.iter_mut() {
        if let Some(project) = group
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.status = "archived".to_string();
            updated_project = Some(project.clone());
            break;
        }
    }

    let updated_project = updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    persist_state(metadata_root, &state).await?;
    Ok(updated_project)
}

pub async fn close_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    let _ = workspace_path;
    let mut state = load_or_create_state(metadata_root).await?;
    let initial_project_count: usize = state
        .project_groups
        .iter()
        .map(|group| group.projects.len())
        .sum();

    for group in state.project_groups.iter_mut() {
        group.projects.retain(|project| project.id != project_id);
    }

    state
        .project_groups
        .retain(|group| !group.projects.is_empty());

    let remaining_project_count: usize = state
        .project_groups
        .iter()
        .map(|group| group.projects.len())
        .sum();

    if initial_project_count == remaining_project_count {
        return Err(BackendError::Validation(format!(
            "Unknown project id: {}",
            project_id
        )));
    }

    if let Some(plan) = state.current_plan.as_mut() {
        plan.project_ids.retain(|id| id != project_id);
        plan.updated_at = Utc::now().to_rfc3339();
    }

    persist_state(metadata_root, &state).await?;
    Ok(state.project_groups)
}

fn workspace_state_path(metadata_root: &Path) -> PathBuf {
    metadata_root.join(WORKSPACE_STATE_FILE)
}

fn legacy_workspace_state_path(metadata_root: &Path) -> PathBuf {
    metadata_root
        .join(LEGACY_WORKSPACE_META_DIR)
        .join(WORKSPACE_STATE_FILE)
}

async fn load_or_create_state(metadata_root: &PathBuf) -> Result<WorkspaceState> {
    if let Some(state) = load_state(metadata_root).await? {
        return Ok(state);
    }

    let state = WorkspaceState::default();
    persist_state(metadata_root, &state).await?;
    Ok(state)
}

async fn load_or_default_state(metadata_root: &PathBuf) -> Result<WorkspaceState> {
    if let Some(state) = load_state(metadata_root).await? {
        return Ok(state);
    }

    Ok(WorkspaceState::default())
}

async fn load_state(metadata_root: &PathBuf) -> Result<Option<WorkspaceState>> {
    let primary_path = workspace_state_path(metadata_root);
    let legacy_path = legacy_workspace_state_path(metadata_root);
    let path = if primary_path.exists() {
        primary_path
    } else if legacy_path.exists() {
        legacy_path
    } else {
        return Ok(None);
    };

    let content = fs::read_to_string(&path)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to read workspace state: {}", error),
        })?;

    let state: WorkspaceState = serde_json::from_str(&content).map_err(|error| {
        BackendError::Validation(format!("Invalid workspace state format: {}", error))
    })?;
    Ok(Some(state))
}

async fn persist_state(workspace_path: &PathBuf, state: &WorkspaceState) -> Result<()> {
    fs::create_dir_all(workspace_path)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to create workspace metadata directory: {}", error),
        })?;

    let serialized =
        serde_json::to_string_pretty(state).map_err(|error| BackendError::Internal {
            message: format!("Failed to serialize workspace state: {}", error),
        })?;

    fs::write(workspace_state_path(workspace_path), serialized)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to write workspace state: {}", error),
        })?;

    Ok(())
}

fn build_project(
    name: &str,
    description: &str,
    path: Option<&str>,
    workspace_path: &PathBuf,
) -> ProjectDto {
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

fn upsert_project_group(
    groups: &mut Vec<ProjectGroupDto>,
    group_id: Option<&str>,
    project: ProjectDto,
) {
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

fn task_status_matches(task: &Value, expected: &[&str]) -> bool {
    task.get("status")
        .and_then(|value| value.as_str())
        .map(|status| expected.iter().any(|candidate| candidate == &status))
        .unwrap_or(false)
}

fn get_git_flow_target_branch(plan: &PlanDto) -> String {
    plan.predicted_git_trees
        .get("targetBranch")
        .and_then(|value| value.as_str())
        .unwrap_or("develop")
        .to_string()
}
