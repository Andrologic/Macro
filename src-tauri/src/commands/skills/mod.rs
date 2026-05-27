use crate::commands::{command_error, CommandResult};
use crate::core::process::background_tokio_command;
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::time::timeout;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

mod cache;
mod types;

use cache::load_skill_catalog;
pub use types::*;

const SKILL_FILE: &str = "SKILL.md";
const LOWERCASE_SKILL_FILE: &str = "skill.md";
const AGENTS_SKILLS_DIR: &str = ".agents/skills";
const RESOURCE_MAX_BYTES: u64 = 512 * 1024;
const SCRIPT_OUTPUT_MAX_CHARS: usize = 20_000;
const DEFAULT_SCRIPT_TIMEOUT_MS: u64 = 60_000;
const MAX_SCRIPT_TIMEOUT_MS: u64 = 600_000;
const MAX_DISCOVERY_DEPTH: usize = 6;
const MAX_DISCOVERY_DIRS: usize = 2_000;
const MAX_SKILL_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;
const MAX_COMPATIBILITY_LENGTH: usize = 500;

const FRONTMATTER_FIELDS: &[&str] = &[
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
];

#[derive(Debug)]
struct ParsedSkillFile {
    name: String,
    description: String,
    license: Option<String>,
    compatibility: Option<String>,
    allowed_tools: Option<String>,
    metadata: BTreeMap<String, String>,
    body: String,
    diagnostics: Vec<SkillDiagnosticDto>,
    spec_compliant: bool,
    is_valid: bool,
    content_hash: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn skill_diagnostic(severity: &str, code: &str, message: impl Into<String>) -> SkillDiagnosticDto {
    SkillDiagnosticDto {
        severity: severity.to_string(),
        code: code.to_string(),
        message: message.into(),
    }
}

fn stable_string_hash(value: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{:016x}", hash)
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
    stable_string_hash(&normalized)
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

fn path_has_ignored_discovery_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => {
            let name = value.to_string_lossy();
            name == ".git" || name == "node_modules"
        }
        _ => false,
    })
}

fn find_skill_file(root: &Path) -> Option<(PathBuf, bool)> {
    let upper = root.join(SKILL_FILE);
    if fs::symlink_metadata(&upper)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Some((upper, false));
    }

    let lower = root.join(LOWERCASE_SKILL_FILE);
    if fs::symlink_metadata(&lower)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Some((lower, true));
    }

    None
}

fn mapping_get<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Value> {
    mapping.get(&Value::String(key.to_string()))
}

fn yaml_value_to_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .trim_start_matches("---")
            .trim()
            .to_string(),
    }
}

fn normalize_nfkc(value: &str) -> String {
    value.nfkc().collect::<String>()
}

fn validate_frontmatter_fields(mapping: &Mapping, diagnostics: &mut Vec<SkillDiagnosticDto>) {
    for key in mapping.keys() {
        let key_string = yaml_value_to_string(key).trim().to_string();
        if key_string.is_empty() {
            diagnostics.push(skill_diagnostic(
                "warning",
                "unexpected_frontmatter_field",
                "SKILL.md frontmatter contains an empty or non-string field name.",
            ));
            continue;
        }
        if !FRONTMATTER_FIELDS.contains(&key_string.as_str()) {
            diagnostics.push(skill_diagnostic(
                "warning",
                "unexpected_frontmatter_field",
                format!(
                    "Unexpected field in SKILL.md frontmatter: {}. Only {} are defined by AgentSkills.",
                    key_string,
                    FRONTMATTER_FIELDS.join(", ")
                ),
            ));
        }
    }
}

fn required_string_field(
    mapping: &Mapping,
    key: &str,
    diagnostics: &mut Vec<SkillDiagnosticDto>,
) -> Option<String> {
    match mapping_get(mapping, key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Some(Value::String(_)) | None => {
            diagnostics.push(skill_diagnostic(
                "error",
                "missing_required_field",
                format!("SKILL.md frontmatter must include non-empty {}.", key),
            ));
            None
        }
        Some(_) => {
            diagnostics.push(skill_diagnostic(
                "error",
                "invalid_required_field",
                format!("SKILL.md frontmatter field '{}' must be a string.", key),
            ));
            None
        }
    }
}

