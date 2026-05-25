use crate::commands::{command_error, CommandResult};
use crate::core::process::background_tokio_command;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

const SKILL_FILE: &str = "SKILL.md";
const AGENTS_SKILLS_DIR: &str = ".agents/skills";
const RESOURCE_MAX_BYTES: u64 = 512 * 1024;
const SCRIPT_OUTPUT_MAX_CHARS: usize = 20_000;
const DEFAULT_SCRIPT_TIMEOUT_MS: u64 = 60_000;
const MAX_SCRIPT_TIMEOUT_MS: u64 = 600_000;
const MAX_DISCOVERY_DEPTH: usize = 6;

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
pub struct SkillManifestDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub root_path: String,
    pub skill_file_path: String,
    pub source: SkillSourceDto,
    pub resources: Vec<SkillResourceDto>,
    pub scripts: Vec<SkillResourceDto>,
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

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Debug)]
struct ParsedSkillFile {
    name: String,
    description: String,
    body: String,
    validation_errors: Vec<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn normalize_skill_name(value: &str, fallback: &str) -> String {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn stable_path_hash(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{:016x}", hash)
}

fn has_hidden_path_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

fn safe_relative_path(path: &str) -> CommandResult<PathBuf> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(command_error("Skill resource path is required."));
    }
    if trimmed.starts_with('/') || trimmed.contains(':') {
        return Err(command_error("Skill resource path must be relative."));
    }

    let mut resolved = PathBuf::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(command_error("Skill resource path cannot contain '..'."));
        }
        resolved.push(part);
    }

    if resolved.as_os_str().is_empty() || has_hidden_path_component(&resolved) {
        return Err(command_error(
            "Hidden skill resource paths are not allowed.",
        ));
    }

    Ok(resolved)
}

fn path_is_inside(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

fn parse_skill_file(skill_file: &Path) -> ParsedSkillFile {
    let mut validation_errors = Vec::new();
    let raw = match fs::read_to_string(skill_file) {
        Ok(value) => value,
        Err(error) => {
            return ParsedSkillFile {
                name: skill_file
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(OsStr::to_str)
                    .unwrap_or("skill")
                    .to_string(),
                description: String::new(),
                body: String::new(),
                validation_errors: vec![format!("Failed to read SKILL.md: {}", error)],
            }
        }
    };

    let mut name = String::new();
    let mut description = String::new();
    let mut body = raw.clone();

    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        let normalized = raw.replace("\r\n", "\n");
        let frontmatter_range = normalized[4..]
            .find("\n---\n")
            .map(|end_index| (4 + end_index, 4 + end_index + "\n---\n".len()))
            .or_else(|| {
                normalized
                    .ends_with("\n---")
                    .then_some((normalized.len() - "\n---".len(), normalized.len()))
            });
        if let Some((frontmatter_end, body_start)) = frontmatter_range {
            let frontmatter = &normalized[4..frontmatter_end];
            body = normalized[body_start..].to_string();
            match serde_yaml::from_str::<SkillFrontmatter>(frontmatter) {
                Ok(parsed) => {
                    name = parsed.name.unwrap_or_default().trim().to_string();
                    description = parsed.description.unwrap_or_default().trim().to_string();
                }
                Err(error) => {
                    validation_errors.push(format!("Invalid SKILL.md frontmatter: {}", error));
                }
            }
        } else {
            validation_errors.push("SKILL.md frontmatter is not closed.".to_string());
        }
    } else {
        validation_errors.push("SKILL.md must start with YAML frontmatter.".to_string());
    }

    if name.is_empty() {
        validation_errors.push("SKILL.md frontmatter must include name.".to_string());
        name = skill_file
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .unwrap_or("skill")
            .to_string();
    }
    if description.is_empty() {
        validation_errors.push("SKILL.md frontmatter must include description.".to_string());
    }

    ParsedSkillFile {
        name,
        description,
        body,
        validation_errors,
    }
}

