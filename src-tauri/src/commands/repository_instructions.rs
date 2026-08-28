use cap_std::ambient_authority;
use cap_std::fs::Dir as CapabilityDir;
use same_file::Handle as FileIdentity;
use serde::de::{IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const INSTRUCTION_FILE_NAME: &str = "AGENTS.md";
const DEFAULT_MAX_FILES: usize = 16;
const ABSOLUTE_MAX_FILES: usize = 32;
const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024;
const ABSOLUTE_MAX_TOTAL_BYTES: usize = 256 * 1024;
const ABSOLUTE_MAX_PROJECTS: usize = 32;
const ABSOLUTE_MAX_DISCOVERY_DIRECTORIES: usize = 256;
const ABSOLUTE_MAX_ISSUES: usize = 64;
const ABSOLUTE_MAX_PROJECT_ID_BYTES: usize = 256;
const ABSOLUTE_MAX_PROJECT_NAME_BYTES: usize = 1024;
const ABSOLUTE_MAX_INPUT_PATH_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionProjectInput {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    #[serde(deserialize_with = "deserialize_project_name")]
    pub project_name: String,
    #[serde(deserialize_with = "deserialize_input_path")]
    pub root_path: String,
    #[serde(default, deserialize_with = "deserialize_optional_input_path")]
    pub scope_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionLoadInput {
    #[serde(deserialize_with = "deserialize_bounded_projects")]
    pub projects: Vec<RepositoryInstructionProjectInput>,
    pub max_files: Option<usize>,
    pub max_total_bytes: Option<usize>,
}

struct BoundedStringVisitor {
    maximum_bytes: usize,
    label: &'static str,
}

impl Visitor<'_> for BoundedStringVisitor {
    type Value = String;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} no longer than {} bytes",
            self.label, self.maximum_bytes
        )
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if value.len() > self.maximum_bytes {
            return Err(E::custom(format!("{} exceeds its byte limit", self.label)));
        }
        Ok(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if value.len() > self.maximum_bytes {
            return Err(E::custom(format!("{} exceeds its byte limit", self.label)));
        }
        Ok(value)
    }
}

fn deserialize_bounded_string<'de, D>(
    deserializer: D,
    maximum_bytes: usize,
    label: &'static str,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_string(BoundedStringVisitor {
        maximum_bytes,
        label,
    })
}

fn deserialize_project_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_string(deserializer, ABSOLUTE_MAX_PROJECT_ID_BYTES, "project id")
}

fn deserialize_project_name<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_string(
        deserializer,
        ABSOLUTE_MAX_PROJECT_NAME_BYTES,
        "project name",
    )
}

fn deserialize_input_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_string(deserializer, ABSOLUTE_MAX_INPUT_PATH_BYTES, "project path")
}

fn deserialize_optional_input_path<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalPathVisitor;

    impl<'de> Visitor<'de> for OptionalPathVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "an optional bounded project path")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserialize_input_path(deserializer).map(Some)
        }
    }

    deserializer.deserialize_option(OptionalPathVisitor)
}

