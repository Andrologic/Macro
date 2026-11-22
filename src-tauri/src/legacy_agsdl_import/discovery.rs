use super::*;
use crate::{
    git::{MACRO_BRANCH_NAME, MACRO_WORKTREE_DIR_NAME, MACRO_WORKTREE_NAME},
    workspace::{
        architect::{sanitize_id, stored_plan_branch_matches},
        resolve_project_path,
    },
};
use chrono::DateTime;
use git2::{ErrorCode, ObjectType, Repository, RepositoryOpenFlags, Tree};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const INDEX: &str = "macro_architect_plan_index:";
const PLAN: &str = "macro_architect_plan:";
const CHAT: &str = "macro_architect_plan_chat:";

type ReadResult<T> = Result<T, String>;

fn optional<T>(result: std::io::Result<T>) -> ReadResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
    Unsupported,
}

fn disk_kind(path: &Path) -> ReadResult<Option<EntryKind>> {
    Ok(optional(fs::symlink_metadata(path))?.map(|metadata| {
        let kind = metadata.file_type();
        if kind.is_dir() {
            EntryKind::Directory
        } else if kind.is_file() {
            EntryKind::File
        } else {
            EntryKind::Unsupported
        }
    }))
}

enum Root<'a> {
    Directory(&'a Path),
    Commit(&'a Repository, Tree<'a>),
}

impl Root<'_> {
    fn children(&self, path: &Path) -> ReadResult<Vec<(String, EntryKind)>> {
        match self {
            Self::Directory(root) => {
                let path = root.join(path);
                fs::read_dir(&path)
                    .map_err(|error| error.to_string())?
                    .map(|entry| {
                        let entry = entry.map_err(|error| error.to_string())?;
                        let name = entry
                            .file_name()
                            .into_string()
                            .map_err(|_| "Directory entry is not a Unicode path".to_string())?;
                        let kind = disk_kind(&entry.path())?
                            .ok_or_else(|| format!("Directory entry disappeared: {name}"))?;
                        Ok((name, kind))
                    })
                    .collect()
            }
            Self::Commit(repo, tree) => {
                let subtree;
                let selected = if path.as_os_str().is_empty() {
                    tree
                } else {
                    let Some(entry) = tree_entry(tree, path)? else {
                        return Ok(Vec::new());
                    };
                    subtree = repo.find_tree(entry.id()).map_err(|e| e.to_string())?;
                    &subtree
                };
                selected
                    .iter()
                    .map(|entry| {
                        let name = entry.name().map_err(|error| error.to_string())?;
                        let kind = match (entry.kind(), entry.filemode()) {
                            (Some(ObjectType::Tree), _) => EntryKind::Directory,
                            (Some(ObjectType::Blob), 0o100644 | 0o100755) => EntryKind::File,
                            _ => EntryKind::Unsupported,
                        };
                        Ok((name.to_owned(), kind))
                    })
                    .collect()
            }
        }
    }

    fn read(&self, path: &Path) -> ReadResult<Option<String>> {
        match self {
            Self::Directory(root) => {
                let path = root.join(path);
                match disk_kind(&path)? {
                    None => Ok(None),
                    Some(EntryKind::File) => optional(fs::read_to_string(&path)),
                    _ => Err("Expected a regular file".into()),
                }
            }
            Self::Commit(repo, tree) => {
                let Some(entry) = tree_entry(tree, path)? else {
                    return Ok(None);
                };
                if !matches!(entry.filemode(), 0o100644 | 0o100755) {
                    return Err("Expected a regular Git blob".into());
                }
                let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
                std::str::from_utf8(blob.content())
                    .map(|text| Some(text.to_owned()))
                    .map_err(|error| error.to_string())
            }
        }
    }
}