fn collect_resources(root: &Path, dirname: &str) -> (Vec<SkillResourceDto>, Vec<String>) {
    let mut resources = Vec::new();
    let mut errors = Vec::new();
    let base = root.join(dirname);
    if !base.exists() {
        return (resources, errors);
    }
    let root_canonical = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(error) => {
            errors.push(format!("Failed to canonicalize skill root: {}", error));
            return (resources, errors);
        }
    };

    let mut stack = vec![base];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                errors.push(format!("Failed to read {}: {}", current.display(), error));
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if has_hidden_path_component(relative) {
                continue;
            }

            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    errors.push(format!("Failed to inspect {}: {}", path.display(), error));
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                match fs::canonicalize(&path) {
                    Ok(target) if path_is_inside(&root_canonical, &target) => {}
                    Ok(_) => {
                        errors.push(format!(
                            "Skipped symlink outside skill root: {}",
                            relative.display()
                        ));
                        continue;
                    }
                    Err(error) => {
                        errors.push(format!(
                            "Skipped unreadable symlink {}: {}",
                            relative.display(),
                            error
                        ));
                        continue;
                    }
                }
            }

            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            resources.push(SkillResourceDto {
                path: relative.to_string_lossy().replace('\\', "/"),
                kind: dirname.trim_end_matches('s').to_string(),
                size_bytes: metadata.len(),
            });
        }
    }

    resources.sort_by(|a, b| a.path.cmp(&b.path));
    (resources, errors)
}

fn build_manifest(root: &Path, source: SkillSourceDto) -> SkillManifestDto {
    let skill_file = root.join(SKILL_FILE);
    let parsed = parse_skill_file(&skill_file);
    let normalized_name = normalize_skill_name(
        &parsed.name,
        root.file_name().and_then(OsStr::to_str).unwrap_or("skill"),
    );
    let path_hash = stable_path_hash(&skill_file);
    let id = match source.kind.as_str() {
        "project" => format!(
            "project:{}:{}:{}:{}",
            source.project_id.as_deref().unwrap_or("unknown"),
            source.namespace,
            normalized_name,
            path_hash,
        ),
        _ => format!(
            "global:{}:{}:{}",
            source.namespace, normalized_name, path_hash,
        ),
    };

    let mut validation_errors = parsed.validation_errors;
    let (mut references, reference_errors) = collect_resources(root, "references");
    let (mut assets, asset_errors) = collect_resources(root, "assets");
    let (scripts, script_errors) = collect_resources(root, "scripts");
    validation_errors.extend(reference_errors);
    validation_errors.extend(asset_errors);
    validation_errors.extend(script_errors);
    references.append(&mut assets);

    SkillManifestDto {
        id,
        name: parsed.name,
        description: parsed.description,
        root_path: root.to_string_lossy().to_string(),
        skill_file_path: skill_file.to_string_lossy().to_string(),
        source,
        resources: references,
        scripts,
        is_valid: validation_errors.is_empty(),
        validation_errors,
    }
}

fn discover_skill_roots(base: &Path) -> Vec<PathBuf> {
    let Ok(metadata) = fs::symlink_metadata(base) else {
        return Vec::new();
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Vec::new();
    }

    let mut roots = Vec::new();
    let mut stack = vec![(base.to_path_buf(), 0_usize)];
    while let Some((current, depth)) = stack.pop() {
        let skill_file = current.join(SKILL_FILE);
        if fs::symlink_metadata(&skill_file)
            .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            roots.push(current.clone());
        }
        if depth >= MAX_DISCOVERY_DEPTH {
            continue;
        }

        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(base) else {
                continue;
            };
            if has_hidden_path_component(relative) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                stack.push((path, depth + 1));
            }
        }
    }
    roots.sort();
    roots
}

struct SkillSearchRoot {
    namespace: &'static str,
    path: PathBuf,
}

