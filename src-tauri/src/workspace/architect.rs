use super::metadata::{
    WorkspaceArchitectActivatePlanChatRequestDto, WorkspaceArchitectActivatePlanHeadRequestDto,
    WorkspaceArchitectChatMessageDto, WorkspaceArchitectListPlansRequestDto,
    WorkspaceArchitectNeedDto, WorkspaceArchitectPlanActivationHeadDto, WorkspaceArchitectPlanListDto,
    WorkspaceArchitectPlanRecordDto, WorkspaceArchitectPlanReplicaDto,
    WorkspaceArchitectPlanRuntimeStatusDto, WorkspaceArchitectPlanSummaryDto,
    WorkspaceArchitectPlanTranscriptDto,
};
use super::load_or_default_state;
use crate::core::error::{BackendError, Result};
use crate::git::GitState;
use chrono::DateTime;
use futures::future::try_join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;
use tokio::sync::RwLock;

const DEFAULT_TARGET_BRANCH: &str = "develop";
const DEFAULT_NEW_PLAN_LABEL: &str = "new plan";

#[derive(Debug, Clone)]
struct ArchitectRuntimeScope {
    scope_key: String,
    project_id: Option<String>,
    repo_path: Option<PathBuf>,
    workspace_path: Option<PathBuf>,
    metadata_root: PathBuf,
    source: String,
}

#[derive(Debug, Clone)]
struct ArchitectPlanScopeSummaryEntry {
    scope: ArchitectRuntimeScope,
    summary: WorkspaceArchitectPlanSummaryDto,
}

