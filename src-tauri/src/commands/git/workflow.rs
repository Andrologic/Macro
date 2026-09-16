use std::path::{Path, PathBuf};

use chrono::Utc;
use git2::{BranchType, Oid, Repository, RepositoryState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tauri::State;
use uuid::Uuid;

use crate::commands::{get_pool, DbPool};
use crate::core::error::{BackendError, Result};
use crate::git::GitState;
use crate::workspace;
use crate::WorkspaceRoot;

use super::{
    abort_exact_incomplete_merge, command_output_text, complete_merge_repo, ensure_clean,
    fast_forward_repo, merge_repo, repo_root, start_merge_resolution_repo, to_join_error,
    validate_branch_name, validate_repo_path, verify_exact_incomplete_merge,
};

const WORKFLOW_SETTING_PREFIX: &str = "gitWorkflow:v1:";
const PLAN_LIFECYCLE_SETTING_KEY: &str = "pendingPlanLifecycles:v1";

#[path = "workflow_cleanup.rs"]
pub(crate) mod cleanup;
#[path = "workflow_rebase.rs"]
mod rebase;
#[path = "workflow_session.rs"]
mod session_guard;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkflowSessionIdentity {
    pub task_id: String,
    pub session_id: String,
    pub source_branch: String,
    pub target_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkflowSessionDto {
    pub session_id: String,
    pub task_id: String,
    pub source_branch: String,
    pub target_branch: String,
    pub source_commit: String,
    pub target_commit: String,
    pub integrated_commit: Option<String>,
    pub status: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorkflowJournal {
    #[serde(flatten)]
    session: GitWorkflowSessionDto,
    repo_path: String,
    #[serde(default)]
    common_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_rebase: Option<rebase::RebaseIntent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPlanLifecycle {
    plan_id: String,
    branch_name: String,
    operation: String,
    #[serde(default)]
    finalization_repositories: Vec<PendingPlanRepositoryCheckpoint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPlanRepositoryCheckpoint {
    repo_path: String,
    plan_branch_name: String,
    base_branch_name: String,
    backmerge_branch_name: Option<String>,
    #[serde(default)]
    expected_plan_commit: Option<String>,
    phase: String,
    base_commit_after_sync: Option<String>,
    base_commit_after_merge: Option<String>,
    backmerge_commit_after_sync: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkflowStatus {
    Prepared,
    Conflicted,
    Integrated,
    Aborted,
}

impl WorkflowStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Conflicted => "conflicted",
            Self::Integrated => "integrated",
            Self::Aborted => "aborted",
        }
    }
}

fn backend_database_error(error: impl std::fmt::Display) -> BackendError {
    BackendError::Database {
        message: error.to_string(),
    }
}

fn workflow_error(message: impl Into<String>) -> BackendError {
    BackendError::Git {
        message: message.into(),
    }
}

fn parse_oid(value: &str, label: &str) -> Result<Oid> {
    Oid::from_str(value).map_err(|_| workflow_error(format!("Invalid {label} commit: {value}")))
}

pub(crate) fn repository_common_dir(repo: &Repository) -> Result<PathBuf> {
    repo.commondir()
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to canonicalize Git common directory: {error}"),
            source: error,
        })
}

pub(crate) fn workflow_key(
    repo: &Repository,
    task_id: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<String> {
    let common_dir = repository_common_dir(repo)?;
    let identity = format!(
        "{}\0{}\0{}\0{}",
        common_dir.to_string_lossy(),
        task_id,
        source_branch,
        target_branch
    );
    let digest = Sha256::digest(identity.as_bytes());
    Ok(format!("{WORKFLOW_SETTING_PREFIX}{digest:x}"))
}

fn local_branch_commit(repo: &Repository, branch_name: &str) -> Result<Oid> {
    validate_branch_name(branch_name)?;
    repo.find_branch(branch_name, BranchType::Local)
        .map_err(|error| {
            if error.code() == git2::ErrorCode::NotFound {
                BackendError::GitBranchNotFound {
                    message: format!("Local branch not found: {branch_name}"),
                }
            } else {
                workflow_error(format!(
                    "Failed to read local branch {branch_name}: {error}"
                ))
            }
        })?
        .get()
        .peel_to_commit()
        .map(|commit| commit.id())
        .map_err(|error| workflow_error(format!("Failed to resolve branch {branch_name}: {error}")))
}

fn current_branch_commit(repo: &Repository, branch_name: &str) -> Result<Oid> {
    local_branch_commit(repo, branch_name)
}

fn ensure_distinct_branches(source_branch: &str, target_branch: &str) -> Result<()> {
    validate_branch_name(source_branch)?;
    validate_branch_name(target_branch)?;
    if source_branch == target_branch {
        return Err(BackendError::Validation(
            "Source and target branches must differ.".to_string(),
        ));
    }
    Ok(())
}

fn session_matches(
    session: &GitWorkflowSessionDto,
    task_id: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<()> {
    if session.task_id != task_id
        || session.source_branch != source_branch
        || session.target_branch != target_branch
    {
        return Err(workflow_error(
            "The durable Git workflow identity does not match this request.",
        ));
    }
    Ok(())
}

fn journal_to_dto(journal: &GitWorkflowJournal) -> GitWorkflowSessionDto {
    journal.session.clone()
}

fn replace_session(
    journal: &GitWorkflowJournal,
    source_commit: Option<String>,
    status: Option<WorkflowStatus>,
    integrated_commit: Option<Option<String>>,
    output: Option<String>,
) -> GitWorkflowJournal {
    let mut next = journal.clone();
    if let Some(source_commit) = source_commit {
        next.session.source_commit = source_commit;
    }
    if let Some(status) = status {
        next.session.status = status.as_str().to_string();
    }
    if let Some(integrated_commit) = integrated_commit {
        next.session.integrated_commit = integrated_commit;
    }
    if let Some(output) = output {
        next.session.output = output;
    }
    next
}

async fn load_journal(pool: &SqlitePool, key: &str) -> Result<Option<GitWorkflowJournal>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(backend_database_error)?;
    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|error| workflow_error(format!("Git workflow journal is corrupt: {error}")))
    })
    .transpose()
}

