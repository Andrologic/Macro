pub mod metadata;

use crate::core::error::{BackendError, Result};
use chrono::Utc;
use metadata::{
    CreateProjectRequest, ImportGitRepoRequest, PlanDto, ProjectDto, ProjectGroupDto,
    ProjectMetadataDto, ProjectRegistryDiagnosticsDto, ProjectRegistryRepairReportDto,
    WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceState, WorkspaceTaskCatalogDto,
    WorkspaceTaskPlanSummaryDto,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::fs;

const WORKSPACE_STATE_FILE: &str = "workspace.json";
const LEGACY_WORKSPACE_META_DIR: &str = ".macro";

fn count_projects(groups: &[ProjectGroupDto]) -> usize {
    groups.iter().map(|group| group.projects.len()).sum()
}

pub async fn get_project_registry_diagnostics(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<ProjectRegistryDiagnosticsDto> {
    let raw_state = load_raw_state(metadata_root).await?.unwrap_or_default();
    let (sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, raw_state.clone());

    Ok(ProjectRegistryDiagnosticsDto {
        raw_group_count: raw_state.project_groups.len(),
        raw_project_count: count_projects(&raw_state.project_groups),
        sanitized_group_count: sanitized_state.project_groups.len(),
        sanitized_project_count: count_projects(&sanitized_state.project_groups),
        raw_project_groups: raw_state.project_groups,
        sanitized_project_groups: sanitized_state.project_groups,
        repair_report,
    })
}

pub async fn get_bootstrap(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceBootstrapDto> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
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
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    Ok(state.project_groups)
}

pub async fn list_tasks(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceTaskCatalogDto> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
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
    let state = load_or_default_state(workspace_path, metadata_root).await?;
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
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "create_project",
        group_id = ?request.group_id,
        group_name = ?request.group_name,
        project_name = %request.name,
        project_path = ?request.path
    );
    ensure_valid_project_group_target(
        &state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.name,
    )?;
    let project = build_project(
        &request.name,
        &request.description,
        request.path.as_deref(),
        workspace_path,
    );
    ensure_unique_project_name_in_group(
        &state.project_groups,
        request.group_id.as_deref(),
        &project.name,
    )?;

    let project_path = resolve_project_path(workspace_path, &project.path);
    ensure_unique_project_path(&state.project_groups, workspace_path, &project_path)?;
    fs::create_dir_all(project_path)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!("Failed to create project directory: {}", error),
        })?;

    insert_project_into_group(
        &mut state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        project.clone(),
    )?;
    ensure_plan_has_project(&mut state, &project.id);

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "create_project").await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "create_project",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(project)
}

pub async fn import_git_repo(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    request: ImportGitRepoRequest,
) -> Result<ProjectDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "import_git_repo",
        group_id = ?request.group_id,
        group_name = ?request.group_name,
        project_name = %request.project_name,
        project_path = ?request.path,
        git_url = %request.git_url
    );
    let description = format!("Imported from {}", request.git_url);
    ensure_valid_project_group_target(
        &state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.project_name,
    )?;

    let project = build_project(
        &request.project_name,
        &description,
        request.path.as_deref(),
        workspace_path,
    );
    ensure_unique_project_name_in_group(
        &state.project_groups,
        request.group_id.as_deref(),
        &project.name,
    )?;

    let project_path = resolve_project_path(workspace_path, &project.path);
    ensure_unique_project_path(&state.project_groups, workspace_path, &project_path)?;
    if !project_path.exists() {
        fs::create_dir_all(&project_path)
            .await
            .map_err(|error| BackendError::Filesystem {
                message: format!("Failed to create imported project directory: {}", error),
            })?;
    }

    insert_project_into_group(
        &mut state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        project.clone(),
    )?;
    ensure_plan_has_project(&mut state, &project.id);

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "import_git_repo").await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "import_git_repo",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(project)
}