fn deserialize_bounded_projects<'de, D>(
    deserializer: D,
) -> Result<Vec<RepositoryInstructionProjectInput>, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoundedProjectsVisitor;

    impl<'de> Visitor<'de> for BoundedProjectsVisitor {
        type Value = Vec<RepositoryInstructionProjectInput>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(
                formatter,
                "at most {ABSOLUTE_MAX_PROJECTS} repository instruction projects"
            )
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut projects =
                Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(ABSOLUTE_MAX_PROJECTS));
            while projects.len() < ABSOLUTE_MAX_PROJECTS {
                match sequence.next_element()? {
                    Some(project) => projects.push(project),
                    None => return Ok(projects),
                }
            }
            if sequence.next_element::<IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::custom(format!(
                    "repository instruction project limit exceeded: {ABSOLUTE_MAX_PROJECTS}"
                )));
            }
            Ok(projects)
        }
    }

    deserializer.deserialize_seq(BoundedProjectsVisitor)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionSource {
    pub project_id: String,
    pub project_name: String,
    pub source_path: String,
    pub relative_path: String,
    pub depth: usize,
    pub size_bytes: usize,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionIssue {
    pub project_id: String,
    pub code: String,
    pub source_path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionLoadResult {
    pub sources: Vec<RepositoryInstructionSource>,
    pub issues: Vec<RepositoryInstructionIssue>,
    pub total_bytes: usize,
    pub file_limit: usize,
    pub byte_limit: usize,
}

fn canonical_path_key_for_platform(path: &Path, windows: bool) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn canonical_path_key(path: &Path) -> String {
    canonical_path_key_for_platform(path, cfg!(windows))
}

fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root_components = root.components().collect::<Vec<_>>();
    let candidate_components = candidate.components().collect::<Vec<_>>();
    if candidate_components.len() < root_components.len() {
        return false;
    }
    root_components
        .iter()
        .zip(candidate_components.iter())
        .all(|(left, right)| left == right)
}

fn issue(
    project_id: &str,
    code: &str,
    source_path: Option<&Path>,
    message: impl Into<String>,
) -> RepositoryInstructionIssue {
    RepositoryInstructionIssue {
        project_id: project_id.to_string(),
        code: code.to_string(),
        source_path: source_path.map(|path| path.to_string_lossy().into_owned()),
        message: message.into(),
    }
}

fn push_issue_bounded(
    issues: &mut Vec<RepositoryInstructionIssue>,
    problem: RepositoryInstructionIssue,
) {
    if issues.len() < ABSOLUTE_MAX_ISSUES - 1 {
        issues.push(problem);
    } else if issues.len() == ABSOLUTE_MAX_ISSUES - 1 {
        issues.push(issue(
            "macro",
            "issue_limit_reached",
            None,
            format!("Repository instruction issue limit reached: {ABSOLUTE_MAX_ISSUES}."),
        ));
    }
}

fn canonical_project_scope(
    project: &RepositoryInstructionProjectInput,
) -> Result<(PathBuf, PathBuf), RepositoryInstructionIssue> {
    let root = fs::canonicalize(&project.root_path).map_err(|error| {
        issue(
            &project.project_id,
            "project_root_unavailable",
            Some(Path::new(&project.root_path)),
            format!("Cannot resolve project root: {error}"),
        )
    })?;
    if !fs::metadata(&root)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(issue(
            &project.project_id,
            "project_root_not_directory",
            Some(&root),
            "Project root is not a directory.",
        ));
    }

    let Some(raw_scope) = project
        .scope_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok((root.clone(), root));
    };
    let raw_scope_path = PathBuf::from(raw_scope);
    let scope_candidate = if raw_scope_path.is_absolute() {
        raw_scope_path
    } else {
        root.join(raw_scope_path)
    };
    let mut scope = fs::canonicalize(&scope_candidate).map_err(|error| {
        issue(
            &project.project_id,
            "scope_unavailable",
            Some(&scope_candidate),
            format!("Cannot resolve project instruction scope: {error}"),
        )
    })?;
    if fs::metadata(&scope)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        scope = scope.parent().unwrap_or(&root).to_path_buf();
    }
    if !path_is_within(&root, &scope) {
        return Err(issue(
            &project.project_id,
            "scope_outside_project",
            Some(&scope),
            "Project instruction scope resolves outside the project root.",
        ));
    }
    Ok((root, scope))
}

fn discovery_directories(root: &Path, scope: &Path) -> (Vec<PathBuf>, bool) {
    let relative = scope.strip_prefix(root).unwrap_or_else(|_| Path::new(""));
    let mut directories = vec![root.to_path_buf()];
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if directories.len() >= ABSOLUTE_MAX_DISCOVERY_DIRECTORIES {
            return (directories, true);
        }
        current.push(component);
        directories.push(current.clone());
    }
    (directories, false)
}

fn relative_source_path(root: &Path, source: &Path) -> String {
    source
        .strip_prefix(root)
        .unwrap_or(source)
        .to_string_lossy()
        .replace('\\', "/")
}

fn project_input_is_bounded(project: &RepositoryInstructionProjectInput) -> bool {
    project.project_id.len() <= ABSOLUTE_MAX_PROJECT_ID_BYTES
        && project.project_name.len() <= ABSOLUTE_MAX_PROJECT_NAME_BYTES
        && project.root_path.len() <= ABSOLUTE_MAX_INPUT_PATH_BYTES
        && project
            .scope_path
            .as_ref()
            .map(|path| path.len() <= ABSOLUTE_MAX_INPUT_PATH_BYTES)
            .unwrap_or(true)
}