pub(crate) async fn load_journal_for_key(
    pool: &SqlitePool,
    key: &str,
) -> Result<GitWorkflowJournal> {
    load_journal(pool, key)
        .await?
        .ok_or_else(|| workflow_error("The requested Git workflow session was not found."))
}

/// Enforce one durable prepared/conflicted owner per Git common directory.
///
/// The in-process repository mutex prevents concurrent mutations, while this
/// database scan prevents a second task from recovering or adopting the same
/// repository after the first task has persisted its prepared checkpoint.
pub(crate) async fn ensure_workflow_exclusive(
    pool: &SqlitePool,
    common_dir: &Path,
    current_key: &str,
) -> Result<()> {
    let rows = sqlx::query("SELECT key, value_json FROM app_settings WHERE key LIKE ?")
        .bind(format!("{WORKFLOW_SETTING_PREFIX}%"))
        .fetch_all(pool)
        .await
        .map_err(backend_database_error)?;

    for row in rows {
        let key: String = row.try_get("key").map_err(backend_database_error)?;
        if key == current_key {
            continue;
        }
        let value: String = row.try_get("value_json").map_err(backend_database_error)?;
        let journal: GitWorkflowJournal = serde_json::from_str(&value)
            .map_err(|error| workflow_error(format!("Git workflow journal is corrupt: {error}")))?;
        if journal.session.status != "prepared" && journal.session.status != "conflicted" {
            continue;
        }
        if !journal.common_dir.is_empty() && Path::new(&journal.common_dir) == common_dir {
            return Err(workflow_error(format!(
                "Git repository already has an active workflow owned by task {}.",
                journal.session.task_id
            )));
        }
    }
    Ok(())
}

/// Legacy merge commands may operate on ordinary Git merges, but must not
/// bypass the owner of a prepared/conflicted workflow, even after a restart.
pub(crate) async fn ensure_unowned_merge_access(
    pool: &State<'_, DbPool>,
    git_state: &GitState,
    path: &Path,
) -> Result<()> {
    let pool = get_pool(pool)
        .await
        .map_err(|error| BackendError::Database {
            message: error.message,
        })?;
    let common = {
        let repository = git_state.open_repo(path)?;
        let repository = repository
            .lock()
            .map_err(|_| workflow_error("Failed to lock repository"))?;
        repository_common_dir(&repository)?
    };
    ensure_workflow_exclusive(&pool, &common, "").await
}

async fn save_journal(pool: &SqlitePool, key: &str, journal: &GitWorkflowJournal) -> Result<()> {
    let value =
        serde_json::to_string(journal).map_err(|error| workflow_error(error.to_string()))?;
    sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .map_err(backend_database_error)?;
    Ok(())
}

async fn run_git_repo<T, F>(git_state: GitState, path: PathBuf, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Repository) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let repo = git_state.open_repo(&path)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        operation(&repo)
    })
    .await
    .map_err(to_join_error)?
}

fn validate_expected_refs(repo: &Repository, journal: &GitWorkflowJournal) -> Result<()> {
    validate_journal_repository(repo, journal)?;
    let source = local_branch_commit(repo, &journal.session.source_branch)?;
    let target = local_branch_commit(repo, &journal.session.target_branch)?;
    let expected_source = parse_oid(&journal.session.source_commit, "source")?;
    let expected_target = parse_oid(&journal.session.target_commit, "target")?;
    if source != expected_source {
        return Err(workflow_error(format!(
            "Refusing Git workflow because source branch {} changed from {} to {}.",
            journal.session.source_branch, expected_source, source
        )));
    }
    if target != expected_target {
        return Err(workflow_error(format!(
            "Refusing Git workflow because target branch {} changed from {} to {}.",
            journal.session.target_branch, expected_target, target
        )));
    }
    Ok(())
}

fn validate_source_ref(repo: &Repository, journal: &GitWorkflowJournal) -> Result<()> {
    let source = local_branch_commit(repo, &journal.session.source_branch)?;
    let expected = parse_oid(&journal.session.source_commit, "source")?;
    if source != expected {
        return Err(workflow_error(
            "Refusing Git workflow because the source branch changed.",
        ));
    }
    Ok(())
}

