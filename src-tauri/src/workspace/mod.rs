pub mod architect;
pub mod metadata;

use crate::core::error::{BackendError, Result};
use crate::core::process::{background_command, background_tokio_command};
use crate::db::models::GitWorktreeRecord;
use crate::git::repo::get_status_options;
use crate::git::MACRO_BRANCH_NAME;
use crate::git::{detect_preferred_git_flow_branches, GitState};
pub use crate::project_path::parse_wsl_unc_path;
use crate::project_path::{wsl_unc_path, ProjectPathKind, WslProjectPath};
use chrono::Utc;
use git2::{
    BranchType, IndexAddOption, Oid, Repository, RepositoryInitOptions, ResetType, Signature, Sort,
};
use metadata::direct_checkpoint_id;
use metadata::{
    CreateNewProjectRepoRequest, CreateProjectRequest, DebugResetProjectReportDto,
    ImportGitRepoRequest, ManualFeatureDto, ManualFeatureMergeWorkflowDto, PlanDto,
    ProjectAccessChangePreviewDto, ProjectAccessMigrationItemDto, ProjectAccessMigrationSummaryDto,
    ProjectDto, ProjectGitFlowDetectionDto, ProjectGitFlowSettingsDto, ProjectGroupDto,
    ProjectMetadataDto, ProjectRegistryDiagnosticsDto, ProjectRegistryRepairReportDto,
    WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceMetadataRecoveryHintDto,
    WorkspaceMetadataRecoveryReportDto, WorkspaceProjectRegistryReconcileReportDto,
    WorkspaceProjectRegistryReconcileSkippedDto,
    WorkspaceReconcileProjectRegistryFromHintsRequestDto,
    WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto,
    WorkspaceRecoverMissingMetadataRequestDto, WorkspaceState, WorkspaceTaskCatalogDto,
    WorkspaceTaskExecutionTargetDto, WorkspaceTaskPlanSummaryDto,
};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::fs;
use tokio::sync::{watch, Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::time::timeout;

const WORKSPACE_STATE_FILE: &str = "workspace.json";
const WORKSPACE_STATE_BACKUP_FILE: &str = "workspace.json.bak";
const WORKSPACE_STATE_FILE_LOCK: &str = ".workspace.json.lock";
const LEGACY_WORKSPACE_META_DIR: &str = ".macro";
const MANUAL_FEATURES_METADATA_DIR: &str = "manual-features";
const MANUAL_FEATURE_METADATA_FILE: &str = "feature.json";
const MACRO_BRANCHES_METADATA_DIR: &str = "branches";
const DEFAULT_REMOTE_NAME: &str = "origin";
const AUTO_DETECTED_MAIN_BRANCH_NAMES: &[&str] = &["main", "master"];
const AUTO_DETECTED_BASE_BRANCH_NAMES: &[&str] = &["develop", "dev", "main", "master"];
const PROJECT_GIT_SETUP_READY: &str = "ready";
const PROJECT_GIT_SETUP_NOT_GIT: &str = "not_git";
const PROJECT_GIT_SETUP_UNBORN: &str = "unborn";
const PROJECT_GIT_DETECTION_READY: &str = "ready";
const PROJECT_GIT_DETECTION_NOT_GIT: &str = "not_git";
const PROJECT_GIT_DETECTION_UNBORN: &str = "unborn";
const PROJECT_GIT_DETECTION_NEEDS_BRANCH_CONFIRMATION: &str = "needs_branch_confirmation";
const READ_ONLY_REASON_MANUAL: &str = "manual";
const READ_ONLY_REASON_MISSING_GIT: &str = "missing_git";
const READ_ONLY_REASON_MISSING_INITIAL_COMMIT: &str = "missing_initial_commit";

const READ_ONLY_REASON_MANUAL_AND_MISSING_GIT: &str = "manual_and_missing_git";
const GIT_RESOLUTION_NONE: &str = "none";
const GIT_RESOLUTION_SELECTED_FOLDER: &str = "selected_folder";
const GIT_RESOLUTION_PARENT_REPO: &str = "parent_repo";
const GIT_RESOLUTION_NEW_LOCAL_REPO: &str = "new_local_repo";
const GIT_SETUP_ACTION_INITIALIZE_REPO: &str = "initialize_repo";
const GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT: &str = "create_initial_commit";
const GIT_SETUP_ACTION_CREATE_DEVELOP: &str = "create_develop";
const INITIAL_COMMIT_PREVIEW_LIMIT: usize = 20;
const PROJECT_GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROJECT_WSL_PREVIEW_TIMEOUT: Duration = Duration::from_secs(5);
const NEW_REPO_OWNERSHIP_MARKER: &str = ".macro-create-in-progress";

static WORKSPACE_STATE_LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    OnceLock::new();
static NEW_REPO_TARGET_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    OnceLock::new();
#[cfg(test)]
static CANCEL_NEW_REPO_AFTER_INIT_PATHS: OnceLock<StdMutex<HashSet<PathBuf>>> = OnceLock::new();

#[cfg(test)]
fn new_repo_cancellation_key(project_path: &Path) -> PathBuf {
    std::fs::canonicalize(project_path).unwrap_or_else(|_| {
        project_path
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .and_then(|parent| project_path.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| absolutize_path(project_path))
    })
}

#[cfg(test)]
fn schedule_new_repo_cancellation_after_init(project_path: &Path) {
    CANCEL_NEW_REPO_AFTER_INIT_PATHS
        .get_or_init(|| StdMutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(new_repo_cancellation_key(project_path));
}

#[cfg(test)]
fn take_new_repo_cancellation_after_init(project_path: &Path) -> bool {
    CANCEL_NEW_REPO_AFTER_INIT_PATHS
        .get_or_init(|| StdMutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&new_repo_cancellation_key(project_path))
}

fn workspace_state_lock_key(metadata_root: &Path) -> PathBuf {
    std::fs::canonicalize(metadata_root).unwrap_or_else(|_| absolutize_path(metadata_root))
}

async fn lock_workspace_state(metadata_root: &Path) -> OwnedMutexGuard<()> {
    let key = workspace_state_lock_key(metadata_root);
    let lock = {
        let locks = WORKSPACE_STATE_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

struct WorkspaceFileLock {
    path: PathBuf,
}

impl Drop for WorkspaceFileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.path);
    }
}

fn lock_workspace_state_file(metadata_root: &Path) -> Result<WorkspaceFileLock> {
    std::fs::create_dir_all(metadata_root).map_err(|error| BackendError::Filesystem {
        message: format!("Failed to create workspace metadata directory: {error}"),
    })?;
    let lock_path = metadata_root.join(WORKSPACE_STATE_FILE_LOCK);
    for _ in 0..100 {
        match std::fs::create_dir(&lock_path) {
            Ok(()) => return Ok(WorkspaceFileLock { path: lock_path }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&lock_path)
                    .and_then(|metadata| metadata.modified())
                    .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                    .map(|elapsed| elapsed > Duration::from_secs(30))
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_dir(&lock_path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(BackendError::Filesystem {
                    message: format!("Failed to acquire workspace state lock: {error}"),
                })
            }
        }
    }
    Err(BackendError::Validation(
        "Une autre instance modifie le workspace. Réessayez dans un instant.".to_string(),
    ))
}
const ACCESS_BLOCK_DIRTY_WORKTREE: &str = "dirty_worktree";
const ACCESS_BLOCK_LIVE_TERMINAL: &str = "live_terminal";
const ACCESS_BLOCK_LAST_ACTIONABLE_PLAN: &str = "last_actionable_plan";
const ACCESS_BLOCK_LAST_ACTIONABLE_FEATURE: &str = "last_actionable_feature";
const ACCESS_BLOCK_LAST_ACTIONABLE_TASK: &str = "last_actionable_task";

struct ProjectGitProbe {
    requested_path: PathBuf,
    repo: Option<Repository>,
    resolved_repo_root_path: Option<PathBuf>,
    repo_resolution: &'static str,
}

#[derive(Debug, Clone, Default)]
struct InitialCommitPreview {
    paths: Vec<String>,
    total_count: usize,
    risk_flags: Vec<String>,
}

#[derive(Debug, Clone)]
enum GitSetupRollbackStep {
    RemoveGitDir {
        git_dir_path: PathBuf,
    },
    RemoveBranch {
        repo_root_path: PathBuf,
        branch_name: String,
    },
    ResetInitialCommit {
        repo_root_path: PathBuf,
        head_reference_name: String,
    },
}

fn count_projects(groups: &[ProjectGroupDto]) -> usize {
    groups.iter().map(|group| group.projects.len()).sum()
}

fn count_registry_projects(
    standalone_projects: &[ProjectDto],
    groups: &[ProjectGroupDto],
) -> usize {
    standalone_projects.len() + count_projects(groups)
}

fn short_oid(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

fn absolutize_path(path: &Path) -> PathBuf {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };

    std::fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn classify_project_path(
    workspace_path: &Path,
    project_path: Option<&str>,
) -> Option<ProjectPathKind> {
    let project_path = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if let Some(wsl_path) = parse_wsl_unc_path(project_path) {
        return Some(ProjectPathKind::Wsl(wsl_path));
    }
    Some(ProjectPathKind::Windows(resolve_project_path(
        workspace_path,
        project_path,
    )))
}

fn ensure_not_cancelled(cancel_rx: Option<&watch::Receiver<bool>>) -> Result<()> {
    if cancel_rx.map(|rx| *rx.borrow()).unwrap_or(false) {
        Err(BackendError::Validation(
            "Project operation cancelled.".to_string(),
        ))
    } else {
        Ok(())
    }
}

fn normalize_repo_resolution(
    requested_path: &Path,
    repo_root_path: Option<&Path>,
    repo_detected: bool,
) -> &'static str {
    if !repo_detected {
        return GIT_RESOLUTION_NEW_LOCAL_REPO;
    }

    match repo_root_path {
        Some(repo_root_path)
            if normalized_path_key(repo_root_path) == normalized_path_key(requested_path) =>
        {
            GIT_RESOLUTION_SELECTED_FOLDER
        }
        Some(_) => GIT_RESOLUTION_PARENT_REPO,
        None => GIT_RESOLUTION_NONE,
    }
}

fn resolve_project_git_probe(
    workspace_path: &Path,
    project_path: Option<&str>,
) -> Option<ProjectGitProbe> {
    let project_path = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let requested_path = resolve_project_path(workspace_path, project_path);
    let mut probe_path = requested_path.clone();
    while !probe_path.exists() && probe_path.pop() {}

    let repo = Repository::discover(&probe_path)
        .or_else(|_| Repository::open(&probe_path))
        .ok();
    let resolved_repo_root_path = repo
        .as_ref()
        .map(|repo| resolve_repo_workdir(repo, repo.path()));
    let repo_resolution = normalize_repo_resolution(
        &requested_path,
        resolved_repo_root_path.as_deref(),
        repo.is_some(),
    );

    Some(ProjectGitProbe {
        requested_path,
        repo,
        resolved_repo_root_path,
        repo_resolution,
    })
}

fn collect_initial_commit_risk_flags(path: &str, flags: &mut HashSet<String>) {
    let normalized = path.trim().replace('\\', "/").to_lowercase();
    if normalized.is_empty() {
        return;
    }

    let file_name = normalized.rsplit('/').next().unwrap_or_default();
    if file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.ends_with(".env")
        || file_name.ends_with(".env.local")
    {
        flags.insert("env_file".to_string());
    }

    if normalized
        .split('/')
        .any(|segment| matches!(segment, "node_modules" | ".pnpm" | "vendor"))
    {
        flags.insert("dependency_dir".to_string());
    }

    if normalized.split('/').any(|segment| {
        matches!(
            segment,
            "dist" | "build" | "coverage" | ".next" | "out" | "target"
        )
    }) {
        flags.insert("build_output".to_string());
    }
}

fn collect_initial_commit_preview_for_path(path: &Path) -> InitialCommitPreview {
    if !path.exists() {
        return InitialCommitPreview::default();
    }

    let mut unique_paths = HashSet::new();
    let mut preview_paths = Vec::new();
    let mut risk_flags = HashSet::new();
    let mut walkdir = walkdir::WalkDir::new(path).into_iter();

    while let Some(entry_result) = walkdir.next() {
        let Ok(entry) = entry_result else {
            continue;
        };

        if entry.depth() == 0 {
            continue;
        }

        let Ok(relative_path) = entry.path().strip_prefix(path) else {
            continue;
        };

        if relative_path
            .components()
            .any(|component| component.as_os_str() == OsStr::new(".git"))
        {
            if entry.file_type().is_dir() {
                walkdir.skip_current_dir();
            }
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let normalized_relative_path = relative_path.to_string_lossy().replace('\\', "/");
        if !unique_paths.insert(normalized_relative_path.clone()) {
            continue;
        }

        collect_initial_commit_risk_flags(&normalized_relative_path, &mut risk_flags);
        if preview_paths.len() < INITIAL_COMMIT_PREVIEW_LIMIT {
            preview_paths.push(normalized_relative_path);
        }
    }

    let mut risk_flags = risk_flags.into_iter().collect::<Vec<_>>();
    risk_flags.sort();

    InitialCommitPreview {
        total_count: unique_paths.len(),
        paths: preview_paths,
        risk_flags,
    }
}

fn collect_initial_commit_preview(repo: &Repository) -> Result<InitialCommitPreview> {
    if repo_has_initial_commit(repo) {
        return Ok(InitialCommitPreview::default());
    }

    let statuses = repo
        .statuses(Some(&mut get_status_options()))
        .map_err(|error| BackendError::Git {
            message: format!("Failed to inspect repository status: {}", error),
        })?;
    let mut unique_paths = HashSet::new();
    let mut preview_paths = Vec::new();
    let mut risk_flags = HashSet::new();

    for entry in statuses.iter() {
        let candidate_path = entry
            .path()
            .ok()
            .or_else(|| {
                entry
                    .head_to_index()
                    .and_then(|delta| delta.new_file().path())
                    .and_then(|path| path.to_str())
            })
            .or_else(|| {
                entry
                    .index_to_workdir()
                    .and_then(|delta| delta.new_file().path())
                    .and_then(|path| path.to_str())
            })
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let Some(path) = candidate_path else {
            continue;
        };
        if !unique_paths.insert(path.to_string()) {
            continue;
        }
        collect_initial_commit_risk_flags(path, &mut risk_flags);
        if preview_paths.len() < INITIAL_COMMIT_PREVIEW_LIMIT {
            preview_paths.push(path.to_string());
        }
    }

    let total_count = unique_paths.len();
    let mut risk_flags = risk_flags.into_iter().collect::<Vec<_>>();
    risk_flags.sort();

    Ok(InitialCommitPreview {
        paths: preview_paths,
        total_count,
        risk_flags,
    })
}

fn resolve_unborn_head_branch(repo: &Repository) -> Option<String> {
    repo.find_reference("HEAD")
        .ok()
        .and_then(|reference| {
            reference
                .symbolic_target()
                .ok()
                .flatten()
                .map(str::to_string)
        })
        .and_then(|target| target.rsplit('/').next().map(str::to_string))
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

fn is_auto_detected_branch_family(value: &str, candidates: &[&str]) -> bool {
    let normalized = normalize_base_branch(Some(value));
    candidates.iter().any(|candidate| normalized == *candidate)
}

fn should_auto_update_project_main_branch(value: &str) -> bool {
    is_auto_detected_branch_family(value, AUTO_DETECTED_MAIN_BRANCH_NAMES)
}

fn should_auto_update_project_base_branch(value: &str) -> bool {
    is_auto_detected_branch_family(value, AUTO_DETECTED_BASE_BRANCH_NAMES)
}

fn should_apply_auto_detected_base_branch(
    current_base_branch: &str,
    detected_base_branch: &str,
    detected_main_branch: Option<&str>,
) -> bool {
    let current = normalize_base_branch(Some(current_base_branch));
    let detected_base = normalize_base_branch(Some(detected_base_branch));
    let detected_main = detected_main_branch.map(|branch| normalize_base_branch(Some(branch)));

    !(current == "develop" && detected_main.as_deref() == Some(detected_base.as_str()))
}

fn repo_has_initial_commit(repo: &Repository) -> bool {
    repo.head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .is_some()
}

fn recommended_git_setup_actions(detection: &ProjectGitFlowDetectionDto) -> Vec<String> {
    if detection.setup_state == PROJECT_GIT_DETECTION_NOT_GIT {
        return vec![
            GIT_SETUP_ACTION_INITIALIZE_REPO.to_string(),
            GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string(),
        ];
    }

    if detection.setup_state == PROJECT_GIT_DETECTION_UNBORN {
        return vec![GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string()];
    }

    Vec::new()
}

fn detection_setup_state(
    detection: &crate::git::GitFlowBranchDetection,
    has_initial_commit: bool,
) -> &'static str {
    if !has_initial_commit {
        return PROJECT_GIT_DETECTION_UNBORN;
    }
    if detection.requires_confirmation {
        return PROJECT_GIT_DETECTION_NEEDS_BRANCH_CONFIRMATION;
    }

    PROJECT_GIT_DETECTION_READY
}

fn derive_git_setup_state(detection: &ProjectGitFlowDetectionDto) -> &'static str {
    if !detection.repo_detected {
        PROJECT_GIT_SETUP_NOT_GIT
    } else if !detection.has_initial_commit {
        PROJECT_GIT_SETUP_UNBORN
    } else {
        PROJECT_GIT_SETUP_READY
    }
}

fn derive_project_read_only_reason(
    user_read_only: bool,
    direct_edit: bool,
    git_setup_state: &str,
) -> Option<String> {
    match (user_read_only, direct_edit, git_setup_state) {
        (false, _, PROJECT_GIT_SETUP_READY) => None,
        (true, _, PROJECT_GIT_SETUP_READY) => Some(READ_ONLY_REASON_MANUAL.to_string()),
        (false, true, PROJECT_GIT_SETUP_NOT_GIT) => None,
        (false, false, PROJECT_GIT_SETUP_NOT_GIT) => Some(READ_ONLY_REASON_MISSING_GIT.to_string()),
        (true, _, PROJECT_GIT_SETUP_NOT_GIT) => {
            Some(READ_ONLY_REASON_MANUAL_AND_MISSING_GIT.to_string())
        }
        (_, _, PROJECT_GIT_SETUP_UNBORN) => {
            Some(READ_ONLY_REASON_MISSING_INITIAL_COMMIT.to_string())
        }
        _ => None,
    }
}

fn project_is_read_only(project: &ProjectDto) -> bool {
    project.user_read_only
        || (project.git_setup_state != PROJECT_GIT_SETUP_READY
            && !(project.git_setup_state == PROJECT_GIT_SETUP_NOT_GIT && project.direct_edit))
}

fn enrich_project_location(mut project: ProjectDto) -> ProjectDto {
    if let Some(wsl_path) = parse_wsl_unc_path(&project.path) {
        project.path_kind = "wsl".to_string();
        project.wsl_distro = Some(wsl_path.distro);
        project.wsl_linux_path = Some(wsl_path.linux_path);
    } else {
        project.path_kind = "windows".to_string();
        project.wsl_distro = None;
        project.wsl_linux_path = None;
    }
    project
}

fn strip_project_location(mut project: ProjectDto) -> ProjectDto {
    project.path_kind = "windows".to_string();
    project.wsl_distro = None;
    project.wsl_linux_path = None;
    project
}

fn strip_workspace_project_locations(mut state: WorkspaceState) -> WorkspaceState {
    state.standalone_projects = state
        .standalone_projects
        .into_iter()
        .map(strip_project_location)
        .collect();
    state.project_groups = state
        .project_groups
        .into_iter()
        .map(|mut group| {
            group.projects = group
                .projects
                .into_iter()
                .map(strip_project_location)
                .collect();
            group
        })
        .collect();
    state
}

fn normalize_project_access(mut project: ProjectDto, git_setup_state: &str) -> ProjectDto {
    project.git_setup_state = git_setup_state.to_string();
    if git_setup_state != PROJECT_GIT_SETUP_NOT_GIT {
        project.direct_edit = false;
    }
    project.is_read_only = project_is_read_only(&ProjectDto {
        git_setup_state: git_setup_state.to_string(),
        ..project.clone()
    });
    project.read_only_reason = derive_project_read_only_reason(
        project.user_read_only,
        project.direct_edit,
        git_setup_state,
    );
    enrich_project_location(project)
}

fn empty_git_flow_detection() -> ProjectGitFlowDetectionDto {
    ProjectGitFlowDetectionDto {
        repo_detected: false,
        branches: Vec::new(),
        current_branch: None,
        suggested_main_branch: None,
        suggested_base_branch: None,
        suggested_commit_branch: None,
        requires_confirmation: false,
        setup_state: PROJECT_GIT_DETECTION_NOT_GIT.to_string(),
        has_initial_commit: false,
        resolved_repo_root_path: None,
        repo_resolution: GIT_RESOLUTION_NONE.to_string(),
        initial_commit_preview_paths: Vec::new(),
        initial_commit_preview_count: 0,
        initial_commit_risk_flags: Vec::new(),
        recommended_action_sequence: Vec::new(),
    }
}

fn project_operation_cancelled_error() -> BackendError {
    BackendError::Validation("Project operation cancelled.".to_string())
}

fn wsl_git_unavailable_error(distro: &str, stderr: &str) -> BackendError {
    let detail = stderr.trim();
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(" ({})", detail)
    };
    BackendError::Git {
        message: format!(
            "Git is not available in WSL distribution '{}'. Install Git in WSL, then try again.{}",
            distro, suffix
        ),
    }
}

async fn wait_for_wsl_command(
    mut command: tokio::process::Command,
    timeout_duration: Duration,
    mut cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<std::process::Output> {
    command.kill_on_drop(true);
    let child = command.spawn().map_err(|error| BackendError::Git {
        message: format!("Failed to start WSL command: {}", error),
    })?;

    let wait_future = child.wait_with_output();
    tokio::pin!(wait_future);

    if let Some(cancel_rx) = cancel_rx.as_mut() {
        tokio::select! {
            result = timeout(timeout_duration, &mut wait_future) => {
                result.map_err(|_| BackendError::Git {
                    message: "Git detection timed out. Check WSL or add the project as read-only.".to_string(),
                })?.map_err(|error| BackendError::Git {
                    message: format!("Failed to run WSL command: {}", error),
                })
            }
            _ = cancel_rx.changed() => {
                Err(project_operation_cancelled_error())
            }
        }
    } else {
        timeout(timeout_duration, &mut wait_future)
            .await
            .map_err(|_| BackendError::Git {
                message: "Git detection timed out. Check WSL or add the project as read-only."
                    .to_string(),
            })?
            .map_err(|error| BackendError::Git {
                message: format!("Failed to run WSL command: {}", error),
            })
    }
}

async fn run_wsl_git(
    wsl_path: &WslProjectPath,
    args: &[&str],
    timeout_duration: Duration,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<std::process::Output> {
    let mut command = background_tokio_command("wsl.exe");
    command
        .arg("-d")
        .arg(&wsl_path.distro)
        .arg("--")
        .arg("git")
        .arg("-C")
        .arg(&wsl_path.linux_path);
    for arg in args {
        command.arg(arg);
    }
    wait_for_wsl_command(command, timeout_duration, cancel_rx).await
}

fn output_stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn output_stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

async fn run_wsl_git_required(
    wsl_path: &WslProjectPath,
    args: &[&str],
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<String> {
    let output = run_wsl_git(wsl_path, args, PROJECT_GIT_PROBE_TIMEOUT, cancel_rx).await?;
    if output.status.success() {
        Ok(output_stdout(&output))
    } else {
        Err(wsl_git_unavailable_error(
            &wsl_path.distro,
            &output_stderr(&output),
        ))
    }
}

async fn run_wsl_git_optional(
    wsl_path: &WslProjectPath,
    args: &[&str],
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<Option<String>> {
    let output = run_wsl_git(wsl_path, args, PROJECT_GIT_PROBE_TIMEOUT, cancel_rx).await?;
    if output.status.success() {
        Ok(Some(output_stdout(&output)))
    } else {
        Ok(None)
    }
}

async fn collect_initial_commit_preview_for_wsl_path(
    wsl_path: &WslProjectPath,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<InitialCommitPreview> {
    let script = format!(
        "cd \"$1\" 2>/dev/null || exit 0; find . -path './.git' -prune -o -type f -print | sed 's#^./##' | head -n {}",
        INITIAL_COMMIT_PREVIEW_LIMIT
    );
    let mut command = background_tokio_command("wsl.exe");
    command
        .arg("-d")
        .arg(&wsl_path.distro)
        .arg("--")
        .arg("sh")
        .arg("-lc")
        .arg(script)
        .arg("macro-wsl-preview")
        .arg(&wsl_path.linux_path);
    let output = wait_for_wsl_command(command, PROJECT_WSL_PREVIEW_TIMEOUT, cancel_rx).await?;
    if !output.status.success() {
        return Ok(InitialCommitPreview::default());
    }

    let mut risk_flags = HashSet::new();
    let paths = output_stdout(&output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .inspect(|path| collect_initial_commit_risk_flags(path, &mut risk_flags))
        .collect::<Vec<_>>();
    let mut risk_flags = risk_flags.into_iter().collect::<Vec<_>>();
    risk_flags.sort();

    Ok(InitialCommitPreview {
        total_count: paths.len(),
        paths,
        risk_flags,
    })
}

async fn detect_wsl_project_git_flow(
    wsl_path: &WslProjectPath,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectGitFlowDetectionDto> {
    ensure_not_cancelled(cancel_rx.as_ref())?;
    let inside = run_wsl_git_required(
        wsl_path,
        &["rev-parse", "--is-inside-work-tree"],
        cancel_rx.clone(),
    )
    .await;

    if inside.is_err() {
        let preview = collect_initial_commit_preview_for_wsl_path(wsl_path, cancel_rx.clone())
            .await
            .unwrap_or_default();
        let probe = ProjectGitProbe {
            requested_path: PathBuf::from(format!(
                r"\\wsl.localhost\{}\{}",
                wsl_path.distro,
                wsl_path
                    .linux_path
                    .trim_start_matches('/')
                    .replace('/', "\\")
            )),
            repo: None,
            resolved_repo_root_path: Some(PathBuf::from(format!(
                r"\\wsl.localhost\{}\{}",
                wsl_path.distro,
                wsl_path
                    .linux_path
                    .trim_start_matches('/')
                    .replace('/', "\\")
            ))),
            repo_resolution: GIT_RESOLUTION_NEW_LOCAL_REPO,
        };
        return Ok(build_project_git_flow_detection(
            &probe, None, false, preview,
        ));
    }

    let repo_root = run_wsl_git_required(
        wsl_path,
        &["rev-parse", "--show-toplevel"],
        cancel_rx.clone(),
    )
    .await?;
    let has_initial_commit = run_wsl_git_optional(
        wsl_path,
        &["rev-parse", "--verify", "HEAD"],
        cancel_rx.clone(),
    )
    .await?
    .is_some();
    let current_branch = run_wsl_git_optional(
        wsl_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        cancel_rx.clone(),
    )
    .await?;
    let branches_output = run_wsl_git_optional(
        wsl_path,
        &["branch", "--format=%(refname:short)"],
        cancel_rx.clone(),
    )
    .await?
    .unwrap_or_default();
    let branches = branches_output
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let suggested_main = ["main", "master"]
        .iter()
        .find(|candidate| branches.iter().any(|branch| branch == **candidate))
        .map(|value| (*value).to_string())
        .or_else(|| current_branch.clone())
        .or_else(|| branches.first().cloned())
        .unwrap_or_else(|| "main".to_string());
    let suggested_base = ["develop", "dev"]
        .iter()
        .find(|candidate| branches.iter().any(|branch| branch == **candidate))
        .map(|value| (*value).to_string())
        .unwrap_or_else(|| suggested_main.clone());
    let requires_confirmation = !["main", "master"].contains(&suggested_main.as_str())
        && suggested_base == suggested_main
        && has_initial_commit;
    let setup_state = if !has_initial_commit {
        PROJECT_GIT_DETECTION_UNBORN
    } else if requires_confirmation {
        PROJECT_GIT_DETECTION_NEEDS_BRANCH_CONFIRMATION
    } else {
        PROJECT_GIT_DETECTION_READY
    };
    let initial_commit_preview = if has_initial_commit {
        InitialCommitPreview::default()
    } else {
        collect_initial_commit_preview_for_wsl_path(wsl_path, cancel_rx.clone())
            .await
            .unwrap_or_default()
    };

    let mut detection = ProjectGitFlowDetectionDto {
        repo_detected: true,
        branches,
        current_branch: current_branch.clone(),
        suggested_main_branch: Some(suggested_main.clone()),
        suggested_base_branch: Some(suggested_base),
        suggested_commit_branch: current_branch.or(Some(suggested_main)),
        requires_confirmation,
        setup_state: setup_state.to_string(),
        has_initial_commit,
        resolved_repo_root_path: Some(format!(
            r"\\wsl.localhost\{}\{}",
            wsl_path.distro,
            repo_root.trim_start_matches('/').replace('/', "\\")
        )),
        repo_resolution: normalize_repo_resolution(
            Path::new(&wsl_path.linux_path),
            Some(Path::new(&repo_root)),
            true,
        )
        .to_string(),
        initial_commit_preview_paths: initial_commit_preview.paths,
        initial_commit_preview_count: initial_commit_preview.total_count,
        initial_commit_risk_flags: initial_commit_preview.risk_flags,
        recommended_action_sequence: Vec::new(),
    };
    detection.recommended_action_sequence = recommended_git_setup_actions(&detection);
    Ok(detection)
}

fn build_project_git_flow_detection(
    probe: &ProjectGitProbe,
    detection: Option<crate::git::GitFlowBranchDetection>,
    has_initial_commit: bool,
    initial_commit_preview: InitialCommitPreview,
) -> ProjectGitFlowDetectionDto {
    let (
        branches,
        current_branch,
        suggested_main_branch,
        suggested_base_branch,
        suggested_commit_branch,
        requires_confirmation,
    ) = match detection {
        Some(detection) => (
            detection.branch_candidates,
            detection.current_branch,
            detection.main_branch,
            detection.base_branch,
            detection.commit_branch,
            detection.requires_confirmation,
        ),
        None if probe.repo.is_some() => {
            let unborn_branch = probe
                .repo
                .as_ref()
                .and_then(resolve_unborn_head_branch)
                .unwrap_or_else(|| "main".to_string());
            (
                vec![unborn_branch.clone()],
                Some(unborn_branch.clone()),
                Some(unborn_branch.clone()),
                Some(unborn_branch.clone()),
                Some(unborn_branch),
                false,
            )
        }
        None => (
            Vec::new(),
            None,
            Some("main".to_string()),
            Some("main".to_string()),
            Some("main".to_string()),
            false,
        ),
    };
    let setup_state = if probe.repo.is_none() {
        PROJECT_GIT_DETECTION_NOT_GIT.to_string()
    } else if !has_initial_commit {
        PROJECT_GIT_DETECTION_UNBORN.to_string()
    } else {
        detection_setup_state(
            &crate::git::GitFlowBranchDetection {
                branch_candidates: branches.clone(),
                current_branch: current_branch.clone(),
                main_branch: suggested_main_branch.clone(),
                base_branch: suggested_base_branch.clone(),
                commit_branch: suggested_commit_branch.clone(),
                requires_confirmation,
            },
            has_initial_commit,
        )
        .to_string()
    };

    let mut detection = ProjectGitFlowDetectionDto {
        repo_detected: probe.repo.is_some(),
        branches,
        current_branch,
        suggested_main_branch,
        suggested_base_branch,
        suggested_commit_branch,
        requires_confirmation,
        setup_state,
        has_initial_commit,
        resolved_repo_root_path: probe
            .resolved_repo_root_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .or_else(|| {
                if probe.repo.is_some() {
                    None
                } else {
                    Some(probe.requested_path.to_string_lossy().to_string())
                }
            }),
        repo_resolution: probe.repo_resolution.to_string(),
        initial_commit_preview_paths: initial_commit_preview.paths,
        initial_commit_preview_count: initial_commit_preview.total_count,
        initial_commit_risk_flags: initial_commit_preview.risk_flags,
        recommended_action_sequence: Vec::new(),
    };
    detection.recommended_action_sequence = recommended_git_setup_actions(&detection);
    detection
}

fn detect_project_git_flow_internal(
    workspace_path: &Path,
    project_path: Option<&str>,
) -> ProjectGitFlowDetectionDto {
    let Some(probe) = resolve_project_git_probe(workspace_path, project_path) else {
        return empty_git_flow_detection();
    };

    let Some(repo) = probe.repo.as_ref() else {
        let preview = collect_initial_commit_preview_for_path(&probe.requested_path);
        return build_project_git_flow_detection(&probe, None, false, preview);
    };

    let has_initial_commit = repo_has_initial_commit(repo);
    if !has_initial_commit {
        let preview = collect_initial_commit_preview(repo).unwrap_or_default();
        return build_project_git_flow_detection(&probe, None, false, preview);
    }

    let detected = detect_preferred_git_flow_branches(repo);
    build_project_git_flow_detection(
        &probe,
        Some(detected),
        true,
        InitialCommitPreview::default(),
    )
}

pub fn detect_project_git_flow(
    workspace_path: &Path,
    project_path: Option<&str>,
) -> ProjectGitFlowDetectionDto {
    detect_project_git_flow_internal(workspace_path, project_path)
}

async fn detect_project_git_flow_for_add(
    workspace_path: &Path,
    project_path: Option<&str>,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectGitFlowDetectionDto> {
    ensure_not_cancelled(cancel_rx.as_ref())?;
    match classify_project_path(workspace_path, project_path) {
        Some(ProjectPathKind::Wsl(wsl_path)) => {
            detect_wsl_project_git_flow(&wsl_path, cancel_rx).await
        }
        Some(ProjectPathKind::Windows(_)) => Ok(detect_project_git_flow_internal(
            workspace_path,
            project_path,
        )),
        None => Ok(empty_git_flow_detection()),
    }
}

fn resolve_repo_workdir(repo: &Repository, fallback: &Path) -> PathBuf {
    let workdir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| fallback.to_path_buf());
    absolutize_path(&workdir)
}

fn create_initial_commit(repo: &Repository) -> Result<Option<String>> {
    if repo_has_initial_commit(repo) {
        return Ok(None);
    }

    let repo_root = resolve_repo_workdir(repo, repo.path());
    let head_reference_name = repo
        .find_reference("HEAD")
        .ok()
        .and_then(|reference| {
            reference
                .symbolic_target()
                .ok()
                .flatten()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "refs/heads/main".to_string());
    let mut index = repo.index().map_err(|e| BackendError::Git {
        message: format!("Failed to open repository index: {}", e),
    })?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| BackendError::Git {
            message: format!(
                "Failed to stage initial repository contents at {}: {}",
                repo_root.display(),
                e
            ),
        })?;
    index.write().map_err(|e| BackendError::Git {
        message: format!("Failed to write repository index: {}", e),
    })?;
    let tree_id = index.write_tree().map_err(|e| BackendError::Git {
        message: format!("Failed to write initial tree: {}", e),
    })?;
    let tree = repo.find_tree(tree_id).map_err(|e| BackendError::Git {
        message: format!("Failed to load initial tree: {}", e),
    })?;
    let signature = repo
        .signature()
        .or_else(|_| Signature::now("Macro", "macro@local"))
        .map_err(|e| BackendError::Git {
            message: format!("Failed to create initial commit signature: {}", e),
        })?;
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "chore(git): initialize repository",
        &tree,
        &[],
    )
    .map_err(|e| BackendError::Git {
        message: format!("Failed to create initial repository commit: {}", e),
    })?;
    Ok(Some(head_reference_name))
}

fn create_develop_branch(repo: &Repository, from_ref: &str) -> Result<bool> {
    if repo
        .find_branch("develop", BranchType::Local)
        .map(|_| true)
        .or_else(|error| {
            if error.code() == git2::ErrorCode::NotFound {
                Ok(false)
            } else {
                Err(error)
            }
        })
        .map_err(|error| BackendError::Git {
            message: format!("Failed to inspect develop branch: {}", error),
        })?
    {
        return Ok(false);
    }

    let target = repo
        .revparse_single(from_ref)
        .and_then(|object| object.peel_to_commit())
        .map_err(|error| BackendError::Git {
            message: format!("Failed to resolve branch source '{}': {}", from_ref, error),
        })?;
    repo.branch("develop", &target, false)
        .map_err(|error| BackendError::Git {
            message: format!("Failed to create develop branch: {}", error),
        })?;
    Ok(true)
}

pub fn preview_project_git_setup(
    workspace_path: &Path,
    project_path: Option<&str>,
) -> ProjectGitFlowDetectionDto {
    detect_project_git_flow_internal(workspace_path, project_path)
}

pub async fn preview_project_git_setup_async(
    workspace_path: &Path,
    project_path: Option<&str>,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectGitFlowDetectionDto> {
    detect_project_git_flow_for_add(workspace_path, project_path, cancel_rx).await
}

fn normalize_git_setup_actions(actions: &[String]) -> Vec<String> {
    actions
        .iter()
        .map(|action| action.trim().to_string())
        .filter(|action| !action.is_empty())
        .collect()
}

fn git_setup_actions_are_prefix(requested: &[String], recommended: &[String]) -> bool {
    requested.len() <= recommended.len()
        && requested
            .iter()
            .zip(recommended.iter())
            .all(|(requested_action, recommended_action)| requested_action == recommended_action)
}

async fn validate_project_git_setup_commit(
    workspace_path: &Path,
    project_path: &str,
    requested_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectGitFlowDetectionDto> {
    let detection =
        detect_project_git_flow_for_add(workspace_path, Some(project_path), cancel_rx).await?;
    let normalized_requested_actions = normalize_git_setup_actions(requested_actions);
    let normalized_expected_recommended_actions =
        normalize_git_setup_actions(expected_recommended_action_sequence);
    let normalized_actual_recommended_actions =
        normalize_git_setup_actions(&detection.recommended_action_sequence);

    if let Some(expected_repo_root_path) = expected_repo_root_path {
        let expected_path_key = normalized_path_key(Path::new(expected_repo_root_path));
        let actual_repo_root = detection
            .resolved_repo_root_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| resolve_project_path(workspace_path, project_path));
        let actual_path_key = normalized_path_key(&actual_repo_root);
        if expected_path_key != actual_path_key {
            return Err(BackendError::Validation(
                "Project Git setup target changed. Refresh and try again.".to_string(),
            ));
        }
    }

    if detection.setup_state != expected_setup_state.trim() {
        return Err(BackendError::Validation(
            "Project Git setup state changed. Refresh and try again.".to_string(),
        ));
    }

    if normalized_expected_recommended_actions != normalized_actual_recommended_actions {
        return Err(BackendError::Validation(
            "Project Git setup recommendations changed. Refresh and try again.".to_string(),
        ));
    }

    if !git_setup_actions_are_prefix(
        &normalized_requested_actions,
        &normalized_actual_recommended_actions,
    ) {
        return Err(BackendError::Validation(
            "Selected Git setup actions are no longer valid. Refresh and try again.".to_string(),
        ));
    }

    Ok(detection)
}

fn rollback_git_setup_step(step: &GitSetupRollbackStep) -> Result<()> {
    match step {
        GitSetupRollbackStep::RemoveGitDir { git_dir_path } => {
            if git_dir_path.exists() {
                std::fs::remove_dir_all(git_dir_path).map_err(|error| {
                    BackendError::Filesystem {
                        message: format!(
                            "Failed to remove Git metadata directory {} during rollback: {}",
                            git_dir_path.display(),
                            error
                        ),
                    }
                })?;
            }
        }
        GitSetupRollbackStep::RemoveBranch {
            repo_root_path,
            branch_name,
        } => {
            let repo = Repository::open(repo_root_path).map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to reopen repository {} during rollback: {}",
                    repo_root_path.display(),
                    error
                ),
            })?;
            let branch_result = repo.find_branch(branch_name, BranchType::Local);
            if let Ok(mut branch) = branch_result {
                branch.delete().map_err(|error| BackendError::Git {
                    message: format!(
                        "Failed to delete branch '{}' during rollback: {}",
                        branch_name, error
                    ),
                })?;
            }
        }
        GitSetupRollbackStep::ResetInitialCommit {
            repo_root_path,
            head_reference_name,
        } => {
            let repo = Repository::open(repo_root_path).map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to reopen repository {} during rollback: {}",
                    repo_root_path.display(),
                    error
                ),
            })?;
            if let Ok(mut reference) = repo.find_reference(head_reference_name) {
                reference.delete().map_err(|error| BackendError::Git {
                    message: format!(
                        "Failed to delete initial branch ref '{}' during rollback: {}",
                        head_reference_name, error
                    ),
                })?;
            }
            repo.reference_symbolic("HEAD", head_reference_name, true, "rollback initial commit")
                .map_err(|error| BackendError::Git {
                    message: format!(
                        "Failed to restore unborn HEAD '{}' during rollback: {}",
                        head_reference_name, error
                    ),
                })?;
            let mut index = repo.index().map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to reopen repository index during rollback: {}",
                    error
                ),
            })?;
            index.clear().map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to clear repository index during rollback: {}",
                    error
                ),
            })?;
            index.write().map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to persist repository index during rollback: {}",
                    error
                ),
            })?;
        }
    }

    Ok(())
}

