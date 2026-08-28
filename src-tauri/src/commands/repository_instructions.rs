use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

const INSTRUCTION_FILE_NAME: &str = "AGENTS.md";
const DEFAULT_MAX_FILES: usize = 16;
const ABSOLUTE_MAX_FILES: usize = 32;
const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024;
const ABSOLUTE_MAX_TOTAL_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionProjectInput {
    pub project_id: String,
    pub project_name: String,
    pub root_path: String,
    pub scope_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInstructionLoadInput {
    pub projects: Vec<RepositoryInstructionProjectInput>,
    pub max_files: Option<usize>,
    pub max_total_bytes: Option<usize>,
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
        .all(|(left, right)| component_eq(left, right))
}

fn component_eq(left: &Component<'_>, right: &Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    } else {
        left == right
    }
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

fn discovery_directories(root: &Path, scope: &Path) -> Vec<PathBuf> {
    let relative = scope.strip_prefix(root).unwrap_or_else(|_| Path::new(""));
    let mut directories = vec![root.to_path_buf()];
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        directories.push(current.clone());
    }
    directories
}

fn relative_source_path(root: &Path, source: &Path) -> String {
    source
        .strip_prefix(root)
        .unwrap_or(source)
        .to_string_lossy()
        .replace('\\', "/")
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
    let mut file_limit_reported = false;

    for project in input.projects {
        let (root, scope) = match canonical_project_scope(&project) {
            Ok(scope) => scope,
            Err(problem) => {
                result.issues.push(problem);
                continue;
            }
        };
        let mut seen_paths = HashSet::new();
        for (depth, directory) in discovery_directories(&root, &scope).into_iter().enumerate() {
            let candidate = directory.join(INSTRUCTION_FILE_NAME);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    result.issues.push(issue(
                        &project.project_id,
                        "instruction_metadata_failed",
                        Some(&candidate),
                        format!("Cannot inspect repository instructions: {error}"),
                    ));
                    continue;
                }
            };
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                continue;
            }
            let canonical_source = match fs::canonicalize(&candidate) {
                Ok(path) => path,
                Err(error) => {
                    result.issues.push(issue(
                        &project.project_id,
                        "instruction_unreadable",
                        Some(&candidate),
                        format!("Cannot resolve repository instructions: {error}"),
                    ));
                    continue;
                }
            };
            if !path_is_within(&root, &canonical_source) {
                result.issues.push(issue(
                    &project.project_id,
                    "instruction_symlink_escape",
                    Some(&candidate),
                    "Repository instructions resolve outside the project root.",
                ));
                continue;
            }
            if !seen_paths.insert(canonical_path_key(&canonical_source)) {
                continue;
            }
            if result.sources.len() >= file_limit {
                if !file_limit_reported {
                    result.issues.push(issue(
                        &project.project_id,
                        "file_limit_reached",
                        Some(&candidate),
                        format!("Repository instruction file limit reached: {file_limit}."),
                    ));
                    file_limit_reported = true;
                }
                continue;
            }
            let source_metadata = match fs::metadata(&canonical_source) {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => continue,
            };
            let size_bytes = match usize::try_from(source_metadata.len()) {
                Ok(size) => size,
                Err(_) => usize::MAX,
            };
            if size_bytes > byte_limit.saturating_sub(result.total_bytes) {
                result.issues.push(issue(
                    &project.project_id,
                    "byte_limit_reached",
                    Some(&candidate),
                    format!("Repository instruction byte limit reached: {byte_limit}."),
                ));
                continue;
            }
            let content = match fs::read_to_string(&canonical_source) {
                Ok(content) => content,
                Err(error) => {
                    result.issues.push(issue(
                        &project.project_id,
                        "instruction_read_failed",
                        Some(&candidate),
                        format!("Cannot read repository instructions as UTF-8: {error}"),
                    ));
                    continue;
                }
            };
            let actual_bytes = content.len();
            if actual_bytes > byte_limit.saturating_sub(result.total_bytes) {
                result.issues.push(issue(
                    &project.project_id,
                    "byte_limit_reached",
                    Some(&candidate),
                    format!("Repository instruction byte limit reached: {byte_limit}."),
                ));
                continue;
            }
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
    fn windows_canonical_keys_ignore_case_and_separator_style() {
        let first = canonical_path_key_for_platform(Path::new(r"C:\\Work\\Repo\\AGENTS.md"), true);
        let second = canonical_path_key_for_platform(Path::new(r"c:\\work\\repo\\agents.MD"), true);
        assert_eq!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_instruction_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().expect("root");
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join(INSTRUCTION_FILE_NAME), "outside rules")
            .expect("outside instructions");
        symlink(
            outside.path().join(INSTRUCTION_FILE_NAME),
            root.path().join(INSTRUCTION_FILE_NAME),
        )
        .expect("instruction symlink");

        let result = load(vec![project("web", root.path(), None)]);

        assert!(result.sources.is_empty());
        assert!(result
            .issues
            .iter()
            .any(|problem| problem.code == "instruction_symlink_escape"));
    }

    #[cfg(unix)]
    #[test]
    fn canonical_path_deduplication_skips_the_same_file_reached_through_a_symlinked_scope() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().expect("root");
        fs::write(root.path().join(INSTRUCTION_FILE_NAME), "root rules").expect("instructions");
        let linked_scope = root.path().join("linked");
        symlink(root.path(), &linked_scope).expect("scope symlink");

        let result = load(vec![project("web", root.path(), Some(&linked_scope))]);

        assert_eq!(result.sources.len(), 1);
    }
}