pub async fn rename_project_group(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    group_id: &str,
    name: &str,
) -> Result<ProjectGroupDto> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Project group name cannot be empty".to_string(),
        ));
    }

    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "rename_project_group",
        group_id = %group_id,
        next_name = %trimmed_name
    );
    let group = state
        .project_groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;

    group.name = trimmed_name.to_string();
    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "rename_project_group")
            .await?;
    let updated_group = sanitized_state
        .project_groups
        .iter()
        .find(|group| group.id == group_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project group id: {}", group_id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "rename_project_group",
        group_id = %group_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(updated_group)
}

pub async fn rename_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
    name: &str,
) -> Result<ProjectDto> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Project name cannot be empty".to_string(),
        ));
    }

    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "rename_project",
        project_id = %project_id,
        next_name = %trimmed_name
    );
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

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "rename_project").await?;
    let updated_project = sanitized_state
        .project_groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "rename_project",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(updated_project)
}

pub async fn archive_project_group(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    group_id: &str,
) -> Result<ProjectGroupDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
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

    let (sanitized_state, _) =
        persist_sanitized_state(workspace_path, metadata_root, state, "archive_project_group")
            .await?;
    let updated_group = sanitized_state
        .project_groups
        .iter()
        .find(|group| group.id == group_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project group id: {}", group_id)))?;
    Ok(updated_group)
}

pub async fn archive_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> Result<ProjectDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
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

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, _) =
        persist_sanitized_state(workspace_path, metadata_root, state, "archive_project").await?;
    let updated_project = sanitized_state
        .project_groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    Ok(updated_project)
}

pub async fn remove_project_group(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    group_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "remove_project_group",
        group_id = %group_id,
        before_group_count = state.project_groups.len(),
        before_project_count = count_projects(&state.project_groups)
    );
    let removed_project_ids = state
        .project_groups
        .iter()
        .find(|group| group.id == group_id)
        .map(|group| {
            group
                .projects
                .iter()
                .map(|project| project.id.clone())
                .collect::<Vec<_>>()
        })
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;

    state.project_groups.retain(|group| group.id != group_id);

    if let Some(plan) = state.current_plan.as_mut() {
        plan.project_ids
            .retain(|id| !removed_project_ids.iter().any(|project_id| project_id == id));
        plan.updated_at = Utc::now().to_rfc3339();
    }

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "remove_project_group")
            .await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "remove_project_group",
        group_id = %group_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(sanitized_state.project_groups)
}

pub async fn close_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "remove_project",
        project_id = %project_id,
        before_group_count = state.project_groups.len(),
        before_project_count = count_projects(&state.project_groups)
    );
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

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "remove_project").await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "remove_project",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(sanitized_state.project_groups)
}

pub async fn remove_project(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    close_project(workspace_path, metadata_root, project_id).await
}

fn workspace_state_path(metadata_root: &Path) -> PathBuf {
    metadata_root.join(WORKSPACE_STATE_FILE)
}

fn legacy_workspace_state_path(metadata_root: &Path) -> PathBuf {
    metadata_root
        .join(LEGACY_WORKSPACE_META_DIR)
        .join(WORKSPACE_STATE_FILE)
}