pub fn load_repository_instructions_internal(
    input: RepositoryInstructionLoadInput,
) -> RepositoryInstructionLoadResult {
    let file_limit = input
        .max_files
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, ABSOLUTE_MAX_FILES);
    let byte_limit = input
        .max_total_bytes
        .unwrap_or(DEFAULT_MAX_TOTAL_BYTES)
        .clamp(1, ABSOLUTE_MAX_TOTAL_BYTES);
    let mut result = RepositoryInstructionLoadResult {
        sources: Vec::new(),
        issues: Vec::new(),
        total_bytes: 0,
        file_limit,
        byte_limit,
    };
    let mut file_limit_reported_projects = HashSet::new();
    let mut inspected_file_count = 0usize;
    let mut read_byte_count = 0usize;
    let project_limit_reached = input.projects.len() > ABSOLUTE_MAX_PROJECTS;

    for project in input.projects.into_iter().take(ABSOLUTE_MAX_PROJECTS) {
        if !project_input_is_bounded(&project) {
            let diagnostic_project_id = if project.project_id.is_empty()
                || project.project_id.len() > ABSOLUTE_MAX_PROJECT_ID_BYTES
            {
                "macro"
            } else {
                &project.project_id
            };
            push_issue_bounded(
                &mut result.issues,
                issue(
                    diagnostic_project_id,
                    "project_metadata_limit_reached",
                    None,
                    "Repository instruction project metadata exceeds its limit.",
                ),
            );
            continue;
        }
        let capability_root = match CapabilityDir::open_ambient_dir(
            Path::new(&project.root_path),
            ambient_authority(),
        ) {
            Ok(directory) => directory,
            Err(error) => {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "project_root_unavailable",
                        Some(Path::new(&project.root_path)),
                        format!("Cannot open project root: {error}"),
                    ),
                );
                continue;
            }
        };
        let (root, scope) = match canonical_project_scope(&project) {
            Ok(scope) => scope,
            Err(problem) => {
                push_issue_bounded(&mut result.issues, problem);
                continue;
            }
        };
        let opened_root_identity = capability_root
            .try_clone()
            .map(CapabilityDir::into_std_file)
            .and_then(FileIdentity::from_file);
        let canonical_root_identity = FileIdentity::from_path(&root);
        match (opened_root_identity, canonical_root_identity) {
            (Ok(opened), Ok(canonical)) if opened == canonical => {}
            (Ok(_), Ok(_)) => {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "project_root_changed",
                        Some(&root),
                        "Project root changed while repository instructions were being prepared.",
                    ),
                );
                continue;
            }
            (Err(error), _) | (_, Err(error)) => {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "project_root_unavailable",
                        Some(&root),
                        format!("Cannot verify opened project root: {error}"),
                    ),
                );
                continue;
            }
        }
        let mut seen_paths = HashSet::new();
        let (directories, depth_limit_reached) = discovery_directories(&root, &scope);
        if depth_limit_reached {
            push_issue_bounded(
                &mut result.issues,
                issue(
                    &project.project_id,
                    "scope_depth_limit_reached",
                    Some(&scope),
                    format!(
                        "Repository instruction scope depth limit reached: {}.",
                        ABSOLUTE_MAX_DISCOVERY_DIRECTORIES - 1
                    ),
                ),
            );
        }
        for (depth, directory) in directories.into_iter().enumerate() {
            let candidate = directory.join(INSTRUCTION_FILE_NAME);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_metadata_failed",
                            Some(&candidate),
                            format!("Cannot inspect repository instructions: {error}"),
                        ),
                    );
                    continue;
                }
            };
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                continue;
            }
            let canonical_source = match fs::canonicalize(&candidate) {
                Ok(path) => path,
                Err(error) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_unreadable",
                            Some(&candidate),
                            format!("Cannot resolve repository instructions: {error}"),
                        ),
                    );
                    continue;
                }
            };
            if !path_is_within(&root, &canonical_source) {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "instruction_symlink_escape",
                        Some(&candidate),
                        "Repository instructions resolve outside the project root.",
                    ),
                );
                continue;
            }
            if !seen_paths.insert(canonical_path_key(&canonical_source)) {
                continue;
            }
            if inspected_file_count >= file_limit {
                if file_limit_reported_projects.insert(project.project_id.clone()) {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "file_limit_reached",
                            Some(&candidate),
                            format!("Repository instruction file limit reached: {file_limit}."),
                        ),
                    );
                }
                continue;
            }
            inspected_file_count += 1;
            let remaining_bytes = byte_limit.saturating_sub(read_byte_count);
            if remaining_bytes == 0 {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "byte_limit_reached",
                        Some(&candidate),
                        format!("Repository instruction byte limit reached: {byte_limit}."),
                    ),
                );
                continue;
            }
            let relative_source = match canonical_source.strip_prefix(&root) {
                Ok(path) => path,
                Err(_) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_symlink_escape",
                            Some(&candidate),
                            "Repository instructions do not have a confined relative path.",
                        ),
                    );
                    continue;
                }
            };
            let mut source_file = match capability_root.open(relative_source) {
                Ok(file) => file.into_std(),
                Err(error) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_read_failed",
                            Some(&candidate),
                            format!("Cannot open repository instructions: {error}"),
                        ),
                    );
                    continue;
                }
            };
            let opened_source_identity = source_file.try_clone().and_then(FileIdentity::from_file);
            let canonical_source_identity = FileIdentity::from_path(&canonical_source);
            match (opened_source_identity, canonical_source_identity) {
                (Ok(opened), Ok(canonical)) if opened == canonical => {}
                (Ok(_), Ok(_)) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_changed",
                            Some(&candidate),
                            "Repository instructions changed while they were being prepared.",
                        ),
                    );
                    continue;
                }
                (Err(error), _) | (_, Err(error)) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_metadata_failed",
                            Some(&candidate),
                            format!("Cannot verify opened repository instructions: {error}"),
                        ),
                    );
                    continue;
                }
            }
            let source_metadata = match source_file.metadata() {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_not_file",
                            Some(&candidate),
                            "Repository instruction source is no longer a file.",
                        ),
                    );
                    continue;
                }
                Err(error) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_metadata_failed",
                            Some(&candidate),
                            format!("Cannot inspect opened repository instructions: {error}"),
                        ),
                    );
                    continue;
                }
            };
            let size_bytes = match usize::try_from(source_metadata.len()) {
                Ok(size) => size,
                Err(_) => usize::MAX,
            };
            if size_bytes > remaining_bytes {
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "byte_limit_reached",
                        Some(&candidate),
                        format!("Repository instruction byte limit reached: {byte_limit}."),
                    ),
                );
                continue;
            }
            let mut content_bytes = Vec::with_capacity(remaining_bytes.min(8 * 1024));
            let read_limit = u64::try_from(remaining_bytes)
                .unwrap_or(u64::MAX - 1)
                .saturating_add(1);
            if let Err(error) = source_file
                .by_ref()
                .take(read_limit)
                .read_to_end(&mut content_bytes)
            {
                read_byte_count += content_bytes.len().min(remaining_bytes);
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "instruction_read_failed",
                        Some(&candidate),
                        format!("Cannot read repository instructions: {error}"),
                    ),
                );
                continue;
            }
            if content_bytes.len() > remaining_bytes {
                read_byte_count = byte_limit;
                push_issue_bounded(
                    &mut result.issues,
                    issue(
                        &project.project_id,
                        "byte_limit_reached",
                        Some(&candidate),
                        format!("Repository instruction byte limit reached: {byte_limit}."),
                    ),
                );
                continue;
            }
            read_byte_count += content_bytes.len();
            let content = match String::from_utf8(content_bytes) {
                Ok(content) => content,
                Err(error) => {
                    push_issue_bounded(
                        &mut result.issues,
                        issue(
                            &project.project_id,
                            "instruction_read_failed",
                            Some(&candidate),
                            format!("Cannot read repository instructions as UTF-8: {error}"),
                        ),
                    );
                    continue;
                }
            };
            let actual_bytes = content.len();
            result.total_bytes += actual_bytes;
            result.sources.push(RepositoryInstructionSource {
                project_id: project.project_id.clone(),
                project_name: project.project_name.clone(),
                source_path: canonical_source.to_string_lossy().into_owned(),
                relative_path: relative_source_path(&root, &candidate),
                depth,
                size_bytes: actual_bytes,
                content,
            });
        }
    }
    if project_limit_reached {
        push_issue_bounded(
            &mut result.issues,
            issue(
                "macro",
                "project_limit_reached",
                None,
                format!("Repository instruction project limit reached: {ABSOLUTE_MAX_PROJECTS}."),
            ),
        );
    }
    result
}