fn validate_journal_repository(repo: &Repository, journal: &GitWorkflowJournal) -> Result<()> {
    let actual_common = repository_common_dir(repo)?;
    if journal.common_dir.is_empty() || Path::new(&journal.common_dir) != actual_common {
        return Err(workflow_error(
            "Refusing Git workflow because the repository common directory no longer matches the journal.",
        ));
    }
    Ok(())
}

fn exact_merge_commit(
    repo: &Repository,
    target_branch: &str,
    expected_target: Oid,
    expected_source: Oid,
) -> Result<Option<Oid>> {
    let actual_target = current_branch_commit(repo, target_branch)?;
    let commit = repo.find_commit(actual_target)?;
    if commit.parent_count() == 2
        && commit.parent_id(0).ok() == Some(expected_target)
        && commit.parent_id(1).ok() == Some(expected_source)
    {
        return Ok(Some(actual_target));
    }
    Ok(None)
}

fn exact_fast_forward_commit(
    repo: &Repository,
    target_branch: &str,
    expected_target: Oid,
    expected_source: Oid,
) -> Result<Option<Oid>> {
    let actual_target = current_branch_commit(repo, target_branch)?;
    if actual_target != expected_source {
        return Ok(None);
    }
    let is_descendant = actual_target == expected_target
        || repo
            .graph_descendant_of(actual_target, expected_target)
            .map_err(|error| {
                workflow_error(format!("Failed to inspect fast-forward ancestry: {error}"))
            })?;
    Ok(is_descendant.then_some(actual_target))
}

fn integrated_commit_after_crash(
    repo: &Repository,
    journal: &GitWorkflowJournal,
) -> Result<Option<Oid>> {
    let expected_target = parse_oid(&journal.session.target_commit, "target")?;
    let expected_source = parse_oid(&journal.session.source_commit, "source")?;
    if let Some(commit) = exact_merge_commit(
        repo,
        &journal.session.target_branch,
        expected_target,
        expected_source,
    )? {
        if local_branch_commit(repo, &journal.session.source_branch)? != expected_source {
            return Err(workflow_error(
                "Refusing recovery because the source branch changed before the integration checkpoint.",
            ));
        }
        return Ok(Some(commit));
    }
    if let Some(commit) = exact_fast_forward_commit(
        repo,
        &journal.session.target_branch,
        expected_target,
        expected_source,
    )? {
        if local_branch_commit(repo, &journal.session.source_branch)? != expected_source {
            return Err(workflow_error(
                "Refusing recovery because the source branch changed before the integration checkpoint.",
            ));
        }
        return Ok(Some(commit));
    }
    Ok(None)
}

fn validate_integrated_state(repo: &Repository, journal: &GitWorkflowJournal) -> Result<()> {
    validate_journal_repository(repo, journal)?;
    if repo.state() != RepositoryState::Clean {
        return Err(workflow_error(
            "Refusing integrated workflow inspection while another Git operation is active.",
        ));
    }
    let integrated = parse_oid(
        journal
            .session
            .integrated_commit
            .as_deref()
            .ok_or_else(|| workflow_error("Integrated workflow is missing its result commit."))?,
        "integrated",
    )?;
    let target = current_branch_commit(repo, &journal.session.target_branch)?;
    if target != integrated
        && !repo
            .graph_descendant_of(target, integrated)
            .map_err(|error| {
                workflow_error(format!("Failed to inspect integrated ancestry: {error}"))
            })?
    {
        return Err(workflow_error(
            "Refusing integrated workflow because the target branch diverged from the recorded result.",
        ));
    }
    match local_branch_commit(repo, &journal.session.source_branch) {
        Err(BackendError::GitBranchNotFound { .. }) => return Ok(()),
        Err(error) => return Err(error),
        Ok(source) => {
            let expected_source = parse_oid(&journal.session.source_commit, "source")?;
            if source != expected_source {
                return Err(workflow_error(
                    "Refusing integrated workflow because the source branch changed.",
                ));
            }
        }
    }
    Ok(())
}

fn workflow_state_repo_path(journal: &GitWorkflowJournal, requested: &Path) -> PathBuf {
    let original = PathBuf::from(&journal.repo_path);
    if original.exists() {
        original
    } else {
        requested.to_path_buf()
    }
}

fn inspect_or_recover(
    repo: &Repository,
    journal: &GitWorkflowJournal,
) -> Result<GitWorkflowJournal> {
    validate_journal_repository(repo, journal)?;
    match journal.session.status.as_str() {
        "integrated" => {
            validate_integrated_state(repo, journal)?;
            Ok(journal.clone())
        }
        "aborted" => Ok(journal.clone()),
        "prepared" | "conflicted" => {
            if verify_exact_incomplete_merge(
                repo,
                &journal.session.target_branch,
                &journal.session.target_commit,
                &journal.session.source_commit,
            )? {
                validate_source_ref(repo, journal)?;
                return Ok(replace_session(
                    journal,
                    None,
                    Some(WorkflowStatus::Conflicted),
                    None,
                    None,
                ));
            }
            if repo.state() != RepositoryState::Clean {
                return Err(workflow_error(
                    "Refusing workflow inspection because the repository is in an unrelated Git state.",
                ));
            }
            if let Some(integrated) = integrated_commit_after_crash(repo, journal)? {
                return Ok(replace_session(
                    journal,
                    None,
                    Some(WorkflowStatus::Integrated),
                    Some(Some(integrated.to_string())),
                    Some("Recovered Git integration after a process interruption.".to_string()),
                ));
            }
            validate_expected_refs(repo, journal)?;
            Ok(journal.clone())
        }
        status => Err(workflow_error(format!(
            "Unknown Git workflow status: {status}"
        ))),
    }
}

