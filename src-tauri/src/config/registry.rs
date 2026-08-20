use super::types::*;
use schemars::{schema::RootSchema, schema_for};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const DEFAULT_ARCHITECT_PROMPT: &str = r#"You are the Architect AI. Discuss the active plan directly with the user and produce structured strategies stored in the `@macro` branch metadata.

IMPORTANT RULES:
1. Each plan is isolated and retains its own conversation and strategy.
2. Inspect selected project code when it adds useful context. If important information is missing, ask focused questions with the `question` tool. Do not impose a mandatory structured collection phase before strategy.
3. Do not call `strategy_generate` automatically. Generate or regenerate strategy only after an explicit user request. Base it on the full plan conversation, the user's expressed intent, the plan scope, selected projects, inspected code context, and clarification answers.
4. Respect the current Macro tool security level. Some tools may require approval or be unavailable.
5. Use `strategy_get` to inspect strategies. Strategy mutations are only allowed while the active plan is draft; once validated, in progress, or completed, its strategy is temporarily immutable.
6. The Architect chat surface includes `plan_create`, `plan_list`, `plan_get`, and `plan_update`; plan deletion, restoration, and active-plan switching stay UI-only.
7. Never call `plan_delete`, `plan_restore`, or `plan_set_active` in Architect chat. Ask the user to use the plan selector for those operations.
8. `plan_create` may only create a draft plan. `plan_update` may change the optional label/title alias, description, mutable draft slug, and draft-only scope metadata. It must never change plan status or activate a plan.
9. Git workflow is strict. Prefer logical `plan_slug` and unique per-node `featureSlug` values; concrete branch names are derived from each project's settings. Express sequential work with dependencies, never by reusing a work slug.
10. Declare artifactContracts only for critical durable handoffs that dependent tasks truly need. Do not add them to every node.
11. If a strategy tool reports frozen-node conflicts and requests one repair retry, retry once while preserving frozen nodes exactly. If it stages a preview or blocks, stop and explain that user review is required.
12. After using an Architect tool, provide a concise natural-language recap and the next useful step.
16. Each executable strategy node must include concrete todos for its implementation checklist. Todos are task-local, use pending, in-progress, or done, and should describe the ordered work the Implement agent must perform on that task branch. Choose the natural number of todos for each task; small tasks may need 1-2, larger tasks may need more, and you must not pad every task to the same count.
17. Do not create a "Finalize plan" strategy node yourself: Macro adds a synthetic finalization task after the terminal strategy nodes and handles the final merge."#;

const DEFAULT_IMPLEMENT_PROMPT: &str = "You are the Implementer. Follow the tasks to implement the specific feature. Use task_todo_get to inspect the current task checklist and task_todo_update to keep each todo status accurate; task completion is blocked while task todos remain pending or in-progress. Use task_artifact_list/task_artifact_get for inherited handoff context, and call task_artifact_put when a finding, map, contract, decision, or risk record should be reused by dependent tasks. When modifying an inherited artifact, create a new current-task artifact with supersedes_artifact_id instead of overwriting the parent. When you propose an implementation plan, keep it concise and execution-oriented: focus on the next concrete steps, key risks, and verification, not an exhaustive essay.";
const DEFAULT_CHAT_PROMPT: &str = "You are a helpful AI assistant. When asked for a plan, keep it concise and easy to scan unless the user explicitly asks for a detailed version.";
const DEFAULT_PLAN_EXPLORER_PROMPT: &str = "Internal agent profile is PLAN_EXPLORER. Inspect the existing plan context, structure what matters, and propose the next useful planning step. Stay exploration-first and avoid code-execution behavior outside the dedicated planning and read-only inspection tools.";
const DEFAULT_TASK_REVIEWER_PROMPT: &str = "Internal agent profile is TASK_REVIEWER. Review changes critically from diffs, touched files, and verification results. Prefer minimal, targeted fixes and keep the task review easy for a human to validate.";
const DEFAULT_REPO_AUDITOR_PROMPT: &str = "Internal agent profile is REPO_AUDITOR. Diagnose repository, worktree, merge, and finalization blockers carefully. Focus on safe remediation of the reported Git issues only, and do not broaden the change scope.";

fn default_open_command(action: &str) -> &'static str {
    if cfg!(target_os = "windows") {
        match action {
            "editor" => "code",
            "terminal" => "wt -d",
            _ => "explorer",
        }
    } else if cfg!(target_os = "macos") {
        match action {
            "editor" => "open -a \"Visual Studio Code\"",
            "terminal" => "open -a Terminal",
            _ => "open -a Finder",
        }
    } else {
        match action {
            "editor" => "code",
            "terminal" => "x-terminal-emulator --working-directory",
            _ => "xdg-open",
        }
    }
}

pub fn sparse_document(kind: ConfigDocumentKind) -> Value {
    json!({
        "$schema": format!("./schemas/v1/{}", kind.schema_file_name()),
        "schemaVersion": CURRENT_SCHEMA_VERSION,
    })
}

