//! A separate native profile owns authentication, config and session files.
//! It never borrows a user's default CODEX_HOME or provider credentials.
use crate::config::ConfigManager;
use crate::core::process::background_contained_tokio_command;
use crate::db::agsdl_execution::{failure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) const ADAPTER: &str = "codex-app-server-v1";
pub(crate) const VERSION: &str = "0.163.0";
pub(crate) const PROVIDER: &str = "codex-native";
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexStatus {
    pub available: bool,
    pub code: String,
    pub version: Option<String>,
    pub platform: String,
    pub tool_policy: String,
}
#[derive(Clone)]
pub(crate) struct Profile {
    pub executable: PathBuf,
    pub directory: PathBuf,
    pub home: PathBuf,
    pub bootstrap: PathBuf,
    pub digest: String,
}
fn unavailable(code: &str) -> CodexStatus {
    CodexStatus {
        available: false,
        code: code.into(),
        version: None,
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        tool_policy: "codex-native".into(),
    }
}
fn executable() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
        .and_then(|path| {
            if path.file_name().is_some_and(|name| name == "codex.js") {
                let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
                    ("linux", "aarch64") => ("codex-linux-arm64", "aarch64-unknown-linux-musl"),
                    ("linux", "x86_64") => ("codex-linux-x64", "x86_64-unknown-linux-musl"),
                    _ => return None,
                };
                let native = path
                    .parent()?
                    .parent()?
                    .join("node_modules/@openai")
                    .join(triple.0)
                    .join("vendor")
                    .join(triple.1)
                    .join("bin/codex");
                native.canonicalize().ok()
            } else {
                Some(path)
            }
        })
}
fn context_io(_: std::io::Error) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "CODEX_CONTEXT_UNQUALIFIED",
        "bootstrap",
        "Private native context cannot be attested",
    )
}
#[cfg(unix)]
fn bootstrap(directory: &Path, context: &Path) -> Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    #[derive(Serialize, Deserialize)]
    struct Receipt {
        path: PathBuf,
        device: u64,
        inode: u64,
    }
    let receipt = directory.join("bootstrap.json");
    let saved: Receipt = if receipt.try_exists().map_err(context_io)? {
        if receipt
            .symlink_metadata()
            .map_err(context_io)?
            .file_type()
            .is_symlink()
        {
            return Err(failure(
                "CODEX_CONTEXT_UNQUALIFIED",
                "bootstrap",
                "Native bootstrap reference is a symlink",
            ));
        }
        serde_json::from_slice(&std::fs::read(&receipt).map_err(context_io)?)?
    } else {
        let parent = context.parent().ok_or_else(|| {
            failure(
                "CODEX_CONTEXT_UNQUALIFIED",
                "bootstrap",
                "Native context parent is absent",
            )
        })?;
        if !parent.exists() {
            private_directory(parent)?;
        }
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(context)
            .map_err(context_io)?;
        let path = context.to_path_buf();
        let metadata = path.symlink_metadata().map_err(context_io)?;
        let saved = Receipt {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&receipt)
            .map_err(context_io)?;
        file.write_all(&serde_json::to_vec(&saved)?)
            .map_err(context_io)?;
        file.sync_all().map_err(context_io)?;
        saved
    };
    let metadata = saved.path.symlink_metadata().map_err(|_| {
        failure(
            "CODEX_CONTEXT_UNQUALIFIED",
            "bootstrap",
            "Captured native bootstrap disappeared",
        )
    })?;
    if saved.path != context
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
        || metadata.dev() != saved.device
        || metadata.ino() != saved.inode
        || saved.path.canonicalize().map_err(context_io)? != saved.path
        || std::fs::read_dir(&saved.path)
            .map_err(context_io)?
            .next()
            .is_some()
    {
        return Err(failure(
            "CODEX_CONTEXT_UNQUALIFIED",
            "bootstrap",
            "Captured native bootstrap changed or is not private and empty",
        ));
    }
    Ok(saved.path)
}
#[cfg(not(unix))]
fn bootstrap(_: &Path, _: &Path) -> Result<PathBuf> {
    Err(failure(
        "CODEX_PLATFORM_UNQUALIFIED",
        "bootstrap",
        "Private native bootstrap is not qualified on this platform",
    ))
}
fn context_roots_are_empty(directory: &Path, home: &Path) -> Result<()> {
    match std::fs::symlink_metadata("/etc/codex/skills") {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        _ => {
            return Err(failure(
                "CODEX_CONTEXT_UNQUALIFIED",
                "skills",
                "An administrator native skills root is present or cannot be attested absent",
            ))
        }
    }
    for root in [home.join(".agents"), directory.join("codex/skills")] {
        if std::fs::read_dir(root)
            .map_err(context_io)?
            .next()
            .is_some()
        {
            return Err(failure(
                "CODEX_CONTEXT_UNQUALIFIED",
                "skills",
                "Private native context roots are no longer empty",
            ));
        }
    }
    Ok(())
}
fn private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(context_io(error)),
        }
        let metadata = path.symlink_metadata().map_err(context_io)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
            || path.canonicalize().map_err(context_io)? != path
        {
            return Err(failure(
                "CODEX_CONTEXT_UNQUALIFIED",
                "profile",
                "Native profile path is not a private owned directory",
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(failure(
            "CODEX_PLATFORM_UNQUALIFIED",
            "profile",
            "Native profile protection is not qualified",
        ))
    }
}
pub(crate) fn prepare(manager: &ConfigManager) -> Result<Profile> {
    let executable = executable().ok_or_else(|| {
        failure(
            "CODEX_NOT_INSTALLED",
            "engine",
            "Codex CLI 0.163.0 is required",
        )
    })?;
    let directory = manager.root().join("native-engines").join("codex-v1");
    let home = directory.join("home");
    for path in [
        manager.root().join("native-engines"),
        directory.clone(),
        home.clone(),
        directory.join("codex"),
        home.join(".agents"),
        directory.join("codex/skills"),
    ] {
        private_directory(&path)?;
    }
    context_roots_are_empty(&directory, &home)?;
    let bootstrap = bootstrap(&directory, &manager.root().join("native-contexts/codex-v1"))?;
    let bytes = std::fs::read(&executable).map_err(|_| {
        failure(
            "CODEX_NOT_INSTALLED",
            "engine",
            "Cannot identify Codex executable",
        )
    })?;
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            VERSION,
            std::env::consts::OS,
            std::env::consts::ARCH,
            format!("{:x}", Sha256::digest(bytes)),
            directory.to_string_lossy().as_ref(),
            bootstrap.to_string_lossy().as_ref(),
            "native-bootstrap-v1"
        ))?)
    );
    Ok(Profile {
        executable,
        directory,
        home,
        bootstrap,
        digest,
    })
}
impl Profile {
    pub fn command(&self) -> tokio::process::Command {
        let mut command = background_contained_tokio_command(&self.executable);
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("CODEX_HOME", self.directory.join("codex"))
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_DATA_HOME", self.home.join(".local/share"))
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .current_dir(&self.directory);
        command
    }
    pub fn settings(&self, root: &Path, read_only: bool) -> Result<Value> {
        if self.directory.starts_with(root)
            || root.starts_with(&self.directory)
            || self.bootstrap.starts_with(root)
            || root.starts_with(&self.bootstrap)
        {
            return Err(failure(
                "CODEX_PROFILE_UNQUALIFIED",
                "scope",
                "Workspace and private native profile overlap",
            ));
        }
        let binary = self.executable.parent().ok_or_else(|| {
            failure(
                "UNSUPPORTED",
                "engine",
                "Codex native executable has no directory",
            )
        })?;
        let mut tool_files = serde_json::Map::new();
        tool_files.insert(":minimal".into(), json!("read"));
        tool_files.insert(self.bootstrap.to_string_lossy().into_owned(), json!("read"));
        tool_files.insert(
            root.to_string_lossy().into_owned(),
            json!(if read_only { "read" } else { "write" }),
        );
        tool_files.insert(binary.to_string_lossy().into_owned(), json!("read"));
        for path in [root.join(".macro"), self.directory.clone()] {
            tool_files.insert(path.to_string_lossy().into_owned(), json!("deny"));
        }
        for name in [".git", ".agents", ".codex", ".aws"] {
            tool_files.insert(
                root.join(name).to_string_lossy().into_owned(),
                json!("read"),
            );
        }
        // Context discovery stays at the private empty bootstrap. Existing
        // metadata can be read only as explicit workspace data by native tools.
        Ok(
            json!({"features":{"plugins":false,"remote_plugin":false,"apps":false,"hooks":false,"shell_snapshot":false,"shell_snapshot_v2":false,
            "memories":false,"goals":false,"code_mode":false,"image_generation":false,"multi_agent":false,"multi_agent_v2":false},
            "cloud":{"skills":{"enabled":false}},"allow_login_shell":false,"agents":{"enabled":false},"notify":[],"skills":{"include_instructions":false,"bundled":{"enabled":false}},
            "project_root_markers":[],"project_doc_max_bytes":0,"web_search":"disabled","shell_environment_policy":{"inherit":"none","experimental_use_profile":false,"set":{"PATH":"/usr/local/bin:/usr/bin:/bin","HOME":self.home,"CODEX_HOME":self.directory.join("codex"),"XDG_CONFIG_HOME":self.home.join(".config"),"XDG_DATA_HOME":self.home.join(".local/share"),"LANG":"C.UTF-8"}},
            "approval_policy":"never","cli_auth_credentials_store":"file","default_permissions":"macro-agsdl",
            "permissions":{"macro-agsdl":{"workspace_roots":{(self.bootstrap.to_string_lossy().into_owned()):true},"filesystem":tool_files,"network":{"enabled":false}}}}),
        )
    }
    pub fn app_server_command(
        &self,
        root: &Path,
        read_only: bool,
    ) -> Result<tokio::process::Command> {
        let settings = self.settings(root, read_only)?;
        let mut flags = Vec::new();
        fn inline_toml(value: &Value) -> Result<String> {
            if let Some(object) = value.as_object() {
                return Ok(format!(
                    "{{{}}}",
                    object
                        .iter()
                        .map(|(key, value)| Ok(format!(
                            "{}={}",
                            serde_json::to_string(key)?,
                            inline_toml(value)?
                        )))
                        .collect::<Result<Vec<_>>>()?
                        .join(",")
                ));
            }
            Ok(serde_json::to_string(value)?)
        }
        for (key, value) in settings.as_object().expect("private settings object") {
            flags.push(format!("{key}={}", inline_toml(value)?));
        }
        let mut command = self.command();
        for flag in &flags {
            command.args(["-c", flag]);
        }
        command.current_dir(&self.bootstrap);
        command.args(["app-server", "--listen", "stdio://"]);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        Ok(command)
    }
    pub fn identity(&self) -> String {
        json!({"format":"macro-codex-native-profile/1","version":VERSION,"platform":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),
            "digest":self.digest,"toolPolicy":"codex-native","approvalPolicy":"never"}).to_string()
    }
    pub fn attestation(&self, read_only: bool, scope: &Value) -> Result<String> {
        Ok(json!({"format":"macro-codex-native-profile/1","version":VERSION,"platform":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),
            "digest":self.digest,"toolPolicy":"codex-native","approvalPolicy":"never","readOnly":read_only,"contextCwd":self.bootstrap,
            "scopeDigest":format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(scope)?)),
            "policyDigest":format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(&self.settings(Path::new(scope["root"].as_str().ok_or_else(|| failure("CORRELATION","scope","Scope root absent"))?),read_only)?)?))}).to_string())
    }
}
pub(crate) async fn status(manager: &ConfigManager) -> CodexStatus {
    let profile = match prepare(manager) {
        Ok(profile) => profile,
        Err(error) => return unavailable(&error.code),
    };
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        profile.command().arg("--version").output(),
    )
    .await;
    let mut result = unavailable("CODEX_VERSION_UNQUALIFIED");
    let Ok(Ok(output)) = output else {
        return result;
    };
    if String::from_utf8_lossy(&output.stdout).trim() != format!("codex-cli {VERSION}") {
        return result;
    }
    result.version = Some(VERSION.into());
    if !cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        result.code = "CODEX_PLATFORM_UNQUALIFIED".into();
        return result;
    }
    // Existence is enough to offer the next diagnostic. Native account/read is
    // the authentication authority; this host never parses auth.json itself.
    if !profile.directory.join("codex/auth.json").is_file() {
        result.code = "CODEX_LOGIN_REQUIRED".into();
        return result;
    }
    result.code = "CODEX_SCOPE_CHECK_REQUIRED".into();
    result.available = true;
    result
}

