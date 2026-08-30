use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

const SECRET_FILE_NAME: &str = "provider-secrets.json";
const SECRET_FILE_VERSION: u8 = 2;
const SECRET_MIGRATION_FILE_NAME: &str = "provider-secrets.migration-pending.json";

static SECRET_STORE_PATH: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));
static STORE_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[cfg(test)]
static FAIL_MIGRATION_AFTER_REPLACE: LazyLock<Mutex<Option<PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretMigrationJournal {
    from_version: u8,
    source_sha256: String,
    target_sha256: String,
    backup_file: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("Secret store has not been initialized.")]
    StoreUnavailable,
    #[error("Secret storage error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Secret serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatGptSecret {
    pub access_token: String,
    pub refresh_token: String,
    pub access_token_expires_at: Option<String>,
    pub account_id: Option<String>,
    pub auth_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct LegacyChatGptSecret {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) id_token: String,
    pub(super) account_id: Option<String>,
    pub(super) client_id: Option<String>,
    pub(super) last_refresh: Option<String>,
    pub(super) source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SecretEnvelope<T> {
    pub(super) version: u8,
    pub(super) kind: String,
    pub(super) payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct ProviderSecretsFile {
    pub(super) version: u8,
    #[serde(skip)]
    pub(super) api_keys: BTreeMap<String, String>,
    #[serde(default)]
    namespaces: SecretNamespaces,
    #[serde(default)]
    pub(super) chatgpt_sessions: BTreeMap<String, ChatGptSecret>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct SecretNamespaces {
    #[serde(default)]
    providers: BTreeMap<String, String>,
    #[serde(default)]
    speech: BTreeMap<String, String>,
    #[serde(default)]
    mcp: BTreeMap<String, String>,
    #[serde(default, rename = "webSearch")]
    web_search: BTreeMap<String, String>,
    #[serde(default)]
    system: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct RawProviderSecretsFile {
    #[serde(default, rename = "version")]
    _version: u8,
    #[serde(default)]
    api_keys: BTreeMap<String, String>,
    #[serde(default)]
    namespaces: SecretNamespaces,
    #[serde(default)]
    chatgpt_sessions: BTreeMap<String, serde_json::Value>,
}

impl Default for ProviderSecretsFile {
    fn default() -> Self {
        Self {
            version: SECRET_FILE_VERSION,
            api_keys: BTreeMap::new(),
            namespaces: SecretNamespaces::default(),
            chatgpt_sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct LocalSecretStore {
    path: PathBuf,
}

impl LocalSecretStore {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(super) fn read_file(&self) -> Result<ProviderSecretsFile, SecretError> {
        match std::fs::read_to_string(&self.path) {
            Ok(contents) => {
                if contents.trim().is_empty() {
                    return Ok(ProviderSecretsFile::default());
                }
                match parse_provider_secrets_file(&contents) {
                    Ok(data) => Ok(data),
                    Err(error) => {
                        self.quarantine_corrupt_file(&error)?;
                        let data = ProviderSecretsFile::default();
                        self.write_file(&data)?;
                        Ok(data)
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ProviderSecretsFile::default())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn write_file(&self, data: &ProviderSecretsFile) -> Result<(), SecretError> {
        let serialized = serialize_provider_secrets(data)?;
        write_private_file_atomically(&self.path, &serialized, || Ok(()))?;
        Ok(())
    }

    pub(super) fn update_file(
        &self,
        update: impl FnOnce(&mut ProviderSecretsFile),
    ) -> Result<(), SecretError> {
        let mut data = self.read_file()?;
        update(&mut data);
        self.write_file(&data)
    }

    fn quarantine_corrupt_file(&self, error: &serde_json::Error) -> Result<(), SecretError> {
        let quarantined_path = self.path.with_file_name(format!(
            "{}.corrupt-{}-{}",
            SECRET_FILE_NAME,
            unix_timestamp_millis(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::rename(&self.path, &quarantined_path)?;
        warn!(
            path = %self.path.display(),
            quarantined_path = %quarantined_path.display(),
            error = %error,
            "quarantined corrupt provider secret store"
        );
        Ok(())
    }

    fn backup_before_version_change(
        &self,
        from_version: u8,
        source: &[u8],
    ) -> Result<PathBuf, SecretError> {
        let backup = self
            .path
            .with_file_name(format!("{SECRET_FILE_NAME}.v{from_version}.bak"));
        if backup.exists() {
            let existing = std::fs::read(&backup)?;
            if secret_digest(&existing) != secret_digest(source) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "existing secret migration backup does not match the migration source",
                )
                .into());
            }
        } else {
            write_private_file_atomically(&backup, source, || Ok(()))?;
        }
        Ok(backup)
    }

    fn migration_journal_path(&self) -> PathBuf {
        self.path.with_file_name(SECRET_MIGRATION_FILE_NAME)
    }

    fn remove_migration_journal(&self) -> Result<(), SecretError> {
        let journal_path = self.migration_journal_path();
        if journal_path.exists() {
            std::fs::remove_file(&journal_path)?;
            sync_parent_directory(&journal_path)?;
        }
        Ok(())
    }

    fn recover_pending_migration(&self) -> Result<(), SecretError> {
        let journal_path = self.migration_journal_path();
        if !journal_path.exists() {
            return Ok(());
        }
        let journal =
            serde_json::from_slice::<SecretMigrationJournal>(&std::fs::read(&journal_path)?)?;
        let canonical = std::fs::read(&self.path).unwrap_or_default();
        let canonical_digest = secret_digest(&canonical);

        if canonical_digest == journal.target_sha256 {
            set_private_file_permissions(&self.path)?;
            sync_parent_directory(&self.path)?;
            self.remove_migration_journal()?;
            return Ok(());
        }

        let parent = self.path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "secret migration path has no parent directory",
            )
        })?;
        let backup_path = parent.join(&journal.backup_file);
        let backup = std::fs::read(&backup_path)?;
        if secret_digest(&backup) != journal.source_sha256 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "secret migration backup does not match its durable journal",
            )
            .into());
        }
        if canonical_digest != journal.source_sha256 {
            write_private_file_atomically(&self.path, &backup, || Ok(()))?;
        }
        self.remove_migration_journal()?;
        Ok(())
    }

    fn migrate_versioned_file(&self, data: &ProviderSecretsFile) -> Result<(), SecretError> {
        let source = std::fs::read(&self.path)?;
        let target = serialize_provider_secrets(data)?;
        let backup = self.backup_before_version_change(data.version, &source)?;
        let backup_file = backup
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "secret migration backup name is invalid",
                )
            })?
            .to_string();
        let journal = SecretMigrationJournal {
            from_version: data.version,
            source_sha256: secret_digest(&source),
            target_sha256: secret_digest(&target),
            backup_file,
        };
        let journal_bytes = serde_json::to_vec_pretty(&journal)?;
        write_private_file_atomically(&self.migration_journal_path(), &journal_bytes, || Ok(()))?;
        write_private_file_atomically(&self.path, &target, || {
            fail_migration_after_replace(&self.path)
        })?;
        self.remove_migration_journal()?;
        Ok(())
    }
}

fn serialize_provider_secrets(data: &ProviderSecretsFile) -> Result<Vec<u8>, SecretError> {
    let mut persisted = data.clone();
    persisted.version = SECRET_FILE_VERSION;
    persisted.namespaces = SecretNamespaces::from_flat(&persisted.api_keys);
    Ok(serde_json::to_vec_pretty(&persisted)?)
}

fn secret_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_private_file_atomically(
    path: &Path,
    contents: &[u8],
    after_replace: impl FnOnce() -> Result<(), std::io::Error>,
) -> Result<(), std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "secret file path has no parent directory",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(SECRET_FILE_NAME);
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        write_private_file(&temporary, contents)?;
        set_private_file_permissions(&temporary)?;
        replace_file(&temporary, path)?;
        after_replace()?;
        set_private_file_permissions(path)?;
        sync_parent_directory(path)
    })();
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
pub(super) fn install_migration_failure_after_replace(path: PathBuf) {
    *FAIL_MIGRATION_AFTER_REPLACE
        .lock()
        .expect("secret migration failure hook mutex") = Some(path);
}

