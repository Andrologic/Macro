//! Pilot-only OS credentials. No provider-store or filesystem fallback.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

const SERVICE: &str = "ai.andrologic.macro.pilot.v1";
static VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PilotSecretKind {
    SessionToken,
    InstanceKey,
    ClaimSecret,
    PollSecret,
}

/// All identifiers are non-secret. Keep the configuration ID across restarts.
/// For instance keys, resource_id is the original creation_id, retained after
/// the server assigns instance_id. For claim/poll, use a client-generated
/// attempt key available before sending the first authentication request.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PilotSecretScope {
    pub configuration_id: String,
    pub relay_origin: String,
    pub kind: PilotSecretKind,
    pub resource_id: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PilotSecretError {
    InvalidScope,
    InvalidSecret,
    VaultUnavailable,
}

fn valid_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn entry_name(scope: &PilotSecretScope) -> Result<String, PilotSecretError> {
    if !valid_id(&scope.configuration_id) || !valid_id(&scope.resource_id) {
        return Err(PilotSecretError::InvalidScope);
    }
    let origin =
        reqwest::Url::parse(&scope.relay_origin).map_err(|_| PilotSecretError::InvalidScope)?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(PilotSecretError::InvalidScope);
    }
    // A structured tuple prevents separator collisions; the hash keeps keychain
    // labels bounded and avoids disclosing relay/instance names in the OS UI.
    let tuple = serde_json::to_vec(&(
        &scope.configuration_id,
        origin.origin().ascii_serialization(),
        scope.kind,
        &scope.resource_id,
    ))
    .map_err(|_| PilotSecretError::InvalidScope)?;
    Ok(format!("v1:{:x}", Sha256::digest(tuple)))
}

fn validate_secret(secret: &str) -> Result<(), PilotSecretError> {
    // 256 bits, canonical base64url without padding. Length alone is insufficient:
    // the unused low bits of the last character must also be zero.
    if secret.len() != 43 {
        return Err(PilotSecretError::InvalidSecret);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(secret)
        .map_err(|_| PilotSecretError::InvalidSecret)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != secret {
        return Err(PilotSecretError::InvalidSecret);
    }
    Ok(())
}

trait Vault {
    fn read(&self, key: &str) -> Result<Option<String>, PilotSecretError>;
    fn write(&self, key: &str, secret: &str) -> Result<(), PilotSecretError>;
    fn delete(&self, key: &str) -> Result<(), PilotSecretError>;
}

struct SystemVault;
impl SystemVault {
    fn entry(key: &str) -> Result<keyring::Entry, PilotSecretError> {
        keyring::Entry::new(SERVICE, key).map_err(|_| PilotSecretError::VaultUnavailable)
    }
}
impl Vault for SystemVault {
    fn read(&self, key: &str) -> Result<Option<String>, PilotSecretError> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => {
                // Platform access errors contain OS diagnostics, never the stored
                // credential. Do not log encoding/data errors, which carry bytes.
                match &error {
                    keyring::Error::NoStorageAccess(cause) | keyring::Error::PlatformFailure(cause) => {
                        tracing::warn!(%cause, "Pilot credential store access failed");
                    }
                    _ => tracing::warn!("Pilot credential store read failed"),
                }
                Err(PilotSecretError::VaultUnavailable)
            },
        }
    }
    fn write(&self, key: &str, secret: &str) -> Result<(), PilotSecretError> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| PilotSecretError::VaultUnavailable)
    }
    fn delete(&self, key: &str) -> Result<(), PilotSecretError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(PilotSecretError::VaultUnavailable),
        }
    }
}

fn read(vault: &impl Vault, scope: &PilotSecretScope) -> Result<Option<String>, PilotSecretError> {
    let value = vault.read(&entry_name(scope)?)?;
    if let Some(secret) = &value {
        validate_secret(secret)?;
    }
    Ok(value)
}
fn write(
    vault: &impl Vault,
    scope: &PilotSecretScope,
    secret: &str,
) -> Result<(), PilotSecretError> {
    let key = entry_name(scope)?;
    validate_secret(secret)?;
    vault.write(&key, secret)
}
fn delete(vault: &impl Vault, scope: &PilotSecretScope) -> Result<(), PilotSecretError> {
    vault.delete(&entry_name(scope)?)
}

// Keyring calls can block for OS unlock prompts. Serialize them off the UI and
// async executor threads; return only static errors, never native error details.
async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, PilotSecretError> + Send + 'static,
) -> Result<T, PilotSecretError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        operation()
    })
    .await
    .map_err(|_| PilotSecretError::VaultUnavailable)?
}