/// Reject all active executable config outside the profile before starting a
/// thread. Project layers must be disabled. Managed sources cannot be assumed
/// empty merely because command-line flags were supplied.
pub(crate) fn verify_layers(
    value: &Value,
    profile: &Profile,
    root: &Path,
    read_only: bool,
) -> Result<()> {
    let layers = value
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            failure(
                "CODEX_PROFILE_UNQUALIFIED",
                "engine",
                "Codex config layers were not observed",
            )
        })?;
    for layer in layers {
        if layer
            .get("disabledReason")
            .and_then(Value::as_str)
            .is_some()
        {
            continue;
        }
        let name = &layer["name"];
        let kind = name["type"].as_str().unwrap_or("");
        let empty = layer["config"]
            .as_object()
            .is_some_and(|value| value.is_empty());
        if !empty && kind != "sessionFlags" {
            return Err(failure(
                "CODEX_PROFILE_UNQUALIFIED",
                "engine",
                "An inherited Codex config layer is active",
            ));
        }
    }
    let config = &value["config"];
    let expected = profile.settings(root, read_only)?;
    fn contains(actual: &Value, expected: &Value) -> bool {
        if let Some(expected) = expected.as_object() {
            return expected.iter().all(|(key, value)| {
                actual
                    .get(key)
                    .is_some_and(|actual| contains(actual, value))
            });
        }
        actual == expected
    }
    fn without_null_defaults(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, value)| (key.clone(), without_null_defaults(value)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    if !contains(config, &expected)
        || without_null_defaults(&config["permissions"]) != expected["permissions"]
        || config
            .get("mcp_servers")
            .and_then(Value::as_object)
            .is_some_and(|servers| !servers.is_empty())
    {
        return Err(failure(
            "CODEX_PROFILE_UNQUALIFIED",
            "engine",
            "Effective Codex configuration differs from the complete captured native policy",
        ));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_is_stable_and_changes_are_refused_without_deleting_data() {
        let private = tempfile::tempdir().unwrap();
        let context = private.path().join("context");
        let path = bootstrap(private.path(), &context).unwrap();
        assert_eq!(bootstrap(private.path(), &context).unwrap(), path);
        std::fs::write(path.join("foreign"), "synthetic").unwrap();
        assert_eq!(
            bootstrap(private.path(), &context).unwrap_err().code,
            "CODEX_CONTEXT_UNQUALIFIED"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("foreign")).unwrap(),
            "synthetic"
        );
        std::fs::remove_file(path.join("foreign")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(
            bootstrap(private.path(), &context).unwrap_err().code,
            "CODEX_CONTEXT_UNQUALIFIED"
        );
        assert!(!path.exists());
    }
}