pub fn default_document(kind: ConfigDocumentKind) -> Value {
    match kind {
        ConfigDocumentKind::Runtime => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "defaultWorkspace": null,
            "headless": { "bindAddress": "127.0.0.1", "port": 43117, "autoStart": false },
            "allowedRoots": [],
            "extensions": {}
        }),
        ConfigDocumentKind::Settings => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "language": "en",
            "appearance": {
                "theme": "macro-dark",
                "zoomMode": "auto",
                "zoomLevel": 1.0,
                "nativeMacosTitlebarBackground": "#09090b",
                "nativeMacosTitlebarTheme": "dark"
            },
            "code": { "overflowMode": "wrap" },
            "shortcuts": {},
            "promptHistoryNavigationMode": "contextual_arrows",
            "notifications": {
                "inAppEnabled": true,
                "channelModes": {
                    "task_attention_required": "both",
                    "task_run_completed": "desktop",
                    "task_completed": "both",
                    "git_sync_completed": "desktop",
                    "git_sync_attention_required": "both"
                }
            },
            "applications": {
                "editorApp": null,
                "terminalApp": null,
                "filesApp": null,
                "editorCommand": default_open_command("editor"),
                "terminalCommand": default_open_command("terminal"),
                "filesCommand": default_open_command("files")
            },
            "extensions": {}
        }),
        ConfigDocumentKind::Agents => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "prompts": {
                "architect": DEFAULT_ARCHITECT_PROMPT,
                "implement": DEFAULT_IMPLEMENT_PROMPT,
                "chat": DEFAULT_CHAT_PROMPT,
                "plan_explorer": DEFAULT_PLAN_EXPLORER_PROMPT,
                "task_reviewer": DEFAULT_TASK_REVIEWER_PROMPT,
                "repo_auditor": DEFAULT_REPO_AUDITOR_PROMPT
            },
            "maxTurns": 0,
            "compaction": { "automatic": true, "prune": true, "reservedTokens": null, "manualVisible": false },
            "reviewPresentation": "focused",
            "models": {},
            "smartCommitPrompt": "You generate concise Git commit messages. Return JSON only. Do not include markdown fences.\nGenerate one independent Conventional Commit per repository.\nAllowed types: feat, fix, perf, build, chore, ci, docs, refactor, style, test, revert.\nUse the body only when it adds useful context beyond the subject.",
            "extensions": {}
        }),
        ConfigDocumentKind::Providers => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "providers": {
                "macro-ai": { "providerType": "openai", "name": "Andrologic", "enabled": true, "baseUrl": "https://lmstudio.andrologic.ai/v1", "isLocal": false },
                "chatgpt": { "providerType": "chatgpt", "name": "ChatGPT", "enabled": false, "baseUrl": "https://chatgpt.com/backend-api", "isLocal": false },
                "copilot": { "providerType": "copilot", "name": "GitHub Copilot", "enabled": false, "baseUrl": "copilot://cli", "isLocal": false },
                "openai": { "providerType": "openai", "name": "OpenAI", "enabled": false, "baseUrl": "https://api.openai.com/v1", "isLocal": false },
                "zai": { "providerType": "openai", "name": "z.ai", "enabled": false, "baseUrl": "https://api.z.ai/api/coding/paas/v4", "isLocal": false },
                "anthropic": { "providerType": "anthropic", "name": "Anthropic", "enabled": false, "baseUrl": "https://api.anthropic.com/v1", "isLocal": false },
                "openrouter": { "providerType": "openrouter", "name": "OpenRouter", "enabled": false, "baseUrl": "https://openrouter.ai/api/v1", "isLocal": false },
                "minimax": { "providerType": "openai", "name": "MiniMax", "enabled": false, "baseUrl": "https://api.minimax.io/v1", "isLocal": false },
                "opencode-go": { "providerType": "openai", "name": "OpenCode Go", "enabled": false, "baseUrl": "https://opencode.ai/zen/go/v1", "isLocal": false },
                "ollama": { "providerType": "ollama", "name": "Ollama", "enabled": false, "baseUrl": "http://localhost:11434/v1", "isLocal": true },
                "lmstudio": { "providerType": "lmstudio", "name": "LM Studio", "enabled": false, "baseUrl": "http://localhost:1234/v1", "isLocal": true }
            },
            "manualModels": {},
            "modelOverrides": {},
            "speechProviders": {
                "andrologic-speech": { "providerType": "openai-compatible", "name": "Andrologic", "baseUrl": "https://lmstudio.andrologic.ai/v1", "model": "macro-transcription", "enabled": true, "isLocal": false },
                "openai-speech": { "providerType": "openai-compatible", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini-transcribe", "enabled": false, "isLocal": false }
            },
            "speech": {
                "providerId": "andrologic-speech",
                "language": "auto",
                "maxDurationSeconds": 120,
                "enhancementEnabled": false
            },
            "extensions": {}
        }),
        ConfigDocumentKind::Tools => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "riskLevel": "balanced",
            "builtIn": {},
            "modes": {},
            "webSearch": { "enabled": false, "fetchEnabled": true, "provider": "tavily", "secretRef": null, "maxResults": 5 },
            "mcpServers": {},
            "projectMcpApprovals": {},
            "projectCommands": {},
            "projectSwitchPolicy": "resume_per_project",
            "extensions": {}
        }),
        ConfigDocumentKind::Skills => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "conventionalRoots": { "agents": true, "codex": true, "opencode": true, "claude": true },
            "roots": {},
            "installDestinations": {
                "global-default": { "scope": "user", "path": "${home}/.agents/skills" },
                "project-default": { "scope": "project", "path": ".agents/skills" }
            },
            "defaultGlobalDestination": "global-default",
            "defaultProjectDestination": "project-default",
            "permissions": {},
            "extensions": {}
        }),
        ConfigDocumentKind::Git => json!({
            "schemaVersion": CURRENT_SCHEMA_VERSION,
            "baseBranch": "main",
            "mainBranch": "main",
            "completionMergePolicy": "merge_commit",
            "branchTemplates": {
                "plan": "plan/{planSlug}",
                "feature": "feature/{planSlug}/{featureSlug}",
                "standaloneFeature": "feature/{featureSlug}",
                "release": "release/v{releaseSlug}",
                "hotfix": "hotfix/{hotfixSlug}",
                "bugfix": "bugfix/{bugfixSlug}"
            },
            "syncTargetBeforeFinish": true,
            "metadataAutoPush": false,
            "metadataMissingUpstreamPolicy": "ask",
            "extensions": {}
        }),
    }
}

