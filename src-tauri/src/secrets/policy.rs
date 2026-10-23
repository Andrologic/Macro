//! Native policy ownership. No secret material or authority is exported over IPC.
use super::store::{self, LocalSecretStore, ProviderSecretsFile};
use super::SecretError;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

pub(crate) static POLICY: LazyLock<Arc<PolicyOwner>> =
    LazyLock::new(|| Arc::new(PolicyOwner::new()));

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct RevocationTicket(u64);
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct PolicyStamp {
    boot: uuid::Uuid,
    revision: u64,
    epoch: uuid::Uuid,
}

pub(crate) struct PolicyOwner {
    gate: Mutex<()>,
    #[cfg(test)]
    injected_store: Option<LocalSecretStore>,
    boot: uuid::Uuid,
    // Low bit means an explicit availability/recovery debt. Even revisions
    // can also be pending while an ordinary mutation owns a ticket.
    state: AtomicU64,
    acknowledged: AtomicU64,
    recovered_through: AtomicU64,
    pending: AtomicUsize,
    persistence_failed: AtomicBool,
    changed: tokio::sync::Notify,
}

struct PolicyGuard<'a> {
    _gate: std::sync::MutexGuard<'a, ()>,
    owner: &'a PolicyOwner,
}
impl Drop for PolicyGuard<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.owner.revoke_now();
            self.owner.persistence_failed.store(true, Ordering::SeqCst);
        }
    }
}

struct Mutation<'a> {
    owner: &'a PolicyOwner,
    revision: u64,
    completed: bool,
}
impl Drop for Mutation<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.owner.revoke_now();
            self.owner.persistence_failed.store(true, Ordering::SeqCst);
        }
        self.owner.pending.fetch_sub(1, Ordering::SeqCst);
        self.owner.changed.notify_waiters();
    }
}

impl PolicyOwner {
    pub(crate) fn new() -> Self {
        Self {
            gate: Mutex::new(()),
            #[cfg(test)]
            injected_store: None,
            boot: uuid::Uuid::new_v4(),
            state: AtomicU64::new(1),
            acknowledged: AtomicU64::new(0),
            recovered_through: AtomicU64::new(0),
            pending: AtomicUsize::new(0),
            persistence_failed: AtomicBool::new(false),
            changed: tokio::sync::Notify::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(directory: &Path) -> Self {
        let mut owner = Self::new();
        owner.injected_store = Some(LocalSecretStore::new(
            directory.join("provider-secrets.json"),
        ));
        owner
    }

    fn store(&self) -> Result<LocalSecretStore, SecretError> {
        #[cfg(test)]
        if let Some(store) = &self.injected_store {
            return Ok(store.clone());
        }
        store::default_store()
    }

    fn install_store(&self, directory: &Path) -> Result<LocalSecretStore, SecretError> {
        #[cfg(test)]
        if let Some(store) = &self.injected_store {
            std::fs::create_dir_all(directory)?;
            return Ok(store.clone());
        }
        store::install_store_path(directory)
    }

    fn clear_caches(&self) {
        #[cfg(test)]
        if self.injected_store.is_some() {
            return;
        }
        super::clear_caches();
    }

    #[cfg(test)]
    pub(crate) fn qualification_stamp(&self) -> Result<PolicyStamp, SecretError> {
        self.capture(|_, stamp| Ok(stamp))
    }

    /// Safe under Pilot operations/state: atomics and notification only.
    pub(crate) fn revoke_now(&self) -> RevocationTicket {
        let previous = self
            .state
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                Some(state.checked_add(2).unwrap_or(u64::MAX) | 1)
            })
            .expect("revocation update always returns a state");
        self.changed.notify_waiters();
        RevocationTicket(previous.checked_add(2).unwrap_or(u64::MAX) | 1)
    }

    pub(crate) fn available(&self) -> bool {
        let state = self.state.load(Ordering::SeqCst);
        state != u64::MAX && state & 1 == 0 && !self.persistence_failed.load(Ordering::SeqCst)
    }