#[derive(Debug, Clone)]
struct ArchitectPlanRuntimeBranchIndex {
    branch_name: String,
    branch_generation: u64,
    branch_stamp: String,
    workspace_state_stamp: String,
    scopes: Vec<ArchitectRuntimeScope>,
    index_stamps_by_scope_key: HashMap<String, String>,
    active_plan_id: Option<String>,
    plan_summaries_by_id: HashMap<String, WorkspaceArchitectPlanSummaryDto>,
    plan_locators_by_id: HashMap<String, Vec<ArchitectPlanScopeSummaryEntry>>,
    conversation_owners_by_id: HashMap<String, Vec<String>>,
    _visible_plans_by_scope_key: HashMap<String, Vec<String>>,
    _blank_canonical_by_scope_key: HashMap<String, String>,
    blank_alias_by_plan_id: HashMap<String, String>,
    rebuilt_last_load: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ArchitectPlanIndexFile {
    #[serde(default)]
    version: u32,
    #[serde(default, rename = "activePlanId")]
    active_plan_id: Option<String>,
    #[serde(default)]
    plans: Vec<WorkspaceArchitectPlanSummaryDto>,
    #[serde(default, rename = "reservedPlanSlugs")]
    reserved_plan_slugs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ArchitectPlanContentHashesDto {
    #[serde(default)]
    plan: String,
    #[serde(default)]
    needs: String,
    #[serde(default)]
    chat: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ArchitectPlanConversationSnapshotDto {
    #[serde(default, rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "messageCount")]
    message_count: usize,
    #[serde(default, rename = "lastMessageAt")]
    last_message_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ArchitectPlanManifestDto {
    #[serde(default, rename = "schemaVersion")]
    schema_version: u32,
    #[serde(default, rename = "planId")]
    plan_id: String,
    #[serde(default, rename = "targetBranch")]
    target_branch: String,
    #[serde(default)]
    status: String,
    #[serde(default, rename = "expectedProjectIds")]
    expected_project_ids: Vec<String>,
    #[serde(default, rename = "contextProjectIds")]
    context_project_ids: Vec<String>,
    #[serde(default)]
    revision: i64,
    #[serde(default, rename = "updatedAt")]
    updated_at: String,
    #[serde(default, rename = "contentHashes")]
    content_hashes: ArchitectPlanContentHashesDto,
    #[serde(default, rename = "needCount")]
    need_count: Option<usize>,
    #[serde(default)]
    conversation: ArchitectPlanConversationSnapshotDto,
}

#[derive(Debug, Clone)]
struct ArchitectPlanHeadSnapshot {
    scope: ArchitectRuntimeScope,
    _locator_summary: WorkspaceArchitectPlanSummaryDto,
    plan: WorkspaceArchitectPlanRecordDto,
    manifest: ArchitectPlanManifestDto,
}

static ARCHITECT_RUNTIME_CACHE: OnceLock<RwLock<HashMap<String, ArchitectPlanRuntimeBranchIndex>>> =
    OnceLock::new();

fn runtime_cache() -> &'static RwLock<HashMap<String, ArchitectPlanRuntimeBranchIndex>> {
    ARCHITECT_RUNTIME_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn normalize_branch_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_TARGET_BRANCH.to_string()
    } else {
        trimmed.replace('\\', "/")
    }
}

fn sanitize_id(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut previous_dash = false;
    for character in value.trim().to_lowercase().chars() {
        let normalized = if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            character
        } else {
            '-'
        };
        if normalized == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        result.push(normalized);
    }
    result.trim_matches('-').to_string()
}

fn trim_to_option(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn is_default_new_plan_family_label(value: Option<&str>) -> bool {
    let normalized = value.unwrap_or_default().trim().to_lowercase();
    if normalized == DEFAULT_NEW_PLAN_LABEL {
        return true;
    }
    normalized
        .strip_prefix(&format!("{DEFAULT_NEW_PLAN_LABEL} "))
        .map(|suffix| !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_canonical_architect_plan(title: &str, id: &str) -> bool {
    title.trim() == id.trim()
}

fn is_blank_activatable_summary(summary: &WorkspaceArchitectPlanSummaryDto) -> bool {
    summary.status == "draft"
        && is_canonical_architect_plan(&summary.title, &summary.id)
        && is_default_new_plan_family_label(summary.label.as_deref())
        && summary.description.trim().is_empty()
        && summary.node_count == 0
        && summary.predicted_branch_count.unwrap_or(0) == 0
        && summary.need_count.unwrap_or(0) == 0
        && summary.chat_message_count.unwrap_or(0) == 0
        && summary.conversation_id.is_none()
}

fn normalize_string_vec(values: &[String]) -> Vec<String> {
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let normalized = value.trim();
        if normalized.is_empty() {
            continue;
        }
        let owned = normalized.to_string();
        if seen.insert(owned.clone()) {
            deduped.push(owned);
        }
    }
    deduped
}

fn resolve_summary_project_ids(summary: &WorkspaceArchitectPlanSummaryDto) -> Vec<String> {
    let mut candidates = summary.project_ids.clone();
    if let Some(project_id) = summary.project_id.as_ref() {
        candidates.push(project_id.clone());
    }
    normalize_string_vec(&candidates)
}

fn normalize_summary(
    branch_name: &str,
    mut summary: WorkspaceArchitectPlanSummaryDto,
) -> WorkspaceArchitectPlanSummaryDto {
    let normalized_id = sanitize_id(&summary.id);
    summary.id = if normalized_id.is_empty() {
        summary.id.trim().to_string()
    } else {
        normalized_id
    };
    summary.slug = summary.slug.trim().to_string();
    if summary.slug.is_empty() {
        summary.slug = summary.id.clone();
    }
    summary.title = if summary.title.trim().is_empty() {
        summary.id.clone()
    } else {
        summary.title.trim().to_string()
    };
    summary.description = summary.description.trim().to_string();
    summary.target_branch = normalize_branch_name(if summary.target_branch.trim().is_empty() {
        branch_name
    } else {
        &summary.target_branch
    });
    summary.project_ids = resolve_summary_project_ids(&summary);
    summary.project_id = summary.project_ids.first().cloned();
    summary.context_project_ids = normalize_string_vec(&summary.context_project_ids);
    summary.expected_project_ids = {
        let normalized = normalize_string_vec(&summary.expected_project_ids);
        if normalized.is_empty() {
            summary.project_ids.clone()
        } else {
            normalized
        }
    };
    summary.available_project_ids = normalize_string_vec(&summary.available_project_ids);
    summary.missing_project_ids = normalize_string_vec(&summary.missing_project_ids);
    summary
}

fn normalize_plan_record(
    branch_name: &str,
    mut plan: WorkspaceArchitectPlanRecordDto,
) -> WorkspaceArchitectPlanRecordDto {
    let normalized_id = sanitize_id(&plan.id);
    plan.id = if normalized_id.is_empty() {
        plan.id.trim().to_string()
    } else {
        normalized_id
    };
    plan.slug = plan.slug.trim().to_string();
    if plan.slug.is_empty() {
        plan.slug = plan.id.clone();
    }
    plan.title = if plan.title.trim().is_empty() {
        plan.id.clone()
    } else {
        plan.title.trim().to_string()
    };
    plan.description = plan.description.trim().to_string();
    plan.target_branch = normalize_branch_name(if plan.target_branch.trim().is_empty() {
        branch_name
    } else {
        &plan.target_branch
    });
    plan.project_ids = normalize_string_vec(&plan.project_ids);
    if let Some(project_id) = plan.project_id.as_ref() {
        if !project_id.trim().is_empty() && !plan.project_ids.iter().any(|candidate| candidate == project_id) {
            plan.project_ids.insert(0, project_id.trim().to_string());
        }
    }
    plan.project_id = plan.project_ids.first().cloned();
    plan.context_project_ids = normalize_string_vec(&plan.context_project_ids);
    plan.expected_project_ids = {
        let normalized = normalize_string_vec(&plan.expected_project_ids);
        if normalized.is_empty() {
            plan.project_ids.clone()
        } else {
            normalized
        }
    };
    plan.available_project_ids = normalize_string_vec(&plan.available_project_ids);
    plan.missing_project_ids = normalize_string_vec(&plan.missing_project_ids);
    plan
}

fn compare_updated_at(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    let left_time = left
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    let right_time = right
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    left_time.cmp(&right_time)
}

fn compare_scope_recency(
    left_updated_at: Option<&str>,
    left_repo_path: Option<&Path>,
    right_updated_at: Option<&str>,
    right_repo_path: Option<&Path>,
) -> std::cmp::Ordering {
    let time_comparison = compare_updated_at(left_updated_at, right_updated_at);
    if time_comparison != std::cmp::Ordering::Equal {
        return time_comparison;
    }
    left_repo_path
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()
        .cmp(
            &right_repo_path
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
}

fn pick_canonical_entry<'a>(
    entries: &'a [ArchitectPlanScopeSummaryEntry],
) -> Option<&'a ArchitectPlanScopeSummaryEntry> {
    entries.iter().max_by(|left, right| {
        compare_scope_recency(
            Some(&left.summary.updated_at),
            left.scope.repo_path.as_deref(),
            Some(&right.summary.updated_at),
            right.scope.repo_path.as_deref(),
        )
    })
}

fn build_blank_scope_key(summary: &WorkspaceArchitectPlanSummaryDto) -> String {
    let mut project_ids = resolve_summary_project_ids(summary);
    project_ids.sort();
    project_ids.dedup();
    project_ids.join(",")
}

fn build_comparable_summary(summary: &WorkspaceArchitectPlanSummaryDto) -> Value {
    serde_json::json!({
        "id": summary.id,
        "slug": summary.slug,
        "title": summary.title,
        "label": summary.label,
        "description": summary.description,
        "status": summary.status,
        "targetBranch": summary.target_branch,
        "targetBranchesByProjectId": summary.target_branches_by_project_id,
        "conversationId": summary.conversation_id,
        "projectId": summary.project_id,
        "projectIds": summary.project_ids,
        "contextProjectIds": summary.context_project_ids,
        "createdAt": summary.created_at,
        "nodeCount": summary.node_count,
        "predictedBranchCount": summary.predicted_branch_count,
        "needCount": summary.need_count,
        "chatMessageCount": summary.chat_message_count,
        "expectedProjectIds": summary.expected_project_ids,
    })
}

fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (key, nested) in map {
                sorted.insert(key.clone(), stable_json_string(nested));
            }
            serde_json::to_string(&sorted).unwrap_or_default()
        }
        Value::Array(items) => serde_json::to_string(
            &items.iter().map(stable_json_string).collect::<Vec<_>>(),
        )
        .unwrap_or_default(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn to_replica_descriptor(
    scope: &ArchitectRuntimeScope,
    updated_at: Option<String>,
) -> WorkspaceArchitectPlanReplicaDto {
    WorkspaceArchitectPlanReplicaDto {
        scope_key: scope.scope_key.clone(),
        project_id: scope.project_id.clone(),
        repo_path: scope
            .repo_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        workspace_path: scope
            .workspace_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        source: scope.source.clone(),
        updated_at,
        missing: false,
    }
}

fn merge_plan_summaries(entries: &[ArchitectPlanScopeSummaryEntry]) -> Option<WorkspaceArchitectPlanSummaryDto> {
    let canonical_entry = pick_canonical_entry(entries)?;
    let mut project_ids = entries
        .iter()
        .flat_map(|entry| resolve_summary_project_ids(&entry.summary))
        .collect::<Vec<_>>();
    project_ids = normalize_string_vec(&project_ids);
    let mut available_project_ids = entries
        .iter()
        .filter_map(|entry| entry.scope.project_id.clone())
        .collect::<Vec<_>>();
    available_project_ids = normalize_string_vec(&available_project_ids);
    let expected_project_ids = {
        let normalized = normalize_string_vec(&canonical_entry.summary.expected_project_ids);
        if normalized.is_empty() {
            project_ids.clone()
        } else {
            normalized
        }
    };
    let missing_project_ids = expected_project_ids
        .iter()
        .filter(|project_id| !available_project_ids.iter().any(|candidate| candidate == *project_id))
        .cloned()
        .collect::<Vec<_>>();
    let has_replica_divergence = entries
        .iter()
        .map(|entry| stable_json_string(&build_comparable_summary(&entry.summary)))
        .collect::<HashSet<_>>()
        .len()
        > 1;
    let replication_state = if canonical_entry.summary.status == "deleted" {
        Some("deleted".to_string())
    } else if has_replica_divergence {
        Some("diverged".to_string())
    } else if !missing_project_ids.is_empty() {
        Some("missing_projects".to_string())
    } else {
        Some("healthy".to_string())
    };
    let mut merged = canonical_entry.summary.clone();
    merged.project_ids = project_ids.clone();
    merged.project_id = project_ids.first().cloned();
    merged.expected_project_ids = expected_project_ids;
    merged.available_project_ids = available_project_ids;
    merged.missing_project_ids = missing_project_ids;
    merged.replication_state = replication_state;
    merged.replicas = entries
        .iter()
        .map(|entry| to_replica_descriptor(&entry.scope, Some(entry.summary.updated_at.clone())))
        .collect();
    merged.has_replica_divergence = has_replica_divergence;
    Some(merged)
}

fn architect_plan_index_path(metadata_root: &Path, branch_name: &str) -> PathBuf {
    metadata_root
        .join("branches")
        .join(branch_name)
        .join("plans")
        .join("index.json")
}

fn architect_plan_dir(metadata_root: &Path, branch_name: &str, plan_id: &str) -> PathBuf {
    metadata_root
        .join("branches")
        .join(branch_name)
        .join("plans")
        .join(plan_id)
}

async fn read_json_file<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<Option<T>> {
    let contents = match fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(BackendError::Filesystem {
                message: format!("Failed to read {}: {}", path.display(), error),
            })
        }
    };
    serde_json::from_str::<T>(&contents).map(Some).map_err(|error| BackendError::Filesystem {
        message: format!("Failed to parse {}: {}", path.display(), error),
    })
}

