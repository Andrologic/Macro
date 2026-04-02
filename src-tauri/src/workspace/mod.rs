pub mod metadata;

use crate::core::error::{BackendError, Result};
use chrono::Utc;
use metadata::{
    CreateProjectRequest, ImportGitRepoRequest, ManualFeatureDto, PlanDto, ProjectDto,
    ProjectGitFlowSettingsDto, ProjectGroupDto, ProjectMetadataDto, ProjectRegistryDiagnosticsDto,
    ProjectRegistryRepairReportDto, WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceState,
    WorkspaceTaskCatalogDto, WorkspaceTaskExecutionTargetDto, WorkspaceTaskPlanSummaryDto,
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
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<ProjectRegistryDiagnosticsDto> {
    let raw_state = load_raw_state(metadata_root).await?.unwrap_or_default();
    let (sanitized_state, repair_report) =
        sanitize_workspace_state(workspace_path, raw_state.clone());

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
    workspace_path: &Path,
    metadata_root: &Path,
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
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<Vec<ProjectGroupDto>> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    Ok(state.project_groups)
}

pub async fn list_tasks(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<WorkspaceTaskCatalogDto> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    let manual_tasks = state
        .manual_features
        .iter()
        .map(manual_feature_to_task_value)
        .collect::<Vec<_>>();
    let Some(plan) = state.current_plan else {
        return Ok(WorkspaceTaskCatalogDto {
            tasks: manual_tasks.clone(),
            plans: Vec::new(),
            has_standalone_tasks: !manual_tasks.is_empty(),
            source: if manual_tasks.is_empty() {
                "empty".to_string()
            } else {
                "fallback".to_string()
            },
        });
    };

    let fallback_tasks = merge_task_lists(plan.tasks.clone(), manual_tasks);
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

    let has_standalone_tasks =
        !state.manual_features.is_empty() || (!is_executable_plan && task_count > 0);
    let source = if is_executable_plan && has_standalone_tasks {
        "mixed".to_string()
    } else if is_executable_plan {
        "architect".to_string()
    } else if has_standalone_tasks {
        "fallback".to_string()
    } else {
        "empty".to_string()
    };

    Ok(WorkspaceTaskCatalogDto {
        tasks: fallback_tasks,
        plans,
        has_standalone_tasks,
        source,
    })
}

pub async fn get_metadata(
    workspace_path: &Path,
    metadata_root: &Path,
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

#[allow(clippy::too_many_arguments)]
pub async fn create_manual_feature_draft(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    conversation_id: &str,
    project_ids: &[String],
    base_branch: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let valid_project_ids = collect_valid_project_ids(&state.project_groups);
    let normalized_project_ids = sanitize_project_id_list(project_ids, &valid_project_ids);
    if normalized_project_ids.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature draft requires at least one valid project".to_string(),
        ));
    }

    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature draft requires a task id".to_string(),
        ));
    }
    if state
        .manual_features
        .iter()
        .any(|feature| feature.id == normalized_task_id)
    {
        return Err(BackendError::Validation(format!(
            "Manual feature {} already exists",
            normalized_task_id
        )));
    }

    let normalized_conversation_id = conversation_id.trim();
    if normalized_conversation_id.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature draft requires a conversation id".to_string(),
        ));
    }

    let now = Utc::now().to_rfc3339();
    let feature = ManualFeatureDto {
        id: normalized_task_id.to_string(),
        conversation_id: normalized_conversation_id.to_string(),
        draft: true,
        title: title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("New feature")
            .to_string(),
        description: description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string(),
        status: "Pending".to_string(),
        feature_slug: None,
        branch_name: None,
        archived_at: None,
        archive_reason: None,
        merged_at: None,
        base_branch: normalize_base_branch(base_branch),
        project_ids: normalized_project_ids,
        execution_targets: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };

    state.manual_features.insert(0, feature.clone());
    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "create_manual_feature_draft",
    )
    .await?;

    sanitized_state
        .manual_features
        .iter()
        .find(|candidate| candidate.id == feature.id)
        .cloned()
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", feature.id))
        })
}