#[cfg(test)]
fn fail_migration_after_replace(path: &Path) -> Result<(), std::io::Error> {
    let should_fail = {
        let mut hook = FAIL_MIGRATION_AFTER_REPLACE
            .lock()
            .expect("secret migration failure hook mutex");
        hook.as_deref() == Some(path) && hook.take().is_some()
    };
    if should_fail {
        Err(std::io::Error::other(
            "injected secret migration failure after canonical replacement",
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn fail_migration_after_replace(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

impl SecretNamespaces {
    fn from_flat(values: &BTreeMap<String, String>) -> Self {
        let mut namespaces = Self::default();
        for (id, value) in values {
            let target = if id.starts_with("speech-provider:") || id.starts_with("speech:") {
                &mut namespaces.speech
            } else if id.starts_with("mcp-env:") {
                &mut namespaces.mcp
            } else if id.starts_with("web-search:") {
                &mut namespaces.web_search
            } else if id.starts_with("macro-installation:") {
                &mut namespaces.system
            } else {
                &mut namespaces.providers
            };
            target.insert(id.clone(), value.clone());
        }
        namespaces
    }

    fn into_flat(self) -> BTreeMap<String, String> {
        self.providers
            .into_iter()
            .chain(self.speech)
            .chain(self.mcp)
            .chain(self.web_search)
            .chain(self.system)
            .collect()
    }
}

fn parse_provider_secrets_file(contents: &str) -> Result<ProviderSecretsFile, serde_json::Error> {
    let raw = serde_json::from_str::<RawProviderSecretsFile>(contents)?;
    let version = raw._version;
    let mut api_keys = raw.namespaces.into_flat();
    api_keys.extend(raw.api_keys);
    let mut chatgpt_sessions = BTreeMap::new();

    for (provider_id, value) in raw.chatgpt_sessions {
        if let Some(secret) = parse_chatgpt_secret_value(&value) {
            chatgpt_sessions.insert(provider_id, secret);
        } else {
            warn!(
                provider_id = %provider_id,
                "ignored unrecognized ChatGPT secret entry in local provider secret store"
            );
        }
    }

    Ok(ProviderSecretsFile {
        version,
        api_keys,
        namespaces: SecretNamespaces::default(),
        chatgpt_sessions,
    })
}

fn parse_chatgpt_secret_value(value: &serde_json::Value) -> Option<ChatGptSecret> {
    if let Ok(secret) = serde_json::from_value::<ChatGptSecret>(value.clone()) {
        return Some(secret);
    }

    if let Some(serialized) = value.as_str() {
        return parse_chatgpt_secret(serialized).ok().flatten();
    }

    serde_json::to_string(value)
        .ok()
        .and_then(|serialized| parse_chatgpt_secret(&serialized).ok().flatten())
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(unix)]
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    std::fs::rename(source, destination)
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), std::io::Error> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)
}

#[cfg(windows)]
fn set_private_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }

    let result = (|| {
        let mut required = 0u32;
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
        }
        let sizing_error = std::io::Error::last_os_error();
        if sizing_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) || required == 0 {
            return Err(sizing_error);
        }

        let mut buffer = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast::<c_void>(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: token_user.User.Sid.cast(),
        };
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: trustee,
        };
        let mut acl = std::ptr::null_mut();
        let acl_status = unsafe { SetEntriesInAclW(1, &access, std::ptr::null(), &mut acl) };
        if acl_status != 0 {
            return Err(std::io::Error::from_raw_os_error(acl_status as i32));
        }

        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            )
        };
        unsafe {
            LocalFree(acl.cast());
        }
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    })();

    unsafe {
        CloseHandle(token);
    }
    result
}

