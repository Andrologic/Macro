use super::{PilotSecretError, PilotSecretKind, Vault};

pub(super) struct SystemVault {
    service: String,
}
pub(super) fn service_for_identifier(identifier: &str) -> String {
    if identifier == "com.macro.desktop" {
        // Preserve production credentials without sharing them with test builds.
        "ai.andrologic.macro.pilot.v1".to_owned()
    } else {
        format!("macro.pilot.v1.app:{identifier}")
    }
}

impl SystemVault {
    pub(super) fn new(service: String) -> Self {
        Self { service }
    }
    #[cfg(not(target_os = "macos"))]
    fn entry(&self, key: &str) -> Result<keyring::Entry, PilotSecretError> {
        keyring::Entry::new(&self.service, key).map_err(|_| PilotSecretError::VaultUnavailable)
    }
}

/// Preserve unknown status numbers in telemetry, without inventing a cause.
/// Authentication failure alone does not establish cancellation or lock state.
pub(super) fn status_error(status: i32) -> PilotSecretError {
    match status {
        -128 => PilotSecretError::Cancelled,
        -25308 | -25315 => PilotSecretError::InterventionRequired,
        _ => PilotSecretError::VaultUnavailable,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) trait Interaction {
    fn get(&self) -> Result<bool, i32>;
    fn set(&self, allowed: bool) -> Result<(), i32>;
}

#[cfg(any(target_os = "macos", test))]
pub(super) struct InteractionGuard<'a, A: Interaction> {
    api: &'a A,
    previous: Option<bool>,
}
#[cfg(any(target_os = "macos", test))]
impl<'a, A: Interaction> InteractionGuard<'a, A> {
    pub(super) fn enter(api: &'a A, interactive: bool) -> Result<Self, i32> {
        let previous = api.get()?;
        let guard = Self {
            api,
            previous: Some(previous),
        };
        api.set(interactive)?;
        Ok(guard)
    }
    pub(super) fn restore(mut self) -> Result<(), i32> {
        // Drop retries on an error; the production API latches the process gate
        // closed if restoring the previous policy cannot be confirmed.
        self.api
            .set(self.previous.expect("guard restoration state"))?;
        self.previous = None;
        Ok(())
    }
}
#[cfg(any(target_os = "macos", test))]
impl<A: Interaction> Drop for InteractionGuard<'_, A> {
    fn drop(&mut self) {
        if let Some(previous) = self.previous {
            let _ = self.api.set(previous);
        }
    }
}

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod macos;

impl Vault for SystemVault {
    fn prepare_resume(&self, kind: PilotSecretKind) -> Result<(), PilotSecretError> {
        #[cfg(target_os = "macos")]
        {
            macos::unlock(kind)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            Ok(())
        }
    }
    fn read(
        &self,
        key: &str,
        kind: PilotSecretKind,
        interactive: bool,
    ) -> Result<Option<String>, PilotSecretError> {
        #[cfg(target_os = "macos")]
        {
            macos::read(&self.service, key, kind, interactive)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (kind, interactive);
            // Historical platform backend. The macOS no-interaction guarantee
            // does not apply to Secret Service unlock prompts on Linux.
            match self.entry(key)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(PilotSecretError::VaultUnavailable),
            }
        }
    }
    fn write(
        &self,
        key: &str,
        kind: PilotSecretKind,
        secret: &str,
    ) -> Result<(), PilotSecretError> {
        #[cfg(target_os = "macos")]
        {
            macos::write(&self.service, key, kind, secret)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            self.entry(key)?
                .set_password(secret)
                .map_err(|_| PilotSecretError::VaultUnavailable)
        }
    }
    fn delete(&self, key: &str, kind: PilotSecretKind) -> Result<(), PilotSecretError> {
        #[cfg(target_os = "macos")]
        {
            macos::delete(&self.service, key, kind)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            match self.entry(key)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(PilotSecretError::VaultUnavailable),
            }
        }
    }
}