pub fn schema_for_kind(kind: ConfigDocumentKind) -> RootSchema {
    match kind {
        ConfigDocumentKind::Runtime => schema_for!(RuntimeDocument),
        ConfigDocumentKind::Settings => schema_for!(SettingsDocument),
        ConfigDocumentKind::Agents => schema_for!(AgentsDocument),
        ConfigDocumentKind::Providers => schema_for!(ProvidersDocument),
        ConfigDocumentKind::Tools => schema_for!(ToolsDocument),
        ConfigDocumentKind::Skills => schema_for!(SkillsDocument),
        ConfigDocumentKind::Git => schema_for!(GitDocument),
    }
}

fn validate_typed<T: DeserializeOwned>(value: &Value) -> Result<(), String> {
    serde_json::from_value::<T>(value.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn diagnostic(
    kind: ConfigDocumentKind,
    scope: &ConfigScope,
    path: Option<String>,
    code: &str,
    message: impl Into<String>,
) -> ConfigDiagnostic {
    ConfigDiagnostic {
        document: kind,
        scope: scope.clone(),
        path,
        code: code.to_string(),
        message: message.into(),
        severity: "error".to_string(),
    }
}

fn collect_plain_secret_fields(
    value: &Value,
    pointer: &str,
    diagnostics: &mut Vec<(String, String)>,
) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                let child_pointer = format!("{pointer}/{escaped}");
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                let sensitive_name = normalized == "secret"
                    || normalized.ends_with("apikey")
                    || normalized.ends_with("token")
                    || normalized.ends_with("password");
                if sensitive_name
                    && child.as_str().is_some_and(|secret| {
                        !secret.is_empty() && !secret.starts_with("macro-secret://")
                    })
                {
                    diagnostics.push((
                        child_pointer.clone(),
                        "Les secrets en clair sont interdits. Utilisez une référence macro-secret://.".to_string(),
                    ));
                }
                if (normalized == "secretref" || normalized.ends_with("secretref"))
                    && child
                        .as_str()
                        .is_some_and(|secret| !secret.starts_with("macro-secret://"))
                {
                    diagnostics.push((
                        child_pointer.clone(),
                        "Une référence de secret doit commencer par macro-secret://.".to_string(),
                    ));
                }
                collect_plain_secret_fields(child, &child_pointer, diagnostics);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_plain_secret_fields(child, &format!("{pointer}/{index}"), diagnostics);
            }
        }
        _ => {}
    }
}

fn validate_skill_paths(value: &Value, scope: &ConfigScope) -> Vec<(String, String)> {
    let mut diagnostics = Vec::new();
    let allowed_variables = ["${home}", "${projectRoot}", "${configDir}"];
    for section in ["roots", "installDestinations"] {
        let Some(entries) = value.get(section).and_then(Value::as_object) else {
            continue;
        };
        for (id, entry) in entries {
            let Some(path) = entry.get("path").and_then(Value::as_str) else {
                continue;
            };
            let mut remainder = path.to_string();
            for variable in allowed_variables {
                remainder = remainder.replace(variable, "");
            }
            if remainder.contains("${") {
                diagnostics.push((
                    format!("/{section}/{id}/path"),
                    "Seules les variables ${home}, ${projectRoot} et ${configDir} sont acceptées."
                        .to_string(),
                ));
            }
            if matches!(scope, ConfigScope::Project { .. })
                && (std::path::Path::new(path).is_absolute()
                    || path.starts_with("${home}")
                    || path.starts_with("${configDir}"))
            {
                diagnostics.push((
                    format!("/{section}/{id}/path"),
                    "Un chemin de skill projet doit être relatif au projet ou utiliser ${projectRoot}."
                        .to_string(),
                ));
            }
        }
    }
    diagnostics
}

