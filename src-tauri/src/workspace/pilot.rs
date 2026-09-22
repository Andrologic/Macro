use super::metadata::{
    direct_checkpoint_id, direct_checkpoint_task_segment, ManualFeatureDto, ProjectDto,
    WorkspaceState,
};
use crate::core::error::{BackendError, Result};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum WorkspacePilotManualTaskMutation {
    Rename {
        title: String,
    },
    Archive {
        reason: Option<String>,
        #[serde(rename = "mergedAt")]
        merged_at: Option<String>,
    },
    Delete {
        #[serde(rename = "draftOnly")]
        draft_only: bool,
    },
    BindCheckpoint {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
    },
}

const MANUAL_FEATURES_FIELD: &str = "manual_features";
const DELETED_MANUAL_FEATURE_IDS_FIELD: &str = "deletedManualFeatureIds";
const WORKSPACE_REVISION_FIELD: &str = "workspaceRevision";

pub async fn mutate_manual_task(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    mutation: WorkspacePilotManualTaskMutation,
) -> Result<Option<ManualFeatureDto>> {
    let _state_guard = super::lock_workspace_state(metadata_root).await;
    let _file_guard = super::lock_workspace_state_file(metadata_root)?;
    mutate_manual_task_sync(workspace_path, metadata_root, task_id, mutation)
}