#[tauri::command]
pub async fn repository_instructions_load(
    input: RepositoryInstructionLoadInput,
) -> Result<RepositoryInstructionLoadResult, String> {
    tauri::async_runtime::spawn_blocking(move || load_repository_instructions_internal(input))
        .await
        .map_err(|error| format!("Repository instruction loader failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn symlink_file(source: &Path, target: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(source, target)
    }

    #[cfg(windows)]
    fn symlink_file(source: &Path, target: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(source, target)
    }

    fn project(id: &str, root: &Path, scope: Option<&Path>) -> RepositoryInstructionProjectInput {
        RepositoryInstructionProjectInput {
            project_id: id.to_string(),
            project_name: format!("Project {id}"),
            root_path: root.to_string_lossy().into_owned(),
            scope_path: scope.map(|path| path.to_string_lossy().into_owned()),
        }
    }

    fn load(projects: Vec<RepositoryInstructionProjectInput>) -> RepositoryInstructionLoadResult {
        load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects,
            max_files: None,
            max_total_bytes: None,
        })
    }

    #[test]
    fn loads_root_before_deeper_instructions() {
        let root = TempDir::new().expect("root");
        let child = root.path().join("src/feature");
        fs::create_dir_all(&child).expect("child");
        fs::write(root.path().join(INSTRUCTION_FILE_NAME), "root").expect("root instructions");
        fs::write(root.path().join("src").join(INSTRUCTION_FILE_NAME), "child")
            .expect("child instructions");

        let result = load(vec![project("web", root.path(), Some(&child))]);

        assert_eq!(
            result
                .sources
                .iter()
                .map(|source| source.content.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "child"]
        );
        assert_eq!(
            result
                .sources
                .iter()
                .map(|source| source.depth)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn keeps_multi_project_sources_separate_and_ordered() {
        let web = TempDir::new().expect("web");
        let api = TempDir::new().expect("api");
        fs::write(web.path().join(INSTRUCTION_FILE_NAME), "web rules").expect("web instructions");
        fs::write(api.path().join(INSTRUCTION_FILE_NAME), "api rules").expect("api instructions");

        let result = load(vec![
            project("web", web.path(), None),
            project("api", api.path(), None),
        ]);

        assert_eq!(
            result
                .sources
                .iter()
                .map(|source| (source.project_id.as_str(), source.content.as_str()))
                .collect::<Vec<_>>(),
            vec![("web", "web rules"), ("api", "api rules")]
        );
    }

    #[test]
    fn missing_files_are_ignored() {
        let root = TempDir::new().expect("root");
        let result = load(vec![project("empty", root.path(), None)]);
        assert!(result.sources.is_empty());
        assert!(result.issues.is_empty());
    }

    #[test]
    fn rejects_a_scope_outside_the_project_root() {
        let root = TempDir::new().expect("root");
        let outside = TempDir::new().expect("outside");

        let result = load(vec![project("confined", root.path(), Some(outside.path()))]);

        assert!(result.sources.is_empty());
        assert!(result
            .issues
            .iter()
            .any(|problem| problem.code == "scope_outside_project"));
    }

    #[test]
    fn enforces_global_file_and_byte_limits_without_partial_content() {
        let root = TempDir::new().expect("root");
        let child = root.path().join("child");
        fs::create_dir_all(&child).expect("child");
        fs::write(root.path().join(INSTRUCTION_FILE_NAME), "1234").expect("root instructions");
        fs::write(child.join(INSTRUCTION_FILE_NAME), "5678").expect("child instructions");

        let file_limited = load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects: vec![project("limited", root.path(), Some(&child))],
            max_files: Some(1),
            max_total_bytes: Some(100),
        });
        assert_eq!(file_limited.sources.len(), 1);
        assert!(file_limited
            .issues
            .iter()
            .any(|problem| problem.code == "file_limit_reached"));

        let byte_limited = load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects: vec![project("limited", root.path(), Some(&child))],
            max_files: Some(10),
            max_total_bytes: Some(6),
        });
        assert_eq!(byte_limited.sources.len(), 1);
        assert_eq!(byte_limited.total_bytes, 4);
        assert!(byte_limited
            .issues
            .iter()
            .any(|problem| problem.code == "byte_limit_reached"));
    }

    #[test]
    fn reports_every_project_affected_by_the_global_file_limit() {
        let first = TempDir::new().expect("first");
        let second = TempDir::new().expect("second");
        let third = TempDir::new().expect("third");
        for root in [&first, &second, &third] {
            fs::write(root.path().join(INSTRUCTION_FILE_NAME), "rules").expect("instructions");
        }

        let result = load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects: vec![
                project("first", first.path(), None),
                project("second", second.path(), None),
                project("third", third.path(), None),
            ],
            max_files: Some(1),
            max_total_bytes: Some(100),
        });

        assert_eq!(result.sources.len(), 1);
        assert_eq!(
            result
                .issues
                .iter()
                .filter(|problem| problem.code == "file_limit_reached")
                .map(|problem| problem.project_id.as_str())
                .collect::<Vec<_>>(),
            vec!["second", "third"]
        );
    }

    #[test]
    fn rejected_utf8_files_consume_file_and_byte_budgets() {
        let root = TempDir::new().expect("root");
        let child = root.path().join("child");
        fs::create_dir(&child).expect("child");
        fs::write(
            root.path().join(INSTRUCTION_FILE_NAME),
            [0xff, 0xfe, 0xfd, 0xfc],
        )
        .expect("invalid root instructions");
        fs::write(child.join(INSTRUCTION_FILE_NAME), "valid").expect("child instructions");

        let file_limited = load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects: vec![project("limited", root.path(), Some(&child))],
            max_files: Some(1),
            max_total_bytes: Some(100),
        });
        assert!(file_limited.sources.is_empty());
        assert!(file_limited
            .issues
            .iter()
            .any(|problem| problem.code == "instruction_read_failed"));
        assert!(file_limited
            .issues
            .iter()
            .any(|problem| problem.code == "file_limit_reached"));

        let byte_limited = load_repository_instructions_internal(RepositoryInstructionLoadInput {
            projects: vec![project("limited", root.path(), Some(&child))],
            max_files: Some(10),
            max_total_bytes: Some(6),
        });
        assert!(byte_limited.sources.is_empty());
        assert!(byte_limited
            .issues
            .iter()
            .any(|problem| problem.code == "instruction_read_failed"));
        assert!(byte_limited
            .issues
            .iter()
            .any(|problem| problem.code == "byte_limit_reached"));
    }

    #[test]
    fn caps_projects_and_reports_the_omission() {
        let root = TempDir::new().expect("root");
        let projects = (0..=ABSOLUTE_MAX_PROJECTS)
            .map(|index| project(&format!("project-{index}"), root.path(), None))
            .collect();

        let result = load(projects);

        assert!(result.sources.is_empty());
        assert!(result
            .issues
            .iter()
            .any(|problem| problem.code == "project_limit_reached"));
    }

    #[test]
    fn rejects_oversized_project_metadata_without_echoing_it() {
        let root = TempDir::new().expect("root");
        let oversized_name = "x".repeat(ABSOLUTE_MAX_PROJECT_NAME_BYTES + 1);

        let result = load(vec![RepositoryInstructionProjectInput {
            project_id: "project".to_string(),
            project_name: oversized_name.clone(),
            root_path: root.path().to_string_lossy().into_owned(),
            scope_path: None,
        }]);

        assert!(result.sources.is_empty());
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].code, "project_metadata_limit_reached");
        assert!(!result.issues[0].message.contains(&oversized_name));
    }

    #[test]
    fn rejects_oversized_project_arrays_during_deserialization() {
        let projects = (0..=ABSOLUTE_MAX_PROJECTS)
            .map(|index| {
                serde_json::json!({
                    "projectId": format!("project-{index}"),
                    "projectName": "Project",
                    "rootPath": "C:/repo",
                    "scopePath": null
                })
            })
            .collect::<Vec<_>>();
        let input = serde_json::json!({
            "projects": projects,
            "maxFiles": 16,
            "maxTotalBytes": 65536
        });

        let error = serde_json::from_value::<RepositoryInstructionLoadInput>(input)
            .expect_err("oversized project array must be rejected");

        assert!(error.to_string().contains("project limit exceeded"));
    }

    #[test]
    fn rejects_oversized_project_fields_during_deserialization() {
        let input = serde_json::json!({
            "projects": [{
                "projectId": "project",
                "projectName": "x".repeat(ABSOLUTE_MAX_PROJECT_NAME_BYTES + 1),
                "rootPath": "C:/repo",
                "scopePath": null
            }],
            "maxFiles": 16,
            "maxTotalBytes": 65536
        });

        let error = serde_json::from_value::<RepositoryInstructionLoadInput>(input)
            .expect_err("oversized project fields must be rejected");

        assert!(error
            .to_string()
            .contains("project name exceeds its byte limit"));
    }

    #[test]
    fn bounds_discovery_while_ancestor_paths_are_built() {
        let root = PathBuf::from("root");
        let mut scope = root.clone();
        for index in 0..(ABSOLUTE_MAX_DISCOVERY_DIRECTORIES * 2) {
            scope.push(format!("child-{index}"));
        }

        let (directories, limit_reached) = discovery_directories(&root, &scope);

        assert!(limit_reached);
        assert_eq!(directories.len(), ABSOLUTE_MAX_DISCOVERY_DIRECTORIES);
    }

    #[test]
    fn bounds_issues_while_they_are_collected() {
        let mut issues = Vec::new();
        for index in 0..(ABSOLUTE_MAX_ISSUES * 2) {
            push_issue_bounded(
                &mut issues,
                issue("project", "test_issue", None, format!("problem {index}")),
            );
        }

        assert_eq!(issues.len(), ABSOLUTE_MAX_ISSUES);
        assert_eq!(
            issues.last().map(|problem| problem.code.as_str()),
            Some("issue_limit_reached")
        );
    }

    #[test]
    fn windows_canonical_keys_ignore_case_and_separator_style() {
        let first = canonical_path_key_for_platform(Path::new(r"C:\\Work\\Repo\\AGENTS.md"), true);
        let second = canonical_path_key_for_platform(Path::new(r"c:\\work\\repo\\agents.MD"), true);
        assert_eq!(first, second);
    }

    #[cfg(windows)]
    #[test]
    fn windows_containment_does_not_fold_case() {
        let root = Path::new(r"C:\parent\Repo");
        let case_distinct_sibling = Path::new(r"C:\parent\repo\AGENTS.md");

        assert!(!path_is_within(root, case_distinct_sibling));
    }

    #[test]
    fn rejects_instruction_symlinks_that_escape_the_project() {
        let root = TempDir::new().expect("root");
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join(INSTRUCTION_FILE_NAME), "outside rules")
            .expect("outside instructions");
        symlink_file(
            &outside.path().join(INSTRUCTION_FILE_NAME),
            &root.path().join(INSTRUCTION_FILE_NAME),
        )
        .expect("instruction symlink");

        let result = load(vec![project("web", root.path(), None)]);

        assert!(result.sources.is_empty());
        assert!(result
            .issues
            .iter()
            .any(|problem| problem.code == "instruction_symlink_escape"));
    }

    #[test]
    fn canonical_path_deduplication_skips_a_symlink_alias_to_a_parent_file() {
        let root = TempDir::new().expect("root");
        fs::write(root.path().join(INSTRUCTION_FILE_NAME), "root rules").expect("instructions");
        let child = root.path().join("child");
        fs::create_dir(&child).expect("child");
        symlink_file(
            &root.path().join(INSTRUCTION_FILE_NAME),
            &child.join(INSTRUCTION_FILE_NAME),
        )
        .expect("instruction alias");

        let result = load(vec![project("web", root.path(), Some(&child))]);

        assert_eq!(result.sources.len(), 1);
    }
}