fn project_skill_search_roots(project_path: &Path) -> Vec<SkillSearchRoot> {
    vec![
        SkillSearchRoot {
            namespace: "agents",
            path: project_path.join(AGENTS_SKILLS_DIR),
        },
        SkillSearchRoot {
            namespace: "codex",
            path: project_path.join(".codex").join("skills"),
        },
        SkillSearchRoot {
            namespace: "opencode",
            path: project_path.join(".opencode").join("skills"),
        },
        SkillSearchRoot {
            namespace: "opencode",
            path: project_path.join(".opencode").join("skill"),
        },
        SkillSearchRoot {
            namespace: "claude",
            path: project_path.join(".claude").join("skills"),
        },
    ]
}

fn global_skill_search_roots(home: &Path) -> Vec<SkillSearchRoot> {
    vec![
        SkillSearchRoot {
            namespace: "agents",
            path: home.join(AGENTS_SKILLS_DIR),
        },
        SkillSearchRoot {
            namespace: "codex",
            path: home.join(".codex").join("skills"),
        },
        SkillSearchRoot {
            namespace: "opencode",
            path: home.join(".config").join("opencode").join("skills"),
        },
        SkillSearchRoot {
            namespace: "opencode",
            path: home.join(".config").join("opencode").join("skill"),
        },
        SkillSearchRoot {
            namespace: "claude",
            path: home.join(".claude").join("skills"),
        },
    ]
}

fn discover_skills(project_roots: &[SkillProjectRootDto]) -> Vec<SkillManifestDto> {
    let mut skills = Vec::new();

    for project in project_roots {
        let project_path = PathBuf::from(&project.path);
        for search_root in project_skill_search_roots(&project_path) {
            for root in discover_skill_roots(&search_root.path) {
                skills.push(build_manifest(
                    &root,
                    SkillSourceDto {
                        kind: "project".to_string(),
                        namespace: search_root.namespace.to_string(),
                        project_id: Some(project.project_id.clone()),
                        project_name: Some(project.project_name.clone()),
                        root_path: project.path.clone(),
                        skill_root_path: search_root.path.to_string_lossy().to_string(),
                    },
                ));
            }
        }
    }

    if let Some(home) = home_dir() {
        for search_root in global_skill_search_roots(&home) {
            for root in discover_skill_roots(&search_root.path) {
                skills.push(build_manifest(
                    &root,
                    SkillSourceDto {
                        kind: "global".to_string(),
                        namespace: search_root.namespace.to_string(),
                        project_id: None,
                        project_name: None,
                        root_path: search_root.path.to_string_lossy().to_string(),
                        skill_root_path: search_root.path.to_string_lossy().to_string(),
                    },
                ));
            }
        }
    }

    skills.sort_by(|a, b| {
        let source_order = match (a.source.kind.as_str(), b.source.kind.as_str()) {
            ("project", "global") => std::cmp::Ordering::Less,
            ("global", "project") => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        };
        source_order
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    skills
}

fn resolve_skill(
    skill_id: &str,
    project_roots: &[SkillProjectRootDto],
) -> CommandResult<SkillManifestDto> {
    discover_skills(project_roots)
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| command_error(format!("Skill not found: {}", skill_id)))
}

fn resolve_resource_path(
    skill: &SkillManifestDto,
    resource_path: &str,
    allowed_roots: &[&str],
) -> CommandResult<PathBuf> {
    let relative = safe_relative_path(resource_path)?;
    let first = relative
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .ok_or_else(|| command_error("Skill resource path is required."))?;
    if !allowed_roots.iter().any(|allowed| first == *allowed) {
        return Err(command_error(format!(
            "Skill resource path must start with one of: {}.",
            allowed_roots.join(", ")
        )));
    }

    let root = fs::canonicalize(&skill.root_path)
        .map_err(|error| command_error(format!("Failed to canonicalize skill root: {}", error)))?;
    let target = root.join(relative);
    let target_canonical = fs::canonicalize(&target)
        .map_err(|error| command_error(format!("Failed to resolve skill resource: {}", error)))?;
    if !path_is_inside(&root, &target_canonical) {
        return Err(command_error(
            "Skill resource resolves outside the skill root.",
        ));
    }
    Ok(target_canonical)
}

fn truncate_chars(value: String, max_chars: usize) -> (String, bool) {
    if value.chars().count() <= max_chars {
        return (value, false);
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n[truncated]");
    (truncated, true)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> CommandResult<()> {
    fs::create_dir_all(destination)
        .map_err(|error| command_error(format!("Failed to create skill destination: {}", error)))?;
    for entry in fs::read_dir(source)
        .map_err(|error| command_error(format!("Failed to read skill source: {}", error)))?
        .flatten()
    {
        let source_path = entry.path();
        let relative = source_path
            .strip_prefix(source)
            .map_err(|error| command_error(error.to_string()))?;
        if has_hidden_path_component(relative) {
            continue;
        }
        let destination_path = destination.join(relative);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| command_error(format!("Failed to inspect skill source: {}", error)))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    command_error(format!(
                        "Failed to create skill destination folder: {}",
                        error
                    ))
                })?;
            }
            fs::copy(&source_path, &destination_path)
                .map_err(|error| command_error(format!("Failed to copy skill file: {}", error)))?;
        }
    }
    Ok(())
}