fn tree_entry(tree: &Tree<'_>, path: &Path) -> ReadResult<Option<git2::TreeEntry<'static>>> {
    match tree.get_path(path) {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Default, Deserialize)]
struct Registry {
    #[serde(default, rename = "version")]
    _version: u32,
    // Historical registries can have shorter project records. Validate the remaining
    // fields against the same workspace schema as the writer.
    #[serde(flatten)]
    _workspace: crate::workspace::metadata::WorkspaceState,
    #[serde(default, rename = "workspaceRevision")]
    revision: u64,
    #[serde(default, alias = "standalone_projects", rename = "standaloneProjects")]
    standalone: Vec<RegistryProject>,
    #[serde(default, alias = "projectGroups")]
    project_groups: Vec<RegistryGroup>,
}

#[derive(Deserialize)]
struct RegistryGroup {
    projects: Vec<RegistryProject>,
}

#[derive(Deserialize)]
struct RegistryProject {
    id: String,
    path: String,
    #[serde(default)]
    name: String,
}

enum RegistryError {
    Invalid(PathBuf, String),
    Unavailable(PathBuf, String),
}

#[derive(Clone)]
struct Scope {
    kind: &'static str,
    location: String,
    project_ids: Vec<String>,
}

impl Scope {
    fn path(&self, path: &Path) -> String {
        format!("{}/{}", self.location, path.display())
    }
}

#[derive(Default)]
struct Recency {
    revision: Option<u64>,
    updated_at: Option<String>,
}

impl Recency {
    fn read(record: &Value) -> Self {
        Self {
            revision: record["revision"].as_u64(),
            updated_at: field(record, "updatedAt").or_else(|| field(record, "deletedAt")),
        }
    }

    fn strictly_newer_than(&self, deletion: &Self) -> bool {
        let date = |at: Option<&str>| at.and_then(|value| DateTime::parse_from_rfc3339(value).ok());
        match (
            date(self.updated_at.as_deref()),
            date(deletion.updated_at.as_deref()),
        ) {
            (Some(live), Some(deleted)) if live != deleted => live > deleted,
            _ => {
                matches!((self.revision, deletion.revision), (Some(live), Some(deleted)) if live > deleted)
            }
        }
    }
}

struct Candidate {
    blueprint: LegacyBlueprint,
    recency: Recency,
}

#[derive(Default)]
struct Scan {
    issues: Vec<LegacyImportIssue>,
    projects: BTreeMap<PathBuf, BTreeSet<String>>,
    project_names: BTreeMap<String, String>,
    candidates: Vec<Candidate>,
    deletions: BTreeMap<(String, String), Vec<Recency>>,
}

fn is_deleted(record: &Value) -> bool {
    record["status"] == "deleted"
        || record["deletion"]["deletedAt"].is_string()
        || record["deletedAt"].is_string()
}

fn field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

fn branch_matches(record: &Value, branch: &str) -> bool {
    let stored = &record["targetBranch"];
    stored.is_null()
        || stored
            .as_str()
            .is_some_and(|value| stored_plan_branch_matches(value, branch))
}

fn valid_branch(branch: &str) -> bool {
    !branch.starts_with("refs/heads/")
        && git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
}

fn canonical_plan_id(slot: &str) -> bool {
    !matches!(slot, "" | "." | "..")
        && !slot.starts_with('-')
        && !slot.ends_with('-')
        && slot
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn id_matches(id: &str, slot: &str) -> bool {
    // The frontend writer preserves repeated hyphens in canonical IDs.
    canonical_plan_id(slot) && (id == slot || (!canonical_plan_id(id) && sanitize_id(id) == slot))
}

fn local_id_matches(id: &str, slot: &str) -> bool {
    // Match the web writer: replace each run of invalid characters, retaining literal hyphens.
    let lower = id.trim().to_lowercase();
    let normalized = lower
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '_' | '-'))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    canonical_plan_id(slot) && normalized.trim_matches('-') == slot
}