fn verify_conflict_session(
    repo: &Repository,
    journal: &GitWorkflowJournal,
    identity: &GitWorkflowSessionIdentity,
) -> Result<()> {
    validate_journal_repository(repo, journal)?;
    session_matches(
        &journal.session,
        &identity.task_id,
        &identity.source_branch,
        &identity.target_branch,
    )?;
    if journal.session.session_id != identity.session_id {
        return Err(workflow_error(
            "The supplied Git workflow session is not the journaled session.",
        ));
    }
    if journal.session.status != "prepared" && journal.session.status != "conflicted" {
        return Err(workflow_error(
            "The supplied Git workflow session is not an active conflict session.",
        ));
    }
    if !verify_exact_incomplete_merge(
        repo,
        &journal.session.target_branch,
        &journal.session.target_commit,
        &journal.session.source_commit,
    )? {
        return Err(workflow_error(
            "Refusing conflict access because MERGE_HEAD is not the exact journaled merge.",
        ));
    }
    if local_branch_commit(repo, &journal.session.source_branch)?
        != parse_oid(&journal.session.source_commit, "source")?
    {
        return Err(workflow_error(
            "Refusing conflict access because the source branch changed.",
        ));
    }
    Ok(())
}

fn merge_result(repo: &Repository, journal: &GitWorkflowJournal) -> Result<Oid> {
    let expected_target = parse_oid(&journal.session.target_commit, "target")?;
    let expected_source = parse_oid(&journal.session.source_commit, "source")?;
    let target = current_branch_commit(repo, &journal.session.target_branch)?;
    if let Some(commit) = exact_merge_commit(
        repo,
        &journal.session.target_branch,
        expected_target,
        expected_source,
    )? {
        return Ok(commit);
    }
    if let Some(commit) = exact_fast_forward_commit(
        repo,
        &journal.session.target_branch,
        expected_target,
        expected_source,
    )? {
        return Ok(commit);
    }
    Err(workflow_error(format!(
        "Git integration did not produce the exact expected result on {} (current target {}).",
        journal.session.target_branch, target
    )))
}

fn any_merge_in_progress(repo: &Repository) -> Result<bool> {
    if repo.state() == RepositoryState::Merge || super::is_merge_in_progress(repo) {
        return Ok(true);
    }
    let root = repo_root(repo)?;
    let output = super::run_git_command(
        &root,
        &[
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ],
    )?;
    if !output.success {
        return Err(workflow_error(format!(
            "Unable to inspect Git worktrees before preparing a workflow: {}",
            command_output_text(&output)
        )));
    }
    let mut candidate = None;
    for line in output.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            candidate = Some(PathBuf::from(path));
        } else if line.trim().is_empty() {
            if let Some(path) = candidate.take() {
                if let Ok(worktree_repo) = Repository::open(&path) {
                    if worktree_repo.state() == RepositoryState::Merge
                        || super::is_merge_in_progress(&worktree_repo)
                    {
                        return Ok(true);
                    }
                }
            }
        }
    }
    if let Some(path) = candidate {
        if let Ok(worktree_repo) = Repository::open(&path) {
            return Ok(worktree_repo.state() == RepositoryState::Merge
                || super::is_merge_in_progress(&worktree_repo));
        }
    }
    Ok(false)
}

fn plan_pending_merge_identity(
    _saga: &PendingPlanLifecycle,
    checkpoint: &PendingPlanRepositoryCheckpoint,
) -> Result<(String, String, String, String)> {
    match checkpoint.phase.as_str() {
        "plan_merge_pending" => Ok((
            checkpoint.plan_branch_name.clone(),
            checkpoint.base_branch_name.clone(),
            checkpoint.expected_plan_commit.clone().ok_or_else(|| {
                workflow_error("Plan merge checkpoint is missing expectedPlanCommit.")
            })?,
            checkpoint.base_commit_after_sync.clone().ok_or_else(|| {
                workflow_error("Plan merge checkpoint is missing baseCommitAfterSync.")
            })?,
        )),
        "backmerge_merge_pending" => Ok((
            checkpoint.base_branch_name.clone(),
            checkpoint.backmerge_branch_name.clone().ok_or_else(|| {
                workflow_error("Backmerge checkpoint is missing backmergeBranchName.")
            })?,
            checkpoint.base_commit_after_merge.clone().ok_or_else(|| {
                workflow_error("Backmerge checkpoint is missing baseCommitAfterMerge.")
            })?,
            checkpoint
                .backmerge_commit_after_sync
                .clone()
                .ok_or_else(|| {
                    workflow_error("Backmerge checkpoint is missing backmergeCommitAfterSync.")
                })?,
        )),
        _ => Err(workflow_error(
            "Plan adoption requires a plan_merge_pending or backmerge_merge_pending checkpoint.",
        )),
    }
}

