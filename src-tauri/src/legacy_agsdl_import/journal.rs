//! Read-only view of the writes in architectPlanMutationPersistence.ts.
//! Journal paths are selectors only. Discovery must independently visit the owner.
use super::*;
use std::path::{Path, PathBuf};

pub(super) const KEY: &str = "pendingArchitectPlanReplicaMutations:v1";

#[derive(Default, Clone)]
pub(super) struct Changes {
    pub files: BTreeMap<PathBuf, Option<String>>,
    /// The old recovery commits files_applied/committing entries without replaying files.
    pub applied: BTreeMap<PathBuf, Option<Value>>,
    pub artifacts: BTreeMap<PathBuf, ArtifactCheck>,
    pub removed_dirs: BTreeSet<PathBuf>,
}

#[derive(Default)]
pub(super) struct Journal {
    pub disk: BTreeMap<(PathBuf, bool), Changes>,
    pub owners: BTreeSet<PathBuf>,
    pub local: Changes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    workspace_key: String,
    branch_name: String,
    plan_id: String,
    operation: String,
    phase: String,
    payload: Value,
    goal_artifact_scope: Option<GoalScope>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    commit_message: String,
    #[serde(default)]
    requires_pilot_authorization: bool,
    targets: Vec<Target>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    scope: Scope,
    action: String,
    plan: Value,
    index: Value,
    chat_messages: Option<Vec<Value>>,
    #[serde(default)]
    replace_plan_directory: bool,
    targeted_task_id: Option<String>,
    execution_modes_by_project_id: Option<BTreeMap<String, String>>,
    extra_files: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    scope_key: String,
    source: String,
    workspace_path: Option<PathBuf>,
    repo_path: Option<PathBuf>,
    workspace_scope: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalScope {
    goal_id: String,
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactFile {
    workspace_path: PathBuf,
    workspace_scope: String,
    path: String,
    before: Value,
    after: String,
}
#[derive(Clone)]
pub(super) struct ArtifactCheck {
    pub before: Option<String>,
    pub after: String,
    pub committed: bool,
}

fn valid_artifact_path(relative: &str, goal: bool) -> bool {
    let name = |s: &str| {
        !matches!(s, "" | "." | "..")
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let file = |s: &str| {
        s.rsplit_once('.')
            .is_some_and(|(base, ext)| name(base) && matches!(ext, "md" | "txt" | "json"))
    };
    let parts = relative.split('/').collect::<Vec<_>>();
    match (goal, parts.as_slice()) {
        (true, [s]) => file(s),
        (false, ["manifest.json"] | ["artifacts", "index.json"]) => true,
        (false, ["artifacts", "tasks", task, s]) => name(task) && file(s),
        _ => false,
    }
}

impl Journal {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let mut journal = Self::default();
        let entries: Vec<Entry> = serde_json::from_str(raw.unwrap_or("[]"))
            .map_err(|e| format!("Unreadable or unsupported replica recovery intent: {e}"))?;
        let mut ids = BTreeSet::new();
        for entry in entries {
            entry.project(&mut journal, &mut ids)?;
        }
        Ok(journal)
    }
}

impl Entry {
    fn project(self, journal: &mut Journal, ids: &mut BTreeSet<String>) -> Result<(), String> {
        let branch = &self.branch_name;
        let id = &self.plan_id;
        if !super::discovery::valid_branch(branch)
            || !super::discovery::canonical_plan_id(id)
            || !ids.insert(self.id.clone())
            || self.id.is_empty()
            || self.created_at.is_empty()
            || self.updated_at.is_empty()
            || !matches!(
                self.operation.as_str(),
                "artifacts"
                    | "create"
                    | "update"
                    | "archive"
                    | "restore"
                    | "delete"
                    | "repair"
                    | "bind"
                    | "activate"
                    | "chat"
                    | "auto_heal"
                    | "orphan_cleanup"
            )
        {
            return Err(format!("Invalid or restricted recovery intent {}", self.id));
        }
        let replay = match self.phase.as_str() {
            "prepared" | "applying" => true,
            "files_applied" | "committing" => false,
            _ => return Err(format!("Unknown recovery phase in {}", self.id)),
        };
        let mut owners = BTreeSet::new();
        for owner in self.workspace_key.split('|') {
            if owner != "local:local" {
                let path = PathBuf::from(owner);
                if !path.is_absolute() {
                    return Err("Invalid recovery workspace".into());
                }
                journal.owners.insert(path.clone());
                owners.insert(path);
            }
        }
        if self.operation == "artifacts" {
            return self.project_artifacts(journal, &owners, replay);
        }
        if self.goal_artifact_scope.is_some() || self.payload.get("files").is_some() {
            return Err("Ambiguous artifact journal envelope".into());
        }
        let payload: Payload = serde_json::from_value(self.payload).map_err(|e| e.to_string())?;
        if payload.commit_message.trim().is_empty()
            || payload.targets.is_empty()
            || payload.requires_pilot_authorization
        {
            return Err(format!(
                "Invalid or restricted replica mutation {}",
                self.id
            ));
        }
        let mut seen = BTreeSet::new();
        for target in payload.targets {
            let scope = &target.scope;
            if !seen.insert(scope.scope_key.clone()) || target.targeted_task_id.is_some() {
                return Err("Ambiguous or restricted replica mutation".into());
            }
            let local = scope.source == "local";
            let changes = if local
                && scope.scope_key == "local"
                && scope.workspace_path.is_none()
                && scope.repo_path.is_none()
            {
                &mut journal.local
            } else {
                let path = scope
                    .workspace_path
                    .as_ref()
                    .ok_or("Missing recovery workspace")?;
                if !matches!(scope.source.as_str(), "workspace" | "project")
                    || !owners.contains(path)
                    || scope
                        .repo_path
                        .as_ref()
                        .is_some_and(|repo| !owners.contains(repo))
                    || scope.scope_key != format!("repo:{}", path.display())
                {
                    return Err("Replica scope does not belong to its workspace".into());
                }
                let direct = match scope.workspace_scope.as_deref() {
                    None | Some("metadata") => false,
                    Some("direct") => true,
                    _ => return Err("Unknown replica workspace scope".into()),
                };
                journal.disk.entry((path.clone(), direct)).or_default()
            };
            target.project(changes, branch, id, local, replay)?;
        }
        Ok(())
    }
    fn project_artifacts(
        self,
        journal: &mut Journal,
        owners: &BTreeSet<PathBuf>,
        replay: bool,
    ) -> Result<(), String> {
        let branch = &self.branch_name;
        let id = &self.plan_id;
        let prefix = if let Some(goal) = self.goal_artifact_scope.as_ref() {
            if goal.goal_id != *id || !super::discovery::canonical_plan_id(&goal.conversation_id) {
                return Err("Invalid goal artifact owner".into());
            }
            format!(
                "branches/{branch}/goals/{}/{id}/artifacts/",
                goal.conversation_id
            )
        } else {
            format!("branches/{branch}/plans/{id}/")
        };
        let files: Vec<ArtifactFile> =
            serde_json::from_value(self.payload["files"].clone()).map_err(|e| e.to_string())?;
        if files.is_empty() {
            return Err("Empty artifact journal".into());
        }
        for file in files {
            let relative = file
                .path
                .strip_prefix(&prefix)
                .ok_or("Invalid artifact owner")?;
            if !valid_artifact_path(relative, self.goal_artifact_scope.is_some())
                || !owners.contains(&file.workspace_path)
            {
                return Err("Artifact path is outside its owner".into());
            }
            let direct = match file.workspace_scope.as_str() {
                "direct" => true,
                "metadata" => false,
                _ => return Err("Invalid artifact scope".into()),
            };
            let changes = journal
                .disk
                .entry((file.workspace_path, direct))
                .or_default();
            let path = PathBuf::from(&file.path);
            let before: Option<String> =
                serde_json::from_value(file.before).map_err(|e| e.to_string())?;
            if relative == "manifest.json" && replay {
                changes.files.insert(path.clone(), before.clone());
            }
            if changes
                .artifacts
                .insert(
                    path,
                    ArtifactCheck {
                        before,
                        after: file.after,
                        committed: !replay,
                    },
                )
                .is_some()
            {
                return Err("Overlapping artifact recovery entries".into());
            }
        }
        Ok(())
    }
}
impl Target {
    fn project(
        self,
        changes: &mut Changes,
        branch: &str,
        id: &str,
        local: bool,
        replay: bool,
    ) -> Result<(), String> {
        if self
            .execution_modes_by_project_id
            .as_ref()
            .is_some_and(|modes| {
                modes
                    .iter()
                    .any(|(id, mode)| id.is_empty() || !matches!(mode.as_str(), "git" | "direct"))
            })
            || self.extra_files.as_ref().is_some_and(|files| {
                files
                    .keys()
                    .any(|p| !p.starts_with("artifacts/") || p.contains("..") || p.contains('\\'))
            })
        {
            return Err("Invalid recovery target".into());
        }
        let summaries = self.index["plans"]
            .as_array()
            .ok_or("Invalid recovery index")?;
        if !matches!(self.index["version"].as_u64(), Some(2 | 3))
            || !self.index["reservedPlanSlugs"].is_array()
            || !summaries
                .iter()
                .all(|s| s["id"].is_string() && s["targetBranch"] == branch)
        {
            return Err("Invalid plan summaries in recovery index".into());
        }
        let directory = Path::new("branches").join(branch).join("plans");
        let plan_dir = directory.join(id);
        let slot = |disk: PathBuf, key: String| if local { PathBuf::from(key) } else { disk };
        let plan = slot(
            plan_dir.join("plan.json"),
            format!("macro_architect_plan:{branch}:{id}"),
        );
        let chat = slot(
            plan_dir.join("chat.jsonl"),
            format!("macro_architect_plan_chat:{branch}:{id}"),
        );
        let manifest = plan_dir.join("manifest.json");
        let mut matching = summaries.iter().filter(|s| s["id"] == id);
        let summary = matching.next();
        if matching.next().is_some()
            || (self.action == "upsert"
                && summary.is_some_and(|s| s["hasAgsdl"] == true)
                && !self.plan["agsdl"]["source"].is_string())
        {
            return Err("Missing or ambiguous journaled plan".into());
        }
        if let Some(messages) = &self.chat_messages {
            if !messages.iter().all(|m| {
                m["id"].is_string()
                    && matches!(m["role"].as_str(), Some("assistant" | "user"))
                    && m["content"].is_string()
                    && m["createdAt"].is_string()
            }) {
                return Err("Invalid recovery chat".into());
            }
        }
        let indexed = summary.is_some();
        let index = slot(
            directory.join("index.json"),
            format!("macro_architect_plan_index:{branch}"),
        );
        if !replay {
            changes
                .applied
                .insert(index.clone(), Some(self.index.clone()));
            if self.action != "index" {
                changes.applied.insert(
                    plan.clone(),
                    (!self.plan.is_null()).then(|| self.plan.clone()),
                );
            }
        }
        match self.action.as_str() {
            "upsert" if indexed && self.plan["id"] == id && self.plan["targetBranch"] == branch => {
                if replay {
                    changes.files.insert(plan, Some(self.plan.to_string()));
                    if !local {
                        changes.files.insert(manifest, None);
                    }
                    if let Some(messages) = self.chat_messages {
                        changes.files.insert(
                            chat,
                            Some(
                                messages
                                    .iter()
                                    .map(Value::to_string)
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            ),
                        );
                    } else if self.replace_plan_directory {
                        changes.files.insert(chat, None);
                    }
                    changes.removed_dirs.remove(&plan_dir);
                }
            }
            "remove" if self.plan.is_null() && !indexed => {
                if replay {
                    changes.files.insert(plan, None);
                    changes.files.insert(chat, None);
                    if !local {
                        changes.removed_dirs.insert(plan_dir);
                    }
                }
            }
            "index" if self.plan.is_null() => {}
            _ => return Err("Recovery action does not match plan and index".into()),
        }
        if replay {
            changes.files.insert(index, Some(self.index.to_string()));
        }
        Ok(())
    }
}

// Plan writes may add derived fields. Compare the fields used by the library,
// while indexes must match the committed snapshot.
pub(super) fn verify_applied(
    path: &Path,
    actual: Option<&str>,
    expected: &Option<Value>,
) -> Result<(), String> {
    let actual = actual
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|e| e.to_string())?;
    let matches = match (&actual, expected) {
        (Some(actual), Some(expected)) if expected.get("plans").is_none() => [
            "id",
            "targetBranch",
            "agsdl",
            "status",
            "title",
            "label",
            "description",
            "icon",
            "archivedAt",
            "archivedFromStatus",
            "createdAt",
            "projectId",
            "projectIds",
            "conversationId",
        ]
        .iter()
        .all(|key| actual[*key] == expected[*key]),
        _ => actual == *expected,
    };
    if matches {
        Ok(())
    } else {
        Err(format!(
            "Applied replica mutation disagrees with {}",
            path.display()
        ))
    }
}
