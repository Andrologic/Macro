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
}

impl Default for WorkspaceState {
	fn default() -> Self {
		Self {
			version: default_version(),
			project_groups: Vec::new(),
			current_plan: None,
			plan_nodes: Vec::new(),
			predicted_branches: Vec::new(),
		}
	}
}

const fn default_version() -> u32 {
	1
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
pub struct ProjectGroupDto {
	pub id: String,
	pub name: String,
	#[serde(rename = "isOpen")]
	pub is_open: bool,
	pub projects: Vec<ProjectDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDto {
	pub id: String,
	pub name: String,
	pub path: String,
	pub created_at: String,
	pub status: String,
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
	pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportGitRepoRequest {
	pub git_url: String,
	pub project_name: String,
	pub branch: String,
	pub group_id: Option<String>,
	pub path: Option<String>,
}