async fn load_plan_adoption_identity(
    pool: &SqlitePool,
    common_dir: &Path,
    task_id: &str,
    source_branch: &str,
    target_branch: &str,
    plan_id: Option<String>,
    storage_branch: Option<String>,
) -> Result<(String, String, String, String)> {
    let plan_id = plan_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BackendError::Validation("adopt_plan requires planId.".to_string()))?;
    let storage_branch = storage_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            BackendError::Validation("adopt_plan requires storageBranch.".to_string())
        })?;
    let expected_task_id = format!("plan-finalization:{plan_id}");
    if task_id != expected_task_id {
        return Err(workflow_error(
            "Only the exact plan-finalization task may adopt a plan merge.",
        ));
    }

    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = ?")
            .bind(PLAN_LIFECYCLE_SETTING_KEY)
            .fetch_optional(pool)
            .await
            .map_err(backend_database_error)?;
    let raw = raw.ok_or_else(|| workflow_error("No pending plan finalization saga exists."))?;
    let sagas: Vec<PendingPlanLifecycle> = serde_json::from_str(&raw)
        .map_err(|error| workflow_error(format!("Plan lifecycle journal is corrupt: {error}")))?;
    let saga = sagas
        .into_iter()
        .find(|candidate| {
            candidate.operation == "finalize"
                && candidate.plan_id == plan_id
                && candidate.branch_name == storage_branch
        })
        .ok_or_else(|| {
            workflow_error(
                "No exact pending plan finalization saga matches planId and storageBranch.",
            )
        })?;
    let checkpoint = saga
        .finalization_repositories
        .iter()
        .find(|candidate| {
            Repository::open(&candidate.repo_path)
                .ok()
                .and_then(|candidate_repo| repository_common_dir(&candidate_repo).ok())
                .is_some_and(|candidate_common| candidate_common == common_dir)
        })
        .cloned()
        .ok_or_else(|| {
            workflow_error("No exact pending plan repository matches this Git repository.")
        })?;
    let (expected_source_branch, expected_target_branch, expected_source, expected_target) =
        plan_pending_merge_identity(&saga, &checkpoint)?;
    if source_branch != expected_source_branch || target_branch != expected_target_branch {
        return Err(workflow_error(
            "Plan checkpoint branches do not match the requested workflow branches.",
        ));
    }
    Ok((
        expected_source_branch,
        expected_target_branch,
        expected_source,
        expected_target,
    ))
}