async fn read_json_lines_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>> {
    let contents = match fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(BackendError::Filesystem {
                message: format!("Failed to read {}: {}", path.display(), error),
            })
        }
    };
    let mut values = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<T>(trimmed).map_err(|error| BackendError::Filesystem {
            message: format!("Failed to parse JSONL {}: {}", path.display(), error),
        })?;
        values.push(value);
    }
    Ok(values)
}

async fn file_stamp(path: &Path) -> String {
    match fs::metadata(path).await {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_nanos().to_string())
                .unwrap_or_else(|| "0".to_string());
            format!("{}:{modified}", metadata.len())
        }
        Err(_) => "missing".to_string(),
    }
}

async fn resolve_project_scopes(
    workspace_path: &Path,
    metadata_root: &Path,
) -> Result<Vec<ArchitectRuntimeScope>> {
    let state = load_or_default_state(workspace_path, metadata_root).await?;
    let mut scopes = Vec::new();
    let mut seen_scope_keys = HashSet::new();

    let workspace_scope = ArchitectRuntimeScope {
        scope_key: format!("workspace:{}", workspace_path.to_string_lossy()),
        project_id: None,
        repo_path: Some(workspace_path.to_path_buf()),
        workspace_path: Some(workspace_path.to_path_buf()),
        metadata_root: metadata_root.to_path_buf(),
        source: "workspace".to_string(),
    };
    seen_scope_keys.insert(workspace_scope.scope_key.clone());
    scopes.push(workspace_scope);

    let git_state = GitState::new();
    let mut project_paths = Vec::new();
    for group in state.project_groups {
        collect_project_paths(&group.projects, &mut project_paths);
    }
    let resolved_project_scopes = try_join_all(project_paths.into_iter().map(
        |(project_id, project_path)| {
            let git_state = git_state.clone();
            async move {
                let resolved_repo_path = PathBuf::from(project_path);
                let metadata_root_result = tokio::task::spawn_blocking({
                    let git_state = git_state.clone();
                    let repo_path = resolved_repo_path.clone();
                    move || git_state.resolve_macro_metadata_root(&repo_path)
                })
                .await
                .map_err(|error| BackendError::Internal {
                    message: format!("Architect metadata root join error: {}", error),
                })?;
                Ok::<_, BackendError>(metadata_root_result.ok().map(|project_metadata_root| {
                    (project_id, resolved_repo_path, project_metadata_root)
                }))
            }
        },
    ))
    .await?;
    for (project_id, resolved_repo_path, project_metadata_root) in
        resolved_project_scopes.into_iter().flatten()
    {
        let scope_key = format!("repo:{}", resolved_repo_path.to_string_lossy());
        if !seen_scope_keys.insert(scope_key.clone()) {
            continue;
        }
        scopes.push(ArchitectRuntimeScope {
            scope_key,
            project_id: Some(project_id),
            repo_path: Some(resolved_repo_path.clone()),
            workspace_path: Some(resolved_repo_path),
            metadata_root: project_metadata_root,
            source: "project".to_string(),
        });
    }

    Ok(scopes)
}

