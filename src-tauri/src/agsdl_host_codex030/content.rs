//! Recipient-scoped native content. Nothing here grants authority to resources.
use super::*;
use crate::agsdl_content::{
    resolve_content, ContentContext, ContentPayload, ContentUsage, ContentUse,
    ResolvedContentReceipt, SkillDescriptor,
};
use crate::agsdl_permissions::{normalize_requested, ExecutionPurpose};

const CONTENT_SCOPE_REFUSAL: &str =
    "Content is outside the approved data scope or inside private host metadata";

fn approved_data_path(root: &Path, private: &Path, path: &Path) -> bool {
    path.is_absolute()
        && path.starts_with(root)
        && !private_project_path(root, path)
        && !path.starts_with(private)
}

pub(crate) struct Sources030 {
    context: ContentContext,
    document: Value,
    root: std::path::PathBuf,
    private: std::path::PathBuf,
    // Keep the actual bytes and provenance for this work's lifetime. D7 never
    // reconstructs these snapshots by replaying a read after interruption.
    pub receipts: Vec<ResolvedContentReceipt>,
    config: Option<HostContext>,
    ceiling_digest: String,
}

impl Sources030 {
    pub async fn check_ceiling(&self) -> HostResult<()> {
        if let Some(config) = &self.config {
            let ceiling = config
                .lock_agsdl_host_permissions()
                .await
                .map_err(|_| missing("contentPolicy"))?;
            if ceiling.fingerprint() != self.ceiling_digest {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "skills",
                    "Content permission ceiling changed",
                ));
            }
        }
        Ok(())
    }
    pub async fn new(
        config: &HostContext,
        capture: &crate::db::agsdl_execution::start030::StartCapture030,
        agent: &str,
        policy: &crate::agsdl_permissions::EffectivePolicy,
        cancel: &CancellationToken,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    ) -> HostResult<Self> {
        let ceiling = config
            .lock_agsdl_host_permissions()
            .await
            .map_err(|_| missing("contentPolicy"))?;
        let paths = policy
            .policies()
            .next()
            .ok_or_else(|| missing("contentPolicy"))?
            .context()
            .clone();
        let root = paths.workspace.clone();
        let private = config
            .root()
            .canonicalize()
            .map_err(|_| missing("contentPrivateRoot"))?;
        let current = normalize_requested(ceiling.permissions().clone(), paths)
            .map_err(|_| missing("contentPolicy"))?;
        let ceiling_digest = ceiling.fingerprint().to_owned();
        let context = ContentContext::capture(
            capture.identity.snapshot_id.clone(),
            capture.source.source_sha256.clone(),
            capture.authored_source.clone(),
            None,
            agent.into(),
            policy.with_current(current),
            ExecutionPurpose::Agent,
            cancel.clone(),
            Arc::new(|_| {
                Box::pin(async {
                    Err(crate::agsdl_content::ContentError {
                        code: "HARNESS_CAPABILITY".into(),
                        pointer: String::new(),
                        message: "Content read approvals are not represented".into(),
                    })
                })
            }),
        )
        .map_err(content_error)?;
        let parent = format!(
            "flow030:{}:{}",
            attempt.identity().system_start_id,
            attempt.start_effect_id()
        );
        let tasks = tasks.clone();
        let context = context.with_resource_owner(Arc::new(move |cleanup| {
            tasks.attach_cleanup030(&parent, cleanup)
        }));
        let mut sources = Self::from_context(
            context,
            serde_json::from_str(&capture.authored_source)?,
            root,
            private,
        )?;
        sources.config = Some(config.clone());
        sources.ceiling_digest = ceiling_digest;
        Ok(sources)
    }

    pub(crate) fn from_context(
        context: ContentContext,
        document: Value,
        root: std::path::PathBuf,
        private: std::path::PathBuf,
    ) -> HostResult<Self> {
        let scope_root = root.clone();
        let scope_private = private.clone();
        let context = context.with_read_scope(Arc::new(move |path| {
            if approved_data_path(&scope_root, &scope_private, path) {
                Ok(())
            } else {
                Err(crate::agsdl_content::ContentError {
                    code: "PERMISSION".into(),
                    pointer: String::new(),
                    message: CONTENT_SCOPE_REFUSAL.into(),
                })
            }
        }));
        Ok(Self {
            context,
            document,
            root,
            private,
            receipts: Vec::new(),
            config: None,
            ceiling_digest: String::new(),
        })
    }

    async fn source(
        &mut self,
        source: &mut Value,
        usage: ContentUsage,
        pointer: &str,
    ) -> HostResult<()> {
        let config = self.config.clone();
        let _ceiling = if let Some(config) = &config {
            let ceiling = config
                .lock_agsdl_host_permissions()
                .await
                .map_err(|_| missing("contentPolicy"))?;
            if ceiling.fingerprint() != self.ceiling_digest {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    pointer,
                    "Content permission ceiling changed",
                ));
            }
            Some(ceiling)
        } else {
            None
        };
        let expanded = source
            .get("ref")
            .and_then(Value::as_str)
            .map(|name| &self.document["content"][name])
            .unwrap_or(source);
        self.allowed_file(expanded, pointer)?;
        let receipt = resolve_content(
            &self.context,
            ContentUse {
                source_json: source.to_string(),
                usage,
                pointer: pointer.into(),
            },
        )
        .await
        .map_err(content_error)?;
        let previous: u64 = self
            .receipts
            .iter()
            .filter_map(|receipt| receipt.provenance.size_bytes.parse::<u64>().ok())
            .sum();
        if previous.saturating_add(
            receipt
                .provenance
                .size_bytes
                .parse::<u64>()
                .unwrap_or(u64::MAX),
        ) > 1_000_000
            || receipt
                .provenance
                .size_bytes
                .parse::<usize>()
                .ok()
                .is_none_or(|n| n > 262_144)
        {
            return Err(failure(
                "INPUT_LIMIT",
                pointer,
                "Content exceeds the native harness input bound",
            ));
        }
        match &receipt.payload {
            ContentPayload::Text { text } => {
                *source = json!({"value":text,"mediaType":receipt.provenance.media_type})
            }
            ContentPayload::Json { json: raw } => {
                // The adapter transports resources as text context. Keep the
                // JSON bytes inside that text rather than reserializing them.
                *source = json!({"value":raw,"mediaType":receipt.provenance.media_type});
            }
            ContentPayload::Media { .. } => {
                return Err(failure(
                    "CONTENT_SOURCE_UNSUPPORTED",
                    pointer,
                    "This Codex adapter cannot represent this media type as native context",
                ))
            }
        }
        self.receipts.push(receipt);
        Ok(())
    }

    pub async fn prompt(
        &mut self,
        value: &mut Value,
        usage: ContentUsage,
        pointer: &str,
    ) -> HostResult<()> {
        if let Some(sources) = value.as_array_mut() {
            for (index, source) in sources.iter_mut().enumerate() {
                self.source(source, usage, &format!("{pointer}/{index}"))
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn resources(&mut self, value: &mut Value, pointer: &str) -> HostResult<()> {
        if let Some(resources) = value.as_object_mut() {
            for (name, source) in resources {
                self.source(
                    source,
                    ContentUsage::Resource,
                    &format!("{pointer}/{}", name.replace('~', "~0").replace('/', "~1")),
                )
                .await?;
            }
        }
        Ok(())
    }

    pub async fn message(&mut self, value: &mut Value, pointer: &str) -> HostResult<()> {
        if let Some(message) = value.as_object_mut() {
            if let Some(prompt) = message.get_mut("prompt") {
                self.prompt(prompt, ContentUsage::Prompt, &format!("{pointer}/prompt"))
                    .await?;
            }
            if let Some(resources) = message.get_mut("resources") {
                self.resources(resources, &format!("{pointer}/resources"))
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn skills(&mut self) -> HostResult<Vec<SkillDescriptor>> {
        let config = self.config.clone();
        let _ceiling = if let Some(config) = &config {
            let ceiling = config
                .lock_agsdl_host_permissions()
                .await
                .map_err(|_| missing("contentPolicy"))?;
            if ceiling.fingerprint() != self.ceiling_digest {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "skills",
                    "Skill permission ceiling changed",
                ));
            }
            Some(ceiling)
        } else {
            None
        };
        qualify_skill_folders(&self.document, &self.root)?;
        for key in self.document["agents"][self.context.binding().map_err(content_error)?.agent]
            ["skills"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let name = key.as_str().ok_or_else(|| missing("skills"))?;
            self.allowed_file(&self.document["skills"][name], &format!("/skills/{name}"))?;
        }
        let selected = crate::agsdl_content::discover_skills(&self.context)
            .await
            .map_err(content_error)?;
        let previous: u64 = self
            .receipts
            .iter()
            .filter_map(|receipt| receipt.provenance.size_bytes.parse::<u64>().ok())
            .sum();
        let skill_bytes: u64 = selected
            .iter()
            .filter_map(|skill| skill.source.provenance.size_bytes.parse::<u64>().ok())
            .sum();
        if previous.saturating_add(skill_bytes) > 1_000_000 {
            return Err(failure(
                "INPUT_LIMIT",
                "skills",
                "Selected skills exceed the work's content bound",
            ));
        }
        for skill in &selected {
            let root = Path::new(&skill.path)
                .parent()
                .ok_or_else(|| missing("skillRoot"))?;
            for entry in std::fs::read_dir(root).map_err(|_| missing("skillRoot"))? {
                let entry = entry.map_err(|_| missing("skillRoot"))?;
                if entry.path() != Path::new(&skill.path)
                    || !entry
                        .file_type()
                        .map_err(|_| missing("skillRoot"))?
                        .is_file()
                {
                    return Err(failure("CONTENT_SOURCE_UNSUPPORTED","skills","Only single-file skills are represented; selected folders with resources, scripts, other files or links are refused"));
                }
            }
        }
        self.receipts
            .extend(selected.iter().map(|skill| skill.source.clone()));
        Ok(selected)
    }

    fn allowed_file(&self, source: &Value, pointer: &str) -> HostResult<()> {
        if let Some(uri) = source.get("uri").and_then(Value::as_str) {
            let path=url::Url::parse(uri).ok().filter(|uri| uri.scheme()=="file" && uri.query().is_none() && uri.fragment().is_none()).and_then(|uri| uri.to_file_path().ok())
                .ok_or_else(|| failure("CONTENT_SOURCE_UNSUPPORTED",pointer,"Only absolute local file sources are represented; no document origin is available for relative URIs"))?;
            let path = path.canonicalize().map_err(|_| {
                failure(
                    "CONTENT_UNAVAILABLE",
                    pointer,
                    "Native content file is unavailable",
                )
            })?;
            if !approved_data_path(&self.root, &self.private, &path) {
                return Err(failure("PERMISSION", pointer, CONTENT_SCOPE_REFUSAL));
            }
        }
        Ok(())
    }
}

pub(crate) fn skill_tool030() -> Value {
    json!({"type":"function","name":"agsdl_load_skill","description":"Load a skill selected for the current AgSDL work. Unselected skills are unavailable. Skills grant no permissions.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"deferLoading":false})
}

/// Native tool replies use only the recipient's captured bytes. There is no
/// path argument, filesystem read, or grant derived from the model's request.
pub(crate) fn skill_reply030(
    params: &Value,
    thread: &str,
    turn: &str,
    skills: &[SkillDescriptor],
    cancel: &CancellationToken,
) -> HostResult<Value> {
    if required(params, "threadId")? != thread || required(params, "turnId")? != turn {
        return Err(missing("skillOwner"));
    }
    if cancel.is_cancelled() {
        return Err(failure(
            "STOP_PENDING",
            "skills",
            "Skill loading was cancelled",
        ));
    }
    let args = &params["arguments"];
    let selected = (params["tool"] == "agsdl_load_skill"
        && params["namespace"].is_null()
        && args.as_object().is_some_and(|args| args.len() == 1))
    .then(|| {
        args["name"]
            .as_str()
            .and_then(|name| skills.iter().find(|skill| skill.key == name))
    })
    .flatten();
    let Some(skill) = selected else {
        return Ok(
            json!({"success":false,"contentItems":[{"type":"inputText","text":"SKILL_NOT_SELECTED: only a skill selected for the current work can be loaded by name."}]}),
        );
    };
    let ContentPayload::Text { text } = &skill.source.payload else {
        return Err(missing("skillText"));
    };
    Ok(json!({"success":true,"contentItems":[{"type":"inputText","text":text}]}))
}

fn content_error(
    error: crate::agsdl_content::ContentError,
) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(&error.code, &error.pointer, &error.message)
}

fn private_project_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        relative.components().any(|part| {
            part.as_os_str().to_str().is_none_or(|name| {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    ".macro" | ".git" | ".aws" | ".codex" | "auth.json" | "credentials"
                )
            })
        })
    })
}