fn resolve_workspace_cwd(
    workspace_path: Option<String>,
    project_roots: &[SkillProjectRootDto],
) -> CommandResult<PathBuf> {
    let raw_path = workspace_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            command_error("Workspace access was requested but no workspace path was provided.")
        })?;
    let cwd = fs::canonicalize(raw_path)
        .map_err(|error| command_error(format!("Failed to resolve workspace path: {}", error)))?;
    if !cwd.is_dir() {
        return Err(command_error("Workspace path is not a directory."));
    }

    let allowed = project_roots.iter().any(|project| {
        fs::canonicalize(&project.path)
            .map(|project_root| path_is_inside(&project_root, &cwd))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(command_error(
            "Workspace path is not one of the active Macro project roots.",
        ));
    }

    Ok(cwd)
}

#[tauri::command]
pub async fn skills_list(
    project_roots: Vec<SkillProjectRootDto>,
) -> CommandResult<SkillListResponse> {
    Ok(SkillListResponse {
        skills: discover_skills(&project_roots),
    })
}

#[tauri::command]
pub async fn skills_get(
    skill_id: String,
    project_roots: Vec<SkillProjectRootDto>,
) -> CommandResult<SkillDetailResponse> {
    let skill = resolve_skill(&skill_id, &project_roots)?;
    let parsed = parse_skill_file(Path::new(&skill.skill_file_path));
    Ok(SkillDetailResponse {
        skill,
        body: parsed.body,
    })
}

#[tauri::command]
pub async fn skills_read_resource(
    skill_id: String,
    resource_path: String,
    project_roots: Vec<SkillProjectRootDto>,
) -> CommandResult<SkillResourceReadResponse> {
    let skill = resolve_skill(&skill_id, &project_roots)?;
    let path = resolve_resource_path(&skill, &resource_path, &["references", "assets"])?;
    let metadata = fs::metadata(&path)
        .map_err(|error| command_error(format!("Failed to inspect skill resource: {}", error)))?;
    if metadata.len() > RESOURCE_MAX_BYTES {
        return Err(command_error(format!(
            "Skill resource is too large to read ({} bytes).",
            metadata.len()
        )));
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        command_error(format!("Failed to read skill resource as text: {}", error))
    })?;
    Ok(SkillResourceReadResponse {
        skill_id,
        path: resource_path,
        content,
    })
}