pub async fn finalize_manual_feature(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    conversation_id: Option<&str>,
    title: &str,
    description: &str,
    feature_slug: &str,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let project_groups = state.project_groups.clone();
    let feature = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == task_id.trim())
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", task_id))
        })?;

    let normalized_title = title.trim();
    let normalized_description = description.trim();
    let normalized_feature_slug = slugify(feature_slug);
    if normalized_title.is_empty()
        || normalized_description.is_empty()
        || normalized_feature_slug.is_empty()
    {
        return Err(BackendError::Validation(
            "Manual feature finalization requires title, description and feature slug".to_string(),
        ));
    }

    if let Some(next_conversation_id) = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        feature.conversation_id = next_conversation_id.to_string();
    }

    let execution_targets = build_manual_feature_execution_targets(
        &feature.project_ids,
        &normalized_feature_slug,
        &project_groups,
    );
    let branch_name = execution_targets
        .first()
        .map(|target| target.branch_name.clone())
        .unwrap_or_else(|| render_standalone_feature_branch_name(None, &normalized_feature_slug));
    let base_branch = execution_targets
        .first()
        .and_then(|target| target.target_branch_name.clone())
        .unwrap_or_else(|| feature.base_branch.clone());
    feature.draft = false;
    feature.title = normalized_title.to_string();
    feature.description = normalized_description.to_string();
    feature.feature_slug = Some(normalized_feature_slug);
    feature.branch_name = Some(branch_name.clone());
    feature.archived_at = None;
    feature.archive_reason = None;
    feature.merged_at = None;
    feature.base_branch = base_branch;
    feature.execution_targets = execution_targets;
    feature.updated_at = Utc::now().to_rfc3339();

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "finalize_manual_feature",
    )
    .await?;

    sanitized_state
        .manual_features
        .iter()
        .find(|candidate| candidate.id == task_id.trim())
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown manual feature id: {}", task_id)))
}

pub async fn delete_manual_feature_draft(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
) -> Result<()> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let initial_len = state.manual_features.len();
    state
        .manual_features
        .retain(|feature| !(feature.id == task_id.trim() && feature.draft));
    if state.manual_features.len() == initial_len {
        return Err(BackendError::Validation(format!(
            "Unknown manual feature draft: {}",
            task_id
        )));
    }

    persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "delete_manual_feature_draft",
    )
    .await?;
    Ok(())
}

pub async fn rename_manual_feature(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    title: &str,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    let normalized_title = title.trim();
    if normalized_task_id.is_empty() || normalized_title.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature rename requires a task id and title".to_string(),
        ));
    }

    let feature = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })?;

    feature.title = normalized_title.to_string();
    feature.updated_at = Utc::now().to_rfc3339();

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "rename_manual_feature",
    )
    .await?;

    sanitized_state
        .manual_features
        .iter()
        .find(|candidate| candidate.id == normalized_task_id)
        .cloned()
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })
}

pub async fn archive_manual_feature(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    reason: Option<&str>,
    merged_at: Option<&str>,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature archive requires a task id".to_string(),
        ));
    }

    let feature = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })?;

    let now = Utc::now().to_rfc3339();
    feature.archived_at = Some(now.clone());
    feature.archive_reason = reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(next_merged_at) = merged_at.map(str::trim).filter(|value| !value.is_empty()) {
        feature.merged_at = Some(next_merged_at.to_string());
    }
    feature.updated_at = now;

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "archive_manual_feature",
    )
    .await?;

    sanitized_state
        .manual_features
        .iter()
        .find(|candidate| candidate.id == normalized_task_id)
        .cloned()
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })
}

pub async fn restore_manual_feature(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err(BackendError::Validation(
            "Manual feature restore requires a task id".to_string(),
        ));
    }

    let feature = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })?;

    feature.archived_at = None;
    feature.archive_reason = None;
    if !feature.draft {
        feature.status = "Pending".to_string();
    }
    feature.updated_at = Utc::now().to_rfc3339();

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "restore_manual_feature",
    )
    .await?;

    sanitized_state
        .manual_features
        .iter()
        .find(|candidate| candidate.id == normalized_task_id)
        .cloned()
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })
}