/// Only inspect selected folders within the native project scope. Other skill
/// shapes remain explicit refusals before launch as well as at work admission.
pub(crate) fn qualify_skill_folders(document: &Value, root: &Path) -> HostResult<()> {
    for (agent_name, agent) in document["agents"].as_object().into_iter().flatten() {
        if agent["skills"]
            .as_array()
            .is_some_and(|skills| skills.len() > 32)
        {
            return Err(failure(
                "INPUT_LIMIT",
                &format!("/agents/{agent_name}/skills"),
                "Too many selected skills for the native discovery bound",
            ));
        }
        for name in agent["skills"].as_array().into_iter().flatten() {
            let name = name.as_str().ok_or_else(|| missing("skills"))?;
            let pointer = format!("/agents/{agent_name}/skills");
            let uri = document["skills"][name]["uri"]
                .as_str()
                .ok_or_else(|| missing("skills"))?;
            let path = url::Url::parse(uri)
                .ok()
                .filter(|uri| uri.scheme() == "file")
                .and_then(|uri| uri.to_file_path().ok())
                .and_then(|path| path.canonicalize().ok())
                .ok_or_else(|| {
                    failure(
                        "CONTENT_SOURCE_UNSUPPORTED",
                        &pointer,
                        "Selected skill requires an available absolute local SKILL.md file",
                    )
                })?;
            if !path.starts_with(root)
                || private_project_path(root, &path)
                || path.file_name().is_none_or(|name| name != "SKILL.md")
            {
                return Err(failure(
                    "PERMISSION",
                    &pointer,
                    "Selected skill is outside the approved project data scope",
                ));
            }
            let directory = path.parent().ok_or_else(|| missing("skills"))?;
            for entry in std::fs::read_dir(directory).map_err(|_| missing("skills"))? {
                let entry = entry.map_err(|_| missing("skills"))?;
                if entry.path() != path
                    || !entry.file_type().map_err(|_| missing("skills"))?.is_file()
                {
                    return Err(failure("CONTENT_SOURCE_UNSUPPORTED",&pointer,"Only single-file skills are represented; folders with resources, scripts, other files or links are refused"));
                }
            }
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agsdl_permissions::{EffectivePolicy, PathContext, RequestedPermissions};
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn recipient_read_scope_is_rechecked_at_content_admission() {
        for folder in [".macro", "private"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let file = root.join("data.txt");
            std::fs::write(&file, "Public fixture").unwrap();
            let private = root.join(folder);
            std::fs::create_dir(&private).unwrap();
            let destination = private.join("fixture.txt");
            std::fs::write(&destination, "Private fixture").unwrap();
            let document = json!({"agents":{"worker":{}}});
            let document_json = document.to_string();
            let policy = normalize_requested(
                RequestedPermissions::Preset(crate::agsdl_permissions::Preset::ReadOnly),
                PathContext {
                    workspace: root.clone(),
                    home: root.clone(),
                },
            )
            .unwrap();
            let context = ContentContext::capture(
                "capture".into(),
                format!("{:x}", Sha256::digest(document_json.as_bytes())),
                document_json,
                None,
                "worker".into(),
                EffectivePolicy::new(policy.clone(), policy.clone(), policy),
                ExecutionPurpose::Agent,
                CancellationToken::new(),
                Arc::new(|_| {
                    Box::pin(async { panic!("read-only content must not request approval") })
                }),
            )
            .unwrap();
            let sources =
                Sources030::from_context(context, document, root.clone(), root.join("private"))
                    .unwrap();
            let source = json!({"uri":url::Url::from_file_path(&file).unwrap().to_string(),"mediaType":"text/plain"});
            sources.allowed_file(&source, "/resource").unwrap();
            std::fs::remove_file(&file).unwrap();
            std::os::unix::fs::symlink(&destination, &file).unwrap();
            // Continue through the same native resolver used after preflight.
            // The recipient scope must be enforced before starting its reader.
            let result = resolve_content(
                &sources.context,
                ContentUse {
                    source_json: source.to_string(),
                    usage: ContentUsage::Resource,
                    pointer: "/resource".into(),
                },
            )
            .await;
            assert_eq!(
                result.unwrap_err().code,
                "PERMISSION",
                "scope changed to {folder}"
            );
        }
    }
}