fn rollback_git_setup_steps(rollback_steps: &[GitSetupRollbackStep]) -> Result<()> {
    for step in rollback_steps.iter().rev() {
        rollback_git_setup_step(step)?;
    }

    Ok(())
}

fn apply_git_setup_action(
    workspace_path: &Path,
    project_path: &str,
    detection: &ProjectGitFlowDetectionDto,
    action: &str,
    rollback_steps: &mut Vec<GitSetupRollbackStep>,
) -> Result<()> {
    let resolved_project_path = resolve_project_path(workspace_path, project_path);
    let existing_probe = resolve_project_git_probe(workspace_path, Some(project_path))
        .ok_or_else(|| BackendError::Validation("Project path is required".to_string()))?;

    match action {
        GIT_SETUP_ACTION_INITIALIZE_REPO => {
            if existing_probe.repo.is_none() {
                let mut opts = RepositoryInitOptions::new();
                opts.initial_head("main");
                let repo =
                    Repository::init_opts(&resolved_project_path, &opts).map_err(|error| {
                        BackendError::Git {
                            message: format!(
                                "Failed to initialize git repository at {}: {}",
                                resolved_project_path.display(),
                                error
                            ),
                        }
                    })?;
                rollback_steps.push(GitSetupRollbackStep::RemoveGitDir {
                    git_dir_path: repo.path().to_path_buf(),
                });
            }
        }
        GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT => {
            let repo = existing_probe.repo.ok_or_else(|| {
                BackendError::Validation(
                    "Git must be initialized before creating the initial commit.".to_string(),
                )
            })?;
            if let Some(head_reference_name) = create_initial_commit(&repo)? {
                rollback_steps.push(GitSetupRollbackStep::ResetInitialCommit {
                    repo_root_path: resolve_repo_workdir(&repo, repo.path()),
                    head_reference_name,
                });
            }
        }
        GIT_SETUP_ACTION_CREATE_DEVELOP => {
            let repo = existing_probe.repo.ok_or_else(|| {
                BackendError::Validation(
                    "Git must be initialized before creating the develop branch.".to_string(),
                )
            })?;
            let source_branch = detection
                .suggested_main_branch
                .clone()
                .or_else(|| detection.suggested_commit_branch.clone())
                .or_else(|| detection.current_branch.clone())
                .unwrap_or_else(|| "main".to_string());
            if create_develop_branch(&repo, &source_branch)? {
                rollback_steps.push(GitSetupRollbackStep::RemoveBranch {
                    repo_root_path: resolve_repo_workdir(&repo, repo.path()),
                    branch_name: "develop".to_string(),
                });
            }
        }
        _ => {
            return Err(BackendError::Validation(format!(
                "Unsupported project Git setup action: {}",
                action
            )));
        }
    }

    Ok(())
}

fn wsl_git_setup_action_command(
    action: &str,
    source_branch: Option<&str>,
) -> Result<(&'static str, Vec<String>)> {
    match action {
        GIT_SETUP_ACTION_INITIALIZE_REPO => Ok((
            r#"if [ ! -d "$1/.git" ]; then git -C "$1" init -b main; fi"#,
            Vec::new(),
        )),
        GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT => Ok((
            r#"git -C "$1" config user.name >/dev/null 2>&1 || git -C "$1" config user.name Macro
git -C "$1" config user.email >/dev/null 2>&1 || git -C "$1" config user.email macro@local
git -C "$1" add -A
git -C "$1" diff --cached --quiet && git -C "$1" commit --allow-empty -m "chore(git): initialize repository" || git -C "$1" commit -m "chore(git): initialize repository""#,
            Vec::new(),
        )),
        GIT_SETUP_ACTION_CREATE_DEVELOP => Ok((
            r#"git -C "$1" show-ref --verify --quiet refs/heads/develop || git -C "$1" branch develop "$2""#,
            vec![source_branch.unwrap_or("main").to_string()],
        )),
        _ => Err(BackendError::Validation(format!(
            "Unsupported project Git setup action: {}",
            action
        ))),
    }
}

async fn apply_wsl_git_setup_action(
    wsl_path: &WslProjectPath,
    detection: &ProjectGitFlowDetectionDto,
    action: &str,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<()> {
    let source_branch = if action == GIT_SETUP_ACTION_CREATE_DEVELOP {
        Some(
            detection
                .suggested_main_branch
                .clone()
                .or_else(|| detection.suggested_commit_branch.clone())
                .or_else(|| detection.current_branch.clone())
                .unwrap_or_else(|| "main".to_string()),
        )
    } else {
        None
    };
    let (script, additional_args) = wsl_git_setup_action_command(action, source_branch.as_deref())?;

    let output = run_wsl_shell_with_args(
        wsl_path,
        script,
        &additional_args,
        Duration::from_secs(12),
        cancel_rx,
    )
    .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(BackendError::Git {
            message: format!(
                "Failed to apply WSL Git setup action: {}",
                output_stderr(&output)
            ),
        })
    }
}

async fn execute_project_git_setup_commit<T, F, Fut>(
    workspace_path: &Path,
    project_path: &str,
    git_setup_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
    cancel_rx: Option<watch::Receiver<bool>>,
    persist_operation: F,
) -> Result<(T, ProjectGitFlowDetectionDto)>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let normalized_actions = normalize_git_setup_actions(git_setup_actions);
    tracing::info!(
        action = "git_setup_commit_started",
        project_path = %project_path,
        requested_actions = ?normalized_actions,
        expected_setup_state = %expected_setup_state.trim(),
        expected_repo_root_path = ?expected_repo_root_path
    );

    ensure_not_cancelled(cancel_rx.as_ref())?;
    let detection = validate_project_git_setup_commit(
        workspace_path,
        project_path,
        &normalized_actions,
        expected_repo_root_path,
        expected_setup_state,
        expected_recommended_action_sequence,
        cancel_rx.clone(),
    )
    .await?;

    let mut rollback_steps = Vec::new();
    if !normalized_actions.is_empty() {
        ensure_project_directory_for_add(
            workspace_path,
            project_path,
            "project_git_setup",
            cancel_rx.clone(),
        )
        .await?;
    }

    if let Some(wsl_path) = parse_wsl_unc_path(project_path) {
        for action in normalized_actions.iter() {
            ensure_not_cancelled(cancel_rx.as_ref())?;
            apply_wsl_git_setup_action(&wsl_path, &detection, action, cancel_rx.clone()).await?;
        }
    } else {
        for action in normalized_actions.iter() {
            ensure_not_cancelled(cancel_rx.as_ref())?;
            apply_git_setup_action(
                workspace_path,
                project_path,
                &detection,
                action,
                &mut rollback_steps,
            )?;
        }
    }

    match persist_operation().await {
        Ok(result) => {
            let next_detection =
                detect_project_git_flow_for_add(workspace_path, Some(project_path), cancel_rx)
                    .await?;
            tracing::info!(
                action = "git_setup_commit_succeeded",
                project_path = %project_path,
                requested_actions = ?normalized_actions,
                resulting_setup_state = %next_detection.setup_state
            );
            Ok((result, next_detection))
        }
        Err(error) => match rollback_git_setup_steps(&rollback_steps) {
            Ok(()) => {
                tracing::warn!(
                    action = "git_setup_commit_rolled_back",
                    project_path = %project_path,
                    requested_actions = ?normalized_actions,
                    rollback_step_count = rollback_steps.len()
                );
                Err(error)
            }
            Err(rollback_error) => {
                tracing::error!(
                    action = "git_setup_commit_partial_rollback_failure",
                    project_path = %project_path,
                    requested_actions = ?normalized_actions,
                    rollback_step_count = rollback_steps.len(),
                    error = %error,
                    rollback_error = %rollback_error
                );
                Err(BackendError::Internal {
                        message: format!(
                            "Project Git setup failed and rollback was only partially applied: {}; rollback error: {}",
                            error, rollback_error
                        ),
                    })
            }
        },
    }
}

pub async fn create_project_with_git_setup(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateProjectRequest,
    git_setup_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    let project_path = request.path.clone().ok_or_else(|| {
        BackendError::Validation(
            "Project path is required when committing project Git setup.".to_string(),
        )
    })?;
    let (project, detection) = execute_project_git_setup_commit(
        workspace_path,
        &project_path,
        git_setup_actions,
        expected_repo_root_path,
        expected_setup_state,
        expected_recommended_action_sequence,
        cancel_rx.clone(),
        || create_project_with_cancel(workspace_path, metadata_root, request, cancel_rx.clone()),
    )
    .await?;

    Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
}

pub struct UpdateProjectGitFlowWithSetupInput<'a> {
    pub project_id: &'a str,
    pub git_flow_settings: &'a ProjectGitFlowSettingsDto,
    pub git_setup_actions: &'a [String],
    pub expected_repo_root_path: Option<&'a str>,
    pub expected_setup_state: &'a str,
    pub expected_recommended_action_sequence: &'a [String],
}

pub async fn update_project_git_flow_with_setup(
    workspace_path: &Path,
    metadata_root: &Path,
    input: UpdateProjectGitFlowWithSetupInput<'_>,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    let UpdateProjectGitFlowWithSetupInput {
        project_id,
        git_flow_settings,
        git_setup_actions,
        expected_repo_root_path,
        expected_setup_state,
        expected_recommended_action_sequence,
    } = input;

    let state = load_or_create_state(workspace_path, metadata_root).await?;
    let project = find_project_by_id_in_state(&state, project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    let project_path = project.path.clone();

    let (project, detection) = execute_project_git_setup_commit(
        workspace_path,
        &project_path,
        git_setup_actions,
        expected_repo_root_path,
        expected_setup_state,
        expected_recommended_action_sequence,
        None,
        || update_project_git_flow(workspace_path, metadata_root, project_id, git_flow_settings),
    )
    .await?;

    Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
}

pub async fn refresh_project_registry_state(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<()> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let state = load_or_create_state(workspace_path, metadata_root).await?;
    let _ = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "refresh_project_registry_state",
    )
    .await?;
    Ok(())
}

fn auto_detect_project_git_flow_settings(
    workspace_path: &Path,
    project_path: &str,
    settings: Option<&ProjectGitFlowSettingsDto>,
) -> ProjectGitFlowSettingsDto {
    let mut normalized = normalize_project_git_flow_settings(settings);
    let detected = detect_project_git_flow_internal(workspace_path, Some(project_path));
    if !detected.repo_detected || !detected.has_initial_commit || detected.requires_confirmation {
        return normalized;
    }

    if should_auto_update_project_main_branch(&normalized.main_branch) {
        if let Some(main_branch) = detected
            .suggested_main_branch
            .clone()
            .or_else(|| detected.suggested_commit_branch.clone())
        {
            normalized.main_branch = main_branch;
        }
    }

    if should_auto_update_project_base_branch(&normalized.base_branch) {
        if let Some(base_branch) = detected
            .suggested_base_branch
            .clone()
            .or_else(|| detected.suggested_main_branch.clone())
            .or_else(|| detected.suggested_commit_branch.clone())
        {
            if should_apply_auto_detected_base_branch(
                &normalized.base_branch,
                &base_branch,
                detected.suggested_main_branch.as_deref(),
            ) {
                normalized.base_branch = base_branch;
            }
        }
    }

    normalized
}

fn auto_detect_project_git_flow_settings_from_detection(
    settings: Option<&ProjectGitFlowSettingsDto>,
    detected: &ProjectGitFlowDetectionDto,
) -> ProjectGitFlowSettingsDto {
    let mut normalized = normalize_project_git_flow_settings(settings);
    if !detected.repo_detected || !detected.has_initial_commit || detected.requires_confirmation {
        return normalized;
    }

    if should_auto_update_project_main_branch(&normalized.main_branch) {
        if let Some(main_branch) = detected
            .suggested_main_branch
            .clone()
            .or_else(|| detected.suggested_commit_branch.clone())
        {
            normalized.main_branch = main_branch;
        }
    }

    if should_auto_update_project_base_branch(&normalized.base_branch) {
        if let Some(base_branch) = detected
            .suggested_base_branch
            .clone()
            .or_else(|| detected.suggested_main_branch.clone())
            .or_else(|| detected.suggested_commit_branch.clone())
        {
            if should_apply_auto_detected_base_branch(
                &normalized.base_branch,
                &base_branch,
                detected.suggested_main_branch.as_deref(),
            ) {
                normalized.base_branch = base_branch;
            }
        }
    }

    normalized
}

pub async fn get_project_registry_diagnostics(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<ProjectRegistryDiagnosticsDto> {
    let raw_state = load_raw_state(metadata_root).await?.unwrap_or_default();
    let (sanitized_state, repair_report) =
        sanitize_workspace_state(workspace_path, raw_state.clone());

    Ok(ProjectRegistryDiagnosticsDto {
        raw_standalone_projects: raw_state.standalone_projects.clone(),
        raw_group_count: raw_state.project_groups.len(),
        raw_project_count: count_registry_projects(
            &raw_state.standalone_projects,
            &raw_state.project_groups,
        ),
        sanitized_standalone_projects: sanitized_state.standalone_projects.clone(),
        sanitized_group_count: sanitized_state.project_groups.len(),
        sanitized_project_count: count_registry_projects(
            &sanitized_state.standalone_projects,
            &sanitized_state.project_groups,
        ),
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
        standalone_projects: state.standalone_projects,
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

pub async fn get_project_by_id(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
) -> Result<Option<ProjectDto>> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    Ok(find_project_by_id_in_state(&state, project_id).cloned())
}

pub async fn list_tasks(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<WorkspaceTaskCatalogDto> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    let project_count = count_registry_projects(&state.standalone_projects, &state.project_groups);
    let manual_feature_count = state.manual_features.len();
    let manual_tasks = state
        .manual_features
        .iter()
        .map(manual_feature_to_task_value)
        .collect::<Vec<_>>();
    let Some(plan) = state.current_plan else {
        if manual_tasks.is_empty() {
            tracing::warn!(
                action = "workspace_task_catalog_empty",
                reason = "no_current_plan",
                project_count,
                manual_feature_count,
                workspace_path = %workspace_path.display(),
                metadata_root = %metadata_root.display(),
                "Workspace task catalog is empty because no current plan or manual features were found."
            );
        }
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

    if fallback_tasks.is_empty() {
        let empty_reason = if task_count == 0 && !is_executable_plan {
            "non_executable_plan_without_tasks"
        } else if task_count == 0 {
            "executable_plan_without_tasks"
        } else {
            "no_catalog_tasks"
        };
        tracing::warn!(
            action = "workspace_task_catalog_empty",
            reason = empty_reason,
            source = %source,
            plan_id = %plan.id,
            plan_status = %plan.status,
            plan_task_count = task_count,
            manual_feature_count,
            project_count,
            is_executable_plan,
            workspace_path = %workspace_path.display(),
            metadata_root = %metadata_root.display(),
            "Workspace task catalog is empty after loading workspace metadata."
        );
    }

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
    let project_count = count_registry_projects(&state.standalone_projects, &state.project_groups);

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
    context_project_ids: &[String],
    base_branch: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
    task_kind: &str,
) -> Result<ManualFeatureDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let actionable_project_ids = collect_actionable_project_ids_from_state(&state);
    let read_only_project_ids = collect_read_only_project_ids_from_state(&state);
    let normalized_project_ids = sanitize_project_id_list(project_ids, &actionable_project_ids);
    let normalized_context_project_ids =
        sanitize_project_id_list(context_project_ids, &read_only_project_ids);
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
    let normalized_task_kind = normalize_manual_task_kind(task_kind)?;
    validate_manual_task_kind_for_projects(
        normalized_task_kind,
        &normalized_project_ids,
        &state.standalone_projects,
        &state.project_groups,
    )?;

    let direct_edit_project_ids = normalized_project_ids
        .iter()
        .filter(|project_id| {
            find_project_by_id_in_state(&state, project_id)
                .map(|project| {
                    project.direct_edit && project.git_setup_state == PROJECT_GIT_SETUP_NOT_GIT
                })
                .unwrap_or(false)
        })
        .cloned()
        .collect::<HashSet<_>>();
    let conflicting_feature = state.manual_features.iter().find(|feature| {
        feature.archived_at.is_none()
            && feature.status != "Completed"
            && (feature
                .project_ids
                .iter()
                .any(|project_id| direct_edit_project_ids.contains(project_id))
                || feature.execution_targets.iter().any(|target| {
                    target.execution_mode.as_deref() == Some("direct")
                        && normalized_project_ids.contains(&target.project_id)
                }))
    });
    if let Some(feature) = conflicting_feature {
        return Err(BackendError::Validation(format!(
            "Direct-edit project already has an active task: {}",
            feature.title
        )));
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
        task_kind: Some(normalized_task_kind.to_string()),
        branch_name: None,
        archived_at: None,
        archive_reason: None,
        merged_at: None,
        base_branch: normalize_base_branch(base_branch),
        project_ids: normalized_project_ids,
        context_project_ids: normalized_context_project_ids,
        execution_targets: Vec::new(),
        merge_workflow: None,
        created_at: now.clone(),
        updated_at: now,
    };

    state
        .deleted_manual_feature_ids
        .retain(|candidate| candidate != normalized_task_id);
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
    task_kind: &str,
) -> Result<ManualFeatureDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let standalone_projects = state.standalone_projects.clone();
    let project_groups = state.project_groups.clone();
    let normalized_task_id = task_id.trim();
    let feature_index = state
        .manual_features
        .iter()
        .position(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", task_id))
        })?;
    let existing_feature_slug = state.manual_features[feature_index].feature_slug.clone();
    let normalized_title = title.trim();
    let normalized_description = description.trim();
    let normalized_feature_slug = slugify(feature_slug);
    let normalized_task_kind = normalize_manual_task_kind(task_kind)?;
    let feature_project_ids = state.manual_features[feature_index].project_ids.clone();
    validate_manual_task_kind_for_projects(
        normalized_task_kind,
        &feature_project_ids,
        &standalone_projects,
        &project_groups,
    )?;
    if normalized_title.is_empty()
        || normalized_description.is_empty()
        || normalized_feature_slug.is_empty()
    {
        return Err(BackendError::Validation(
            "Manual feature finalization requires title, description and feature slug".to_string(),
        ));
    }

    let slug_used_by_other_feature =
        state
            .manual_features
            .iter()
            .enumerate()
            .any(|(index, candidate)| {
                index != feature_index
                    && candidate
                        .feature_slug
                        .as_ref()
                        .map(|value| value == &normalized_feature_slug)
                        .unwrap_or(false)
            });
    if slug_used_by_other_feature {
        return Err(BackendError::Validation(format!(
            "Standalone feature slug \"{}\" is already in use.",
            normalized_feature_slug
        )));
    }

    let slug_reserved_elsewhere = state.reserved_standalone_feature_slugs.iter().any(|value| {
        value == &normalized_feature_slug
            && existing_feature_slug.as_deref() != Some(normalized_feature_slug.as_str())
    });
    if slug_reserved_elsewhere {
        return Err(BackendError::Validation(format!(
            "Standalone feature slug \"{}\" is already reserved.",
            normalized_feature_slug
        )));
    }

    let feature = state
        .manual_features
        .get_mut(feature_index)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", task_id))
        })?;

    if let Some(next_conversation_id) = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        feature.conversation_id = next_conversation_id.to_string();
    }

    let execution_targets = build_manual_feature_execution_targets(
        workspace_path,
        task_id,
        &feature.project_ids,
        &normalized_feature_slug,
        normalized_task_kind,
        &standalone_projects,
        &project_groups,
    );
    let branch_name = execution_targets
        .first()
        .map(|target| target.branch_name.clone())
        .unwrap_or_else(|| {
            render_standalone_task_branch_name(None, &normalized_feature_slug, normalized_task_kind)
        });
    let base_branch = execution_targets
        .first()
        .and_then(|target| target.target_branch_name.clone())
        .unwrap_or_else(|| feature.base_branch.clone());
    feature.draft = false;
    feature.title = normalized_title.to_string();
    feature.description = normalized_description.to_string();
    feature.feature_slug = Some(normalized_feature_slug.clone());
    feature.task_kind = Some(normalized_task_kind.to_string());
    feature.branch_name = Some(branch_name.clone());
    feature.archived_at = None;
    feature.archive_reason = None;
    feature.merged_at = None;
    feature.base_branch = base_branch;
    feature.execution_targets = execution_targets;
    feature.merge_workflow = None;
    feature.updated_at = Utc::now().to_rfc3339();
    if !state
        .reserved_standalone_feature_slugs
        .iter()
        .any(|value| value == &normalized_feature_slug)
    {
        state
            .reserved_standalone_feature_slugs
            .push(normalized_feature_slug.clone());
    }

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

pub async fn revert_manual_feature_to_draft(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    conversation_id: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
) -> Result<ManualFeatureDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    let feature_index = state
        .manual_features
        .iter()
        .position(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", task_id))
        })?;

    let previous_feature_slug = state.manual_features[feature_index]
        .feature_slug
        .as_ref()
        .map(|value| slugify(value))
        .filter(|value| !value.is_empty());

    let feature = state
        .manual_features
        .get_mut(feature_index)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", task_id))
        })?;

    if let Some(next_conversation_id) = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        feature.conversation_id = next_conversation_id.to_string();
    }

    feature.draft = true;
    feature.title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("New feature")
        .to_string();
    feature.description = description.map(str::trim).unwrap_or("").to_string();
    feature.status = "Pending".to_string();
    feature.feature_slug = None;
    feature.branch_name = None;
    feature.archived_at = None;
    feature.archive_reason = None;
    feature.merged_at = None;
    feature.execution_targets = Vec::new();
    feature.merge_workflow = None;
    feature.updated_at = Utc::now().to_rfc3339();

    if let Some(previous_feature_slug) = previous_feature_slug {
        state
            .reserved_standalone_feature_slugs
            .retain(|value| slugify(value) != previous_feature_slug);
    }

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "revert_manual_feature_to_draft",
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