fn optional_string_field(
    mapping: &Mapping,
    key: &str,
    diagnostics: &mut Vec<SkillDiagnosticDto>,
) -> Option<String> {
    match mapping_get(mapping, key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Some(Value::String(_)) | None => None,
        Some(_) => {
            diagnostics.push(skill_diagnostic(
                "warning",
                "invalid_optional_field",
                format!("SKILL.md frontmatter field '{}' should be a string.", key),
            ));
            None
        }
    }
}

fn parse_metadata_field(
    mapping: &Mapping,
    diagnostics: &mut Vec<SkillDiagnosticDto>,
) -> BTreeMap<String, String> {
    let Some(value) = mapping_get(mapping, "metadata") else {
        return BTreeMap::new();
    };

    let Value::Mapping(metadata) = value else {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_metadata",
            "SKILL.md frontmatter field 'metadata' should be a mapping.",
        ));
        return BTreeMap::new();
    };

    let mut result = BTreeMap::new();
    for (key, value) in metadata {
        let key = yaml_value_to_string(key).trim().to_string();
        if key.is_empty() {
            diagnostics.push(skill_diagnostic(
                "warning",
                "invalid_metadata_key",
                "SKILL.md metadata contains an empty key.",
            ));
            continue;
        }
        result.insert(key, yaml_value_to_string(value));
    }
    result
}

fn value_looks_quoted(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('"')
        || trimmed.starts_with('\'')
        || trimmed.starts_with('|')
        || trimmed.starts_with('>')
}

fn repair_unquoted_colon_values(frontmatter: &str) -> Option<String> {
    let mut changed = false;
    let mut repaired = Vec::new();

    for line in frontmatter.lines() {
        let trimmed = line.trim_start();
        let is_top_level = line.len() == trimmed.len();
        let Some((key, value)) = trimmed.split_once(':') else {
            repaired.push(line.to_string());
            continue;
        };
        let key = key.trim();
        let value = value.trim_start();
        let can_repair = is_top_level
            && FRONTMATTER_FIELDS.contains(&key)
            && !value.is_empty()
            && value.contains(": ")
            && !value_looks_quoted(value);
        if can_repair {
            repaired.push(format!("{}: |-", key));
            repaired.push(format!("  {}", value));
            changed = true;
        } else {
            repaired.push(line.to_string());
        }
    }

    changed.then(|| repaired.join("\n"))
}

fn parse_frontmatter_mapping(
    frontmatter: &str,
    diagnostics: &mut Vec<SkillDiagnosticDto>,
) -> Option<Mapping> {
    match serde_yaml::from_str::<Mapping>(frontmatter) {
        Ok(mapping) => Some(mapping),
        Err(first_error) => {
            if let Some(repaired) = repair_unquoted_colon_values(frontmatter) {
                if let Ok(mapping) = serde_yaml::from_str::<Mapping>(&repaired) {
                    diagnostics.push(skill_diagnostic(
                        "warning",
                        "frontmatter_repaired",
                        "SKILL.md frontmatter used an unquoted colon value; Macro repaired it for compatibility.",
                    ));
                    return Some(mapping);
                }
            }
            diagnostics.push(skill_diagnostic(
                "error",
                "invalid_frontmatter",
                format!("Invalid SKILL.md frontmatter: {}", first_error),
            ));
            None
        }
    }
}