fn initial_session(
    repo: &Repository,
    repo_path: &Path,
    task_id: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<GitWorkflowJournal> {
    ensure_distinct_branches(source_branch, target_branch)?;
    ensure_clean(repo)?;
    let source_commit = local_branch_commit(repo, source_branch)?.to_string();
    let target_commit = local_branch_commit(repo, target_branch)?.to_string();
    Ok(GitWorkflowJournal {
        session: GitWorkflowSessionDto {
            session_id: Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            source_branch: source_branch.to_string(),
            target_branch: target_branch.to_string(),
            source_commit,
            target_commit,
            integrated_commit: None,
            status: WorkflowStatus::Prepared.as_str().to_string(),
            output: "Git workflow prepared.".to_string(),
        },
        repo_path: repo_path.to_string_lossy().to_string(),
        common_dir: repository_common_dir(repo)?.to_string_lossy().to_string(),
        pending_rebase: None,
    })
}

pub(crate) fn verify_conflict_journal(
    repo: &Repository,
    journal: &GitWorkflowJournal,
    identity: &GitWorkflowSessionIdentity,
) -> Result<()> {
    verify_conflict_session(repo, journal, identity)
}

pub(crate) fn journal_repo_path(journal: &GitWorkflowJournal) -> PathBuf {
    PathBuf::from(&journal.repo_path)
}

#[tauri::command]
pub async fn git_workflow(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    repo_path: String,
    task_id: String,
    source_branch: String,
    target_branch: String,
    action: String,
    plan_id: Option<String>,
    storage_branch: Option<String>,
    expected_session_id: Option<String>,
) -> Result<Option<GitWorkflowSessionDto>> {
    if super::parse_wsl_repo_path(&repo_path).is_some() {
        return Err(super::unsupported_wsl_git_operation("git_workflow"));
    }
    let allowed = [
        "inspect",
        "prepare",
        "start",
        "merge_commit",
        "fast_forward",
        "rebase_then_continue",
        "no_changes",
        "complete",
        "abort",
        "adopt_plan",
    ];
    if !allowed.contains(&action.as_str()) {
        return Err(BackendError::Validation(format!(
            "Invalid Git workflow action: {action}"
        )));
    }
    if action != "adopt_plan" {
        ensure_distinct_branches(&source_branch, &target_branch)?;
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    let validated = validate_repo_path(&repo_path, &workspace)?;
    let _repo_guard = workspace::lock_git_repository(&validated).await?;
    let pool = get_pool(&pool)
        .await
        .map_err(|error| BackendError::Database {
            message: error.message,
        })?;
    let request_repo = git_state.open_repo(&validated)?;
    let key = {
        let repo = request_repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        workflow_key(&repo, &task_id, &source_branch, &target_branch)?
    };
    let common_dir = {
        let repo = request_repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        repository_common_dir(&repo)?
    };
    let mut existing = load_journal(&pool, &key).await?;
    session_guard::verify_requested_session(existing.as_ref(), expected_session_id.as_deref())?;
    if let Some(journal) = existing.as_ref() {
        session_matches(&journal.session, &task_id, &source_branch, &target_branch)?;
    }
    if action == "inspect" && existing.is_none() {
        return Ok(None);
    }
    ensure_workflow_exclusive(&pool, &common_dir, &key).await?;

    if let Some(journal) = existing
        .as_ref()
        .filter(|journal| journal.pending_rebase.is_some())
    {
        let pending = journal.clone();
        let abort = action == "abort";
        let recovered = run_git_repo(git_state.clone(), validated.clone(), move |repo| {
            rebase::recover_rebase(repo, &pending, abort)
        })
        .await?;
        save_journal(&pool, &key, &recovered).await?;
        existing = Some(recovered);
    }

    if action == "prepare" {
        if let Some(existing) = existing.take() {
            session_matches(&existing.session, &task_id, &source_branch, &target_branch)?;
            if existing.session.status != "aborted" {
                let state_path = workflow_state_repo_path(&existing, &validated);
                let previous = existing.clone();
                let inspected = run_git_repo(git_state.clone(), state_path, move |repo| {
                    inspect_or_recover(repo, &previous)
                })
                .await?;
                if inspected.session.status == "integrated" && inspected.session != existing.session
                {
                    save_journal(&pool, &key, &inspected).await?;
                }
                return Ok(Some(journal_to_dto(&inspected)));
            }
        }
        let new_session = run_git_repo(git_state.clone(), validated.clone(), {
            let task_id = task_id.clone();
            let source_branch = source_branch.clone();
            let target_branch = target_branch.clone();
            move |repo| {
                if any_merge_in_progress(repo)? {
                    return Err(workflow_error(
                        "Refusing to prepare a new workflow while a merge is already in progress.",
                    ));
                }
                initial_session(repo, &validated, &task_id, &source_branch, &target_branch)
            }
        })
        .await?;
        save_journal(&pool, &key, &new_session).await?;
        return Ok(Some(journal_to_dto(&new_session)));
    }

    if action == "adopt_plan" {
        if let Some(existing) = existing.take() {
            session_matches(&existing.session, &task_id, &source_branch, &target_branch)?;
            if existing.session.status != "aborted" {
                let state_path = workflow_state_repo_path(&existing, &validated);
                let previous = existing.clone();
                let inspected = run_git_repo(git_state.clone(), state_path, move |repo| {
                    inspect_or_recover(repo, &previous)
                })
                .await?;
                if inspected.session != existing.session {
                    save_journal(&pool, &key, &inspected).await?;
                }
                return Ok(Some(journal_to_dto(&inspected)));
            }
        }
        let (expected_source_branch, expected_target_branch, expected_source, expected_target) =
            load_plan_adoption_identity(
                &pool,
                &common_dir,
                &task_id,
                &source_branch,
                &target_branch,
                plan_id,
                storage_branch,
            )
            .await?;
        let adopted = run_git_repo(git_state.clone(), validated.clone(), move |repo| {
            if repo.state() != RepositoryState::Merge
                || !verify_exact_incomplete_merge(
                    repo,
                    &expected_target_branch,
                    &expected_target,
                    &expected_source,
                )?
            {
                return Err(workflow_error(
                    "Plan adoption requires the exact pending finalization merge.",
                ));
            }
            if local_branch_commit(repo, &expected_source_branch)?.to_string() != expected_source {
                return Err(workflow_error(
                    "Plan adoption refused because the source branch does not match the checkpoint.",
                ));
            }
            let actual_target = local_branch_commit(repo, &expected_target_branch)?.to_string();
            if actual_target != expected_target {
                return Err(workflow_error(
                    "Plan adoption refused because the target branch does not match the checkpoint.",
                ));
            }
            Ok(GitWorkflowJournal {
                session: GitWorkflowSessionDto {
                    session_id: Uuid::new_v4().to_string(),
                    task_id: task_id.clone(),
                    source_branch: expected_source_branch.clone(),
                    target_branch: expected_target_branch.clone(),
                    source_commit: expected_source.clone(),
                    target_commit: expected_target.clone(),
                    integrated_commit: None,
                    status: WorkflowStatus::Conflicted.as_str().to_string(),
                    output: "Adopted pending plan finalization merge.".to_string(),
                },
                repo_path: validated.to_string_lossy().to_string(),
                common_dir: common_dir.to_string_lossy().to_string(),
                pending_rebase: None,
            })
        })
        .await?;
        save_journal(&pool, &key, &adopted).await?;
        return Ok(Some(journal_to_dto(&adopted)));
    }

    let mut journal = match existing.take() {
        Some(journal) => journal,
        None if matches!(
            action.as_str(),
            "start" | "merge_commit" | "fast_forward" | "rebase_then_continue" | "no_changes"
        ) =>
        {
            let new_session = run_git_repo(git_state.clone(), validated.clone(), {
                let task_id = task_id.clone();
                let source_branch = source_branch.clone();
                let target_branch = target_branch.clone();
                let repo_path = validated.clone();
                move |repo| {
                    if any_merge_in_progress(repo)? {
                        return Err(workflow_error(
                            "Refusing to create a workflow while a merge is already in progress.",
                        ));
                    }
                    initial_session(repo, &repo_path, &task_id, &source_branch, &target_branch)
                }
            })
            .await?;
            save_journal(&pool, &key, &new_session).await?;
            new_session
        }
        None => {
            return Err(workflow_error(
                "No prepared Git workflow session exists for this task and branch pair.",
            ));
        }
    };
    session_matches(&journal.session, &task_id, &source_branch, &target_branch)?;

    let can_restart = matches!(
        action.as_str(),
        "start" | "merge_commit" | "fast_forward" | "rebase_then_continue" | "no_changes"
    );
    if journal.session.status == "aborted" && can_restart {
        let new_session = run_git_repo(git_state.clone(), validated.clone(), {
            let task_id = task_id.clone();
            let source_branch = source_branch.clone();
            let target_branch = target_branch.clone();
            let repo_path = validated.clone();
            move |repo| {
                if any_merge_in_progress(repo)? {
                    return Err(workflow_error(
                        "Refusing to prepare a new workflow while a merge is already in progress.",
                    ));
                }
                initial_session(repo, &repo_path, &task_id, &source_branch, &target_branch)
            }
        })
        .await?;
        save_journal(&pool, &key, &new_session).await?;
        journal = new_session;
    }

    if action == "inspect" {
        let state_path = workflow_state_repo_path(&journal, &validated);
        let previous = journal.clone();
        let inspected = run_git_repo(git_state.clone(), state_path, move |repo| {
            inspect_or_recover(repo, &previous)
        })
        .await?;
        if inspected.session != journal.session {
            save_journal(&pool, &key, &inspected).await?;
        }
        return Ok(Some(journal_to_dto(&inspected)));
    }

    if journal.session.status == "aborted" {
        return Err(workflow_error("The Git workflow session has been aborted."));
    }
    if journal.session.status == "integrated" {
        let state_path = workflow_state_repo_path(&journal, &validated);
        let inspected = run_git_repo(git_state.clone(), state_path, move |repo| {
            validate_integrated_state(repo, &journal).map(|_| journal)
        })
        .await?;
        return Ok(Some(journal_to_dto(&inspected)));
    }

    if action == "start" {
        let path = validated.clone();
        let next = run_git_repo(git_state.clone(), path.clone(), {
            let journal = journal.clone();
            let source_branch = source_branch.clone();
            let target_branch = target_branch.clone();
            move |repo| {
                validate_journal_repository(repo, &journal)?;
                if verify_exact_incomplete_merge(
                    repo,
                    &target_branch,
                    &journal.session.target_commit,
                    &journal.session.source_commit,
                )? {
                    validate_source_ref(repo, &journal)?;
                    return Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Conflicted),
                        None,
                        None,
                    ));
                }
                validate_expected_refs(repo, &journal)?;
                let result = start_merge_resolution_repo(repo, &source_branch, &target_branch)?;
                if result.status == "conflicted" {
                    Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Conflicted),
                        None,
                        Some(result.output),
                    ))
                } else if result.status == "merged" {
                    let integrated = merge_result(repo, &journal)?;
                    Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Integrated),
                        Some(Some(integrated.to_string())),
                        Some(result.output),
                    ))
                } else {
                    Err(workflow_error(
                        "Git merge start returned an unknown status.",
                    ))
                }
            }
        })
        .await?;
        journal = next;
        if journal.session.status == "conflicted" {
            journal.repo_path = validated.to_string_lossy().to_string();
        }
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    if action == "rebase_then_continue" {
        journal = run_git_repo(git_state.clone(), validated.clone(), {
            let journal = journal.clone();
            move |repo| rebase::prepare_rebase(repo, &journal)
        })
        .await?;
        // Persist the identity before Git can rewrite the source reference.
        save_journal(&pool, &key, &journal).await?;
        journal = run_git_repo(git_state.clone(), validated.clone(), {
            let journal = journal.clone();
            move |repo| {
                rebase::execute_rebase(repo, &journal)?;
                rebase::recover_rebase(repo, &journal, false)
            }
        })
        .await?;
        save_journal(&pool, &key, &journal).await?;
        let ff = run_git_repo(git_state.clone(), validated.clone(), {
            let journal = journal.clone();
            let source_branch = source_branch.clone();
            let target_branch = target_branch.clone();
            move |repo| {
                validate_expected_refs(repo, &journal)?;
                let output = fast_forward_repo(repo, &source_branch, &target_branch)?;
                let integrated = merge_result(repo, &journal)?;
                Ok((integrated, output))
            }
        })
        .await?;
        journal = replace_session(
            &journal,
            None,
            Some(WorkflowStatus::Integrated),
            Some(Some(ff.0.to_string())),
            Some(format!("{}\n{}", journal.session.output, ff.1)),
        );
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    if action == "complete" {
        let next = run_git_repo(
            git_state.clone(),
            workflow_state_repo_path(&journal, &validated),
            {
                let journal = journal.clone();
                move |repo| {
                    validate_journal_repository(repo, &journal)?;
                    if verify_exact_incomplete_merge(
                        repo,
                        &journal.session.target_branch,
                        &journal.session.target_commit,
                        &journal.session.source_commit,
                    )? {
                        if local_branch_commit(repo, &journal.session.source_branch)?
                            != parse_oid(&journal.session.source_commit, "source")?
                        {
                            return Err(workflow_error(
                                "Complete refused because the source branch changed.",
                            ));
                        }
                        complete_merge_repo(repo)?;
                        let integrated = exact_merge_commit(
                            repo,
                            &journal.session.target_branch,
                            parse_oid(&journal.session.target_commit, "target")?,
                            parse_oid(&journal.session.source_commit, "source")?,
                        )?
                        .ok_or_else(|| {
                            workflow_error(
                                "Completed merge does not have the exact two recorded parents.",
                            )
                        })?;
                        return Ok(replace_session(
                            &journal,
                            None,
                            Some(WorkflowStatus::Integrated),
                            Some(Some(integrated.to_string())),
                            Some("Merge completed.".to_string()),
                        ));
                    }
                    let recovered = inspect_or_recover(repo, &journal)?;
                    if recovered.session.status == "integrated" {
                        return Ok(recovered);
                    }
                    Err(workflow_error(
                        "Complete requires the exact journaled MERGE_HEAD.",
                    ))
                }
            },
        )
        .await?;
        journal = next;
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    if action == "abort" {
        let next = run_git_repo(
            git_state.clone(),
            workflow_state_repo_path(&journal, &validated),
            {
                let journal = journal.clone();
                move |repo| {
                    if verify_exact_incomplete_merge(
                        repo,
                        &journal.session.target_branch,
                        &journal.session.target_commit,
                        &journal.session.source_commit,
                    )? {
                        validate_source_ref(repo, &journal)?;
                        abort_exact_incomplete_merge(
                            repo,
                            &journal.session.target_branch,
                            &journal.session.target_commit,
                            &journal.session.source_commit,
                        )?;
                    } else {
                        if repo.state() != RepositoryState::Clean {
                            return Err(workflow_error(
                                "Refusing to abort an unrelated Git operation.",
                            ));
                        }
                        validate_expected_refs(repo, &journal)?;
                    }
                    Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Aborted),
                        Some(None),
                        Some("Git workflow aborted.".to_string()),
                    ))
                }
            },
        )
        .await?;
        journal = next;
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    if action == "merge_commit" || action == "fast_forward" {
        let next = run_git_repo(git_state.clone(), validated.clone(), {
            let journal = journal.clone();
            let source_branch = source_branch.clone();
            let target_branch = target_branch.clone();
            let action = action.clone();
            move |repo| {
                validate_journal_repository(repo, &journal)?;
                if verify_exact_incomplete_merge(
                    repo,
                    &target_branch,
                    &journal.session.target_commit,
                    &journal.session.source_commit,
                )? {
                    validate_source_ref(repo, &journal)?;
                    return Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Conflicted),
                        None,
                        None,
                    ));
                }
                if let Some(integrated) = integrated_commit_after_crash(repo, &journal)? {
                    return Ok(replace_session(
                        &journal,
                        None,
                        Some(WorkflowStatus::Integrated),
                        Some(Some(integrated.to_string())),
                        Some("Recovered Git integration after a process interruption.".to_string()),
                    ));
                }
                validate_expected_refs(repo, &journal)?;
                let output = if action == "merge_commit" {
                    merge_repo(repo, &source_branch, &target_branch)?
                } else {
                    fast_forward_repo(repo, &source_branch, &target_branch)?
                };
                let integrated = merge_result(repo, &journal)?;
                Ok(replace_session(
                    &journal,
                    None,
                    Some(WorkflowStatus::Integrated),
                    Some(Some(integrated.to_string())),
                    Some(output),
                ))
            }
        })
        .await?;
        journal = next;
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    if action == "no_changes" {
        let next = run_git_repo(git_state.clone(), validated.clone(), {
            let journal = journal.clone();
            move |repo| {
                validate_expected_refs(repo, &journal)?;
                let source = parse_oid(&journal.session.source_commit, "source")?;
                let target = parse_oid(&journal.session.target_commit, "target")?;
                if source != target
                    && !repo.graph_descendant_of(target, source).map_err(|error| {
                        workflow_error(format!("Failed to inspect no-change ancestry: {error}"))
                    })?
                {
                    return Err(workflow_error(
                        "No-change completion requires source to already be an ancestor of target.",
                    ));
                }
                Ok(replace_session(
                    &journal,
                    None,
                    Some(WorkflowStatus::Integrated),
                    Some(Some(target.to_string())),
                    Some(
                        "No Git changes were required; target already contains source.".to_string(),
                    ),
                ))
            }
        })
        .await?;
        journal = next;
        save_journal(&pool, &key, &journal).await?;
        return Ok(Some(journal_to_dto(&journal)));
    }

    Err(workflow_error(format!(
        "Unhandled Git workflow action: {action}"
    )))
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
