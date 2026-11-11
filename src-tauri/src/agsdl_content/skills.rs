use super::*;
use std::path::Path;
use url::Url;

/// Native-only handle, retained by the host and never deserialized from a tool.
#[derive(Clone)]
pub(crate) struct SkillHandle {
    capture_id: String,
    agent: String,
    name: String,
    declared_uri: String,
    final_uri: String,
    sha256: String,
}

#[derive(Clone)]
pub(crate) struct SkillDescriptor {
    pub key: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: ResolvedContentReceipt,
    pub handle: SkillHandle,
}

pub(crate) struct LoadedSkill {
    handle: SkillHandle,
    root: resolve::SkillRoot,
    pub instructions: String,
    pub provenance: ContentProvenance,
}

fn skill_source(uri: &str) -> String {
    serde_json::json!({"uri": uri, "mediaType": "text/plain"}).to_string()
}

fn parse_skill(receipt: &ResolvedContentReceipt) -> ContentResult<(String, String, String)> {
    let ContentPayload::Text { text } = &receipt.payload else {
        return Err(error("CONTENT_FORMAT", "SKILL.md must be text."));
    };
    let uri = receipt
        .provenance
        .final_uri
        .as_deref()
        .ok_or_else(|| error("CORRELATION", "Skill file has no resolved location."))?;
    let url = resolve::absolute_uri(uri)?;
    if !url.path().ends_with("/SKILL.md") {
        return Err(error("INVALID_SKILL", "Skill URI must name SKILL.md."));
    }
    crate::commands::skills::parse_admitted_skill_text(Path::new(url.path()), text)
        .map_err(|e| error("INVALID_SKILL", e.message))
}

pub(crate) async fn discover_skills(
    context: &ContentContext,
) -> ContentResult<Vec<SkillDescriptor>> {
    let selected = crate::db::exact_json::at_path(
        &context.document_json,
        &["agents", &context.agent, "skills"],
    )
    .map_err(|e| error("PARSE", e))?;
    let names: Vec<String> = match selected {
        Some(value) => serde_json::from_str(value.get()).map_err(|e| error("INVALID_SKILL", e))?,
        None => Vec::new(),
    };
    let mut seen = std::collections::BTreeSet::new();
    if names.len() > 32 {
        return Err(error(
            "INPUT_LIMIT",
            "Too many selected skills for the native discovery bound.",
        ));
    }
    let mut retained = 0u64;
    let mut result = Vec::with_capacity(names.len());
    for key in names {
        if !seen.insert(key.clone()) {
            return Err(error("INVALID_SKILL", "Duplicate skill name."));
        }
        let raw = crate::db::exact_json::at_path(&context.document_json, &["skills", &key, "uri"])
            .map_err(|e| error("PARSE", e))?
            .ok_or_else(|| error("INVALID_SKILL", "Unknown declared skill."))?;
        let declared_uri: String =
            serde_json::from_str(raw.get()).map_err(|e| error("INVALID_SKILL", e))?;
        let receipt = resolve_content(
            context,
            ContentUse {
                source_json: skill_source(&declared_uri),
                usage: ContentUsage::SkillDiscovery,
                pointer: format!("/skills/{}/uri", key.replace('~', "~0").replace('/', "~1")),
            },
        )
        .await?;
        let bytes = receipt
            .provenance
            .size_bytes
            .parse::<u64>()
            .map_err(|_| error("CORRELATION", "Invalid native skill size."))?;
        retained = retained.saturating_add(bytes);
        if bytes > 262_144 || retained > 1_000_000 {
            return Err(error(
                "INPUT_LIMIT",
                "Selected skills exceed the native content bound.",
            ));
        }
        let (name, description, _) = parse_skill(&receipt)?;
        let final_uri = receipt
            .provenance
            .final_uri
            .clone()
            .ok_or_else(|| error("CORRELATION", "Skill URI was not resolved."))?;
        let handle = SkillHandle {
            capture_id: context.capture_id.clone(),
            agent: context.agent.clone(),
            name: key.clone(),
            declared_uri,
            final_uri,
            sha256: receipt.provenance.sha256.clone(),
        };
        result.push(SkillDescriptor {
            source: receipt,
            path: resolve::absolute_uri(&handle.final_uri)?
                .to_file_path()
                .map_err(|_| error("CONTENT_URI", "Native skills require a local file"))?
                .to_string_lossy()
                .into_owned(),
            key,
            name,
            description,
            handle,
        });
    }
    Ok(result)
}