fn collect_project_paths(projects: &[super::metadata::ProjectDto], output: &mut Vec<(String, String)>) {
    for project in projects {
        if project.path.trim().is_empty() {
            continue;
        }
        output.push((project.id.clone(), project.path.clone()));
    }
}

async fn read_index_at_scope(
    scope: &ArchitectRuntimeScope,
    branch_name: &str,
) -> Result<ArchitectPlanIndexFile> {
    let path = architect_plan_index_path(&scope.metadata_root, branch_name);
    let index = read_json_file::<ArchitectPlanIndexFile>(&path)
        .await?
        .unwrap_or_default();
    let plans = index
        .plans
        .into_iter()
        .map(|summary| normalize_summary(branch_name, summary))
        .collect::<Vec<_>>();
    Ok(ArchitectPlanIndexFile {
        plans,
        ..index
    })
}

async fn build_branch_index(
    workspace_path: &Path,
    metadata_root: &Path,
    branch_name: &str,
    previous_generation: u64,
) -> Result<ArchitectPlanRuntimeBranchIndex> {
    let normalized_branch = normalize_branch_name(branch_name);
    let workspace_state_stamp = file_stamp(&metadata_root.join("workspace.json")).await;
    let scopes = resolve_project_scopes(workspace_path, metadata_root).await?;
    let index_results = try_join_all(scopes.iter().cloned().map(|scope| {
        let normalized_branch = normalized_branch.clone();
        async move {
            let index = read_index_at_scope(&scope, &normalized_branch).await?;
            let stamp =
                file_stamp(&architect_plan_index_path(&scope.metadata_root, &normalized_branch))
                    .await;
            Ok::<_, BackendError>((scope, index, stamp))
        }
    }))
    .await?;

    let mut plan_entries_by_id: HashMap<String, Vec<ArchitectPlanScopeSummaryEntry>> = HashMap::new();
    let mut active_plan_ids = HashSet::new();
    let mut index_stamps_by_scope_key = HashMap::new();
    for (scope, index, stamp) in &index_results {
        index_stamps_by_scope_key.insert(scope.scope_key.clone(), stamp.clone());
        if let Some(active_plan_id) = trim_to_option(index.active_plan_id.as_deref()) {
            active_plan_ids.insert(sanitize_id(&active_plan_id));
        }
        for summary in &index.plans {
            plan_entries_by_id
                .entry(summary.id.clone())
                .or_default()
                .push(ArchitectPlanScopeSummaryEntry {
                    scope: scope.clone(),
                    summary: summary.clone(),
                });
        }
    }

    let mut merged_summaries_by_id = HashMap::new();
    for (plan_id, entries) in &plan_entries_by_id {
        if let Some(merged) = merge_plan_summaries(entries) {
            merged_summaries_by_id.insert(plan_id.clone(), merged);
        }
    }

    let mut blank_groups: HashMap<String, Vec<String>> = HashMap::new();
    for (plan_id, summary) in &merged_summaries_by_id {
        if is_blank_activatable_summary(summary) {
            blank_groups
                .entry(build_blank_scope_key(summary))
                .or_default()
                .push(plan_id.clone());
        }
    }

    let mut blank_canonical_by_scope_key = HashMap::new();
    let mut blank_alias_by_plan_id = HashMap::new();
    for (scope_key, plan_ids) in blank_groups {
        let mut entries = plan_ids
            .iter()
            .filter_map(|plan_id| merged_summaries_by_id.get(plan_id))
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            compare_scope_recency(
                Some(&left.updated_at),
                None,
                Some(&right.updated_at),
                None,
            )
        });
        if let Some(canonical) = entries.last() {
            blank_canonical_by_scope_key.insert(scope_key.clone(), canonical.id.clone());
            for plan_id in plan_ids {
                blank_alias_by_plan_id.insert(plan_id, canonical.id.clone());
            }
        }
    }

    let mut visible_plan_ids = merged_summaries_by_id.keys().cloned().collect::<Vec<_>>();
    visible_plan_ids.retain(|plan_id| {
        let Some(summary) = merged_summaries_by_id.get(plan_id) else {
            return false;
        };
        if !is_blank_activatable_summary(summary) {
            return true;
        }
        blank_alias_by_plan_id
            .get(plan_id)
            .map(|canonical_id| canonical_id == plan_id)
            .unwrap_or(true)
    });

    let visible_plan_id_set = visible_plan_ids.iter().cloned().collect::<HashSet<_>>();
    let mut conversation_owners_by_id: HashMap<String, Vec<String>> = HashMap::new();
    let mut visible_plans_by_scope_key: HashMap<String, Vec<String>> = HashMap::new();
    for plan_id in &visible_plan_ids {
        let Some(summary) = merged_summaries_by_id.get(plan_id) else {
            continue;
        };
        if let Some(conversation_id) = summary.conversation_id.as_ref() {
            conversation_owners_by_id
                .entry(conversation_id.clone())
                .or_default()
                .push(plan_id.clone());
        }
        for project_id in resolve_summary_project_ids(summary) {
            visible_plans_by_scope_key
                .entry(project_id)
                .or_default()
                .push(plan_id.clone());
        }
    }
    for owners in conversation_owners_by_id.values_mut() {
        owners.sort();
        owners.dedup();
    }

    let active_plan_id = if active_plan_ids.len() == 1 {
        active_plan_ids.into_iter().next().map(|plan_id| {
            blank_alias_by_plan_id
                .get(&plan_id)
                .cloned()
                .unwrap_or(plan_id)
        })
    } else {
        None
    };
    let branch_stamp = index_stamps_by_scope_key
        .iter()
        .map(|(scope_key, stamp)| format!("{scope_key}:{stamp}"))
        .collect::<Vec<_>>()
        .join("|");

    let plan_summaries_by_id = merged_summaries_by_id
        .into_iter()
        .filter(|(plan_id, _)| visible_plan_id_set.contains(plan_id))
        .collect::<HashMap<_, _>>();

    Ok(ArchitectPlanRuntimeBranchIndex {
        branch_name: normalized_branch,
        branch_generation: previous_generation.saturating_add(1),
        branch_stamp,
        workspace_state_stamp,
        scopes,
        index_stamps_by_scope_key,
        active_plan_id,
        plan_summaries_by_id,
        plan_locators_by_id: plan_entries_by_id,
        conversation_owners_by_id,
        _visible_plans_by_scope_key: visible_plans_by_scope_key,
        _blank_canonical_by_scope_key: blank_canonical_by_scope_key,
        blank_alias_by_plan_id,
        rebuilt_last_load: true,
    })
}