pub async fn delete_manual_feature_draft(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
) -> Result<()> {
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    let normalized_task_id = task_id.trim().to_string();
    if !state
        .deleted_manual_feature_ids
        .contains(&normalized_task_id)
    {
        state.deleted_manual_feature_ids.push(normalized_task_id);
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    if !state
        .deleted_manual_feature_ids
        .iter()
        .any(|candidate| candidate == normalized_task_id)
    {
        state
            .deleted_manual_feature_ids
            .push(normalized_task_id.to_string());
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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

pub async fn update_manual_feature_merge_workflow(
    workspace_path: &Path,
    metadata_root: &Path,
    task_id: &str,
    merge_workflow: Option<ManualFeatureMergeWorkflowDto>,
) -> Result<ManualFeatureDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_task_id = task_id.trim();
    let feature = state
        .manual_features
        .iter_mut()
        .find(|candidate| candidate.id == normalized_task_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown manual feature id: {}", normalized_task_id))
        })?;

    feature.merge_workflow = merge_workflow;
    feature.updated_at = Utc::now().to_rfc3339();

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "update_manual_feature_merge_workflow",
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

async fn ensure_project_directory(project_path: &Path, operation: &str) -> Result<()> {
    if project_path.exists() {
        let metadata =
            fs::metadata(project_path)
                .await
                .map_err(|error| BackendError::Filesystem {
                    message: format!(
                        "Failed to inspect project directory {} for {}: {}",
                        project_path.display(),
                        operation,
                        error
                    ),
                })?;

        if !metadata.is_dir() {
            return Err(BackendError::FilesystemIsFile {
                message: format!(
                    "Project path {} for {} is not a directory",
                    project_path.display(),
                    operation
                ),
            });
        }

        return Ok(());
    }

    fs::create_dir_all(project_path)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!(
                "Failed to create project directory {} for {}: {}",
                project_path.display(),
                operation,
                error
            ),
        })?;

    Ok(())
}

async fn ensure_project_directory_for_add(
    workspace_path: &Path,
    project_path: &str,
    operation: &str,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<()> {
    if let Some(wsl_path) = parse_wsl_unc_path(project_path) {
        let output = run_wsl_shell(
            &wsl_path,
            r#"test -d "$1""#,
            PROJECT_GIT_PROBE_TIMEOUT,
            cancel_rx,
        )
        .await?;
        if output.status.success() {
            return Ok(());
        }
        return Err(BackendError::FilesystemNotFound {
            message: format!(
                "Project path {} for {} was not found.",
                project_path, operation
            ),
        });
    }

    ensure_project_directory(
        &resolve_project_path(workspace_path, project_path),
        operation,
    )
    .await
}

fn normalize_new_repo_folder_name(folder_name: &str) -> Result<String> {
    let trimmed = folder_name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(BackendError::FilesystemInvalidPath {
            message: "New project folder name must be a single folder name.".to_string(),
        });
    }

    Ok(trimmed.to_string())
}

fn ensure_new_repo_parent_path(parent_path: &Path) -> Result<()> {
    if !parent_path.exists() {
        return Err(BackendError::FilesystemNotFound {
            message: format!("Parent folder {} does not exist.", parent_path.display()),
        });
    }

    if !parent_path.is_dir() {
        return Err(BackendError::FilesystemIsFile {
            message: format!("Parent path {} is not a directory.", parent_path.display()),
        });
    }

    if Repository::discover(parent_path)
        .or_else(|_| Repository::open(parent_path))
        .is_ok()
    {
        return Err(BackendError::Validation(
            "Choose a parent folder that is not inside an existing Git repository.".to_string(),
        ));
    }

    Ok(())
}

fn ensure_new_repo_target_available(project_path: &Path) -> Result<()> {
    if project_path.exists() {
        return Err(BackendError::FilesystemAlreadyExists {
            message: format!(
                "New project folder {} already exists.",
                project_path.display()
            ),
        });
    }

    Ok(())
}

async fn rollback_created_new_repo<T>(
    project_path: &Path,
    original_error: BackendError,
) -> Result<T> {
    // Only remove a target that this operation can still prove it owns.  A plain
    // `exists()` check made the previous rollback capable of deleting a folder
    // created or populated by a concurrent operation.
    let marker = project_path.join(NEW_REPO_OWNERSHIP_MARKER);
    if !marker.exists() {
        return Err(original_error);
    }

    fs::remove_dir_all(project_path)
        .await
        .map_err(|rollback_error| BackendError::Internal {
            message: format!(
                "New project creation failed and rollback was not fully applied: {}; rollback error: {}",
                original_error, rollback_error
            ),
        })?;

    Err(original_error)
}

async fn lock_new_repo_target(metadata_root: &Path, target: &str) -> OwnedMutexGuard<()> {
    let key = format!(
        "{}::{target}",
        workspace_state_lock_key(metadata_root).to_string_lossy()
    );
    let lock = {
        let locks = NEW_REPO_TARGET_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

async fn clear_new_repo_ownership_marker(project_path: &Path) {
    let marker = project_path.join(NEW_REPO_OWNERSHIP_MARKER);
    if let Err(error) = fs::remove_file(&marker).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                action = "new_project_repo_ownership_marker_cleanup_failed",
                project_path = %project_path.display(),
                error = %error
            );
        }
    }
}

pub async fn create_project(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateProjectRequest,
) -> Result<ProjectDto> {
    create_project_with_cancel(workspace_path, metadata_root, request, None).await
}

pub async fn create_project_with_cancel(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateProjectRequest,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    create_project_with_cancel_locked(workspace_path, metadata_root, request, cancel_rx).await
}

async fn create_project_with_cancel_locked(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateProjectRequest,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectDto> {
    ensure_not_cancelled(cancel_rx.as_ref())?;
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
    let project = build_project_for_add(
        &request.name,
        &request.description,
        request.path.as_deref(),
        workspace_path,
        request.git_flow_settings.as_ref(),
        request.direct_edit,
        cancel_rx.clone(),
    )
    .await?;
    ensure_not_cancelled(cancel_rx.as_ref())?;
    ensure_unique_project_name_in_target(
        &state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &project.name,
    )?;

    let project_path = resolve_project_path(workspace_path, &project.path);
    ensure_unique_project_path_in_state(&state, workspace_path, &project_path)?;
    ensure_project_directory_for_add(
        workspace_path,
        &project.path,
        "create_project",
        cancel_rx.clone(),
    )
    .await?;
    ensure_not_cancelled(cancel_rx.as_ref())?;

    insert_project_into_registry(
        &mut state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        project.clone(),
    )?;
    ensure_plan_has_project(&mut state, &project);

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "create_project").await?;
    let persisted_project = find_project_by_id_in_state(&sanitized_state, &project.id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project.id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "create_project",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(persisted_project)
}

pub async fn create_new_project_repo(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateNewProjectRepoRequest,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    create_new_project_repo_with_cancel(workspace_path, metadata_root, request, None).await
}

pub async fn create_new_project_repo_with_cancel(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateNewProjectRepoRequest,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    // Git setup can block, especially through WSL. Serialize only this target,
    // leaving the registry lock available to unrelated project operations.
    let folder_name = normalize_new_repo_folder_name(&request.folder_name)?;
    let target = if let Some(wsl_parent) = parse_wsl_unc_path(&request.parent_path) {
        wsl_unc_path(
            &wsl_parent.distro,
            &format!(
                "{}/{}",
                wsl_parent.linux_path.trim_end_matches('/'),
                folder_name
            ),
        )
    } else {
        absolutize_path(
            &resolve_project_path(workspace_path, &request.parent_path).join(folder_name),
        )
        .to_string_lossy()
        .to_string()
    };
    let _target_guard = lock_new_repo_target(metadata_root, &target).await;
    create_new_project_repo_with_cancel_locked(workspace_path, metadata_root, request, cancel_rx)
        .await
}

async fn create_new_project_repo_with_cancel_locked(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateNewProjectRepoRequest,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    ensure_not_cancelled(cancel_rx.as_ref())?;
    if let Some(wsl_parent) = parse_wsl_unc_path(&request.parent_path) {
        return create_new_wsl_project_repo(
            workspace_path,
            metadata_root,
            request,
            wsl_parent,
            cancel_rx,
        )
        .await;
    }

    let folder_name = normalize_new_repo_folder_name(&request.folder_name)?;
    let parent_path = resolve_project_path(workspace_path, &request.parent_path);
    let project_path = absolutize_path(&parent_path.join(folder_name));
    let project_path_string = project_path.to_string_lossy().to_string();

    let state = {
        let _state_guard = lock_workspace_state(metadata_root).await;
        load_or_create_state(workspace_path, metadata_root).await?
    };
    ensure_valid_project_group_target(
        &state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.repo_name,
    )?;
    ensure_unique_project_name_in_target(
        &state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.repo_name,
    )?;
    ensure_unique_project_path_in_state(&state, workspace_path, &project_path)?;
    ensure_new_repo_parent_path(&parent_path)?;
    ensure_new_repo_target_available(&project_path)?;

    ensure_not_cancelled(cancel_rx.as_ref())?;
    fs::create_dir(&project_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            BackendError::FilesystemAlreadyExists {
                message: format!(
                    "New project folder {} already exists.",
                    project_path.display()
                ),
            }
        } else {
            BackendError::Filesystem {
                message: format!(
                    "Failed to create repository directory {}: {}",
                    project_path.display(),
                    error
                ),
            }
        }
    })?;

    if let Err(error) = fs::write(project_path.join(NEW_REPO_OWNERSHIP_MARKER), b"").await {
        return rollback_created_new_repo(
            &project_path,
            BackendError::Filesystem {
                message: format!(
                    "Failed to mark repository directory {} as owned: {}",
                    project_path.display(),
                    error
                ),
            },
        )
        .await;
    }

    ensure_not_cancelled(cancel_rx.as_ref())?;
    let setup_result: Result<()> = (|| {
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo =
            Repository::init_opts(&project_path, &opts).map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to initialize git repository at {}: {}",
                    project_path.display(),
                    error
                ),
            })?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(repo.path().join("info").join("exclude"))
            .and_then(|mut file| writeln!(file, "/{}", NEW_REPO_OWNERSHIP_MARKER))
            .map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to exclude the temporary repository ownership marker at {}: {}",
                    project_path.display(),
                    error
                ),
            })?;
        create_initial_commit(&repo)?;
        Ok(())
    })();

    if let Err(error) = setup_result {
        return rollback_created_new_repo(&project_path, error).await;
    }

    #[cfg(test)]
    if take_new_repo_cancellation_after_init(&project_path) {
        return rollback_created_new_repo(&project_path, project_operation_cancelled_error()).await;
    }

    // Resolve the result before registry persistence.  Once the project has
    // been persisted, this function must return success even if cancellation
    // was requested while the metadata write was finishing.
    let detection = match detect_project_git_flow_for_add(
        workspace_path,
        Some(project_path_string.as_str()),
        cancel_rx.clone(),
    )
    .await
    {
        Ok(detection) => detection,
        Err(error) => return rollback_created_new_repo(&project_path, error).await,
    };

    let create_request = CreateProjectRequest {
        name: request.repo_name,
        description: String::new(),
        group_id: request.group_id,
        group_name: request.group_name,
        path: Some(project_path_string.clone()),
        direct_edit: false,
        git_flow_settings: request.git_flow_settings,
    };

    let create_result = {
        let _state_guard = lock_workspace_state(metadata_root).await;
        create_project_with_cancel_locked(workspace_path, metadata_root, create_request, cancel_rx)
            .await
    };
    match create_result {
        Ok(project) => {
            clear_new_repo_ownership_marker(&project_path).await;
            Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
        }
        Err(error) => rollback_created_new_repo(&project_path, error).await,
    }
}

async fn run_wsl_shell(
    wsl_path: &WslProjectPath,
    script: &str,
    timeout_duration: Duration,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<std::process::Output> {
    run_wsl_shell_with_args(wsl_path, script, &[], timeout_duration, cancel_rx).await
}

async fn run_wsl_shell_with_args(
    wsl_path: &WslProjectPath,
    script: &str,
    additional_args: &[String],
    timeout_duration: Duration,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<std::process::Output> {
    let mut command = background_tokio_command("wsl.exe");
    command
        .arg("-d")
        .arg(&wsl_path.distro)
        .arg("--")
        .arg("sh")
        .arg("-lc")
        .arg(script)
        .arg("macro-wsl-command")
        .arg(&wsl_path.linux_path)
        .args(additional_args);
    wait_for_wsl_command(command, timeout_duration, cancel_rx).await
}

async fn create_new_wsl_project_repo(
    workspace_path: &Path,
    metadata_root: &Path,
    request: CreateNewProjectRepoRequest,
    parent_wsl_path: WslProjectPath,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    let folder_name = normalize_new_repo_folder_name(&request.folder_name)?;
    let project_linux_path = format!(
        "{}/{}",
        parent_wsl_path.linux_path.trim_end_matches('/'),
        folder_name
    );
    let project_path_string = wsl_unc_path(&parent_wsl_path.distro, &project_linux_path);
    let project_wsl_path = WslProjectPath {
        distro: parent_wsl_path.distro.clone(),
        linux_path: project_linux_path,
        original_path: project_path_string.clone(),
        unc_path: project_path_string.clone(),
    };

    let state = {
        let _state_guard = lock_workspace_state(metadata_root).await;
        load_or_create_state(workspace_path, metadata_root).await?
    };
    ensure_valid_project_group_target(
        &state.project_groups,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.repo_name,
    )?;
    ensure_unique_project_name_in_target(
        &state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &request.repo_name,
    )?;
    ensure_unique_project_path_in_state(&state, workspace_path, Path::new(&project_path_string))?;
    ensure_not_cancelled(cancel_rx.as_ref())?;

    let create_script = r#"set -e
project="$1"
marker="$project/.macro-create-in-progress"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$marker" ]; then
    rm -rf "$project"
  fi
  exit "$status"
}
trap cleanup EXIT
[ -d "$(dirname "$project")" ] || { echo "parent folder does not exist" >&2; exit 18; }
[ ! -e "$project" ] || { echo "target exists" >&2; exit 17; }
mkdir "$project"
: > "$marker"
git -C "$project" init -b main
printf '/.macro-create-in-progress\n' >> "$project/.git/info/exclude"
git -C "$project" config user.name >/dev/null 2>&1 || git -C "$project" config user.name Macro
git -C "$project" config user.email >/dev/null 2>&1 || git -C "$project" config user.email macro@local
git -C "$project" commit --allow-empty -m "chore(git): initialize repository"
trap - EXIT
"#;
    let output = match run_wsl_shell(
        &project_wsl_path,
        create_script,
        Duration::from_secs(12),
        cancel_rx.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            rollback_created_wsl_new_repo(&project_wsl_path).await;
            return Err(error);
        }
    };
    if !output.status.success() {
        rollback_created_wsl_new_repo(&project_wsl_path).await;
        return Err(BackendError::Git {
            message: format!(
                "Failed to initialize WSL git repository: {}",
                output_stderr(&output)
            ),
        });
    }
    let detection = match detect_project_git_flow_for_add(
        workspace_path,
        Some(project_path_string.as_str()),
        cancel_rx.clone(),
    )
    .await
    {
        Ok(detection) => detection,
        Err(error) => {
            rollback_created_wsl_new_repo(&project_wsl_path).await;
            return Err(error);
        }
    };

    let create_request = CreateProjectRequest {
        name: request.repo_name,
        description: String::new(),
        group_id: request.group_id,
        group_name: request.group_name,
        path: Some(project_path_string.clone()),
        direct_edit: false,
        git_flow_settings: request.git_flow_settings,
    };

    let create_result = {
        let _state_guard = lock_workspace_state(metadata_root).await;
        create_project_with_cancel_locked(workspace_path, metadata_root, create_request, cancel_rx)
            .await
    };
    match create_result {
        Ok(project) => {
            let _ = run_wsl_shell(
                &project_wsl_path,
                r#"rm -f "$1/.macro-create-in-progress""#,
                PROJECT_GIT_PROBE_TIMEOUT,
                None,
            )
            .await;
            Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
        }
        Err(error) => {
            rollback_created_wsl_new_repo(&project_wsl_path).await;
            Err(error)
        }
    }
}

async fn rollback_created_wsl_new_repo(project_wsl_path: &WslProjectPath) {
    let _ = run_wsl_shell(
        project_wsl_path,
        r#"if [ -f "$1/.macro-create-in-progress" ]; then rm -rf "$1"; fi"#,
        PROJECT_GIT_PROBE_TIMEOUT,
        None,
    )
    .await;
}

pub async fn import_git_repo(
    workspace_path: &Path,
    metadata_root: &Path,
    request: ImportGitRepoRequest,
) -> Result<ProjectDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    ensure_unique_project_name_in_target(
        &state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        &project.name,
    )?;

    let project_path = resolve_project_path(workspace_path, &project.path);
    ensure_unique_project_path_in_state(&state, workspace_path, &project_path)?;
    ensure_project_directory(&project_path, "import_git_repo").await?;

    insert_project_into_registry(
        &mut state,
        request.group_id.as_deref(),
        request.group_name.as_deref(),
        project.clone(),
    )?;
    ensure_plan_has_project(&mut state, &project);

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "import_git_repo").await?;
    let persisted_project = find_project_by_id_in_state(&sanitized_state, &project.id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project.id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "import_git_repo",
        project_id = %project.id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
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
    let _state_guard = lock_workspace_state(metadata_root).await;
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
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(updated_group)
}

pub async fn create_project_group(
    workspace_path: &Path,
    metadata_root: &Path,
    name: &str,
    project_ids: &[String],
) -> Result<Vec<ProjectGroupDto>> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Group name cannot be empty".to_string(),
        ));
    }

    let mut unique_project_ids = Vec::new();
    let mut seen = HashSet::new();
    for project_id in project_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if seen.insert(project_id.to_string()) {
            unique_project_ids.push(project_id.to_string());
        }
    }

    if unique_project_ids.len() < 2 {
        return Err(BackendError::Validation(
            "A group requires at least two projects.".to_string(),
        ));
    }

    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let mut grouped_projects = Vec::with_capacity(unique_project_ids.len());
    for project_id in &unique_project_ids {
        let project = take_project_from_registry(&mut state, project_id).ok_or_else(|| {
            BackendError::Validation(format!("Unknown project id: {}", project_id))
        })?;
        grouped_projects.push(project);
    }

    state.project_groups.push(ProjectGroupDto {
        id: format!("group-{}", Utc::now().timestamp_millis()),
        name: trimmed_name.to_string(),
        is_open: true,
        projects: grouped_projects,
    });

    let (sanitized_state, _) =
        persist_sanitized_state(workspace_path, metadata_root, state, "create_project_group")
            .await?;
    Ok(sanitized_state.project_groups)
}

pub async fn move_project_to_group(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    group_id: Option<&str>,
) -> Result<Vec<ProjectGroupDto>> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let current_group_id = find_group_id_for_project(&state, project_id);
    let target_group_id = group_id.map(str::trim).filter(|value| !value.is_empty());

    if current_group_id.as_deref() == target_group_id {
        let (sanitized_state, _) = persist_sanitized_state(
            workspace_path,
            metadata_root,
            state,
            "move_project_to_group",
        )
        .await?;
        return Ok(sanitized_state.project_groups);
    }

    if let Some(target_group_id) = target_group_id {
        if !state
            .project_groups
            .iter()
            .any(|group| group.id == target_group_id)
        {
            return Err(BackendError::Validation(format!(
                "Unknown project group id: {}",
                target_group_id
            )));
        }
    }

    let project = take_project_from_registry(&mut state, project_id)
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    if let Some(target_group_id) = target_group_id {
        let group = state
            .project_groups
            .iter_mut()
            .find(|group| group.id == target_group_id)
            .ok_or_else(|| {
                BackendError::Validation(format!("Unknown project group id: {}", target_group_id))
            })?;
        group.projects.push(project);
    } else {
        state.standalone_projects.push(project);
    }

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "move_project_to_group",
    )
    .await?;
    Ok(sanitized_state.project_groups)
}

pub async fn rename_project(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    name: &str,
) -> Result<ProjectDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
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

    if let Some(project) = find_project_by_id_mut_in_state(&mut state, project_id) {
        project.name = trimmed_name.to_string();
        updated_project = Some(project.clone());
    }

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "rename_project").await?;
    let updated_project = sanitized_state
        .standalone_projects
        .iter()
        .chain(
            sanitized_state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "rename_project",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
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
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let normalized_git_flow_settings = normalize_project_git_flow_settings(Some(git_flow_settings));
    validate_project_git_flow_settings_strict(&normalized_git_flow_settings)?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "update_project_git_flow",
        project_id = %project_id
    );
    let mut updated_project: Option<ProjectDto> = None;

    if let Some(project) = find_project_by_id_mut_in_state(&mut state, project_id) {
        project.git_flow_settings = normalized_git_flow_settings.clone();
        updated_project = Some(project.clone());
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
        .standalone_projects
        .iter()
        .chain(
            sanitized_state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "update_project_git_flow",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(updated_project)
}

fn preview_item_from_labels(labels: HashSet<String>) -> ProjectAccessMigrationItemDto {
    let mut labels = labels
        .into_iter()
        .filter(|label| !label.trim().is_empty())
        .collect::<Vec<_>>();
    labels.sort();
    ProjectAccessMigrationItemDto {
        count: labels.len(),
        labels,
    }
}

fn blocking_reasons_message(blocking_reasons: &[String]) -> String {
    if blocking_reasons.is_empty() {
        return "unknown_reason".to_string();
    }

    blocking_reasons.join(", ")
}

fn inspect_worktree_dirty(worktree: &GitWorktreeRecord) -> bool {
    let path = Path::new(&worktree.path);
    if !path.exists() {
        return false;
    }

    Repository::open(path)
        .ok()
        .and_then(|repo| {
            let mut status_options = get_status_options();
            repo.statuses(Some(&mut status_options))
                .ok()
                .map(|statuses| !statuses.is_empty())
        })
        .unwrap_or(false)
}

fn task_status_is_active(status: &str) -> bool {
    !matches!(status.trim(), "" | "Completed" | "Failed")
}

fn is_task_entry_active(task: &serde_json::Map<String, Value>) -> bool {
    if task
        .get("archived_at")
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }

    if task
        .get("draft")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    task.get("status")
        .and_then(|value| value.as_str())
        .map(task_status_is_active)
        .unwrap_or(false)
}

fn collect_task_actionable_project_ids(
    task: &serde_json::Map<String, Value>,
    actionable_project_ids: &HashSet<String>,
) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Some(project_id) = task.get("project_id").and_then(|value| value.as_str()) {
        if actionable_project_ids.contains(project_id) {
            ids.insert(project_id.to_string());
        }
    }
    if let Some(project_ids) = task.get("project_ids").and_then(|value| value.as_array()) {
        for project_id in project_ids.iter().filter_map(|value| value.as_str()) {
            if actionable_project_ids.contains(project_id) {
                ids.insert(project_id.to_string());
            }
        }
    }
    if let Some(targets) = task
        .get("execution_targets")
        .and_then(|value| value.as_array())
    {
        for target in targets {
            if let Some(project_id) = target.get("projectId").and_then(|value| value.as_str()) {
                if actionable_project_ids.contains(project_id) {
                    ids.insert(project_id.to_string());
                }
            }
        }
    }
    ids
}

pub async fn preview_project_access_change(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    target_read_only: bool,
    worktrees: &[GitWorktreeRecord],
    live_terminal_project_ids: &HashSet<String>,
) -> Result<ProjectAccessChangePreviewDto> {
    let state = load_or_create_state(workspace_path, metadata_root).await?;
    let project = find_project_by_id_in_state(&state, project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let actionable_project_ids = collect_actionable_project_ids_from_state(&state);
    let mut blocking_reasons = Vec::new();
    let mut plan_labels = HashSet::new();
    let mut manual_feature_labels = HashSet::new();
    let mut task_labels = HashSet::new();
    let mut worktree_labels = HashSet::new();
    let mut predicted_branch_labels = HashSet::new();
    let mut plan_node_labels = HashSet::new();
    let mut execution_target_labels = HashSet::new();

    if !target_read_only {
        return Ok(ProjectAccessChangePreviewDto {
            project_id: project_id.to_string(),
            target_read_only,
            can_apply: project.git_setup_state == PROJECT_GIT_SETUP_READY,
            requires_confirmation: false,
            blocking_reasons,
            migration_summary: ProjectAccessMigrationSummaryDto::default(),
        });
    }

    if project.user_read_only {
        return Ok(ProjectAccessChangePreviewDto {
            project_id: project_id.to_string(),
            target_read_only,
            can_apply: true,
            requires_confirmation: false,
            blocking_reasons,
            migration_summary: ProjectAccessMigrationSummaryDto::default(),
        });
    }

    for worktree in worktrees
        .iter()
        .filter(|worktree| worktree.project_id == project_id)
    {
        worktree_labels.insert(if worktree.branch.trim().is_empty() {
            worktree.task_id.clone()
        } else {
            format!("{} ({})", worktree.branch, worktree.task_id)
        });
        if inspect_worktree_dirty(worktree)
            && !blocking_reasons
                .iter()
                .any(|reason| reason == ACCESS_BLOCK_DIRTY_WORKTREE)
        {
            blocking_reasons.push(ACCESS_BLOCK_DIRTY_WORKTREE.to_string());
        }
    }

    if live_terminal_project_ids.contains(project_id) {
        blocking_reasons.push(ACCESS_BLOCK_LIVE_TERMINAL.to_string());
    }

    if let Some(plan) = state.current_plan.as_ref() {
        if plan.project_ids.iter().any(|value| value == project_id) {
            plan_labels.insert(plan.description.clone());
            let remaining_actionable = plan
                .project_ids
                .iter()
                .filter(|candidate| candidate.as_str() != project_id)
                .filter(|candidate| actionable_project_ids.contains(candidate.as_str()))
                .count();
            if remaining_actionable == 0 {
                blocking_reasons.push(ACCESS_BLOCK_LAST_ACTIONABLE_PLAN.to_string());
            }
        }

        for task in &plan.tasks {
            let Some(task_object) = task.as_object() else {
                continue;
            };
            let actionable_targets =
                collect_task_actionable_project_ids(task_object, &actionable_project_ids);
            if !actionable_targets.contains(project_id) {
                continue;
            }
            let task_label = task_object
                .get("title")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Unnamed task")
                .to_string();
            task_labels.insert(task_label.clone());

            if let Some(targets) = task_object
                .get("execution_targets")
                .and_then(|value| value.as_array())
            {
                for target in targets {
                    if target
                        .get("projectId")
                        .and_then(|value| value.as_str())
                        .map(|value| value == project_id)
                        .unwrap_or(false)
                    {
                        let branch_label = target
                            .get("branchName")
                            .and_then(|value| value.as_str())
                            .unwrap_or("execution target");
                        execution_target_labels
                            .insert(format!("{} · {}", task_label, branch_label));
                    }
                }
            }

            if is_task_entry_active(task_object) && actionable_targets.len() <= 1 {
                blocking_reasons.push(ACCESS_BLOCK_LAST_ACTIONABLE_TASK.to_string());
            }
        }
    }

    for feature in &state.manual_features {
        let feature_project_ids = feature
            .project_ids
            .iter()
            .filter(|candidate| actionable_project_ids.contains(candidate.as_str()))
            .cloned()
            .collect::<HashSet<_>>();
        let target_matches = feature_project_ids.contains(project_id)
            || feature
                .execution_targets
                .iter()
                .any(|target| target.project_id == project_id);
        if !target_matches {
            continue;
        }

        manual_feature_labels.insert(feature.title.clone());
        for target in feature
            .execution_targets
            .iter()
            .filter(|target| target.project_id == project_id)
        {
            execution_target_labels.insert(format!("{} · {}", feature.title, target.branch_name));
        }

        let archived = feature
            .archived_at
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !archived && feature_project_ids.len() <= 1 {
            blocking_reasons.push(ACCESS_BLOCK_LAST_ACTIONABLE_FEATURE.to_string());
        }
    }

    for node in state
        .plan_nodes
        .iter()
        .filter(|node| node.project_id.as_deref() == Some(project_id))
    {
        plan_node_labels.insert(node.title.clone());
    }

    for branch in state
        .predicted_branches
        .iter()
        .filter(|branch| branch.project_id == project_id)
    {
        predicted_branch_labels.insert(branch.name.clone());
    }

    let mut unique_blocking_reasons = HashSet::new();
    blocking_reasons.retain(|reason| unique_blocking_reasons.insert(reason.clone()));
    let migration_summary = ProjectAccessMigrationSummaryDto {
        plans: preview_item_from_labels(plan_labels),
        manual_features: preview_item_from_labels(manual_feature_labels),
        tasks: preview_item_from_labels(task_labels),
        worktrees: preview_item_from_labels(worktree_labels),
        predicted_branches: preview_item_from_labels(predicted_branch_labels),
        plan_nodes: preview_item_from_labels(plan_node_labels),
        execution_targets: preview_item_from_labels(execution_target_labels),
    };
    let requires_confirmation = blocking_reasons.is_empty()
        && [
            migration_summary.plans.count,
            migration_summary.manual_features.count,
            migration_summary.tasks.count,
            migration_summary.worktrees.count,
            migration_summary.predicted_branches.count,
            migration_summary.plan_nodes.count,
            migration_summary.execution_targets.count,
        ]
        .into_iter()
        .any(|count| count > 0);

    if blocking_reasons.is_empty() {
        tracing::info!(
            action = "project_access_preview_ready",
            project_id = %project_id,
            target_read_only = target_read_only,
            project_git_setup_state = %project.git_setup_state,
            project_user_read_only = project.user_read_only,
            project_is_read_only = project.is_read_only,
            worktree_count = worktrees.iter().filter(|worktree| worktree.project_id == project_id).count(),
            live_terminal_attached = live_terminal_project_ids.contains(project_id),
            requires_confirmation = requires_confirmation,
            plan_migration_count = migration_summary.plans.count,
            manual_feature_migration_count = migration_summary.manual_features.count,
            task_migration_count = migration_summary.tasks.count,
            worktree_migration_count = migration_summary.worktrees.count,
            predicted_branch_migration_count = migration_summary.predicted_branches.count,
            plan_node_migration_count = migration_summary.plan_nodes.count,
            execution_target_migration_count = migration_summary.execution_targets.count
        );
    } else {
        tracing::warn!(
            action = "project_access_preview_blocked",
            project_id = %project_id,
            target_read_only = target_read_only,
            project_git_setup_state = %project.git_setup_state,
            project_user_read_only = project.user_read_only,
            project_is_read_only = project.is_read_only,
            worktree_count = worktrees.iter().filter(|worktree| worktree.project_id == project_id).count(),
            live_terminal_attached = live_terminal_project_ids.contains(project_id),
            blocking_reasons = ?blocking_reasons,
            plan_migration_count = migration_summary.plans.count,
            manual_feature_migration_count = migration_summary.manual_features.count,
            task_migration_count = migration_summary.tasks.count,
            worktree_migration_count = migration_summary.worktrees.count,
            predicted_branch_migration_count = migration_summary.predicted_branches.count,
            plan_node_migration_count = migration_summary.plan_nodes.count,
            execution_target_migration_count = migration_summary.execution_targets.count
        );
    }

    Ok(ProjectAccessChangePreviewDto {
        project_id: project_id.to_string(),
        target_read_only,
        can_apply: blocking_reasons.is_empty(),
        requires_confirmation,
        blocking_reasons,
        migration_summary,
    })
}

pub async fn update_project_access(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    user_read_only: bool,
    direct_edit: Option<bool>,
    confirmed_migration: bool,
    access_preview: Option<&ProjectAccessChangePreviewDto>,
) -> Result<ProjectDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    tracing::info!(
        action = "project_access_update_requested",
        project_id = %project_id,
        user_read_only = user_read_only,
        confirmed_migration = confirmed_migration,
        preview_available = access_preview.is_some()
    );

    if user_read_only {
        let preview = access_preview.ok_or_else(|| {
            tracing::warn!(
                action = "project_access_update_rejected",
                project_id = %project_id,
                user_read_only = user_read_only,
                reason = "missing_preview"
            );
            BackendError::Validation(
                "Project access change requires a validated preview.".to_string(),
            )
        })?;
        if !preview.can_apply {
            tracing::warn!(
                action = "project_access_update_rejected",
                project_id = %project_id,
                user_read_only = user_read_only,
                confirmed_migration = confirmed_migration,
                blocking_reasons = ?preview.blocking_reasons,
                requires_confirmation = preview.requires_confirmation
            );
            return Err(BackendError::Validation(format!(
                "This project cannot be switched to read-only right now: {}.",
                blocking_reasons_message(&preview.blocking_reasons)
            )));
        }
        if preview.requires_confirmation && !confirmed_migration {
            tracing::warn!(
                action = "project_access_update_rejected",
                project_id = %project_id,
                user_read_only = user_read_only,
                confirmed_migration = confirmed_migration,
                reason = "missing_confirmation"
            );
            return Err(BackendError::Validation(
                "Project access change requires confirmation.".to_string(),
            ));
        }
    }

    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let mut updated_project: Option<ProjectDto> = None;

    if let Some(project) = find_project_by_id_mut_in_state(&mut state, project_id) {
        if let Some(direct_edit) = direct_edit {
            if direct_edit && project.git_setup_state != PROJECT_GIT_SETUP_NOT_GIT {
                return Err(BackendError::Validation(
                    "Direct editing is only available for folders without Git.".to_string(),
                ));
            }
            project.direct_edit = direct_edit;
        }
        if !user_read_only
            && project.git_setup_state != PROJECT_GIT_SETUP_READY
            && !(project.git_setup_state == PROJECT_GIT_SETUP_NOT_GIT && project.direct_edit)
        {
            tracing::warn!(
                action = "project_access_update_rejected",
                project_id = %project_id,
                user_read_only = user_read_only,
                project_git_setup_state = %project.git_setup_state,
                reason = "git_not_ready"
            );
            return Err(BackendError::Validation(
                "Git must be ready before this project can become editable.".to_string(),
            ));
        }
        project.user_read_only = user_read_only;
        updated_project = Some(project.clone());
    }

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, _) = persist_sanitized_state(
        workspace_path,
        metadata_root,
        state,
        "update_project_access",
    )
    .await?;
    let updated_project = sanitized_state
        .standalone_projects
        .iter()
        .chain(
            sanitized_state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    tracing::info!(
        action = "project_access_update_succeeded",
        project_id = %project_id,
        user_read_only = updated_project.user_read_only,
        is_read_only = updated_project.is_read_only,
        git_setup_state = %updated_project.git_setup_state,
        read_only_reason = ?updated_project.read_only_reason
    );

    Ok(updated_project)
}