#[cfg(all(not(unix), not(windows)))]
fn set_private_file_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

pub(super) fn init_store(app_data_dir: &Path) -> Result<(), SecretError> {
    std::fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(SECRET_FILE_NAME);
    *SECRET_STORE_PATH.lock().expect("secret store path lock") = Some(path.clone());
    let store = LocalSecretStore::new(path);
    let _guard = STORE_MUTEX.lock().expect("secret store lock");
    store.recover_pending_migration()?;
    let data = store.read_file()?;
    if data.version < SECRET_FILE_VERSION && store.path.exists() {
        store.migrate_versioned_file(&data)?;
    } else if !store.path.exists() {
        store.write_file(&data)?;
    }
    Ok(())
}

pub(super) fn default_store() -> Result<LocalSecretStore, SecretError> {
    SECRET_STORE_PATH
        .lock()
        .expect("secret store path lock")
        .as_ref()
        .cloned()
        .map(LocalSecretStore::new)
        .ok_or(SecretError::StoreUnavailable)
}

pub(super) fn with_store_lock<T>(
    operation: impl FnOnce(&LocalSecretStore) -> Result<T, SecretError>,
) -> Result<T, SecretError> {
    let store = default_store()?;
    let _guard = STORE_MUTEX.lock().expect("secret store lock");
    operation(&store)
}