async fn branch_index_is_stale(
    metadata_root: &Path,
    cached: &ArchitectPlanRuntimeBranchIndex,
) -> bool {
    let current_workspace_state_stamp = file_stamp(&metadata_root.join("workspace.json")).await;
    if current_workspace_state_stamp != cached.workspace_state_stamp {
        return true;
    }
    for scope in &cached.scopes {
        let current_stamp = file_stamp(&architect_plan_index_path(&scope.metadata_root, &cached.branch_name)).await;
        let Some(previous_stamp) = cached.index_stamps_by_scope_key.get(&scope.scope_key) else {
            return true;
        };
        if &current_stamp != previous_stamp {
            return true;
        }
    }
    false
}

async fn load_branch_index(
    workspace_path: &Path,
    metadata_root: &Path,
    branch_name: &str,
) -> Result<ArchitectPlanRuntimeBranchIndex> {
    let normalized_branch = normalize_branch_name(branch_name);
    let cache_key = format!("{}::{normalized_branch}", metadata_root.to_string_lossy());

    {
        let cache = runtime_cache().read().await;
        if let Some(cached) = cache.get(&cache_key) {
            if !branch_index_is_stale(metadata_root, cached).await {
                let mut reused = cached.clone();
                reused.rebuilt_last_load = false;
                return Ok(reused);
            }
        }
    }

    let previous_generation = {
        let cache = runtime_cache().read().await;
        cache
            .get(&cache_key)
            .map(|index| index.branch_generation)
            .unwrap_or(0)
    };
    let rebuilt = build_branch_index(workspace_path, metadata_root, &normalized_branch, previous_generation).await?;
    {
        let mut cache = runtime_cache().write().await;
        cache.insert(cache_key, rebuilt.clone());
    }
    Ok(rebuilt)
}