#[tauri::command]
pub async fn pilot_secret_read(
    scope: PilotSecretScope,
) -> Result<Option<String>, PilotSecretError> {
    blocking(move || read(&SystemVault, &scope)).await
}
#[tauri::command]
pub async fn pilot_secret_write(
    scope: PilotSecretScope,
    secret: String,
) -> Result<(), PilotSecretError> {
    blocking(move || write(&SystemVault, &scope, &secret)).await
}
#[tauri::command]
pub async fn pilot_secret_delete(scope: PilotSecretScope) -> Result<(), PilotSecretError> {
    blocking(move || delete(&SystemVault, &scope)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct FakeVault {
        entries: RefCell<HashMap<String, String>>,
        fail: bool,
    }
    impl Vault for FakeVault {
        fn read(&self, key: &str) -> Result<Option<String>, PilotSecretError> {
            if self.fail {
                return Err(PilotSecretError::VaultUnavailable);
            }
            Ok(self.entries.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, secret: &str) -> Result<(), PilotSecretError> {
            if self.fail {
                return Err(PilotSecretError::VaultUnavailable);
            }
            self.entries.borrow_mut().insert(key.into(), secret.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), PilotSecretError> {
            if self.fail {
                return Err(PilotSecretError::VaultUnavailable);
            }
            self.entries.borrow_mut().remove(key);
            Ok(())
        }
    }
    fn scope() -> PilotSecretScope {
        PilotSecretScope {
            configuration_id: "config:test-01".into(),
            relay_origin: "https://relay.example".into(),
            kind: PilotSecretKind::SessionToken,
            resource_id: "session:test-01".into(),
        }
    }
    #[test]
    fn round_trip_replace_delete_and_absence() {
        let vault = FakeVault::default();
        let scope = scope();
        assert_eq!(read(&vault, &scope), Ok(None));
        for byte in [1, 2] {
            let secret = URL_SAFE_NO_PAD.encode([byte; 32]);
            write(&vault, &scope, &secret).unwrap();
            assert_eq!(read(&vault, &scope), Ok(Some(secret)));
        }
        delete(&vault, &scope).unwrap();
        delete(&vault, &scope).unwrap();
        assert_eq!(read(&vault, &scope), Ok(None));
    }
    #[test]
    fn unavailable_is_not_absence_or_success() {
        let vault = FakeVault {
            fail: true,
            ..Default::default()
        };
        let scope = scope();
        assert_eq!(
            read(&vault, &scope),
            Err(PilotSecretError::VaultUnavailable)
        );
        assert_eq!(
            write(&vault, &scope, &URL_SAFE_NO_PAD.encode([1; 32])),
            Err(PilotSecretError::VaultUnavailable)
        );
        assert_eq!(
            delete(&vault, &scope),
            Err(PilotSecretError::VaultUnavailable)
        );
    }
    #[test]
    fn scopes_are_isolated_and_origins_are_canonical() {
        let original = scope();
        let key = entry_name(&original).unwrap();
        let mut equivalent = original.clone();
        equivalent.relay_origin = "https://RELAY.example:443/".into();
        assert_eq!(entry_name(&equivalent).unwrap(), key);
        let mut others = vec![];
        let mut other = original.clone();
        other.configuration_id = "config:test-02".into();
        others.push(other);
        let mut other = original.clone();
        other.relay_origin = "https://other.example".into();
        others.push(other);
        let mut other = original.clone();
        other.resource_id = "session:test-02".into();
        others.push(other);
        for kind in [
            PilotSecretKind::InstanceKey,
            PilotSecretKind::ClaimSecret,
            PilotSecretKind::PollSecret,
        ] {
            let mut other = original.clone();
            other.kind = kind;
            others.push(other);
        }
        let vault = FakeVault::default();
        write(&vault, &original, &URL_SAFE_NO_PAD.encode([1; 32])).unwrap();
        for other in others {
            assert_ne!(entry_name(&other).unwrap(), key);
            delete(&vault, &other).unwrap();
            assert_eq!(read(&vault, &other), Ok(None));
        }
        assert!(read(&vault, &original).unwrap().is_some());
    }
    #[test]
    fn rejects_invalid_tokens_without_mutating_vault() {
        let vault = FakeVault::default();
        let scope = scope();
        for value in [
            "",
            "secret",
            &"A".repeat(42),
            &"A".repeat(44),
            &format!("{}B", "A".repeat(42)),
            &format!("{}=", "A".repeat(42)),
        ] {
            assert_eq!(
                write(&vault, &scope, value),
                Err(PilotSecretError::InvalidSecret)
            );
        }
        assert!(vault.entries.borrow().is_empty());
        vault
            .entries
            .borrow_mut()
            .insert(entry_name(&scope).unwrap(), "corrupted".into());
        assert_eq!(read(&vault, &scope), Err(PilotSecretError::InvalidSecret));
        delete(&vault, &scope).unwrap();
    }
    #[test]
    fn rejects_invalid_scope_and_unknown_secret_kind() {
        for origin in [
            "http://relay.example",
            "https://user:password@relay.example",
            "https://relay.example/path",
            "https://relay.example/?x=1",
            "https://relay.example/#fragment",
        ] {
            let mut scope = scope();
            scope.relay_origin = origin.into();
            assert_eq!(entry_name(&scope), Err(PilotSecretError::InvalidScope));
        }
        let mut invalid = scope();
        invalid.resource_id = "../other".into();
        assert_eq!(entry_name(&invalid), Err(PilotSecretError::InvalidScope));
        assert!(serde_json::from_str::<PilotSecretKind>("\"provider_key\"").is_err());
    }
}