impl Scan {
    fn result<T>(&mut self, location: impl Into<String>, result: ReadResult<T>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(message) => {
                self.issues.push(LegacyImportIssue {
                    location: location.into(),
                    message,
                });
                None
            }
        }
    }

    fn json(&mut self, location: &str, text: &str) -> Option<Value> {
        self.result(
            location,
            serde_json::from_str::<Value>(text)
                .map_err(|err| err.to_string())
                .and_then(|value| {
                    value
                        .is_object()
                        .then_some(value)
                        .ok_or("Expected a JSON object".into())
                }),
        )
    }

    fn read_json(
        &mut self,
        root: &Root<'_>,
        scope: &Scope,
        path: &Path,
    ) -> Result<Option<Value>, ()> {
        let location = scope.path(path);
        let text = self.result(&location, root.read(path)).ok_or(())?;
        text.map(|value| self.json(&location, &value).ok_or(()))
            .transpose()
    }

    fn read_registry(
        root: &Root<'_>,
        prefix: &Path,
        nested: bool,
    ) -> Result<Option<Registry>, RegistryError> {
        use RegistryError::{Invalid, Unavailable};
        if let Root::Directory(dir) = root {
            match disk_kind(&dir.join(prefix))
                .map_err(|error| Unavailable(prefix.to_owned(), error))?
            {
                Some(EntryKind::Directory) => {}
                None => return Ok(None),
                _ => {
                    return Err(Unavailable(
                        prefix.to_owned(),
                        "Expected a workspace directory".into(),
                    ))
                }
            }
        }
        let primary = prefix.join("workspace.json");
        let backup = prefix.join("workspace.json.bak");
        let read = |path: &Path| {
            root.read(path)
                .map_err(|error| Unavailable(path.to_owned(), error))?
                .map(|text| {
                    if !text.trim_start().starts_with('{') {
                        return Err("Expected a workspace registry object".into());
                    }
                    let registry =
                        serde_json::from_str::<Registry>(&text).map_err(|e| e.to_string())?;
                    let complete =
                        serde_json::from_str::<crate::workspace::metadata::WorkspaceState>(&text)
                            .is_ok();
                    Ok((registry, complete))
                })
                .transpose()
                .map_err(|error| Invalid(path.to_owned(), error))
        };
        let registry = read(&primary);
        if let Err(error @ Unavailable(..)) = registry {
            return Err(error);
        }
        if let Root::Directory(dir) = root {
            // Match the writer's revision, modification time and name ordering.
            let mut candidates = Vec::new();
            for (name, kind) in root
                .children(prefix)
                .map_err(|error| Unavailable(prefix.to_owned(), error))?
            {
                if kind != EntryKind::File || !name.starts_with(".workspace.json.macro-tmp-") {
                    continue;
                }
                let path = prefix.join(&name);
                let text = root
                    .read(&path)
                    .map_err(|error| Unavailable(path.clone(), error))?
                    .ok_or_else(|| {
                        Unavailable(path.clone(), "Temporary registry disappeared".to_string())
                    })?;
                // Only complete snapshots produced by the workspace writer can supersede the primary.
                let Ok(state) =
                    serde_json::from_str::<crate::workspace::metadata::WorkspaceState>(&text)
                else {
                    continue;
                };
                let modified = fs::symlink_metadata(dir.join(&path))
                    .and_then(|metadata| metadata.modified())
                    .map_err(|error| Unavailable(path, error.to_string()))?;
                let project = |p: crate::workspace::metadata::ProjectDto| RegistryProject {
                    id: p.id,
                    name: p.name,
                    path: p.path,
                };
                let state = Registry {
                    _version: state.version,
                    _workspace: Default::default(),
                    revision: state.workspace_revision,
                    standalone: state.standalone_projects.into_iter().map(project).collect(),
                    project_groups: state
                        .project_groups
                        .into_iter()
                        .map(|group| RegistryGroup {
                            projects: group.projects.into_iter().map(project).collect(),
                        })
                        .collect(),
                };
                candidates.push((state, modified, name));
            }
            let temporary = candidates.into_iter().max_by(|left, right| {
                (&left.0.revision, &left.1, &left.2).cmp(&(&right.0.revision, &right.1, &right.2))
            });
            if let Some((state, _, _)) = temporary {
                if !matches!(&registry, Ok(Some((primary, true))) if primary.revision >= state.revision)
                {
                    return Ok(Some(state));
                }
            }
        }
        let mut failure = None;
        match registry {
            Ok(Some((state, _))) => return Ok(Some(state)),
            Ok(None) if nested => match Self::read_registry(root, Path::new(".macro"), false) {
                Ok(Some(state)) => return Ok(Some(state)),
                Err(error @ Unavailable(..)) => return Err(error),
                Err(error) => failure = Some(error),
                Ok(None) => {}
            },
            Err(error) => failure = Some(error),
            Ok(None) => {}
        }
        match read(&backup) {
            Ok(Some((state, _))) => Ok(Some(state)),
            Ok(None) => failure.map_or(Ok(None), Err),
            Err(error @ Unavailable(..)) => Err(error),
            Err(error) => Err(failure.unwrap_or(error)),
        }
    }

    fn registry(&mut self, root: &Root<'_>, scope: &Scope, workspace: &Path, nested: bool) {
        let registry = match Self::read_registry(root, Path::new(""), nested) {
            Ok(registry) => registry,
            Err(RegistryError::Invalid(path, error) | RegistryError::Unavailable(path, error)) => {
                self.result(scope.path(&path), Err(error)).flatten()
            }
        };
        if let Some(registry) = registry {
            for project in registry.standalone.into_iter().chain(
                registry
                    .project_groups
                    .into_iter()
                    .flat_map(|group| group.projects),
            ) {
                if project.path.trim().is_empty() || project.id.starts_with("session-project-") {
                    continue;
                }
                self.projects
                    .entry(resolve_project_path(workspace, &project.path))
                    .or_default()
                    .insert(project.id.clone());
                if !project.name.trim().is_empty() {
                    self.project_names.entry(project.id).or_insert(project.name);
                }
            }
        }
    }

    fn index(
        &mut self,
        branch: &str,
        location: &str,
        index: Option<Value>,
    ) -> BTreeMap<String, Value> {
        let mut entries = BTreeMap::new();
        let Some(index) = index else { return entries };
        if !branch_matches(&index, branch) {
            self.result::<()>(location, Err("Index belongs to another branch".into()));
            return entries;
        }
        let Some(summaries) = self.result(
            location,
            index["plans"]
                .as_array()
                .ok_or("Invalid plans index".into()),
        ) else {
            return entries;
        };
        for summary in summaries {
            let Some(id) = self.result(
                location,
                field(summary, "id").ok_or("Missing plan ID in index".into()),
            ) else {
                continue;
            };
            if !branch_matches(summary, branch) {
                self.result::<()>(
                    location,
                    Err(format!("Indexed plan {id} belongs to another branch")),
                );
                continue;
            }
            self.observe_deletion(branch, &id, summary);
            entries.insert(id, summary.clone());
        }
        entries
    }

    fn observe_deletion(&mut self, branch: &str, id: &str, record: &Value) {
        if is_deleted(record) {
            let mut recency = Recency::read(record);
            if recency.updated_at.is_none() {
                recency.updated_at = field(&record["deletion"], "deletedAt");
            }
            self.deletions
                .entry((branch.to_owned(), id.to_owned()))
                .or_default()
                .push(recency);
        }
    }

    fn plan(
        &mut self,
        branch: &str,
        id: String,
        plan: &Value,
        summary: &Value,
        manifest: &Value,
        mut origin: LegacyOrigin,
    ) {
        self.observe_deletion(branch, &id, plan);
        if is_deleted(plan) || id.starts_with("builtin:") || plan["builtin"] == true {
            return;
        }
        let document = &plan["agsdl"];
        if document.is_null() {
            return;
        }
        let Some(source) = self.result(
            &origin.location,
            document["source"]
                .as_str()
                .ok_or("Missing AgSDL source".into()),
        ) else {
            return;
        };
        if source.trim().is_empty() {
            return;
        }
        #[derive(Deserialize)]
        struct Contract {
            contract: Option<String>,
        }
        // Ignore the rest of the source while reading the marker. Its numbers
        // can exceed the native JSON number range and the exact string survives.
        if !source.trim_start().starts_with('{') {
            self.result::<()>(
                &origin.location,
                Err("Expected a JSON AgSDL document".into()),
            );
            return;
        }
        let Some(marker) = self.result(
            &origin.location,
            serde_json::from_str::<Contract>(source).map_err(|e| e.to_string()),
        ) else {
            return;
        };
        if marker.contract.as_deref() != Some("agsdl-0.3.0") {
            return;
        }
        if self
            .result(
                &origin.location,
                document["annexes"]
                    .as_object()
                    .filter(|values| values.values().all(Value::is_string))
                    .ok_or("Invalid AgSDL annexes".into()),
            )
            .is_none()
        {
            return;
        }
        let mut metadata: BTreeMap<_, _> = [
            "title",
            "label",
            "description",
            "icon",
            "createdAt",
            "status",
            "archivedAt",
            "archivedFromStatus",
        ]
        .into_iter()
        .filter_map(|key| {
            plan.get(key)
                .or_else(|| summary.get(key))
                .filter(|v| !v.is_null())
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect();
        if let Some(conversation_id) = field(plan, "conversationId") {
            metadata.insert("conversationId".into(), Value::from(conversation_id));
        }
        if !metadata.contains_key("status") {
            if let Some(status) = manifest["status"].as_str() {
                metadata.insert("status".into(), Value::from(status));
            }
        }
        origin.project_ids.extend(
            [
                "projectId",
                "projectIds",
                "contextProjectIds",
                "expectedProjectIds",
            ]
            .into_iter()
            .flat_map(|key| ids(&plan[key]).into_iter().chain(ids(&manifest[key]))),
        );
        origin.project_ids.sort();
        origin.project_ids.dedup();
        origin.conversation_ids.extend(
            [plan, summary, &manifest["conversation"]]
                .into_iter()
                .filter_map(|record| field(record, "conversationId")),
        );
        let project_id =
            field(plan, "projectId").or_else(|| ids(&plan["projectIds"]).into_iter().next());
        let source_project_id = project_id.as_ref().map_or_else(
            || "legacy:library".to_owned(),
            |id| format!("legacy:project:{id}"),
        );
        let project_name = project_id
            .as_ref()
            .and_then(|id| self.project_names.get(id))
            .cloned()
            .or_else(|| {
                manifest["participants"]
                    .as_array()?
                    .iter()
                    .find(|p| p["projectId"].as_str() == project_id.as_deref())
                    .and_then(|p| field(p, "displayName"))
            })
            .unwrap_or_else(|| project_id.unwrap_or_else(|| "Macro Library".into()));
        let name = field(plan, "label")
            .or_else(|| field(&document["display"], "title"))
            .or_else(|| field(plan, "title"))
            .or_else(|| field(summary, "title"))
            .unwrap_or_else(|| id.clone());
        let recency = Recency {
            revision: plan["revision"]
                .as_u64()
                .or_else(|| manifest["revision"].as_u64()),
            updated_at: field(plan, "updatedAt").or_else(|| field(manifest, "updatedAt")),
        };
        origin.revision = recency.revision;
        origin.updated_at = recency.updated_at.clone();
        self.candidates.push(Candidate {
            blueprint: LegacyBlueprint {
                import_key: import_key(branch, &id, document, &metadata, &source_project_id),
                branch: branch.to_owned(),
                plan_id: id,
                source_project_id,
                project_name,
                name,
                document: document.clone(),
                metadata,
                origins: BTreeSet::from([origin]),
            },
            recency,
        });
    }

    fn branches(&mut self, root: &Root<'_>, scope: &Scope, prefix: &Path) {
        let branches = prefix.join("branches");
        if !self.contains_dir(root, scope, prefix, "branches") {
            return;
        }
        let mut pending = vec![branches.clone()];
        let mut record_dirs = BTreeSet::new();
        while let Some(path) = pending.pop() {
            let Some(entries) = self.result(scope.path(&path), root.children(&path)) else {
                continue;
            };
            for (name, kind) in entries {
                let child = path.join(&name);
                if kind == EntryKind::Unsupported {
                    self.result::<()>(
                        scope.path(&child),
                        Err("Unsupported entry in branch tree".into()),
                    );
                }
                if kind != EntryKind::Directory || record_dirs.contains(&child) {
                    continue;
                }
                if name == "plans" && path != branches {
                    let branch = path
                        .strip_prefix(&branches)
                        .expect("descendant")
                        .iter()
                        .map(|part| part.to_str().expect("validated directory entry"))
                        .collect::<Vec<_>>()
                        .join("/");
                    if valid_branch(&branch) {
                        self.plan_directory(root, scope, &branch, &child, &mut record_dirs);
                    } else {
                        self.result::<()>(scope.path(&child), Err("Invalid branch path".into()));
                    }
                }
                // A branch component can itself be named "plans". Skip known
                // records while continuing through that possible branch.
                pending.push(child);
            }
        }
    }

    fn contains_dir(&mut self, root: &Root<'_>, scope: &Scope, parent: &Path, name: &str) -> bool {
        match self
            .result(scope.path(parent), root.children(parent))
            .and_then(|entries| entries.into_iter().find(|(entry, _)| entry == name))
        {
            Some((_, EntryKind::Directory)) => true,
            Some(_) => {
                self.result::<()>(
                    scope.path(&parent.join(name)),
                    Err("Expected a metadata directory".into()),
                );
                false
            }
            None => false,
        }
    }

    fn plan_directory(
        &mut self,
        root: &Root<'_>,
        scope: &Scope,
        branch: &str,
        directory: &Path,
        record_dirs: &mut BTreeSet<PathBuf>,
    ) {
        let index_path = directory.join("index.json");
        let index = self.read_json(root, scope, &index_path).ok().flatten();
        let mut summaries = self.index(branch, &scope.path(&index_path), index);
        let Some(children) = self.result(scope.path(directory), root.children(directory)) else {
            return;
        };
        for (id, kind) in children {
            if kind == EntryKind::Unsupported {
                self.result::<()>(
                    scope.path(&directory.join(&id)),
                    Err("Unsupported entry in plans directory".into()),
                );
            }
            if kind != EntryKind::Directory {
                continue;
            }
            let plan_dir = directory.join(&id);
            let plan_path = plan_dir.join("plan.json");
            let manifest_path = plan_dir.join("manifest.json");
            let plan = self.read_json(root, scope, &plan_path);
            let manifest = self.read_json(root, scope, &manifest_path);
            if !matches!(plan, Ok(None)) || !matches!(manifest, Ok(None)) {
                record_dirs.insert(plan_dir.clone());
            }
            let (Ok(plan), Ok(manifest)) = (plan, manifest) else {
                continue;
            };
            let manifest = manifest.unwrap_or(Value::Null);
            let manifest_id = if manifest.is_null() {
                None
            } else {
                let Some(manifest_id) = self.record_id(
                    branch,
                    &id,
                    &manifest,
                    "planId",
                    &scope.path(&manifest_path),
                    id_matches,
                ) else {
                    continue;
                };
                Some(manifest_id)
            };
            let Some(plan) = plan else {
                if let Some(deleted_id) = manifest_id.as_deref().filter(|_| is_deleted(&manifest)) {
                    self.observe_deletion(branch, deleted_id, &manifest);
                    summaries.remove(deleted_id);
                } else if manifest.is_object() {
                    self.result::<()>(
                        scope.path(&plan_path),
                        Err("Manifest has no readable plan record".into()),
                    );
                }
                continue;
            };
            let location = scope.path(&plan_path);
            let Some(plan_id) = self.record_id(branch, &id, &plan, "id", &location, id_matches)
            else {
                continue;
            };
            let summary = summaries.remove(&plan_id).unwrap_or(Value::Null);
            if let Some(manifest_id) = manifest_id {
                if plan_id != manifest_id {
                    self.result::<()>(
                        scope.path(&manifest_path),
                        Err("Manifest belongs to another plan".into()),
                    );
                    continue;
                }
                self.observe_deletion(branch, &manifest_id, &manifest);
            }
            let first_new = self.candidates.len();
            self.plan(
                branch,
                plan_id,
                &plan,
                &summary,
                &manifest,
                LegacyOrigin {
                    scope: scope.kind,
                    location,
                    project_ids: scope.project_ids.clone(),
                    revision: None,
                    updated_at: None,
                    conversation_ids: BTreeSet::new(),
                    transcript: None,
                },
            );
            if self.candidates.len() > first_new {
                let chat_path = plan_dir.join("chat.jsonl");
                let transcript = self
                    .result(scope.path(&chat_path), root.read(&chat_path))
                    .flatten();
                let origins = &mut self.candidates[first_new].blueprint.origins;
                let mut origin = origins.pop_first().expect("new candidate has one origin");
                origin.transcript = transcript;
                origins.insert(origin);
            }
        }
        self.check_missing(&scope.path(&index_path), summaries);
    }

    fn record_id(
        &mut self,
        branch: &str,
        slot: &str,
        record: &Value,
        id_field: &str,
        location: &str,
        matches_slot: fn(&str, &str) -> bool,
    ) -> Option<String> {
        self.result(
            location,
            field(record, id_field)
                .filter(|id| matches_slot(id, slot) && branch_matches(record, branch))
                .ok_or("Stored plan identity does not match its branch and plan location".into()),
        )
    }

    fn check_missing(&mut self, location: &str, summaries: BTreeMap<String, Value>) {
        for (id, summary) in summaries {
            if !is_deleted(&summary) && summary["hasAgsdl"] != false && !id.starts_with("builtin:")
            {
                self.result::<()>(
                    location,
                    Err(format!("Plan {id} is indexed but has no readable record")),
                );
            }
        }
    }

    fn local(&mut self, local: &LegacyLocalStorage) {
        let entries = match local {
            LegacyLocalStorage::Snapshot(entries) => entries,
            LegacyLocalStorage::Unavailable(message) => {
                self.result::<()>("localStorage", Err(message.clone()));
                return;
            }
            LegacyLocalStorage::NotApplicable => return,
        };
        let mut indexes = BTreeMap::new();
        for (key, text) in entries {
            if let Some(branch) = key.strip_prefix(INDEX) {
                if !valid_branch(branch) {
                    self.result::<()>(key, Err("Invalid local index branch".into()));
                    continue;
                }
                let index = self.json(key, text);
                indexes.insert(branch, self.index(branch, key, index));
            }
        }
        for (key, text) in entries {
            let Some(locator) = key.strip_prefix(PLAN) else {
                continue;
            };
            let Some((branch, slot)) = locator
                .rsplit_once(':')
                .filter(|(branch, _)| valid_branch(branch))
            else {
                self.result::<()>(key, Err("Invalid local plan key".into()));
                continue;
            };
            let Some(plan) = self.json(key, text) else {
                continue;
            };
            let Some(id) = self.record_id(branch, slot, &plan, "id", key, local_id_matches) else {
                continue;
            };
            let summary = indexes
                .get_mut(branch)
                .and_then(|summaries| summaries.remove(&id))
                .unwrap_or(Value::Null);
            self.plan(
                branch,
                id,
                &plan,
                &summary,
                &Value::Null,
                LegacyOrigin {
                    scope: "local",
                    location: key.clone(),
                    project_ids: Vec::new(),
                    revision: None,
                    updated_at: None,
                    conversation_ids: BTreeSet::new(),
                    transcript: entries.get(&format!("{CHAT}{branch}:{slot}")).cloned(),
                },
            );
        }
        for (branch, index) in indexes {
            self.check_missing(&format!("{INDEX}{branch}"), index);
        }
    }
}

fn ids(value: &Value) -> Vec<String> {
    if let Some(values) = value.as_array() {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    } else {
        value.as_str().into_iter().map(str::to_owned).collect()
    }
}

fn read_git_pointer(file: &Path, prefix: &str, base: &Path) -> ReadResult<PathBuf> {
    if disk_kind(file)? != Some(EntryKind::File) {
        return Err("Expected a regular Git pointer file".into());
    }
    let text = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let path = text
        .trim()
        .strip_prefix(prefix)
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.contains(['\n', '\r']))
        .ok_or("Invalid Git pointer")?;
    base.join(path)
        .canonicalize()
        .map_err(|error| error.to_string())
}

