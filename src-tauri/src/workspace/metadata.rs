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
        }
    }
}

const fn default_version() -> u32 {
    2
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
    #[serde(default, rename = "executionTargets")]
    pub execution_targets: Vec<WorkspaceTaskExecutionTargetDto>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

fn default_manual_feature_base_branch() -> String {
    "develop".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGroupDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "isOpen")]
    pub is_open: bool,
    pub projects: Vec<ProjectDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGitFlowSettingsDto {
    #[serde(default = "default_project_git_base_branch", rename = "baseBranch")]
    pub base_branch: String,
    #[serde(default = "default_project_git_plan_branch_template", rename = "planBranchTemplate")]
    pub plan_branch_template: String,
    #[serde(
        default = "default_project_git_feature_branch_template",
        rename = "featureBranchTemplate"
    )]
    pub feature_branch_template: String,
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

impl Default for ProjectGitFlowSettingsDto {
    fn default() -> Self {
        Self {
            base_branch: default_project_git_base_branch(),
            plan_branch_template: default_project_git_plan_branch_template(),
            feature_branch_template: default_project_git_feature_branch_template(),
            release_branch_template: default_project_git_release_branch_template(),
            hotfix_branch_template: default_project_git_hotfix_branch_template(),
            bugfix_branch_template: default_project_git_bugfix_branch_template(),
        }
    }
}

fn default_project_git_base_branch() -> String {
    "develop".to_string()
}

fn default_project_git_plan_branch_template() -> String {
    "plan/{planSlug}".to_string()
}

fn default_project_git_feature_branch_template() -> String {
    "feature/{planSlug}/{featureSlug}".to_string()
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
    }
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