pub async fn get_project(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
) -> Result<Option<ProjectDto>> {
    let state = load_or_create_state(workspace_path, metadata_root).await?;
    Ok(find_project_by_id_in_state(&state, project_id).cloned())
}

pub async fn archive_project_group(
    workspace_path: &Path,
    metadata_root: &Path,
    group_id: &str,
) -> Result<ProjectGroupDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
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
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let mut updated_project: Option<ProjectDto> = None;

    if let Some(project) = find_project_by_id_mut_in_state(&mut state, project_id) {
        project.status = "archived".to_string();
        updated_project = Some(project.clone());
    }

    updated_project
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let (sanitized_state, _) =
        persist_sanitized_state(workspace_path, metadata_root, state, "archive_project").await?;
    let updated_project = sanitized_state
        .standalone_projects
        .iter()
        .chain(
            sanitized_state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
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
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "remove_project_group",
        group_id = %group_id,
        before_group_count = state.project_groups.len(),
        before_project_count = count_registry_projects(&state.standalone_projects, &state.project_groups)
    );
    let group_index = state
        .project_groups
        .iter()
        .position(|group| group.id == group_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unknown project group id: {}", group_id))
        })?;
    let dissolved_group = state.project_groups.remove(group_index);
    state.standalone_projects.extend(dissolved_group.projects);

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "remove_project_group")
            .await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "remove_project_group",
        group_id = %group_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
        repair_applied = repair_report.has_repairs()
    );
    Ok(sanitized_state.project_groups)
}

pub async fn close_project(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
) -> Result<Vec<ProjectGroupDto>> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    tracing::info!(
        action = "project_registry_action_started",
        operation = "remove_project",
        project_id = %project_id,
        before_group_count = state.project_groups.len(),
        before_project_count = count_registry_projects(&state.standalone_projects, &state.project_groups)
    );
    let removed_project = take_project_from_registry(&mut state, project_id);

    if removed_project.is_none() {
        return Err(BackendError::Validation(format!(
            "Unknown project id: {}",
            project_id
        )));
    }

    if let Some(plan) = state.current_plan.as_mut() {
        plan.project_ids.retain(|id| id != project_id);
        plan.updated_at = Utc::now().to_rfc3339();
    }

    state.project_registry_explicitly_empty =
        count_registry_projects(&state.standalone_projects, &state.project_groups) == 0;

    let (sanitized_state, repair_report) =
        persist_sanitized_state(workspace_path, metadata_root, state, "remove_project").await?;
    tracing::info!(
        action = "project_registry_action_succeeded",
        operation = "remove_project",
        project_id = %project_id,
        after_group_count = sanitized_state.project_groups.len(),
        after_project_count = count_registry_projects(&sanitized_state.standalone_projects, &sanitized_state.project_groups),
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

pub async fn debug_reset_project(
    workspace_path: &Path,
    metadata_root: &Path,
    git_state: GitState,
    project_id: &str,
    force: bool,
) -> Result<DebugResetProjectReportDto> {
    if !force {
        return Err(BackendError::Validation(
            "Debug project reset requires an explicit force confirmation.".to_string(),
        ));
    }

    let state = load_or_create_state(workspace_path, metadata_root).await?;
    let project = find_project_by_id_in_state(&state, project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;
    let project_path = resolve_project_path(workspace_path, &project.path);

    let mut report = DebugResetProjectReportDto {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        ..DebugResetProjectReportDto::default()
    };

    close_project(workspace_path, metadata_root, &project.id).await?;
    report.removed_registry_entry = true;

    match git_state.debug_reset_macro_project_artifacts(&project_path) {
        Ok(reset) => {
            report.removed_task_worktrees = reset.removed_task_worktrees;
            report.removed_metadata_worktree = reset.removed_metadata_worktree;
            report.removed_macro_branch = reset.removed_macro_branch;
            report.warnings.extend(reset.warnings);
        }
        Err(error) => {
            report.warnings.push(format!(
                "Git cleanup was skipped or incomplete for '{}': {}",
                project_path.display(),
                error
            ));
        }
    }

    Ok(report)
}

fn merge_task_lists(mut legacy_tasks: Vec<Value>, manual_tasks: Vec<Value>) -> Vec<Value> {
    let mut merged = manual_tasks;
    merged.append(&mut legacy_tasks);
    merged
}

fn collect_valid_project_ids_from_state(state: &WorkspaceState) -> HashSet<String> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .map(|project| project.id.clone())
        .collect()
}

fn collect_actionable_project_ids_from_state(state: &WorkspaceState) -> HashSet<String> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .filter(|project| !project_is_read_only(project))
        .map(|project| project.id.clone())
        .collect()
}

fn collect_git_actionable_project_ids_from_state(state: &WorkspaceState) -> HashSet<String> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .filter(|project| {
            !project_is_read_only(project)
                && !project.direct_edit
                && project.git_setup_state == PROJECT_GIT_SETUP_READY
        })
        .map(|project| project.id.clone())
        .collect()
}

fn collect_architect_context_project_ids_from_state(state: &WorkspaceState) -> HashSet<String> {
    let git_actionable = collect_git_actionable_project_ids_from_state(state);
    collect_valid_project_ids_from_state(state)
        .difference(&git_actionable)
        .cloned()
        .collect()
}

fn collect_read_only_project_ids_from_state(state: &WorkspaceState) -> HashSet<String> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .filter(|project| project_is_read_only(project))
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

fn sanitize_json_project_id_list(
    value: Option<&Value>,
    valid_project_ids: &HashSet<String>,
) -> Vec<Value> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            let mut seen = HashSet::new();
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|project_id| project_id.trim().to_string())
                .filter(|project_id| !project_id.is_empty())
                .filter(|project_id| valid_project_ids.contains(project_id))
                .filter(|project_id| seen.insert(project_id.clone()))
                .map(Value::String)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_base_branch(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .unwrap_or("main")
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
    workspace_path: &Path,
    task_id: &str,
    project_ids: &[String],
    feature_slug: &str,
    task_kind: &str,
    standalone_projects: &[ProjectDto],
    project_groups: &[ProjectGroupDto],
) -> Vec<WorkspaceTaskExecutionTargetDto> {
    project_ids
        .iter()
        .map(|project_id| {
            let project = standalone_projects
                .iter()
                .find(|project| project.id == *project_id)
                .or_else(|| find_project_by_id(project_groups, project_id));
            let branch_name = render_standalone_task_branch_name(
                project.map(|project| &project.git_flow_settings),
                feature_slug,
                task_kind,
            );
            let is_direct = project
                .map(|project| {
                    project.direct_edit && project.git_setup_state == PROJECT_GIT_SETUP_NOT_GIT
                })
                .unwrap_or(false);
            let checkpoint_id = project.filter(|_| is_direct).map(|project| {
                let resolved_path = resolve_project_path(workspace_path, &project.path);
                let stable_path = resolved_path.canonicalize().unwrap_or(resolved_path);
                direct_checkpoint_id(task_id, &stable_path)
            });
            WorkspaceTaskExecutionTargetDto {
                project_id: project_id.clone(),
                branch_name: branch_name.clone(),
                target_branch_name: project.map(|project| {
                    if task_kind == "hotfix" {
                        project.git_flow_settings.main_branch.clone()
                    } else {
                        project.git_flow_settings.base_branch.clone()
                    }
                }),
                execution_mode: Some(if is_direct { "direct" } else { "git" }.to_string()),
                checkpoint_id,
                worktree_key: to_branch_worktree_key(project_id, &branch_name),
                repo_path: project.map(|project| project.path.clone()),
            }
        })
        .collect()
}

fn validate_manual_task_kind_for_projects(
    task_kind: &str,
    project_ids: &[String],
    standalone_projects: &[ProjectDto],
    project_groups: &[ProjectGroupDto],
) -> Result<()> {
    for project_id in project_ids {
        let project = standalone_projects
            .iter()
            .find(|project| project.id == *project_id)
            .or_else(|| find_project_by_id(project_groups, project_id));
        let Some(project) = project else {
            continue;
        };
        if project.direct_edit
            && project.git_setup_state == PROJECT_GIT_SETUP_NOT_GIT
            && task_kind != "feature"
        {
            return Err(BackendError::Validation(format!(
                "Direct-edit projects only support feature tasks for project {}.",
                project.name
            )));
        }
        if task_kind != "bugfix" {
            continue;
        }
        let base_branch = project.git_flow_settings.base_branch.trim();
        let main_branch = project.git_flow_settings.main_branch.trim();
        if !base_branch.is_empty() && base_branch.eq_ignore_ascii_case(main_branch) {
            return Err(BackendError::Validation(format!(
                "Bugfix tasks require a development branch distinct from the production branch for project {}.",
                project.name
            )));
        }
    }

    Ok(())
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
    task.insert(
        "context_project_ids".to_string(),
        Value::Array(
            feature
                .context_project_ids
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
    if let Some(task_kind) = feature.task_kind.as_ref() {
        task.insert("task_kind".to_string(), Value::String(task_kind.clone()));
    }
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
    if let Some(merge_workflow) = feature.merge_workflow.as_ref() {
        if let Ok(value) = serde_json::to_value(merge_workflow) {
            task.insert("merge_workflow".to_string(), value);
        }
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

fn workspace_state_backup_path(metadata_root: &Path) -> PathBuf {
    metadata_root.join(WORKSPACE_STATE_BACKUP_FILE)
}

fn legacy_workspace_state_path(metadata_root: &Path) -> PathBuf {
    metadata_root
        .join(LEGACY_WORKSPACE_META_DIR)
        .join(WORKSPACE_STATE_FILE)
}

fn latest_valid_workspace_temp_sync(metadata_root: &Path) -> Option<(PathBuf, WorkspaceState)> {
    let prefix = format!(".{WORKSPACE_STATE_FILE}.macro-tmp-");
    let mut candidates = std::fs::read_dir(metadata_root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            let content = std::fs::read_to_string(entry.path()).ok()?;
            let state = serde_json::from_str::<WorkspaceState>(&content).ok()?;
            Some((modified, name, entry.path(), state))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .3
            .workspace_revision
            .cmp(&left.3.workspace_revision)
            .then_with(|| right.0.cmp(&left.0))
            .then_with(|| right.1.cmp(&left.1))
    });
    candidates
        .into_iter()
        .next()
        .map(|(_, _, path, state)| (path, state))
}

fn load_raw_state_sync(metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let primary_path = workspace_state_path(metadata_root);
    let legacy_path = legacy_workspace_state_path(metadata_root);
    let backup_path = workspace_state_backup_path(metadata_root);
    if let Some((temp_path, state)) = latest_valid_workspace_temp_sync(metadata_root) {
        let primary_candidate = std::fs::read_to_string(&primary_path)
            .ok()
            .and_then(|content| serde_json::from_str::<WorkspaceState>(&content).ok());
        let should_promote = match primary_candidate {
            None => true,
            Some(primary) => state.workspace_revision > primary.workspace_revision,
        };
        if should_promote {
            persist_state_sync(metadata_root, &state)?;
            let _ = std::fs::remove_file(&temp_path);
            tracing::warn!(
                action = "workspace_state_recovered_from_temp",
                temp_path = %temp_path.display(),
                primary_path = %primary_path.display()
            );
            return Ok(Some(state));
        }
    }
    let path = if primary_path.exists() {
        primary_path.clone()
    } else if legacy_path.exists() {
        legacy_path
    } else if backup_path.exists() {
        backup_path.clone()
    } else {
        return Ok(None);
    };

    let read_and_parse = |candidate: &Path| -> Result<WorkspaceState> {
        let content =
            std::fs::read_to_string(candidate).map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to read workspace state {}: {}",
                    candidate.display(),
                    error
                ),
            })?;
        serde_json::from_str(&content).map_err(|error| {
            BackendError::Validation(format!(
                "Invalid workspace state format in {}: {}",
                candidate.display(),
                error
            ))
        })
    };

    match read_and_parse(&path) {
        Ok(state) => {
            if path == backup_path && !primary_path.exists() {
                persist_state_sync(metadata_root, &state)?;
                tracing::warn!(
                    action = "workspace_state_recovered_from_backup",
                    backup_path = %backup_path.display(),
                    primary_path = %primary_path.display(),
                    reason = "primary_missing"
                );
            }
            Ok(Some(state))
        }
        Err(primary_error) if path == primary_path && backup_path.exists() => {
            match read_and_parse(&backup_path) {
                Ok(state) => {
                    let corrupt_path = metadata_root.join(format!(
                        "{}.corrupt-{}",
                        WORKSPACE_STATE_FILE,
                        uuid::Uuid::new_v4().simple()
                    ));
                    std::fs::rename(&primary_path, &corrupt_path).map_err(|error| {
                        BackendError::Filesystem {
                            message: format!(
                                "Failed to preserve invalid workspace state {} before recovery: {}",
                                primary_path.display(),
                                error
                            ),
                        }
                    })?;
                    persist_state_sync(metadata_root, &state)?;
                    tracing::warn!(
                        action = "workspace_state_recovered_from_backup",
                        backup_path = %backup_path.display(),
                        primary_path = %primary_path.display(),
                        corrupt_path = %corrupt_path.display(),
                        reason = "primary_invalid",
                        primary_error = %primary_error
                    );
                    Ok(Some(state))
                }
                Err(backup_error) => Err(BackendError::Validation(format!(
                    "Workspace state and backup are both invalid. Primary error: {}; backup error: {}",
                    primary_error, backup_error
                ))),
            }
        }
        Err(error) => Err(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ManualFeatureMetadataSnapshot {
    id: String,
    conversation_id: Option<String>,
    draft: bool,
    title: String,
    description: String,
    status: String,
    feature_slug: Option<String>,
    task_kind: Option<String>,
    branch_name: Option<String>,
    archived_at: Option<String>,
    archive_reason: Option<String>,
    merged_at: Option<String>,
    base_branch: String,
    project_ids: Vec<String>,
    context_project_ids: Vec<String>,
    execution_targets: Vec<WorkspaceTaskExecutionTargetDto>,
    merge_workflow: Option<ManualFeatureMergeWorkflowDto>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn normalize_manual_feature_timestamp(value: Option<String>, fallback: &str) -> String {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn manual_feature_snapshot_to_dto(
    snapshot: ManualFeatureMetadataSnapshot,
) -> Option<ManualFeatureDto> {
    let id = snapshot.id.trim().to_string();
    if id.is_empty() {
        return None;
    }

    let fallback_timestamp = Utc::now().to_rfc3339();
    let updated_at = normalize_manual_feature_timestamp(snapshot.updated_at, &fallback_timestamp);
    let created_at = normalize_manual_feature_timestamp(snapshot.created_at, &updated_at);
    let base_branch = snapshot.base_branch.trim().to_string();

    Some(ManualFeatureDto {
        id: id.clone(),
        conversation_id: snapshot
            .conversation_id
            .map(|value| value.trim().to_string())
            .unwrap_or_default(),
        draft: snapshot.draft,
        title: if snapshot.title.trim().is_empty() {
            id.clone()
        } else {
            snapshot.title.trim().to_string()
        },
        description: snapshot.description,
        status: if snapshot.status.trim().is_empty() {
            "Pending".to_string()
        } else {
            snapshot.status.trim().to_string()
        },
        feature_slug: snapshot
            .feature_slug
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        task_kind: snapshot
            .task_kind
            .map(|value| value.trim().to_lowercase())
            .filter(|value| matches!(value.as_str(), "feature" | "bugfix" | "hotfix")),
        branch_name: snapshot
            .branch_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        archived_at: snapshot.archived_at,
        archive_reason: snapshot.archive_reason,
        merged_at: snapshot.merged_at,
        base_branch: if base_branch.is_empty() {
            "main".to_string()
        } else {
            base_branch
        },
        project_ids: snapshot.project_ids,
        context_project_ids: snapshot.context_project_ids,
        execution_targets: snapshot.execution_targets,
        merge_workflow: snapshot.merge_workflow,
        created_at,
        updated_at,
    })
}

fn load_manual_features_from_metadata_root_sync(metadata_root: &Path) -> Vec<ManualFeatureDto> {
    let manual_features_root = metadata_root.join(MANUAL_FEATURES_METADATA_DIR);
    let Ok(entries) = std::fs::read_dir(&manual_features_root) else {
        return Vec::new();
    };

    let mut features = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }

        let metadata_file = entry.path().join(MANUAL_FEATURE_METADATA_FILE);
        let Ok(content) = std::fs::read_to_string(&metadata_file) else {
            continue;
        };
        let snapshot = match serde_json::from_str::<ManualFeatureMetadataSnapshot>(&content) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::warn!(
                    action = "manual_feature_metadata_snapshot_ignored",
                    path = %metadata_file.display(),
                    error = %error,
                    "Ignored an invalid manual feature metadata snapshot while loading @macro."
                );
                continue;
            }
        };
        if let Some(feature) = manual_feature_snapshot_to_dto(snapshot) {
            features.push(feature);
        }
    }

    features.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    features
}

fn merge_manual_feature_snapshots_from_metadata_root(
    state: &mut WorkspaceState,
    metadata_root: &Path,
) -> usize {
    let mut known_ids = state
        .manual_features
        .iter()
        .map(|feature| feature.id.clone())
        .collect::<HashSet<_>>();
    let deleted_ids = state
        .deleted_manual_feature_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    let recovered_features = load_manual_features_from_metadata_root_sync(metadata_root);
    let mut added = 0;

    for feature in recovered_features {
        if deleted_ids.contains(feature.id.as_str()) {
            continue;
        }
        if known_ids.insert(feature.id.clone()) {
            state.manual_features.push(feature);
            added += 1;
        }
    }

    if added > 0 {
        state
            .manual_features
            .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        tracing::info!(
            action = "manual_feature_metadata_snapshots_loaded",
            added,
            metadata_root = %metadata_root.display(),
            "Loaded manual feature snapshots directly from @macro metadata."
        );
    }

    added
}

fn collect_project_ids_from_json_value(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for key in [
                "projectId",
                "project_id",
                "expectedProjectIds",
                "projectIds",
                "project_ids",
                "availableProjectIds",
            ] {
                if let Some(nested) = map.get(key) {
                    collect_project_ids_from_json_value(nested, output);
                }
            }
            if let Some(replicas) = map.get("replicas") {
                collect_project_ids_from_json_value(replicas, output);
            }
            if let Some(participants) = map.get("participants") {
                collect_project_ids_from_json_value(participants, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_project_ids_from_json_value(item, output);
            }
        }
        Value::String(value) => {
            let candidate = value.trim();
            if candidate.starts_with("project-") {
                output.push(candidate.to_string());
            }
        }
        _ => {}
    }
}

fn collect_project_ids_from_json_file(path: &Path, output: &mut Vec<String>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    collect_project_ids_from_json_value(&value, output);
}

fn infer_project_id_from_macro_metadata_root_sync(metadata_root: &Path) -> Option<String> {
    let mut project_ids = Vec::new();

    let manual_features_root = metadata_root.join(MANUAL_FEATURES_METADATA_DIR);
    if let Ok(entries) = std::fs::read_dir(&manual_features_root) {
        for entry in entries.flatten() {
            let metadata_file = entry.path().join(MANUAL_FEATURE_METADATA_FILE);
            collect_project_ids_from_json_file(&metadata_file, &mut project_ids);
        }
    }

    let branches_root = metadata_root.join(MACRO_BRANCHES_METADATA_DIR);
    if let Ok(branches) = std::fs::read_dir(&branches_root) {
        for branch in branches.flatten() {
            let plans_root = branch.path().join("plans");
            collect_project_ids_from_json_file(&plans_root.join("index.json"), &mut project_ids);
            let Ok(plans) = std::fs::read_dir(&plans_root) else {
                continue;
            };
            for plan in plans.flatten() {
                let plan_path = plan.path();
                if !plan_path.is_dir() {
                    continue;
                }
                collect_project_ids_from_json_file(
                    &plan_path.join("manifest.json"),
                    &mut project_ids,
                );
                collect_project_ids_from_json_file(&plan_path.join("plan.json"), &mut project_ids);
            }
        }
    }

    project_ids
        .into_iter()
        .map(|project_id| project_id.trim().to_string())
        .find(|project_id| !project_id.is_empty())
}

fn fallback_recovered_project_id(workspace_path: &Path) -> String {
    let slug = workspace_path
        .file_name()
        .and_then(OsStr::to_str)
        .map(slugify_mount_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "project".to_string());
    format!("project-{slug}-recovered")
}

fn build_recovered_standalone_project_from_workspace_path(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Option<ProjectDto> {
    if !workspace_path.join(".git").exists() {
        return None;
    }
    let project_path = absolutize_path(workspace_path);
    let project_name = project_path
        .file_name()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Recovered project")
        .to_string();
    let project_id = infer_project_id_from_macro_metadata_root_sync(metadata_root)
        .unwrap_or_else(|| fallback_recovered_project_id(&project_path));
    let now = Utc::now().to_rfc3339();

    Some(ProjectDto {
        id: project_id.clone(),
        name: project_name.clone(),
        mount_name: derive_project_mount_name(
            project_path.to_string_lossy().as_ref(),
            &project_name,
            &project_id,
        ),
        path: project_path.to_string_lossy().to_string(),
        git_flow_settings: ProjectGitFlowSettingsDto::default(),
        created_at: now,
        status: "active".to_string(),
        user_read_only: false,
        direct_edit: false,
        git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
        is_read_only: false,
        read_only_reason: None,
        path_kind: "windows".to_string(),
        wsl_distro: None,
        wsl_linux_path: None,
        metadata: ProjectMetadataDto {
            description: String::new(),
            tags: Vec::new(),
            team_members: Vec::new(),
            api_contracts: Vec::new(),
            dependencies: Vec::new(),
        },
    })
}

fn recover_physical_workspace_project_if_missing(
    state: &mut WorkspaceState,
    workspace_path: &Path,
    metadata_root: &Path,
) -> bool {
    if state.project_registry_explicitly_empty {
        return false;
    }
    if count_registry_projects(&state.standalone_projects, &state.project_groups) > 0 {
        return false;
    }
    let Some(project) =
        build_recovered_standalone_project_from_workspace_path(workspace_path, metadata_root)
    else {
        return false;
    };
    tracing::info!(
        action = "physical_workspace_project_recovered",
        project_id = %project.id,
        project_path = %project.path,
        metadata_root = %metadata_root.display(),
        "Recovered the selected physical Git repository as a standalone project at runtime."
    );
    state.standalone_projects.push(project);
    true
}

fn persist_state_sync(metadata_root: &Path, state: &WorkspaceState) -> Result<()> {
    std::fs::create_dir_all(metadata_root).map_err(|error| BackendError::Filesystem {
        message: format!(
            "Failed to create workspace metadata directory {}: {}",
            metadata_root.display(),
            error
        ),
    })?;

    let durable_state = strip_workspace_project_locations(state.clone());
    let serialized =
        serde_json::to_string_pretty(&durable_state).map_err(|error| BackendError::Internal {
            message: format!("Failed to serialize workspace state: {}", error),
        })?;

    write_workspace_state_durably_sync(metadata_root, serialized.as_bytes())?;

    Ok(())
}

fn merge_manual_feature_snapshots_from_project_roots(
    state: &mut WorkspaceState,
    primary_metadata_root: &Path,
) -> usize {
    let mut added = merge_manual_feature_snapshots_from_metadata_root(state, primary_metadata_root);
    let projects = state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .map(|project| (project.id.clone(), PathBuf::from(&project.path)))
        .collect::<Vec<_>>();
    for (project_id, project_path) in projects {
        let Some(root) = resolve_existing_macro_metadata_root(&project_path) else {
            continue;
        };
        if workspace_state_lock_key(&root) == workspace_state_lock_key(primary_metadata_root) {
            continue;
        }
        let existing_ids = state
            .manual_features
            .iter()
            .map(|feature| feature.id.clone())
            .collect::<HashSet<_>>();
        merge_manual_feature_snapshots_from_metadata_root(state, &root);
        state.manual_features.retain(|feature| {
            existing_ids.contains(&feature.id)
                || feature
                    .project_ids
                    .iter()
                    .any(|candidate| candidate == &project_id)
                || feature
                    .execution_targets
                    .iter()
                    .any(|target| target.project_id == project_id)
        });
        added += state
            .manual_features
            .len()
            .saturating_sub(existing_ids.len());
    }
    added
}

fn replace_workspace_state_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source_wide = source
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let destination_wide = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let replaced = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(source, destination)
    }
}

fn write_workspace_state_durably_sync(metadata_root: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(metadata_root).map_err(|error| BackendError::Filesystem {
        message: format!(
            "Failed to create workspace metadata directory {}: {}",
            metadata_root.display(),
            error
        ),
    })?;

    let primary_path = workspace_state_path(metadata_root);
    let backup_path = workspace_state_backup_path(metadata_root);
    let temp_path = metadata_root.join(format!(
        ".{}.macro-tmp-{}",
        WORKSPACE_STATE_FILE,
        uuid::Uuid::new_v4().simple()
    ));

    let write_result = (|| -> Result<()> {
        let mut temp_file =
            std::fs::File::create(&temp_path).map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to create temporary workspace state {}: {}",
                    temp_path.display(),
                    error
                ),
            })?;
        temp_file
            .write_all(bytes)
            .and_then(|_| temp_file.flush())
            .and_then(|_| temp_file.sync_all())
            .map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to write temporary workspace state {}: {}",
                    temp_path.display(),
                    error
                ),
            })?;

        if primary_path.exists() {
            std::fs::copy(&primary_path, &backup_path).map_err(|error| {
                BackendError::Filesystem {
                    message: format!(
                        "Failed to back up workspace state {} to {}: {}",
                        primary_path.display(),
                        backup_path.display(),
                        error
                    ),
                }
            })?;
            if let Ok(backup_file) = std::fs::File::open(&backup_path) {
                let _ = backup_file.sync_all();
            }
        }

        if let Err(error) = replace_workspace_state_file(&temp_path, &primary_path) {
            if !primary_path.exists() && backup_path.exists() {
                let _ = std::fs::copy(&backup_path, &primary_path);
            }
            return Err(BackendError::Filesystem {
                message: format!(
                    "Failed to replace workspace state {}: {}",
                    primary_path.display(),
                    error
                ),
            });
        }

        #[cfg(unix)]
        if let Ok(directory) = std::fs::File::open(metadata_root) {
            let _ = directory.sync_all();
        }

        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

fn load_state_sync(workspace_path: &Path, metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let Some(state) = load_raw_state_sync(metadata_root)? else {
        return Ok(None);
    };

    let raw_state = state.clone();
    let (sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, state);
    let mut loaded_state = if repair_report.has_destructive_repairs() {
        raw_state
    } else {
        if repair_report.has_repairs() {
            persist_state_sync(metadata_root, &sanitized_state)?;
        }
        sanitized_state
    };

    merge_manual_feature_snapshots_from_project_roots(&mut loaded_state, metadata_root);
    recover_physical_workspace_project_if_missing(&mut loaded_state, workspace_path, metadata_root);

    if repair_report.has_destructive_repairs() {
        return Ok(Some(loaded_state));
    }

    Ok(Some(loaded_state))
}

fn metadata_statuses(repo: &Repository) -> Result<(bool, bool)> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let has_conflicts = statuses.iter().any(|entry| entry.status().is_conflicted())
        || repo.path().join("MERGE_HEAD").exists();
    let is_dirty = !statuses.is_empty();
    Ok((is_dirty, has_conflicts))
}

fn has_macro_upstream(repo: &Repository) -> bool {
    repo.find_branch(MACRO_BRANCH_NAME, BranchType::Local)
        .ok()
        .and_then(|branch| branch.upstream().ok())
        .is_some()
}