pub async fn delete_manual_feature(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
) -> Result<()> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let initial_len = state.manual_features.len();
    let normalized_task_id = task_id.trim();
    state
        .manual_features
        .retain(|feature| feature.id != normalized_task_id);
    if state.manual_features.len() == initial_len {
        return Err(BackendError::Validation(format!(
            "Unknown manual feature: {}",
            normalized_task_id
        )));
    }

    persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "delete_manual_feature",
    )
    .await?;
    Ok(())
}

pub async fn update_standalone_task_status(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    status: &str,
) -> Result<()> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    let normalized_status = status.trim();
    if normalized_task_id.is_empty() || normalized_status.is_empty() {
        return Err(BackendError::Validation(
            "Task status update requires a task id and status".to_string(),
        ));
    }

    if let Some(feature) = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == normalized_task_id)
    {
        feature.status = normalized_status.to_string();
        feature.updated_at = Utc::now().to_rfc3339();
        persist_sanitized_state(
            workspace_path,
            metadata_root,
            state,
            "update_manual_feature_status",
        )
        .await?;
        return Ok(());
    }

    let Some(plan) = state.current_plan.as_mut() else {
        return Err(BackendError::Validation(format!(
            "Unknown standalone task id: {}",
            normalized_task_id
        )));
    };

    let mut updated = false;
    for task in plan.tasks.iter_mut() {
        let Some(task_object) = task.as_object_mut() else {
            continue;
        };
        if task_object
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == normalized_task_id)
            .unwrap_or(false)
        {
            task_object.insert(
                "status".to_string(),
                Value::String(normalized_status.to_string()),
            );
            updated = true;
            break;
        }
    }

    if !updated {
        return Err(BackendError::Validation(format!(
            "Unknown standalone task id: {}",
            normalized_task_id
        )));
    }

    plan.updated_at = Utc::now().to_rfc3339();
    persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "update_standalone_task_status",
    )
    .await?;
    Ok(())
}

pub async fn create_project(
    workspace_path: &Path,
    metadata_root: &Path,
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
        request.git_flow_settings.as_ref(),
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
    let persisted_project = find_project_by_id(&sanitized_state.project_groups, &project.id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project.id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "create_project",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(persisted_project)
}

pub async fn import_git_repo(
    workspace_path: &Path,
    metadata_root: &Path,
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
        request.git_flow_settings.as_ref(),
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
    let persisted_project = find_project_by_id(&sanitized_state.project_groups, &project.id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project.id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "import_git_repo",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(persisted_project)
}

pub async fn rename_project_group(
    workspace_path: &Path,
    metadata_root: &Path,
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
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;
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
    workspace_path: &Path,
    metadata_root: &Path,
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

pub async fn update_project_git_flow(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    git_flow_settings: &ProjectGitFlowSettingsDto,
) -> Result<ProjectDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "update_project_git_flow",
        project_id = %project_id
    );
    let mut updated_project: Option<ProjectDto> = None;

    for group in state.project_groups.iter_mut() {
        if let Some(project) = group
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.git_flow_settings =
                normalize_project_git_flow_settings(Some(git_flow_settings));
            updated_project = Some(project.clone());
            break;
        }
    }

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, repair_report) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "update_project_git_flow",
    )
    .await?;
    let updated_project = sanitized_state
        .project_groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "update_project_git_flow",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_projects(&sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(updated_project)
}

pub async fn archive_project_group(
    workspace_path: &Path,
    metadata_root: &Path,
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

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "archive_project_group",
    )
    .await?;
    let updated_group = sanitized_state
        .project_groups
        .iter()
        .find(|group| group.id == group_id)
        .cloned()
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;
    Ok(updated_group)
}