fn validate_skill_name(name: &str, skill_dir: &Path, diagnostics: &mut Vec<SkillDiagnosticDto>) {
    let normalized_name = normalize_nfkc(name.trim());
    if normalized_name.chars().count() > MAX_SKILL_NAME_LENGTH {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_name",
            format!(
                "Skill name '{}' exceeds the {} character limit.",
                name, MAX_SKILL_NAME_LENGTH
            ),
        ));
    }
    if normalized_name != normalized_name.to_lowercase() {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_name",
            format!("Skill name '{}' must be lowercase.", name),
        ));
    }
    if normalized_name.starts_with('-') || normalized_name.ends_with('-') {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_name",
            "Skill name cannot start or end with a hyphen.",
        ));
    }
    if normalized_name.contains("--") {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_name",
            "Skill name cannot contain consecutive hyphens.",
        ));
    }
    if !normalized_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-')
    {
        diagnostics.push(skill_diagnostic(
            "warning",
            "invalid_name",
            format!(
                "Skill name '{}' contains invalid characters. Only lowercase Unicode letters, digits, and hyphens are allowed.",
                name
            ),
        ));
    }
    let dir_name = skill_dir
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let normalized_dir_name = normalize_nfkc(dir_name);
    if !normalized_dir_name.is_empty() && normalized_dir_name != normalized_name {
        diagnostics.push(skill_diagnostic(
            "warning",
            "directory_name_mismatch",
            format!(
                "Directory name '{}' should match skill name '{}'.",
                dir_name, name
            ),
        ));
    }
}

fn parse_skill_file(skill_file: &Path) -> ParsedSkillFile {
    let used_lowercase_file = skill_file
        .file_name()
        .and_then(OsStr::to_str)
        .map(|name| name == LOWERCASE_SKILL_FILE)
        .unwrap_or(false);
    let fallback_name = skill_file
        .parent()
        .and_then(Path::file_name)
        .and_then(OsStr::to_str)
        .unwrap_or("skill")
        .to_string();
    let mut diagnostics = Vec::new();
    let raw = match fs::read_to_string(skill_file) {
        Ok(value) => value,
        Err(error) => {
            diagnostics.push(skill_diagnostic(
                "error",
                "skill_file_read_failed",
                format!("Failed to read SKILL.md: {}", error),
            ));
            return ParsedSkillFile {
                name: fallback_name,
                description: String::new(),
                license: None,
                compatibility: None,
                allowed_tools: None,
                metadata: BTreeMap::new(),
                body: String::new(),
                diagnostics,
                spec_compliant: false,
                is_valid: false,
                content_hash: String::new(),
            };
        }
    };

    let mut name = String::new();
    let mut description = String::new();
    let mut license = None;
    let mut compatibility = None;
    let mut allowed_tools = None;
    let mut metadata = BTreeMap::new();
    let normalized = raw.replace("\r\n", "\n");
    let mut body = normalized.clone();

    if normalized.starts_with("---\n") {
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
            if let Some(mapping) = parse_frontmatter_mapping(frontmatter, &mut diagnostics) {
                validate_frontmatter_fields(&mapping, &mut diagnostics);
                name = required_string_field(&mapping, "name", &mut diagnostics)
                    .unwrap_or_else(|| fallback_name.clone());
                description = required_string_field(&mapping, "description", &mut diagnostics)
                    .unwrap_or_default();
                license = optional_string_field(&mapping, "license", &mut diagnostics);
                compatibility = optional_string_field(&mapping, "compatibility", &mut diagnostics);
                allowed_tools = optional_string_field(&mapping, "allowed-tools", &mut diagnostics);
                metadata = parse_metadata_field(&mapping, &mut diagnostics);
            }
        } else {
            diagnostics.push(skill_diagnostic(
                "error",
                "frontmatter_not_closed",
                "SKILL.md frontmatter is not closed.",
            ));
        }
    } else {
        diagnostics.push(skill_diagnostic(
            "error",
            "frontmatter_missing",
            "SKILL.md must start with YAML frontmatter.",
        ));
    }

    if name.is_empty() {
        diagnostics.push(skill_diagnostic(
            "error",
            "missing_required_field",
            "SKILL.md frontmatter must include non-empty name.",
        ));
        name = fallback_name.clone();
    }
    if description.is_empty() {
        let already_reported = diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "missing_required_field"
                && diagnostic.message.contains("description")
        });
        if !already_reported {
            diagnostics.push(skill_diagnostic(
                "error",
                "missing_required_field",
                "SKILL.md frontmatter must include non-empty description.",
            ));
        }
    }

    if used_lowercase_file {
        diagnostics.push(skill_diagnostic(
            "warning",
            "lowercase_skill_file",
            "Found skill.md. Use SKILL.md for AgentSkills spec compliance.",
        ));
    }
    validate_skill_name(
        &name,
        skill_file.parent().unwrap_or_else(|| Path::new("")),
        &mut diagnostics,
    );
    if description.len() > MAX_DESCRIPTION_LENGTH {
        diagnostics.push(skill_diagnostic(
            "warning",
            "description_too_long",
            format!(
                "Skill description exceeds the {} character limit.",
                MAX_DESCRIPTION_LENGTH
            ),
        ));
    }
    if compatibility
        .as_ref()
        .map(|value| value.len() > MAX_COMPATIBILITY_LENGTH)
        .unwrap_or(false)
    {
        diagnostics.push(skill_diagnostic(
            "warning",
            "compatibility_too_long",
            format!(
                "Skill compatibility exceeds the {} character limit.",
                MAX_COMPATIBILITY_LENGTH
            ),
        ));
    }
    let is_valid = diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != "error");
    let spec_compliant = diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != "error" && diagnostic.severity != "warning");

    ParsedSkillFile {
        name,
        description,
        license,
        compatibility,
        allowed_tools,
        metadata,
        body,
        diagnostics,
        spec_compliant,
        is_valid,
        content_hash: stable_string_hash(&raw),
    }
}