fn pull_macro_branch_best_effort(
    repo: &Repository,
    metadata_root: &Path,
) -> (bool, bool, Option<String>) {
    if repo.find_remote(DEFAULT_REMOTE_NAME).is_err() || !has_macro_upstream(repo) {
        return (false, false, None);
    }

    let mut command = background_command("git");
    command.current_dir(metadata_root).args([
        "pull",
        "--no-rebase",
        DEFAULT_REMOTE_NAME,
        MACRO_BRANCH_NAME,
    ]);
    let output = command.output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let details = if stdout.is_empty() && stderr.is_empty() {
                None
            } else if stdout.is_empty() {
                Some(stderr)
            } else if stderr.is_empty() {
                Some(stdout)
            } else {
                Some(format!("{}\n{}", stdout, stderr))
            };
            (true, output.status.success(), details)
        }
        Err(error) => (
            true,
            false,
            Some(format!(
                "Failed to pull @macro metadata before recovery: {}",
                error
            )),
        ),
    }
}

fn try_read_workspace_state_from_tree(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    path: &str,
) -> Option<WorkspaceState> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let object = entry.to_object(repo).ok()?;
    let blob = object.as_blob()?;
    let content = std::str::from_utf8(blob.content()).ok()?;
    serde_json::from_str::<WorkspaceState>(content).ok()
}

fn is_workspace_state_exploitable(state: &WorkspaceState) -> bool {
    !state.standalone_projects.is_empty()
        || !state.project_groups.is_empty()
        || state.current_plan.is_some()
        || !state.plan_nodes.is_empty()
        || !state.predicted_branches.is_empty()
        || !state.manual_features.is_empty()
}

fn find_last_valid_metadata_commit(repo: &Repository) -> Result<Option<(Oid, WorkspaceState)>> {
    let mut revwalk = repo.revwalk()?;
    revwalk.push_ref(&format!("refs/heads/{}", MACRO_BRANCH_NAME))?;
    let _ = revwalk.set_sorting(Sort::TIME);

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let state =
            try_read_workspace_state_from_tree(repo, &tree, WORKSPACE_STATE_FILE).or_else(|| {
                try_read_workspace_state_from_tree(
                    repo,
                    &tree,
                    &format!("{}/{}", LEGACY_WORKSPACE_META_DIR, WORKSPACE_STATE_FILE),
                )
            });
        if let Some(state) = state.filter(is_workspace_state_exploitable) {
            return Ok(Some((oid, state)));
        }
    }

    Ok(None)
}

fn project_name_from_hint(hint: &WorkspaceMetadataRecoveryHintDto, resolved_path: &Path) -> String {
    let trimmed = hint.name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    resolved_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Recovered project")
        .to_string()
}

fn reconstruct_workspace_state_from_hints(
    workspace_path: &Path,
    hints: &[WorkspaceMetadataRecoveryHintDto],
) -> WorkspaceState {
    #[derive(Clone)]
    struct RecoveryCandidate {
        project_id: String,
        group_id: Option<String>,
        name: String,
        path: String,
        normalized_path: String,
    }

    let mut seen_paths = HashSet::new();
    let mut candidates: Vec<RecoveryCandidate> = Vec::new();

    for hint in hints {
        let raw_path = hint.path.trim();
        if raw_path.is_empty() {
            continue;
        }

        let resolved_path = resolve_project_path(workspace_path, raw_path);
        if !resolved_path.exists() {
            continue;
        }

        let normalized_path = normalized_path_key(&resolved_path);
        if normalized_path.trim().is_empty() || !seen_paths.insert(normalized_path.clone()) {
            continue;
        }

        candidates.push(RecoveryCandidate {
            project_id: hint.project_id.trim().to_string(),
            group_id: hint.group_id.as_ref().map(|value| value.trim().to_string()),
            name: project_name_from_hint(hint, &resolved_path),
            path: raw_path.to_string(),
            normalized_path,
        });
    }

    if candidates.is_empty() {
        return WorkspaceState::default();
    }

    let mut project_id_counts = HashMap::<String, usize>::new();
    for candidate in &candidates {
        if !candidate.project_id.is_empty() {
            *project_id_counts
                .entry(candidate.project_id.clone())
                .or_insert(0) += 1;
        }
    }

    let mut groups_by_key = HashMap::<String, Vec<RecoveryCandidate>>::new();
    let mut group_order: Vec<String> = Vec::new();
    for candidate in candidates {
        let key = candidate
            .group_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("recovered-group-{}", candidate.normalized_path));
        if !groups_by_key.contains_key(&key) {
            group_order.push(key.clone());
        }
        groups_by_key.entry(key).or_default().push(candidate);
    }

    let project_groups = group_order
        .into_iter()
        .filter_map(|group_key| {
            let group_candidates = groups_by_key.remove(&group_key)?;
            let projects = group_candidates
                .iter()
                .map(|candidate| {
                    let mut project = build_project(
                        candidate.name.as_str(),
                        "",
                        Some(candidate.path.as_str()),
                        workspace_path,
                        None,
                    );
                    if project_id_counts.get(&candidate.project_id).copied() == Some(1) {
                        project.id = candidate.project_id.clone();
                    }
                    project.name = candidate.name.clone();
                    project
                })
                .collect::<Vec<_>>();
            let group_name = if projects.len() == 1 {
                projects[0].name.clone()
            } else {
                "Recovered project group".to_string()
            };
            Some(ProjectGroupDto {
                id: group_key,
                name: group_name,
                is_open: true,
                projects,
            })
        })
        .collect::<Vec<_>>();

    let mut state = WorkspaceState {
        version: WorkspaceState::default().version,
        workspace_revision: 0,
        standalone_projects: Vec::new(),
        project_registry_explicitly_empty: false,
        project_groups,
        current_plan: None,
        plan_nodes: Vec::new(),
        predicted_branches: Vec::new(),
        manual_features: Vec::new(),
        deleted_manual_feature_ids: Vec::new(),
        reserved_standalone_feature_slugs: Vec::new(),
    };
    collapse_singleton_project_groups(&mut state);
    state
}

fn hint_project_id_is_recoverable(project_id: &str) -> bool {
    let trimmed = project_id.trim();
    !trimmed.is_empty() && !trimmed.starts_with("session-project-")
}

fn project_macro_metadata_root_is_usable(project_path: &Path) -> bool {
    if let Ok(repo) = Repository::open(project_path) {
        if crate::git::repair_existing_macro_metadata_worktree(&repo)
            .ok()
            .flatten()
            .is_some()
        {
            return true;
        }
    }
    if crate::git::find_existing_macro_metadata_worktree_root(project_path).is_some() {
        return true;
    }

    let legacy_root = project_path.join(LEGACY_WORKSPACE_META_DIR);
    legacy_root.exists() && Repository::open(legacy_root).is_ok()
}

fn resolve_existing_macro_metadata_root(project_path: &Path) -> Option<PathBuf> {
    if let Ok(repo) = Repository::open(project_path) {
        if let Some(result) = crate::git::repair_existing_macro_metadata_worktree(&repo)
            .ok()
            .flatten()
        {
            return Some(result.worktree_path);
        }
    }
    if let Some(worktree_path) =
        crate::git::find_existing_macro_metadata_worktree_root(project_path)
    {
        return Some(worktree_path);
    }

    let legacy_root = project_path.join(LEGACY_WORKSPACE_META_DIR);
    if legacy_root.exists() && Repository::open(&legacy_root).is_ok() {
        return Some(legacy_root);
    }

    None
}

fn collect_project_registry_parent_dirs(
    workspace_path: &Path,
    state: &WorkspaceState,
) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    for project in state.standalone_projects.iter().chain(
        state
            .project_groups
            .iter()
            .flat_map(|group| group.projects.iter()),
    ) {
        let resolved_path = resolve_project_path(workspace_path, &project.path);
        let Some(parent) = resolved_path.parent() else {
            continue;
        };
        if !parent.is_dir() {
            continue;
        }
        let key = normalized_path_key(parent);
        if !key.is_empty() && seen.insert(key) {
            roots.push(parent.to_path_buf());
        }
    }
    roots
}

fn collect_known_project_path_keys(
    workspace_path: &Path,
    state: &WorkspaceState,
) -> HashSet<String> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .filter_map(|project| {
            let key = normalized_path_key(&resolve_project_path(workspace_path, &project.path));
            if key.is_empty() {
                None
            } else {
                Some(key)
            }
        })
        .collect()
}

fn push_project_ids_from_json_value(value: &Value, ids: &mut Vec<String>) {
    if let Some(project_id) = value.get("projectId").and_then(Value::as_str) {
        ids.push(project_id.to_string());
    }
    for key in [
        "projectIds",
        "expectedProjectIds",
        "contextProjectIds",
        "availableProjectIds",
    ] {
        if let Some(values) = value.get(key).and_then(Value::as_array) {
            ids.extend(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string),
            );
        }
    }
    if let Some(map) = value
        .get("targetBranchesByProjectId")
        .and_then(Value::as_object)
    {
        ids.extend(map.keys().cloned());
    }
    if let Some(participants) = value.get("participants").and_then(Value::as_array) {
        ids.extend(participants.iter().filter_map(|participant| {
            participant
                .get("projectId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }));
    }
    if let Some(nodes) = value.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            push_project_ids_from_json_value(node, ids);
        }
    }
    if let Some(branches) = value.get("predictedBranches").and_then(Value::as_array) {
        for branch in branches {
            push_project_ids_from_json_value(branch, ids);
        }
    }
}

fn collect_macro_metadata_project_ids(metadata_root: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    let branches_root = metadata_root.join("branches");
    let Ok(branches) = std::fs::read_dir(branches_root) else {
        return ids;
    };

    for branch in branches.flatten() {
        let plans_root = branch.path().join("plans");
        let Ok(plans) = std::fs::read_dir(plans_root) else {
            continue;
        };
        for plan in plans.flatten() {
            let plan_path = plan.path();
            if !plan_path.is_dir() {
                continue;
            }
            for file_name in ["manifest.json", "plan.json"] {
                let path = plan_path.join(file_name);
                let Ok(content) = std::fs::read_to_string(path) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&content) else {
                    continue;
                };
                push_project_ids_from_json_value(&value, &mut ids);
            }
        }
    }

    ids
}

fn choose_recovery_project_id(ids: Vec<String>) -> Option<String> {
    let mut counts = HashMap::<String, usize>::new();
    for id in ids {
        let trimmed = id.trim();
        if !hint_project_id_is_recoverable(trimmed) {
            continue;
        }
        *counts.entry(trimmed.to_string()).or_insert(0) += 1;
    }
    let mut ranked = counts.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    ranked.into_iter().map(|(id, _)| id).next()
}

fn discover_recoverable_project_hints(
    workspace_path: &Path,
    state: &WorkspaceState,
    max_children_per_root: usize,
) -> Vec<WorkspaceMetadataRecoveryHintDto> {
    let known_paths = collect_known_project_path_keys(workspace_path, state);
    let mut seen_candidate_paths = HashSet::new();
    let mut hints = Vec::new();
    let roots = collect_project_registry_parent_dirs(workspace_path, state);
    let mut scanned_child_count = 0usize;
    let mut known_path_count = 0usize;
    let mut duplicate_candidate_count = 0usize;
    let mut metadata_repo_count = 0usize;
    let mut missing_project_id_count = 0usize;

    for root in &roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten().take(max_children_per_root) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            scanned_child_count += 1;
            let candidate_path = entry.path();
            let normalized_path = normalized_path_key(&candidate_path);
            if normalized_path.is_empty() {
                continue;
            }
            if known_paths.contains(&normalized_path) {
                known_path_count += 1;
                continue;
            }
            if !seen_candidate_paths.insert(normalized_path) {
                duplicate_candidate_count += 1;
                continue;
            }
            let Some(metadata_root) = resolve_existing_macro_metadata_root(&candidate_path) else {
                continue;
            };
            metadata_repo_count += 1;
            let Some(project_id) =
                choose_recovery_project_id(collect_macro_metadata_project_ids(&metadata_root))
            else {
                missing_project_id_count += 1;
                continue;
            };
            let name = candidate_path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Recovered project")
                .to_string();
            hints.push(WorkspaceMetadataRecoveryHintDto {
                project_id,
                group_id: None,
                name,
                path: candidate_path.to_string_lossy().to_string(),
            });
        }
    }

    tracing::info!(
        action = "project_registry_recoverable_project_discovery_scanned",
        root_count = roots.len(),
        known_path_count = known_paths.len(),
        scanned_child_count,
        skipped_known_path_count = known_path_count,
        skipped_duplicate_candidate_count = duplicate_candidate_count,
        metadata_repo_count,
        missing_project_id_count,
        hint_count = hints.len(),
        max_children_per_root,
        "Scanned known project parent directories for recoverable @macro repositories."
    );

    hints
}

fn push_registry_reconcile_skip(
    report: &mut WorkspaceProjectRegistryReconcileReportDto,
    hint: &WorkspaceMetadataRecoveryHintDto,
    reason: &str,
) {
    report
        .skipped_projects
        .push(WorkspaceProjectRegistryReconcileSkippedDto {
            project_id: if hint.project_id.trim().is_empty() {
                None
            } else {
                Some(hint.project_id.trim().to_string())
            },
            path: hint.path.trim().to_string(),
            reason: reason.to_string(),
        });
}

pub async fn reconcile_project_registry_from_hints(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceReconcileProjectRegistryFromHintsRequestDto,
) -> Result<WorkspaceProjectRegistryReconcileReportDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    let mut report = WorkspaceProjectRegistryReconcileReportDto {
        status: "unchanged".to_string(),
        ..WorkspaceProjectRegistryReconcileReportDto::default()
    };
    let mut state = load_raw_state(metadata_root).await?.unwrap_or_default();
    let mut seen_paths = HashSet::new();
    let mut known_project_ids = HashSet::new();

    for project in state.standalone_projects.iter().chain(
        state
            .project_groups
            .iter()
            .flat_map(|group| group.projects.iter()),
    ) {
        known_project_ids.insert(project.id.trim().to_string());
        let resolved_path = resolve_project_path(workspace_path, &project.path);
        let normalized_path = normalized_path_key(&resolved_path);
        if !normalized_path.trim().is_empty() {
            seen_paths.insert(normalized_path);
        }
    }

    for hint in request.projects {
        let raw_path = hint.path.trim();
        let project_id = hint.project_id.trim();
        if raw_path.is_empty() {
            push_registry_reconcile_skip(&mut report, &hint, "missing_path");
            continue;
        }
        if !hint_project_id_is_recoverable(project_id) {
            push_registry_reconcile_skip(&mut report, &hint, "invalid_project_id");
            continue;
        }
        if known_project_ids.contains(project_id) {
            push_registry_reconcile_skip(&mut report, &hint, "duplicate_project_id");
            continue;
        }

        let resolved_path = resolve_project_path(workspace_path, raw_path);
        let normalized_path = normalized_path_key(&resolved_path);
        if normalized_path.trim().is_empty() || !resolved_path.is_dir() {
            report.invalid_paths.push(raw_path.to_string());
            push_registry_reconcile_skip(&mut report, &hint, "invalid_path");
            continue;
        }
        if seen_paths.contains(&normalized_path) {
            report.duplicate_paths.push(raw_path.to_string());
            push_registry_reconcile_skip(&mut report, &hint, "duplicate_path");
            continue;
        }
        if Repository::open(&resolved_path).is_err() && !resolved_path.join(".git").exists() {
            report.invalid_paths.push(raw_path.to_string());
            push_registry_reconcile_skip(&mut report, &hint, "invalid_git_repo");
            continue;
        }
        if !project_macro_metadata_root_is_usable(&resolved_path) {
            push_registry_reconcile_skip(&mut report, &hint, "missing_or_invalid_macro_metadata");
            continue;
        }

        let project = project_from_recovery_hint(&hint, &resolved_path, workspace_path);

        known_project_ids.insert(project.id.clone());
        seen_paths.insert(normalized_path);
        report.added_projects.push(project.clone());
        state.standalone_projects.push(project);
    }

    if !report.added_projects.is_empty() {
        state.version = state.version.max(WorkspaceState::default().version);
        persist_state(metadata_root, &state).await?;
        report.status = "reconciled".to_string();
        tracing::warn!(
            action = "project_registry_reconciled_from_hints",
            added_project_count = report.added_projects.len(),
            skipped_project_count = report.skipped_projects.len(),
            duplicate_path_count = report.duplicate_paths.len(),
            invalid_path_count = report.invalid_paths.len(),
            "Workspace registry was repaired additively from remembered project hints."
        );
    }

    Ok(report)
}

fn project_from_recovery_hint(
    hint: &WorkspaceMetadataRecoveryHintDto,
    resolved_path: &Path,
    workspace_path: &Path,
) -> ProjectDto {
    let project_name = project_name_from_hint(hint, resolved_path);
    let mut project = build_project(&project_name, "", Some(&hint.path), workspace_path, None);
    project.id = hint.project_id.trim().to_string();
    project.name = project_name;
    project.mount_name = derive_project_mount_name(&project.path, &project.name, &project.id);
    project
}

pub async fn discover_recoverable_projects(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto,
) -> Result<WorkspaceProjectRegistryReconcileReportDto> {
    let state = load_raw_state(metadata_root).await?.unwrap_or_default();
    let max_children_per_root = request.max_children_per_root.unwrap_or(250).clamp(1, 1000);
    let hints = discover_recoverable_project_hints(workspace_path, &state, max_children_per_root);

    let mut report = WorkspaceProjectRegistryReconcileReportDto {
        status: if hints.is_empty() {
            "unchanged".to_string()
        } else {
            "discovered".to_string()
        },
        ..WorkspaceProjectRegistryReconcileReportDto::default()
    };

    for hint in hints {
        let resolved_path = resolve_project_path(workspace_path, &hint.path);
        report.discovered_projects.push(project_from_recovery_hint(
            &hint,
            &resolved_path,
            workspace_path,
        ));
    }

    tracing::info!(
        action = "project_registry_discover_recoverable_projects_completed",
        discovered_project_count = report.discovered_projects.len(),
        status = %report.status,
        "Workspace registry recoverable project discovery completed without mutating metadata."
    );
    Ok(report)
}

fn append_report_message(base: Option<String>, extra: Option<String>) -> Option<String> {
    match (
        base.filter(|value| !value.trim().is_empty()),
        extra.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(base), Some(extra)) => Some(format!("{}\n{}", base, extra)),
        (Some(base), None) => Some(base),
        (None, Some(extra)) => Some(extra),
        (None, None) => None,
    }
}

fn sanitize_backup_operation(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "mutation".to_string()
    } else {
        sanitized.chars().take(48).collect()
    }
}

async fn backup_workspace_state_if_present(
    metadata_root: &Path,
    operation: &str,
) -> Result<Option<PathBuf>> {
    let source = workspace_state_path(metadata_root);
    if !source.exists() {
        return Ok(None);
    }

    let now = Utc::now();
    let timestamp = format!(
        "{}-{:03}",
        now.format("%Y%m%d-%H%M%S"),
        now.timestamp_subsec_millis()
    );
    let backup_file_name = format!(
        "{}.bak-{}-{}",
        WORKSPACE_STATE_FILE,
        timestamp,
        sanitize_backup_operation(operation)
    );
    let mut backup_path = metadata_root.join(&backup_file_name);
    let mut collision_index = 1usize;
    while backup_path.exists() {
        backup_path = metadata_root.join(format!("{}.{}", backup_file_name, collision_index));
        collision_index += 1;
    }

    fs::copy(&source, &backup_path)
        .await
        .map_err(|error| BackendError::Filesystem {
            message: format!(
                "Failed to back up workspace state {} to {}: {}",
                source.display(),
                backup_path.display(),
                error
            ),
        })?;

    Ok(Some(backup_path))
}

pub(crate) fn recover_missing_metadata_sync(
    workspace_path: &Path,
    metadata_root: &Path,
    request: &WorkspaceRecoverMissingMetadataRequestDto,
) -> Result<WorkspaceMetadataRecoveryReportDto> {
    let mut report = WorkspaceMetadataRecoveryReportDto {
        status: "none".to_string(),
        restored_commit: None,
        pull_attempted: false,
        pull_succeeded: false,
        message: None,
    };

    let repo = Repository::open(metadata_root).ok();
    if let Some(repo) = repo.as_ref() {
        let (is_dirty, has_conflicts) = metadata_statuses(repo)?;
        if has_conflicts {
            report.status = "blocked_conflict".to_string();
            report.message = Some(
                "Automatic @macro recovery was skipped because the metadata worktree has unresolved conflicts."
                    .to_string(),
            );
            return Ok(report);
        }
        if is_dirty {
            report.status = "blocked_dirty".to_string();
            report.message = Some(
                "Automatic @macro recovery was skipped because the metadata worktree has local changes."
                    .to_string(),
            );
            return Ok(report);
        }

        if request.attempt_pull {
            let (attempted, succeeded, pull_message) =
                pull_macro_branch_best_effort(repo, metadata_root);
            report.pull_attempted = attempted;
            report.pull_succeeded = succeeded;
            report.message = append_report_message(report.message.take(), pull_message);
        }
    }

    let metadata_missing = match load_raw_state_sync(metadata_root) {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(BackendError::Validation(_)) => true,
        Err(error) => return Err(error),
    };

    if !metadata_missing {
        return Ok(report);
    }

    if let Some(repo) = repo.as_ref() {
        if let Some((oid, restored_state)) = find_last_valid_metadata_commit(repo)? {
            let object = repo.find_object(oid, None)?;
            repo.reset(&object, ResetType::Hard, None)?;
            if load_state_sync(workspace_path, metadata_root)?.is_none() {
                let (sanitized_state, _) = sanitize_workspace_state(workspace_path, restored_state);
                persist_state_sync(metadata_root, &sanitized_state)?;
            }
            report.status = "restored_from_history".to_string();
            report.restored_commit = Some(short_oid(oid));
            report.message = append_report_message(
                report.message.take(),
                Some(format!(
                    "@macro metadata was restored from commit {}.",
                    short_oid(oid)
                )),
            );
            return Ok(report);
        }
    }

    let reconstructed = reconstruct_workspace_state_from_hints(workspace_path, &request.projects);
    if !is_workspace_state_exploitable(&reconstructed) {
        report.message = append_report_message(
            report.message.take(),
            Some("No recoverable @macro history or local project hints were found.".to_string()),
        );
        return Ok(report);
    }

    let (sanitized_state, _) = sanitize_workspace_state(workspace_path, reconstructed);
    persist_state_sync(metadata_root, &sanitized_state)?;
    report.status = "reconstructed_from_hints".to_string();
    report.message = append_report_message(
        report.message.take(),
        Some("@macro metadata was reconfigured from local project hints.".to_string()),
    );
    Ok(report)
}

pub async fn recover_missing_metadata(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceRecoverMissingMetadataRequestDto,
) -> Result<WorkspaceMetadataRecoveryReportDto> {
    let _state_guard = lock_workspace_state(metadata_root).await;
    recover_missing_metadata_sync(workspace_path, metadata_root, &request)
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

    let mut state = WorkspaceState::default();
    merge_manual_feature_snapshots_from_project_roots(&mut state, metadata_root);
    recover_physical_workspace_project_if_missing(&mut state, workspace_path, metadata_root);
    Ok(state)
}

async fn load_state(workspace_path: &Path, metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let Some(state) = load_raw_state(metadata_root).await? else {
        return Ok(None);
    };

    let raw_state = state.clone();
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
            predicted_branches_removed = repair_report.predicted_branches_removed,
            git_flow_settings_auto_updated = repair_report.git_flow_settings_auto_updated
        );
        if repair_report.has_destructive_repairs() {
            tracing::warn!(
                action = "project_registry_state_sanitized_not_persisted",
                reason = "destructive_repairs_during_load",
                "Workspace metadata repairs were ignored because a simple load must not remove projects or task metadata."
            );
            let mut loaded_state = raw_state;
            merge_manual_feature_snapshots_from_project_roots(&mut loaded_state, metadata_root);
            recover_physical_workspace_project_if_missing(
                &mut loaded_state,
                workspace_path,
                metadata_root,
            );
            return Ok(Some(loaded_state));
        } else {
            persist_state(metadata_root, &sanitized_state).await?;
        }
    }

    let mut loaded_state = sanitized_state;
    merge_manual_feature_snapshots_from_project_roots(&mut loaded_state, metadata_root);
    recover_physical_workspace_project_if_missing(&mut loaded_state, workspace_path, metadata_root);

    Ok(Some(loaded_state))
}

async fn load_raw_state(metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let metadata_root = metadata_root.to_path_buf();
    tokio::task::spawn_blocking(move || load_raw_state_sync(&metadata_root))
        .await
        .map_err(|error| BackendError::Internal {
            message: format!("Workspace state load task failed: {error}"),
        })?
}

fn sanitize_project_entry(
    workspace_path: &Path,
    project: ProjectDto,
    seen_paths: &mut HashSet<String>,
    repair_report: &mut ProjectRegistryRepairReportDto,
) -> Option<ProjectDto> {
    if project.id.starts_with("session-project-") {
        repair_report.removed_synthetic_projects += 1;
        repair_report.removed_project_ids.push(project.id);
        return None;
    }

    let resolved_path = resolve_project_path(workspace_path, &project.path);
    let normalized_key = normalized_path_key(&resolved_path);
    if normalized_key.trim().is_empty() {
        repair_report.removed_project_ids.push(project.id);
        return None;
    }

    if seen_paths.contains(&normalized_key) {
        repair_report.duplicate_paths_removed += 1;
        repair_report.removed_project_ids.push(project.id);
        return None;
    }

    seen_paths.insert(normalized_key);
    if parse_wsl_unc_path(&project.path).is_some() {
        return Some(enrich_project_location(project));
    }
    let git_flow_settings = auto_detect_project_git_flow_settings(
        workspace_path,
        &project.path,
        Some(&project.git_flow_settings),
    );
    let git_detection =
        detect_project_git_flow_internal(workspace_path, Some(project.path.as_str()));
    if git_flow_settings != project.git_flow_settings {
        repair_report.git_flow_settings_auto_updated += 1;
    }
    Some(normalize_project_access(
        ProjectDto {
            git_flow_settings,
            ..project
        },
        derive_git_setup_state(&git_detection),
    ))
}