pub(super) fn mutate_manual_task_sync(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    mutation: WorkspacePilotManualTaskMutation,
) -> Result<Option<ManualFeatureDto>> {
    let primary_path = super::workspace_state_path(metadata_root);
    let initial_bytes = std::fs::read(&primary_path).map_err(|error| BackendError::Filesystem {
        message: format!(
            "Failed to read the existing workspace state {}: {}",
            primary_path.display(),
            error
        ),
    })?;
    let (mut raw_state, state) = parse_primary_state(&primary_path, &initial_bytes)?;
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err(BackendError::Validation(
            "Manual task mutation requires a task id.".to_string(),
        ));
    }

    let feature_index = state
        .manual_features
        .iter()
        .position(|feature| feature.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })?;
    let mut changed = true;
    let returned_feature = match mutation {
        WorkspacePilotManualTaskMutation::Rename { title } => {
            let normalized_title = title.trim();
            if normalized_title.is_empty() {
                return Err(BackendError::Validation(
                    "Manual feature rename requires a title.".to_string(),
                ));
            }
            let feature = manual_feature_value_mut(&mut raw_state, feature_index)?;
            feature.insert(
                "title".to_string(),
                Value::String(normalized_title.to_string()),
            );
            feature.insert(
                "updatedAt".to_string(),
                Value::String(Utc::now().to_rfc3339()),
            );
            Some(parse_manual_feature(Value::Object(feature.clone()))?)
        }
        WorkspacePilotManualTaskMutation::Archive { reason, merged_at } => {
            let feature = manual_feature_value_mut(&mut raw_state, feature_index)?;
            let now = Utc::now().to_rfc3339();
            feature.insert("archivedAt".to_string(), Value::String(now.clone()));
            feature.insert(
                "archiveReason".to_string(),
                reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map_or(Value::Null, |value| Value::String(value.to_string())),
            );
            if let Some(merged_at) = merged_at
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                feature.insert("mergedAt".to_string(), Value::String(merged_at.to_string()));
            }
            feature.insert("updatedAt".to_string(), Value::String(now));
            Some(parse_manual_feature(Value::Object(feature.clone()))?)
        }
        WorkspacePilotManualTaskMutation::Delete { draft_only } => {
            let feature = &state.manual_features[feature_index];
            if feature.draft != draft_only {
                return Err(BackendError::Validation(format!(
                    "Manual feature draft state does not match delete mode for {}.",
                    normalized_task_id
                )));
            }
            let root = raw_state.as_object_mut().ok_or_else(|| {
                BackendError::Validation("Workspace state must be a JSON object.".to_string())
            })?;
            let features = root
                .get_mut(MANUAL_FEATURES_FIELD)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    BackendError::Validation(
                        "Workspace state manual_features must be an array.".to_string(),
                    )
                })?;
            features.remove(feature_index);
            let deleted_ids = root
                .entry(DELETED_MANUAL_FEATURE_IDS_FIELD.to_string())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| {
                    BackendError::Validation(
                        "Workspace state deletedManualFeatureIds must be an array.".to_string(),
                    )
                })?;
            if !deleted_ids
                .iter()
                .any(|candidate| candidate.as_str() == Some(normalized_task_id))
            {
                deleted_ids.push(Value::String(normalized_task_id.to_string()));
            }
            None
        }
        WorkspacePilotManualTaskMutation::BindCheckpoint {
            project_id,
            checkpoint_id,
        } => {
            let feature = state.manual_features[feature_index].clone();
            let normalized_project_id = project_id.trim();
            let normalized_checkpoint_id = checkpoint_id.trim();
            validate_direct_checkpoint_identity(
                workspace_path,
                &state,
                &feature,
                normalized_task_id,
                normalized_project_id,
                normalized_checkpoint_id,
            )?;

            let feature_value = manual_feature_value_mut(&mut raw_state, feature_index)?;
            let targets = feature_value
                .get_mut("executionTargets")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    BackendError::Validation(
                        "Direct checkpoint target does not belong to this task.".to_string(),
                    )
                })?;
            let target_index = targets
                .iter()
                .position(|target| {
                    target
                        .get("projectId")
                        .and_then(Value::as_str)
                        .map(|value| value == normalized_project_id)
                        .unwrap_or(false)
                })
                .ok_or_else(|| {
                    BackendError::Validation(
                        "Direct checkpoint target does not belong to this task.".to_string(),
                    )
                })?;
            let target = targets[target_index].as_object_mut().ok_or_else(|| {
                BackendError::Validation("Invalid direct checkpoint target.".to_string())
            })?;
            let existing_mode = target
                .get("executionMode")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(mode) = existing_mode.as_deref() {
                if mode != "direct" {
                    return Err(BackendError::Validation(
                        "Direct checkpoint target is not in direct mode.".to_string(),
                    ));
                }
            } else {
                target.insert(
                    "executionMode".to_string(),
                    Value::String("direct".to_string()),
                );
            }
            if let Some(existing) = target.get("checkpointId").and_then(Value::as_str) {
                if existing != normalized_checkpoint_id {
                    return Err(BackendError::Validation(
                        "Direct checkpoint identity is already bound to another value.".to_string(),
                    ));
                }
                if existing_mode.as_deref() == Some("direct") {
                    changed = false;
                }
            } else {
                target.insert(
                    "checkpointId".to_string(),
                    Value::String(normalized_checkpoint_id.to_string()),
                );
            }
            if changed {
                feature_value.insert(
                    "updatedAt".to_string(),
                    Value::String(Utc::now().to_rfc3339()),
                );
            }
            Some(parse_manual_feature(Value::Object(feature_value.clone()))?)
        }
    };

    if !changed {
        return Ok(returned_feature);
    }

    let root = raw_state.as_object_mut().ok_or_else(|| {
        BackendError::Validation("Workspace state must be a JSON object.".to_string())
    })?;
    root.insert(
        WORKSPACE_REVISION_FIELD.to_string(),
        json!(state.workspace_revision.saturating_add(1)),
    );
    let fresh_bytes = std::fs::read(&primary_path).map_err(|error| BackendError::Filesystem {
        message: format!(
            "Failed to re-read the existing workspace state {}: {}",
            primary_path.display(),
            error
        ),
    })?;
    if fresh_bytes != initial_bytes {
        return Err(BackendError::RevisionConflict {
            message: "The workspace state changed while the Pilot mutation was prepared."
                .to_string(),
        });
    }
    let serialized =
        serde_json::to_vec_pretty(&raw_state).map_err(|error| BackendError::Internal {
            message: format!("Failed to serialize Pilot workspace mutation: {error}"),
        })?;
    super::write_workspace_state_durably_sync(metadata_root, &serialized)?;
    Ok(returned_feature)
}

