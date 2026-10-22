//! Explicit external installation, private context and replaced process environment.
use crate::config::ConfigManager;
use crate::core::process::background_contained_tokio_command;
use crate::db::agsdl_execution::{failure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
pub(crate) const ADAPTER: &str = "claude-sdk-v1";
pub(crate) const VERSION: &str = "0.3.308";
pub(crate) const CLI_VERSION: &str = "2.1.308";
pub(crate) const PROVIDER: &str = "claude-native";
pub(crate) const INSTALL_URL: &str = "https://platform.claude.com/docs/en/agent-sdk/quickstart";
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeStatus {
    pub available: bool,
    pub code: String,
    pub version: Option<String>,
    pub tool_policy: String,
    pub installation_url: String,
}
#[derive(Clone)]
pub(crate) struct Profile {
    pub node: PathBuf,
    pub sdk: PathBuf,
    pub zod: PathBuf,
    pub cli: PathBuf,
    pub directory: PathBuf,
    pub home: PathBuf,
    pub cache: PathBuf,
    pub config: PathBuf,
    pub bootstrap: PathBuf,
    pub digest: String,
    pub workspace: Option<String>,
    pub qa_endpoint: Option<String>,
}
fn context_error() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "CLAUDE_CONTEXT_UNQUALIFIED",
        "profile",
        "Claude context contains an external source or cannot be attested",
    )
}
fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
pub(crate) fn private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(context_error()),
        }
        let m = path.symlink_metadata().map_err(|_| context_error())?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o777 != 0o700
            || path.canonicalize().map_err(|_| context_error())? != path
        {
            return Err(context_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(context_error())
    }
}
fn explicit(name: &str) -> Result<PathBuf> {
    let path = std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute())
        .ok_or_else(|| failure("CLAUDE_NOT_INSTALLED", "installation", "Set explicit MACRO_CLAUDE_NODE, MACRO_CLAUDE_SDK and MACRO_CLAUDE_CLI paths; install the SDK separately"))?;
    let path = path.canonicalize().map_err(|_| {
        failure(
            "CLAUDE_NOT_INSTALLED",
            "installation",
            "External Claude installation is unavailable",
        )
    })?;
    if !path.is_file() {
        return Err(failure(
            "CLAUDE_NOT_INSTALLED",
            "installation",
            "External Claude installation is not a file",
        ));
    }
    Ok(path)
}
fn absent(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(context_error()),
    }
}
impl Profile {
    pub fn verify_context(&self) -> Result<()> {
        for root in [&self.home, &self.bootstrap] {
            if std::fs::read_dir(root)
                .map_err(|_| context_error())?
                .next()
                .is_some()
            {
                return Err(context_error());
            }
        }
        // Managed files are independent of settingSources. Refuse them before spawning.
        for path in [
            "/etc/claude-code",
            "/etc/claude",
            "/usr/local/etc/claude-code",
        ] {
            absent(Path::new(path))?;
        }
        for name in [
            "settings.json",
            "settings.local.json",
            "CLAUDE.md",
            "agents",
            "skills",
            "plugins",
            "hooks",
            "commands",
            "output-styles",
            ".mcp.json",
            "managed-settings.json",
            "memory",
        ] {
            absent(&self.config.join(name))?;
        }
        // The native global file has non-executable startup metadata. Reject every
        // unqualified field rather than assuming settingSources closes this file.
        let global = self.config.join(".claude.json");
        if global.try_exists().map_err(|_| context_error())? {
            if global
                .symlink_metadata()
                .map_err(|_| context_error())?
                .file_type()
                .is_symlink()
            {
                return Err(context_error());
            }
            let value: Value =
                serde_json::from_slice(&std::fs::read(global).map_err(|_| context_error())?)?;
            let allowed = [
                "firstStartTime",
                "firstStartVersion",
                "machineID",
                "opusProMigrationComplete",
                "sonnet1m45MigrationComplete",
                "seenNotifications",
                "hasResetAutoModeOptInForDefaultOffer",
                "migrationVersion",
                "userID",
                "pluginUsage",
            ];
            if value
                .as_object()
                .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
            {
                return Err(context_error());
            }
        }
        Ok(())
    }
    pub fn identity(&self) -> String {
        json!({"format":"macro-claude-controlled-profile/1","version":VERSION,"cliVersion":CLI_VERSION,"digest":self.digest,"toolPolicy":"macro-controlled","contextCwd":self.bootstrap,"cacheDirectory":self.cache}).to_string()
    }
    pub fn attestation(&self, scope: &Value) -> Result<String> {
        let root = Path::new(scope["root"].as_str().ok_or_else(context_error)?);
        if root.starts_with(&self.directory)
            || self.directory.starts_with(root)
            || root.starts_with(&self.bootstrap)
            || self.bootstrap.starts_with(root)
        {
            return Err(context_error());
        }
        Ok(json!({"profileJson":self.identity(),"scopeDigest":format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(scope)?))}).to_string())
    }
    pub(crate) fn runner_path(&self) -> PathBuf {
        self.directory.join(format!(
            "runner-{:x}.mjs",
            Sha256::digest(include_bytes!("runner.mjs"))
        ))
    }
    pub fn command(&self, api_key: &str, qa: bool) -> tokio::process::Command {
        let mut command = background_contained_tokio_command(&self.node);
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("XDG_CACHE_HOME", &self.cache)
            .env("CLAUDE_CONFIG_DIR", &self.config)
            .env("TMPDIR", self.directory.join("tmp"))
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env("ANTHROPIC_API_KEY", api_key)
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("DISABLE_AUTOUPDATER", "1")
            .env("DISABLE_TELEMETRY", "1")
            .env("DISABLE_ERROR_REPORTING", "1")
            .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
            .env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1")
            .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
            .env("CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "1")
            .env("CLAUDE_CODE_DISABLE_FILE_MENTIONS", "1")
            .env("ENABLE_TOOL_SEARCH", "false")
            .env("CLAUDE_CODE_DISABLE_ADVISOR_TOOL", "1")
            .env("CLAUDE_CODE_DISABLE_WORKFLOWS", "1")
            .env("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1")
            .env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1")
            .env("CLAUDE_CODE_MAX_RETRIES", "0")
            .env("DISABLE_DOCTOR_COMMAND", "1")
            .env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")
            .env("CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "1")
            .env("CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "1")
            .env("CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK", "1")
            .env("CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "1")
            .env("CLAUDE_CODE_DISABLE_POLICY_SKILLS", "1")
            .env("CLAUDE_CODE_DISABLE_CRON", "1")
            .env("CLAUDE_CODE_DISABLE_ARTIFACT", "1")
            .current_dir(&self.bootstrap)
            .arg(self.runner_path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if let Some(workspace) = &self.workspace {
            command.env(
                "ANTHROPIC_CUSTOM_HEADERS",
                format!("anthropic-workspace-id: {workspace}"),
            );
        }
        if qa {
            if cfg!(debug_assertions) {
                if let Some(endpoint) = &self.qa_endpoint {
                    command.env("ANTHROPIC_BASE_URL", endpoint);
                }
            }
            command.env("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "1024");
        }
        command
    }
}
pub(crate) fn prepare(manager: &ConfigManager) -> Result<Profile> {
    if !cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        return Err(failure(
            "CLAUDE_PLATFORM_UNQUALIFIED",
            "platform",
            "Claude controlled profile is qualified only on Linux arm64",
        ));
    }
    let (node, sdk, cli) = (
        explicit("MACRO_CLAUDE_NODE")?,
        explicit("MACRO_CLAUDE_SDK")?,
        explicit("MACRO_CLAUDE_CLI")?,
    );
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(sdk.parent().ok_or_else(context_error)?.join("package.json"))
            .map_err(|_| context_error())?,
    )?;
    if manifest["name"] != "@anthropic-ai/claude-agent-sdk"
        || manifest["version"] != VERSION
        || sdk.file_name().is_none_or(|n| n != "sdk.mjs")
    {
        return Err(failure(
            "CLAUDE_VERSION_UNQUALIFIED",
            "sdk",
            "Claude Agent SDK 0.3.308 is required",
        ));
    }
    let zod = sdk
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(context_error)?
        .join("zod")
        .canonicalize()
        .map_err(|_| context_error())?;
    let mut dependency_hash = Sha256::new();
    fn hash_dependency(
        root: &Path,
        path: &Path,
        hash: &mut Sha256,
        count: &mut usize,
    ) -> Result<()> {
        *count += 1;
        if *count > 10_000 {
            return Err(context_error());
        }
        let metadata = path.symlink_metadata().map_err(|_| context_error())?;
        if metadata.file_type().is_symlink() {
            return Err(context_error());
        }
        hash.update(
            path.strip_prefix(root)
                .map_err(|_| context_error())?
                .to_string_lossy()
                .as_bytes(),
        );
        if metadata.is_dir() {
            let mut children = std::fs::read_dir(path)
                .map_err(|_| context_error())?
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|_| context_error())?;
            children.sort_by_key(|e| e.file_name());
            for entry in children {
                hash_dependency(root, &entry.path(), hash, count)?;
            }
        } else if metadata.is_file() && metadata.len() <= 10_000_000 {
            hash.update(Sha256::digest(
                std::fs::read(path).map_err(|_| context_error())?,
            ));
        } else {
            return Err(context_error());
        }
        Ok(())
    }
    hash_dependency(&zod, &zod, &mut dependency_hash, &mut 0)?;
    let directory = manager.root().join("native-engines/claude-v1");
    let home = directory.join("home");
    let cache = directory.join("cache");
    let config = directory.join("claude");
    let bootstrap = manager.root().join("native-contexts/claude-v1");
    for path in [
        manager.root().join("native-engines"),
        directory.clone(),
        home.clone(),
        cache.clone(),
        config.clone(),
        directory.join("tmp"),
        manager.root().join("native-contexts"),
        bootstrap.clone(),
    ] {
        private_directory(&path)?;
    }
    let runner = include_str!("runner.mjs");
    let runner_path = directory.join(format!(
        "runner-{:x}.mjs",
        Sha256::digest(runner.as_bytes())
    ));
    if runner_path.try_exists().map_err(|_| context_error())? {
        if runner_path
            .symlink_metadata()
            .map_err(|_| context_error())?
            .file_type()
            .is_symlink()
            || std::fs::read(&runner_path).map_err(|_| context_error())? != runner.as_bytes()
        {
            return Err(context_error());
        }
    } else {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&runner_path).map_err(|_| context_error())?;
        file.write_all(runner.as_bytes())
            .map_err(|_| context_error())?;
        file.sync_all().map_err(|_| context_error())?;
    }
    let workspace = std::env::var("MACRO_CLAUDE_WORKSPACE_ID").ok();
    if workspace.as_ref().is_some_and(|s| !valid_workspace_id(s)) {
        return Err(context_error());
    }
    let qa_endpoint = if cfg!(debug_assertions) {
        std::env::var("MACRO_AGSDL_CLAUDE_QA_BASE_URL").ok()
    } else {
        None
    };
    if let Some(endpoint) = &qa_endpoint {
        let parsed = reqwest::Url::parse(endpoint).map_err(|_| context_error())?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || parsed.path() != "/"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(context_error());
        }
    }
    let mut hash = Sha256::new();
    hash.update(qa_endpoint.as_deref().unwrap_or("").as_bytes());
    hash.update(dependency_hash.finalize());
    hash.update(workspace.as_deref().unwrap_or("").as_bytes());
    for path in [&node, &sdk, &cli, &runner_path] {
        hash.update(path.to_string_lossy().as_bytes());
        hash.update(Sha256::digest(
            std::fs::read(path).map_err(|_| context_error())?,
        ));
    }
    hash.update(directory.to_string_lossy().as_bytes());
    hash.update(bootstrap.to_string_lossy().as_bytes());
    hash.update(cache.to_string_lossy().as_bytes());
    let profile = Profile {
        node,
        sdk,
        zod,
        cli,
        directory,
        home,
        cache,
        config,
        bootstrap,
        workspace,
        qa_endpoint,
        digest: format!("sha256:{:x}", hash.finalize()),
    };
    profile.verify_context()?;
    Ok(profile)
}
pub(crate) fn unavailable(code: &str) -> ClaudeStatus {
    ClaudeStatus {
        available: false,
        code: code.into(),
        version: None,
        tool_policy: "macro-controlled".into(),
        installation_url: INSTALL_URL.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::valid_workspace_id;
    #[test]
    fn native_workspace_routing_accepts_official_shape_and_rejects_header_injection() {
        assert!(valid_workspace_id("wrkspc_synthetic-0123"));
        for value in [
            "",
            "wrkspc synthetic",
            "wrkspc:test",
            "wrkspc_test\r\nx-other: value",
            "wrkspc_test\n",
            "é",
        ] {
            assert!(!valid_workspace_id(value));
        }
        assert!(!valid_workspace_id(&"x".repeat(257)));
    }
}