pub async fn archive_project(
    workspace_path: &Path,
    metadata_root: &Path,
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
    workspace_path: &Path,
    metadata_root: &Path,
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
        plan.project_ids.retain(|id| {
            !removed_project_ids
                .iter()
                .any(|project_id| project_id == id)
        });
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
    workspace_path: &Path,
    metadata_root: &Path,
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
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    close_project(workspace_path, metadata_root, project_id).await
}

fn merge_task_lists(mut legacy_tasks: Vec<Value>, manual_tasks: Vec<Value>) -> Vec<Value> {
    let mut merged = manual_tasks;
    merged.append(&mut legacy_tasks);
    merged
}

fn collect_valid_project_ids(groups: &[ProjectGroupDto]) -> HashSet<String> {
    groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .map(|project| project.id.clone())
        .collect()
}

fn sanitize_project_id_list(
    project_ids: &[String],
    valid_project_ids: &HashSet<String>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    project_ids
        .iter()
        .map(|project_id| project_id.trim().to_string())
        .filter(|project_id| !project_id.is_empty())
        .filter(|project_id| valid_project_ids.contains(project_id))
        .filter(|project_id| seen.insert(project_id.clone()))
        .collect()
}

fn normalize_base_branch(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .unwrap_or("develop")
        .to_string()
}

fn replace_template_tokens(template: &str, replacements: &[(&str, &str)]) -> String {
    replacements
        .iter()
        .fold(template.to_string(), |output, (token, value)| {
            output.replace(&format!("{{{}}}", token), value)
        })
}

fn normalized_project_id(project_id: &str) -> String {
    let normalized = project_id
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if normalized.is_empty() {
        "project".to_string()
    } else {
        normalized.chars().take(16).collect()
    }
}

fn stable_hash(value: &str) -> String {
    let mut hash: u32 = 2166136261;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{:08x}", hash)
}

fn to_branch_worktree_key(project_id: &str, branch_name: &str) -> String {
    let normalized_branch = branch_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(32)
        .collect::<String>();
    let branch_component = if normalized_branch.is_empty() {
        "work".to_string()
    } else {
        normalized_branch
    };
    format!(
        "branch-{}-{}-{}",
        normalized_project_id(project_id),
        branch_component,
        stable_hash(&format!("{}:{}", project_id, branch_name))
    )
}

fn build_manual_feature_execution_targets(
    project_ids: &[String],
    feature_slug: &str,
    project_groups: &[ProjectGroupDto],
) -> Vec<WorkspaceTaskExecutionTargetDto> {
    project_ids
        .iter()
        .map(|project_id| {
            let project = find_project_by_id(project_groups, project_id);
            let branch_name = render_standalone_feature_branch_name(
                project.map(|project| &project.git_flow_settings),
                feature_slug,
            );
            WorkspaceTaskExecutionTargetDto {
                project_id: project_id.clone(),
                branch_name: branch_name.clone(),
                target_branch_name: project
                    .map(|project| project.git_flow_settings.base_branch.clone()),
                worktree_key: to_branch_worktree_key(project_id, &branch_name),
                repo_path: project.map(|project| project.path.clone()),
            }
        })
        .collect()
}

