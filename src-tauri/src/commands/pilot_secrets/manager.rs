use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex, MutexGuard, TryLockError,
    },
};

const MAX_CACHED_SCOPES: usize = 8;

#[derive(Default)]
struct Cache(VecDeque<(String, Option<String>)>);
impl Cache {
    fn get(&self, key: &str) -> Option<&Option<String>> {
        self.0
            .iter()
            .find(|(cached, _)| cached == key)
            .map(|(_, value)| value)
    }
    fn clear(&mut self) {
        self.0.clear();
    }
    fn remove(&mut self, key: &str) {
        self.0.retain(|(cached, _)| cached != key);
    }
    fn insert(&mut self, key: String, value: Option<String>) {
        self.remove(&key);
        if self.0.len() == MAX_CACHED_SCOPES {
            self.0.pop_front();
        }
        self.0.push_back((key, value));
    }
}

// Constructed only by a native connection owner, never accepted as an IPC DTO.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct TransportIdentity {
    pub(super) context: PilotVaultContext,
    pub(super) generation: String,
    pub(super) instance_creation_id: String,
}
#[derive(PartialEq, Eq)]
pub(super) struct TransportPair {
    identity: TransportIdentity,
    pub(super) session_token: String,
    pub(super) instance_key: String,
}

struct State {
    context: Option<PilotVaultContext>,
    resume_parent_generation: Option<String>,
    status: VaultStatus,
    cache: Cache,
    recovery_scopes: Vec<PilotSecretScope>,
    automatic_recovery: bool,
    recovery_inflight: bool,
}

/// `operations` covers the entire backend call. `state` is never held across
/// native I/O, so logout and lifecycle callbacks invalidate in-flight work now.
pub(super) struct Manager<B> {
    backend: B,
    operations: Mutex<()>,
    state: Mutex<State>,
    generation: AtomicU64,
    policy: Arc<crate::secrets::policy::PolicyOwner>,
    active_operations: AtomicUsize,
    invalidations: Mutex<Vec<crate::secrets::blocking::Completion>>,
    #[cfg(test)]
    _store_directory: tempfile::TempDir,
}

impl<B> Drop for Manager<B> {
    fn drop(&mut self) {
        if let Ok(pending) = self.invalidations.lock() {
            for job in pending.iter() {
                let _ = job.wait();
            }
        }
    }
}

impl<B: Vault> Manager<B> {
    pub(super) fn new(backend: B) -> Self {
        #[cfg(not(test))]
        let policy = crate::secrets::policy::POLICY.clone();
        #[cfg(test)]
        let directory = tempfile::tempdir().expect("synthetic secret store");
        #[cfg(test)]
        let policy = {
            let owner = crate::secrets::policy::PolicyOwner::for_test(directory.path());
            owner
                .initialize(directory.path())
                .expect("initialize synthetic policy");
            Arc::new(owner)
        };
        Self {
            policy,
            active_operations: AtomicUsize::new(0),
            invalidations: Mutex::new(Vec::new()),
            #[cfg(test)]
            _store_directory: directory,
            backend,
            operations: Mutex::new(()),
            generation: AtomicU64::new(1),
            state: Mutex::new(State {
                context: None,
                resume_parent_generation: None,
                status: VaultStatus::Ready,
                cache: Cache::default(),
                recovery_scopes: Vec::new(),
                automatic_recovery: false,
                recovery_inflight: false,
            }),
        }
    }

    fn policy_error(&self, generation: &str) -> PilotSecretError {
        if let Err(error) = self.current(generation) {
            return error;
        }
        self.state()
            .ok()
            .and_then(|state| Self::ready(&state).err())
            .unwrap_or(PilotSecretError::VaultUnavailable)
    }

    fn join_invalidations(&self) -> Result<(), PilotSecretError> {
        let pending = self
            .invalidations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?
            .clone();
        // No gate, operations or state guard is held while joining.
        let complete = pending.iter().fold(true, |ok, job| job.wait() && ok);
        self.invalidations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?
            .retain(|job| !job.completed());
        if complete {
            Ok(())
        } else {
            Err(PilotSecretError::VaultUnavailable)
        }
    }

