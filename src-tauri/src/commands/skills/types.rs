use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProjectRootDto {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceDto {
    pub kind: String,
    pub namespace: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub root_path: String,
    pub skill_root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceDto {
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLocationDto {
    pub kind: String,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiagnosticDto {
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifestDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub root_path: String,
    pub skill_file_path: String,
    pub location: SkillLocationDto,
    pub source: SkillSourceDto,
    pub resources: Vec<SkillResourceDto>,
    pub scripts: Vec<SkillResourceDto>,
    pub diagnostics: Vec<SkillDiagnosticDto>,
    pub spec_compliant: bool,
    pub shadowed_by_skill_id: Option<String>,
    pub content_hash: String,
    pub validation_errors: Vec<String>,
    pub is_valid: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListResponse {
    pub skills: Vec<SkillManifestDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetailResponse {
    pub skill: SkillManifestDto,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceReadResponse {
    pub skill_id: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScriptRunResponse {
    pub skill_id: String,
    pub script_path: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}