pub fn validate_document(
    kind: ConfigDocumentKind,
    scope: &ConfigScope,
    value: &Value,
) -> ConfigValidationResult {
    let mut diagnostics = Vec::new();
    let read_only =
        schema_version_of(value).is_some_and(|version| version > CURRENT_SCHEMA_VERSION);

    if !value.is_object() {
        diagnostics.push(diagnostic(
            kind,
            scope,
            None,
            "config.document.not_object",
            "Le document de configuration doit être un objet JSON.",
        ));
    }
    if value.get("schemaVersion").and_then(Value::as_u64).is_none() {
        diagnostics.push(diagnostic(
            kind,
            scope,
            Some("/schemaVersion".to_string()),
            "config.schema_version.missing",
            "schemaVersion est obligatoire.",
        ));
    }
    if value.get("$schema").and_then(Value::as_str).is_none() {
        diagnostics.push(diagnostic(
            kind,
            scope,
            Some("/$schema".to_string()),
            "config.schema.missing",
            "$schema est obligatoire dans un document persistant.",
        ));
    }

    if !read_only {
        let typed_result = match kind {
            ConfigDocumentKind::Runtime => validate_typed::<RuntimeDocument>(value),
            ConfigDocumentKind::Settings => validate_typed::<SettingsDocument>(value),
            ConfigDocumentKind::Agents => validate_typed::<AgentsDocument>(value),
            ConfigDocumentKind::Providers => validate_typed::<ProvidersDocument>(value),
            ConfigDocumentKind::Tools => validate_typed::<ToolsDocument>(value),
            ConfigDocumentKind::Skills => validate_typed::<SkillsDocument>(value),
            ConfigDocumentKind::Git => validate_typed::<GitDocument>(value),
        };
        if let Err(message) = typed_result {
            diagnostics.push(diagnostic(
                kind,
                scope,
                None,
                "config.schema.invalid",
                message,
            ));
        }
    }

    if matches!(scope, ConfigScope::Project { .. }) && !kind.supports_project_scope() {
        diagnostics.push(diagnostic(
            kind,
            scope,
            None,
            "config.scope.forbidden",
            "Ce document ne peut pas être surchargé au niveau projet.",
        ));
    }

    if matches!(scope, ConfigScope::Project { .. }) {
        if kind == ConfigDocumentKind::Agents && value.get("prompts").is_some() {
            diagnostics.push(diagnostic(
                kind,
                scope,
                Some("/prompts".to_string()),
                "config.project.prompts_forbidden",
                "Un projet ne peut pas remplacer les prompts système globaux.",
            ));
        }
        if kind == ConfigDocumentKind::Skills && value.get("permissions").is_some() {
            diagnostics.push(diagnostic(
                kind,
                scope,
                Some("/permissions".to_string()),
                "config.project.skill_trust_forbidden",
                "La confiance et les permissions des skills sont locales à l’utilisateur.",
            ));
        }
        if kind == ConfigDocumentKind::Tools && value.get("projectMcpApprovals").is_some() {
            diagnostics.push(diagnostic(
                kind,
                scope,
                Some("/projectMcpApprovals".to_string()),
                "config.project.mcp_approval_forbidden",
                "Un projet ne peut pas s’accorder lui-même la confiance pour un serveur MCP.",
            ));
        }
    }

    let mut secret_diagnostics = Vec::new();
    collect_plain_secret_fields(value, "", &mut secret_diagnostics);
    diagnostics.extend(secret_diagnostics.into_iter().map(|(path, message)| {
        diagnostic(
            kind,
            scope,
            Some(path),
            "config.secret.plaintext_forbidden",
            message,
        )
    }));

    if kind == ConfigDocumentKind::Skills {
        diagnostics.extend(validate_skill_paths(value, scope).into_iter().map(
            |(path, message)| {
                diagnostic(
                    kind,
                    scope,
                    Some(path),
                    "config.skills.path_invalid",
                    message,
                )
            },
        ));
    }

    ConfigValidationResult {
        valid: diagnostics.is_empty() || read_only,
        read_only,
        diagnostics,
    }
}

pub fn merge_values(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, overlay_value) in overlay_map {
                if key == "$schema" || key == "schemaVersion" {
                    continue;
                }
                match base_map.get_mut(key) {
                    Some(base_value) => merge_values(base_value, overlay_value),
                    None => {
                        base_map.insert(key.clone(), overlay_value.clone());
                    }
                }
            }
        }
        (base_value, overlay_value) => *base_value = overlay_value.clone(),
    }
}

pub fn collect_leaf_pointers(value: &Value) -> Vec<String> {
    fn visit(value: &Value, pointer: &str, output: &mut Vec<String>) {
        match value {
            Value::Object(map) if !map.is_empty() => {
                for (key, child) in map {
                    if key == "$schema" || key == "schemaVersion" {
                        continue;
                    }
                    visit(
                        child,
                        &format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1")),
                        output,
                    );
                }
            }
            Value::Array(values) if !values.is_empty() => {
                for (index, child) in values.iter().enumerate() {
                    visit(child, &format!("{pointer}/{index}"), output);
                }
            }
            _ if !pointer.is_empty() => output.push(pointer.to_string()),
            _ => {}
        }
    }

    let mut output = Vec::new();
    visit(value, "", &mut output);
    output
}

fn descriptor(
    document: ConfigDocumentKind,
    json_pointer: &str,
    scopes: &[&str],
    merge_strategy: ConfigMergeStrategy,
    sensitivity: ConfigSensitivity,
    apply_mode: ConfigApplyMode,
) -> ConfigDescriptor {
    ConfigDescriptor {
        document,
        json_pointer: json_pointer.to_string(),
        scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
        merge_strategy,
        sensitivity,
        apply_mode,
        lifecycle: ConfigLifecycle::Normal,
    }
}