fn manual_feature_to_task_value(feature: &ManualFeatureDto) -> Value {
    let project_id = feature
        .project_ids
        .first()
        .cloned()
        .or_else(|| {
            feature
                .execution_targets
                .first()
                .map(|target| target.project_id.clone())
        })
        .unwrap_or_default();

    let mut task = serde_json::Map::new();
    task.insert("id".to_string(), Value::String(feature.id.clone()));
    task.insert(
        "plan_id".to_string(),
        Value::String(format!("manual:{}", feature.id)),
    );
    task.insert("project_id".to_string(), Value::String(project_id));
    task.insert(
        "project_ids".to_string(),
        Value::Array(
            feature
                .project_ids
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    task.insert("title".to_string(), Value::String(feature.title.clone()));
    task.insert(
        "description".to_string(),
        Value::String(feature.description.clone()),
    );
    task.insert("status".to_string(), Value::String(feature.status.clone()));
    task.insert("dependencies".to_string(), Value::Array(Vec::new()));
    task.insert("estimated_changes".to_string(), Value::Array(Vec::new()));
    task.insert("draft".to_string(), Value::Bool(feature.draft));
    task.insert(
        "standalone_kind".to_string(),
        Value::String("manual_feature".to_string()),
    );
    task.insert(
        "base_branch".to_string(),
        Value::String(feature.base_branch.clone()),
    );
    task.insert(
        "conversation_id".to_string(),
        Value::String(feature.conversation_id.clone()),
    );
    if let Some(archived_at) = feature.archived_at.as_ref() {
        task.insert(
            "archived_at".to_string(),
            Value::String(archived_at.clone()),
        );
    }
    if let Some(archive_reason) = feature.archive_reason.as_ref() {
        task.insert(
            "archive_reason".to_string(),
            Value::String(archive_reason.clone()),
        );
    }
    if let Some(merged_at) = feature.merged_at.as_ref() {
        task.insert("merged_at".to_string(), Value::String(merged_at.clone()));
    }

    if let Some(feature_slug) = feature.feature_slug.as_ref() {
        task.insert(
            "feature_slug".to_string(),
            Value::String(feature_slug.clone()),
        );
    }
    if let Some(branch_name) = feature.branch_name.as_ref() {
        task.insert(
            "assigned_branch".to_string(),
            Value::String(branch_name.clone()),
        );
        task.insert(
            "branch_name".to_string(),
            Value::String(branch_name.clone()),
        );
    }
    if !feature.execution_targets.is_empty() {
        task.insert(
            "execution_targets".to_string(),
            Value::Array(
                feature
                    .execution_targets
                    .iter()
                    .map(|target| {
                        let mut value = serde_json::Map::new();
                        value.insert(
                            "projectId".to_string(),
                            Value::String(target.project_id.clone()),
                        );
                        value.insert(
                            "branchName".to_string(),
                            Value::String(target.branch_name.clone()),
                        );
                        value.insert(
                            "worktreeKey".to_string(),
                            Value::String(target.worktree_key.clone()),
                        );
                        if let Some(target_branch_name) = target.target_branch_name.as_ref() {
                            value.insert(
                                "targetBranchName".to_string(),
                                Value::String(target_branch_name.clone()),
                            );
                        }
                        if let Some(repo_path) = target.repo_path.as_ref() {
                            value.insert("repoPath".to_string(), Value::String(repo_path.clone()));
                        }
                        Value::Object(value)
                    })
                    .collect(),
            ),
        );
    }

    Value::Object(task)
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
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<WorkspaceState> {
    if let Some(state) = load_state(workspace_path, metadata_root).await? {
        return Ok(state);
    }

    let state = WorkspaceState::default();
    persist_state(metadata_root, &state).await?;
    Ok(state)
}

async fn load_or_default_state(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<WorkspaceState> {
    if let Some(state) = load_state(workspace_path, metadata_root).await? {
        return Ok(state);
    }

    Ok(WorkspaceState::default())
}

async fn load_state(workspace_path: &Path, metadata_root: &Path) -> Result<Option<WorkspaceState>> {
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
            mount_names_assigned = repair_report.mount_names_assigned,
            removed_group_ids = ?repair_report.removed_group_ids,
            removed_project_ids = ?repair_report.removed_project_ids,
            current_plan_project_ids_removed = repair_report.current_plan_project_ids_removed,
            current_plan_tasks_removed = repair_report.current_plan_tasks_removed,
            current_plan_task_targets_removed = repair_report.current_plan_task_targets_removed,
            manual_features_removed = repair_report.manual_features_removed,
            manual_feature_targets_removed = repair_report.manual_feature_targets_removed,
            plan_nodes_removed = repair_report.plan_nodes_removed,
            predicted_branches_removed = repair_report.predicted_branches_removed
        );
        persist_state(metadata_root, &sanitized_state).await?;
    }

    Ok(Some(sanitized_state))
}

async fn load_raw_state(metadata_root: &Path) -> Result<Option<WorkspaceState>> {
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
    workspace_path: &Path,
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
            sanitized_projects.push(ProjectDto {
                git_flow_settings: normalize_project_git_flow_settings(Some(
                    &project.git_flow_settings,
                )),
                ..project
            });
        }

        if sanitized_projects.is_empty() {
            repair_report.empty_groups_removed += 1;
            repair_report.removed_group_ids.push(group.id);
            continue;
        }

        repair_report.mount_names_assigned += assign_group_mount_names(&mut sanitized_projects);

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
        plan.project_ids
            .retain(|project_id| valid_project_ids.contains(project_id));
        let mut unique_project_ids = HashSet::new();
        plan.project_ids
            .retain(|project_id| unique_project_ids.insert(project_id.clone()));
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

    let initial_manual_feature_count = state.manual_features.len();
    let (sanitized_manual_features, removed_manual_feature_targets) =
        sanitize_manual_features(&state.manual_features, &valid_project_ids);
    state.manual_features = sanitized_manual_features;
    repair_report.manual_features_removed =
        initial_manual_feature_count.saturating_sub(state.manual_features.len());
    repair_report.manual_feature_targets_removed = removed_manual_feature_targets;

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
    state
        .predicted_branches
        .retain(|branch| valid_project_ids.contains(&branch.project_id));
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

fn sanitize_manual_features(
    features: &[ManualFeatureDto],
    valid_project_ids: &HashSet<String>,
) -> (Vec<ManualFeatureDto>, usize) {
    let mut removed_targets = 0usize;
    let mut sanitized_features = Vec::with_capacity(features.len());

    for feature in features {
        let project_ids = sanitize_project_id_list(&feature.project_ids, valid_project_ids);
        let initial_target_len = feature.execution_targets.len();
        let execution_targets = feature
            .execution_targets
            .iter()
            .filter(|target| valid_project_ids.contains(&target.project_id))
            .cloned()
            .collect::<Vec<_>>();
        removed_targets += initial_target_len.saturating_sub(execution_targets.len());

        let fallback_project_ids = if !project_ids.is_empty() {
            project_ids.clone()
        } else {
            execution_targets
                .iter()
                .map(|target| target.project_id.clone())
                .collect::<Vec<_>>()
        };

        if fallback_project_ids.is_empty() {
            continue;
        }

        sanitized_features.push(ManualFeatureDto {
            project_ids: fallback_project_ids,
            execution_targets,
            ..feature.clone()
        });
    }

    (sanitized_features, removed_targets)
}

async fn persist_sanitized_state(
    workspace_path: &Path,
    metadata_root: &Path,
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
            mount_names_assigned = repair_report.mount_names_assigned,
            removed_group_ids = ?repair_report.removed_group_ids,
            removed_project_ids = ?repair_report.removed_project_ids,
            current_plan_project_ids_removed = repair_report.current_plan_project_ids_removed,
            current_plan_tasks_removed = repair_report.current_plan_tasks_removed,
            current_plan_task_targets_removed = repair_report.current_plan_task_targets_removed,
            manual_features_removed = repair_report.manual_features_removed,
            manual_feature_targets_removed = repair_report.manual_feature_targets_removed,
            plan_nodes_removed = repair_report.plan_nodes_removed,
            predicted_branches_removed = repair_report.predicted_branches_removed
        );
    }

    persist_state(metadata_root, &sanitized_state).await?;
    Ok((sanitized_state, repair_report))
}

