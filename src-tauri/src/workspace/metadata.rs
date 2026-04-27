use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub project_groups: Vec<ProjectGroupDto>,
    #[serde(default)]
    pub current_plan: Option<PlanDto>,
    #[serde(default)]
    pub plan_nodes: Vec<PlanNodeDto>,
    #[serde(default)]
    pub predicted_branches: Vec<PredictedBranchDto>,
    #[serde(default)]
    pub manual_features: Vec<ManualFeatureDto>,
    #[serde(default, rename = "reservedStandaloneFeatureSlugs")]
    pub reserved_standalone_feature_slugs: Vec<String>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            version: default_version(),
            project_groups: Vec::new(),
            current_plan: None,
            plan_nodes: Vec::new(),
            predicted_branches: Vec::new(),
            manual_features: Vec::new(),
            reserved_standalone_feature_slugs: Vec::new(),
        }
    }
}

const fn default_version() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceBootstrapDto {
    pub plan: Option<PlanDto>,
    #[serde(rename = "projectGroups")]
    pub project_groups: Vec<ProjectGroupDto>,
    #[serde(rename = "planNodes")]
    pub plan_nodes: Vec<PlanNodeDto>,
    #[serde(rename = "predictedBranches")]
    pub predicted_branches: Vec<PredictedBranchDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMetadataDto {
    pub workspace_path: String,
    pub metadata_path: String,
    pub project_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMetadataRecoveryHintDto {
    #[serde(default, rename = "projectId")]
    pub project_id: String,
    #[serde(default, rename = "groupId")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceRecoverMissingMetadataRequestDto {
    #[serde(default, rename = "attemptPull")]
    pub attempt_pull: bool,
    #[serde(default)]
    pub projects: Vec<WorkspaceMetadataRecoveryHintDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceMetadataRecoveryReportDto {
    pub status: String,
    #[serde(default, rename = "restoredCommit")]
    pub restored_commit: Option<String>,
    #[serde(default, rename = "pullAttempted")]
    pub pull_attempted: bool,
    #[serde(default, rename = "pullSucceeded")]
    pub pull_succeeded: bool,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DebugResetProjectReportDto {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(rename = "removedRegistryEntry")]
    pub removed_registry_entry: bool,
    #[serde(rename = "removedTaskWorktrees")]
    pub removed_task_worktrees: usize,
    #[serde(rename = "removedMetadataWorktree")]
    pub removed_metadata_worktree: bool,
    #[serde(rename = "removedMacroBranch")]
    pub removed_macro_branch: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTaskPlanSummaryDto {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(rename = "targetBranch")]
    pub target_branch: String,
    #[serde(rename = "projectIds")]
    pub project_ids: Vec<String>,
    #[serde(rename = "taskCount")]
    pub task_count: usize,
    #[serde(rename = "completedTaskCount")]
    pub completed_task_count: usize,
    #[serde(rename = "activeTaskCount")]
    pub active_task_count: usize,
    #[serde(rename = "inReviewTaskCount")]
    pub in_review_task_count: usize,
    #[serde(rename = "readyForValidation")]
    pub ready_for_validation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTaskCatalogDto {
    pub tasks: Vec<Value>,
    pub plans: Vec<WorkspaceTaskPlanSummaryDto>,
    #[serde(rename = "hasStandaloneTasks")]
    pub has_standalone_tasks: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTaskExecutionTargetDto {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "branchName")]
    pub branch_name: String,
    #[serde(default, rename = "targetBranchName")]
    pub target_branch_name: Option<String>,
    #[serde(rename = "worktreeKey")]
    pub worktree_key: String,
    #[serde(default, rename = "repoPath")]
    pub repo_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualFeatureMergeWorkflowRepositoryDto {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "repoPath")]
    pub repo_path: String,
    #[serde(rename = "sourceBranchName")]
    pub source_branch_name: String,
    #[serde(rename = "targetBranchName")]
    pub target_branch_name: String,
    pub state: String,
    #[serde(default, rename = "hadChangesAtStart")]
    pub had_changes_at_start: bool,
    #[serde(default, rename = "mergeAppliedAt")]
    pub merge_applied_at: Option<String>,
    #[serde(default, rename = "blockingKind")]
    pub blocking_kind: Option<String>,
    #[serde(default, rename = "blockingReason")]
    pub blocking_reason: Option<String>,
    #[serde(default, rename = "conflictFiles")]
    pub conflict_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualFeatureMergeWorkflowDto {
    pub kind: String,
    pub phase: String,
    #[serde(rename = "taskStatus")]
    pub task_status: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default, rename = "lastLoadedAt")]
    pub last_loaded_at: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub repositories: Vec<ManualFeatureMergeWorkflowRepositoryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualFeatureDto {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(default)]
    pub draft: bool,
    pub title: String,
    pub description: String,
    pub status: String,
    #[serde(default, rename = "featureSlug")]
    pub feature_slug: Option<String>,
    #[serde(default, rename = "branchName")]
    pub branch_name: Option<String>,
    #[serde(default, rename = "archivedAt")]
    pub archived_at: Option<String>,
    #[serde(default, rename = "archiveReason")]
    pub archive_reason: Option<String>,
    #[serde(default, rename = "mergedAt")]
    pub merged_at: Option<String>,
    #[serde(default = "default_manual_feature_base_branch", rename = "baseBranch")]
    pub base_branch: String,
    #[serde(default, rename = "projectIds")]
    pub project_ids: Vec<String>,
    #[serde(default, rename = "contextProjectIds")]
    pub context_project_ids: Vec<String>,
    #[serde(default, rename = "executionTargets")]
    pub execution_targets: Vec<WorkspaceTaskExecutionTargetDto>,
    #[serde(default, rename = "mergeWorkflow")]
    pub merge_workflow: Option<ManualFeatureMergeWorkflowDto>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

fn default_manual_feature_base_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGroupDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "isOpen")]
    pub is_open: bool,
    pub projects: Vec<ProjectDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGitFlowSettingsDto {
    #[serde(default = "default_project_git_base_branch", rename = "baseBranch")]
    pub base_branch: String,
    #[serde(default = "default_project_git_main_branch", rename = "mainBranch")]
    pub main_branch: String,
    #[serde(
        default = "default_project_git_plan_branch_template",
        rename = "planBranchTemplate"
    )]
    pub plan_branch_template: String,
    #[serde(
        default = "default_project_git_feature_branch_template",
        rename = "featureBranchTemplate"
    )]
    pub feature_branch_template: String,
    #[serde(
        default = "default_project_git_standalone_feature_branch_template",
        rename = "standaloneFeatureBranchTemplate"
    )]
    pub standalone_feature_branch_template: String,
    #[serde(
        default = "default_project_git_release_branch_template",
        rename = "releaseBranchTemplate"
    )]
    pub release_branch_template: String,
    #[serde(
        default = "default_project_git_hotfix_branch_template",
        rename = "hotfixBranchTemplate"
    )]
    pub hotfix_branch_template: String,
    #[serde(
        default = "default_project_git_bugfix_branch_template",
        rename = "bugfixBranchTemplate"
    )]
    pub bugfix_branch_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGitFlowDetectionDto {
    #[serde(rename = "repoDetected")]
    pub repo_detected: bool,
    pub branches: Vec<String>,
    #[serde(default, rename = "currentBranch")]
    pub current_branch: Option<String>,
    #[serde(default, rename = "suggestedMainBranch")]
    pub suggested_main_branch: Option<String>,
    #[serde(default, rename = "suggestedBaseBranch")]
    pub suggested_base_branch: Option<String>,
    #[serde(default, rename = "suggestedCommitBranch")]
    pub suggested_commit_branch: Option<String>,
    #[serde(rename = "requiresConfirmation")]
    pub requires_confirmation: bool,
    #[serde(
        default = "default_project_git_detection_setup_state",
        rename = "setupState"
    )]
    pub setup_state: String,
    #[serde(default, rename = "hasInitialCommit")]
    pub has_initial_commit: bool,
    #[serde(default, rename = "resolvedRepoRootPath")]
    pub resolved_repo_root_path: Option<String>,
    #[serde(
        default = "default_project_git_detection_repo_resolution",
        rename = "repoResolution"
    )]
    pub repo_resolution: String,
    #[serde(default, rename = "initialCommitPreviewPaths")]
    pub initial_commit_preview_paths: Vec<String>,
    #[serde(default, rename = "initialCommitPreviewCount")]
    pub initial_commit_preview_count: usize,
    #[serde(default, rename = "initialCommitRiskFlags")]
    pub initial_commit_risk_flags: Vec<String>,
    #[serde(default, rename = "recommendedActionSequence")]
    pub recommended_action_sequence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGitSetupCommitResultDto {
    pub project: ProjectDto,
    pub detection: ProjectGitFlowDetectionDto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectAccessMigrationItemDto {
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectAccessMigrationSummaryDto {
    #[serde(default)]
    pub plans: ProjectAccessMigrationItemDto,
    #[serde(default, rename = "manualFeatures")]
    pub manual_features: ProjectAccessMigrationItemDto,
    #[serde(default)]
    pub tasks: ProjectAccessMigrationItemDto,
    #[serde(default)]
    pub worktrees: ProjectAccessMigrationItemDto,
    #[serde(default, rename = "predictedBranches")]
    pub predicted_branches: ProjectAccessMigrationItemDto,
    #[serde(default, rename = "planNodes")]
    pub plan_nodes: ProjectAccessMigrationItemDto,
    #[serde(default, rename = "executionTargets")]
    pub execution_targets: ProjectAccessMigrationItemDto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectAccessChangePreviewDto {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "targetReadOnly")]
    pub target_read_only: bool,
    #[serde(rename = "canApply")]
    pub can_apply: bool,
    #[serde(rename = "requiresConfirmation")]
    pub requires_confirmation: bool,
    #[serde(default, rename = "blockingReasons")]
    pub blocking_reasons: Vec<String>,
    #[serde(default, rename = "migrationSummary")]
    pub migration_summary: ProjectAccessMigrationSummaryDto,
}

impl Default for ProjectGitFlowSettingsDto {
    fn default() -> Self {
        Self {
            base_branch: default_project_git_base_branch(),
            main_branch: default_project_git_main_branch(),
            plan_branch_template: default_project_git_plan_branch_template(),
            feature_branch_template: default_project_git_feature_branch_template(),
            standalone_feature_branch_template:
                default_project_git_standalone_feature_branch_template(),
            release_branch_template: default_project_git_release_branch_template(),
            hotfix_branch_template: default_project_git_hotfix_branch_template(),
            bugfix_branch_template: default_project_git_bugfix_branch_template(),
        }
    }
}

fn default_project_git_base_branch() -> String {
    "main".to_string()
}

fn default_project_git_detection_repo_resolution() -> String {
    "none".to_string()
}

fn default_project_git_main_branch() -> String {
    "main".to_string()
}

fn default_project_git_plan_branch_template() -> String {
    "plan/{planSlug}".to_string()
}

fn default_project_git_feature_branch_template() -> String {
    "feature/{planSlug}/{featureSlug}".to_string()
}

fn default_project_git_standalone_feature_branch_template() -> String {
    "feature/{featureSlug}".to_string()
}

fn default_project_git_release_branch_template() -> String {
    "release/{releaseSlug}".to_string()
}

fn default_project_git_hotfix_branch_template() -> String {
    "hotfix/{hotfixSlug}".to_string()
}

fn default_project_git_bugfix_branch_template() -> String {
    "bugfix/{bugfixSlug}".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    #[serde(default, rename = "mountName")]
    pub mount_name: String,
    pub path: String,
    pub created_at: String,
    pub status: String,
    #[serde(default, rename = "gitFlowSettings")]
    pub git_flow_settings: ProjectGitFlowSettingsDto,
    #[serde(default, rename = "userReadOnly")]
    pub user_read_only: bool,
    #[serde(default = "default_project_git_setup_state", rename = "gitSetupState")]
    pub git_setup_state: String,
    #[serde(default, rename = "isReadOnly")]
    pub is_read_only: bool,
    #[serde(default, rename = "readOnlyReason")]
    pub read_only_reason: Option<String>,
    pub metadata: ProjectMetadataDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetadataDto {
    pub description: String,
    pub tags: Vec<String>,
    pub team_members: Vec<String>,
    pub api_contracts: Vec<Value>,
    pub dependencies: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDto {
    pub id: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub project_ids: Vec<String>,
    #[serde(default, rename = "contextProjectIds")]
    pub context_project_ids: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<Value>,
    #[serde(default)]
    pub predicted_git_trees: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanNodeDto {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub node_type: String,
    pub status: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default, rename = "assignedBranch")]
    pub assigned_branch: Option<String>,
    #[serde(default, rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(default, rename = "estimatedTime")]
    pub estimated_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictedBranchDto {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, rename = "parentBranch")]
    pub parent_branch: Option<String>,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(default, rename = "taskIds")]
    pub task_ids: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: String,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub path: Option<String>,
    pub git_flow_settings: Option<ProjectGitFlowSettingsDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportGitRepoRequest {
    pub git_url: String,
    pub project_name: String,
    pub branch: String,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub path: Option<String>,
    pub git_flow_settings: Option<ProjectGitFlowSettingsDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectRegistryRepairReportDto {
    pub duplicate_paths_removed: usize,
    pub empty_groups_removed: usize,
    pub removed_synthetic_groups: usize,
    pub removed_synthetic_projects: usize,
    pub mount_names_assigned: usize,
    pub removed_group_ids: Vec<String>,
    pub removed_project_ids: Vec<String>,
    pub current_plan_project_ids_removed: usize,
    pub current_plan_tasks_removed: usize,
    pub current_plan_task_targets_removed: usize,
    pub manual_features_removed: usize,
    pub manual_feature_targets_removed: usize,
    pub plan_nodes_removed: usize,
    pub predicted_branches_removed: usize,
    pub git_flow_settings_auto_updated: usize,
}

impl ProjectRegistryRepairReportDto {
    pub fn has_repairs(&self) -> bool {
        self.duplicate_paths_removed > 0
            || self.empty_groups_removed > 0
            || self.removed_synthetic_groups > 0
            || self.removed_synthetic_projects > 0
            || self.mount_names_assigned > 0
            || !self.removed_group_ids.is_empty()
            || !self.removed_project_ids.is_empty()
            || self.current_plan_project_ids_removed > 0
            || self.current_plan_tasks_removed > 0
            || self.current_plan_task_targets_removed > 0
            || self.manual_features_removed > 0
            || self.manual_feature_targets_removed > 0
            || self.plan_nodes_removed > 0
            || self.predicted_branches_removed > 0
            || self.git_flow_settings_auto_updated > 0
    }
}

fn default_project_git_setup_state() -> String {
    "ready".to_string()
}

fn default_project_git_detection_setup_state() -> String {
    "not_git".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRegistryDiagnosticsDto {
    #[serde(rename = "rawProjectGroups")]
    pub raw_project_groups: Vec<ProjectGroupDto>,
    #[serde(rename = "sanitizedProjectGroups")]
    pub sanitized_project_groups: Vec<ProjectGroupDto>,
    #[serde(rename = "rawGroupCount")]
    pub raw_group_count: usize,
    #[serde(rename = "rawProjectCount")]
    pub raw_project_count: usize,
    #[serde(rename = "sanitizedGroupCount")]
    pub sanitized_group_count: usize,
    #[serde(rename = "sanitizedProjectCount")]
    pub sanitized_project_count: usize,
    #[serde(rename = "repairReport")]
    pub repair_report: ProjectRegistryRepairReportDto,
}