pub(super) fn read_provider_secret(provider_id: &str) -> Result<Option<String>, SecretError> {
    with_store_lock(|store| Ok(store.read_file()?.api_keys.get(provider_id).cloned()))
}

pub(super) fn write_provider_secret(provider_id: &str, value: &str) -> Result<(), SecretError> {
    with_store_lock(|store| {
        store.update_file(|data| {
            data.api_keys
                .insert(provider_id.to_string(), value.to_string());
        })
    })
}

pub(super) fn delete_provider_secret_entry(provider_id: &str) -> Result<(), SecretError> {
    with_store_lock(|store| {
        store.update_file(|data| {
            data.api_keys.remove(provider_id);
        })
    })
}

pub(super) fn list_provider_secret_ids() -> Result<Vec<String>, SecretError> {
    with_store_lock(|store| Ok(store.read_file()?.api_keys.keys().cloned().collect()))
}

pub(super) fn list_chatgpt_secret_ids() -> Result<Vec<String>, SecretError> {
    with_store_lock(|store| {
        Ok(store
            .read_file()?
            .chatgpt_sessions
            .keys()
            .cloned()
            .collect())
    })
}

pub(super) fn read_chatgpt_secret(provider_id: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    with_store_lock(|store| {
        Ok(store
            .read_file()?
            .chatgpt_sessions
            .get(provider_id)
            .cloned())
    })
}

pub(super) fn write_chatgpt_secret(
    provider_id: &str,
    secret: &ChatGptSecret,
) -> Result<(), SecretError> {
    with_store_lock(|store| {
        store.update_file(|data| {
            data.chatgpt_sessions
                .insert(provider_id.to_string(), secret.clone());
        })
    })
}

pub(super) fn delete_chatgpt_secret(provider_id: &str) -> Result<(), SecretError> {
    with_store_lock(|store| {
        store.update_file(|data| {
            data.chatgpt_sessions.remove(provider_id);
        })
    })
}

pub(super) fn parse_chatgpt_secret(serialized: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    if let Ok(secret) = serde_json::from_str::<ChatGptSecret>(serialized) {
        return Ok(Some(secret));
    }

    if let Ok(envelope) = serde_json::from_str::<SecretEnvelope<ChatGptSecret>>(serialized) {
        if envelope.version == 2 && envelope.kind == "chatgpt_session" {
            return Ok(Some(envelope.payload));
        }
    }

    if let Ok(envelope) = serde_json::from_str::<SecretEnvelope<LegacyChatGptSecret>>(serialized) {
        if envelope.version == 1 && envelope.kind == "chatgpt" {
            return Ok(Some(ChatGptSecret {
                access_token: envelope.payload.access_token,
                refresh_token: envelope.payload.refresh_token,
                access_token_expires_at: None,
                account_id: envelope.payload.account_id,
                auth_source: envelope.payload.source,
            }));
        }
    }

    Ok(None)
}

#[cfg(test)]
pub(super) fn test_store(path: PathBuf) -> LocalSecretStore {
    LocalSecretStore::new(path)
}