async fn persist_state(workspace_path: &Path, state: &WorkspaceState) -> Result<()> {
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
    workspace_path: &Path,
    git_flow_settings: Option<&ProjectGitFlowSettingsDto>,
) -> ProjectDto {
    let now = Utc::now().to_rfc3339();
    let slug = slugify(name);
    let id = format!("project-{}-{}", slug, Utc::now().timestamp_millis());
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
        id: id.clone(),
        name: normalized_name,
        mount_name: derive_project_mount_name(&project_path, name, &id),
        path: project_path,
        created_at: now,
        status: "active".to_string(),
        git_flow_settings: normalize_project_git_flow_settings(git_flow_settings),
        metadata: ProjectMetadataDto {
            description: description.to_string(),
            tags: Vec::new(),
            team_members: Vec::new(),
            api_contracts: Vec::new(),
            dependencies: Vec::new(),
        },
    }
}

fn normalize_project_git_flow_settings(
    settings: Option<&ProjectGitFlowSettingsDto>,
) -> ProjectGitFlowSettingsDto {
    let defaults = ProjectGitFlowSettingsDto::default();
    let input = settings.cloned().unwrap_or_default();

    ProjectGitFlowSettingsDto {
        base_branch: normalize_base_branch(Some(input.base_branch.as_str())),
        main_branch: normalize_base_branch(Some(input.main_branch.as_str())),
        plan_branch_template: normalize_branch_template(
            Some(input.plan_branch_template.as_str()),
            defaults.plan_branch_template.as_str(),
        ),
        feature_branch_template: normalize_branch_template(
            Some(input.feature_branch_template.as_str()),
            defaults.feature_branch_template.as_str(),
        ),
        standalone_feature_branch_template: normalize_branch_template(
            Some(input.standalone_feature_branch_template.as_str()),
            defaults.standalone_feature_branch_template.as_str(),
        ),
        release_branch_template: normalize_branch_template(
            Some(input.release_branch_template.as_str()),
            defaults.release_branch_template.as_str(),
        ),
        hotfix_branch_template: normalize_branch_template(
            Some(input.hotfix_branch_template.as_str()),
            defaults.hotfix_branch_template.as_str(),
        ),
        bugfix_branch_template: normalize_branch_template(
            Some(input.bugfix_branch_template.as_str()),
            defaults.bugfix_branch_template.as_str(),
        ),
    }
}