fn linked_git_dirs(
    worktree: &Path,
    expected_admin: Option<&Path>,
) -> ReadResult<(PathBuf, PathBuf)> {
    let gitfile = worktree.join(".git");
    let admin = read_git_pointer(&gitfile, "gitdir:", worktree)?;
    if expected_admin.is_some_and(|expected| admin != expected) {
        return Err("Metadata checkout is outside this repository's Macro registration".into());
    }
    // Git registers linked checkouts under <common>/worktrees/<name>.
    let common = admin
        .parent()
        .filter(|parent| parent.ends_with("worktrees"))
        .and_then(Path::parent)
        .ok_or("Git pointer is outside the worktree registrations")?;
    if read_git_pointer(&admin.join("commondir"), "", &admin)? != common
        || read_git_pointer(&admin.join("gitdir"), "", &admin)? != gitfile
    {
        return Err("Git worktree registration does not point back to this checkout".into());
    }
    let common = common.to_path_buf();
    Ok((admin, common))
}

fn open_git_checkout(path: &Path, admin: &Path, common: &Path) -> ReadResult<Repository> {
    if disk_kind(&admin.join("HEAD"))? != Some(EntryKind::File) {
        return Err("Expected a regular Git HEAD file".into());
    }
    let repo = Repository::open_ext(
        path,
        RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .map_err(|error| error.to_string())?;
    let canonical = |path: &Path| path.canonicalize().map_err(|error| error.to_string());
    if canonical(repo.path())? != admin
        || canonical(repo.commondir())? != common
        || !repo
            .workdir()
            .and_then(|dir| canonical(dir).ok())
            .is_some_and(|dir| dir == path)
        || repo.is_worktree() != (admin != common)
    {
        return Err("Git repository does not match this checkout".into());
    }
    Ok(repo)
}

fn open_git_workspace(path: &Path) -> ReadResult<Option<Repository>> {
    let dot_git = path.join(".git");
    match disk_kind(&dot_git)? {
        None => Ok(None),
        Some(EntryKind::Directory) if disk_kind(&dot_git.join("commondir"))?.is_none() => {
            open_git_checkout(path, &dot_git, &dot_git).map(Some)
        }
        Some(EntryKind::File) => {
            let (admin, common) = linked_git_dirs(path, None)?;
            open_git_checkout(path, &admin, &common).map(Some)
        }
        _ => Err("Expected a local .git directory or a registered linked checkout".into()),
    }
}

fn is_metadata_checkout(path: &Path, common: &Path, reference: &str) -> ReadResult<bool> {
    match disk_kind(path)? {
        None => return Ok(false),
        Some(EntryKind::Directory) => {}
        _ => return Err("Expected a metadata worktree directory".into()),
    }
    if fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        return Ok(false);
    }
    let expected_admin = common.join("worktrees").join(MACRO_WORKTREE_NAME);
    let (admin, _) = linked_git_dirs(path, Some(&expected_admin))?;
    let repo = open_git_checkout(path, &admin, common)?;
    let head = repo
        .find_reference("HEAD")
        .map_err(|error| error.to_string())?;
    if head.symbolic_target().map_err(|error| error.to_string())? != Some(reference) {
        return Err("Metadata checkout is on a branch other than @macro".into());
    }
    let branch = repo
        .find_reference(reference)
        .map_err(|error| error.to_string())?;
    if branch.target().is_none() {
        return Err("Expected @macro to be a direct Git reference".into());
    }
    Ok(true)
}