fn sanitize_workspace_state(
    workspace_path: &Path,
    mut state: WorkspaceState,
) -> (WorkspaceState, ProjectRegistryRepairReportDto) {
    let mut repair_report = ProjectRegistryRepairReportDto::default();
    let mut seen_paths = HashSet::new();
    let mut sanitized_standalone_projects = Vec::with_capacity(state.standalone_projects.len());
    let mut sanitized_groups = Vec::with_capacity(state.project_groups.len());

    for project in std::mem::take(&mut state.standalone_projects) {
        if let Some(project) =
            sanitize_project_entry(workspace_path, project, &mut seen_paths, &mut repair_report)
        {
            sanitized_standalone_projects.push(project);
        }
    }

    for group in std::mem::take(&mut state.project_groups) {
        if group.id.starts_with("session-group-") {
            repair_report.removed_synthetic_groups += 1;
            repair_report.removed_group_ids.push(group.id);
            continue;
        }

        let mut sanitized_projects = Vec::with_capacity(group.projects.len());
        for project in group.projects {
            if let Some(project) =
                sanitize_project_entry(workspace_path, project, &mut seen_paths, &mut repair_report)
            {
                sanitized_projects.push(project);
            }
        }

        if sanitized_projects.is_empty() {
            repair_report.empty_groups_removed += 1;
            repair_report.removed_group_ids.push(group.id);
            continue;
        }

        if sanitized_projects.len() == 1 {
            repair_report.singleton_groups_migrated += 1;
            sanitized_standalone_projects.extend(sanitized_projects);
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

    repair_report.mount_names_assigned +=
        assign_group_mount_names(&mut sanitized_standalone_projects);
    state.standalone_projects = sanitized_standalone_projects;
    state.project_groups = sanitized_groups;
    let _valid_project_ids = collect_valid_project_ids_from_state(&state);
    let actionable_project_ids = collect_actionable_project_ids_from_state(&state);
    let git_actionable_project_ids = collect_git_actionable_project_ids_from_state(&state);
    let read_only_project_ids = collect_read_only_project_ids_from_state(&state);
    let architect_context_project_ids = collect_architect_context_project_ids_from_state(&state);

    if let Some(plan) = state.current_plan.as_mut() {
        let original_project_ids = plan.project_ids.clone();
        let initial_project_ids = plan.project_ids.len();
        plan.project_ids
            .retain(|project_id| git_actionable_project_ids.contains(project_id));
        let mut unique_project_ids = HashSet::new();
        plan.project_ids
            .retain(|project_id| unique_project_ids.insert(project_id.clone()));
        let mut context_project_ids =
            sanitize_project_id_list(&plan.context_project_ids, &architect_context_project_ids);
        for project_id in original_project_ids {
            if architect_context_project_ids.contains(&project_id)
                && !context_project_ids.iter().any(|value| value == &project_id)
            {
                context_project_ids.push(project_id);
            }
        }
        plan.context_project_ids = context_project_ids;
        repair_report.current_plan_project_ids_removed =
            initial_project_ids.saturating_sub(plan.project_ids.len());

        let (sanitized_tasks, removed_tasks, removed_targets) = sanitize_plan_tasks(
            &plan.tasks,
            &git_actionable_project_ids,
            &architect_context_project_ids,
        );
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
    let (sanitized_manual_features, removed_manual_feature_targets) = sanitize_manual_features(
        &state.manual_features,
        &actionable_project_ids,
        &read_only_project_ids,
    );
    state.manual_features = sanitized_manual_features;
    repair_report.manual_features_removed =
        initial_manual_feature_count.saturating_sub(state.manual_features.len());
    repair_report.manual_feature_targets_removed = removed_manual_feature_targets;
    let mut reserved_standalone_feature_slugs = state
        .reserved_standalone_feature_slugs
        .iter()
        .map(|value| slugify(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    for feature in &state.manual_features {
        if let Some(feature_slug) = feature.feature_slug.as_ref() {
            let normalized = slugify(feature_slug);
            if !normalized.is_empty() {
                reserved_standalone_feature_slugs.insert(normalized);
            }
        }
    }
    state.reserved_standalone_feature_slugs = reserved_standalone_feature_slugs
        .into_iter()
        .collect::<Vec<_>>();
    state.reserved_standalone_feature_slugs.sort();

    let initial_plan_node_count = state.plan_nodes.len();
    state.plan_nodes.retain(|node| {
        node.project_id
            .as_ref()
            .map(|project_id| git_actionable_project_ids.contains(project_id))
            .unwrap_or(true)
    });
    repair_report.plan_nodes_removed =
        initial_plan_node_count.saturating_sub(state.plan_nodes.len());

    let initial_predicted_branch_count = state.predicted_branches.len();
    state
        .predicted_branches
        .retain(|branch| git_actionable_project_ids.contains(&branch.project_id));
    repair_report.predicted_branches_removed =
        initial_predicted_branch_count.saturating_sub(state.predicted_branches.len());

    (state, repair_report)
}

fn sanitize_plan_tasks(
    tasks: &[Value],
    actionable_project_ids: &HashSet<String>,
    read_only_project_ids: &HashSet<String>,
) -> (Vec<Value>, usize, usize) {
    let mut removed_tasks = 0usize;
    let mut removed_targets = 0usize;
    let mut sanitized_tasks = Vec::with_capacity(tasks.len());

    for task in tasks {
        let Some(task_object) = task.as_object() else {
            sanitized_tasks.push(task.clone());
            continue;
        };

        let mut next_task = serde_json::Map::from_iter(task_object.clone());
        let original_project_ids = task_object
            .get("project_ids")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut context_project_ids = sanitize_json_project_id_list(
            next_task.get("context_project_ids"),
            read_only_project_ids,
        );
        let project_ids =
            sanitize_json_project_id_list(next_task.get("project_ids"), actionable_project_ids);
        let project_id_strings = project_ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();

        if next_task.contains_key("project_ids") {
            if project_ids.is_empty() {
                next_task.remove("project_ids");
            } else {
                next_task.insert("project_ids".to_string(), Value::Array(project_ids.clone()));
            }
        }

        let mut removed_from_primary_projects = original_project_ids
            .into_iter()
            .filter(|project_id| read_only_project_ids.contains(project_id))
            .collect::<Vec<_>>();
        if let Some(project_id) = next_task.get("project_id").and_then(|value| value.as_str()) {
            if read_only_project_ids.contains(project_id) {
                removed_from_primary_projects.push(project_id.to_string());
            }
        }
        for project_id in removed_from_primary_projects {
            if !context_project_ids
                .iter()
                .any(|value| value.as_str() == Some(project_id.as_str()))
            {
                context_project_ids.push(Value::String(project_id));
            }
        }
        if next_task.contains_key("context_project_ids") || !context_project_ids.is_empty() {
            if context_project_ids.is_empty() {
                next_task.remove("context_project_ids");
            } else {
                next_task.insert(
                    "context_project_ids".to_string(),
                    Value::Array(context_project_ids.clone()),
                );
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
                            .map(|project_id| actionable_project_ids.contains(project_id))
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
            .map(|project_id| actionable_project_ids.contains(project_id))
            .unwrap_or(true);

        if !is_primary_project_valid {
            if let Some(next_project_id) = fallback_project_id.clone() {
                next_task.insert("project_id".to_string(), Value::String(next_project_id));
            } else {
                next_task.remove("project_id");
            }
        } else if !next_task.contains_key("project_id") {
            if let Some(next_project_id) = fallback_project_id {
                next_task.insert("project_id".to_string(), Value::String(next_project_id));
            }
        }

        let has_actionable_project = next_task
            .get("project_id")
            .and_then(|value| value.as_str())
            .map(|project_id| actionable_project_ids.contains(project_id))
            .unwrap_or(false)
            || !project_id_strings.is_empty()
            || !execution_targets.is_empty();
        if !has_actionable_project {
            removed_tasks += 1;
            continue;
        }

        sanitized_tasks.push(Value::Object(next_task));
    }

    (sanitized_tasks, removed_tasks, removed_targets)
}

fn sanitize_manual_features(
    features: &[ManualFeatureDto],
    actionable_project_ids: &HashSet<String>,
    read_only_project_ids: &HashSet<String>,
) -> (Vec<ManualFeatureDto>, usize) {
    let mut removed_targets = 0usize;
    let mut sanitized_features = Vec::with_capacity(features.len());

    for feature in features {
        let project_ids = sanitize_project_id_list(&feature.project_ids, actionable_project_ids);
        let mut context_project_ids =
            sanitize_project_id_list(&feature.context_project_ids, read_only_project_ids);
        for project_id in &feature.project_ids {
            if read_only_project_ids.contains(project_id)
                && !context_project_ids.iter().any(|value| value == project_id)
            {
                context_project_ids.push(project_id.clone());
            }
        }
        let initial_target_len = feature.execution_targets.len();
        let execution_targets = feature
            .execution_targets
            .iter()
            .filter(|target| actionable_project_ids.contains(&target.project_id))
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

        if fallback_project_ids.is_empty() && context_project_ids.is_empty() {
            continue;
        }

        let task_kind = feature
            .task_kind
            .as_ref()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| matches!(value.as_str(), "feature" | "bugfix" | "hotfix"));

        sanitized_features.push(ManualFeatureDto {
            project_ids: fallback_project_ids,
            context_project_ids,
            execution_targets,
            task_kind,
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
    let _file_guard = lock_workspace_state_file(metadata_root)?;
    let (mut sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, state);
    if count_registry_projects(
        &sanitized_state.standalone_projects,
        &sanitized_state.project_groups,
    ) > 0
    {
        sanitized_state.project_registry_explicitly_empty = false;
    }
    let persisted_revision = load_raw_state_sync(metadata_root)?
        .map(|current| current.workspace_revision)
        .unwrap_or(0);
    if persisted_revision != sanitized_state.workspace_revision {
        return Err(BackendError::Validation(
            "Le workspace a été modifié par une autre instance. Actualisez puis réessayez."
                .to_string(),
        ));
    }
    sanitized_state.workspace_revision = sanitized_state.workspace_revision.saturating_add(1);
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
            predicted_branches_removed = repair_report.predicted_branches_removed,
            git_flow_settings_auto_updated = repair_report.git_flow_settings_auto_updated
        );
    }

    if repair_report.has_destructive_repairs() {
        if let Some(backup_path) =
            backup_workspace_state_if_present(metadata_root, operation).await?
        {
            tracing::warn!(
                action = "project_registry_destructive_repair_backup_created",
                operation,
                backup_path = %backup_path.display()
            );
        }
    }

    persist_state(metadata_root, &sanitized_state).await?;
    Ok((sanitized_state, repair_report))
}

async fn persist_state(workspace_path: &Path, state: &WorkspaceState) -> Result<()> {
    let durable_state = strip_workspace_project_locations(state.clone());
    let serialized =
        serde_json::to_string_pretty(&durable_state).map_err(|error| BackendError::Internal {
            message: format!("Failed to serialize workspace state: {}", error),
        })?;
    let workspace_path = workspace_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        write_workspace_state_durably_sync(&workspace_path, serialized.as_bytes())
    })
    .await
    .map_err(|error| BackendError::Internal {
        message: format!("Workspace state persistence task failed: {error}"),
    })?
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
    let git_detection =
        detect_project_git_flow_internal(workspace_path, Some(project_path.as_str()));
    let detected_git_flow_settings =
        auto_detect_project_git_flow_settings(workspace_path, &project_path, git_flow_settings);

    normalize_project_access(
        ProjectDto {
            id: id.clone(),
            name: normalized_name,
            mount_name: derive_project_mount_name(&project_path, name, &id),
            path: project_path,
            created_at: now,
            status: "active".to_string(),
            git_flow_settings: detected_git_flow_settings,
            user_read_only: false,
            direct_edit: false,
            git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
            is_read_only: false,
            read_only_reason: None,
            path_kind: "windows".to_string(),
            wsl_distro: None,
            wsl_linux_path: None,
            metadata: ProjectMetadataDto {
                description: description.to_string(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        },
        derive_git_setup_state(&git_detection),
    )
}

async fn build_project_for_add(
    name: &str,
    description: &str,
    path: Option<&str>,
    workspace_path: &Path,
    git_flow_settings: Option<&ProjectGitFlowSettingsDto>,
    direct_edit: bool,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> Result<ProjectDto> {
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
    let git_detection =
        detect_project_git_flow_for_add(workspace_path, Some(project_path.as_str()), cancel_rx)
            .await?;
    let detected_git_flow_settings =
        auto_detect_project_git_flow_settings_from_detection(git_flow_settings, &git_detection);

    Ok(normalize_project_access(
        ProjectDto {
            id: id.clone(),
            name: normalized_name,
            mount_name: derive_project_mount_name(&project_path, name, &id),
            path: project_path,
            created_at: now,
            status: "active".to_string(),
            git_flow_settings: detected_git_flow_settings,
            user_read_only: false,
            direct_edit,
            git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
            is_read_only: false,
            read_only_reason: None,
            path_kind: "windows".to_string(),
            wsl_distro: None,
            wsl_linux_path: None,
            metadata: ProjectMetadataDto {
                description: description.to_string(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        },
        derive_git_setup_state(&git_detection),
    ))
}

fn normalize_project_git_flow_settings(
    settings: Option<&ProjectGitFlowSettingsDto>,
) -> ProjectGitFlowSettingsDto {
    let defaults = ProjectGitFlowSettingsDto::default();
    let input = settings.cloned().unwrap_or_default();

    ProjectGitFlowSettingsDto {
        base_branch: normalize_base_branch(Some(input.base_branch.as_str())),
        main_branch: normalize_base_branch(Some(input.main_branch.as_str())),
        completion_merge_policy: match input.completion_merge_policy.as_str() {
            "fast_forward" => "fast_forward".to_string(),
            _ => "merge_commit".to_string(),
        },
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

const GIT_FLOW_PARSE_PATTERN: &str = r"[a-z0-9._-]+";

fn compile_branch_template_regex(
    template: &str,
    allowed_tokens: &[&str],
) -> std::result::Result<(Regex, Vec<String>, Vec<String>), String> {
    let token_regex =
        Regex::new(r"\{([A-Za-z][A-Za-z0-9]*)\}").map_err(|error| error.to_string())?;
    let mut seen_tokens = HashSet::new();
    let mut duplicate_tokens = Vec::new();
    let mut unsupported_tokens = Vec::new();
    let mut pattern = String::from("^");
    let mut last_index = 0usize;

    for captures in token_regex.captures_iter(template) {
        let Some(full_match) = captures.get(0) else {
            continue;
        };
        let Some(token_match) = captures.get(1) else {
            continue;
        };
        let token = token_match.as_str();
        pattern.push_str(&regex::escape(&template[last_index..full_match.start()]));
        if allowed_tokens.contains(&token) {
            if !seen_tokens.insert(token.to_string()) {
                duplicate_tokens.push(token.to_string());
            }
            pattern.push_str(&format!("(?P<{}>{})", token, GIT_FLOW_PARSE_PATTERN));
        } else {
            unsupported_tokens.push(token.to_string());
            pattern.push_str(&regex::escape(full_match.as_str()));
        }
        last_index = full_match.end();
    }

    pattern.push_str(&regex::escape(&template[last_index..]));
    pattern.push('$');

    let regex = Regex::new(&pattern).map_err(|error| error.to_string())?;
    Ok((regex, duplicate_tokens, unsupported_tokens))
}

fn is_valid_git_branch_name(branch_name: &str) -> bool {
    let normalized = normalize_branch_template(Some(branch_name), "");
    if normalized.is_empty() {
        return false;
    }

    let ref_name = format!("refs/heads/{}", normalized);
    git2::Reference::is_valid_name(&ref_name)
}

fn render_plan_branch_name(settings: &ProjectGitFlowSettingsDto, plan_slug: &str) -> String {
    let rendered =
        replace_template_tokens(&settings.plan_branch_template, &[("planSlug", plan_slug)]);
    normalize_branch_template(Some(rendered.as_str()), &format!("plan/{}", plan_slug))
}

fn render_plan_feature_branch_name(
    settings: &ProjectGitFlowSettingsDto,
    plan_slug: &str,
    feature_slug: &str,
) -> String {
    let rendered = replace_template_tokens(
        &settings.feature_branch_template,
        &[("planSlug", plan_slug), ("featureSlug", feature_slug)],
    );
    normalize_branch_template(
        Some(rendered.as_str()),
        &format!("feature/{}/{}", plan_slug, feature_slug),
    )
}

fn validate_project_git_flow_settings_strict(settings: &ProjectGitFlowSettingsDto) -> Result<()> {
    let normalized = normalize_project_git_flow_settings(Some(settings));
    let mut errors = Vec::new();

    if normalized.base_branch.trim().is_empty() {
        errors.push("Base branch cannot be empty.".to_string());
    }

    if normalized.main_branch.trim().is_empty() {
        errors.push("Main branch cannot be empty.".to_string());
    }

    if normalized.completion_merge_policy != "merge_commit"
        && normalized.completion_merge_policy != "fast_forward"
    {
        errors.push("Completion merge policy must be merge_commit or fast_forward.".to_string());
    }

    let required_tokens = [
        (
            "Plan branch template",
            normalized.plan_branch_template.as_str(),
            vec!["planSlug"],
        ),
        (
            "Feature branch template",
            normalized.feature_branch_template.as_str(),
            vec!["planSlug", "featureSlug"],
        ),
        (
            "Independent feature branch template",
            normalized.standalone_feature_branch_template.as_str(),
            vec!["featureSlug"],
        ),
    ];

    for (label, template, tokens) in &required_tokens {
        for token in tokens {
            if !template.contains(&format!("{{{}}}", token)) {
                errors.push(format!("{} must include {{{}}}.", label, token));
            }
        }
    }

    let sample_plan_slug = "checkout-rework";
    let sample_feature_slug = "checkout-api";

    let validate_round_trip = |label: &str,
                               template: &str,
                               allowed_tokens: &[&str],
                               rendered: String,
                               expected_pairs: &[(&str, &str)],
                               errors: &mut Vec<String>| {
        match compile_branch_template_regex(template, allowed_tokens) {
            Ok((regex, duplicate_tokens, unsupported_tokens)) => {
                if !duplicate_tokens.is_empty() {
                    errors.push(format!(
                        "{} cannot repeat tokens: {}.",
                        label,
                        duplicate_tokens.join(", ")
                    ));
                }
                if !unsupported_tokens.is_empty() {
                    errors.push(format!(
                        "{} cannot include unsupported tokens: {}.",
                        label,
                        unsupported_tokens.join(", ")
                    ));
                }
                if !is_valid_git_branch_name(&rendered) {
                    errors.push(format!("{} must render a valid Git branch name.", label));
                }

                match regex.captures(&rendered) {
                    Some(captures) => {
                        for (token, expected_value) in expected_pairs {
                            let actual_value = captures.name(token).map(|value| value.as_str());
                            if actual_value != Some(*expected_value) {
                                errors.push(format!(
                                    "{} must preserve {} in a parseable way.",
                                    label, token
                                ));
                                break;
                            }
                        }
                    }
                    None => errors.push(format!("{} must be parseable after rendering.", label)),
                }
            }
            Err(error) => errors.push(format!("{} is invalid: {}", label, error)),
        }
    };

    validate_round_trip(
        "Plan branch template",
        &normalized.plan_branch_template,
        &["planSlug"],
        render_plan_branch_name(&normalized, sample_plan_slug),
        &[("planSlug", sample_plan_slug)],
        &mut errors,
    );
    validate_round_trip(
        "Feature branch template",
        &normalized.feature_branch_template,
        &["planSlug", "featureSlug"],
        render_plan_feature_branch_name(&normalized, sample_plan_slug, sample_feature_slug),
        &[
            ("planSlug", sample_plan_slug),
            ("featureSlug", sample_feature_slug),
        ],
        &mut errors,
    );
    validate_round_trip(
        "Independent feature branch template",
        &normalized.standalone_feature_branch_template,
        &["featureSlug"],
        render_standalone_feature_branch_name(Some(&normalized), sample_feature_slug),
        &[("featureSlug", sample_feature_slug)],
        &mut errors,
    );

    if errors.is_empty() {
        Ok(())
    } else {
        Err(BackendError::Validation(errors.join(" ")))
    }
}

fn render_standalone_feature_branch_name(
    settings: Option<&ProjectGitFlowSettingsDto>,
    feature_slug: &str,
) -> String {
    render_standalone_task_branch_name(settings, feature_slug, "feature")
}

fn normalize_manual_task_kind(task_kind: &str) -> Result<&'static str> {
    match task_kind.trim().to_lowercase().as_str() {
        "feature" => Ok("feature"),
        "bugfix" => Ok("bugfix"),
        "hotfix" => Ok("hotfix"),
        _ => Err(BackendError::Validation(
            "Manual task kind must be feature, bugfix or hotfix".to_string(),
        )),
    }
}

fn render_standalone_task_branch_name(
    settings: Option<&ProjectGitFlowSettingsDto>,
    task_slug: &str,
    task_kind: &str,
) -> String {
    let normalized_settings = normalize_project_git_flow_settings(settings);
    let (template, token, fallback_prefix) = match task_kind {
        "bugfix" => (
            normalized_settings.bugfix_branch_template.as_str(),
            "bugfixSlug",
            "bugfix",
        ),
        "hotfix" => (
            normalized_settings.hotfix_branch_template.as_str(),
            "hotfixSlug",
            "hotfix",
        ),
        _ => (
            normalized_settings
                .standalone_feature_branch_template
                .as_str(),
            "featureSlug",
            "feature",
        ),
    };
    let rendered = replace_template_tokens(template, &[(token, task_slug)]);
    normalize_branch_template(
        Some(rendered.as_str()),
        &format!("{}/{}", fallback_prefix, task_slug),
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

    if group_name.unwrap_or_default().trim().is_empty() {
        return Ok(());
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

fn target_is_standalone(group_id: Option<&str>, group_name: Option<&str>) -> bool {
    group_id.is_none() && group_name.unwrap_or_default().trim().is_empty()
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
                "A project named \"{}\" already exists in this group.",
                trimmed_name
            )));
        }
    }

    Ok(())
}

fn ensure_unique_project_name_in_target(
    state: &WorkspaceState,
    group_id: Option<&str>,
    group_name: Option<&str>,
    project_name: &str,
) -> Result<()> {
    ensure_unique_project_name_in_group(&state.project_groups, group_id, project_name)?;

    let trimmed_name = project_name.trim();
    if target_is_standalone(group_id, group_name)
        && state
            .standalone_projects
            .iter()
            .any(|project| project.name.trim().eq_ignore_ascii_case(trimmed_name))
    {
        return Err(BackendError::Validation(format!(
            "A project named \"{}\" already exists outside groups.",
            trimmed_name
        )));
    }

    Ok(())
}

fn normalized_path_key(path: &Path) -> String {
    let normalized = absolutize_path(path).to_string_lossy().replace('\\', "/");
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
            "A project with this folder already exists in the workspace.".to_string(),
        ));
    }

    Ok(())
}

fn ensure_unique_project_path_in_state(
    state: &WorkspaceState,
    workspace_path: &Path,
    project_path: &Path,
) -> Result<()> {
    ensure_unique_project_path(&state.project_groups, workspace_path, project_path)?;

    let next_project_path_key = normalized_path_key(project_path);
    let duplicate = state.standalone_projects.iter().any(|project| {
        let existing_path = resolve_project_path(workspace_path, &project.path);
        normalized_path_key(&existing_path) == next_project_path_key
    });

    if duplicate {
        return Err(BackendError::Validation(
            "A project with this folder already exists in the workspace.".to_string(),
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

fn insert_project_into_registry(
    state: &mut WorkspaceState,
    group_id: Option<&str>,
    group_name: Option<&str>,
    project: ProjectDto,
) -> Result<()> {
    if target_is_standalone(group_id, group_name) {
        state.standalone_projects.push(project);
        return Ok(());
    }

    insert_project_into_group(&mut state.project_groups, group_id, group_name, project)
}

fn collapse_singleton_project_groups(state: &mut WorkspaceState) {
    let mut next_groups = Vec::with_capacity(state.project_groups.len());
    for mut group in std::mem::take(&mut state.project_groups) {
        match group.projects.len() {
            0 => {}
            1 => {
                if let Some(project) = group.projects.pop() {
                    state.standalone_projects.push(project);
                }
            }
            _ => next_groups.push(group),
        }
    }
    state.project_groups = next_groups;
}

fn take_project_from_registry(state: &mut WorkspaceState, project_id: &str) -> Option<ProjectDto> {
    if let Some(index) = state
        .standalone_projects
        .iter()
        .position(|project| project.id == project_id)
    {
        return Some(state.standalone_projects.remove(index));
    }

    let mut removed_project = None;
    for group in state.project_groups.iter_mut() {
        if let Some(index) = group
            .projects
            .iter()
            .position(|project| project.id == project_id)
        {
            removed_project = Some(group.projects.remove(index));
            break;
        }
    }
    collapse_singleton_project_groups(state);
    removed_project
}

fn ensure_plan_has_project(state: &mut WorkspaceState, project: &ProjectDto) {
    if state.current_plan.is_none() {
        if project_is_read_only(project) {
            return;
        }
        let now = Utc::now().to_rfc3339();
        state.current_plan = Some(PlanDto {
            id: "plan-main".to_string(),
            description: "Workspace execution plan".to_string(),
            created_at: now.clone(),
            updated_at: now,
            status: "Draft".to_string(),
            project_ids: vec![project.id.to_string()],
            context_project_ids: Vec::new(),
            tasks: Vec::new(),
            predicted_git_trees: HashMap::new(),
        });
        return;
    }

    if let Some(plan) = state.current_plan.as_mut() {
        let target_collection = if project_is_read_only(project) {
            &mut plan.context_project_ids
        } else {
            &mut plan.project_ids
        };
        if !target_collection.iter().any(|id| id == &project.id) {
            target_collection.push(project.id.to_string());
        }
        plan.updated_at = Utc::now().to_rfc3339();
    }
}

fn resolve_project_path(workspace_path: &Path, project_path: &str) -> PathBuf {
    let normalized_project_path = project_path.replace('\\', "/");
    let candidate = PathBuf::from(normalized_project_path);
    if candidate.is_absolute() {
        absolutize_path(&candidate)
    } else {
        absolutize_path(&workspace_path.join(candidate))
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

fn find_project_by_id_in_state<'a>(
    state: &'a WorkspaceState,
    project_id: &str,
) -> Option<&'a ProjectDto> {
    state
        .standalone_projects
        .iter()
        .chain(
            state
                .project_groups
                .iter()
                .flat_map(|group| group.projects.iter()),
        )
        .find(|project| project.id == project_id)
}

fn find_project_by_id_mut_in_state<'a>(
    state: &'a mut WorkspaceState,
    project_id: &str,
) -> Option<&'a mut ProjectDto> {
    if let Some(project) = state
        .standalone_projects
        .iter_mut()
        .find(|project| project.id == project_id)
    {
        return Some(project);
    }

    state
        .project_groups
        .iter_mut()
        .flat_map(|group| group.projects.iter_mut())
        .find(|project| project.id == project_id)
}

fn find_group_id_for_project(state: &WorkspaceState, project_id: &str) -> Option<String> {
    state
        .project_groups
        .iter()
        .find(|group| {
            group
                .projects
                .iter()
                .any(|project| project.id == project_id)
        })
        .map(|group| group.id.clone())
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
        .unwrap_or("main")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process::background_command;
    use git2::{Repository, RepositoryInitOptions};
    use serde_json::json;
    use std::fs as stdfs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn parse_wsl_unc_path_supports_wsl_dollar_prefix() {
        let parsed = parse_wsl_unc_path(r"\\wsl$\Ubuntu\home\oscar\repo").expect("parse wsl path");

        assert_eq!(parsed.distro, "Ubuntu");
        assert_eq!(parsed.linux_path, "/home/oscar/repo");
    }

    #[test]
    fn parse_wsl_unc_path_supports_wsl_localhost_prefix() {
        let parsed = parse_wsl_unc_path(r"\\wsl.localhost\Debian\var\www\app")
            .expect("parse wsl localhost path");

        assert_eq!(parsed.distro, "Debian");
        assert_eq!(parsed.linux_path, "/var/www/app");
    }

    #[test]
    fn wsl_develop_branch_source_is_passed_as_positional_argument() {
        let source_branch = r#"main$(touch /tmp/macro-pwned);`id`"#;

        let (script, args) =
            wsl_git_setup_action_command(GIT_SETUP_ACTION_CREATE_DEVELOP, Some(source_branch))
                .expect("build WSL git setup command");

        assert!(script.contains("\"$2\""));
        assert!(!script.contains(source_branch));
        assert_eq!(args, vec![source_branch.to_string()]);
    }

    fn make_project(id: &str, path: &str) -> ProjectDto {
        ProjectDto {
            id: id.to_string(),
            name: id.to_string(),
            mount_name: String::new(),
            path: path.to_string(),
            git_flow_settings: ProjectGitFlowSettingsDto {
                base_branch: "develop".to_string(),
                main_branch: "main".to_string(),
                completion_merge_policy: "merge_commit".to_string(),
                plan_branch_template: "plan/{planSlug}".to_string(),
                feature_branch_template: "feature/{planSlug}/{featureSlug}".to_string(),
                standalone_feature_branch_template: "feature/{featureSlug}".to_string(),
                release_branch_template: "release/{releaseSlug}".to_string(),
                hotfix_branch_template: "hotfix/{hotfixSlug}".to_string(),
                bugfix_branch_template: "bugfix/{bugfixSlug}".to_string(),
            },
            created_at: "2026-03-14T00:00:00.000Z".to_string(),
            status: "active".to_string(),
            user_read_only: false,
            direct_edit: false,
            git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
            is_read_only: false,
            read_only_reason: None,
            path_kind: "windows".to_string(),
            wsl_distro: None,
            wsl_linux_path: None,
            metadata: ProjectMetadataDto {
                description: String::new(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        }
    }

    #[tokio::test]
    async fn get_project_by_id_finds_standalone_project() {
        let temp = TempDir::new().expect("temp dir");
        let standalone_project = make_project("project-standalone", "apps/standalone");
        let state = WorkspaceState {
            version: WorkspaceState::default().version,
            standalone_projects: vec![standalone_project],
            project_groups: vec![ProjectGroupDto {
                id: "group-1".to_string(),
                name: "Grouped".to_string(),
                is_open: true,
                projects: vec![make_project("project-grouped", "apps/grouped")],
            }],
            ..WorkspaceState::default()
        };
        persist_state_sync(temp.path(), &state).expect("persist workspace state");

        let found = get_project_by_id(temp.path(), temp.path(), "project-standalone")
            .await
            .expect("lookup standalone project")
            .expect("standalone project");

        assert_eq!(found.id, "project-standalone");
        assert_eq!(found.path, "apps/standalone");
    }

    #[tokio::test]
    async fn get_project_by_id_finds_group_project() {
        let temp = TempDir::new().expect("temp dir");
        let state = WorkspaceState {
            version: WorkspaceState::default().version,
            standalone_projects: vec![make_project("project-standalone", "apps/standalone")],
            project_groups: vec![ProjectGroupDto {
                id: "group-1".to_string(),
                name: "Grouped".to_string(),
                is_open: true,
                projects: vec![make_project("project-grouped", "apps/grouped")],
            }],
            ..WorkspaceState::default()
        };
        persist_state_sync(temp.path(), &state).expect("persist workspace state");

        let found = get_project_by_id(temp.path(), temp.path(), "project-grouped")
            .await
            .expect("lookup grouped project")
            .expect("grouped project");

        assert_eq!(found.id, "project-grouped");
        assert_eq!(found.path, "apps/grouped");
    }

    #[tokio::test]
    async fn get_project_by_id_returns_none_for_unknown_project() {
        let temp = TempDir::new().expect("temp dir");
        let state = WorkspaceState {
            version: WorkspaceState::default().version,
            standalone_projects: vec![make_project("project-standalone", "apps/standalone")],
            ..WorkspaceState::default()
        };
        persist_state_sync(temp.path(), &state).expect("persist workspace state");

        let found = get_project_by_id(temp.path(), temp.path(), "project-missing")
            .await
            .expect("lookup missing project");

        assert!(found.is_none());
    }

    fn init_git_repo(path: &Path, initial_head: &str, extra_branches: &[&str]) -> Repository {
        stdfs::create_dir_all(path).expect("create repo dir");
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head(initial_head);
        let repo = Repository::init_opts(path, &opts).expect("init repo");
        let file_path = path.join("README.md");
        stdfs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add readme");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        {
            let head_commit_id = repo
                .head()
                .and_then(|head| head.peel_to_commit())
                .map(|commit| commit.id())
                .expect("head commit");
            let head_commit = repo.find_commit(head_commit_id).expect("find head commit");
            for branch_name in extra_branches {
                repo.branch(branch_name, &head_commit, false)
                    .expect("create branch");
            }
        }

        repo
    }

    fn checkout_branch(repo: &Repository, branch_name: &str) {
        let reference = format!("refs/heads/{}", branch_name);
        if repo.find_reference(&reference).is_err() {
            let head = repo
                .head()
                .expect("head")
                .peel_to_commit()
                .expect("head commit");
            repo.branch(branch_name, &head, false)
                .expect("create branch");
        }

        let object = repo
            .revparse_single(&reference)
            .expect("resolve branch ref");
        repo.checkout_tree(&object, Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout branch");
        repo.set_head(&reference).expect("set head");
    }

    fn commit_all(repo_root: &Path, message: &str) -> Oid {
        let add_output = background_command("git")
            .current_dir(repo_root)
            .args(["-c", "core.autocrlf=false", "add", "-A", "."])
            .output()
            .expect("git add");
        assert!(
            add_output.status.success(),
            "{}",
            String::from_utf8_lossy(&add_output.stderr)
        );

        let commit_output = background_command("git")
            .current_dir(repo_root)
            .args([
                "-c",
                "user.name=Tester",
                "-c",
                "user.email=tester@example.com",
                "commit",
                "-m",
                message,
            ])
            .output()
            .expect("git commit");
        assert!(
            commit_output.status.success(),
            "{}",
            String::from_utf8_lossy(&commit_output.stderr)
        );

        Repository::open(repo_root)
            .expect("open repo")
            .head()
            .expect("head")
            .target()
            .expect("head oid")
    }

    #[tokio::test]
    async fn create_project_with_absolute_path_persists_metadata_under_metadata_root() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let project_path = temp.path().join("repos").join("web");

        let project = create_project(
            &workspace_path,
            &metadata_root,
            CreateProjectRequest {
                name: "Web".to_string(),
                description: String::new(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                path: Some(project_path.to_string_lossy().to_string()),
                direct_edit: false,
                git_flow_settings: None,
            },
        )
        .await
        .expect("create project");

        assert_eq!(project.path, project_path.to_string_lossy());
        assert!(project_path.is_dir());
        assert!(metadata_root.join(WORKSPACE_STATE_FILE).exists());
        assert!(!workspace_path.join(WORKSPACE_STATE_FILE).exists());
    }

    #[tokio::test]
    async fn create_project_reports_project_path_when_target_is_file() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let project_path = temp.path().join("repos").join("web");
        stdfs::create_dir_all(project_path.parent().expect("project parent"))
            .expect("create project parent");
        stdfs::write(&project_path, "not a directory").expect("write file target");

        let result = create_project(
            &workspace_path,
            &metadata_root,
            CreateProjectRequest {
                name: "Web".to_string(),
                description: String::new(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                path: Some(project_path.to_string_lossy().to_string()),
                direct_edit: false,
                git_flow_settings: None,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemIsFile { message })
                if message.contains(&project_path.to_string_lossy().to_string())
                    && message.contains("create_project")
        ));
    }

    #[tokio::test]
    async fn create_new_project_repo_creates_git_repo_with_initial_commit() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        stdfs::create_dir_all(&parent_path).expect("create parent");

        let result = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        )
        .await
        .expect("create new repo");

        let project_path = parent_path.join("backend-api");
        let repo = Repository::open(&project_path).expect("open created repo");
        assert!(project_path.join(".git").is_dir());
        assert!(repo.head().expect("head").target().is_some());
        assert_eq!(result.project.name, "Backend API");
        assert_eq!(result.project.git_setup_state, PROJECT_GIT_SETUP_READY);
        assert!(!result.project.is_read_only);
        assert_eq!(result.detection.setup_state, PROJECT_GIT_DETECTION_READY);
    }

    #[tokio::test]
    async fn create_new_project_repo_blocks_existing_target_folder() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        stdfs::create_dir_all(parent_path.join("backend-api")).expect("create target");

        let result = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemAlreadyExists { message })
                if message.contains("backend-api")
        ));
    }

    #[tokio::test]
    async fn create_new_project_repo_serializes_same_target() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        stdfs::create_dir_all(&parent_path).expect("create parent");

        let first = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        );
        let second = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        );
        let (first, second) = tokio::join!(first, second);

        assert!(first.is_ok() ^ second.is_ok());
        let error = first.err().or_else(|| second.err()).expect("one failure");
        assert!(matches!(
            error,
            BackendError::FilesystemAlreadyExists { .. } | BackendError::Validation(_)
        ));
        let state = load_or_create_state(&workspace_path, &metadata_root)
            .await
            .expect("read state");
        assert_eq!(
            count_registry_projects(&state.standalone_projects, &state.project_groups),
            1
        );
    }

    #[tokio::test]
    async fn cancelled_new_repo_after_git_init_is_compensated_before_persistence() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        let project_path = parent_path.join("backend-api");
        stdfs::create_dir_all(&parent_path).expect("create parent");

        schedule_new_repo_cancellation_after_init(&project_path);

        let result = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        )
        .await;

        assert!(
            matches!(result, Err(BackendError::Validation(message)) if message.contains("cancelled"))
        );
        assert!(!project_path.exists());
        let state = load_or_create_state(&workspace_path, &metadata_root)
            .await
            .expect("read state");
        assert_eq!(
            count_registry_projects(&state.standalone_projects, &state.project_groups),
            0
        );
    }

    #[tokio::test]
    async fn create_new_project_repo_blocks_parent_inside_git_repo() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        init_git_repo(&parent_path, "main", &[]);

        let result = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                git_flow_settings: None,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::Validation(message))
                if message.contains("not inside an existing Git repository")
        ));
    }

    #[tokio::test]
    async fn create_new_project_repo_reuses_project_path_uniqueness_validation() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("app-data").join("workspace");
        let metadata_root = workspace_path.join(".macro");
        let parent_path = temp.path().join("repos");
        let project_path = parent_path.join("backend-api");
        stdfs::create_dir_all(&parent_path).expect("create parent");

        create_project(
            &workspace_path,
            &metadata_root,
            CreateProjectRequest {
                name: "Existing".to_string(),
                description: String::new(),
                group_id: None,
                group_name: Some("Suite".to_string()),
                path: Some(project_path.to_string_lossy().to_string()),
                direct_edit: false,
                git_flow_settings: None,
            },
        )
        .await
        .expect("create existing project");

        let result = create_new_project_repo(
            &workspace_path,
            &metadata_root,
            CreateNewProjectRepoRequest {
                repo_name: "Backend API".to_string(),
                parent_path: parent_path.to_string_lossy().to_string(),
                folder_name: "backend-api".to_string(),
                group_id: None,
                group_name: Some("Other Suite".to_string()),
                git_flow_settings: None,
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::Validation(message))
                if message.contains("folder already exists")
        ));
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
            Path::new("."),
            "task-feature",
            &["project-web".to_string(), "project-api".to_string()],
            "quick-export",
            "feature",
            &[],
            &project_groups,
        );

        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].project_id, "project-web");
        assert_eq!(targets[0].branch_name, "feature/quick-export");
        assert_eq!(targets[0].target_branch_name.as_deref(), Some("main"));
        assert_eq!(targets[1].project_id, "project-api");
        assert_eq!(targets[1].branch_name, "work/quick-export");
        assert_eq!(targets[1].target_branch_name.as_deref(), Some("develop"));

        let bugfix_targets = build_manual_feature_execution_targets(
            Path::new("."),
            "task-bugfix",
            &["project-web".to_string(), "project-api".to_string()],
            "broken-export",
            "bugfix",
            &[],
            &project_groups,
        );
        assert_eq!(bugfix_targets[0].branch_name, "bugfix/broken-export");
        assert_eq!(
            bugfix_targets[0].target_branch_name.as_deref(),
            Some("main")
        );
        assert_eq!(bugfix_targets[1].branch_name, "bugfix/broken-export");
        assert_eq!(
            bugfix_targets[1].target_branch_name.as_deref(),
            Some("develop")
        );

        let hotfix_targets = build_manual_feature_execution_targets(
            Path::new("."),
            "task-hotfix",
            &["project-web".to_string(), "project-api".to_string()],
            "production-export",
            "hotfix",
            &[],
            &project_groups,
        );
        assert_eq!(hotfix_targets[0].branch_name, "hotfix/production-export");
        assert_eq!(
            hotfix_targets[0].target_branch_name.as_deref(),
            Some("main")
        );
        assert_eq!(hotfix_targets[1].branch_name, "hotfix/production-export");
        assert_eq!(
            hotfix_targets[1].target_branch_name.as_deref(),
            Some("main")
        );
    }

    #[test]
    fn manual_bugfix_requires_a_distinct_development_branch() {
        let mut mainline = make_project("project-mainline", "apps/mainline");
        mainline.git_flow_settings.base_branch = "main".to_string();
        mainline.git_flow_settings.main_branch = "MAIN".to_string();
        let develop = make_project("project-develop", "apps/develop");

        let error = validate_manual_task_kind_for_projects(
            "bugfix",
            &[mainline.id.clone()],
            &[mainline.clone(), develop.clone()],
            &[],
        )
        .expect_err("mainline bugfix should be rejected");
        assert!(matches!(
            error,
            BackendError::Validation(message)
                if message.contains("development branch distinct from the production branch")
        ));

        validate_manual_task_kind_for_projects(
            "feature",
            &[mainline.id.clone()],
            &[mainline.clone()],
            &[],
        )
        .expect("mainline feature should remain available");
        validate_manual_task_kind_for_projects("hotfix", &[mainline.id.clone()], &[mainline], &[])
            .expect("mainline hotfix should remain available");
        validate_manual_task_kind_for_projects("bugfix", &[develop.id.clone()], &[develop], &[])
            .expect("develop-based bugfix should remain available");
    }

    #[test]
    fn direct_edit_project_is_writable_but_not_architect_actionable() {
        let mut direct = make_project("project-direct", "apps/direct");
        direct.git_setup_state = PROJECT_GIT_SETUP_NOT_GIT.to_string();
        direct.direct_edit = true;
        direct.is_read_only = project_is_read_only(&direct);
        let state = WorkspaceState {
            version: 1,
            workspace_revision: 0,
            standalone_projects: vec![direct.clone()],
            project_registry_explicitly_empty: false,
            project_groups: Vec::new(),
            current_plan: None,
            plan_nodes: Vec::new(),
            predicted_branches: Vec::new(),
            manual_features: Vec::new(),
            deleted_manual_feature_ids: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
        };

        assert!(!direct.is_read_only);
        assert!(collect_actionable_project_ids_from_state(&state).contains(&direct.id));
        assert!(!collect_git_actionable_project_ids_from_state(&state).contains(&direct.id));
        assert!(collect_architect_context_project_ids_from_state(&state).contains(&direct.id));
    }

    #[test]
    fn direct_edit_project_only_accepts_feature_tasks() {
        let mut direct = make_project("project-direct", "apps/direct");
        direct.git_setup_state = PROJECT_GIT_SETUP_NOT_GIT.to_string();
        direct.direct_edit = true;

        validate_manual_task_kind_for_projects(
            "feature",
            &[direct.id.clone()],
            &[direct.clone()],
            &[],
        )
        .expect("direct feature should be available");
        let error =
            validate_manual_task_kind_for_projects("hotfix", &[direct.id.clone()], &[direct], &[])
                .expect_err("direct hotfix should be rejected");
        assert!(
            matches!(error, BackendError::Validation(message) if message.contains("only support feature"))
        );
    }

    #[test]
    fn strict_git_flow_validation_rejects_unparseable_feature_templates() {
        let settings = ProjectGitFlowSettingsDto {
            feature_branch_template: "feature/{planSlug}/{featureSlug}/{featureSlug}".to_string(),
            ..Default::default()
        };

        let error = validate_project_git_flow_settings_strict(&settings)
            .expect_err("template should be rejected");

        match error {
            BackendError::Validation(message) => {
                assert!(
                    message.contains("cannot repeat tokens")
                        || message.contains("invalid")
                        || message.contains("parseable")
                );
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn strict_git_flow_validation_rejects_unknown_template_tokens() {
        let settings = ProjectGitFlowSettingsDto {
            feature_branch_template: "feature/{planSlug}/{featureSlug}/{branchType}".to_string(),
            ..Default::default()
        };

        let error = validate_project_git_flow_settings_strict(&settings)
            .expect_err("template should be rejected");

        match error {
            BackendError::Validation(message) => {
                assert!(message.contains("unsupported tokens"));
                assert!(message.contains("branchType"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn strict_git_flow_validation_rejects_invalid_rendered_branch_names() {
        let settings = ProjectGitFlowSettingsDto {
            plan_branch_template: "plan/{planSlug}/.draft".to_string(),
            ..Default::default()
        };

        let error = validate_project_git_flow_settings_strict(&settings)
            .expect_err("template should be rejected");

        match error {
            BackendError::Validation(message) => {
                assert!(message.contains("valid Git branch name"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn sanitize_workspace_state_preserves_reserved_standalone_feature_slugs() {
        let workspace_path = PathBuf::from("C:/workspace");
        let state = WorkspaceState {
            version: 3,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-web", "apps/web")],
            }],
            manual_features: vec![ManualFeatureDto {
                id: "feature-1".to_string(),
                conversation_id: "conv-1".to_string(),
                draft: false,
                title: "Quick export".to_string(),
                description: "Standalone work".to_string(),
                status: "Pending".to_string(),
                feature_slug: Some("quick-export".to_string()),
                task_kind: Some("feature".to_string()),
                branch_name: Some("feature/quick-export".to_string()),
                archived_at: None,
                archive_reason: None,
                merged_at: None,
                base_branch: "develop".to_string(),
                project_ids: vec!["project-web".to_string()],
                context_project_ids: Vec::new(),
                execution_targets: vec![WorkspaceTaskExecutionTargetDto {
                    project_id: "project-web".to_string(),
                    branch_name: "feature/quick-export".to_string(),
                    target_branch_name: Some("develop".to_string()),
                    execution_mode: Some("git".to_string()),
                    checkpoint_id: None,
                    worktree_key: "branch-project-web-quick-export".to_string(),
                    repo_path: Some("apps/web".to_string()),
                }],
                merge_workflow: None,
                created_at: "2026-03-14T00:00:00.000Z".to_string(),
                updated_at: "2026-03-14T00:00:00.000Z".to_string(),
            }],
            reserved_standalone_feature_slugs: vec!["legacy-slug".to_string()],
            ..WorkspaceState::default()
        };

        let (sanitized, _) = sanitize_workspace_state(&workspace_path, state);

        assert_eq!(
            sanitized.reserved_standalone_feature_slugs,
            vec!["legacy-slug".to_string(), "quick-export".to_string()]
        );
    }

    #[test]
    fn sanitize_workspace_state_removes_duplicate_paths_and_dead_references() {
        let temp_dir = TempDir::new().expect("temp dir");
        let workspace_path = temp_dir.path().to_path_buf();
        init_git_repo(&workspace_path.join("apps/web"), "main", &[]);
        init_git_repo(&workspace_path.join("apps/api"), "main", &[]);
        let state = WorkspaceState {
            version: 1,
            workspace_revision: 0,
            standalone_projects: Vec::new(),
            project_registry_explicitly_empty: false,
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
                context_project_ids: Vec::new(),
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
            deleted_manual_feature_ids: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
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
            workspace_revision: 0,
            standalone_projects: Vec::new(),
            project_registry_explicitly_empty: false,
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
            deleted_manual_feature_ids: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
        };

        let (sanitized, report) = sanitize_workspace_state(&workspace_path, state);

        assert_eq!(report.mount_names_assigned, 1);
        assert_eq!(sanitized.project_groups[0].projects[0].mount_name, "app");
        assert_eq!(sanitized.project_groups[0].projects[1].mount_name, "app-2");
    }

    #[test]
    fn build_project_auto_detects_master_and_dev_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("legacy-repo");
        let _repo = init_git_repo(&repo_path, "master", &["dev"]);

        let project = build_project(
            "Legacy Repo",
            "",
            Some(repo_path.to_string_lossy().as_ref()),
            temp.path(),
            Some(&ProjectGitFlowSettingsDto::default()),
        );

        assert_eq!(project.git_flow_settings.main_branch, "master");
        assert_eq!(project.git_flow_settings.base_branch, "dev");
    }

    #[test]
    fn build_project_auto_detects_trunk_and_integration_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("custom-repo");
        let _repo = init_git_repo(&repo_path, "trunk", &["integration"]);

        let project = build_project(
            "Custom Repo",
            "",
            Some(repo_path.to_string_lossy().as_ref()),
            temp.path(),
            Some(&ProjectGitFlowSettingsDto::default()),
        );

        assert_eq!(project.git_flow_settings.main_branch, "trunk");
        assert_eq!(project.git_flow_settings.base_branch, "integration");
    }

    #[test]
    fn build_project_keeps_defaults_for_rare_branch_conventions_until_confirmed() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("rare-repo");
        let _repo = init_git_repo(&repo_path, "stable", &["integration-ready"]);

        let project = build_project(
            "Rare Repo",
            "",
            Some(repo_path.to_string_lossy().as_ref()),
            temp.path(),
            Some(&ProjectGitFlowSettingsDto::default()),
        );

        assert_eq!(project.git_flow_settings.main_branch, "main");
        assert_eq!(project.git_flow_settings.base_branch, "main");
    }

    #[test]
    fn sanitize_workspace_state_auto_detects_legacy_git_flow_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("legacy-repo");
        let _repo = init_git_repo(&repo_path, "master", &["dev"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-legacy", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.standalone_projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "master");
        assert_eq!(project.git_flow_settings.base_branch, "dev");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 1);
        assert_eq!(repair_report.singleton_groups_migrated, 1);
    }

    #[test]
    fn sanitize_workspace_state_preserves_existing_develop_on_single_main_repo() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("mainline-repo");
        let _repo = init_git_repo(&repo_path, "main", &[]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-develop", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.standalone_projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "main");
        assert_eq!(project.git_flow_settings.base_branch, "develop");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 0);
        assert_eq!(repair_report.singleton_groups_migrated, 1);
    }

    #[test]
    fn sanitize_workspace_state_auto_detects_custom_git_flow_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("custom-repo");
        let _repo = init_git_repo(&repo_path, "trunk", &["integration"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-custom-detected", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.standalone_projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "trunk");
        assert_eq!(project.git_flow_settings.base_branch, "integration");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 1);
        assert_eq!(repair_report.singleton_groups_migrated, 1);
    }

    #[test]
    fn sanitize_workspace_state_skips_rare_git_flow_conventions_without_confirmation() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("rare-repo");
        let _repo = init_git_repo(&repo_path, "stable", &["integration-ready"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-rare-detected", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.standalone_projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "main");
        assert_eq!(project.git_flow_settings.base_branch, "develop");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 0);
        assert_eq!(repair_report.singleton_groups_migrated, 1);
    }

    #[test]
    fn sanitize_workspace_state_preserves_non_standard_git_flow_overrides() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("legacy-repo");
        let _repo = init_git_repo(&repo_path, "master", &["dev"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let mut project = make_project("project-custom", &project_path);
        project.git_flow_settings.main_branch = "trunk".to_string();
        project.git_flow_settings.base_branch = "release".to_string();

        let state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![project],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.standalone_projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "trunk");
        assert_eq!(project.git_flow_settings.base_branch, "release");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 0);
        assert_eq!(repair_report.singleton_groups_migrated, 1);
    }

    #[test]
    fn detect_project_git_flow_reports_confirmation_for_rare_conventions() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("rare-repo");
        let _repo = init_git_repo(&repo_path, "stable", &["integration-ready"]);

        let detection =
            detect_project_git_flow(temp.path(), Some(repo_path.to_string_lossy().as_ref()));

        assert!(detection.repo_detected);
        assert!(detection.requires_confirmation);
        assert_eq!(detection.suggested_main_branch.as_deref(), Some("stable"));
        assert_eq!(detection.suggested_base_branch.as_deref(), Some("stable"));
        assert!(detection.branches.contains(&"stable".to_string()));
        assert!(detection
            .branches
            .contains(&"integration-ready".to_string()));
    }

    #[test]
    fn preview_project_git_setup_recommends_atomic_actions_for_non_git_path() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        stdfs::write(project_path.join("README.md"), "hello").expect("write file");

        let detection =
            preview_project_git_setup(temp.path(), Some(project_path.to_string_lossy().as_ref()));

        assert!(!detection.repo_detected);
        assert_eq!(detection.setup_state, PROJECT_GIT_DETECTION_NOT_GIT);
        assert_eq!(detection.suggested_main_branch.as_deref(), Some("main"));
        assert_eq!(
            detection.recommended_action_sequence,
            vec![
                GIT_SETUP_ACTION_INITIALIZE_REPO.to_string(),
                GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string(),
            ]
        );
        assert_eq!(detection.initial_commit_preview_count, 1);
        assert_eq!(
            detection.initial_commit_preview_paths,
            vec!["README.md".to_string()]
        );
    }

    #[test]
    fn detect_project_git_flow_treats_single_main_repo_as_ready() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("mainline-repo");
        let _repo = init_git_repo(&repo_path, "main", &[]);

        let detection =
            detect_project_git_flow(temp.path(), Some(repo_path.to_string_lossy().as_ref()));

        assert!(detection.repo_detected);
        assert_eq!(detection.setup_state, PROJECT_GIT_DETECTION_READY);
        assert_eq!(detection.suggested_main_branch.as_deref(), Some("main"));
        assert_eq!(detection.suggested_base_branch.as_deref(), Some("main"));
        assert!(detection.recommended_action_sequence.is_empty());
    }

    #[test]
    fn recover_missing_metadata_restores_latest_valid_history_snapshot() {
        let temp = TempDir::new().expect("temp dir");
        init_git_repo(temp.path(), "main", &[]);
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        stdfs::write(project_path.join("README.md"), "hello").expect("write project file");

        let repo = Repository::open(temp.path()).expect("open workspace repo");
        checkout_branch(&repo, MACRO_BRANCH_NAME);

        let valid_state = WorkspaceState {
            version: 2,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-1".to_string(),
                name: "Suite".to_string(),
                is_open: true,
                projects: vec![make_project("project-web", "apps/web")],
            }],
            ..WorkspaceState::default()
        };
        persist_state_sync(temp.path(), &valid_state).expect("persist valid state");
        let valid_commit = commit_all(temp.path(), "valid metadata");

        persist_state_sync(temp.path(), &WorkspaceState::default()).expect("persist empty state");
        let _empty_commit = commit_all(temp.path(), "empty metadata");

        stdfs::remove_file(workspace_state_path(temp.path())).expect("remove workspace state");
        if workspace_state_backup_path(temp.path()).exists() {
            stdfs::remove_file(workspace_state_backup_path(temp.path()))
                .expect("remove workspace backup");
        }
        let _missing_commit = commit_all(temp.path(), "remove metadata");

        let report = recover_missing_metadata_sync(
            temp.path(),
            temp.path(),
            &WorkspaceRecoverMissingMetadataRequestDto {
                attempt_pull: false,
                projects: Vec::new(),
            },
        )
        .expect("recover metadata");

        let restored = load_raw_state_sync(temp.path())
            .expect("read restored state")
            .expect("restored state");
        let expected_commit = short_oid(valid_commit);

        assert_eq!(report.status, "restored_from_history");
        assert_eq!(
            report.restored_commit.as_deref(),
            Some(expected_commit.as_str())
        );
        assert_eq!(restored.project_groups.len(), 0);
        assert_eq!(restored.standalone_projects.len(), 1);
        assert_eq!(restored.standalone_projects[0].id, "project-web");
    }

    #[test]
    fn recover_missing_metadata_reconstructs_minimal_state_from_hints() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let _project_repo = init_git_repo(&temp.path().join("apps/web"), "main", &[]);

        let report = recover_missing_metadata_sync(
            temp.path(),
            &metadata_root,
            &WorkspaceRecoverMissingMetadataRequestDto {
                attempt_pull: true,
                projects: vec![WorkspaceMetadataRecoveryHintDto {
                    project_id: "project-web".to_string(),
                    group_id: Some("group-1".to_string()),
                    name: "Web".to_string(),
                    path: "apps/web".to_string(),
                }],
            },
        )
        .expect("recover metadata");

        let reconstructed = load_raw_state_sync(&metadata_root)
            .expect("read reconstructed state")
            .expect("reconstructed state");

        assert_eq!(report.status, "reconstructed_from_hints");
        assert_eq!(reconstructed.project_groups.len(), 0);
        assert_eq!(reconstructed.standalone_projects.len(), 1);
        assert_eq!(reconstructed.standalone_projects[0].id, "project-web");
        assert_eq!(reconstructed.standalone_projects[0].name, "Web");
    }

    #[tokio::test]
    async fn reconcile_project_registry_from_hints_adds_missing_standalone_project() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("octan_sales");
        let _project_repo = init_git_repo(&project_path, "main", &[]);
        let _project_metadata_root = GitState::new()
            .resolve_macro_metadata_root(&project_path)
            .expect("project metadata root");
        let state = WorkspaceState {
            version: WorkspaceState::default().version,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-existing".to_string(),
                name: "Existing".to_string(),
                is_open: true,
                projects: vec![make_project("project-existing", "apps/existing")],
            }],
            current_plan: Some(PlanDto {
                id: "legacy-plan".to_string(),
                description: "Keep me".to_string(),
                created_at: "2026-03-14T00:00:00.000Z".to_string(),
                updated_at: "2026-03-14T00:00:00.000Z".to_string(),
                status: "Draft".to_string(),
                project_ids: vec!["project-existing".to_string()],
                context_project_ids: Vec::new(),
                tasks: Vec::new(),
                predicted_git_trees: HashMap::new(),
            }),
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &state).expect("persist workspace state");

        let report = reconcile_project_registry_from_hints(
            temp.path(),
            &metadata_root,
            WorkspaceReconcileProjectRegistryFromHintsRequestDto {
                projects: vec![WorkspaceMetadataRecoveryHintDto {
                    project_id: "project-octan-sales-1780653766405".to_string(),
                    group_id: None,
                    name: "octan_sales".to_string(),
                    path: project_path.to_string_lossy().to_string(),
                }],
            },
        )
        .await
        .expect("reconcile registry");
        let repaired = load_raw_state_sync(&metadata_root)
            .expect("read repaired state")
            .expect("repaired state");

        assert_eq!(report.status, "reconciled");
        assert_eq!(report.added_projects.len(), 1);
        assert_eq!(
            report.added_projects[0].id,
            "project-octan-sales-1780653766405"
        );
        assert_eq!(repaired.standalone_projects.len(), 1);
        assert_eq!(
            repaired.standalone_projects[0].id,
            "project-octan-sales-1780653766405"
        );
        assert_eq!(repaired.project_groups.len(), 1);
        assert_eq!(
            repaired.current_plan.as_ref().map(|plan| plan.id.as_str()),
            Some("legacy-plan")
        );
    }

    #[tokio::test]
    async fn reconcile_project_registry_from_hints_repairs_metadata_worktree_after_project_rename()
    {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let original_path = temp.path().join("lplr-app");
        let renamed_path = temp.path().join("octan_sales");

        {
            let _project_repo = init_git_repo(&original_path, "main", &[]);
            let project_metadata_root = GitState::new()
                .resolve_macro_metadata_root(&original_path)
                .expect("project metadata root");
            stdfs::write(project_metadata_root.join("plan.txt"), "kept metadata")
                .expect("write metadata file");
            assert!(Repository::open(&project_metadata_root).is_ok());
        }

        stdfs::rename(&original_path, &renamed_path).expect("rename project");
        persist_state_sync(&metadata_root, &WorkspaceState::default())
            .expect("persist workspace state");

        let report = reconcile_project_registry_from_hints(
            temp.path(),
            &metadata_root,
            WorkspaceReconcileProjectRegistryFromHintsRequestDto {
                projects: vec![WorkspaceMetadataRecoveryHintDto {
                    project_id: "project-octan-sales-1780653766405".to_string(),
                    group_id: None,
                    name: "octan_sales".to_string(),
                    path: renamed_path.to_string_lossy().to_string(),
                }],
            },
        )
        .await
        .expect("reconcile registry");
        let repaired_metadata_root = renamed_path
            .join(".git")
            .join(crate::git::MACRO_WORKTREE_DIR_NAME);
        let repaired = load_raw_state_sync(&metadata_root)
            .expect("read repaired state")
            .expect("repaired state");

        assert_eq!(report.status, "reconciled");
        assert_eq!(report.added_projects.len(), 1);
        assert_eq!(repaired.standalone_projects.len(), 1);
        assert!(Repository::open(&repaired_metadata_root).is_ok());
        assert_eq!(
            stdfs::read_to_string(repaired_metadata_root.join("plan.txt"))
                .expect("read metadata file"),
            "kept metadata"
        );
    }

    #[tokio::test]
    async fn discover_recoverable_projects_finds_missing_macro_repo_without_mutating_registry() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let parent = temp.path().join("github");
        let known_path = parent.join("sysml-drone-demo");
        let missing_path = parent.join("octan_sales");
        let _known_repo = init_git_repo(&known_path, "main", &[]);
        let missing_repo = init_git_repo(&missing_path, "main", &[]);
        let missing_git_config = missing_repo.path().join("config");
        let missing_metadata_root = GitState::new()
            .resolve_macro_metadata_root(&missing_path)
            .expect("missing project metadata root");
        {
            use std::io::Write as _;
            let mut config = stdfs::OpenOptions::new()
                .append(true)
                .open(&missing_git_config)
                .expect("open missing repo config");
            writeln!(
                config,
                "\n[extensions]\n\trelativeWorktrees = true\n\tworktreeConfig = true"
            )
            .expect("write relative worktree extension");
        }
        let plan_dir = missing_metadata_root
            .join("branches")
            .join("main")
            .join("plans")
            .join("1780299051043");
        stdfs::create_dir_all(&plan_dir).expect("create plan dir");
        stdfs::write(
            plan_dir.join("manifest.json"),
            serde_json::json!({
                "schemaVersion": 3,
                "planId": "1780299051043",
                "targetBranch": "main",
                "expectedProjectIds": ["project-lplr-app-1780329499166"],
                "participants": [{
                    "projectId": "project-lplr-app-1780329499166",
                    "repoPathSnapshot": "/Users/oscarlahaie/github/lplr-app"
                }]
            })
            .to_string(),
        )
        .expect("write manifest");
        persist_state_sync(
            &metadata_root,
            &WorkspaceState {
                version: WorkspaceState::default().version,
                standalone_projects: Vec::new(),
                project_groups: vec![ProjectGroupDto {
                    id: "group-sysml".to_string(),
                    name: "sysml".to_string(),
                    is_open: true,
                    projects: vec![make_project(
                        "project-sysml",
                        known_path.to_string_lossy().as_ref(),
                    )],
                }],
                ..WorkspaceState::default()
            },
        )
        .expect("persist workspace state");

        let before = stdfs::read_to_string(workspace_state_path(&metadata_root))
            .expect("read workspace state before discovery");

        let report = discover_recoverable_projects(
            temp.path(),
            &metadata_root,
            WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto {
                max_children_per_root: Some(50),
            },
        )
        .await
        .expect("discover missing macro repo");
        let after = stdfs::read_to_string(workspace_state_path(&metadata_root))
            .expect("read workspace state after discovery");
        let persisted = load_raw_state_sync(&metadata_root)
            .expect("read persisted state")
            .expect("persisted state");

        assert_eq!(report.status, "discovered");
        assert_eq!(report.discovered_projects.len(), 1);
        assert!(report.added_projects.is_empty());
        assert_eq!(
            report.discovered_projects[0].id,
            "project-lplr-app-1780329499166"
        );
        assert_eq!(report.discovered_projects[0].name, "octan_sales");
        assert_eq!(before, after);
        assert!(persisted.standalone_projects.is_empty());
        assert_eq!(persisted.project_groups[0].projects[0].id, "project-sysml");
    }

    #[tokio::test]
    async fn remove_project_does_not_restore_macro_sibling_on_next_load() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let parent = temp.path().join("github");
        let kept_path = parent.join("kept");
        let removed_path = parent.join("octan_sales");
        let _kept_repo = init_git_repo(&kept_path, "main", &[]);
        let _removed_repo = init_git_repo(&removed_path, "main", &[]);
        let removed_metadata_root = GitState::new()
            .resolve_macro_metadata_root(&removed_path)
            .expect("removed project metadata root");
        let plan_dir = removed_metadata_root
            .join("branches")
            .join("main")
            .join("plans")
            .join("1780299051043");
        stdfs::create_dir_all(&plan_dir).expect("create removed plan dir");
        stdfs::write(
            plan_dir.join("manifest.json"),
            serde_json::json!({
                "schemaVersion": 3,
                "planId": "1780299051043",
                "targetBranch": "main",
                "expectedProjectIds": ["project-octan-sales"]
            })
            .to_string(),
        )
        .expect("write removed manifest");

        persist_state_sync(
            &metadata_root,
            &WorkspaceState {
                version: WorkspaceState::default().version,
                standalone_projects: Vec::new(),
                project_groups: vec![ProjectGroupDto {
                    id: "group-main".to_string(),
                    name: "Main".to_string(),
                    is_open: true,
                    projects: vec![
                        make_project("project-kept", kept_path.to_string_lossy().as_ref()),
                        make_project(
                            "project-octan-sales",
                            removed_path.to_string_lossy().as_ref(),
                        ),
                    ],
                }],
                ..WorkspaceState::default()
            },
        )
        .expect("persist workspace state");

        close_project(temp.path(), &metadata_root, "project-octan-sales")
            .await
            .expect("remove project");
        let loaded = load_state(temp.path(), &metadata_root)
            .await
            .expect("load state")
            .expect("state");
        let all_project_ids = loaded
            .standalone_projects
            .iter()
            .chain(
                loaded
                    .project_groups
                    .iter()
                    .flat_map(|group| group.projects.iter()),
            )
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(all_project_ids, vec!["project-kept"]);
        assert!(removed_metadata_root.exists());
    }

    #[tokio::test]
    async fn removing_last_project_keeps_git_workspace_registry_empty_after_reload() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("octan_sales");
        let _repo = init_git_repo(&workspace_path, "main", &[]);
        let metadata_root = temp.path().join("metadata");

        persist_state_sync(
            &metadata_root,
            &WorkspaceState {
                standalone_projects: vec![make_project(
                    "project-octan-sales",
                    workspace_path.to_string_lossy().as_ref(),
                )],
                ..WorkspaceState::default()
            },
        )
        .expect("persist workspace state");

        close_project(&workspace_path, &metadata_root, "project-octan-sales")
            .await
            .expect("remove last project");

        let persisted = load_raw_state_sync(&metadata_root)
            .expect("load persisted state")
            .expect("persisted state");
        assert!(persisted.project_registry_explicitly_empty);
        assert!(persisted.standalone_projects.is_empty());
        assert!(persisted.project_groups.is_empty());

        let loaded_async = load_state(&workspace_path, &metadata_root)
            .await
            .expect("load async state")
            .expect("async state");
        let loaded_sync = load_state_sync(&workspace_path, &metadata_root)
            .expect("load sync state")
            .expect("sync state");
        let loaded_default = load_or_default_state(&workspace_path, &metadata_root)
            .await
            .expect("load default state");

        for loaded in [loaded_async, loaded_sync, loaded_default] {
            assert!(loaded.project_registry_explicitly_empty);
            assert!(loaded.standalone_projects.is_empty());
            assert!(loaded.project_groups.is_empty());
        }
    }

    #[tokio::test]
    async fn persisting_added_project_clears_explicitly_empty_registry_marker() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join("metadata");
        let state = WorkspaceState {
            project_registry_explicitly_empty: true,
            standalone_projects: vec![make_project("project-added", "/repos/added")],
            ..WorkspaceState::default()
        };

        persist_sanitized_state(temp.path(), &metadata_root, state, "add_project_test")
            .await
            .expect("persist added project");
        let persisted = load_raw_state_sync(&metadata_root)
            .expect("load persisted state")
            .expect("persisted state");

        assert!(!persisted.project_registry_explicitly_empty);
        assert_eq!(persisted.standalone_projects.len(), 1);
    }

    #[test]
    fn legacy_empty_registry_still_recovers_physical_git_workspace() {
        let temp = TempDir::new().expect("temp dir");
        let workspace_path = temp.path().join("octan_sales");
        let _repo = init_git_repo(&workspace_path, "main", &[]);
        let metadata_root = temp.path().join("metadata");
        stdfs::create_dir_all(&metadata_root).expect("create metadata root");
        let mut legacy_state = serde_json::to_value(WorkspaceState::default())
            .expect("serialize legacy workspace state");
        legacy_state
            .as_object_mut()
            .expect("workspace state object")
            .remove("projectRegistryExplicitlyEmpty");
        stdfs::write(
            workspace_state_path(&metadata_root),
            serde_json::to_vec_pretty(&legacy_state).expect("serialize legacy state"),
        )
        .expect("write legacy workspace state");

        let loaded = load_state_sync(&workspace_path, &metadata_root)
            .expect("load legacy state")
            .expect("legacy state");

        assert!(!loaded.project_registry_explicitly_empty);
        assert_eq!(loaded.standalone_projects.len(), 1);
        assert_eq!(
            PathBuf::from(&loaded.standalone_projects[0].path),
            absolutize_path(&workspace_path)
        );
    }

    #[tokio::test]
    async fn list_tasks_recovers_manual_features_from_macro_metadata_without_workspace_state() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".git").join("macro-metadata-worktree");
        let feature_dir = metadata_root
            .join(MANUAL_FEATURES_METADATA_DIR)
            .join("manual-feature-1");
        stdfs::create_dir_all(&feature_dir).expect("create manual feature dir");
        stdfs::write(
            feature_dir.join(MANUAL_FEATURE_METADATA_FILE),
            serde_json::json!({
                "schemaVersion": 1,
                "id": "manual-feature-1",
                "title": "Recovered independent task",
                "description": "Loaded from physical @macro metadata.",
                "status": "InProgress",
                "draft": false,
                "featureSlug": "recovered-independent-task",
                "branchName": "feature/recovered-independent-task",
                "baseBranch": "develop",
                "conversationId": "conversation-1",
                "projectIds": ["project-old"],
                "executionTargets": [{
                    "projectId": "project-old",
                    "branchName": "feature/recovered-independent-task",
                    "targetBranchName": "develop",
                    "worktreeKey": "branch-project-old-feature-recovered",
                    "repoPath": "/old/path"
                }],
                "updatedAt": "2026-06-05T07:52:40.707Z"
            })
            .to_string(),
        )
        .expect("write manual feature snapshot");

        let catalog = list_tasks(temp.path(), &metadata_root)
            .await
            .expect("recover manual feature task catalog");

        assert_eq!(catalog.tasks.len(), 1);
        assert_eq!(catalog.source, "fallback");
        assert!(catalog.has_standalone_tasks);
        assert_eq!(catalog.tasks[0]["id"], "manual-feature-1");
        assert_eq!(catalog.tasks[0]["standalone_kind"], "manual_feature");
        assert_eq!(catalog.tasks[0]["conversation_id"], "conversation-1");
        assert_eq!(
            catalog.tasks[0]["execution_targets"][0]["projectId"],
            "project-old"
        );
    }

    #[tokio::test]
    async fn get_bootstrap_recovers_selected_physical_repo_as_standalone_project_without_workspace_state(
    ) {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("octan_sales");
        let _repo = init_git_repo(&project_path, "main", &[]);
        let metadata_root = GitState::new()
            .resolve_macro_metadata_root(&project_path)
            .expect("project metadata root");
        let stale_project_id = "project-lplr-app-1780329499166";
        let plan_id = "1780299051043";
        let plan_dir = metadata_root
            .join(MACRO_BRANCHES_METADATA_DIR)
            .join("main")
            .join("plans")
            .join(plan_id);
        stdfs::create_dir_all(&plan_dir).expect("create plan dir");
        stdfs::write(
            metadata_root
                .join(MACRO_BRANCHES_METADATA_DIR)
                .join("main")
                .join("plans")
                .join("index.json"),
            serde_json::json!({
                "version": 3,
                "activePlanId": plan_id,
                "plans": [{
                    "id": plan_id,
                    "slug": "refonte-catalogue-produit",
                    "title": "Refonte catalogue produit",
                    "label": "Refonte catalogue produit",
                    "description": "Plan from physical @macro metadata.",
                    "status": "draft",
                    "targetBranch": "main",
                    "projectId": stale_project_id,
                    "projectIds": [stale_project_id],
                    "expectedProjectIds": [stale_project_id],
                    "createdAt": "2026-06-05T00:00:00.000Z",
                    "updatedAt": "2026-06-05T00:00:00.000Z",
                    "nodeCount": 1
                }]
            })
            .to_string(),
        )
        .expect("write plan index");
        stdfs::write(
            plan_dir.join("manifest.json"),
            serde_json::json!({
                "schemaVersion": 3,
                "planId": plan_id,
                "targetBranch": "main",
                "expectedProjectIds": [stale_project_id],
                "participants": [{
                    "projectId": stale_project_id,
                    "repoPathSnapshot": "/Users/oscarlahaie/github/lplr-app"
                }]
            })
            .to_string(),
        )
        .expect("write manifest");

        let bootstrap = get_bootstrap(&project_path, &metadata_root)
            .await
            .expect("bootstrap from physical repo");

        assert_eq!(bootstrap.project_groups.len(), 0);
        assert_eq!(bootstrap.standalone_projects.len(), 1);
        assert_eq!(bootstrap.standalone_projects[0].id, stale_project_id);
        assert_eq!(bootstrap.standalone_projects[0].name, "octan_sales");
        assert_eq!(
            bootstrap.standalone_projects[0].path,
            absolutize_path(&project_path).to_string_lossy()
        );
    }

    #[tokio::test]
    async fn get_bootstrap_does_not_restore_missing_sibling_macro_repo() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let parent = temp.path().join("github");
        let known_path = parent.join("sysml-drone-demo");
        let missing_path = parent.join("octan_sales");
        let _known_repo = init_git_repo(&known_path, "main", &[]);
        let _missing_repo = init_git_repo(&missing_path, "main", &[]);
        let missing_metadata_root = GitState::new()
            .resolve_macro_metadata_root(&missing_path)
            .expect("missing project metadata root");
        let plan_dir = missing_metadata_root
            .join("branches")
            .join("main")
            .join("plans")
            .join("1780299051043");
        stdfs::create_dir_all(&plan_dir).expect("create plan dir");
        stdfs::write(
            plan_dir.join("manifest.json"),
            serde_json::json!({
                "schemaVersion": 3,
                "planId": "1780299051043",
                "targetBranch": "main",
                "expectedProjectIds": ["project-lplr-app-1780329499166"],
                "participants": [{
                    "projectId": "project-lplr-app-1780329499166",
                    "repoPathSnapshot": "/Users/oscarlahaie/github/lplr-app"
                }]
            })
            .to_string(),
        )
        .expect("write manifest");
        persist_state_sync(
            &metadata_root,
            &WorkspaceState {
                version: WorkspaceState::default().version,
                standalone_projects: Vec::new(),
                project_groups: vec![ProjectGroupDto {
                    id: "group-sysml".to_string(),
                    name: "sysml".to_string(),
                    is_open: true,
                    projects: vec![make_project(
                        "project-sysml",
                        known_path.to_string_lossy().as_ref(),
                    )],
                }],
                ..WorkspaceState::default()
            },
        )
        .expect("persist workspace state");

        let bootstrap = get_bootstrap(temp.path(), &metadata_root)
            .await
            .expect("bootstrap loads registry");
        let persisted = load_raw_state_sync(&metadata_root)
            .expect("read persisted state")
            .expect("persisted state");

        assert!(!bootstrap
            .standalone_projects
            .iter()
            .any(|project| project.id == "project-lplr-app-1780329499166"
                && project.name == "octan_sales"));
        assert!(!persisted
            .standalone_projects
            .iter()
            .any(|project| project.id == "project-lplr-app-1780329499166"
                && project.name == "octan_sales"));
        let persisted_project_ids = persisted
            .standalone_projects
            .iter()
            .chain(
                persisted
                    .project_groups
                    .iter()
                    .flat_map(|group| group.projects.iter()),
            )
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(persisted_project_ids, vec!["project-sysml"]);
    }

    #[tokio::test]
    async fn reconcile_project_registry_from_hints_does_not_duplicate_existing_path() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("octan_sales");
        let _project_repo = init_git_repo(&project_path, "main", &[]);
        let _project_metadata_root = GitState::new()
            .resolve_macro_metadata_root(&project_path)
            .expect("project metadata root");
        let state = WorkspaceState {
            version: WorkspaceState::default().version,
            standalone_projects: vec![make_project(
                "project-existing",
                project_path.to_string_lossy().as_ref(),
            )],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &state).expect("persist workspace state");

        let report = reconcile_project_registry_from_hints(
            temp.path(),
            &metadata_root,
            WorkspaceReconcileProjectRegistryFromHintsRequestDto {
                projects: vec![WorkspaceMetadataRecoveryHintDto {
                    project_id: "project-octan-sales-1780653766405".to_string(),
                    group_id: None,
                    name: "octan_sales".to_string(),
                    path: project_path.to_string_lossy().to_string(),
                }],
            },
        )
        .await
        .expect("reconcile registry");
        let repaired = load_raw_state_sync(&metadata_root)
            .expect("read repaired state")
            .expect("state");

        assert_eq!(report.status, "unchanged");
        assert!(report.added_projects.is_empty());
        assert_eq!(
            report.duplicate_paths,
            vec![project_path.to_string_lossy().to_string()]
        );
        assert_eq!(repaired.standalone_projects.len(), 1);
        assert_eq!(repaired.standalone_projects[0].id, "project-existing");
    }

    #[tokio::test]
    async fn reconcile_project_registry_from_hints_ignores_invalid_paths() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        persist_state_sync(&metadata_root, &WorkspaceState::default())
            .expect("persist workspace state");
        let missing_path = temp.path().join("missing");

        let report = reconcile_project_registry_from_hints(
            temp.path(),
            &metadata_root,
            WorkspaceReconcileProjectRegistryFromHintsRequestDto {
                projects: vec![WorkspaceMetadataRecoveryHintDto {
                    project_id: "project-missing".to_string(),
                    group_id: None,
                    name: "Missing".to_string(),
                    path: missing_path.to_string_lossy().to_string(),
                }],
            },
        )
        .await
        .expect("reconcile registry");
        let state = load_raw_state_sync(&metadata_root)
            .expect("read state")
            .expect("state");

        assert_eq!(report.status, "unchanged");
        assert!(report.added_projects.is_empty());
        assert_eq!(
            report.invalid_paths,
            vec![missing_path.to_string_lossy().to_string()]
        );
        assert!(state.standalone_projects.is_empty());
    }

    #[tokio::test]
    async fn load_state_does_not_persist_destructive_repairs() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        init_git_repo(&project_path, "main", &[]);

        let state = WorkspaceState {
            version: 3,
            workspace_revision: 0,
            standalone_projects: Vec::new(),
            project_registry_explicitly_empty: false,
            project_groups: vec![ProjectGroupDto {
                id: "group-1".to_string(),
                name: "Suite".to_string(),
                is_open: true,
                projects: vec![make_project(
                    "project-web",
                    project_path.to_string_lossy().as_ref(),
                )],
            }],
            current_plan: Some(PlanDto {
                id: "plan-main".to_string(),
                description: "Workspace execution plan".to_string(),
                created_at: "2026-03-14T00:00:00.000Z".to_string(),
                updated_at: "2026-03-14T00:00:00.000Z".to_string(),
                status: "Draft".to_string(),
                project_ids: vec!["project-web".to_string(), "project-missing".to_string()],
                context_project_ids: Vec::new(),
                tasks: Vec::new(),
                predicted_git_trees: HashMap::new(),
            }),
            plan_nodes: Vec::new(),
            predicted_branches: Vec::new(),
            manual_features: Vec::new(),
            deleted_manual_feature_ids: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
        };
        persist_state_sync(&metadata_root, &state).expect("persist raw state");

        let loaded = load_state(temp.path(), &metadata_root)
            .await
            .expect("load state")
            .expect("state");
        assert_eq!(
            loaded.current_plan.as_ref().unwrap().project_ids,
            vec!["project-web".to_string(), "project-missing".to_string()]
        );

        let raw_content =
            stdfs::read_to_string(workspace_state_path(&metadata_root)).expect("read raw state");
        assert!(raw_content.contains("project-missing"));
    }

    #[tokio::test]
    async fn destructive_mutation_repairs_back_up_workspace_state_before_persisting() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        init_git_repo(&project_path, "main", &[]);

        let state = WorkspaceState {
            version: 3,
            standalone_projects: Vec::new(),
            project_groups: vec![ProjectGroupDto {
                id: "group-1".to_string(),
                name: "Suite".to_string(),
                is_open: true,
                projects: vec![
                    make_project("project-web", project_path.to_string_lossy().as_ref()),
                    make_project("project-web-copy", project_path.to_string_lossy().as_ref()),
                ],
            }],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &state).expect("persist raw state");

        persist_sanitized_state(temp.path(), &metadata_root, state, "remove_project")
            .await
            .expect("persist sanitized state");

        let backups = stdfs::read_dir(&metadata_root)
            .expect("read metadata root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("workspace.json.bak-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);

        let backup_content = stdfs::read_to_string(backups[0].path()).expect("read backup state");
        assert!(backup_content.contains("project-web-copy"));
    }

    #[tokio::test]
    async fn execute_project_git_setup_commit_rolls_back_new_repo_on_failure() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        stdfs::write(project_path.join("README.md"), "hello").expect("write file");
        let detection =
            preview_project_git_setup(temp.path(), Some(project_path.to_string_lossy().as_ref()));

        let result = execute_project_git_setup_commit(
            temp.path(),
            project_path.to_string_lossy().as_ref(),
            &[
                GIT_SETUP_ACTION_INITIALIZE_REPO.to_string(),
                GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string(),
            ],
            detection.resolved_repo_root_path.as_deref(),
            &detection.setup_state,
            &detection.recommended_action_sequence,
            None,
            || async {
                Err::<(), BackendError>(BackendError::Validation(
                    "persist failed on purpose".to_string(),
                ))
            },
        )
        .await;

        assert!(result.is_err());
        assert!(!project_path.join(".git").exists());
        let next_detection =
            preview_project_git_setup(temp.path(), Some(project_path.to_string_lossy().as_ref()));
        assert_eq!(next_detection.setup_state, PROJECT_GIT_DETECTION_NOT_GIT);
    }

    #[tokio::test]
    async fn execute_project_git_setup_commit_rolls_back_develop_branch_on_failure() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("repo");
        let repo = init_git_repo(&project_path, "main", &[]);
        let detection =
            preview_project_git_setup(temp.path(), Some(project_path.to_string_lossy().as_ref()));

        let result = execute_project_git_setup_commit(
            temp.path(),
            project_path.to_string_lossy().as_ref(),
            &[GIT_SETUP_ACTION_CREATE_DEVELOP.to_string()],
            detection.resolved_repo_root_path.as_deref(),
            &detection.setup_state,
            &detection.recommended_action_sequence,
            None,
            || async {
                Err::<(), BackendError>(BackendError::Validation(
                    "persist failed on purpose".to_string(),
                ))
            },
        )
        .await;

        assert!(result.is_err());
        assert!(repo.find_branch("develop", BranchType::Local).is_err());
    }

    #[tokio::test]
    async fn execute_project_git_setup_commit_rejects_stale_preview() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        let detection =
            preview_project_git_setup(temp.path(), Some(project_path.to_string_lossy().as_ref()));

        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(&project_path, &opts).expect("init repo");

        let result = execute_project_git_setup_commit::<(), _, _>(
            temp.path(),
            project_path.to_string_lossy().as_ref(),
            &[],
            detection.resolved_repo_root_path.as_deref(),
            &detection.setup_state,
            &detection.recommended_action_sequence,
            None,
            || async { Ok(()) },
        )
        .await;

        assert!(
            matches!(result, Err(BackendError::Validation(message)) if message.contains("Refresh and try again"))
        );
    }

    #[tokio::test]
    async fn revert_manual_feature_to_draft_clears_generated_metadata_and_slug_reservation() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("apps/web");
        stdfs::create_dir_all(&project_path).expect("create project dir");
        init_git_repo(&project_path, "main", &[]);
        let state = WorkspaceState {
            version: 1,
            workspace_revision: 0,
            standalone_projects: Vec::new(),
            project_registry_explicitly_empty: false,
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project(
                    "project-web",
                    project_path.to_string_lossy().as_ref(),
                )],
            }],
            current_plan: None,
            plan_nodes: Vec::new(),
            predicted_branches: Vec::new(),
            manual_features: Vec::new(),
            deleted_manual_feature_ids: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
        };

        persist_sanitized_state(temp.path(), &metadata_root, state, "seed_workspace_state")
            .await
            .expect("seed workspace state");

        let draft = create_manual_feature_draft(
            temp.path(),
            &metadata_root,
            "manual-task-1",
            "manual-conv",
            &["project-web".to_string()],
            &[],
            Some("develop"),
            None,
            None,
            "feature",
        )
        .await
        .expect("create draft");
        assert_eq!(draft.task_kind.as_deref(), Some("feature"));

        let finalized = finalize_manual_feature(
            temp.path(),
            &metadata_root,
            "manual-task-1",
            Some("manual-conv"),
            "Quick export",
            "Add a quick CSV export from the table.",
            "quick-export",
            "feature",
        )
        .await
        .expect("finalize draft");
        assert_eq!(finalized.task_kind.as_deref(), Some("feature"));

        let reverted = revert_manual_feature_to_draft(
            temp.path(),
            &metadata_root,
            "manual-task-1",
            Some("manual-conv"),
            Some("New feature"),
            Some(""),
        )
        .await
        .expect("revert draft");

        assert!(reverted.draft);
        assert_eq!(reverted.title, "New feature");
        assert_eq!(reverted.description, "");
        assert_eq!(reverted.status, "Pending");
        assert!(reverted.feature_slug.is_none());
        assert_eq!(reverted.task_kind.as_deref(), Some("feature"));
        assert!(reverted.branch_name.is_none());
        assert!(reverted.execution_targets.is_empty());

        let persisted_state = load_or_create_state(temp.path(), &metadata_root)
            .await
            .expect("load state");
        assert!(!persisted_state
            .reserved_standalone_feature_slugs
            .iter()
            .any(|value| value == "quick-export"));
    }

    #[tokio::test]
    async fn persisted_direct_execution_rejects_a_second_task_after_git_is_added() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let project_path = temp.path().join("direct-project");
        stdfs::create_dir_all(&project_path).expect("create direct project");
        let mut direct = make_project("project-direct", project_path.to_string_lossy().as_ref());
        direct.git_setup_state = PROJECT_GIT_SETUP_NOT_GIT.to_string();
        direct.direct_edit = true;
        direct.is_read_only = false;
        let state = WorkspaceState {
            standalone_projects: vec![direct],
            project_registry_explicitly_empty: false,
            ..WorkspaceState::default()
        };
        persist_sanitized_state(temp.path(), &metadata_root, state, "seed_direct_project")
            .await
            .expect("seed direct project");

        create_manual_feature_draft(
            temp.path(),
            &metadata_root,
            "direct-task-1",
            "direct-conv-1",
            &["project-direct".to_string()],
            &[],
            None,
            Some("First direct task"),
            None,
            "feature",
        )
        .await
        .expect("create first direct task");
        let finalized = finalize_manual_feature(
            temp.path(),
            &metadata_root,
            "direct-task-1",
            Some("direct-conv-1"),
            "First direct task",
            "Edit files without a project Git repository.",
            "first-direct-task",
            "feature",
        )
        .await
        .expect("finalize first direct task");
        let direct_target = finalized
            .execution_targets
            .first()
            .expect("persisted direct execution target");
        assert_eq!(direct_target.execution_mode.as_deref(), Some("direct"));
        assert!(direct_target.checkpoint_id.is_some());

        init_git_repo(&project_path, "develop", &["main"]);
        let mut state = load_or_create_state(temp.path(), &metadata_root)
            .await
            .expect("load direct project state");
        let project = state
            .standalone_projects
            .iter_mut()
            .find(|project| project.id == "project-direct")
            .expect("direct project");
        project.git_setup_state = PROJECT_GIT_SETUP_READY.to_string();
        project.direct_edit = false;
        persist_sanitized_state(
            temp.path(),
            &metadata_root,
            state,
            "add_git_to_direct_project",
        )
        .await
        .expect("persist project Git state");

        let error = create_manual_feature_draft(
            temp.path(),
            &metadata_root,
            "direct-task-2",
            "direct-conv-2",
            &["project-direct".to_string()],
            &[],
            None,
            Some("Second direct task"),
            None,
            "feature",
        )
        .await
        .expect_err("second direct task should be rejected");
        match error {
            BackendError::Validation(message) => assert!(
                message.contains("already has an active task"),
                "unexpected validation error: {message}"
            ),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn load_raw_state_restores_the_last_valid_backup() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let first = WorkspaceState {
            standalone_projects: vec![make_project("project-first", "/tmp/first")],
            ..WorkspaceState::default()
        };
        let second = WorkspaceState {
            standalone_projects: vec![make_project("project-second", "/tmp/second")],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &first).expect("persist first state");
        persist_state_sync(&metadata_root, &second).expect("persist second state");
        stdfs::write(workspace_state_path(&metadata_root), "{invalid")
            .expect("corrupt primary state");

        let recovered = load_raw_state_sync(&metadata_root)
            .expect("recover state")
            .expect("workspace state");
        assert_eq!(recovered.standalone_projects[0].id, "project-first");

        let restored_content =
            stdfs::read_to_string(workspace_state_path(&metadata_root)).expect("restored primary");
        let restored: WorkspaceState =
            serde_json::from_str(&restored_content).expect("valid restored json");
        assert_eq!(restored.standalone_projects[0].id, "project-first");
    }

    #[test]
    fn stale_manual_feature_snapshot_does_not_override_a_tombstone() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let snapshot_root = metadata_root
            .join(MANUAL_FEATURES_METADATA_DIR)
            .join("deleted-task");
        stdfs::create_dir_all(&snapshot_root).expect("snapshot root");
        stdfs::write(
            snapshot_root.join(MANUAL_FEATURE_METADATA_FILE),
            r#"{"id":"deleted-task","projectIds":["project-web"],"title":"Stale"}"#,
        )
        .expect("snapshot");
        let mut state = WorkspaceState {
            deleted_manual_feature_ids: vec!["deleted-task".to_string()],
            ..WorkspaceState::default()
        };

        assert_eq!(
            merge_manual_feature_snapshots_from_metadata_root(&mut state, &metadata_root),
            0
        );
        assert!(state.manual_features.is_empty());
    }

    #[tokio::test]
    async fn workspace_revision_rejects_a_stale_writer() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let initial = WorkspaceState::default();
        persist_state_sync(&metadata_root, &initial).expect("seed state");
        let first = load_raw_state_sync(&metadata_root)
            .expect("load")
            .expect("state");
        let stale = first.clone();
        persist_sanitized_state(temp.path(), &metadata_root, first, "first_writer")
            .await
            .expect("first writer");

        let error = persist_sanitized_state(temp.path(), &metadata_root, stale, "stale_writer")
            .await
            .expect_err("stale writer must fail");
        assert!(error.to_string().contains("autre instance"));
    }

    #[test]
    fn load_raw_state_promotes_the_newest_valid_temp_after_a_crash() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let primary = WorkspaceState {
            workspace_revision: 1,
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &primary).expect("primary");
        std::thread::sleep(Duration::from_millis(20));
        let recovered = WorkspaceState {
            workspace_revision: 2,
            standalone_projects: vec![make_project("project-recovered", "/tmp/recovered")],
            ..WorkspaceState::default()
        };
        let temp_path =
            metadata_root.join(format!(".{}.macro-tmp-recovery-test", WORKSPACE_STATE_FILE));
        stdfs::write(&temp_path, serde_json::to_string(&recovered).expect("json"))
            .expect("temp state");

        let loaded = load_raw_state_sync(&metadata_root)
            .expect("load")
            .expect("workspace state");
        assert_eq!(loaded.workspace_revision, 2);
        assert!(!temp_path.exists());
    }

    #[test]
    fn load_raw_state_never_downgrades_a_valid_primary_to_a_newer_touched_temp() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let primary = WorkspaceState {
            workspace_revision: 8,
            standalone_projects: vec![make_project("project-current", "/tmp/current")],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &primary).expect("primary");
        std::thread::sleep(Duration::from_millis(20));
        let stale_temp = WorkspaceState {
            workspace_revision: 7,
            standalone_projects: vec![make_project("project-stale", "/tmp/stale")],
            ..WorkspaceState::default()
        };
        let temp_path = metadata_root.join(format!(
            ".{}.macro-tmp-newer-mtime-stale-revision",
            WORKSPACE_STATE_FILE
        ));
        stdfs::write(
            &temp_path,
            serde_json::to_string(&stale_temp).expect("json"),
        )
        .expect("stale temp");

        let loaded = load_raw_state_sync(&metadata_root)
            .expect("load")
            .expect("workspace state");
        assert_eq!(loaded.workspace_revision, 8);
        assert_eq!(loaded.standalone_projects[0].id, "project-current");
        assert!(
            temp_path.exists(),
            "an unselected temp remains available for diagnostics"
        );
    }

    #[test]
    fn load_raw_state_keeps_valid_primary_when_temp_revision_is_equal() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let primary = WorkspaceState {
            workspace_revision: 12,
            standalone_projects: vec![make_project("project-primary", "/tmp/primary")],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &primary).expect("primary");
        std::thread::sleep(Duration::from_millis(20));
        let divergent_temp = WorkspaceState {
            workspace_revision: 12,
            standalone_projects: vec![make_project("project-divergent", "/tmp/divergent")],
            ..WorkspaceState::default()
        };
        let temp_path = metadata_root.join(format!(
            ".{}.macro-tmp-equal-revision-divergent",
            WORKSPACE_STATE_FILE
        ));
        stdfs::write(
            &temp_path,
            serde_json::to_string(&divergent_temp).expect("json"),
        )
        .expect("equal revision temp");

        let loaded = load_raw_state_sync(&metadata_root)
            .expect("load")
            .expect("workspace state");
        assert_eq!(loaded.workspace_revision, 12);
        assert_eq!(loaded.standalone_projects[0].id, "project-primary");
        assert!(temp_path.exists());
    }

    #[test]
    fn load_raw_state_prefers_temp_revision_over_temp_mtime() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        stdfs::create_dir_all(&metadata_root).expect("metadata root");
        let newest_revision = WorkspaceState {
            workspace_revision: 11,
            standalone_projects: vec![make_project("project-revision-11", "/tmp/revision-11")],
            ..WorkspaceState::default()
        };
        let revision_11_path =
            metadata_root.join(format!(".{}.macro-tmp-revision-11", WORKSPACE_STATE_FILE));
        stdfs::write(
            &revision_11_path,
            serde_json::to_string(&newest_revision).expect("json"),
        )
        .expect("revision 11 temp");
        std::thread::sleep(Duration::from_millis(20));
        let newer_mtime = WorkspaceState {
            workspace_revision: 10,
            standalone_projects: vec![make_project("project-revision-10", "/tmp/revision-10")],
            ..WorkspaceState::default()
        };
        let revision_10_path = metadata_root.join(format!(
            ".{}.macro-tmp-revision-10-newer-mtime",
            WORKSPACE_STATE_FILE
        ));
        stdfs::write(
            &revision_10_path,
            serde_json::to_string(&newer_mtime).expect("json"),
        )
        .expect("revision 10 temp");

        let loaded = load_raw_state_sync(&metadata_root)
            .expect("load")
            .expect("workspace state");
        assert_eq!(loaded.workspace_revision, 11);
        assert_eq!(loaded.standalone_projects[0].id, "project-revision-11");
        assert!(!revision_11_path.exists());
        assert!(revision_10_path.exists());
    }

    #[test]
    fn load_raw_state_reports_primary_and_backup_corruption() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        stdfs::create_dir_all(&metadata_root).expect("metadata root");
        stdfs::write(workspace_state_path(&metadata_root), "{primary").expect("corrupt primary");
        stdfs::write(workspace_state_backup_path(&metadata_root), "{backup")
            .expect("corrupt backup");

        let error = load_raw_state_sync(&metadata_root).expect_err("both files must fail");
        let message = error.to_string();
        assert!(message.contains("Primary error"));
        assert!(message.contains("backup error"));
        assert_eq!(
            stdfs::read_to_string(workspace_state_path(&metadata_root)).expect("primary kept"),
            "{primary"
        );
    }

    #[cfg(unix)]
    #[test]
    fn durable_write_failure_preserves_the_last_valid_json() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let original = WorkspaceState {
            standalone_projects: vec![make_project("project-original", "/tmp/original")],
            ..WorkspaceState::default()
        };
        let replacement = WorkspaceState {
            standalone_projects: vec![make_project("project-replacement", "/tmp/replacement")],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &original).expect("persist original state");

        let writable_permissions = stdfs::metadata(&metadata_root)
            .expect("metadata root")
            .permissions();
        let mut read_only_permissions = writable_permissions.clone();
        read_only_permissions.set_mode(0o555);
        stdfs::set_permissions(&metadata_root, read_only_permissions)
            .expect("make metadata root read-only");
        let result = persist_state_sync(&metadata_root, &replacement);
        stdfs::set_permissions(&metadata_root, writable_permissions)
            .expect("restore metadata permissions");

        assert!(
            result.is_err(),
            "write should fail in a read-only directory"
        );
        let content = stdfs::read_to_string(workspace_state_path(&metadata_root))
            .expect("read preserved primary state");
        let preserved: WorkspaceState =
            serde_json::from_str(&content).expect("preserved primary must remain valid JSON");
        assert_eq!(preserved.standalone_projects[0].id, "project-original");
    }

    #[tokio::test]
    async fn concurrent_workspace_mutations_preserve_both_updates() {
        let temp = TempDir::new().expect("temp dir");
        let metadata_root = temp.path().join(".macro");
        let first_path = temp.path().join("first");
        let second_path = temp.path().join("second");
        stdfs::create_dir_all(&first_path).expect("first path");
        stdfs::create_dir_all(&second_path).expect("second path");
        let state = WorkspaceState {
            standalone_projects: vec![
                make_project("project-first", first_path.to_string_lossy().as_ref()),
                make_project("project-second", second_path.to_string_lossy().as_ref()),
            ],
            ..WorkspaceState::default()
        };
        persist_state_sync(&metadata_root, &state).expect("seed state");

        let (first_result, second_result) = tokio::join!(
            rename_project(
                temp.path(),
                &metadata_root,
                "project-first",
                "First renamed"
            ),
            rename_project(
                temp.path(),
                &metadata_root,
                "project-second",
                "Second renamed"
            )
        );
        first_result.expect("rename first");
        second_result.expect("rename second");

        let persisted = load_raw_state_sync(&metadata_root)
            .expect("load state")
            .expect("workspace state");
        let names = persisted
            .standalone_projects
            .iter()
            .map(|project| project.name.as_str())
            .collect::<HashSet<_>>();
        assert!(names.contains("First renamed"));
        assert!(names.contains("Second renamed"));
    }
}
