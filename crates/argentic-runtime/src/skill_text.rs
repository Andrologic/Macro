//! Shared parser for already admitted SKILL.md bytes. No filesystem access.
use serde_yaml::{Mapping, Value};
use std::{collections::BTreeMap, ffi::OsStr, path::Path};
use unicode_normalization::UnicodeNormalization;
#[derive(Debug)]
pub struct SkillDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
}
const LOWERCASE_SKILL_FILE: &str = "skill.md";
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
pub struct ParsedSkillFile {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub body: String,
    pub diagnostics: Vec<SkillDiagnostic>,
    pub spec_compliant: bool,
    pub is_valid: bool,
}

fn skill_diagnostic(severity: &str, code: &str, message: impl Into<String>) -> SkillDiagnostic {
    SkillDiagnostic {
        severity: severity.to_string(),
        code: code.to_string(),
        message: message.into(),
    }
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

fn validate_frontmatter_fields(mapping: &Mapping, diagnostics: &mut Vec<SkillDiagnostic>) {
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
    diagnostics: &mut Vec<SkillDiagnostic>,
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
    diagnostics: &mut Vec<SkillDiagnostic>,
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
    diagnostics: &mut Vec<SkillDiagnostic>,
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
    diagnostics: &mut Vec<SkillDiagnostic>,
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

fn validate_skill_name(name: &str, skill_dir: &Path, diagnostics: &mut Vec<SkillDiagnostic>) {
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

/// Shared parser for bytes already read under native authority. No file access.
pub fn parse_admitted_skill_text(
    skill_file: &Path,
    raw: &str,
) -> Result<(String, String, String), String> {
    let parsed = parse_skill_text(skill_file, raw);
    if !parsed.is_valid {
        return Err(parsed
            .diagnostics
            .iter()
            .filter(|d| d.severity == "error")
            .map(|d| d.message.as_str())
            .collect::<Vec<_>>()
            .join("; "));
    }
    Ok((parsed.name, parsed.description, parsed.body))
}

pub fn parse_skill_text(skill_file: &Path, raw: &str) -> ParsedSkillFile {
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
    }
}