pub(crate) async fn load_skill(
    context: &ContentContext,
    handle: &SkillHandle,
) -> ContentResult<LoadedSkill> {
    if handle.capture_id != context.capture_id || handle.agent != context.agent {
        return Err(error(
            "CORRELATION",
            "Skill handle belongs to another capture.",
        ));
    }
    let receipt = resolve_content(
        context,
        ContentUse {
            source_json: skill_source(&handle.declared_uri),
            usage: ContentUsage::SkillActivation,
            pointer: format!(
                "/skills/{}/uri",
                handle.name.replace('~', "~0").replace('/', "~1")
            ),
        },
    )
    .await?;
    if receipt.provenance.sha256 != handle.sha256
        || receipt.provenance.final_uri.as_deref() != Some(handle.final_uri.as_str())
    {
        return Err(error("CORRELATION", "Skill changed since discovery."));
    }
    let (_, _, instructions) = parse_skill(&receipt)?;
    let root = resolve::absolute_uri(&handle.final_uri)?
        .join(".")
        .map_err(|e| error("CONTENT_URI", e))?;
    if root.scheme() == "file" {
        let path = root
            .to_file_path()
            .map_err(|_| error("CONTENT_URI", "Invalid skill root."))?;
        let canonical = path
            .canonicalize()
            .map_err(|e| error("CONTENT_UNAVAILABLE", e))?;
        let identity = crate::fs::operations::workspace_root_identity(&canonical)
            .map_err(|e| error("CONTENT_UNAVAILABLE", e))?
            .observation_key();
        if Url::from_directory_path(&canonical).ok().as_ref() != Some(&root)
            || identity.is_none()
            || identity != receipt.provenance.file_parent_identity
        {
            return Err(error(
                "CORRELATION",
                "Skill root changed during activation.",
            ));
        }
    }
    Ok(LoadedSkill {
        handle: handle.clone(),
        root: resolve::SkillRoot {
            uri: root,
            file_identity: receipt.provenance.file_parent_identity.clone(),
        },
        instructions,
        provenance: receipt.provenance,
    })
}

pub(crate) async fn read_skill_resource(
    context: &ContentContext,
    loaded: &LoadedSkill,
    relative_path: &str,
    media_type: Option<&str>,
) -> ContentResult<ResolvedContentReceipt> {
    if loaded.handle.capture_id != context.capture_id || loaded.handle.agent != context.agent {
        return Err(error(
            "CORRELATION",
            "Skill handle belongs to another capture.",
        ));
    }
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.contains('\\')
        || relative_path.split('/').any(|p| p == ".." || p == ".")
    {
        return Err(error(
            "CONTENT_URI",
            "Skill resource must be a relative path within its root.",
        ));
    }
    let target = loaded
        .root
        .uri
        .join(relative_path)
        .map_err(|e| error("CONTENT_URI", e))?;
    let mut source = serde_json::json!({"uri": target.as_str()});
    if let Some(media) = media_type {
        source["mediaType"] = media.into();
    }
    resolve::resolve_content_in_root(
        context,
        ContentUse {
            source_json: source.to_string(),
            usage: ContentUsage::SkillResource,
            pointer: format!("/skills/{}/resources", loaded.handle.name),
        },
        Some(&loaded.root),
    )
    .await
}