fn resolve_effective_plan_id(index: &ArchitectPlanRuntimeBranchIndex, requested_plan_id: &str) -> String {
    let normalized_plan_id = sanitize_id(requested_plan_id);
    index.blank_alias_by_plan_id
        .get(&normalized_plan_id)
        .cloned()
        .unwrap_or(normalized_plan_id)
}

fn build_runtime_status(index: &ArchitectPlanRuntimeBranchIndex) -> WorkspaceArchitectPlanRuntimeStatusDto {
    WorkspaceArchitectPlanRuntimeStatusDto {
        branch_name: index.branch_name.clone(),
        branch_generation: index.branch_generation,
        branch_stamp: index.branch_stamp.clone(),
        plan_count: index.plan_summaries_by_id.len(),
        scope_count: index.scopes.len(),
        rebuilt: index.rebuilt_last_load,
    }
}

fn summary_to_blank_head(
    summary: &WorkspaceArchitectPlanSummaryDto,
) -> WorkspaceArchitectPlanActivationHeadDto {
    WorkspaceArchitectPlanActivationHeadDto {
        plan: WorkspaceArchitectPlanRecordDto {
            id: summary.id.clone(),
            slug: summary.slug.clone(),
            title: summary.title.clone(),
            label: summary.label.clone(),
            description: summary.description.clone(),
            status: summary.status.clone(),
            target_branch: summary.target_branch.clone(),
            target_branches_by_project_id: summary.target_branches_by_project_id.clone(),
            conversation_id: None,
            project_id: summary.project_id.clone(),
            project_ids: summary.project_ids.clone(),
            context_project_ids: summary.context_project_ids.clone(),
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
            nodes: Vec::new(),
            predicted_branches: Vec::new(),
            expected_project_ids: summary.expected_project_ids.clone(),
            available_project_ids: summary.available_project_ids.clone(),
            missing_project_ids: summary.missing_project_ids.clone(),
            replication_state: summary.replication_state.clone(),
            revision: summary.revision,
            replicas: summary.replicas.clone(),
            has_replica_divergence: summary.has_replica_divergence,
        },
        needs: Vec::new(),
        conversation_id: None,
        shared_conversation: false,
        target_branch: summary.target_branch.clone(),
        resolution_mode: "blank_fast_path".to_string(),
        chat_transcript_revision: None,
        chat_message_count: 0,
    }
}