pub fn descriptors() -> Vec<ConfigDescriptor> {
    use ConfigApplyMode::{Live, Reconnect, Restart};
    use ConfigDocumentKind::*;
    use ConfigMergeStrategy::{Deep, Keyed, Replace, Restrictive};
    use ConfigSensitivity::{ApprovalRequired, Normal, SecretReferenceOnly};

    vec![
        descriptor(
            Runtime,
            "/defaultWorkspace",
            &["user"],
            Replace,
            Normal,
            Restart,
        ),
        descriptor(
            Runtime,
            "/headless/bindAddress",
            &["user"],
            Replace,
            ApprovalRequired,
            Restart,
        ),
        descriptor(
            Runtime,
            "/headless/port",
            &["user"],
            Replace,
            Normal,
            Restart,
        ),
        descriptor(
            Runtime,
            "/headless/autoStart",
            &["user"],
            Replace,
            Normal,
            Restart,
        ),
        descriptor(
            Runtime,
            "/allowedRoots",
            &["user"],
            Restrictive,
            ApprovalRequired,
            Restart,
        ),
        descriptor(Settings, "/language", &["user"], Replace, Normal, Live),
        descriptor(Settings, "/appearance", &["user"], Deep, Normal, Live),
        descriptor(Settings, "/code", &["user"], Deep, Normal, Live),
        descriptor(Settings, "/shortcuts", &["user"], Keyed, Normal, Live),
        descriptor(
            Settings,
            "/promptHistoryNavigationMode",
            &["user"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(Settings, "/notifications", &["user"], Deep, Normal, Live),
        descriptor(
            Settings,
            "/applications",
            &["user"],
            Deep,
            ApprovalRequired,
            Live,
        ),
        descriptor(Agents, "/prompts", &["user"], Deep, Normal, Live),
        descriptor(
            Agents,
            "/maxTurns",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Agents,
            "/compaction",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Agents,
            "/reviewPresentation",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Agents,
            "/models",
            &["user", "project"],
            Keyed,
            Normal,
            Reconnect,
        ),
        descriptor(
            Agents,
            "/smartCommitPrompt",
            &["user"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Providers,
            "/providers",
            &["user"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Providers,
            "/providers/*/secretRef",
            &["user"],
            Replace,
            SecretReferenceOnly,
            Reconnect,
        ),
        descriptor(
            Providers,
            "/manualModels",
            &["user"],
            Keyed,
            Normal,
            Reconnect,
        ),
        descriptor(Providers, "/modelOverrides", &["user"], Keyed, Normal, Live),
        descriptor(
            Providers,
            "/speechProviders",
            &["user"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Providers,
            "/speech",
            &["user"],
            Deep,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Tools,
            "/riskLevel",
            &["user", "project"],
            Restrictive,
            ApprovalRequired,
            Live,
        ),
        descriptor(
            Tools,
            "/builtIn",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Tools,
            "/modes",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Tools,
            "/webSearch",
            &["user"],
            Deep,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Tools,
            "/mcpServers",
            &["user", "project"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Tools,
            "/projectMcpApprovals",
            &["user"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Tools,
            "/projectCommands",
            &["user", "project"],
            Keyed,
            ApprovalRequired,
            Live,
        ),
        descriptor(
            Tools,
            "/projectSwitchPolicy",
            &["user"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Skills,
            "/conventionalRoots",
            &["user", "project"],
            Restrictive,
            Normal,
            Reconnect,
        ),
        descriptor(
            Skills,
            "/roots",
            &["user", "project"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Skills,
            "/installDestinations",
            &["user", "project"],
            Keyed,
            ApprovalRequired,
            Reconnect,
        ),
        descriptor(
            Skills,
            "/defaultGlobalDestination",
            &["user"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Skills,
            "/defaultProjectDestination",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Skills,
            "/permissions",
            &["user"],
            Keyed,
            ApprovalRequired,
            Live,
        ),
        descriptor(
            Git,
            "/configurationState",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/baseBranch",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/mainBranch",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/completionMergePolicy",
            &["user", "project"],
            Replace,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/branchTemplates",
            &["user", "project"],
            Deep,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/syncTargetBeforeFinish",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/metadataAutoPush",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
        descriptor(
            Git,
            "/metadataMissingUpstreamPolicy",
            &["user", "project"],
            Restrictive,
            Normal,
            Live,
        ),
    ]
}

pub fn descriptor_for_path(kind: ConfigDocumentKind, path: &str) -> Option<ConfigDescriptor> {
    let mut candidates = descriptors()
        .into_iter()
        .filter(|descriptor| descriptor.document == kind)
        .filter(|descriptor| {
            let prefix = descriptor.json_pointer.trim_end_matches("/*");
            path == descriptor.json_pointer || path.starts_with(&format!("{prefix}/"))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|descriptor| std::cmp::Reverse(descriptor.json_pointer.len()));
    candidates.into_iter().next()
}

pub fn classify_sensitive_paths(
    kind: ConfigDocumentKind,
    paths: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut sensitive_paths = BTreeSet::new();
    let mut reasons = BTreeSet::new();
    for path in paths {
        if let Some(descriptor) = descriptor_for_path(kind, path) {
            if descriptor.sensitivity == ConfigSensitivity::ApprovalRequired {
                sensitive_paths.insert(path.clone());
                reasons.insert(format!(
                    "{} exige une approbation utilisateur.",
                    descriptor.json_pointer
                ));
            }
        }
    }
    (
        sensitive_paths.into_iter().collect(),
        reasons.into_iter().collect(),
    )
}

pub fn apply_modes_for_paths(kind: ConfigDocumentKind, paths: &[String]) -> BTreeSet<String> {
    paths
        .iter()
        .filter_map(|path| descriptor_for_path(kind, path))
        .map(|descriptor| match descriptor.apply_mode {
            ConfigApplyMode::Live => "live",
            ConfigApplyMode::Reconnect => "reconnect",
            ConfigApplyMode::Restart => "restart",
        })
        .map(str::to_string)
        .collect()
}

pub fn project_overlay_is_restrictive(
    kind: ConfigDocumentKind,
    global_effective: &Value,
    project: &Value,
) -> Result<(), String> {
    if kind == ConfigDocumentKind::Tools {
        if let Some(project_risk) = project.get("riskLevel").and_then(Value::as_str) {
            let rank = |value: &str| match value {
                "strict" => 0,
                "balanced" => 1,
                "yolo" => 2,
                _ => 255,
            };
            let global_risk = global_effective
                .get("riskLevel")
                .and_then(Value::as_str)
                .unwrap_or("balanced");
            if rank(project_risk) > rank(global_risk) {
                return Err(
                    "Un projet ne peut pas augmenter le niveau de risque global.".to_string(),
                );
            }
        }
        for section in ["builtIn", "modes"] {
            if re_enables_false(global_effective.get(section), project.get(section)) {
                return Err(format!(
                    "Un projet ne peut pas réactiver une entrée désactivée globalement dans {section}."
                ));
            }
        }
    }

    if kind == ConfigDocumentKind::Agents {
        for pointer in ["/maxTurns", "/compaction/reservedTokens"] {
            let global = global_effective.pointer(pointer).and_then(Value::as_u64);
            let local = project.pointer(pointer).and_then(Value::as_u64);
            if let (Some(global), Some(local)) = (global, local) {
                if global != 0 && (local == 0 || local > global) {
                    return Err(format!(
                        "La surcharge projet {pointer} doit être au moins aussi restrictive que la valeur globale."
                    ));
                }
            }
        }
    }
    Ok(())
}

fn re_enables_false(global: Option<&Value>, project: Option<&Value>) -> bool {
    match (global, project) {
        (Some(Value::Object(global)), Some(Value::Object(project))) => {
            project.iter().any(|(key, value)| {
                if value == &Value::Bool(true) && global.get(key) == Some(&Value::Bool(false)) {
                    return true;
                }
                re_enables_false(global.get(key), Some(value))
            })
        }
        _ => false,
    }
}

fn collect_false_pointers(value: Option<&Value>, base: &str, output: &mut Vec<String>) {
    match value {
        Some(Value::Bool(false)) => output.push(base.to_string()),
        Some(Value::Object(map)) => {
            for (key, child) in map {
                let pointer = format!("{base}/{}", key.replace('~', "~0").replace('/', "~1"));
                collect_false_pointers(Some(child), &pointer, output);
            }
        }
        _ => {}
    }
}

fn set_project_provenance(
    provenance: &mut BTreeMap<(ConfigDocumentKind, String), ConfigProvenance>,
    kind: ConfigDocumentKind,
    pointer: &str,
    project_id: &str,
) {
    provenance.insert(
        (kind, pointer.to_string()),
        ConfigProvenance {
            json_pointer: format!(
                "/{}/{}",
                kind.file_name().trim_end_matches(".json"),
                pointer.trim_start_matches('/')
            ),
            origin: ConfigOrigin::Project,
            project_id: Some(project_id.to_string()),
        },
    );
}

fn apply_project_restrictions(
    kind: ConfigDocumentKind,
    value: &mut Value,
    user_effective: &Value,
    project_documents: &[(&str, &BTreeMap<ConfigDocumentKind, Value>)],
    provenance: &mut BTreeMap<(ConfigDocumentKind, String), ConfigProvenance>,
) {
    if kind == ConfigDocumentKind::Git && project_documents.len() > 1 {
        *value = user_effective.clone();
        return;
    }

    if kind == ConfigDocumentKind::Agents {
        if let Some(models) = user_effective.pointer("/models") {
            value["models"] = models.clone();
        }
        let max_turns = std::iter::once(
            user_effective
                .pointer("/maxTurns")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
        .chain(project_documents.iter().filter_map(|(_, documents)| {
            documents
                .get(&kind)
                .and_then(|document| document.pointer("/maxTurns"))
                .and_then(Value::as_u64)
        }))
        .filter(|limit| *limit > 0)
        .min()
        .unwrap_or(0);
        value["maxTurns"] = json!(max_turns);

        let reserved_tokens = std::iter::once(
            user_effective
                .pointer("/compaction/reservedTokens")
                .and_then(Value::as_u64),
        )
        .chain(project_documents.iter().map(|(_, documents)| {
            documents
                .get(&kind)
                .and_then(|document| document.pointer("/compaction/reservedTokens"))
                .and_then(Value::as_u64)
        }))
        .flatten()
        .filter(|limit| *limit > 0)
        .min();
        value["compaction"]["reservedTokens"] = reserved_tokens.map_or(Value::Null, Value::from);
    }

    let restrictive_roots: &[&str] = match kind {
        ConfigDocumentKind::Tools => &["/builtIn", "/modes"],
        ConfigDocumentKind::Skills => &["/conventionalRoots"],
        _ => &[],
    };
    for root in restrictive_roots {
        let mut false_pointers = Vec::new();
        collect_false_pointers(user_effective.pointer(root), root, &mut false_pointers);
        for pointer in false_pointers {
            if let Some(target) = value.pointer_mut(&pointer) {
                *target = Value::Bool(false);
                provenance.insert(
                    (kind, pointer.clone()),
                    ConfigProvenance {
                        json_pointer: format!(
                            "/{}/{}",
                            kind.file_name().trim_end_matches(".json"),
                            pointer.trim_start_matches('/')
                        ),
                        origin: ConfigOrigin::User,
                        project_id: None,
                    },
                );
            }
        }
    }
    for (project_id, documents) in project_documents {
        let Some(project) = documents.get(&kind) else {
            continue;
        };
        for root in restrictive_roots {
            let mut false_pointers = Vec::new();
            collect_false_pointers(project.pointer(root), root, &mut false_pointers);
            for pointer in false_pointers {
                if let Some(target) = value.pointer_mut(&pointer) {
                    *target = Value::Bool(false);
                    set_project_provenance(provenance, kind, &pointer, project_id);
                }
            }
        }
    }

    if kind == ConfigDocumentKind::Tools {
        let risk_rank = |risk: &str| match risk {
            "strict" => 0,
            "balanced" => 1,
            "yolo" => 2,
            _ => 1,
        };
        let mut selected = user_effective
            .pointer("/riskLevel")
            .and_then(Value::as_str)
            .unwrap_or("balanced");
        let mut selected_project = None;
        for (project_id, documents) in project_documents {
            let Some(candidate) = documents
                .get(&kind)
                .and_then(|document| document.pointer("/riskLevel"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if risk_rank(candidate) < risk_rank(selected) {
                selected = candidate;
                selected_project = Some(*project_id);
            }
        }
        value["riskLevel"] = Value::String(selected.to_string());
        if let Some(project_id) = selected_project {
            set_project_provenance(provenance, kind, "/riskLevel", project_id);
        }
    }
}

pub fn effective_documents(
    user_documents: &BTreeMap<ConfigDocumentKind, Value>,
    project_documents: &[(&str, &BTreeMap<ConfigDocumentKind, Value>)],
    session_documents: &BTreeMap<ConfigDocumentKind, Value>,
) -> (BTreeMap<String, Value>, Vec<ConfigProvenance>) {
    let mut effective = BTreeMap::new();
    let mut provenance = BTreeMap::<(ConfigDocumentKind, String), ConfigProvenance>::new();

    for kind in ConfigDocumentKind::ALL {
        let mut value = default_document(kind);
        for pointer in collect_leaf_pointers(&value) {
            provenance.insert(
                (kind, pointer.clone()),
                ConfigProvenance {
                    json_pointer: format!(
                        "/{}/{pointer}",
                        kind.file_name().trim_end_matches(".json")
                    ),
                    origin: ConfigOrigin::Default,
                    project_id: None,
                },
            );
        }

        if let Some(user) = user_documents.get(&kind) {
            merge_values(&mut value, user);
            for pointer in collect_leaf_pointers(user) {
                provenance.insert(
                    (kind, pointer.clone()),
                    ConfigProvenance {
                        json_pointer: format!(
                            "/{}/{pointer}",
                            kind.file_name().trim_end_matches(".json")
                        ),
                        origin: ConfigOrigin::User,
                        project_id: None,
                    },
                );
            }
        }
        let user_effective = value.clone();

        for (project_id, project_documents) in project_documents {
            if let Some(project) = project_documents.get(&kind) {
                merge_values(&mut value, project);
                for pointer in collect_leaf_pointers(project) {
                    provenance.insert(
                        (kind, pointer.clone()),
                        ConfigProvenance {
                            json_pointer: format!(
                                "/{}/{pointer}",
                                kind.file_name().trim_end_matches(".json")
                            ),
                            origin: ConfigOrigin::Project,
                            project_id: Some((*project_id).to_string()),
                        },
                    );
                }
            }
        }
        apply_project_restrictions(
            kind,
            &mut value,
            &user_effective,
            project_documents,
            &mut provenance,
        );

        if let Some(session) = session_documents.get(&kind) {
            merge_values(&mut value, session);
            for pointer in collect_leaf_pointers(session) {
                provenance.insert(
                    (kind, pointer.clone()),
                    ConfigProvenance {
                        json_pointer: format!(
                            "/{}/{pointer}",
                            kind.file_name().trim_end_matches(".json")
                        ),
                        origin: ConfigOrigin::Session,
                        project_id: None,
                    },
                );
            }
        }

        effective.insert(
            kind.file_name().trim_end_matches(".json").to_string(),
            value,
        );
    }

    (effective, provenance.into_values().collect())
}

pub fn schema_map() -> BTreeMap<ConfigDocumentKind, Value> {
    ConfigDocumentKind::ALL
        .into_iter()
        .map(|kind| {
            let schema = serde_json::to_value(schema_for_kind(kind)).unwrap_or_else(|_| json!({}));
            (kind, schema)
        })
        .collect()
}

pub fn strip_default_values(document: &mut Value, defaults: &Value) {
    let (Some(document), Some(defaults)) = (document.as_object_mut(), defaults.as_object()) else {
        return;
    };

    let keys = document.keys().cloned().collect::<Vec<_>>();
    for key in keys {
        if key == "$schema" || key == "schemaVersion" {
            continue;
        }
        let Some(default_value) = defaults.get(&key) else {
            continue;
        };
        let should_remove = if let Some(value) = document.get_mut(&key) {
            if value.is_object() && default_value.is_object() {
                strip_default_values(value, default_value);
                value.as_object().is_some_and(Map::is_empty)
            } else {
                value == default_value
            }
        } else {
            false
        };
        if should_remove {
            document.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_document_validates_when_persisted() {
        for kind in ConfigDocumentKind::ALL {
            let mut document = default_document(kind);
            let sparse = sparse_document(kind);
            document
                .as_object_mut()
                .expect("default document object")
                .insert(
                    "$schema".to_string(),
                    sparse.get("$schema").expect("schema").clone(),
                );
            let result = validate_document(kind, &ConfigScope::User, &document);
            assert!(result.valid, "{kind:?}: {:?}", result.diagnostics);
        }
    }

    #[test]
    fn rejects_unknown_fields_and_plain_secrets() {
        let mut document = sparse_document(ConfigDocumentKind::Providers);
        document["providers"] = json!({
            "custom": {
                "providerType": "openai-compatible",
                "apiKey": "secret",
                "unexpected": true
            }
        });
        let result =
            validate_document(ConfigDocumentKind::Providers, &ConfigScope::User, &document);
        assert!(!result.valid);
        assert!(result
            .diagnostics
            .iter()
            .any(|entry| entry.code == "config.secret.plaintext_forbidden"));
        assert!(result
            .diagnostics
            .iter()
            .any(|entry| entry.code == "config.schema.invalid"));
    }

    #[test]
    fn project_cannot_raise_tool_risk_or_grant_skill_trust() {
        let global = default_document(ConfigDocumentKind::Tools);
        let project = json!({"riskLevel": "yolo"});
        assert!(
            project_overlay_is_restrictive(ConfigDocumentKind::Tools, &global, &project).is_err()
        );

        let mut skills = sparse_document(ConfigDocumentKind::Skills);
        skills["permissions"] = json!({});
        let result = validate_document(
            ConfigDocumentKind::Skills,
            &ConfigScope::Project {
                project_id: "project".to_string(),
            },
            &skills,
        );
        assert!(!result.valid);
    }

    #[test]
    fn deleting_a_property_restores_default_during_merge() {
        let mut effective = default_document(ConfigDocumentKind::Settings);
        merge_values(&mut effective, &json!({"appearance": {"theme": "light"}}));
        assert_eq!(
            effective.pointer("/appearance/theme"),
            Some(&json!("light"))
        );

        effective = default_document(ConfigDocumentKind::Settings);
        merge_values(&mut effective, &json!({"appearance": {}}));
        assert_eq!(
            effective.pointer("/appearance/theme"),
            Some(&json!("macro-dark"))
        );
    }

    #[test]
    fn multi_project_merge_keeps_the_most_restrictive_values() {
        let user = BTreeMap::from([
            (
                ConfigDocumentKind::Tools,
                json!({"riskLevel":"yolo","builtIn":{"write_file":true}}),
            ),
            (
                ConfigDocumentKind::Agents,
                json!({"maxTurns":20,"models":{"chat":{"modelId":"global"}}}),
            ),
        ]);
        let first = BTreeMap::from([
            (
                ConfigDocumentKind::Tools,
                json!({"riskLevel":"balanced","builtIn":{"write_file":false}}),
            ),
            (
                ConfigDocumentKind::Agents,
                json!({"maxTurns":12,"models":{"chat":{"modelId":"first"}}}),
            ),
        ]);
        let second = BTreeMap::from([
            (
                ConfigDocumentKind::Tools,
                json!({"riskLevel":"strict","builtIn":{"write_file":true}}),
            ),
            (
                ConfigDocumentKind::Agents,
                json!({"maxTurns":8,"models":{"chat":{"modelId":"second"}}}),
            ),
        ]);

        let (effective, _) = effective_documents(
            &user,
            &[("first", &first), ("second", &second)],
            &BTreeMap::new(),
        );

        assert_eq!(
            effective["tools"].pointer("/builtIn/write_file"),
            Some(&json!(false))
        );
        assert_eq!(
            effective["tools"].pointer("/riskLevel"),
            Some(&json!("strict"))
        );
        assert_eq!(effective["agents"].pointer("/maxTurns"), Some(&json!(8)));
        assert_eq!(
            effective["agents"].pointer("/models/chat/modelId"),
            Some(&json!("global"))
        );
    }

    #[test]
    fn one_project_cannot_relax_globally_hardened_limits() {
        let user = BTreeMap::from([
            (
                ConfigDocumentKind::Tools,
                json!({"riskLevel":"strict","builtIn":{"write_file":false}}),
            ),
            (ConfigDocumentKind::Agents, json!({"maxTurns":8})),
        ]);
        let project = BTreeMap::from([
            (
                ConfigDocumentKind::Tools,
                json!({"riskLevel":"yolo","builtIn":{"write_file":true}}),
            ),
            (ConfigDocumentKind::Agents, json!({"maxTurns":20})),
        ]);

        let (effective, _) = effective_documents(&user, &[("project", &project)], &BTreeMap::new());

        assert_eq!(effective["tools"]["riskLevel"], json!("strict"));
        assert_eq!(effective["tools"]["builtIn"]["write_file"], json!(false));
        assert_eq!(effective["agents"]["maxTurns"], json!(8));
    }

    #[test]
    fn mcp_environment_secrets_require_secret_references() {
        for name in [
            "API_TOKEN",
            "api-token",
            "GH_TOKEN",
            "ACCESS_TOKEN",
            "DB_PASSWORD",
            "db-password",
        ] {
            let mut document = sparse_document(ConfigDocumentKind::Tools);
            document["mcpServers"] = json!({
                "server": {
                    "transport": {
                        "type": "stdio",
                        "command": "server",
                        "args": [],
                        "env": { name: "plaintext" }
                    }
                }
            });
            let result =
                validate_document(ConfigDocumentKind::Tools, &ConfigScope::User, &document);
            assert!(
                result.diagnostics.iter().any(|entry| {
                    entry.code == "config.secret.plaintext_forbidden"
                        && entry.path.as_deref()
                            == Some(format!("/mcpServers/server/transport/env/{name}").as_str())
                }),
                "{name} must be rejected"
            );

            document["mcpServers"]["server"]["transport"]["env"][name] =
                json!("macro-secret://mcp-env:server:credential");
            let result =
                validate_document(ConfigDocumentKind::Tools, &ConfigScope::User, &document);
            assert!(result.valid, "{name}: {:?}", result.diagnostics);
        }
    }

    #[test]
    fn descriptor_registry_covers_each_setting_root_and_no_removed_target() {
        let mut targets = BTreeSet::new();
        let registry = descriptors();
        for descriptor in &registry {
            assert!(targets.insert((descriptor.document, descriptor.json_pointer.clone())));
            assert_ne!(descriptor.lifecycle, ConfigLifecycle::Removed);
        }

        for kind in ConfigDocumentKind::ALL {
            let schema = schema_for_kind(kind);
            let properties = schema
                .schema
                .object
                .as_ref()
                .expect("document object schema")
                .properties
                .keys()
                .filter(|property| {
                    !matches!(
                        property.as_str(),
                        "$schema" | "schemaVersion" | "extensions"
                    )
                })
                .cloned()
                .collect::<BTreeSet<_>>();
            let described = registry
                .iter()
                .filter(|descriptor| descriptor.document == kind)
                .filter_map(|descriptor| {
                    descriptor
                        .json_pointer
                        .trim_start_matches('/')
                        .split('/')
                        .next()
                        .map(str::to_string)
                })
                .collect::<BTreeSet<_>>();
            assert_eq!(properties, described, "couverture incomplète pour {kind:?}");
        }
    }
}