fn normalize_branch_template(value: Option<&str>, fallback: &str) -> String {
    value
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(|branch| branch.replace('\\', "/"))
        .map(|branch| branch.trim_start_matches("refs/heads/").to_string())
        .map(|branch| branch.trim_matches('/').to_string())
        .unwrap_or_else(|| fallback.to_string())
}

fn render_standalone_feature_branch_name(
    settings: Option<&ProjectGitFlowSettingsDto>,
    feature_slug: &str,
) -> String {
    let normalized_settings = normalize_project_git_flow_settings(settings);
    let rendered = replace_template_tokens(
        &normalized_settings.standalone_feature_branch_template,
        &[("featureSlug", feature_slug)],
    );
    normalize_branch_template(
        Some(rendered.as_str()),
        &format!("feature/{}", feature_slug),
    )
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

    if normalize_group_name(group_name, fallback_name)
        .trim()
        .is_empty()
    {
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
                group
                    .projects
                    .iter()
                    .find(|project| project.name.trim().eq_ignore_ascii_case(trimmed_name))
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

fn normalized_path_key(path: &Path) -> String {
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
    workspace_path: &Path,
    project_path: &Path,
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

fn resolve_project_path(workspace_path: &Path, project_path: &str) -> PathBuf {
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

fn slugify_mount_name(input: &str) -> String {
    let slug = slugify(input);
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

fn get_project_path_basename(project_path: &str) -> Option<String> {
    let trimmed = project_path.trim().replace('\\', "/");
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    trimmed
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .map(str::to_string)
}

fn derive_project_mount_name(project_path: &str, project_name: &str, project_id: &str) -> String {
    if let Some(base_name) = get_project_path_basename(project_path) {
        let slug = slugify_mount_name(&base_name);
        if !slug.is_empty() {
            return slug;
        }
    }

    let name_slug = slugify_mount_name(project_name);
    if !name_slug.is_empty() {
        return name_slug;
    }

    slugify_mount_name(project_id)
}

fn normalize_project_mount_name(project: &ProjectDto) -> String {
    let explicit = project.mount_name.trim();
    if !explicit.is_empty() {
        return slugify_mount_name(explicit);
    }

    derive_project_mount_name(&project.path, &project.name, &project.id)
}

fn assign_group_mount_names(projects: &mut [ProjectDto]) -> usize {
    let mut used_mounts = HashSet::new();
    let mut assigned = 0usize;

    for project in projects.iter_mut() {
        let base = normalize_project_mount_name(project);
        let mut next_mount = base.clone();
        let mut suffix = 2usize;

        while used_mounts.contains(&next_mount) {
            next_mount = format!("{}-{}", base, suffix);
            suffix += 1;
        }

        if project.mount_name != next_mount {
            project.mount_name = next_mount.clone();
            assigned += 1;
        }

        used_mounts.insert(next_mount);
    }

    assigned
}

fn find_project_by_id<'a>(
    groups: &'a [ProjectGroupDto],
    project_id: &str,
) -> Option<&'a ProjectDto> {
    groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
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
            mount_name: String::new(),
            path: path.to_string(),
            git_flow_settings: ProjectGitFlowSettingsDto {
                base_branch: "develop".to_string(),
                main_branch: "main".to_string(),
                plan_branch_template: "plan/{planSlug}".to_string(),
                feature_branch_template: "feature/{planSlug}/{featureSlug}".to_string(),
                standalone_feature_branch_template: "feature/{featureSlug}".to_string(),
                release_branch_template: "release/{releaseSlug}".to_string(),
                hotfix_branch_template: "hotfix/{hotfixSlug}".to_string(),
                bugfix_branch_template: "bugfix/{bugfixSlug}".to_string(),
            },
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
    fn manual_feature_targets_use_project_standalone_templates() {
        let mut web = make_project("project-web", "apps/web");
        web.git_flow_settings.base_branch = "main".to_string();
        web.git_flow_settings.standalone_feature_branch_template =
            "feature/{featureSlug}".to_string();

        let mut api = make_project("project-api", "apps/api");
        api.git_flow_settings.base_branch = "develop".to_string();
        api.git_flow_settings.standalone_feature_branch_template = "work/{featureSlug}".to_string();

        let project_groups = vec![ProjectGroupDto {
            id: "group-main".to_string(),
            name: "Main".to_string(),
            is_open: true,
            projects: vec![web, api],
        }];

        let targets = build_manual_feature_execution_targets(
            &["project-web".to_string(), "project-api".to_string()],
            "quick-export",
            &project_groups,
        );

        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].project_id, "project-web");
        assert_eq!(targets[0].branch_name, "feature/quick-export");
        assert_eq!(targets[0].target_branch_name.as_deref(), Some("main"));
        assert_eq!(targets[1].project_id, "project-api");
        assert_eq!(targets[1].branch_name, "work/quick-export");
        assert_eq!(targets[1].target_branch_name.as_deref(), Some("develop"));
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
            manual_features: Vec::new(),
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
        assert_eq!(report.mount_names_assigned, 2);
        assert_eq!(plan.project_ids, vec!["project-web".to_string()]);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(
            plan.tasks[0]
                .get("project_ids")
                .and_then(|value| value.as_array())
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(sanitized.project_groups[0].projects[0].mount_name, "web");
        assert_eq!(sanitized.project_groups[0].projects[1].mount_name, "api");
    }

    #[test]
    fn sanitize_workspace_state_assigns_unique_mount_names_per_group() {
        let workspace_path = PathBuf::from("C:/workspace");
        let state = WorkspaceState {
            version: 1,
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![
                    ProjectDto {
                        mount_name: "app".to_string(),
                        ..make_project("project-app-1", "apps/app")
                    },
                    ProjectDto {
                        mount_name: "app".to_string(),
                        ..make_project("project-app-2", "packages/app")
                    },
                ],
            }],
            current_plan: None,
            plan_nodes: Vec::new(),
            predicted_branches: Vec::new(),
            manual_features: Vec::new(),
        };

        let (sanitized, report) = sanitize_workspace_state(&workspace_path, state);

        assert_eq!(report.mount_names_assigned, 1);
        assert_eq!(sanitized.project_groups[0].projects[0].mount_name, "app");
        assert_eq!(sanitized.project_groups[0].projects[1].mount_name, "app-2");
    }
}