async fn load_head_snapshot(
    scope_entry: &ArchitectPlanScopeSummaryEntry,
    branch_name: &str,
) -> Result<Option<ArchitectPlanHeadSnapshot>> {
    let plan_id = sanitize_id(&scope_entry.summary.id);
    let plan_dir = architect_plan_dir(&scope_entry.scope.metadata_root, branch_name, &plan_id);
    let plan_path = plan_dir.join("plan.json");
    let manifest_path = plan_dir.join("manifest.json");
    let (plan_opt, manifest_opt) = tokio::try_join!(
        read_json_file::<WorkspaceArchitectPlanRecordDto>(&plan_path),
        read_json_file::<ArchitectPlanManifestDto>(&manifest_path),
    )?;
    let Some(plan) = plan_opt else {
        return Ok(None);
    };
    let Some(manifest) = manifest_opt else {
        return Ok(None);
    };
    if plan.status == "deleted" {
        return Ok(None);
    }
    Ok(Some(ArchitectPlanHeadSnapshot {
        scope: scope_entry.scope.clone(),
        _locator_summary: scope_entry.summary.clone(),
        plan: normalize_plan_record(branch_name, plan),
        manifest,
    }))
}

async fn load_head_snapshots_for_locators(
    locators: &[ArchitectPlanScopeSummaryEntry],
    branch_name: &str,
) -> Result<Vec<ArchitectPlanHeadSnapshot>> {
    let normalized_branch = branch_name.to_string();
    Ok(try_join_all(locators.iter().cloned().map(|locator| {
        let normalized_branch = normalized_branch.clone();
        async move { load_head_snapshot(&locator, &normalized_branch).await }
    }))
    .await?
    .into_iter()
    .flatten()
    .collect())
}

fn pick_canonical_snapshot<'a>(
    snapshots: &'a [ArchitectPlanHeadSnapshot],
) -> Option<&'a ArchitectPlanHeadSnapshot> {
    snapshots.iter().max_by(|left, right| {
        compare_scope_recency(
            Some(&left.plan.updated_at),
            left.scope.repo_path.as_deref(),
            Some(&right.plan.updated_at),
            right.scope.repo_path.as_deref(),
        )
    })
}

async fn read_needs_for_snapshot(
    snapshot: &ArchitectPlanHeadSnapshot,
    branch_name: &str,
    hinted_need_count: usize,
) -> Result<Vec<WorkspaceArchitectNeedDto>> {
    if hinted_need_count == 0 {
        return Ok(Vec::new());
    }
    let plan_id = sanitize_id(&snapshot.plan.id);
    let path = architect_plan_dir(&snapshot.scope.metadata_root, branch_name, &plan_id).join("needs.json");
    Ok(read_json_file::<Vec<WorkspaceArchitectNeedDto>>(&path)
        .await?
        .unwrap_or_default())
}

async fn read_transcript_for_scope(
    scope: &ArchitectRuntimeScope,
    branch_name: &str,
    plan_id: &str,
) -> Result<Vec<WorkspaceArchitectChatMessageDto>> {
    let path = architect_plan_dir(&scope.metadata_root, branch_name, plan_id).join("chat.jsonl");
    read_json_lines_file::<WorkspaceArchitectChatMessageDto>(&path).await
}

fn filter_locators_for_scope_hint(
    locators: &[ArchitectPlanScopeSummaryEntry],
    scoped_project_ids_hint: &[String],
) -> Vec<ArchitectPlanScopeSummaryEntry> {
    if scoped_project_ids_hint.is_empty() {
        return locators.to_vec();
    }
    let project_id_set = scoped_project_ids_hint
        .iter()
        .map(|project_id| project_id.trim().to_string())
        .filter(|project_id| !project_id.is_empty())
        .collect::<HashSet<_>>();
    let mut filtered = locators
        .iter()
        .filter(|entry| {
            entry
                .scope
                .project_id
                .as_ref()
                .map(|project_id| project_id_set.contains(project_id))
                .unwrap_or(false)
                || entry.scope.source == "workspace"
        })
        .cloned()
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        filtered = locators.to_vec();
    }
    filtered
}

pub async fn list_plans(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceArchitectListPlansRequestDto,
) -> Result<WorkspaceArchitectPlanListDto> {
    let index = load_branch_index(workspace_path, metadata_root, &request.branch_name).await?;
    let mut plans = index
        .plan_summaries_by_id
        .values()
        .filter(|summary| request.include_deleted || summary.status != "deleted")
        .filter(|summary| request.include_archived || summary.status != "archived")
        .cloned()
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| {
        compare_scope_recency(
            Some(&left.updated_at),
            None,
            Some(&right.updated_at),
            None,
        )
        .reverse()
    });
    Ok(WorkspaceArchitectPlanListDto {
        active_plan_id: index.active_plan_id.clone(),
        plans,
        runtime_status: Some(build_runtime_status(&index)),
    })
}