pub(crate) fn get_project_by_id_from_primary(
    metadata_root: &Path,
    project_id: &str,
) -> Result<Option<ProjectDto>> {
    let primary_path = super::workspace_state_path(metadata_root);
    let bytes = std::fs::read(&primary_path).map_err(|error| BackendError::Filesystem {
        message: format!(
            "Failed to read the existing workspace state {}: {}",
            primary_path.display(),
            error
        ),
    })?;
    let (_, state) = parse_primary_state(&primary_path, &bytes)?;
    Ok(super::find_project_by_id_in_state(&state, project_id).cloned())
}

pub(crate) fn parse_primary_state(path: &Path, bytes: &[u8]) -> Result<(Value, WorkspaceState)> {
    let raw_state: Value = serde_json::from_slice(bytes).map_err(|error| {
        BackendError::Validation(format!(
            "Invalid primary workspace state format in {}: {}",
            path.display(),
            error
        ))
    })?;
    if !raw_state.is_object() {
        return Err(BackendError::Validation(format!(
            "Invalid primary workspace state format in {}: expected a JSON object.",
            path.display()
        )));
    }
    let state: WorkspaceState = serde_json::from_value(raw_state.clone()).map_err(|error| {
        BackendError::Validation(format!(
            "Invalid primary workspace state format in {}: {}",
            path.display(),
            error
        ))
    })?;
    let mut task_ids = HashSet::with_capacity(state.manual_features.len());
    for feature in &state.manual_features {
        if !task_ids.insert(feature.id.clone()) {
            return Err(BackendError::Validation(format!(
                "Duplicate manual feature id in primary workspace state: {}",
                feature.id
            )));
        }
    }
    Ok((raw_state, state))
}

fn manual_feature_value_mut(
    raw_state: &mut Value,
    feature_index: usize,
) -> Result<&mut serde_json::Map<String, Value>> {
    raw_state
        .get_mut(MANUAL_FEATURES_FIELD)
        .and_then(Value::as_array_mut)
        .and_then(|features| features.get_mut(feature_index))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            BackendError::Validation(
                "Workspace state manual_features must contain valid objects.".to_string(),
            )
        })
}

fn parse_manual_feature(value: Value) -> Result<ManualFeatureDto> {
    serde_json::from_value(value).map_err(|error| {
        BackendError::Validation(format!("Invalid manual feature target: {error}"))
    })
}

