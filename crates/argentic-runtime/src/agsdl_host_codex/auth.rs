//! Host-selected file authentication only. No config loading, OAuth or writes.
//! Credentials are serialized solely to the contained app-server's private stdin.
use crate::persistence::{dto::EngineFailure, failure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, OwnedMutexGuard},
};

pub(super) const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const FILE_LIMIT: u64 = 128 * 1024;

pub(super) fn error(code: &str) -> EngineFailure {
    failure(code, "authentication", match code {
        "CODEX_AUTH_EXPIRED" => "The selected ChatGPT access token has expired; this host never renews the ordinary session",
        "CODEX_AUTH_ACCOUNT_CHANGED" => "The selected ChatGPT account or attested routing differs from the capture",
        "CODEX_AUTH_REFRESH_REQUIRED" => "Codex rejected the access token and no renewed token for the same account is available",
        "CODEX_AUTH_TIMEOUT" => "Native authentication did not complete within its deadline",
        "CODEX_AUTH_PROFILE_CONFLICT" => "External authentication requires a private execution profile without stored auth",
        "CODEX_AUTH_SOURCE_UNSUPPORTED" => "Expected an explicitly selected private ChatGPT file session outside the workspace and execution profile",
        "CODEX_AUTH_SOURCE_UNAVAILABLE" => "The explicitly selected ChatGPT file session is unavailable",
        _ => "Native external ChatGPT authentication was refused",
    })
}

pub(super) fn no_private_auth(profile: &Path) -> Result<()> {
    match std::fs::symlink_metadata(profile.join("codex/auth.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(error("CODEX_AUTH_PROFILE_CONFLICT")),
    }
}

// Deliberately no Debug/Serialize or refresh/id-token fields on these types.
#[derive(Deserialize)]
struct Record {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<serde::de::IgnoredAny>,
    tokens: Option<Tokens>,
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    account_id: String,
}
pub(super) struct Credentials {
    pub access_token: String,
    pub account_id: String,
}
impl Credentials {
    pub fn fingerprint(&self) -> [u8; 32] {
        Sha256::digest(self.access_token.as_bytes()).into()
    }
}

pub(super) fn source_scope(source: &Path, profile: &Path, workspace: &Path) -> Result<()> {
    if !source.is_absolute() || source.starts_with(profile) || source.starts_with(workspace) {
        return Err(error("CODEX_AUTH_SOURCE_UNSUPPORTED"));
    }
    no_private_auth(profile)
}

pub(super) async fn read(source: &Path) -> Result<Credentials> {
    tokio::time::timeout(TIMEOUT, read_file(source))
        .await
        .map_err(|_| error("CODEX_AUTH_TIMEOUT"))?
}
#[cfg(unix)]
async fn read_file(source: &Path) -> Result<Credentials> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let unavailable = || error("CODEX_AUTH_SOURCE_UNAVAILABLE");
    if !source.is_absolute() || source.canonicalize().map_err(|_| unavailable())? != source {
        return Err(unavailable());
    }
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = tokio::fs::OpenOptions::from(options)
        .open(source)
        .await
        .map_err(|_| unavailable())?;
    let meta = file.metadata().await.map_err(|_| unavailable())?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > FILE_LIMIT
    {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(unavailable());
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| error("CODEX_AUTH_SOURCE_UNSUPPORTED"))?;
    if record
        .auth_mode
        .as_deref()
        .is_some_and(|mode| mode != "chatgpt")
        || record.api_key.is_some()
    {
        return Err(error("CODEX_AUTH_SOURCE_UNSUPPORTED"));
    }
    let tokens = record
        .tokens
        .ok_or_else(|| error("CODEX_AUTH_SOURCE_UNSUPPORTED"))?;
    if tokens.account_id.is_empty()
        || tokens.account_id.len() > 256
        || !tokens.account_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(error("CODEX_AUTH_SOURCE_UNSUPPORTED"));
    }
    #[derive(Deserialize)]
    struct Expiry {
        exp: u64,
    }
    let parts: Vec<_> = tokens.access_token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(error("CODEX_AUTH_SOURCE_UNSUPPORTED"));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| error("CODEX_AUTH_SOURCE_UNSUPPORTED"))?;
    let expiry: Expiry =
        serde_json::from_slice(&payload).map_err(|_| error("CODEX_AUTH_SOURCE_UNSUPPORTED"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("CODEX_AUTH_EXPIRED"))?
        .as_secs();
    if expiry.exp <= now {
        return Err(error("CODEX_AUTH_EXPIRED"));
    }
    // JWT expiry is a refusal check, never an identity or execution authority.
    Ok(Credentials {
        access_token: tokens.access_token,
        account_id: tokens.account_id,
    })
}
#[cfg(not(unix))]
async fn read_file(_: &Path) -> Result<Credentials> {
    Err(error("CODEX_AUTH_SOURCE_UNSUPPORTED"))
}