fn collect_resources(
    root: &Path,
    dirname: &str,
) -> (Vec<SkillResourceDto>, Vec<SkillDiagnosticDto>) {
    let mut resources = Vec::new();
    let mut diagnostics = Vec::new();
    let base = root.join(dirname);
    if !base.exists() {
        return (resources, diagnostics);
    }
    let root_canonical = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(error) => {
            diagnostics.push(skill_diagnostic(
                "error",
                "skill_root_unreadable",
                format!("Failed to canonicalize skill root: {}", error),
            ));
            return (resources, diagnostics);
        }
    };

    let mut stack = vec![base];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                diagnostics.push(skill_diagnostic(
                    "warning",
                    "resource_scan_failed",
                    format!("Failed to read {}: {}", current.display(), error),
                ));
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
                    diagnostics.push(skill_diagnostic(
                        "warning",
                        "resource_scan_failed",
                        format!("Failed to inspect {}: {}", path.display(), error),
                    ));
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                match fs::canonicalize(&path) {
                    Ok(target) if path_is_inside(&root_canonical, &target) => {}
                    Ok(_) => {
                        diagnostics.push(skill_diagnostic(
                            "warning",
                            "resource_symlink_outside_root",
                            format!("Skipped symlink outside skill root: {}", relative.display()),
                        ));
                        continue;
                    }
                    Err(error) => {
                        diagnostics.push(skill_diagnostic(
                            "warning",
                            "resource_symlink_unreadable",
                            format!(
                                "Skipped unreadable symlink {}: {}",
                                relative.display(),
                                error
                            ),
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
    (resources, diagnostics)
}

fn build_manifest(root: &Path, source: SkillSourceDto) -> SkillManifestDto {
    let (skill_file, _) = find_skill_file(root).unwrap_or_else(|| (root.join(SKILL_FILE), false));
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

    let mut diagnostics = parsed.diagnostics;
    let (mut references, reference_errors) = collect_resources(root, "references");
    let (mut assets, asset_errors) = collect_resources(root, "assets");
    let (scripts, script_errors) = collect_resources(root, "scripts");
    diagnostics.extend(reference_errors);
    diagnostics.extend(asset_errors);
    diagnostics.extend(script_errors);
    references.append(&mut assets);
    let validation_errors = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == "error")
        .map(|diagnostic| diagnostic.message.clone())
        .collect::<Vec<_>>();
    let is_valid = parsed.is_valid
        && diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != "error");

    SkillManifestDto {
        id,
        name: parsed.name,
        description: parsed.description,
        license: parsed.license,
        compatibility: parsed.compatibility,
        allowed_tools: parsed.allowed_tools,
        metadata: parsed.metadata,
        root_path: root.to_string_lossy().to_string(),
        skill_file_path: skill_file.to_string_lossy().to_string(),
        location: SkillLocationDto {
            kind: "local".to_string(),
            uri: root.to_string_lossy().to_string(),
        },
        source,
        resources: references,
        scripts,
        diagnostics,
        spec_compliant: parsed.spec_compliant,
        shadowed_by_skill_id: None,
        content_hash: parsed.content_hash,
        validation_errors,
        is_valid,
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
    let mut visited_dirs = 0_usize;
    let mut stack = vec![(base.to_path_buf(), 0_usize)];
    while let Some((current, depth)) = stack.pop() {
        visited_dirs += 1;
        if visited_dirs > MAX_DISCOVERY_DIRS {
            break;
        }
        if find_skill_file(&current).is_some() {
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
            if path_has_ignored_discovery_component(relative) {
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
            namespace: "opencode",
            path: home.join(".opencode").join("skills"),
        },
        SkillSearchRoot {
            namespace: "opencode",
            path: home.join(".opencode").join("skill"),
        },
        SkillSearchRoot {
            namespace: "claude",
            path: home.join(".claude").join("skills"),
        },
    ]
}

fn namespace_precedence(namespace: &str) -> u8 {
    match namespace {
        "agents" => 0,
        "codex" => 1,
        "opencode" => 2,
        "claude" => 3,
        _ => 4,
    }
}

fn source_precedence(kind: &str) -> u8 {
    match kind {
        "project" => 0,
        "global" => 1,
        _ => 2,
    }
}

fn skill_collision_key(skill: &SkillManifestDto) -> String {
    normalize_nfkc(skill.name.trim()).to_lowercase()
}

fn skill_collision_rank(skill: &SkillManifestDto) -> (u8, u8, String, String) {
    (
        source_precedence(&skill.source.kind),
        namespace_precedence(&skill.source.namespace),
        skill.root_path.clone(),
        skill.id.clone(),
    )
}

fn resolve_skill_collisions(skills: &mut [SkillManifestDto]) {
    let mut skills_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, skill) in skills.iter().enumerate() {
        let key = skill_collision_key(skill);
        if key.is_empty() {
            continue;
        }
        skills_by_name.entry(key).or_default().push(index);
    }

    for indexes in skills_by_name.values() {
        if indexes.len() <= 1 {
            continue;
        }

        let winner_index = indexes
            .iter()
            .copied()
            .filter(|index| skills[*index].is_valid)
            .min_by_key(|index| skill_collision_rank(&skills[*index]))
            .or_else(|| {
                indexes
                    .iter()
                    .copied()
                    .min_by_key(|index| skill_collision_rank(&skills[*index]))
            });

        let Some(winner_index) = winner_index else {
            continue;
        };
        let winner_id = skills[winner_index].id.clone();
        let winner_label = format!(
            "{}/{}",
            skills[winner_index].source.kind, skills[winner_index].source.namespace
        );
        for index in indexes {
            if *index == winner_index {
                continue;
            }
            let skill = &mut skills[*index];
            skill.shadowed_by_skill_id = Some(winner_id.clone());
            skill.diagnostics.push(skill_diagnostic(
                "warning",
                "shadowed_skill",
                format!(
                    "Another skill named '{}' wins by precedence ({}). Select this skill by exact id to use it.",
                    skill.name, winner_label
                ),
            ));
        }
    }
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

    resolve_skill_collisions(&mut skills);
    skills.sort_by(|a, b| {
        let source_order = match (a.source.kind.as_str(), b.source.kind.as_str()) {
            ("project", "global") => std::cmp::Ordering::Less,
            ("global", "project") => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        };
        source_order
            .then_with(|| {
                namespace_precedence(&a.source.namespace)
                    .cmp(&namespace_precedence(&b.source.namespace))
            })
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.root_path.cmp(&b.root_path))
            .then_with(|| a.id.cmp(&b.id))
    });
    skills
}

fn resolve_skill(
    skill_id: &str,
    project_roots: &[SkillProjectRootDto],
) -> CommandResult<SkillManifestDto> {
    load_skill_catalog(project_roots, false)
        .skills_by_id
        .get(skill_id)
        .cloned()
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
        skills: load_skill_catalog(&project_roots, true).skills,
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
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| command_error(format!("Failed to inspect selected folder: {}", error)))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(command_error("Selected path must be a real skill folder."));
    }
    if !source.join(SKILL_FILE).is_file() {
        return Err(command_error("Selected folder does not contain SKILL.md."));
    }
    let parsed = parse_skill_file(&source.join(SKILL_FILE));
    if !parsed.is_valid || !parsed.spec_compliant {
        let details = parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
            .collect::<Vec<_>>()
            .join(" ");
        return Err(command_error(format!(
            "Selected skill is not AgentSkills spec-compliant. {}",
            details
        )));
    }

    let home =
        home_dir().ok_or_else(|| command_error("Could not resolve the user home directory."))?;
    let destination_base = home.join(AGENTS_SKILLS_DIR);
    let destination = destination_base.join(&parsed.name);
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
        assert!(parsed.diagnostics.is_empty());
        assert!(parsed.spec_compliant);
        assert!(parsed.is_valid);
        assert!(parsed.body.contains("# Use me"));
    }

    #[test]
    fn parses_frontmatter_closed_at_eof() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("eof");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: eof\ndescription: Closed at EOF\n---",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert_eq!(parsed.name, "eof");
        assert_eq!(parsed.description, "Closed at EOF");
        assert!(parsed.diagnostics.is_empty());
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
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "invalid_frontmatter"));
        assert!(invalid
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("non-empty name")));

        let missing_dir = dir.path().join("missing");
        fs::create_dir_all(&missing_dir).expect("mkdir missing");
        fs::write(missing_dir.join(SKILL_FILE), "---\nname: missing\n---\n")
            .expect("write missing");

        let missing = parse_skill_file(&missing_dir.join(SKILL_FILE));
        assert!(missing
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("non-empty description")));
        assert!(!missing.is_valid);
    }

    #[test]
    fn parses_optional_agentskills_fields_and_metadata() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("example");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: example\ndescription: \"Does: useful work\"\nlicense: MIT\ncompatibility: codex cloud\nallowed-tools: bash, web\nmetadata:\n  provider: macro\n  version: 1\n---\n\nBody\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert_eq!(parsed.license.as_deref(), Some("MIT"));
        assert_eq!(parsed.compatibility.as_deref(), Some("codex cloud"));
        assert_eq!(parsed.allowed_tools.as_deref(), Some("bash, web"));
        assert_eq!(
            parsed.metadata.get("provider").map(String::as_str),
            Some("macro")
        );
        assert_eq!(
            parsed.metadata.get("version").map(String::as_str),
            Some("1")
        );
        assert!(parsed.spec_compliant);
    }

    #[test]
    fn unexpected_frontmatter_fields_are_lenient_warnings() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("example");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: example\ndescription: Has extra metadata\nunknown_field: value\n---\n\nBody\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert!(parsed.is_valid);
        assert!(!parsed.spec_compliant);
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "unexpected_frontmatter_field"));
    }

    #[test]
    fn accepts_unicode_lowercase_skill_names_like_skills_ref() {
        let dir = tempdir().expect("tempdir");
        let chinese_dir = dir.path().join("技能");
        fs::create_dir_all(&chinese_dir).expect("mkdir chinese");
        fs::write(
            chinese_dir.join(SKILL_FILE),
            "---\nname: 技能\ndescription: Unicode skill name\n---\n",
        )
        .expect("write chinese");

        let chinese = parse_skill_file(&chinese_dir.join(SKILL_FILE));
        assert!(chinese.is_valid);
        assert!(chinese.spec_compliant);

        let russian_dir = dir.path().join("мой-навык");
        fs::create_dir_all(&russian_dir).expect("mkdir russian");
        fs::write(
            russian_dir.join(SKILL_FILE),
            "---\nname: мой-навык\ndescription: Unicode skill name\n---\n",
        )
        .expect("write russian");

        let russian = parse_skill_file(&russian_dir.join(SKILL_FILE));
        assert!(russian.is_valid);
        assert!(russian.spec_compliant);
    }

    #[test]
    fn validates_unicode_lowercase_and_nfkc_directory_match() {
        let dir = tempdir().expect("tempdir");
        let composed = "café";
        let decomposed = "cafe\u{0301}";
        let skill_dir = dir.path().join(composed);
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            format!(
                "---\nname: {}\ndescription: Normalized name\n---\n",
                decomposed
            ),
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert!(parsed.is_valid);
        assert!(parsed.spec_compliant);

        let uppercase_dir = dir.path().join("НАВЫК");
        fs::create_dir_all(&uppercase_dir).expect("mkdir uppercase");
        fs::write(
            uppercase_dir.join(SKILL_FILE),
            "---\nname: НАВЫК\ndescription: Uppercase Unicode name\n---\n",
        )
        .expect("write uppercase");
        let uppercase = parse_skill_file(&uppercase_dir.join(SKILL_FILE));
        assert!(uppercase.is_valid);
        assert!(!uppercase.spec_compliant);
        assert!(uppercase
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("lowercase")));
    }

    #[test]
    fn accepts_lowercase_skill_file_with_warning() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("lowercase");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(LOWERCASE_SKILL_FILE),
            "---\nname: lowercase\ndescription: Compatibility filename\n---\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(LOWERCASE_SKILL_FILE));
        assert!(parsed.is_valid);
        assert!(!parsed.spec_compliant);
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "lowercase_skill_file"));
        assert!(discover_skill_roots(dir.path()).contains(&skill_dir));
    }

    #[test]
    fn leniently_repairs_unquoted_colon_values() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("repair");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: repair\ndescription: Use this when input has: a colon\n---\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert!(parsed.is_valid);
        assert!(!parsed.spec_compliant);
        assert_eq!(parsed.description, "Use this when input has: a colon");
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "frontmatter_repaired"));
    }

    #[test]
    fn invalid_names_are_loadable_but_not_spec_compliant() {
        let dir = tempdir().expect("tempdir");
        let skill_dir = dir.path().join("Bad_Name");
        fs::create_dir_all(&skill_dir).expect("mkdir");
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: Bad_Name\ndescription: Invalid name but readable\n---\n",
        )
        .expect("write");

        let parsed = parse_skill_file(&skill_dir.join(SKILL_FILE));
        assert!(parsed.is_valid);
        assert!(!parsed.spec_compliant);
        assert!(parsed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "invalid_name"));
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
    fn resolves_collisions_with_deterministic_source_precedence() {
        let project = tempdir().expect("project");
        write_skill(&project.path().join(AGENTS_SKILLS_DIR).join("docs"), "docs");
        write_skill(
            &project.path().join(".codex").join("skills").join("docs"),
            "docs",
        );

        let skills = discover_skills(&[SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }]);
        let agents = skills
            .iter()
            .find(|skill| skill.name == "docs" && skill.source.namespace == "agents")
            .expect("agents docs");
        let codex = skills
            .iter()
            .find(|skill| skill.name == "docs" && skill.source.namespace == "codex")
            .expect("codex docs");

        assert!(agents.shadowed_by_skill_id.is_none());
        assert_eq!(
            codex.shadowed_by_skill_id.as_deref(),
            Some(agents.id.as_str())
        );
        assert!(codex
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "shadowed_skill"));
    }

    #[test]
    fn resolves_collisions_after_unicode_nfkc_normalization() {
        let project = tempdir().expect("project");
        let composed = "café";
        let decomposed = "cafe\u{0301}";
        write_skill(
            &project.path().join(AGENTS_SKILLS_DIR).join(composed),
            decomposed,
        );
        write_skill(
            &project.path().join(".codex").join("skills").join(composed),
            composed,
        );

        let skills = discover_skills(&[SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }]);
        let agents = skills
            .iter()
            .find(|skill| skill.source.namespace == "agents")
            .expect("agents skill");
        let codex = skills
            .iter()
            .find(|skill| skill.source.namespace == "codex")
            .expect("codex skill");

        assert!(agents.shadowed_by_skill_id.is_none());
        assert_eq!(
            codex.shadowed_by_skill_id.as_deref(),
            Some(agents.id.as_str())
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
        assert!(paths.contains(&("opencode", "/tmp/macro-home/.opencode/skills".to_string())));
        assert!(paths.contains(&("opencode", "/tmp/macro-home/.opencode/skill".to_string())));
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
    async fn cached_catalog_invalidates_when_skill_file_changes() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("docs");
        write_skill(&skill_dir, "docs");
        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let listed = skills_list(project_roots.clone()).await.expect("list");
        let skill_id = listed
            .skills
            .iter()
            .find(|skill| skill.name == "docs")
            .expect("docs")
            .id
            .clone();

        std::thread::sleep(Duration::from_millis(10));
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: docs\ndescription: Updated docs skill\n---\n\nUpdated body\n",
        )
        .expect("rewrite skill");

        let detail = skills_get(skill_id, project_roots).await.expect("detail");
        assert_eq!(detail.skill.description, "Updated docs skill");
        assert!(detail.body.contains("Updated body"));
    }

    #[tokio::test]
    async fn cached_catalog_invalidates_when_skill_disappears() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("docs");
        write_skill(&skill_dir, "docs");
        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let listed = skills_list(project_roots.clone()).await.expect("list");
        let skill_id = listed.skills[0].id.clone();
        std::thread::sleep(Duration::from_millis(10));
        fs::remove_dir_all(&skill_dir).expect("remove skill");

        let result = skills_get(skill_id, project_roots).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn cached_catalog_invalidates_when_resource_directory_changes() {
        let project = tempdir().expect("project");
        let skill_dir = project.path().join(AGENTS_SKILLS_DIR).join("docs");
        write_skill(&skill_dir, "docs");
        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let listed = skills_list(project_roots.clone()).await.expect("list");
        let skill_id = listed.skills[0].id.clone();
        std::thread::sleep(Duration::from_millis(10));
        fs::create_dir_all(skill_dir.join("references")).expect("mkdir references");
        fs::write(skill_dir.join("references/new.md"), "new resource").expect("write resource");

        let detail = skills_get(skill_id, project_roots).await.expect("detail");
        assert!(detail
            .skill
            .resources
            .iter()
            .any(|resource| resource.path == "references/new.md"));
    }

    #[tokio::test]
    async fn skills_list_refreshes_catalog_for_added_skills() {
        let project = tempdir().expect("project");
        write_skill(&project.path().join(AGENTS_SKILLS_DIR).join("one"), "one");
        let project_roots = vec![SkillProjectRootDto {
            project_id: "p1".to_string(),
            project_name: "Project".to_string(),
            path: project.path().to_string_lossy().to_string(),
        }];

        let first = skills_list(project_roots.clone())
            .await
            .expect("first list");
        assert!(first.skills.iter().any(|skill| {
            skill.source.kind == "project"
                && skill.source.project_id.as_deref() == Some("p1")
                && skill.name == "one"
        }));
        assert!(!first.skills.iter().any(|skill| {
            skill.source.kind == "project"
                && skill.source.project_id.as_deref() == Some("p1")
                && skill.name == "two"
        }));
        std::thread::sleep(Duration::from_millis(10));
        write_skill(&project.path().join(AGENTS_SKILLS_DIR).join("two"), "two");

        let second = skills_list(project_roots).await.expect("second list");
        assert!(second.skills.iter().any(|skill| {
            skill.source.kind == "project"
                && skill.source.project_id.as_deref() == Some("p1")
                && skill.name == "one"
        }));
        assert!(second.skills.iter().any(|skill| {
            skill.source.kind == "project"
                && skill.source.project_id.as_deref() == Some("p1")
                && skill.name == "two"
        }));
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