pub async fn activate_plan_head(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceArchitectActivatePlanHeadRequestDto,
) -> Result<Option<WorkspaceArchitectPlanActivationHeadDto>> {
    let normalized_branch = normalize_branch_name(&request.branch_name);
    let index = load_branch_index(workspace_path, metadata_root, &normalized_branch).await?;
    let effective_plan_id = resolve_effective_plan_id(&index, &request.plan_id);
    let hinted_summary = request
        .summary_hint
        .map(|summary| normalize_summary(&normalized_branch, summary))
        .filter(|summary| sanitize_id(&summary.id) == effective_plan_id);
    let summary = hinted_summary
        .or_else(|| index.plan_summaries_by_id.get(&effective_plan_id).cloned());
    let Some(summary) = summary else {
        return Ok(None);
    };
    if is_blank_activatable_summary(&summary) {
        return Ok(Some(summary_to_blank_head(&summary)));
    }

    let Some(all_locators) = index.plan_locators_by_id.get(&effective_plan_id) else {
        return Ok(None);
    };
    let candidate_locators =
        filter_locators_for_scope_hint(all_locators, &request.scoped_project_ids_hint);
    let mut snapshots =
        load_head_snapshots_for_locators(&candidate_locators, &normalized_branch).await?;
    if snapshots.is_empty() && candidate_locators.len() != all_locators.len() {
        snapshots = load_head_snapshots_for_locators(all_locators, &normalized_branch).await?;
    }
    let Some(canonical_snapshot) = pick_canonical_snapshot(&snapshots) else {
        return Ok(None);
    };

    let needs = read_needs_for_snapshot(
        canonical_snapshot,
        &normalized_branch,
        summary
            .need_count
            .or(canonical_snapshot.manifest.need_count)
            .unwrap_or(0),
    )
    .await?;
    let conversation_id = canonical_snapshot
        .manifest
        .conversation
        .conversation_id
        .clone()
        .or_else(|| canonical_snapshot.plan.conversation_id.clone());
    let shared_conversation = conversation_id
        .as_ref()
        .and_then(|conversation_id| index.conversation_owners_by_id.get(conversation_id))
        .map(|owners| owners.len() > 1)
        .unwrap_or(false);
    let mut plan = canonical_snapshot.plan.clone();
    plan.target_branch = normalized_branch.clone();
    plan.project_ids = summary.project_ids.clone();
    plan.project_id = summary.project_id.clone();
    plan.context_project_ids = summary.context_project_ids.clone();
    plan.expected_project_ids = summary.expected_project_ids.clone();
    plan.available_project_ids = summary.available_project_ids.clone();
    plan.missing_project_ids = summary.missing_project_ids.clone();
    plan.replication_state = summary.replication_state.clone();
    plan.revision = Some(canonical_snapshot.manifest.revision.max(plan.revision.unwrap_or(1)));
    plan.replicas = summary.replicas.clone();
    plan.has_replica_divergence = summary.has_replica_divergence;
    plan.conversation_id = conversation_id.clone();

    Ok(Some(WorkspaceArchitectPlanActivationHeadDto {
        plan,
        needs,
        conversation_id: conversation_id.clone(),
        shared_conversation,
        target_branch: normalized_branch,
        resolution_mode: "full".to_string(),
        chat_transcript_revision: trim_to_option(Some(
            canonical_snapshot.manifest.content_hashes.chat.as_str(),
        )),
        chat_message_count: canonical_snapshot.manifest.conversation.message_count,
    }))
}

pub async fn activate_plan_chat(
    workspace_path: &Path,
    metadata_root: &Path,
    request: WorkspaceArchitectActivatePlanChatRequestDto,
) -> Result<Option<WorkspaceArchitectPlanTranscriptDto>> {
    let normalized_branch = normalize_branch_name(&request.branch_name);
    let index = load_branch_index(workspace_path, metadata_root, &normalized_branch).await?;
    let effective_plan_id = resolve_effective_plan_id(&index, &request.plan_id);
    let Some(locators) = index.plan_locators_by_id.get(&effective_plan_id) else {
        return Ok(None);
    };
    let chosen_locator = pick_canonical_entry(locators).cloned();
    let Some(chosen_locator) = chosen_locator else {
        return Ok(None);
    };
    let plan_id = sanitize_id(&effective_plan_id);
    let manifest_path =
        architect_plan_dir(&chosen_locator.scope.metadata_root, &normalized_branch, &plan_id)
            .join("manifest.json");
    let manifest = read_json_file::<ArchitectPlanManifestDto>(&manifest_path)
        .await?
        .unwrap_or_default();
    let messages = if manifest.conversation.message_count == 0 {
        Vec::new()
    } else {
        read_transcript_for_scope(&chosen_locator.scope, &normalized_branch, &plan_id).await?
    };
    Ok(Some(WorkspaceArchitectPlanTranscriptDto {
        plan_id,
        target_branch: normalized_branch,
        transcript_revision: trim_to_option(Some(manifest.content_hashes.chat.as_str())),
        message_count: manifest.conversation.message_count,
        messages,
    }))
}