#[tauri::command]
pub async fn skills_install_from_local_path(
    source_path: String,
) -> CommandResult<SkillManifestDto> {
    let source = PathBuf::from(source_path.trim());
    if !source.join(SKILL_FILE).is_file() {
        return Err(command_error("Selected folder does not contain SKILL.md."));
    }
    let parsed = parse_skill_file(&source.join(SKILL_FILE));
    if !parsed.validation_errors.is_empty() {
        return Err(command_error(parsed.validation_errors.join(" ")));
    }

    let home =
        home_dir().ok_or_else(|| command_error("Could not resolve the user home directory."))?;
    let destination_base = home.join(AGENTS_SKILLS_DIR);
    let skill_dir_name = normalize_skill_name(
        &parsed.name,
        source
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("skill"),
    );
    let destination = destination_base.join(skill_dir_name);
    if destination.exists() {
        return Err(command_error(format!(
            "A skill already exists at {}.",
            destination.display()
        )));
    }
    copy_dir_recursive(&source, &destination)?;
    Ok(build_manifest(
        &destination,
        SkillSourceDto {
            kind: "global".to_string(),
            namespace: "agents".to_string(),
            project_id: None,
            project_name: None,
            root_path: destination_base.to_string_lossy().to_string(),
            skill_root_path: destination_base.to_string_lossy().to_string(),
        },
    ))
}