pub(super) struct Session {
    pub source: PathBuf,
    pub profile: super::profile::Profile,
    pub workspace: PathBuf,
    pub read_only: bool,
    pub account_id: String,
    pub token_fingerprint: [u8; 32],
    pub routing_digest: Option<String>,
    pub valid: bool,
}
#[derive(Clone)]
pub(super) struct Guard(pub Arc<Mutex<Session>>);
impl Guard {
    /// Held through physical replies. Refresh holds the same lock until native
    /// account/routing attestation completes, including during human waits.
    pub async fn lock_current(&self) -> Result<OwnedMutexGuard<Session>> {
        let guard = self.0.clone().lock_owned().await;
        if !guard.valid {
            return Err(error("CODEX_AUTH_FAILED"));
        }
        no_private_auth(&guard.profile.directory)?;
        let current = read(&guard.source).await?;
        if current.account_id != guard.account_id {
            return Err(error("CODEX_AUTH_ACCOUNT_CHANGED"));
        }
        Ok(guard)
    }
}

#[cfg(test)]
pub(crate) fn fixture_file(path: &Path, account: &str, exp: u64, generation: &str) {
    use serde_json::json;
    let token = format!(
        "e30.{}.synthetic",
        URL_SAFE_NO_PAD.encode(json!({"exp":exp,"generation":generation}).to_string())
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).unwrap();
    use std::io::Write;
    file.write_all(json!({"auth_mode":"chatgpt","tokens":{"access_token":token,"account_id":account,"id_token":"SYNTHETIC_ID_NEVER_FORWARDED","refresh_token":"SYNTHETIC_REFRESH_NEVER_FORWARDED"}}).to_string().as_bytes()).unwrap();
}
#[cfg(all(test, unix))]
mod tests {
    use super::fixture_file as fixture;
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[tokio::test]
    async fn auth_file_is_read_only_bounded_and_expiry_never_grants_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("auth.json");
        fixture(&path, "synthetic-account", u64::MAX, "one");
        let before = std::fs::read(&path).unwrap();
        let credential = read(&path).await.unwrap();
        assert_eq!(credential.account_id, "synthetic-account");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        fixture(&path, "synthetic-account", 1, "expired");
        assert_eq!(read(&path).await.err().unwrap().code, "CODEX_AUTH_EXPIRED");
    }
    #[tokio::test]
    async fn auth_file_refuses_bad_sources_without_reflecting_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("auth.json");
        assert_eq!(
            read(&path).await.err().unwrap().code,
            "CODEX_AUTH_SOURCE_UNAVAILABLE"
        );
        for text in [
            "SYNTHETIC_SECRET",
            r#"{"auth_mode":"SYNTHETIC_SECRET","tokens":{}}"#,
            r#"{"tokens":{"access_token":"SYNTHETIC_SECRET","account_id":"account"}}"#,
            r#"{"OPENAI_API_KEY":"SYNTHETIC_SECRET"}"#,
        ] {
            std::fs::write(&path, text).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let error = read(&path).await.err().unwrap();
            assert_eq!(error.code, "CODEX_AUTH_SOURCE_UNSUPPORTED");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("SYNTHETIC_SECRET"));
        }
        fixture(&path, "account", u64::MAX, "one");
        let link = root.join("symlink");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(
            read(&link).await.err().unwrap().code,
            "CODEX_AUTH_SOURCE_UNAVAILABLE"
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            read(&path).await.err().unwrap().code,
            "CODEX_AUTH_SOURCE_UNAVAILABLE"
        );
        assert!(read(&root).await.is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&path, root.join("hardlink")).unwrap();
        assert_eq!(
            read(&path).await.err().unwrap().code,
            "CODEX_AUTH_SOURCE_UNAVAILABLE"
        );
        std::fs::remove_file(root.join("hardlink")).unwrap();
        std::fs::write(&path, vec![b' '; FILE_LIMIT as usize + 1]).unwrap();
        assert_eq!(
            read(&path).await.err().unwrap().code,
            "CODEX_AUTH_SOURCE_UNAVAILABLE"
        );
        let fifo = root.join("fifo");
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), read(&fifo))
                .await
                .unwrap()
                .is_err()
        );
    }
    #[test]
    fn auth_source_and_private_profile_never_overlap_or_fallback() {
        assert!(source_scope(
            Path::new("relative"),
            Path::new("/private"),
            Path::new("/workspace")
        )
        .is_err());
        assert!(source_scope(
            Path::new("/workspace/auth.json"),
            Path::new("/private"),
            Path::new("/workspace")
        )
        .is_err());
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("codex")).unwrap();
        no_private_auth(temp.path()).unwrap();
        std::fs::write(temp.path().join("codex/auth.json"), "synthetic").unwrap();
        assert_eq!(
            no_private_auth(temp.path()).unwrap_err().code,
            "CODEX_AUTH_PROFILE_CONFLICT"
        );
        let context = crate::test_context::context(temp.path().join("context"));
        assert!(context.codex_auth_file().is_none());
        assert_eq!(
            context
                .with_codex_auth_file("/explicit/auth.json".into())
                .codex_auth_file(),
            Some(Path::new("/explicit/auth.json"))
        );
    }
}