    fn operation<T>(
        &self,
        generation: &str,
        exclusive: bool,
        explicit: bool,
        body: impl FnOnce(
            &mut Option<crate::secrets::policy::RevocationTicket>,
        ) -> Result<T, PilotSecretError>,
    ) -> Result<T, PilotSecretError> {
        struct Active<'a>(&'a AtomicUsize);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        if exclusive {
            self.active_operations
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| {
                    self.current(generation)
                        .err()
                        .unwrap_or(PilotSecretError::Suspended)
                })?;
        } else {
            self.active_operations.fetch_add(1, Ordering::SeqCst);
        }
        let _active = Active(&self.active_operations);
        let joined = self.join_invalidations();
        if explicit {
            if !self.policy.available() {
                self.policy
                    .retry_invalidation()
                    .map_err(|_| self.policy_error(generation))?;
            }
        } else {
            joined?;
        }
        let mut debt = None;
        let result = self
            .policy
            .change(|| body(&mut debt))
            .map_err(|_| self.policy_error(generation))
            .and_then(|value| value);
        // change and the inner body have released gate/store/operations/state.
        if let Some(ticket) = debt {
            if self.policy.settle(ticket).is_err() && result.is_ok() {
                return Err(PilotSecretError::VaultUnavailable);
            }
        }
        result
    }

    pub(super) fn read(
        &self,
        scope: &PilotSecretScope,
        generation: &str,
    ) -> Result<Option<String>, PilotSecretError> {
        let key = entry_name(scope)?;
        let cached = self
            .policy
            .inspect(|| {
                let state = self.state()?;
                self.current(generation)?;
                Self::active(&state, scope)?;
                Self::ready(&state)?;
                Ok::<_, PilotSecretError>(state.cache.get(&key).cloned())
            })
            .map_err(|_| self.policy_error(generation))??;
        if let Some(value) = cached {
            return Ok(value);
        }
        self.operation(generation, false, false, |debt| {
            self.read_inner(debt, scope, generation)
        })
    }
    pub(super) fn write(
        &self,
        scope: &PilotSecretScope,
        generation: &str,
        secret: &str,
    ) -> Result<(), PilotSecretError> {
        entry_name(scope)?;
        validate_secret(secret)?;
        self.operation(generation, false, false, |debt| {
            self.write_inner(debt, scope, generation, secret)
        })
    }
    pub(super) fn delete(
        &self,
        scope: &PilotSecretScope,
        generation: &str,
    ) -> Result<(), PilotSecretError> {
        entry_name(scope)?;
        self.operation(generation, false, false, |debt| {
            self.delete_inner(debt, scope, generation)
        })
    }
    pub(super) fn resume(
        &self,
        scopes: &[PilotSecretScope],
        generation: &str,
    ) -> Result<VaultLease, PilotSecretError> {
        if scopes.is_empty() || scopes.len() > 8 {
            return Err(PilotSecretError::InvalidScope);
        }
        for scope in scopes {
            entry_name(scope)?;
        }
        self.operation(generation, true, true, |debt| {
            self.resume_inner(debt, scopes, generation)
        })
    }
    pub(super) fn recover_silently(
        &self,
        scopes: &[PilotSecretScope],
        generation: &str,
    ) -> Result<VaultLease, PilotSecretError> {
        self.operation(generation, true, false, |debt| {
            self.recover_silently_inner(debt, scopes, generation)
        })
    }

    fn read_transport_pair_locked(
        &self,
        identity: &TransportIdentity,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
    ) -> Result<TransportPair, PilotSecretError> {
        if !self.backend.silent_capture_supported() {
            return Err(PilotSecretError::VaultUnavailable);
        }
        let scope = |kind, resource_id: String| PilotSecretScope {
            configuration_id: identity.context.configuration_id.clone(),
            relay_origin: identity.context.relay_origin.clone(),
            kind,
            resource_id,
        };
        let session = scope(
            PilotSecretKind::SessionToken,
            identity.context.owner_id.clone(),
        );
        let instance = scope(
            PilotSecretKind::InstanceKey,
            identity.instance_creation_id.clone(),
        );
        let keys = [entry_name(&session)?, entry_name(&instance)?];
        let _operation = self
            .operations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        {
            let state = self.state()?;
            self.current(&identity.generation)?;
            if state.context.as_ref() != Some(&identity.context) {
                return Err(PilotSecretError::ContextChanged);
            }
            Self::ready(&state)?;
        }
        let mut read = |scope: &PilotSecretScope, key: &str| {
            let result = self.backend.read(key, scope.kind, false).and_then(|value| {
                let value = value.ok_or(PilotSecretError::InvalidSecret)?;
                validate_secret(&value)?;
                Ok(value)
            });
            self.finish(debt, &identity.generation, result, |_, _| {})
        };
        let session_token = read(&session, &keys[0])?;
        let instance_key = read(&instance, &keys[1])?;
        Ok(TransportPair {
            identity: identity.clone(),
            session_token,
            instance_key,
        })
    }

    pub(super) fn capture_policy(
        &self,
        identity: &TransportIdentity,
    ) -> Result<crate::secrets::policy::PolicySnapshot<TransportPair>, PilotSecretError> {
        let mut debt = None;
        let mut native_error = None;
        let result = self.policy.capture_private(|| {
            self.read_transport_pair_locked(identity, &mut debt)
                .map_err(|error| {
                    native_error = Some(error);
                    crate::secrets::SecretError::PolicyUnavailable
                })
        });
        if let Some(ticket) = debt {
            let _ = self.policy.settle(ticket);
        }
        result.map_err(|_| native_error.unwrap_or_else(|| self.policy_error(&identity.generation)))
    }

    pub(super) fn consume_policy<T>(
        &self,
        snapshot: &crate::secrets::policy::PolicySnapshot<TransportPair>,
        identity: &TransportIdentity,
        effect: impl FnOnce(
            &crate::secrets::policy::EmissionLease<'_>,
            &TransportPair,
        ) -> Result<T, crate::secrets::SecretError>,
    ) -> Result<T, PilotSecretError> {
        let mut debt = None;
        let mut native_error = None;
        let result = self.policy.consume_private(
            snapshot,
            || {
                self.read_transport_pair_locked(identity, &mut debt)
                    .map_err(|error| {
                        native_error = Some(error);
                        crate::secrets::SecretError::PolicyUnavailable
                    })
            },
            effect,
        );
        if let Some(ticket) = debt {
            let _ = self.policy.settle(ticket);
        }
        result.map_err(|_| native_error.unwrap_or_else(|| self.policy_error(&identity.generation)))
    }

    #[cfg(test)]
    pub(super) fn using_policy(mut self, policy: Arc<crate::secrets::policy::PolicyOwner>) -> Self {
        self.policy = policy;
        self
    }

    #[cfg(test)]
    pub(super) fn policy_fixture(
        &self,
    ) -> (&crate::secrets::policy::PolicyOwner, &std::path::Path) {
        (&self.policy, self._store_directory.path())
    }

    #[cfg(test)]
    pub(super) fn revoked_since(&self, generation: &str) -> bool {
        self.current(generation).is_err() && !self.policy.available()
    }

    fn state(&self) -> Result<MutexGuard<'_, State>, PilotSecretError> {
        self.state
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)
    }

    fn lease(&self, state: &State) -> VaultLease {
        VaultLease {
            generation: self.generation.load(Ordering::Acquire).to_string(),
            status: if state.status == VaultStatus::Ready && !self.policy.available() {
                VaultStatus::VaultUnavailable
            } else {
                state.status
            },
        }
    }

    fn advance(&self, state: &mut State) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        state.cache.clear();
        state.resume_parent_generation = None;
    }

    fn current(&self, generation: &str) -> Result<(), PilotSecretError> {
        if generation != self.generation.load(Ordering::Acquire).to_string() {
            return Err(PilotSecretError::ContextChanged);
        }
        Ok(())
    }

    fn active(state: &State, scope: &PilotSecretScope) -> Result<(), PilotSecretError> {
        let context = state
            .context
            .as_ref()
            .ok_or(PilotSecretError::ContextChanged)?;
        let origin =
            reqwest::Url::parse(&scope.relay_origin).map_err(|_| PilotSecretError::InvalidScope)?;
        if scope.configuration_id != context.configuration_id
            || origin.origin().ascii_serialization() != context.relay_origin
        {
            return Err(PilotSecretError::InvalidScope);
        }
        Ok(())
    }

    fn ready(state: &State) -> Result<(), PilotSecretError> {
        match state.status {
            VaultStatus::Ready => Ok(()),
            VaultStatus::InterventionRequired => Err(PilotSecretError::InterventionRequired),
            VaultStatus::Cancelled => Err(PilotSecretError::Cancelled),
            VaultStatus::Suspended => Err(PilotSecretError::Suspended),
            VaultStatus::VaultUnavailable => Err(PilotSecretError::VaultUnavailable),
        }
    }

    pub(super) fn activate(
        &self,
        mut context: PilotVaultContext,
        generation: Option<&str>,
    ) -> Result<VaultLease, PilotSecretError> {
        let scope = PilotSecretScope {
            configuration_id: context.configuration_id.clone(),
            relay_origin: context.relay_origin.clone(),
            kind: PilotSecretKind::SessionToken,
            resource_id: context.owner_id.clone(),
        };
        entry_name(&scope)?;
        context.relay_origin = reqwest::Url::parse(&context.relay_origin)
            .map_err(|_| PilotSecretError::InvalidScope)?
            .origin()
            .ascii_serialization();
        let (ticket, next) = {
            let mut state = self.state()?;
            if state.context.as_ref() == Some(&context) {
                return Ok(self.lease(&state));
            }
            if state.context.is_some() {
                self.current(generation.ok_or(PilotSecretError::ContextChanged)?)?;
            }
            // Generation revocation is immediate; the replacement context is
            // published only after durable invalidation under the common gate.
            let ticket = self.policy.revoke_now();
            self.advance(&mut state);
            (ticket, self.lease(&state).generation)
        };
        self.policy
            .settle(ticket)
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        self.policy
            .change(|| {
                let mut state = self.state()?;
                self.current(&next)?;
                if !self.policy.available() {
                    return Err(PilotSecretError::VaultUnavailable);
                }
                state.context = Some(context);
                state.recovery_scopes.clear();
                state.automatic_recovery = false;
                state.recovery_inflight = false;
                Ok(self.lease(&state))
            })
            .map_err(|_| PilotSecretError::VaultUnavailable)?
    }

    pub(super) fn invalidate(
        &self,
        generation: Option<&str>,
    ) -> Result<VaultLease, PilotSecretError> {
        let (ticket, lease) = {
            let mut state = self.state()?;
            if !generation.is_some_and(|value| {
                self.current(value).is_ok()
                    || state.resume_parent_generation.as_deref() == Some(value)
            }) {
                return Ok(self.lease(&state));
            }
            let ticket = self.policy.revoke_now();
            self.advance(&mut state);
            state.context = None;
            state.recovery_scopes.clear();
            state.automatic_recovery = false;
            state.recovery_inflight = false;
            (ticket, self.lease(&state))
        };
        self.policy
            .settle(ticket)
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        // Return the current status after settlement, never a pre-settlement Ready.
        let state = self.state()?;
        self.current(&lease.generation)?;
        Ok(self.lease(&state))
    }

    #[cfg(test)]
    pub(super) fn suspend(&self) {
        self.suspend_for("application_shutdown", false);
    }

    pub(super) fn suspend_for(&self, reason: &'static str, recoverable: bool) {
        let ticket = self.policy.revoke_now();
        if let Ok(mut state) = self.state() {
            state.automatic_recovery = recoverable
                && (state.status == VaultStatus::Ready
                    || state.automatic_recovery
                    || state.recovery_inflight);
            state.recovery_inflight = false;
            self.advance(&mut state);
            if state.status == VaultStatus::Ready {
                state.status = VaultStatus::Suspended;
            }
            tracing::info!(reason, status = ?state.status, automatic_recovery = state.automatic_recovery,
                "Macro Connect credentials suspended");
            emit(&self.lease(&state));
        }
        // The callback never waits for a gate or an emission. Its registered
        // blocking owner is joined by recovery and by application shutdown.
        let policy = self.policy.clone();
        if let Ok(mut pending) = self.invalidations.lock() {
            match crate::secrets::blocking::submit_joined(move || policy.settle(ticket)) {
                Ok(job) => pending.push(job),
                Err(_) => tracing::warn!("Credential invalidation owner is closed"),
            }
        }
    }

    fn remember(state: &mut State, scope: &PilotSecretScope) {
        let key = entry_name(scope).expect("validated scope");
        state
            .recovery_scopes
            .retain(|known| entry_name(known).ok().as_ref() != Some(&key));
        if state.recovery_scopes.len() == MAX_CACHED_SCOPES {
            state.recovery_scopes.remove(0);
        }
        state.recovery_scopes.push(scope.clone());
    }

    /// Reserve one batch per suspension. No keychain call runs on the main thread.
    pub(super) fn take_recovery(&self) -> Option<(Vec<PilotSecretScope>, String)> {
        let mut state = self.state().ok()?;
        if !state.automatic_recovery
            || state.status != VaultStatus::Suspended
            || state.context.is_none()
            || state.recovery_scopes.is_empty()
        {
            return None;
        }
        state.automatic_recovery = false;
        state.recovery_inflight = true;
        Some((state.recovery_scopes.clone(), self.lease(&state).generation))
    }

    fn recover_silently_inner(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        scopes: &[PilotSecretScope],
        generation: &str,
    ) -> Result<VaultLease, PilotSecretError> {
        // A busy vault does not create an automatic queue or prompt loop.
        let _operation = self
            .operations
            .try_lock()
            .map_err(|_| PilotSecretError::Suspended)?;
        let mut cache = Vec::new();
        for scope in scopes {
            {
                let state = self.state()?;
                self.current(generation)?;
                Self::active(&state, scope)?;
                if state.status != VaultStatus::Suspended {
                    return Err(PilotSecretError::ContextChanged);
                }
            }
            let key = entry_name(scope)?;
            let result = self
                .backend
                .read(&key, scope.kind, false)
                .and_then(|value| {
                    if let Some(secret) = &value {
                        validate_secret(secret)?;
                    }
                    Ok(value)
                });
            let value = self.finish(debt, generation, result, |_, _| {})?;
            cache.push((key, value));
        }
        let mut state = self.state()?;
        self.current(generation)?;
        if !self.policy.available() {
            return Err(PilotSecretError::VaultUnavailable);
        }
        for (key, value) in cache {
            state.cache.insert(key, value);
        }
        state.recovery_inflight = false;
        if !self.policy.available() {
            return Err(PilotSecretError::VaultUnavailable);
        }
        state.status = VaultStatus::Ready;
        let lease = self.lease(&state);
        emit(&lease);
        Ok(lease)
    }

    fn finish<T>(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        generation: &str,
        result: Result<T, PilotSecretError>,
        cache: impl FnOnce(&mut State, &T),
    ) -> Result<T, PilotSecretError> {
        if matches!(
            &result,
            Err(PilotSecretError::InterventionRequired
                | PilotSecretError::Cancelled
                | PilotSecretError::VaultUnavailable
                | PilotSecretError::InvalidSecret)
        ) {
            *debt = Some(self.policy.revoke_now());
        }
        let mut state = self.state()?;
        self.current(generation)?;
        match result {
            Ok(value) => {
                if !self.policy.available() {
                    return Err(PilotSecretError::VaultUnavailable);
                }
                cache(&mut state, &value);
                Ok(value)
            }
            Err(error) => {
                let status = match error {
                    PilotSecretError::InterventionRequired => {
                        Some(VaultStatus::InterventionRequired)
                    }
                    PilotSecretError::Cancelled => Some(VaultStatus::Cancelled),
                    PilotSecretError::VaultUnavailable | PilotSecretError::InvalidSecret => {
                        Some(VaultStatus::VaultUnavailable)
                    }
                    _ => None,
                };
                if let Some(status) = status {
                    state.status = status;
                    state.automatic_recovery = false;
                    state.recovery_inflight = false;
                    state.cache.clear();
                    emit(&self.lease(&state));
                }
                Err(error)
            }
        }
    }

    fn read_inner(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        scope: &PilotSecretScope,
        generation: &str,
    ) -> Result<Option<String>, PilotSecretError> {
        let key = entry_name(scope)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        {
            let state = self.state()?;
            self.current(generation)?;
            Self::active(&state, scope)?;
            Self::ready(&state)?;
            if let Some(value) = state.cache.get(&key) {
                return Ok(value.clone());
            }
        }
        let result = self
            .backend
            .read(&key, scope.kind, false)
            .and_then(|value| {
                if let Some(secret) = &value {
                    validate_secret(secret)?;
                }
                Ok(value)
            });
        self.finish(debt, generation, result, |state, value| {
            state.cache.insert(key, value.clone());
            Self::remember(state, scope);
        })
    }

    fn write_inner(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        scope: &PilotSecretScope,
        generation: &str,
        secret: &str,
    ) -> Result<(), PilotSecretError> {
        let key = entry_name(scope)?;
        validate_secret(secret)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        {
            let state = self.state()?;
            self.current(generation)?;
            Self::active(&state, scope)?;
            Self::ready(&state)?;
        }
        let result = self.backend.write(&key, scope.kind, secret);
        self.finish(debt, generation, result, |state, _| {
            state.cache.insert(key, Some(secret.to_owned()));
            Self::remember(state, scope);
        })
    }

    fn delete_inner(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        scope: &PilotSecretScope,
        generation: &str,
    ) -> Result<(), PilotSecretError> {
        let key = entry_name(scope)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)?;
        {
            let mut state = self.state()?;
            self.current(generation)?;
            Self::ready(&state)?;
            // Forget even if native deletion fails. Never populate from cleanup.
            state.cache.remove(&key);
            state
                .recovery_scopes
                .retain(|known| entry_name(known).ok().as_ref() != Some(&key));
        }
        self.finish(
            debt,
            generation,
            self.backend.delete(&key, scope.kind),
            |_, _| {},
        )
    }

    fn failed_resume(
        &self,
        generation: &str,
        error: PilotSecretError,
    ) -> Result<VaultLease, PilotSecretError> {
        if error == PilotSecretError::ContextChanged {
            return Err(error);
        }
        let mut state = self.state()?;
        self.current(generation)?;
        state.resume_parent_generation = None;
        Ok(self.lease(&state))
    }

    fn resume_inner(
        &self,
        debt: &mut Option<crate::secrets::policy::RevocationTicket>,
        scopes: &[PilotSecretScope],
        generation: &str,
    ) -> Result<VaultLease, PilotSecretError> {
        if scopes.is_empty() || scopes.len() > 8 {
            return Err(PilotSecretError::InvalidScope);
        }
        let keys: Vec<String> = scopes.iter().map(entry_name).collect::<Result<_, _>>()?;
        // Explicit recovery must never wait in an interactive queue, even when
        // a second caller has already obtained the in-flight generation.
        let _operation = match self.operations.try_lock() {
            Ok(operation) => operation,
            Err(TryLockError::WouldBlock) => {
                self.current(generation)?;
                return Err(PilotSecretError::Suspended);
            }
            Err(TryLockError::Poisoned(_)) => return Err(PilotSecretError::VaultUnavailable),
        };
        let lease = {
            let mut state = self.state()?;
            self.current(generation)?;
            for scope in scopes {
                Self::active(&state, scope)?;
            }
            self.advance(&mut state);
            state.automatic_recovery = false;
            state.recovery_inflight = false;
            state.resume_parent_generation = Some(generation.to_owned());
            state.status = VaultStatus::Suspended;
            self.lease(&state)
        };
        self.current(&lease.generation)?;
        if let Err(error) = self.finish(
            debt,
            &lease.generation,
            self.backend.prepare_resume(scopes[0].kind),
            |_, _| {},
        ) {
            return self.failed_resume(&lease.generation, error);
        }
        let mut cache = HashMap::new();
        for (scope, key) in scopes.iter().zip(keys) {
            self.current(&lease.generation)?;
            if cache.contains_key(&key) {
                continue;
            }
            let result = self.backend.read(&key, scope.kind, true).and_then(|value| {
                if let Some(secret) = &value {
                    validate_secret(secret)?;
                }
                Ok(value)
            });
            match self.finish(debt, &lease.generation, result, |_, _| {}) {
                Ok(value) => {
                    cache.insert(key, value);
                }
                Err(error) => return self.failed_resume(&lease.generation, error),
            }
        }
        let mut state = self.state()?;
        self.current(&lease.generation)?;
        state.resume_parent_generation = None;
        if !self.policy.available() {
            return Err(PilotSecretError::VaultUnavailable);
        }
        for (key, value) in cache {
            state.cache.insert(key, value);
        }
        state.recovery_scopes.clear();
        for scope in scopes {
            Self::remember(&mut state, scope);
        }
        state.recovery_inflight = false;
        if !self.policy.available() {
            return Err(PilotSecretError::VaultUnavailable);
        }
        state.status = VaultStatus::Ready;
        let lease = self.lease(&state);
        emit(&lease);
        Ok(lease)
    }
}