#[tauri::command]
pub async fn skills_run_script(
    skill_id: String,
    script_path: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    allow_workspace: bool,
    workspace_path: Option<String>,
    project_roots: Vec<SkillProjectRootDto>,
) -> CommandResult<SkillScriptRunResponse> {
    let skill = resolve_skill(&skill_id, &project_roots)?;
    let script = resolve_resource_path(&skill, &script_path, &["scripts"])?;
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_SCRIPT_TIMEOUT_MS)
        .clamp(1_000, MAX_SCRIPT_TIMEOUT_MS);

    let (program, mut command_args) = match script.extension().and_then(OsStr::to_str) {
        Some("py") => (
            "python3".to_string(),
            vec![script.to_string_lossy().to_string()],
        ),
        Some("js") | Some("mjs") | Some("cjs") => (
            "node".to_string(),
            vec![script.to_string_lossy().to_string()],
        ),
        Some("sh") | Some("bash") => (
            "bash".to_string(),
            vec![script.to_string_lossy().to_string()],
        ),
        _ => (script.to_string_lossy().to_string(), Vec::new()),
    };
    command_args.extend(args);

    let mut temp_run_dir: Option<PathBuf> = None;
    let run_cwd = if allow_workspace {
        resolve_workspace_cwd(workspace_path, &project_roots)?
    } else {
        let path = std::env::temp_dir().join(format!("macro-skill-run-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).map_err(|error| {
            command_error(format!("Failed to create skill run directory: {}", error))
        })?;
        temp_run_dir = Some(path.clone());
        path
    };

    let mut command = background_tokio_command(program);
    command
        .args(command_args)
        .current_dir(run_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    command.kill_on_drop(true);
    if let Ok(path) = std::env::var("PATH") {
        command.env("PATH", path);
    }

    let result = timeout(Duration::from_millis(timeout_ms), command.output()).await;
    let response = match result {
        Ok(Ok(output)) => {
            let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();
            let (stdout, stdout_truncated) = truncate_chars(stdout_raw, SCRIPT_OUTPUT_MAX_CHARS);
            let (stderr, stderr_truncated) = truncate_chars(stderr_raw, SCRIPT_OUTPUT_MAX_CHARS);
            Ok(SkillScriptRunResponse {
                skill_id,
                script_path,
                stdout,
                stderr,
                exit_code: output.status.code(),
                timed_out: false,
                truncated: stdout_truncated || stderr_truncated,
            })
        }
        Ok(Err(error)) => Err(command_error(format!(
            "Failed to run skill script: {}",
            error
        ))),
        Err(_) => Ok(SkillScriptRunResponse {
            skill_id,
            script_path,
            stdout: String::new(),
            stderr: format!("Skill script timed out after {} ms.", timeout_ms),
            exit_code: None,
            timed_out: true,
            truncated: false,
        }),
    };

    if let Some(path) = temp_run_dir {
        let _ = fs::remove_dir_all(path);
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_skill(root: &Path, name: &str) {
        fs::create_dir_all(root).expect("mkdir skill");
        fs::write(
            root.join(SKILL_FILE),
            format!(
                "---\nname: {}\ndescription: Skill {}\n---\n\n# {}\n",
                name, name, name
            ),
        )
        .expect("write skill");
    }

    #[test]
    fn parses_valid_skill_frontmatter() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("example");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: example\ndescription: Does useful work\n---\n\n# Use me\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert_eq!(parsed.name, "example");
        assert_eq!(parsed.description, "Does useful work");
        assert!(parsed.validation_errors.is_empty());
        assert!(parsed.body.contains("# Use me"));
    }

    #[test]
    fn parses_frontmatter_closed_at_eof() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("example");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: eof\ndescription: Closed at EOF\n---",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert_eq!(parsed.name, "eof");
        assert_eq!(parsed.description, "Closed at EOF");
        assert!(parsed.validation_errors.is_empty());
        assert!(parsed.body.is_empty());
    }

    #[test]
    fn reports_invalid_frontmatter_and_required_fields() {
        let dir = tempdir().expect("tempdir");
        let invalid_dir = dir.path().join("invalid");
        fs::create_dir_all(&invalid_dir).expect("mkdir invalid");
        fs::write(
            invalid_dir.join(SKILL_FILE),
            "---\nname: [broken\ndescription: Invalid YAML\n---\n",
        )
        .expect("write invalid");

        let invalid = parse_skill_file(&invalid_dir.join(SKILL_FILE));
        assert!(invalid
            .validation_errors
            .iter()
            .any(|error| error.contains("Invalid SKILL.md frontmatter")));
        assert!(invalid
            .validation_errors
            .iter()
            .any(|error| error.contains("must include name")));

        let missing_dir = dir.path().join("missing");
        fs::create_dir_all(&missing_dir).expect("mkdir missing");
        fs::write(missing_dir.join(SKILL_FILE), "---\nname: missing\n---\n")
            .expect("write missing");

        let missing = parse_skill_file(&missing_dir.join(SKILL_FILE));
        assert!(missing
            .validation_errors
            .iter()
            .any(|error| error.contains("must include description")));
    }

    #[test]
    fn rejects_traversal_resource_paths() {
        assert!(safe_relative_path("../secret").is_err());
        assert!(safe_relative_path("references/../secret").is_err());
        assert!(safe_relative_path("references/.hidden").is_err());
    }

    #[test]
    fn discovers_project_and_global_skills_with_project_precedence() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("local");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: local\ndescription: Project skill\n---\n",
        )
        .expect("write");

        let skills = discover_skills(&[SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }]);
        let local = skills
            .iter()
            .find(|skill| skill.name == "local")
            .expect("local skill");
        assert!(local.id.starts_with("project:p1:agents:local:"));
        assert_eq!(local.source.namespace, "agents");
        assert_eq!(
            local.source.skill_root_path,
            project
                .path()
                .join(AGENTS_SKILLS_DIR)
                .to_string_lossy()
                .to_string()
        );
    }

    #[test]
    fn discovers_codex_opencode_claude_and_agents_project_skill_sources() {
        let project = tempdir().expect("project");
        let sources = [
            ("agents", ".agents/skills", "agent-skill"),
            ("codex", ".codex/skills", "codex-skill"),
            ("opencode", ".opencode/skills", "opencode-skills-skill"),
            ("opencode", ".opencode/skill", "opencode-skill-skill"),
            ("claude", ".claude/skills", "claude-skill"),
        ];
        for (_, root, name) in sources {
            write_skill(&project.path().join(root).join(name), name);
        }

        let skills = discover_skills(&[SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }]);

        for (namespace, _, name) in sources {
            let skill = skills
                .iter()
                .find(|skill| skill.source.kind == "project" && skill.name == name)
                .expect("skill source");
            assert_eq!(skill.source.namespace, namespace);
            assert!(skill
                .id
                .starts_with(&format!("project:p1:{}:{}:", namespace, name)));
        }
    }

    #[test]
    fn discovers_nested_and_root_skill_files_like_codex_and_opencode() {
        let base = tempdir().expect("base");
        write_skill(base.path(), "root-skill");
        write_skill(&base.path().join("nested").join("deep-skill"), "deep-skill");
        fs::create_dir_all(base.path().join(".hidden").join("hidden-skill")).expect("mkdir hidden");
        fs::write(
            base.path()
                .join(".hidden")
                .join("hidden-skill")
                .join(SKILL_FILE),
            "---\nname: hidden-skill\ndescription: Hidden\n---\n",
        )
        .expect("write hidden");

        let roots = discover_skill_roots(base.path());
        assert!(roots.contains(&base.path().to_path_buf()));
        assert!(roots.contains(&base.path().join("nested").join("deep-skill")));
        assert!(!roots.contains(&base.path().join(".hidden").join("hidden-skill")));
    }

    #[test]
    fn lists_codex_opencode_claude_and_agents_global_roots() {
        let home = PathBuf::from("/tmp/macro-home");
        let roots = global_skill_search_roots(&home);
        let paths = roots
            .iter()
            .map(|root| {
                (
                    root.namespace,
                    root.path.to_string_lossy().replace('\\', "/"),
                )
            })
            .collect::<Vec<_>>();

        assert!(paths.contains(&("agents", "/tmp/macro-home/.agents/skills".to_string())));
        assert!(paths.contains(&("codex", "/tmp/macro-home/.codex/skills".to_string())));
        assert!(paths.contains(&(
            "opencode",
            "/tmp/macro-home/.config/opencode/skills".to_string()
        )));
        assert!(paths.contains(&(
            "opencode",
            "/tmp/macro-home/.config/opencode/skill".to_string()
        )));
        assert!(paths.contains(&("claude", "/tmp/macro-home/.claude/skills".to_string())));
    }

    #[test]
    fn resource_resolution_stays_inside_root() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("example");
        fs::create_dir_all(skill_dir.join("references")).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: example\ndescription: Example\n---\n",
        )
        .expect("write");
        fs::write(skill_dir.join("references/info.md"), "hello").expect("write");
        let skill = build_manifest(
            &skill_dir,
            SkillSourceDto {
                kind: "global".to_string(),
                namespace: "agents".to_string(),
                project_id: None,
                project_name: None,
                root_path: dir.path().to_string_lossy().to_string(),
                skill_root_path: dir.path().to_string_lossy().to_string(),
            },
        );
        assert!(resolve_resource_path(&skill, "references/info.md", &["references"]).is_ok());
        assert!(resolve_resource_path(&skill, "scripts/run.sh", &["references"]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_skill_roots_and_rejects_outgoing_resource_symlinks() {
        use std::os::unix::fs::symlink;

        let project = tempdir().expect("project");
        let external = tempdir().expect("external");
        let external_skill = external.path().join("external-skill");
        fs::create_dir_all(external_skill.join("references")).expect("mkdir external");
        fs::write(
            external_skill.join(SKILL_FILE),
            "---\nname: external\ndescription: External\n---\n",
        )
        .expect("write external skill");
        fs::write(external_skill.join("references/info.md"), "outside").expect("write external");

        let skills_dir = project.path().join(AGENTS_SKILLS_DIR);
        fs::create_dir_all(&skills_dir).expect("mkdir skills");
        symlink(&external_skill, skills_dir.join("linked")).expect("symlink root");
        assert!(discover_skill_roots(&skills_dir).is_empty());

        let local_skill = skills_dir.join("local");
        fs::create_dir_all(local_skill.join("references")).expect("mkdir local");
        fs::write(
            local_skill.join(SKILL_FILE),
            "---\nname: local\ndescription: Local\n---\n",
        )
        .expect("write local skill");
        symlink(
            external_skill.join("references/info.md"),
            local_skill.join("references/outside.md"),
        )
        .expect("symlink resource");

        let skill = build_manifest(
            &local_skill,
            SkillSourceDto {
                kind: "project".to_string(),
                namespace: "agents".to_string(),
                project_id: Some("p1".to_string()),
                project_name: Some("Project".to_string()),
                root_path: project.path().to_string_lossy().to_string(),
                skill_root_path: skills_dir.to_string_lossy().to_string(),
            },
        );
        assert!(resolve_resource_path(&skill, "references/outside.md", &["references"]).is_err());
    }

    #[tokio::test]
    async fn test_skill_fixture_can_activate_read_resource_and_run_check_script() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("test-skill");
        fs::create_dir_all(skill_dir.join("references")).expect("mkdir references");
        fs::create_dir_all(skill_dir.join("scripts")).expect("mkdir scripts");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: test-skill\ndescription: Skill de test pour verifier l'activation dans Macro\n---\n\nReponds court.\n",
        )
        .expect("write skill");
        fs::write(
            skill_dir.join("references/style.md"),
            "Regle de reference: utiliser un ton concis.",
        )
        .expect("write reference");
        fs::write(skill_dir.join("scripts/check.sh"), "echo \"script ok\"\n")
            .expect("write script");

        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let discovered = skills_list(project_roots.clone())
            .await
            .expect("skills list");
        let skill_id = discovered
            .skills
            .iter()
            .find(|skill| skill.name == "test-skill")
            .expect("test skill")
            .id
            .clone();
        assert!(skill_id.starts_with("project:p1:agents:test-skill:"));

        let detail = skills_get(skill_id.clone(), project_roots.clone())
            .await
            .expect("skill detail");
        assert_eq!(detail.skill.name, "test-skill");
        assert!(detail.body.contains("Reponds court"));

        let resource = skills_read_resource(
            skill_id.clone(),
            "references/style.md".to_string(),
            project_roots.clone(),
        )
        .await
        .expect("resource");
        assert!(resource.content.contains("ton concis"));

        let script = skills_run_script(
            skill_id,
            "scripts/check.sh".to_string(),
            vec![],
            Some(5_000),
            false,
            None,
            project_roots,
        )
        .await
        .expect("script");
        assert_eq!(script.exit_code, Some(0));
        assert_eq!(script.stdout.trim(), "script ok");
    }

    #[tokio::test]
    async fn script_runs_are_timed_out_and_truncated() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("runner");
        fs::create_dir_all(skill_dir.join("scripts")).expect("mkdir scripts");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: runner\ndescription: Runs local scripts\n---\n",
        )
        .expect("write skill");
        fs::write(skill_dir.join("scripts/slow.sh"), "sleep 2\n").expect("write slow");
        fs::write(
            skill_dir.join("scripts/noisy.sh"),
            "printf 'x%.0s' {1..21050}\n",
        )
        .expect("write noisy");
        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let discovered = skills_list(project_roots.clone())
            .await
            .expect("skills list");
        let skill_id = discovered
            .skills
            .iter()
            .find(|skill| skill.name == "runner")
            .expect("runner skill")
            .id
            .clone();

        let timed_out = skills_run_script(
            skill_id.clone(),
            "scripts/slow.sh".to_string(),
            vec![],
            Some(1_000),
            false,
            None,
            project_roots.clone(),
        )
        .await
        .expect("timeout response");
        assert!(timed_out.timed_out);
        assert!(timed_out.stderr.contains("timed out"));

        let truncated = skills_run_script(
            skill_id,
            "scripts/noisy.sh".to_string(),
            vec![],
            Some(5_000),
            false,
            None,
            project_roots,
        )
        .await
        .expect("truncated response");
        assert!(!truncated.timed_out);
        assert!(truncated.truncated);
        assert!(truncated.stdout.ends_with("[truncated]"));
    }
}
