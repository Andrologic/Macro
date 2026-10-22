//! Historical links resolve actual current Tasks and native execution targets.
use crate::db::agsdl_execution::{self as repository, dto::*, Result};
use crate::workspace::metadata::{WorkspaceState, WorkspaceTaskExecutionTargetDto};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveCardTask {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicTaskTarget {
    pub project_id: String,
    pub branch_name: String,
    pub execution_mode: Option<String>,
    pub execution_kind: Option<String>,
    pub worktree_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedCardTask {
    pub task_id: String,
    pub project_id: String,
    pub plan_id: String,
    pub branch: String,
    pub execution_target: PublicTaskTarget,
}

fn task_identity(id: &str, owner: &EngineSourceOwner) -> Option<String> {
    let parts = id.strip_prefix("task:v1:")?.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    if urlencoding::decode(parts[0]).ok()?.as_ref() != owner.branch
        || urlencoding::decode(parts[1]).ok()?.as_ref() != owner.plan_id
    {
        return None;
    }
    Some(urlencoding::decode(parts[2]).ok()?.into_owned())
}
fn plan_candidate(
    task: &Value,
    owner: &EngineSourceOwner,
    reference: &repository::card_associations::CardAssociation,
) -> Option<(String, WorkspaceTaskExecutionTargetDto)> {
    let id = task.get("id")?.as_str()?;
    let node = task_identity(id, owner)?;
    if task.get("plan_id")?.as_str()? != owner.plan_id
        || task.get("archived_at").is_some_and(|v| !v.is_null())
        || task
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s.eq_ignore_ascii_case("archived"))
    {
        return None;
    }
    // A present exact Task association takes precedence over its legacy node hint.
    if let Some(expected) = &reference.task_id {
        if expected != id {
            return None;
        }
    } else if reference.legacy_node_id.as_deref() != Some(node.as_str()) {
        return None;
    }
    let targets = task
        .get("execution_targets")?
        .as_array()?
        .iter()
        .map(|value| serde_json::from_value::<WorkspaceTaskExecutionTargetDto>(value.clone()).ok())
        .collect::<Option<Vec<_>>>()?;
    let targets = targets
        .into_iter()
        .filter(|target| target.project_id == owner.project_id)
        .collect::<Vec<_>>();
    (targets.len() == 1).then(|| (id.to_owned(), targets[0].clone()))
}
fn candidate(
    registry: &WorkspaceState,
    owner: &EngineSourceOwner,
    reference: &repository::card_associations::CardAssociation,
) -> Option<(String, WorkspaceTaskExecutionTargetDto)> {
    let mut found = registry
        .current_plan
        .iter()
        .flat_map(|plan| &plan.tasks)
        .filter_map(|task| plan_candidate(task, owner, reference))
        .collect::<Vec<_>>();
    if let Some(task_id) = &reference.task_id {
        for task in &registry.manual_features {
            if task.id != *task_id
                || task.archived_at.is_some()
                || task.status.eq_ignore_ascii_case("archived")
                || task.base_branch != owner.branch
                || !task.project_ids.contains(&owner.project_id)
                || registry.deleted_manual_feature_ids.contains(task_id)
            {
                continue;
            }
            let targets = task
                .execution_targets
                .iter()
                .filter(|target| target.project_id == owner.project_id)
                .collect::<Vec<_>>();
            if targets.len() == 1 {
                found.push((task.id.clone(), targets[0].clone()));
            }
        }
    }
    (found.len() == 1).then(|| found.remove(0))
}
pub(crate) fn resolve_target(
    workspace: &Path,
    locked: &crate::workspace::architect::LockedExecutionSource,
    reference: &repository::card_associations::CardAssociation,
    git: &crate::git::GitState,
) -> Result<Option<(String, WorkspaceTaskExecutionTargetDto, PathBuf)>> {
    let owner = &locked.revision.owner;
    let Some((task, target)) = candidate(&locked.registry, owner, reference) else {
        return Ok(None);
    };
    let scope = crate::agsdl_host_capture::project_scope(workspace, locked)?;
    let root = PathBuf::from(scope.get("root").and_then(Value::as_str).unwrap_or(""));
    let resolved =
        match crate::workspace::task_target::resolve_task_execution_root(root, &target, git) {
            Ok(root) => root,
            Err(_) => return Ok(None),
        };
    Ok(Some((task, target, resolved)))
}
pub(crate) async fn resolve(
    pool: &sqlx::SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: ResolveCardTask,
) -> Result<Option<ResolvedCardTask>> {
    let Some(reference) = repository::card_associations::historical(
        pool,
        &request.system_start_id,
        &request.source,
        &request.path,
    )
    .await?
    else {
        return Ok(None);
    };
    let metadata = crate::agsdl_host_capture::metadata_root(workspace)?;
    let locked = match crate::workspace::architect::lock_execution_source_owner(
        workspace,
        &metadata,
        &request.source.owner,
        None,
    )
    .await
    {
        Ok(locked) => locked,
        Err(_) => return Ok(None),
    };
    let Some((task_id, target, _root)) = resolve_target(workspace, &locked, &reference, git)?
    else {
        return Ok(None);
    };
    Ok(Some(ResolvedCardTask {
        task_id,
        project_id: request.source.owner.project_id,
        plan_id: request.source.owner.plan_id,
        branch: request.source.owner.branch,
        execution_target: PublicTaskTarget {
            project_id: target.project_id,
            branch_name: target.branch_name,
            execution_mode: target.execution_mode,
            execution_kind: target.execution_kind,
            worktree_key: target.worktree_key,
        },
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_task_identity_scope_and_target_are_required() {
        let owner = EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "plan".into(),
            branch: "feature/test".into(),
        };
        let reference = repository::card_associations::CardAssociation {
            path: "/agents/a".into(),
            task_id: Some("task:v1:feature%2Ftest:plan:node".into()),
            legacy_node_id: Some("node".into()),
        };
        let task = json!({"id":reference.task_id,"plan_id":"plan","status":"Pending","execution_targets":[{"projectId":"project","branchName":"feature/task","executionMode":"git","executionKind":"worktree","worktreeKey":"task"}]});
        assert!(plan_candidate(&task, &owner, &reference).is_some());
        for (key, value) in [
            ("id", json!("task:v1:other:plan:node")),
            ("plan_id", json!("other")),
            ("archived_at", json!("date")),
            ("execution_targets", json!([])),
        ] {
            let mut changed = task.clone();
            changed[key] = value;
            assert!(plan_candidate(&changed, &owner, &reference).is_none());
        }
        let mut legacy = reference.clone();
        legacy.task_id = None;
        assert!(plan_candidate(&task, &owner, &legacy).is_some());
        let mut wrong = reference.clone();
        wrong.task_id = Some("missing".into());
        assert!(plan_candidate(&task, &owner, &wrong).is_none());
        let mut ambiguous = task.clone();
        ambiguous["execution_targets"]
            .as_array_mut()
            .unwrap()
            .push(task["execution_targets"][0].clone());
        assert!(plan_candidate(&ambiguous, &owner, &reference).is_none());
    }
}