    fn quiescent_revision(&self) -> Result<u64, SecretError> {
        let revision = self.state.load(Ordering::SeqCst);
        if !self.available()
            || self.pending.load(Ordering::SeqCst) != 0
            || revision != self.acknowledged.load(Ordering::SeqCst)
        {
            return Err(SecretError::PolicyUnavailable);
        }
        Ok(revision)
    }

    fn begin_mutation(&self) -> Result<Mutation<'_>, SecretError> {
        self.pending.fetch_add(1, Ordering::SeqCst);
        let next = self
            .state
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                if state & 1 != 0 || self.persistence_failed.load(Ordering::SeqCst) {
                    None
                } else {
                    state.checked_add(2)
                }
            });
        match next {
            Ok(previous) => {
                self.changed.notify_waiters();
                Ok(Mutation {
                    owner: self,
                    revision: previous + 2,
                    completed: false,
                })
            }
            Err(_) => {
                self.pending.fetch_sub(1, Ordering::SeqCst);
                Err(SecretError::PolicyUnavailable)
            }
        }
    }

    fn lock(&self) -> Result<PolicyGuard<'_>, SecretError> {
        self.gate
            .lock()
            .map(|gate| PolicyGuard {
                _gate: gate,
                owner: self,
            })
            .map_err(|_| {
                self.revoke_now();
                SecretError::PolicyUnavailable
            })
    }

    fn recovery_lock(&self) -> PolicyGuard<'_> {
        PolicyGuard {
            _gate: self
                .gate
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            owner: self,
        }
    }

    fn acknowledge_recovery(&self, ticket: RevocationTicket) -> Result<(), SecretError> {
        let ready = ticket.0 & !1;
        if ticket.0 == u64::MAX {
            return Err(SecretError::PolicyUnavailable);
        }
        self.state
            .compare_exchange(ticket.0, ready, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| SecretError::PolicyUnavailable)?;
        self.acknowledged.store(ready, Ordering::SeqCst);
        self.recovered_through.store(ready, Ordering::SeqCst);
        self.persistence_failed.store(false, Ordering::SeqCst);
        self.gate.clear_poison();
        Ok(())
    }

    pub(crate) fn initialize(&self, directory: &Path) -> Result<(), SecretError> {
        let ticket = self.revoke_now();
        let _gate = self.recovery_lock();
        let result = (|| {
            let store = self.install_store(directory)?;
            store::with_specific_store_recovery_lock(&store, |store| {
                store.prepare_policy_file()?;
                self.clear_caches();
                Ok(())
            })
        })();
        if let Err(error) = result {
            self.persistence_failed.store(true, Ordering::SeqCst);
            return Err(error);
        }
        self.acknowledge_recovery(ticket)
    }

    /// The blocking owner keeps all guards outside the async restore future.
    pub(crate) fn startup<T>(
        &self,
        directory: &Path,
        operation: impl FnOnce(&dyn Fn() -> Result<(), SecretError>) -> Result<T, String>,
    ) -> Result<T, String> {
        let ticket = self.revoke_now();
        let _gate = self.recovery_lock();
        let mut operation_error = None;
        let result = (|| {
            let store = self.install_store(directory)?;
            store::with_specific_store_recovery_lock(&store, |store| {
                let rotate_before_journal_removal =
                    || store.prepare_restored_policy_file().map(|_| ());
                let value = operation(&rotate_before_journal_removal).map_err(|error| {
                    operation_error = Some(error);
                    SecretError::PolicyUnavailable
                })?;
                store.prepare_policy_file()?;
                self.clear_caches();
                Ok(value)
            })
        })();
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                self.persistence_failed.store(true, Ordering::SeqCst);
                return Err(operation_error.unwrap_or_else(|| error.to_string()));
            }
        };
        self.acknowledge_recovery(ticket)
            .map_err(|error| error.to_string())?;
        Ok(value)
    }

    /// The caller must have dropped all Pilot guards before entering here.
    pub(crate) fn settle(&self, ticket: RevocationTicket) -> Result<(), SecretError> {
        self.settle_inner(ticket, false)
    }

    pub(crate) fn retry_invalidation(&self) -> Result<(), SecretError> {
        self.settle_inner(RevocationTicket(self.state.load(Ordering::SeqCst)), true)
    }

    fn settle_inner(&self, ticket: RevocationTicket, explicit: bool) -> Result<(), SecretError> {
        let _gate = if explicit {
            self.recovery_lock()
        } else {
            self.lock()?
        };
        if !explicit && self.persistence_failed.load(Ordering::SeqCst) {
            return Err(SecretError::PolicyUnavailable);
        }
        if ticket.0 & 1 == 0 {
            return Err(SecretError::PolicyUnavailable);
        }
        let result = (|| {
            let store = self.store()?;
            let rotate = |store: &LocalSecretStore| {
                store.rotate_policy_file()?;
                self.clear_caches();
                Ok(())
            };
            if explicit {
                store::with_specific_store_recovery_lock(&store, rotate)
            } else {
                store::with_specific_store_lock(&store, rotate)
            }
        })();
        if let Err(error) = result {
            self.persistence_failed.store(true, Ordering::SeqCst);
            return Err(error);
        }
        self.acknowledge_recovery(ticket)
    }

    pub(super) fn mutation<T>(
        &self,
        effect: impl FnOnce(&LocalSecretStore, ProviderSecretsFile) -> Result<T, SecretError>,
    ) -> Result<T, SecretError> {
        let mut mutation = self.begin_mutation()?;
        let _gate = self.lock()?;
        let result = (|| {
            if !self.available()
                || mutation.revision <= self.recovered_through.load(Ordering::SeqCst)
            {
                // This queued operation never reached an effect. Preserve the
                // existing revocation instead of creating a new failed debt.
                mutation.completed = true;
                return Err(SecretError::PolicyUnavailable);
            }
            let store = self.store()?;
            store::with_specific_store_lock(&store, |store| {
                let data = store.rotate_policy_file()?;
                if !self.available() {
                    return Err(SecretError::PolicyUnavailable);
                }
                effect(store, data)
            })
        })();
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                // Install the refusal before releasing the gate to a queued writer.
                drop(mutation);
                return Err(error);
            }
        };
        self.acknowledged
            .fetch_max(mutation.revision, Ordering::SeqCst);
        mutation.completed = true;
        Ok(value)
    }

    pub(crate) fn change<T>(&self, effect: impl FnOnce() -> T) -> Result<T, SecretError> {
        self.mutation(|_, _| Ok(effect()))
    }

    pub(crate) fn inspect<T>(&self, read: impl FnOnce() -> T) -> Result<T, SecretError> {
        let _gate = self.lock()?;
        if !self.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        Ok(read())
    }

    pub(super) fn cached<T: Clone>(
        &self,
        cached: impl FnOnce() -> Option<T>,
        read: impl FnOnce(&ProviderSecretsFile) -> T,
        publish: impl FnOnce(&T),
    ) -> Result<T, SecretError> {
        // The cache lock is taken only inside the common gate.
        {
            let _gate = self.lock()?;
            if !self.available() {
                return Err(SecretError::PolicyUnavailable);
            }
            if let Some(value) = cached() {
                return Ok(value);
            }
        }
        self.mutation(|_, data| {
            let value = read(&data);
            if !self.available() {
                return Err(SecretError::PolicyUnavailable);
            }
            publish(&value);
            Ok(value)
        })
    }

    pub(super) fn read<T>(
        &self,
        read: impl FnOnce(&ProviderSecretsFile) -> Result<T, SecretError>,
    ) -> Result<T, SecretError> {
        let _gate = self.lock()?;
        if !self.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        let store = self.store()?;
        store::with_specific_store_lock(&store, |store| read(&store.read_policy_file()?))
    }

    pub(super) fn capture<T>(
        &self,
        capture: impl FnOnce(&ProviderSecretsFile, PolicyStamp) -> Result<T, SecretError>,
    ) -> Result<T, SecretError> {
        let _gate = self.lock()?;
        let revision = self.quiescent_revision()?;
        let store = self.store()?;
        store::with_specific_store_lock(&store, |store| {
            let data = store.read_policy_file()?;
            let stamp = PolicyStamp {
                boot: self.boot,
                revision,
                epoch: data.policy_epoch.ok_or(SecretError::PolicyUnavailable)?,
            };
            let value = capture(&data, stamp)?;
            if self.quiescent_revision()? != revision {
                return Err(SecretError::PolicyUnavailable);
            }
            Ok(value)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn capture_reads_disk_while_ordinary_cache_retains_its_value() {
        let _serial = super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        super::super::init(directory.path()).unwrap();
        super::super::set_api_key("synthetic", "cached").unwrap();
        let before = POLICY.capture(|_, stamp| Ok(stamp)).unwrap();
        let store = store::default_store().unwrap();
        store::with_specific_store_lock(&store, |store| {
            let mut data = store.rotate_policy_file()?;
            data.api_keys.insert("synthetic".into(), "fresh".into());
            store.write_file(&data)
        })
        .unwrap();
        assert_eq!(
            super::super::get_api_key("synthetic").unwrap().as_deref(),
            Some("cached")
        );
        let (value, after) = POLICY
            .capture(|data, stamp| Ok((data.api_keys.get("synthetic").cloned(), stamp)))
            .unwrap();
        assert_eq!(value.as_deref(), Some("fresh"));
        assert!(before != after);
    }

    #[test]
    fn revocation_during_capture_is_immediate_and_joined_after_capture_unlocks() {
        let _serial = super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        super::super::init(directory.path()).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let capture = std::thread::spawn(move || {
            POLICY.capture(|_, _| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let ticket = POLICY.revoke_now();
        assert!(!POLICY.available());
        let (settled_tx, settled_rx) = mpsc::channel();
        let settle = std::thread::spawn(move || {
            let result = POLICY.settle(ticket);
            settled_tx.send(result.is_ok()).unwrap();
        });
        assert!(settled_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        assert!(capture.join().unwrap().is_err());
        assert!(settled_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        settle.join().unwrap();
        assert!(POLICY.capture(|_, _| Ok(())).is_ok());
    }

    #[test]
    fn failed_nonce_persistence_requires_explicit_retry_and_stale_ticket_cannot_reactivate() {
        let _serial = super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        super::super::init(directory.path()).unwrap();
        let path = directory.path().join("provider-secrets.json");
        let bytes = std::fs::read(&path).unwrap();
        let ticket = POLICY.revoke_now();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(POLICY.settle(ticket).is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, bytes).unwrap();
        assert!(POLICY.settle(ticket).is_err());
        assert!(POLICY.capture(|_, _| Ok(())).is_err());
        assert!(super::super::set_api_key("synthetic", "refused").is_err());
        POLICY.retry_invalidation().unwrap();
        let older = POLICY.revoke_now();
        let newer = POLICY.revoke_now();
        assert!(POLICY.settle(older).is_err());
        assert!(!POLICY.available());
        POLICY.settle(newer).unwrap();
        assert!(POLICY.capture(|_, _| Ok(())).is_ok());
    }
    #[test]
    fn explicit_recovery_after_panic_preserves_values_and_rotates_before_reopening() {
        let _serial = super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        super::super::init(directory.path()).unwrap();
        let panic = std::panic::catch_unwind(|| {
            let _ = POLICY.mutation::<()>(|store, mut data| {
                data.api_keys
                    .insert("synthetic".into(), "written-before-panic".into());
                store.write_file(&data)?;
                panic!("synthetic mutation panic");
            });
        });
        assert!(panic.is_err());
        assert!(!POLICY.available());
        assert!(super::super::get_api_key("synthetic").is_err());
        let path = directory.path().join("provider-secrets.json");
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(POLICY.retry_invalidation().is_err());
        assert!(POLICY.gate.is_poisoned());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        POLICY.retry_invalidation().unwrap();
        assert!(!POLICY.gate.is_poisoned());
        assert_ne!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            super::super::get_api_key("synthetic").unwrap().as_deref(),
            Some("written-before-panic")
        );
        assert!(std::panic::catch_unwind(|| POLICY.capture::<()>(|_, _| {
            panic!("synthetic capture panic");
        }))
        .is_err());
        assert!(!POLICY.available());
        super::super::init(directory.path()).unwrap();
        assert!(POLICY.capture(|_, _| Ok(())).is_ok());
    }
}
