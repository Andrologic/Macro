pub mod metadata;

use crate::core::error::{BackendError, Result};
use crate::db::models::GitWorktreeRecord;
use crate::git::detect_preferred_git_flow_branches;
use crate::git::repo::get_status_options;
use crate::git::MACRO_BRANCH_NAME;
use chrono::Utc;
use git2::{
    BranchType, IndexAddOption, Oid, Repository, RepositoryInitOptions, ResetType, Signature, Sort,
};
use metadata::{
    CreateProjectRequest, ImportGitRepoRequest, ManualFeatureDto, PlanDto,
    ProjectAccessChangePreviewDto, ProjectAccessMigrationItemDto, ProjectAccessMigrationSummaryDto,
    ProjectDto, ProjectGitFlowDetectionDto, ProjectGitFlowSettingsDto, ProjectGroupDto,
    ProjectMetadataDto, ProjectRegistryDiagnosticsDto, ProjectRegistryRepairReportDto,
    WorkspaceBootstrapDto, WorkspaceMetadataDto, WorkspaceMetadataRecoveryHintDto,
    WorkspaceMetadataRecoveryReportDto, WorkspaceRecoverMissingMetadataRequestDto, WorkspaceState,
    WorkspaceTaskCatalogDto, WorkspaceTaskExecutionTargetDto, WorkspaceTaskPlanSummaryDto,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::fs;

const WORKSPACE_STATE_FILE: &str = "workspace.json";
const LEGACY_WORKSPACE_META_DIR: &str = ".macro";
const DEFAULT_REMOTE_NAME: &str = "origin";
const AUTO_DETECTED_MAIN_BRANCH_NAMES: &[&str] = &["main", "master"];
const AUTO_DETECTED_BASE_BRANCH_NAMES: &[&str] = &["develop", "dev", "main", "master"];
const PROJECT_GIT_SETUP_READY: &str = "ready";
const PROJECT_GIT_SETUP_NOT_GIT: &str = "not_git";
const PROJECT_GIT_SETUP_UNBORN: &str = "unborn";
const PROJECT_GIT_DETECTION_READY: &str = "ready";
const PROJECT_GIT_DETECTION_NOT_GIT: &str = "not_git";
const PROJECT_GIT_DETECTION_UNBORN: &str = "unborn";
const PROJECT_GIT_DETECTION_SINGLE_MAIN_ONLY: &str = "single_main_only";
const PROJECT_GIT_DETECTION_NEEDS_BRANCH_CONFIRMATION: &str = "needs_branch_confirmation";
const READ_ONLY_REASON_MANUAL: &str = "manual";
const READ_ONLY_REASON_MISSING_GIT: &str = "missing_git";
const READ_ONLY_REASON_MISSING_INITIAL_COMMIT: &str = "missing_initial_commit";
const READ_ONLY_REASON_MANUAL_AND_MISSING_GIT: &str = "manual_and_missing_git";
const DEVELOP_PROMPT_MAIN_BRANCHES: &[&str] = &["main", "master", "trunk"];
const GIT_RESOLUTION_NONE: &str = "none";
const GIT_RESOLUTION_SELECTED_FOLDER: &str = "selected_folder";
const GIT_RESOLUTION_PARENT_REPO: &str = "parent_repo";
const GIT_RESOLUTION_NEW_LOCAL_REPO: &str = "new_local_repo";
const GIT_SETUP_ACTION_INITIALIZE_REPO: &str = "initialize_repo";
const GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT: &str = "create_initial_commit";
const GIT_SETUP_ACTION_CREATE_DEVELOP: &str = "create_develop";
const INITIAL_COMMIT_PREVIEW_LIMIT: usize = 20;
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
        .and_then(|reference| reference.symbolic_target().map(str::to_string))
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

fn repo_has_initial_commit(repo: &Repository) -> bool {
    repo.is_empty().map(|is_empty| !is_empty).unwrap_or(false)
}

fn should_offer_develop_for_branch(branch: Option<&str>) -> bool {
    let normalized = normalize_base_branch(branch);
    DEVELOP_PROMPT_MAIN_BRANCHES
        .iter()
        .any(|candidate| normalized == *candidate)
}

fn recommended_git_setup_actions(detection: &ProjectGitFlowDetectionDto) -> Vec<String> {
    if detection.setup_state == PROJECT_GIT_DETECTION_NOT_GIT {
        return vec![
            GIT_SETUP_ACTION_INITIALIZE_REPO.to_string(),
            GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string(),
            GIT_SETUP_ACTION_CREATE_DEVELOP.to_string(),
        ];
    }

    if detection.setup_state == PROJECT_GIT_DETECTION_UNBORN {
        let mut actions = vec![GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string()];
        let main_branch = detection
            .suggested_main_branch
            .as_deref()
            .or(detection.suggested_commit_branch.as_deref())
            .or(detection.current_branch.as_deref());
        if should_offer_develop_for_branch(main_branch) {
            actions.push(GIT_SETUP_ACTION_CREATE_DEVELOP.to_string());
        }
        return actions;
    }

    if detection.setup_state == PROJECT_GIT_DETECTION_SINGLE_MAIN_ONLY
        && should_offer_develop_for_branch(
            detection
                .suggested_main_branch
                .as_deref()
                .or(detection.suggested_commit_branch.as_deref())
                .or(detection.current_branch.as_deref()),
        )
    {
        return vec![GIT_SETUP_ACTION_CREATE_DEVELOP.to_string()];
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

    let suggested_main_branch = detection
        .main_branch
        .as_deref()
        .map(|value| normalize_base_branch(Some(value)));
    let suggested_base_branch = detection
        .base_branch
        .as_deref()
        .map(|value| normalize_base_branch(Some(value)));
    let viable_branch_count = detection
        .branch_candidates
        .iter()
        .filter(|branch_name| {
            let normalized = branch_name.trim().to_lowercase();
            !normalized.is_empty()
                && normalized != crate::git::MACRO_BRANCH_NAME.to_lowercase()
                && !normalized.starts_with("feature/")
                && !normalized.starts_with("feature-")
                && !normalized.starts_with("feat/")
                && !normalized.starts_with("feat-")
                && !normalized.starts_with("fix/")
                && !normalized.starts_with("fix-")
                && !normalized.starts_with("bugfix/")
                && !normalized.starts_with("bugfix-")
                && !normalized.starts_with("hotfix/")
                && !normalized.starts_with("hotfix-")
                && !normalized.starts_with("release/")
                && !normalized.starts_with("release-")
                && !normalized.starts_with("task/")
                && !normalized.starts_with("task-")
                && !normalized.starts_with("work/")
                && !normalized.starts_with("work-")
        })
        .count();

    if viable_branch_count <= 1 {
        if let (Some(main_branch), Some(base_branch)) = (
            suggested_main_branch.as_deref(),
            suggested_base_branch.as_deref(),
        ) {
            if main_branch == base_branch
                && DEVELOP_PROMPT_MAIN_BRANCHES
                    .iter()
                    .any(|candidate| main_branch == *candidate)
            {
                return PROJECT_GIT_DETECTION_SINGLE_MAIN_ONLY;
            }
        }
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

fn derive_project_read_only_reason(user_read_only: bool, git_setup_state: &str) -> Option<String> {
    match (user_read_only, git_setup_state) {
        (false, PROJECT_GIT_SETUP_READY) => None,
        (true, PROJECT_GIT_SETUP_READY) => Some(READ_ONLY_REASON_MANUAL.to_string()),
        (false, PROJECT_GIT_SETUP_NOT_GIT) => Some(READ_ONLY_REASON_MISSING_GIT.to_string()),
        (true, PROJECT_GIT_SETUP_NOT_GIT) => {
            Some(READ_ONLY_REASON_MANUAL_AND_MISSING_GIT.to_string())
        }
        (_, PROJECT_GIT_SETUP_UNBORN) => Some(READ_ONLY_REASON_MISSING_INITIAL_COMMIT.to_string()),
        _ => None,
    }
}

fn project_is_read_only(project: &ProjectDto) -> bool {
    project.user_read_only || project.git_setup_state != PROJECT_GIT_SETUP_READY
}

fn normalize_project_access(mut project: ProjectDto, git_setup_state: &str) -> ProjectDto {
    project.git_setup_state = git_setup_state.to_string();
    project.is_read_only = project_is_read_only(&ProjectDto {
        git_setup_state: git_setup_state.to_string(),
        ..project.clone()
    });
    project.read_only_reason =
        derive_project_read_only_reason(project.user_read_only, git_setup_state);
    project
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
        .and_then(|reference| reference.symbolic_target().map(str::to_string))
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

fn validate_project_git_setup_commit(
    workspace_path: &Path,
    project_path: &str,
    requested_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
) -> Result<ProjectGitFlowDetectionDto> {
    let detection = detect_project_git_flow_internal(workspace_path, Some(project_path));
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

async fn execute_project_git_setup_commit<T, F, Fut>(
    workspace_path: &Path,
    project_path: &str,
    git_setup_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
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

    let detection = validate_project_git_setup_commit(
        workspace_path,
        project_path,
        &normalized_actions,
        expected_repo_root_path,
        expected_setup_state,
        expected_recommended_action_sequence,
    )?;

    if !normalized_actions.is_empty() {
        let resolved_project_path = resolve_project_path(workspace_path, project_path);
        fs::create_dir_all(&resolved_project_path)
            .await
            .map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to create project directory {}: {}",
                    resolved_project_path.display(),
                    error
                ),
            })?;
    }

    let mut rollback_steps = Vec::new();
    for action in normalized_actions.iter() {
        apply_git_setup_action(
            workspace_path,
            project_path,
            &detection,
            action,
            &mut rollback_steps,
        )?;
    }

    match persist_operation().await {
        Ok(result) => {
            let next_detection =
                detect_project_git_flow_internal(workspace_path, Some(project_path));
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
        || create_project(workspace_path, metadata_root, request),
    )
    .await?;

    Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
}

pub async fn update_project_git_flow_with_setup(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
    git_flow_settings: &ProjectGitFlowSettingsDto,
    git_setup_actions: &[String],
    expected_repo_root_path: Option<&str>,
    expected_setup_state: &str,
    expected_recommended_action_sequence: &[String],
) -> Result<metadata::ProjectGitSetupCommitResultDto> {
    let state = load_or_create_state(workspace_path, metadata_root).await?;
    let project = find_project_by_id(&state.project_groups, project_id)
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
        || update_project_git_flow(workspace_path, metadata_root, project_id, git_flow_settings),
    )
    .await?;

    Ok(metadata::ProjectGitSetupCommitResultDto { project, detection })
}

pub async fn refresh_project_registry_state(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<()> {
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
            normalized.base_branch = base_branch;
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
    context_project_ids: &[String],
    base_branch: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
) -> Result<ManualFeatureDto> {
    let mut state = load_or_create_state(workspace_path, metadata_root).await?;
    let actionable_project_ids = collect_actionable_project_ids(&state.project_groups);
    let read_only_project_ids = collect_read_only_project_ids(&state.project_groups);
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
        context_project_ids: normalized_context_project_ids,
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
    ensure_plan_has_project(&mut state, &project);

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
    ensure_plan_has_project(&mut state, &project);

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
    let project = state
        .project_groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| BackendError::Validation(format!("Unknown project id: {}", project_id)))?;

    let actionable_project_ids = collect_actionable_project_ids(&state.project_groups);
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
    confirmed_migration: bool,
    access_preview: Option<&ProjectAccessChangePreviewDto>,
) -> Result<ProjectDto> {
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
                "This subproject cannot be switched to read-only right now: {}.",
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

    for group in state.project_groups.iter_mut() {
        if let Some(project) = group
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            if !user_read_only && project.git_setup_state != PROJECT_GIT_SETUP_READY {
                tracing::warn!(
                    action = "project_access_update_rejected",
                    project_id = %project_id,
                    user_read_only = user_read_only,
                    project_git_setup_state = %project.git_setup_state,
                    reason = "git_not_ready"
                );
                return Err(BackendError::Validation(
                    "Git must be ready before this subproject can become editable.".to_string(),
                ));
            }
            project.user_read_only = user_read_only;
            updated_project = Some(project.clone());
            break;
        }
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
        .project_groups
        .iter()
        .flat_map(|group| group.projects.iter())
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

fn collect_actionable_project_ids(groups: &[ProjectGroupDto]) -> HashSet<String> {
    groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .filter(|project| !project_is_read_only(project))
        .map(|project| project.id.clone())
        .collect()
}

fn collect_read_only_project_ids(groups: &[ProjectGroupDto]) -> HashSet<String> {
    groups
        .iter()
        .flat_map(|group| group.projects.iter())
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

fn load_raw_state_sync(metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let primary_path = workspace_state_path(metadata_root);
    let legacy_path = legacy_workspace_state_path(metadata_root);
    let path = if primary_path.exists() {
        primary_path
    } else if legacy_path.exists() {
        legacy_path
    } else {
        return Ok(None);
    };

    let content = std::fs::read_to_string(&path).map_err(|error| BackendError::Filesystem {
        message: format!("Failed to read workspace state: {}", error),
    })?;

    let state: WorkspaceState = serde_json::from_str(&content).map_err(|error| {
        BackendError::Validation(format!("Invalid workspace state format: {}", error))
    })?;

    Ok(Some(state))
}

fn persist_state_sync(metadata_root: &Path, state: &WorkspaceState) -> Result<()> {
    std::fs::create_dir_all(metadata_root).map_err(|error| BackendError::Filesystem {
        message: format!("Failed to create workspace metadata directory: {}", error),
    })?;

    let serialized =
        serde_json::to_string_pretty(state).map_err(|error| BackendError::Internal {
            message: format!("Failed to serialize workspace state: {}", error),
        })?;

    std::fs::write(workspace_state_path(metadata_root), serialized).map_err(|error| {
        BackendError::Filesystem {
            message: format!("Failed to write workspace state: {}", error),
        }
    })?;

    Ok(())
}

fn load_state_sync(workspace_path: &Path, metadata_root: &Path) -> Result<Option<WorkspaceState>> {
    let Some(state) = load_raw_state_sync(metadata_root)? else {
        return Ok(None);
    };

    let (sanitized_state, repair_report) = sanitize_workspace_state(workspace_path, state);
    if repair_report.has_repairs() {
        persist_state_sync(metadata_root, &sanitized_state)?;
    }

    Ok(Some(sanitized_state))
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

    let output = Command::new("git")
        .current_dir(metadata_root)
        .args([
            "pull",
            "--no-rebase",
            DEFAULT_REMOTE_NAME,
            MACRO_BRANCH_NAME,
        ])
        .output();

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
    !state.project_groups.is_empty()
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

    WorkspaceState {
        version: WorkspaceState::default().version,
        project_groups,
        current_plan: None,
        plan_nodes: Vec::new(),
        predicted_branches: Vec::new(),
        manual_features: Vec::new(),
    }
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
            predicted_branches_removed = repair_report.predicted_branches_removed,
            git_flow_settings_auto_updated = repair_report.git_flow_settings_auto_updated
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
            sanitized_projects.push(normalize_project_access(
                ProjectDto {
                    git_flow_settings,
                    ..project
                },
                derive_git_setup_state(&git_detection),
            ));
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
    let _valid_project_ids = collect_valid_project_ids(&state.project_groups);
    let actionable_project_ids = collect_actionable_project_ids(&state.project_groups);
    let read_only_project_ids = collect_read_only_project_ids(&state.project_groups);

    if let Some(plan) = state.current_plan.as_mut() {
        let original_project_ids = plan.project_ids.clone();
        let initial_project_ids = plan.project_ids.len();
        plan.project_ids
            .retain(|project_id| actionable_project_ids.contains(project_id));
        let mut unique_project_ids = HashSet::new();
        plan.project_ids
            .retain(|project_id| unique_project_ids.insert(project_id.clone()));
        let mut context_project_ids =
            sanitize_project_id_list(&plan.context_project_ids, &read_only_project_ids);
        for project_id in original_project_ids {
            if read_only_project_ids.contains(&project_id)
                && !context_project_ids.iter().any(|value| value == &project_id)
            {
                context_project_ids.push(project_id);
            }
        }
        plan.context_project_ids = context_project_ids;
        repair_report.current_plan_project_ids_removed =
            initial_project_ids.saturating_sub(plan.project_ids.len());

        let (sanitized_tasks, removed_tasks, removed_targets) =
            sanitize_plan_tasks(&plan.tasks, &actionable_project_ids, &read_only_project_ids);
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

    let initial_plan_node_count = state.plan_nodes.len();
    state.plan_nodes.retain(|node| {
        node.project_id
            .as_ref()
            .map(|project_id| actionable_project_ids.contains(project_id))
            .unwrap_or(true)
    });
    repair_report.plan_nodes_removed =
        initial_plan_node_count.saturating_sub(state.plan_nodes.len());

    let initial_predicted_branch_count = state.predicted_branches.len();
    state
        .predicted_branches
        .retain(|branch| actionable_project_ids.contains(&branch.project_id));
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

        let mut next_task = serde_json::Map::from_iter(task_object.clone().into_iter());
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

        sanitized_features.push(ManualFeatureDto {
            project_ids: fallback_project_ids,
            context_project_ids,
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
            predicted_branches_removed = repair_report.predicted_branches_removed,
            git_flow_settings_auto_updated = repair_report.git_flow_settings_auto_updated
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
            git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
            is_read_only: false,
            read_only_reason: None,
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
    use git2::{Repository, RepositoryInitOptions};
    use serde_json::json;
    use std::fs as stdfs;
    use std::process::Command;
    use tempfile::TempDir;

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
            user_read_only: false,
            git_setup_state: PROJECT_GIT_SETUP_READY.to_string(),
            is_read_only: false,
            read_only_reason: None,
            metadata: ProjectMetadataDto {
                description: String::new(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        }
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
        let add_status = Command::new("git")
            .current_dir(repo_root)
            .args(["add", "-A", "."])
            .status()
            .expect("git add");
        assert!(add_status.success());

        let commit_output = Command::new("git")
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
        let temp_dir = TempDir::new().expect("temp dir");
        let workspace_path = temp_dir.path().to_path_buf();
        init_git_repo(&workspace_path.join("apps/web"), "main", &[]);
        init_git_repo(&workspace_path.join("apps/api"), "main", &[]);
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
        assert_eq!(project.git_flow_settings.base_branch, "develop");
    }

    #[test]
    fn sanitize_workspace_state_auto_detects_legacy_git_flow_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("legacy-repo");
        let _repo = init_git_repo(&repo_path, "master", &["dev"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-legacy", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.project_groups[0].projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "master");
        assert_eq!(project.git_flow_settings.base_branch, "dev");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 1);
    }

    #[test]
    fn sanitize_workspace_state_auto_detects_custom_git_flow_branches() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("custom-repo");
        let _repo = init_git_repo(&repo_path, "trunk", &["integration"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-custom-detected", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.project_groups[0].projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "trunk");
        assert_eq!(project.git_flow_settings.base_branch, "integration");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 1);
    }

    #[test]
    fn sanitize_workspace_state_skips_rare_git_flow_conventions_without_confirmation() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("rare-repo");
        let _repo = init_git_repo(&repo_path, "stable", &["integration-ready"]);
        let project_path = repo_path.to_string_lossy().to_string();

        let state = WorkspaceState {
            version: 2,
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![make_project("project-rare-detected", &project_path)],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.project_groups[0].projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "main");
        assert_eq!(project.git_flow_settings.base_branch, "develop");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 0);
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
            project_groups: vec![ProjectGroupDto {
                id: "group-main".to_string(),
                name: "Main".to_string(),
                is_open: true,
                projects: vec![project],
            }],
            ..WorkspaceState::default()
        };

        let (sanitized_state, repair_report) = sanitize_workspace_state(temp.path(), state);
        let project = &sanitized_state.project_groups[0].projects[0];

        assert_eq!(project.git_flow_settings.main_branch, "trunk");
        assert_eq!(project.git_flow_settings.base_branch, "release");
        assert_eq!(repair_report.git_flow_settings_auto_updated, 0);
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
                GIT_SETUP_ACTION_CREATE_DEVELOP.to_string(),
            ]
        );
        assert_eq!(detection.initial_commit_preview_count, 1);
        assert_eq!(
            detection.initial_commit_preview_paths,
            vec!["README.md".to_string()]
        );
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
        assert_eq!(restored.project_groups.len(), 1);
        assert_eq!(restored.project_groups[0].projects[0].id, "project-web");
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
        assert_eq!(reconstructed.project_groups.len(), 1);
        assert_eq!(reconstructed.project_groups[0].id, "group-1");
        assert_eq!(
            reconstructed.project_groups[0].projects[0].id,
            "project-web"
        );
        assert_eq!(reconstructed.project_groups[0].projects[0].name, "Web");
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
            &vec![
                GIT_SETUP_ACTION_INITIALIZE_REPO.to_string(),
                GIT_SETUP_ACTION_CREATE_INITIAL_COMMIT.to_string(),
            ],
            detection.resolved_repo_root_path.as_deref(),
            &detection.setup_state,
            &detection.recommended_action_sequence,
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
            &vec![GIT_SETUP_ACTION_CREATE_DEVELOP.to_string()],
            detection.resolved_repo_root_path.as_deref(),
            &detection.setup_state,
            &detection.recommended_action_sequence,
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
            || async { Ok(()) },
        )
        .await;

        assert!(
            matches!(result, Err(BackendError::Validation(message)) if message.contains("Refresh and try again"))
        );
    }
}