async fn load_or_create_state(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceState> {
    if let Some(state) = load_state(workspace_path, metadata_root).await? {
        return Ok(state);
    }

    let state = WorkspaceState::default();
    persist_state(metadata_root, &state).await?;
    Ok(state)
}

async fn load_or_default_state(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<WorkspaceState> {
    if let Some(state) = load_state(workspace_path, metadata_root).await? {
        return Ok(state);
    }

    Ok(WorkspaceState::default())
}

async fn load_state(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
) -> Result<Option<WorkspaceState>> {
    let Some(state) = load_raw_state(metadata_root).await? else {
        return Ok(None);
    };

    let (sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, state);
    if repair_report.has_repairs() {
        tracing::warn!(
            action = "project_registry_state_sanitized",
            duplicate_paths_removed = repair_report.duplicate_paths_removed,
            empty_groups_removed = repair_report.empty_groups_removed,
            removed_synthetic_groups = repair_report.removed_synthetic_groups,
            removed_synthetic_projects = repair_report.removed_synthetic_projects,
            removed_group_ids = ?repair_report.removed_group_ids,
            removed_project_ids = ?repair_report.removed_project_ids,
            current_plan_project_ids_removed = repair_report.current_plan_project_ids_removed,
            current_plan_tasks_removed = repair_report.current_plan_tasks_removed,
            current_plan_task_targets_removed = repair_report.current_plan_task_targets_removed,
            plan_nodes_removed = repair_report.plan_nodes_removed,
            predicted_branches_removed = repair_report.predicted_branches_removed
        );
        persist_state(metadata_root, &sanitized_state).await?;
    }

    Ok(Some(sanitized_state))
}

async fn load_raw_state(metadata_root: &PathBuf) -> Result<Option<WorkspaceState>> {
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

fn sanitize_workspace_state(
    workspace_path: &PathBuf,
    mut state: WorkspaceState,
) -> (WorkspaceState, ProjectRegistryRepairReportDto) {
    let mut repair_report = ProjectRegistryRepairReportDto::default();
    let mut seen_paths = HashSet::new();
    let mut valid_project_ids = HashSet::new();
    let mut sanitized_groups = Vec::with_capacity(state.project_groups.len());

    for group in state.project_groups {
        if group.id.starts_with("session-group-") {
            repair_report.removed_synthetic_groups += 1;
            repair_report.removed_group_ids.push(group.id);
            continue;
        }

        let mut sanitized_projects = Vec::with_capacity(group.projects.len());
        for project in group.projects {
            if project.id.starts_with("session-project-") {
                repair_report.removed_synthetic_projects += 1;
                repair_report.removed_project_ids.push(project.id);
                continue;
            }

            let resolved_path = resolve_project_path(workspace_path, &project.path);
            let normalized_key = normalized_path_key(&resolved_path);
            if normalized_key.trim().is_empty() {
                repair_report.removed_project_ids.push(project.id);
                continue;
            }

            if seen_paths.contains(&normalized_key) {
                repair_report.duplicate_paths_removed += 1;
                repair_report.removed_project_ids.push(project.id);
                continue;
            }

            seen_paths.insert(normalized_key);
            valid_project_ids.insert(project.id.clone());
            sanitized_projects.push(project);
        }

        if sanitized_projects.is_empty() {
            repair_report.empty_groups_removed += 1;
            repair_report.removed_group_ids.push(group.id);
            continue;
        }

        sanitized_groups.push(ProjectGroupDto {
            projects: sanitized_projects,
            ..group
        });
    }

    let removed_group_id_set: HashSet<&str> = repair_report
        .removed_group_ids
        .iter()
        .map(String::as_str)
        .collect();
    sanitized_groups.retain(|group| {
        if removed_group_id_set.contains(group.id.as_str()) {
            return false;
        }
        true
    });

    state.project_groups = sanitized_groups;

    if let Some(plan) = state.current_plan.as_mut() {
        let initial_project_ids = plan.project_ids.len();
        plan.project_ids.retain(|project_id| valid_project_ids.contains(project_id));
        let mut unique_project_ids = HashSet::new();
        plan.project_ids.retain(|project_id| unique_project_ids.insert(project_id.clone()));
        repair_report.current_plan_project_ids_removed =
            initial_project_ids.saturating_sub(plan.project_ids.len());

        let (sanitized_tasks, removed_tasks, removed_targets) =
            sanitize_plan_tasks(&plan.tasks, &valid_project_ids);
        if removed_tasks > 0 || removed_targets > 0 || sanitized_tasks.len() != plan.tasks.len() {
            plan.tasks = sanitized_tasks;
        }
        repair_report.current_plan_tasks_removed = removed_tasks;
        repair_report.current_plan_task_targets_removed = removed_targets;

        if repair_report.current_plan_project_ids_removed > 0
            || repair_report.current_plan_tasks_removed > 0
            || repair_report.current_plan_task_targets_removed > 0
        {
            plan.updated_at = Utc::now().to_rfc3339();
        }
    }

    let initial_plan_node_count = state.plan_nodes.len();
    state.plan_nodes.retain(|node| {
        node.project_id
            .as_ref()
            .map(|project_id| valid_project_ids.contains(project_id))
            .unwrap_or(true)
    });
    repair_report.plan_nodes_removed =
        initial_plan_node_count.saturating_sub(state.plan_nodes.len());

    let initial_predicted_branch_count = state.predicted_branches.len();
    state.predicted_branches.retain(|branch| valid_project_ids.contains(&branch.project_id));
    repair_report.predicted_branches_removed =
        initial_predicted_branch_count.saturating_sub(state.predicted_branches.len());

    (state, repair_report)
}

fn sanitize_plan_tasks(
    tasks: &[Value],
    valid_project_ids: &HashSet<String>,
) -> (Vec<Value>, usize, usize) {
    let mut removed_tasks = 0usize;
    let mut removed_targets = 0usize;
    let mut sanitized_tasks = Vec::with_capacity(tasks.len());

    for task in tasks {
        let Some(task_object) = task.as_object() else {
            sanitized_tasks.push(task.clone());
            continue;
        };

        let mut next_task = serde_json::Map::from_iter(task_object.clone().into_iter());
        let project_ids = next_task
            .get("project_ids")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .filter(|project_id| valid_project_ids.contains(*project_id))
                    .map(|project_id| Value::String(project_id.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if next_task.contains_key("project_ids") {
            if project_ids.is_empty() {
                next_task.remove("project_ids");
            } else {
                next_task.insert("project_ids".to_string(), Value::Array(project_ids.clone()));
            }
        }

        let execution_targets = next_task
            .get("execution_targets")
            .and_then(|value| value.as_array())
            .map(|targets| {
                let initial_len = targets.len();
                let filtered_targets = targets
                    .iter()
                    .filter(|target| {
                        target
                            .get("projectId")
                            .and_then(|value| value.as_str())
                            .map(|project_id| valid_project_ids.contains(project_id))
                            .unwrap_or(true)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                removed_targets += initial_len.saturating_sub(filtered_targets.len());
                filtered_targets
            })
            .unwrap_or_default();

        if next_task.contains_key("execution_targets") {
            if execution_targets.is_empty() {
                next_task.remove("execution_targets");
            } else {
                next_task.insert(
                    "execution_targets".to_string(),
                    Value::Array(execution_targets.clone()),
                );
            }
        }

        let fallback_project_id = project_ids
            .first()
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                execution_targets.iter().find_map(|target| {
                    target
                        .get("projectId")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
            });

        let is_primary_project_valid = next_task
            .get("project_id")
            .and_then(|value| value.as_str())
            .map(|project_id| valid_project_ids.contains(project_id))
            .unwrap_or(true);

        if !is_primary_project_valid {
            if let Some(next_project_id) = fallback_project_id.clone() {
                next_task.insert("project_id".to_string(), Value::String(next_project_id));
            } else {
                removed_tasks += 1;
                continue;
            }
        } else if !next_task.contains_key("project_id") {
            if let Some(next_project_id) = fallback_project_id {
                next_task.insert("project_id".to_string(), Value::String(next_project_id));
            }
        }

        sanitized_tasks.push(Value::Object(next_task));
    }

    (sanitized_tasks, removed_tasks, removed_targets)
}

async fn persist_sanitized_state(
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    state: WorkspaceState,
    operation: &str,
) -> Result<(WorkspaceState, ProjectRegistryRepairReportDto)> {
    let (sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, state);
    if repair_report.has_repairs() {
        tracing::warn!(
            action = "project_registry_mutation_sanitized",
            operation,
            duplicate_paths_removed = repair_report.duplicate_paths_removed,
            empty_groups_removed = repair_report.empty_groups_removed,
            removed_synthetic_groups = repair_report.removed_synthetic_groups,
            removed_synthetic_projects = repair_report.removed_synthetic_projects,
            removed_group_ids = ?repair_report.removed_group_ids,
            removed_project_ids = ?repair_report.removed_project_ids,
            current_plan_project_ids_removed = repair_report.current_plan_project_ids_removed,
            current_plan_tasks_removed = repair_report.current_plan_tasks_removed,
            current_plan_task_targets_removed = repair_report.current_plan_task_targets_removed,
            plan_nodes_removed = repair_report.plan_nodes_removed,
            predicted_branches_removed = repair_report.predicted_branches_removed
        );
    }

    persist_state(metadata_root, &sanitized_state).await?;
    Ok((sanitized_state, repair_report))
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

fn normalize_group_name(group_name: Option<&str>, fallback_name: &str) -> String {
    let trimmed_group_name = group_name.unwrap_or_default().trim();
    if !trimmed_group_name.is_empty() {
        return trimmed_group_name.to_string();
    }
    fallback_name.trim().to_string()
}

fn ensure_valid_project_group_target(
    groups: &[ProjectGroupDto],
    group_id: Option<&str>,
    group_name: Option<&str>,
    fallback_name: &str,
) -> Result<()> {
    if let Some(group_id) = group_id {
        if groups.iter().any(|group| group.id == group_id) {
            return Ok(());
        }
        return Err(BackendError::Validation(format!(
            "Unknown project group id: {}",
            group_id
        )));
    }

    if normalize_group_name(group_name, fallback_name).trim().is_empty() {
        return Err(BackendError::Validation(
            "Project group name cannot be empty".to_string(),
        ));
    }

    Ok(())
}

fn ensure_unique_project_name_in_group(
    groups: &[ProjectGroupDto],
    group_id: Option<&str>,
    project_name: &str,
) -> Result<()> {
    let trimmed_name = project_name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Project name cannot be empty".to_string(),
        ));
    }

    if let Some(group_id) = group_id {
        let duplicate = groups
            .iter()
            .find(|group| group.id == group_id)
            .and_then(|group| {
                group.projects.iter().find(|project| {
                    project.name.trim().eq_ignore_ascii_case(trimmed_name)
                })
            });
        if duplicate.is_some() {
            return Err(BackendError::Validation(format!(
                "A subproject named \"{}\" already exists in this global project.",
                trimmed_name
            )));
        }
    }

    Ok(())
}

fn normalized_path_key(path: &PathBuf) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        normalized.trim_end_matches('/').to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized.trim_end_matches('/').to_string()
    }
}

fn ensure_unique_project_path(
    groups: &[ProjectGroupDto],
    workspace_path: &PathBuf,
    project_path: &PathBuf,
) -> Result<()> {
    let next_project_path_key = normalized_path_key(project_path);
    let duplicate = groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .any(|project| {
            let existing_path = resolve_project_path(workspace_path, &project.path);
            normalized_path_key(&existing_path) == next_project_path_key
        });

    if duplicate {
        return Err(BackendError::Validation(
            "A subproject with this folder already exists in the workspace.".to_string(),
        ));
    }

    Ok(())
}

fn insert_project_into_group(
    groups: &mut Vec<ProjectGroupDto>,
    group_id: Option<&str>,
    group_name: Option<&str>,
    project: ProjectDto,
) -> Result<()> {
    if let Some(group_id) = group_id {
        if let Some(group) = groups.iter_mut().find(|group| group.id == group_id) {
            group.projects.push(project);
            return Ok(());
        }
        return Err(BackendError::Validation(format!(
            "Unknown project group id: {}",
            group_id
        )));
    }

    let new_group_name = normalize_group_name(group_name, &project.name);

    groups.push(ProjectGroupDto {
        id: format!("group-{}", Utc::now().timestamp_millis()),
        name: new_group_name,
        is_open: true,
        projects: vec![project],
    });

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_project(id: &str, path: &str) -> ProjectDto {
        ProjectDto {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            created_at: "2026-03-14T00:00:00.000Z".to_string(),
            status: "active".to_string(),
            metadata: ProjectMetadataDto {
                description: String::new(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        }
    }

    #[test]
    fn sanitize_workspace_state_removes_duplicate_paths_and_dead_references() {
        let workspace_path = PathBuf::from("C:/workspace");
        let state = WorkspaceState {
            version: 1,
            project_groups: vec![
                ProjectGroupDto {
                    id: "group-main".to_string(),
                    name: "Main".to_string(),
                    is_open: true,
                    projects: vec![
                        make_project("project-web", "apps/web"),
                        make_project("project-api", "apps/api"),
                    ],
                },
                ProjectGroupDto {
                    id: "group-dup".to_string(),
                    name: "Duplicate".to_string(),
                    is_open: true,
                    projects: vec![make_project("project-web-dup", "apps\\web")],
                },
                ProjectGroupDto {
                    id: "session-group-1".to_string(),
                    name: "Session".to_string(),
                    is_open: true,
                    projects: vec![make_project("session-project-1", "apps/session")],
                },
            ],
            current_plan: Some(PlanDto {
                id: "plan-1".to_string(),
                description: "Plan".to_string(),
                created_at: "2026-03-14T00:00:00.000Z".to_string(),
                updated_at: "2026-03-14T00:00:00.000Z".to_string(),
                status: "Validated".to_string(),
                project_ids: vec![
                    "project-web".to_string(),
                    "project-web-dup".to_string(),
                    "session-project-1".to_string(),
                ],
                tasks: vec![
                    json!({
                        "id": "task-web",
                        "project_id": "project-web",
                        "project_ids": ["project-web", "project-web-dup"],
                        "execution_targets": [
                            { "projectId": "project-web", "branchName": "feature/web" },
                            { "projectId": "project-web-dup", "branchName": "feature/web" }
                        ]
                    }),
                    json!({
                        "id": "task-dead",
                        "project_id": "project-web-dup",
                        "project_ids": ["project-web-dup"]
                    }),
                ],
                predicted_git_trees: HashMap::new(),
            }),
            plan_nodes: vec![
                metadata::PlanNodeDto {
                    id: "node-web".to_string(),
                    title: "Web".to_string(),
                    description: None,
                    node_type: "task".to_string(),
                    status: "pending".to_string(),
                    dependencies: Vec::new(),
                    assigned_branch: None,
                    project_id: Some("project-web".to_string()),
                    estimated_time: None,
                },
                metadata::PlanNodeDto {
                    id: "node-dead".to_string(),
                    title: "Dead".to_string(),
                    description: None,
                    node_type: "task".to_string(),
                    status: "pending".to_string(),
                    dependencies: Vec::new(),
                    assigned_branch: None,
                    project_id: Some("project-web-dup".to_string()),
                    estimated_time: None,
                },
            ],
            predicted_branches: vec![
                metadata::PredictedBranchDto {
                    id: "branch-web".to_string(),
                    name: "feature/web".to_string(),
                    color: "#fff".to_string(),
                    parent_branch: None,
                    project_id: "project-web".to_string(),
                    task_ids: vec!["task-web".to_string()],
                    status: "pending".to_string(),
                },
                metadata::PredictedBranchDto {
                    id: "branch-dead".to_string(),
                    name: "feature/dead".to_string(),
                    color: "#fff".to_string(),
                    parent_branch: None,
                    project_id: "project-web-dup".to_string(),
                    task_ids: vec!["task-dead".to_string()],
                    status: "pending".to_string(),
                },
            ],
        };

        let (sanitized, report) = sanitize_workspace_state(&workspace_path, state);
        let plan = sanitized.current_plan.expect("plan should be present");

        assert_eq!(sanitized.project_groups.len(), 1);
        assert_eq!(sanitized.project_groups[0].projects.len(), 2);
        assert_eq!(report.duplicate_paths_removed, 1);
        assert_eq!(report.removed_synthetic_groups, 1);
        assert_eq!(report.current_plan_project_ids_removed, 2);
        assert_eq!(report.current_plan_tasks_removed, 1);
        assert_eq!(report.current_plan_task_targets_removed, 1);
        assert_eq!(report.plan_nodes_removed, 1);
        assert_eq!(report.predicted_branches_removed, 1);
        assert_eq!(plan.project_ids, vec!["project-web".to_string()]);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(
            plan.tasks[0].get("project_ids").and_then(|value| value.as_array()).map(Vec::len),
            Some(1)
        );
    }
}