impl Scan {
    fn layout(&mut self, root: &Root<'_>, scope: &Scope, workspace: &Path, legacy_nested: bool) {
        let prefix = Path::new("");
        let nested = legacy_nested && self.contains_dir(root, scope, prefix, ".macro");
        if scope.kind == "workspace" {
            self.registry(root, scope, workspace, nested);
        }
        self.branches(root, scope, prefix);
        if nested {
            self.branches(root, scope, Path::new(".macro"));
        }
    }

    fn physical_scope(&mut self, path: &Path, kind: &'static str, project_ids: Vec<String>) {
        let location = path.display().to_string();
        if !path.is_absolute() {
            self.result::<()>(
                &location,
                Err("Expected an absolute legacy workspace path".into()),
            );
            return;
        }
        let Some(path) = self.result(
            &location,
            fs::canonicalize(path).map_err(|err| err.to_string()),
        ) else {
            return;
        };
        if !path.is_dir() {
            self.result::<()>(&location, Err("Legacy workspace is not a directory".into()));
            return;
        }
        let scope = Scope {
            kind,
            location,
            project_ids,
        };
        let direct = path.join(".macro");
        match self.result(&scope.location, disk_kind(&direct)).flatten() {
            Some(EntryKind::Directory) => self.layout(
                &Root::Directory(&direct),
                &Scope {
                    location: direct.display().to_string(),
                    ..scope.clone()
                },
                &path,
                false,
            ),
            Some(_) => {
                self.result::<()>(
                    direct.display().to_string(),
                    Err("Expected a metadata directory".into()),
                );
            }
            None => {}
        }

        let Some(repo) = self
            .result(&scope.location, open_git_workspace(&path))
            .flatten()
        else {
            return;
        };
        let Some(common) = self.result(
            &scope.location,
            repo.commondir()
                .canonicalize()
                .map_err(|error| error.to_string()),
        ) else {
            return;
        };
        let Some(admin) = self.result(
            &scope.location,
            repo.path()
                .canonicalize()
                .map_err(|error| error.to_string()),
        ) else {
            return;
        };
        let reference = format!("refs/heads/{MACRO_BRANCH_NAME}");
        let mut materialized = false;
        for admin in BTreeSet::from([admin, common.clone()]) {
            let worktree = admin.join(MACRO_WORKTREE_DIR_NAME);
            let location = worktree.display().to_string();
            match self.result(
                &location,
                is_metadata_checkout(&worktree, &common, &reference),
            ) {
                Some(false) => {}
                Some(true) => {
                    materialized = true;
                    self.layout(
                        &Root::Directory(&worktree),
                        &Scope {
                            location,
                            ..scope.clone()
                        },
                        &path,
                        true,
                    );
                }
                None => materialized = true,
            }
        }
        if materialized {
            return;
        }
        // A repository can retain @macro after losing its checkout. Read only
        // the local tip. A materialized tree may contain newer edits/removals.
        let metadata_ref = match repo.find_reference(&reference) {
            Ok(metadata_ref) => metadata_ref,
            Err(error) if error.code() == ErrorCode::NotFound => return,
            Err(error) => {
                self.result::<()>(&scope.location, Err(error.to_string()));
                return;
            }
        };
        let Some(tip) = self.result(
            &scope.location,
            metadata_ref
                .target()
                .ok_or("Expected @macro to be a direct Git reference".into()),
        ) else {
            return;
        };
        if let Some(commit) = self.result(
            &scope.location,
            repo.find_commit(tip).map_err(|e| e.to_string()),
        ) {
            if let Some(tree) =
                self.result(&scope.location, commit.tree().map_err(|e| e.to_string()))
            {
                self.layout(
                    &Root::Commit(&repo, tree),
                    &Scope {
                        location: format!("{}#{reference}@{}", scope.location, commit.id()),
                        ..scope
                    },
                    &path,
                    true,
                );
            }
        };
    }
}