fn validate_direct_checkpoint_identity(
    workspace_path: &Path,
    state: &WorkspaceState,
    feature: &ManualFeatureDto,
    task_id: &str,
    project_id: &str,
    checkpoint_id: &str,
) -> Result<()> {
    let (owner, hash) = checkpoint_id.rsplit_once('-').ok_or_else(|| {
        BackendError::Validation("Invalid direct checkpoint identifier.".to_string())
    })?;
    if owner != direct_checkpoint_task_segment(task_id)
        || hash.len() != 16
        || !hash.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(BackendError::Validation(
            "Invalid direct checkpoint identifier.".to_string(),
        ));
    }

    let project = super::find_project_by_id_in_state(state, project_id).ok_or_else(|| {
        BackendError::Validation(
            "Direct checkpoint binding requires an existing project.".to_string(),
        )
    })?;
    if !project.direct_edit || project.git_setup_state != super::PROJECT_GIT_SETUP_NOT_GIT {
        return Err(BackendError::Validation(
            "Direct checkpoint binding requires a confirmed non-Git direct project.".to_string(),
        ));
    }
    let project_path = super::resolve_project_path(workspace_path, &project.path);
    let stable_project_path = project_path
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct project path: {error}"),
            source: error,
        })?;
    if direct_checkpoint_id(task_id, &stable_project_path) != checkpoint_id {
        return Err(BackendError::Validation(
            "Direct checkpoint identity does not match this project.".to_string(),
        ));
    }
    let target = feature
        .execution_targets
        .iter()
        .find(|target| target.project_id == project_id)
        .ok_or_else(|| {
            BackendError::Validation(
                "Direct checkpoint target does not belong to this task.".to_string(),
            )
        })?;
    if let Some(mode) = target.execution_mode.as_deref() {
        if mode != "direct" {
            return Err(BackendError::Validation(
                "Direct checkpoint target is not in direct mode.".to_string(),
            ));
        }
    }
    if let Some(existing) = target.checkpoint_id.as_deref() {
        if existing != checkpoint_id {
            return Err(BackendError::Validation(
                "Direct checkpoint identity is already bound to another value.".to_string(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::metadata::WorkspaceTaskExecutionTargetDto;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn feature(id: &str, draft: bool, project_id: &str) -> ManualFeatureDto {
        ManualFeatureDto {
            id: id.to_string(),
            conversation_id: format!("conversation-{id}"),
            draft,
            title: format!("Title {id}"),
            description: "Description".to_string(),
            status: "Pending".to_string(),
            feature_slug: None,
            task_kind: Some("direct".to_string()),
            branch_name: Some("direct".to_string()),
            archived_at: None,
            archive_reason: None,
            merged_at: None,
            base_branch: "main".to_string(),
            project_ids: vec![project_id.to_string()],
            context_project_ids: Vec::new(),
            execution_targets: vec![WorkspaceTaskExecutionTargetDto {
                project_id: project_id.to_string(),
                branch_name: "direct".to_string(),
                target_branch_name: Some("main".to_string()),
                execution_mode: None,
                execution_kind: Some("repository_root".to_string()),
                checkpoint_id: None,
                base_commit_hash: None,
                worktree_key: format!("direct:{project_id}"),
                repo_path: None,
            }],
            merge_workflow: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn write_state(metadata_root: &Path, state: &WorkspaceState) -> Value {
        let value = serde_json::to_value(state).expect("serialize state");
        super::super::write_workspace_state_durably_sync(
            metadata_root,
            serde_json::to_string_pretty(&value)
                .expect("serialize raw state")
                .as_bytes(),
        )
        .expect("write state");
        value
    }

    #[test]
    fn primary_project_lookup_refuses_backup_recovery() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        let state = WorkspaceState {
            standalone_projects: vec![super::super::build_project(
                "Project A",
                "",
                Some("project-a"),
                temp.path(),
                None,
            )],
            ..WorkspaceState::default()
        };
        let raw = write_state(&metadata_root, &state);
        fs::write(
            super::super::workspace_state_backup_path(&metadata_root),
            serde_json::to_vec_pretty(&raw).expect("serialize backup"),
        )
        .expect("write backup");
        let backup =
            fs::read(super::super::workspace_state_backup_path(&metadata_root)).expect("backup");

        fs::remove_file(super::super::workspace_state_path(&metadata_root))
            .expect("remove primary");
        let error = get_project_by_id_from_primary(&metadata_root, "project-a")
            .expect_err("missing primary must fail");
        assert!(error.to_string().contains("existing workspace state"));
        assert!(!super::super::workspace_state_path(&metadata_root).exists());
        assert_eq!(
            fs::read(super::super::workspace_state_backup_path(&metadata_root)).unwrap(),
            backup
        );

        fs::write(
            super::super::workspace_state_path(&metadata_root),
            b"{corrupt",
        )
        .expect("corrupt primary");
        let error = get_project_by_id_from_primary(&metadata_root, "project-a")
            .expect_err("corrupt primary must fail");
        assert!(error.to_string().contains("Invalid primary"));
        assert_eq!(
            fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
            b"{corrupt"
        );
        assert_eq!(
            fs::read(super::super::workspace_state_backup_path(&metadata_root)).unwrap(),
            backup
        );
    }

    #[test]
    fn primary_project_lookup_returns_the_requested_project_without_rewriting_json() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        let mut project_a = super::super::build_project(
            "Project A",
            "projects/a",
            Some("project-a"),
            temp.path(),
            None,
        );
        project_a.id = "project-a".to_string();
        let mut project_b = super::super::build_project(
            "Project B",
            "projects/b",
            Some("project-b"),
            temp.path(),
            None,
        );
        project_b.id = "project-b".to_string();
        let state = WorkspaceState {
            standalone_projects: vec![project_a, project_b],
            ..WorkspaceState::default()
        };
        let before = write_state(&metadata_root, &state);
        let before_bytes = fs::read(super::super::workspace_state_path(&metadata_root)).unwrap();

        let project = get_project_by_id_from_primary(&metadata_root, "project-b")
            .expect("primary project lookup")
            .expect("project b");

        assert_eq!(project.id, "project-b");
        assert_eq!(project.name, "Project B");
        assert_eq!(
            fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
            before_bytes
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&before_bytes).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn rename_preserves_orphan_and_unknown_fields() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        let state = WorkspaceState {
            manual_features: vec![
                feature("task-target", false, "project-a"),
                feature("task-orphan", false, "project-a"),
            ],
            ..WorkspaceState::default()
        };
        let mut raw = write_state(&metadata_root, &state);
        raw["unknownRoot"] = json!({"kept": true});
        raw[MANUAL_FEATURES_FIELD][0]["unknownTask"] = json!("kept");
        raw[MANUAL_FEATURES_FIELD][1]["orphanField"] = json!([1, 2, 3]);
        super::super::write_workspace_state_durably_sync(
            &metadata_root,
            serde_json::to_string_pretty(&raw)
                .expect("serialize raw state")
                .as_bytes(),
        )
        .expect("rewrite state");
        let orphan = raw[MANUAL_FEATURES_FIELD][1].clone();

        mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-target",
            WorkspacePilotManualTaskMutation::Rename {
                title: "Renamed".to_string(),
            },
        )
        .await
        .expect("rename");

        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(super::super::workspace_state_path(&metadata_root))
                .expect("read state"),
        )
        .expect("parse state");
        assert_eq!(persisted["unknownRoot"], json!({"kept": true}));
        assert_eq!(persisted[MANUAL_FEATURES_FIELD][1], orphan);
        assert_eq!(persisted[MANUAL_FEATURES_FIELD][0]["title"], "Renamed");
        assert_eq!(persisted[MANUAL_FEATURES_FIELD][0]["unknownTask"], "kept");
    }

    #[tokio::test]
    async fn corrupt_primary_and_missing_primary_never_recover_from_backup() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        let state = WorkspaceState {
            manual_features: vec![feature("task-target", false, "project-a")],
            ..WorkspaceState::default()
        };
        let raw = write_state(&metadata_root, &state);
        super::super::write_workspace_state_durably_sync(
            &metadata_root,
            serde_json::to_vec(&raw)
                .expect("serialize backup seed")
                .as_slice(),
        )
        .expect("seed backup");
        let backup =
            fs::read(super::super::workspace_state_backup_path(&metadata_root)).expect("backup");
        fs::write(
            super::super::workspace_state_path(&metadata_root),
            b"{corrupt",
        )
        .expect("corrupt primary");
        let error = mutate_manual_task_sync(
            temp.path(),
            &metadata_root,
            "task-target",
            WorkspacePilotManualTaskMutation::Rename {
                title: "Renamed".to_string(),
            },
        )
        .expect_err("corrupt primary must fail");
        assert!(error.to_string().contains("Invalid primary"));
        assert_eq!(
            fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
            b"{corrupt"
        );
        assert_eq!(
            fs::read(super::super::workspace_state_backup_path(&metadata_root)).unwrap(),
            backup
        );

        fs::remove_file(super::super::workspace_state_path(&metadata_root))
            .expect("remove primary");
        fs::write(
            super::super::workspace_state_backup_path(&metadata_root),
            serde_json::to_vec(&raw).unwrap(),
        )
        .expect("restore backup");
        let error = mutate_manual_task_sync(
            temp.path(),
            &metadata_root,
            "task-target",
            WorkspacePilotManualTaskMutation::Rename {
                title: "Renamed".to_string(),
            },
        )
        .expect_err("missing primary must fail");
        assert!(error.to_string().contains("existing workspace state"));
        assert!(!super::super::workspace_state_path(&metadata_root).exists());
    }

    #[tokio::test]
    async fn archive_and_delete_only_change_the_selected_task() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        let state = WorkspaceState {
            manual_features: vec![
                feature("task-archive", false, "project-a"),
                feature("task-delete", true, "project-a"),
            ],
            ..WorkspaceState::default()
        };
        write_state(&metadata_root, &state);
        mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-archive",
            WorkspacePilotManualTaskMutation::Archive {
                reason: Some("done".to_string()),
                merged_at: None,
            },
        )
        .await
        .expect("archive");
        mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-delete",
            WorkspacePilotManualTaskMutation::Delete { draft_only: true },
        )
        .await
        .expect("delete");
        let persisted: WorkspaceState = serde_json::from_str(
            &fs::read_to_string(super::super::workspace_state_path(&metadata_root)).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted.manual_features.len(), 1);
        assert_eq!(persisted.manual_features[0].id, "task-archive");
        assert!(persisted.manual_features[0].archived_at.is_some());
        assert_eq!(persisted.deleted_manual_feature_ids, vec!["task-delete"]);

        let before = fs::read(super::super::workspace_state_path(&metadata_root)).unwrap();
        assert!(mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-archive",
            WorkspacePilotManualTaskMutation::Delete { draft_only: true },
        )
        .await
        .is_err());
        assert_eq!(
            fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
            before
        );
        mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-archive",
            WorkspacePilotManualTaskMutation::Delete { draft_only: false },
        )
        .await
        .expect("delete finalized task");
        let persisted: WorkspaceState = serde_json::from_slice(
            &fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
        )
        .unwrap();
        assert!(persisted.manual_features.is_empty());
        assert_eq!(
            persisted.deleted_manual_feature_ids,
            vec!["task-delete", "task-archive"]
        );
    }

    #[tokio::test]
    async fn bind_rejects_bad_owner_and_updates_only_the_linked_target() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project-a");
        let metadata_root = temp.path().join(".macro");
        fs::create_dir_all(&metadata_root).expect("metadata root");
        fs::create_dir_all(&project_path).expect("project path");
        let mut project =
            super::super::build_project("Project A", "", Some("project-a"), temp.path(), None);
        project.id = "project-a".to_string();
        project.direct_edit = true;
        project.git_setup_state = super::super::PROJECT_GIT_SETUP_NOT_GIT.to_string();
        let state = WorkspaceState {
            standalone_projects: vec![project],
            manual_features: vec![
                feature("task-target", false, "project-a"),
                feature("task-other", false, "project-a"),
            ],
            ..WorkspaceState::default()
        };
        write_state(&metadata_root, &state);
        let before = fs::read(super::super::workspace_state_path(&metadata_root)).unwrap();
        let bad = mutate_manual_task_sync(
            temp.path(),
            &metadata_root,
            "task-target",
            WorkspacePilotManualTaskMutation::BindCheckpoint {
                project_id: "project-a".to_string(),
                checkpoint_id: "wrong-owner-0123456789abcdef".to_string(),
            },
        )
        .expect_err("bad owner must fail");
        assert!(bad.to_string().contains("Invalid direct checkpoint"));
        assert_eq!(
            fs::read(super::super::workspace_state_path(&metadata_root)).unwrap(),
            before
        );

        let checkpoint = direct_checkpoint_id("task-target", &project_path.canonicalize().unwrap());
        mutate_manual_task(
            temp.path(),
            &metadata_root,
            "task-target",
            WorkspacePilotManualTaskMutation::BindCheckpoint {
                project_id: "project-a".to_string(),
                checkpoint_id: checkpoint,
            },
        )
        .await
        .expect("bind");
        let persisted: WorkspaceState = serde_json::from_str(
            &fs::read_to_string(super::super::workspace_state_path(&metadata_root)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            persisted.manual_features[0].execution_targets[0]
                .execution_mode
                .as_deref(),
            Some("direct")
        );
        assert!(persisted.manual_features[0].execution_targets[0]
            .checkpoint_id
            .is_some());
        assert_eq!(
            persisted.manual_features[1].execution_targets[0].execution_mode,
            None
        );
        assert_eq!(
            persisted.manual_features[1].execution_targets[0].checkpoint_id,
            None
        );
    }
}
