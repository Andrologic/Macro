use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
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
}

impl<B: Vault> Manager<B> {
    pub(super) fn new(backend: B) -> Self {
        Self {
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

    fn state(&self) -> Result<MutexGuard<'_, State>, PilotSecretError> {
        self.state
            .lock()
            .map_err(|_| PilotSecretError::VaultUnavailable)
    }

    fn lease(&self, state: &State) -> VaultLease {
        VaultLease {
            generation: self.generation.load(Ordering::Acquire).to_string(),
            status: state.status,
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
        let mut state = self.state()?;
        if state.context.as_ref() != Some(&context) {
            // A detached manager accepts a new owner; a live owner can only be
            // replaced by the holder of its current native generation.
            if state.context.is_some() {
                self.current(generation.ok_or(PilotSecretError::ContextChanged)?)?;
            }
            self.advance(&mut state);
            state.context = Some(context);
            state.recovery_scopes.clear();
            state.automatic_recovery = false;
            state.recovery_inflight = false;
        }
        Ok(self.lease(&state))
    }

    pub(super) fn invalidate(
        &self,
        generation: Option<&str>,
    ) -> Result<VaultLease, PilotSecretError> {
        let mut state = self.state()?;
        if generation.is_some_and(|value| {
            self.current(value).is_ok() || state.resume_parent_generation.as_deref() == Some(value)
        }) {
            self.advance(&mut state);
            state.context = None;
            state.recovery_scopes.clear();
            state.automatic_recovery = false;
            state.recovery_inflight = false;
        }
        Ok(self.lease(&state))
    }

    #[cfg(test)]
    pub(super) fn suspend(&self) {
        self.suspend_for("application_shutdown", false);
    }

    pub(super) fn suspend_for(&self, reason: &'static str, recoverable: bool) {
        if let Ok(mut state) = self.state() {
            // A lifecycle transition cannot turn a real refusal into a retry.
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

    pub(super) fn recover_silently(
        &self,
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
            let value = self.finish(generation, result, |_, _| {})?;
            cache.push((key, value));
        }
        let mut state = self.state()?;
        self.current(generation)?;
        for (key, value) in cache {
            state.cache.insert(key, value);
        }
        state.recovery_inflight = false;
        state.status = VaultStatus::Ready;
        let lease = self.lease(&state);
        emit(&lease);
        Ok(lease)
    }

    fn finish<T>(
        &self,
        generation: &str,
        result: Result<T, PilotSecretError>,
        cache: impl FnOnce(&mut State, &T),
    ) -> Result<T, PilotSecretError> {
        let mut state = self.state()?;
        self.current(generation)?;
        match result {
            Ok(value) => {
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

    pub(super) fn read(
        &self,
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
        self.finish(generation, result, |state, value| {
            state.cache.insert(key, value.clone());
            Self::remember(state, scope);
        })
    }

    pub(super) fn write(
        &self,
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
        self.finish(generation, result, |state, _| {
            state.cache.insert(key, Some(secret.to_owned()));
            Self::remember(state, scope);
        })
    }

    pub(super) fn delete(
        &self,
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
        self.finish(generation, self.backend.delete(&key, scope.kind), |_, _| {})
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

    pub(super) fn resume(
        &self,
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
            match self.finish(&lease.generation, result, |_, _| {}) {
                Ok(value) => {
                    cache.insert(key, value);
                }
                Err(error) => return self.failed_resume(&lease.generation, error),
            }
        }
        let mut state = self.state()?;
        self.current(&lease.generation)?;
        state.resume_parent_generation = None;
        for (key, value) in cache {
            state.cache.insert(key, value);
        }
        state.recovery_scopes.clear();
        for scope in scopes {
            Self::remember(&mut state, scope);
        }
        state.recovery_inflight = false;
        state.status = VaultStatus::Ready;
        let lease = self.lease(&state);
        emit(&lease);
        Ok(lease)
    }
}