pub(super) fn discover(profile: &LegacyProfile) -> LegacyDiscovery {
    let mut scan = Scan::default();
    for project in &profile.projects {
        let path = match (profile.workspace_paths.first(), project.path.to_str()) {
            (Some(workspace), Some(path)) if workspace.is_absolute() && !path.trim().is_empty() => {
                resolve_project_path(workspace, path)
            }
            _ => project.path.clone(),
        };
        scan.projects
            .entry(path)
            .or_default()
            .insert(project.id.clone());
    }
    let mut visited_workspaces = BTreeSet::new();
    for path in &profile.workspace_paths {
        if visited_workspaces.insert(path.clone()) {
            scan.physical_scope(path, "workspace", Vec::new());
        }
    }
    for (path, project_ids) in std::mem::take(&mut scan.projects) {
        // Keep distinct scope provenance when the workspace is also a registered project.
        scan.physical_scope(&path, "project", project_ids.into_iter().collect());
    }
    scan.local(&profile.local_storage);

    let mut links = BTreeMap::<_, BTreeSet<_>>::new();
    for link in &profile.conversation_links {
        links
            .entry((&link.target_branch, &link.plan_id))
            .or_default()
            .insert(link.conversation_id.clone());
    }
    let mut blueprints = BTreeMap::new();
    for Candidate {
        mut blueprint,
        recency,
    } in scan.candidates
    {
        if scan
            .deletions
            .get(&(blueprint.branch.clone(), blueprint.plan_id.clone()))
            .is_some_and(|deletions| {
                deletions
                    .iter()
                    .any(|deletion| !recency.strictly_newer_than(deletion))
            })
        {
            continue;
        }
        if let Some(name) = blueprint
            .source_project_id
            .strip_prefix("legacy:project:")
            .and_then(|id| scan.project_names.get(id))
        {
            blueprint.project_name = name.clone();
        }
        if let Some(ids) = links.get(&(&blueprint.branch, &blueprint.plan_id)) {
            blueprint.origins = blueprint
                .origins
                .into_iter()
                .map(|mut origin| {
                    origin.conversation_ids.extend(ids.iter().cloned());
                    origin
                })
                .collect();
        }
        blueprints
            .entry(blueprint.import_key.clone())
            .and_modify(|existing: &mut LegacyBlueprint| {
                existing.origins.append(&mut blueprint.origins)
            })
            .or_insert(blueprint);
    }
    scan.issues.sort_by(|left, right| {
        (&left.location, &left.message).cmp(&(&right.location, &right.message))
    });
    scan.issues
        .dedup_by(|a, b| a.location == b.location && a.message == b.message);
    LegacyDiscovery {
        blueprints: blueprints.into_values().collect(),
        issues: scan.issues,
    }
}
