use super::*;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Barrier, Mutex,
    },
    thread,
};

type ReadGate = (mpsc::Sender<()>, mpsc::Receiver<()>);
#[derive(Default)]
struct Fake {
    values: Mutex<HashMap<String, String>>,
    failures: Mutex<HashMap<usize, PilotSecretError>>,
    resumes: AtomicUsize,
    resume_failure: Mutex<Option<PilotSecretError>>,
    resume_gate: Mutex<Option<ReadGate>>,
    reads: AtomicUsize,
    interactive: AtomicUsize,
    writes: AtomicUsize,
    deletes: AtomicUsize,
    write_fail: AtomicBool,
    refuse_silent_capture: AtomicBool,
    gate: Mutex<Option<ReadGate>>,
}
impl Vault for Arc<Fake> {
    fn silent_capture_supported(&self) -> bool {
        !self.refuse_silent_capture.load(Ordering::SeqCst)
    }
    fn prepare_resume(&self, _: PilotSecretKind) -> Result<(), PilotSecretError> {
        self.resumes.fetch_add(1, Ordering::SeqCst);
        let result = self.resume_failure.lock().unwrap().map_or(Ok(()), Err);
        if let Some((started, release)) = self.resume_gate.lock().unwrap().take() {
            started.send(()).unwrap();
            release.recv().unwrap();
        }
        result
    }
    fn read(
        &self,
        key: &str,
        _: PilotSecretKind,
        interactive: bool,
    ) -> Result<Option<String>, PilotSecretError> {
        let call = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if interactive {
            self.interactive.fetch_add(1, Ordering::SeqCst);
        }
        let result = if let Some(error) = self.failures.lock().unwrap().get(&call) {
            Err(*error)
        } else {
            Ok(self.values.lock().unwrap().get(key).cloned())
        };
        if let Some((started, release)) = self.gate.lock().unwrap().take() {
            started.send(()).unwrap();
            release.recv().unwrap();
        }
        result
    }
    fn write(&self, key: &str, _: PilotSecretKind, secret: &str) -> Result<(), PilotSecretError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.write_fail.load(Ordering::SeqCst) {
            return Err(PilotSecretError::VaultUnavailable);
        }
        self.values
            .lock()
            .unwrap()
            .insert(key.into(), secret.into());
        Ok(())
    }
    fn delete(&self, key: &str, _: PilotSecretKind) -> Result<(), PilotSecretError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.values.lock().unwrap().remove(key);
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
fn context() -> PilotVaultContext {
    PilotVaultContext {
        configuration_id: scope().configuration_id,
        relay_origin: scope().relay_origin,
        owner_id: "owner:test-01".into(),
    }
}
fn setup() -> (Arc<Manager<Arc<Fake>>>, Arc<Fake>, String) {
    let fake = Arc::new(Fake::default());
    let manager = Arc::new(Manager::new(fake.clone()));
    let generation = manager.activate(context(), None).unwrap().generation;
    (manager, fake, generation)
}
fn gate(fake: &Fake) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *fake.gate.lock().unwrap() = Some((started_tx, release_rx));
    (started_rx, release_tx)
}
fn begin_transition<T: Send + 'static>(
    manager: &Arc<Manager<Arc<Fake>>>,
    generation: &str,
    action: impl FnOnce(Arc<Manager<Arc<Fake>>>) -> T + Send + 'static,
) -> thread::JoinHandle<T> {
    let owned = manager.clone();
    let task = thread::spawn(move || action(owned));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !manager.revoked_since(generation) {
        assert!(
            std::time::Instant::now() < deadline,
            "memory revocation must not await native I/O"
        );
        thread::sleep(std::time::Duration::from_millis(1));
    }
    task
}
fn secret() -> String {
    URL_SAFE_NO_PAD.encode([7; 32])
}

#[test]
fn concurrent_reads_coalesce_values_and_absence() {
    for present in [false, true] {
        let (manager, fake, generation) = setup();
        if present {
            fake.values
                .lock()
                .unwrap()
                .insert(entry_name(&scope()).unwrap(), secret());
        }
        let start = Arc::new(Barrier::new(13));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let (manager, generation, start) =
                    (manager.clone(), generation.clone(), start.clone());
                thread::spawn(move || {
                    start.wait();
                    manager.read(&scope(), &generation)
                })
            })
            .collect();
        start.wait();
        for task in threads {
            assert_eq!(task.join().unwrap(), Ok(present.then(secret)));
        }
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        assert_eq!(fake.interactive.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn refusal_stops_already_queued_reads_and_survives_owner_changes() {
    for failure in [
        PilotSecretError::Cancelled,
        PilotSecretError::InterventionRequired,
        PilotSecretError::VaultUnavailable,
    ] {
        let (manager, fake, generation) = setup();
        fake.failures.lock().unwrap().insert(1, failure);
        let (started, release) = gate(&fake);
        let first = {
            let manager = manager.clone();
            let generation = generation.clone();
            thread::spawn(move || manager.read(&scope(), &generation))
        };
        started.recv().unwrap();
        let queued: Vec<_> = (0..8)
            .map(|_| {
                let manager = manager.clone();
                let generation = generation.clone();
                thread::spawn(move || manager.read(&scope(), &generation))
            })
            .collect();
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Err(failure));
        for task in queued {
            assert_eq!(task.join().unwrap(), Err(failure));
        }
        let blocked = manager.activate(context(), None).unwrap();
        assert_ne!(blocked.status, VaultStatus::Ready);
        manager.invalidate(Some(&generation)).unwrap();
        let mut next = context();
        next.owner_id = "owner:test-02".into();
        let next = manager.activate(next, None).unwrap();
        assert_eq!(manager.read(&scope(), &next.generation), Err(failure));
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn invalidation_does_not_wait_for_io_or_recaches_late_result() {
    let (manager, fake, generation) = setup();
    fake.values
        .lock()
        .unwrap()
        .insert(entry_name(&scope()).unwrap(), secret());
    let (started, release) = gate(&fake);
    let task = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.read(&scope(), &generation))
    };
    started.recv().unwrap();
    let previous = generation.clone();
    let invalidating = begin_transition(&manager, &generation, move |manager| {
        manager.invalidate(Some(&previous))
    });
    fake.values.lock().unwrap().clear();
    release.send(()).unwrap();
    assert_eq!(task.join().unwrap(), Err(PilotSecretError::ContextChanged));
    let detached = invalidating.join().unwrap().unwrap();
    assert_ne!(detached.generation, generation);
    let next = manager.activate(context(), None).unwrap();
    assert_eq!(manager.read(&scope(), &next.generation), Ok(None));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    assert_eq!(
        manager.invalidate(Some(&generation)).unwrap().generation,
        next.generation
    );
    assert_eq!(
        manager.invalidate(None).unwrap().generation,
        next.generation
    );
}

#[test]
fn writes_are_durable_before_cache_and_failure_never_caches() {
    let (manager, fake, generation) = setup();
    fake.write_fail.store(true, Ordering::SeqCst);
    assert_eq!(
        manager.write(&scope(), &generation, &secret()),
        Err(PilotSecretError::VaultUnavailable)
    );
    assert_eq!(
        manager.read(&scope(), &generation),
        Err(PilotSecretError::VaultUnavailable)
    );
    assert!(fake.values.lock().unwrap().is_empty());
    fake.write_fail.store(false, Ordering::SeqCst);
    let resumed = manager.resume(&[scope()], &generation).unwrap();
    manager
        .write(&scope(), &resumed.generation, &secret())
        .unwrap();
    assert_eq!(
        fake.values
            .lock()
            .unwrap()
            .get(&entry_name(&scope()).unwrap()),
        Some(&secret())
    );
    assert_eq!(
        manager.read(&scope(), &resumed.generation),
        Ok(Some(secret()))
    );
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn cleanup_delete_never_reads_or_populates_cache() {
    let (manager, fake, generation) = setup();
    let mut cleanup = scope();
    cleanup.configuration_id = "config:old-01".into();
    fake.values
        .lock()
        .unwrap()
        .insert(entry_name(&cleanup).unwrap(), "invalid data".into());
    assert_eq!(
        manager.read(&cleanup, &generation),
        Err(PilotSecretError::InvalidScope)
    );
    manager.delete(&cleanup, &generation).unwrap();
    manager.delete(&cleanup, &generation).unwrap();
    assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fake.deletes.load(Ordering::SeqCst), 2);
    assert!(fake.values.lock().unwrap().is_empty());
    manager.write(&scope(), &generation, &secret()).unwrap();
    manager.delete(&scope(), &generation).unwrap();
    assert_eq!(manager.read(&scope(), &generation), Ok(None));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn resume_reads_explicit_batch_once_and_caches_for_silent_operations() {
    let (manager, fake, generation) = setup();
    let mut instance = scope();
    instance.kind = PilotSecretKind::InstanceKey;
    fake.values
        .lock()
        .unwrap()
        .insert(entry_name(&scope()).unwrap(), secret());
    let lease = manager
        .resume(&[scope(), instance.clone(), scope()], &generation)
        .unwrap();
    assert_eq!(lease.status, VaultStatus::Ready);
    assert_ne!(lease.generation, generation);
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 2);
    assert_eq!(
        manager.read(&scope(), &lease.generation),
        Ok(Some(secret()))
    );
    assert_eq!(manager.read(&instance, &lease.generation), Ok(None));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn resume_stops_first_refusal_and_queued_resume_is_obsolete() {
    let (manager, fake, generation) = setup();
    fake.failures
        .lock()
        .unwrap()
        .insert(2, PilotSecretError::Cancelled);
    let (started, release) = gate(&fake);
    let first = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || {
            let mut instance = scope();
            instance.kind = PilotSecretKind::InstanceKey;
            let mut poll = scope();
            poll.kind = PilotSecretKind::PollSecret;
            manager.resume(&[scope(), instance, poll], &generation)
        })
    };
    started.recv().unwrap();
    let queued = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.resume(&[scope()], &generation))
    };
    release.send(()).unwrap();
    let lease = first.join().unwrap().unwrap();
    assert_eq!(lease.status, VaultStatus::Cancelled);
    assert!(matches!(
        queued.join().unwrap(),
        Err(PilotSecretError::ContextChanged)
    ));
    assert_eq!(
        manager.read(&scope(), &lease.generation),
        Err(PilotSecretError::Cancelled)
    );
    assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 2);
}

#[test]
fn suspension_interrupts_batch_and_activation_never_rearms() {
    let (manager, fake, generation) = setup();
    let (started, release) = gate(&fake);
    let task = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || {
            let mut instance = scope();
            instance.kind = PilotSecretKind::InstanceKey;
            manager.resume(&[scope(), instance], &generation)
        })
    };
    started.recv().unwrap();
    manager.suspend();
    let suspended = manager.activate(context(), None).unwrap();
    assert_eq!(suspended.status, VaultStatus::Suspended);
    release.send(()).unwrap();
    assert!(matches!(
        task.join().unwrap(),
        Err(PilotSecretError::ContextChanged)
    ));
    assert_eq!(
        manager.read(&scope(), &suspended.generation),
        Err(PilotSecretError::Suspended)
    );
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 1);
    let resumed = manager.resume(&[scope()], &suspended.generation).unwrap();
    assert_eq!(resumed.status, VaultStatus::Ready);
}

#[test]
fn active_owner_requires_generation_and_drops_previous_cache() {
    let (manager, fake, generation) = setup();
    manager.write(&scope(), &generation, &secret()).unwrap();
    let mut other = context();
    other.owner_id = "owner:other-01".into();
    assert!(matches!(
        manager.activate(other.clone(), None),
        Err(PilotSecretError::ContextChanged)
    ));
    let next = manager.activate(other, Some(&generation)).unwrap();
    fake.values.lock().unwrap().clear();
    assert_eq!(
        manager.read(&scope(), &generation),
        Err(PilotSecretError::ContextChanged)
    );
    assert_eq!(manager.read(&scope(), &next.generation), Ok(None));
}

#[test]
fn validates_scope_secret_and_batch_before_backend_io() {
    let (manager, fake, generation) = setup();
    for origin in [
        "http://relay.example",
        "https://user:password@relay.example",
        "https://relay.example/path",
        "https://relay.example/?x=1",
        "https://relay.example/#fragment",
    ] {
        let mut invalid = scope();
        invalid.relay_origin = origin.into();
        assert_eq!(
            manager.read(&invalid, &generation),
            Err(PilotSecretError::InvalidScope)
        );
    }
    for value in [
        "".to_owned(),
        "secret".into(),
        "A".repeat(42),
        "A".repeat(44),
        format!("{}B", "A".repeat(42)),
    ] {
        assert_eq!(
            manager.write(&scope(), &generation, &value),
            Err(PilotSecretError::InvalidSecret)
        );
    }
    assert!(matches!(
        manager.resume(&[], &generation),
        Err(PilotSecretError::InvalidScope)
    ));
    assert!(matches!(
        manager.resume(&vec![scope(); 9], &generation),
        Err(PilotSecretError::InvalidScope)
    ));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
    assert!(serde_json::from_str::<PilotSecretKind>("\"provider_key\"").is_err());
    let mut equivalent = scope();
    equivalent.relay_origin = "https://RELAY.example:443/".into();
    assert_eq!(entry_name(&scope()), entry_name(&equivalent));
    let mut other = scope();
    other.kind = PilotSecretKind::InstanceKey;
    assert_ne!(entry_name(&scope()), entry_name(&other));
}

#[test]
fn osstatus_mapping_does_not_invent_causes() {
    for status in [-25308, -25315] {
        assert_eq!(
            native::status_error(status),
            PilotSecretError::InterventionRequired
        );
    }
    assert_eq!(native::status_error(-128), PilotSecretError::Cancelled);
    for status in [-25291, -25293, -25294, -25300, -50, 123456] {
        assert_eq!(
            native::status_error(status),
            PilotSecretError::VaultUnavailable
        );
    }
}

struct FakeInteraction {
    allowed: AtomicBool,
    changes: Mutex<Vec<bool>>,
    fail_get: bool,
    fail_set: AtomicBool,
}
impl native::Interaction for FakeInteraction {
    fn get(&self) -> Result<bool, i32> {
        if self.fail_get {
            Err(-50)
        } else {
            Ok(self.allowed.load(Ordering::SeqCst))
        }
    }
    fn set(&self, value: bool) -> Result<(), i32> {
        self.changes.lock().unwrap().push(value);
        if self.fail_set.swap(false, Ordering::SeqCst) {
            return Err(-50);
        }
        self.allowed.store(value, Ordering::SeqCst);
        Ok(())
    }
}
fn policy(value: bool) -> FakeInteraction {
    FakeInteraction {
        allowed: AtomicBool::new(value),
        changes: Mutex::new(vec![]),
        fail_get: false,
        fail_set: AtomicBool::new(false),
    }
}

#[test]
fn interaction_guard_restores_both_prior_states_and_nested_policy() {
    for previous in [false, true] {
        let api = policy(previous);
        {
            let outer = native::InteractionGuard::enter(&api, false).unwrap();
            {
                let inner = native::InteractionGuard::enter(&api, true).unwrap();
                inner.restore().unwrap();
            }
            assert!(!api.allowed.load(Ordering::SeqCst));
            outer.restore().unwrap();
        }
        assert_eq!(api.allowed.load(Ordering::SeqCst), previous);
        assert_eq!(
            *api.changes.lock().unwrap(),
            vec![false, true, false, previous]
        );
    }
}

#[test]
fn interaction_guard_restores_on_unwind_and_reports_failures() {
    let api = policy(false);
    let _ = std::panic::catch_unwind(|| {
        let _guard = native::InteractionGuard::enter(&api, true).unwrap();
        panic!("synthetic failure");
    });
    assert!(!api.allowed.load(Ordering::SeqCst));
    let guard = native::InteractionGuard::enter(&api, true).unwrap();
    api.fail_set.store(true, Ordering::SeqCst);
    assert_eq!(guard.restore(), Err(-50));
    assert!(!api.allowed.load(Ordering::SeqCst));
    api.fail_set.store(true, Ordering::SeqCst);
    assert!(native::InteractionGuard::enter(&api, true).is_err());
    assert!(!api.allowed.load(Ordering::SeqCst));
    let mut unreadable = policy(true);
    unreadable.fail_get = true;
    assert!(native::InteractionGuard::enter(&unreadable, false).is_err());
    assert!(unreadable.changes.lock().unwrap().is_empty());
}

#[test]
fn logout_with_resume_input_generation_invalidates_pending_interactive_result() {
    let (manager, fake, generation) = setup();
    fake.values
        .lock()
        .unwrap()
        .insert(entry_name(&scope()).unwrap(), secret());
    let (started, release) = gate(&fake);
    let task = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.resume(&[scope()], &generation))
    };
    started.recv().unwrap();
    let in_flight = manager.activate(context(), None).unwrap();
    assert_ne!(in_flight.generation, generation);
    let previous = generation.clone();
    let invalidating = begin_transition(&manager, &in_flight.generation, move |manager| {
        manager.invalidate(Some(&previous))
    });
    release.send(()).unwrap();
    let invalidated = invalidating.join().unwrap().unwrap();
    assert_ne!(invalidated.generation, in_flight.generation);
    assert!(matches!(
        task.join().unwrap(),
        Err(PilotSecretError::ContextChanged)
    ));
    let next = manager.activate(context(), None).unwrap();
    assert_eq!(next.status, VaultStatus::Suspended);
    assert_eq!(
        manager.read(&scope(), &next.generation),
        Err(PilotSecretError::Suspended)
    );
    fake.values.lock().unwrap().clear();
    let resumed = manager.resume(&[scope()], &next.generation).unwrap();
    assert_eq!(manager.read(&scope(), &resumed.generation), Ok(None));
    assert_eq!(
        manager
            .invalidate(Some(&next.generation))
            .unwrap()
            .generation,
        resumed.generation
    );
}

#[test]
fn native_namespace_preserves_production_and_isolates_other_identifiers() {
    assert_eq!(
        native::service_for_identifier("com.macro.desktop"),
        "ai.andrologic.macro.pilot.v1"
    );
    for identifier in [
        "com.macro.desktop.test",
        "com.macro.desktop.preview",
        "org.example.synthetic",
        "ai.andrologic.macro",
    ] {
        let service = native::service_for_identifier(identifier);
        assert_eq!(service, format!("macro.pilot.v1.app:{identifier}"));
        assert_ne!(service, native::service_for_identifier("com.macro.desktop"));
    }
}

#[test]
fn cache_retains_at_most_eight_scopes_and_write_replaces_cached_absence() {
    let (manager, fake, generation) = setup();
    let scopes: Vec<_> = (0..9)
        .map(|index| {
            let mut scope = scope();
            scope.resource_id = format!("resource:{index:03}");
            scope
        })
        .collect();
    for scope in &scopes {
        assert_eq!(manager.read(scope, &generation), Ok(None));
    }
    assert_eq!(fake.reads.load(Ordering::SeqCst), 9);
    for scope in &scopes[1..] {
        assert_eq!(manager.read(scope, &generation), Ok(None));
    }
    assert_eq!(fake.reads.load(Ordering::SeqCst), 9);
    manager.read(&scopes[0], &generation).unwrap();
    assert_eq!(fake.reads.load(Ordering::SeqCst), 10);
    manager.write(&scopes[0], &generation, &secret()).unwrap();
    assert_eq!(manager.read(&scopes[0], &generation), Ok(Some(secret())));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 10);
}

#[test]
fn unlock_is_explicit_once_and_refusal_prevents_all_reads() {
    let (manager, fake, generation) = setup();
    manager.read(&scope(), &generation).unwrap();
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 0);
    *fake.resume_failure.lock().unwrap() = Some(PilotSecretError::Cancelled);
    let lease = manager.resume(&[scope()], &generation).unwrap();
    assert_eq!(lease.status, VaultStatus::Cancelled);
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        manager.read(&scope(), &lease.generation),
        Err(PilotSecretError::Cancelled)
    );
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 1);
}

#[test]
fn logout_during_unlock_rejects_late_success_without_reading_any_scope() {
    let (manager, fake, generation) = setup();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *fake.resume_gate.lock().unwrap() = Some((started_tx, release_rx));
    let task = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.resume(&[scope()], &generation))
    };
    started_rx.recv().unwrap();
    let in_flight = manager.activate(context(), None).unwrap();
    let previous = generation.clone();
    let invalidating = begin_transition(&manager, &in_flight.generation, move |manager| {
        manager.invalidate(Some(&previous))
    });
    release_tx.send(()).unwrap();
    invalidating.join().unwrap().unwrap();
    assert!(matches!(
        task.join().unwrap(),
        Err(PilotSecretError::ContextChanged)
    ));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn second_resume_with_current_inflight_generation_never_queues() {
    let (manager, fake, generation) = setup();
    let (started, release) = gate(&fake);
    let first = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.resume(&[scope()], &generation))
    };
    started.recv().unwrap();
    let current = manager.activate(context(), None).unwrap();
    // This must return while the first native operation is still blocked.
    let (returned_tx, returned_rx) = mpsc::channel();
    let second = {
        let manager = manager.clone();
        thread::spawn(move || {
            returned_tx
                .send(manager.resume(&[scope()], &current.generation))
                .unwrap();
        })
    };
    let rejected = returned_rx.recv_timeout(std::time::Duration::from_secs(2));
    release.send(()).unwrap();
    assert!(matches!(
        rejected.unwrap(),
        Err(PilotSecretError::Suspended)
    ));
    second.join().unwrap();
    assert_eq!(first.join().unwrap().unwrap().status, VaultStatus::Ready);
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 1);
}

#[test]
fn silent_recovery_is_one_batch_without_unlock_or_interactive_reads() {
    let (manager, fake, generation) = setup();
    manager.write(&scope(), &generation, &secret()).unwrap();
    manager.suspend_for("screen_locked", true);
    let (scopes, generation) = manager.take_recovery().unwrap();
    assert!(manager.take_recovery().is_none());
    let lease = manager.recover_silently(&scopes, &generation).unwrap();
    assert_eq!(lease.status, VaultStatus::Ready);
    assert_eq!(lease.generation, generation);
    assert_eq!(manager.read(&scope(), &generation), Ok(Some(secret())));
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 0);
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 0);
}

#[test]
fn lifecycle_never_rearms_a_refusal_or_failed_silent_attempt() {
    for failure in [
        PilotSecretError::Cancelled,
        PilotSecretError::InterventionRequired,
        PilotSecretError::VaultUnavailable,
    ] {
        let (manager, fake, generation) = setup();
        manager.write(&scope(), &generation, &secret()).unwrap();
        manager.suspend_for("system_sleep", true);
        let (scopes, generation) = manager.take_recovery().unwrap();
        fake.failures.lock().unwrap().insert(1, failure);
        assert!(
            matches!(manager.recover_silently(&scopes, &generation), Err(error) if error == failure)
        );
        manager.suspend_for("screen_locked", true);
        assert!(manager.take_recovery().is_none());
        let lease = manager.activate(context(), None).unwrap();
        assert_eq!(manager.read(&scope(), &lease.generation), Err(failure));
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        assert_eq!(fake.interactive.load(Ordering::SeqCst), 0);
        assert_eq!(fake.resumes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn logout_owner_change_and_relock_reject_inflight_silent_recovery() {
    for transition in ["logout", "owner_change", "relock"] {
        let (manager, fake, generation) = setup();
        manager.write(&scope(), &generation, &secret()).unwrap();
        manager.suspend_for("screen_locked", true);
        let (scopes, generation) = manager.take_recovery().unwrap();
        let (started, release) = gate(&fake);
        let task = {
            let manager = manager.clone();
            let generation = generation.clone();
            thread::spawn(move || manager.recover_silently(&scopes, &generation))
        };
        started.recv().unwrap();
        let previous = generation.clone();
        let changing = begin_transition(&manager, &generation, move |manager| match transition {
            "logout" => manager.invalidate(Some(&previous)).map(|_| ()),
            "owner_change" => {
                let mut owner = context();
                owner.owner_id = "owner:other-01".into();
                manager.activate(owner, Some(&previous)).map(|_| ())
            }
            _ => {
                manager.suspend_for("screen_locked", true);
                Ok(())
            }
        });
        release.send(()).unwrap();
        changing.join().unwrap().unwrap();
        assert!(matches!(
            task.join().unwrap(),
            Err(PilotSecretError::ContextChanged)
        ));
        assert_eq!(fake.interactive.load(Ordering::SeqCst), 0);
        if transition == "relock" {
            let (scopes, next) = manager.take_recovery().unwrap();
            assert_eq!(
                manager.recover_silently(&scopes, &next).unwrap().status,
                VaultStatus::Ready
            );
        } else {
            assert!(manager.take_recovery().is_none());
        }
    }
}

#[test]
fn shutdown_cancels_recovery_and_deleted_scopes_are_not_restored() {
    let (manager, _, generation) = setup();
    manager.write(&scope(), &generation, &secret()).unwrap();
    manager.delete(&scope(), &generation).unwrap();
    manager.suspend_for("screen_locked", true);
    assert!(manager.take_recovery().is_none());
    manager.suspend();
    assert!(manager.take_recovery().is_none());
}

pub(super) fn qualification_backup_context(
    actual: &serde_json::Value,
    original_id: &str,
    attached: bool,
) {
    let fake = Arc::new(Fake::default());
    let original_context = PilotVaultContext {
        configuration_id: original_id.into(),
        relay_origin: "https://relay.example".into(),
        owner_id: "owner:test-01".into(),
    };
    let current = PilotVaultContext {
        configuration_id: actual["configurationId"].as_str().unwrap().into(),
        relay_origin: actual["relayOrigin"].as_str().unwrap().into(),
        owner_id: "owner:test-01".into(),
    };
    for kind in [
        PilotSecretKind::SessionToken,
        PilotSecretKind::InstanceKey,
        PilotSecretKind::ClaimSecret,
        PilotSecretKind::PollSecret,
    ] {
        let old = PilotSecretScope {
            configuration_id: original_id.into(),
            relay_origin: original_context.relay_origin.clone(),
            kind,
            resource_id: "resource:test-01".into(),
        };
        fake.values
            .lock()
            .unwrap()
            .insert(entry_name(&old).unwrap(), secret());
        // Warm a separate original manager cache, then create a fresh manager using the restored context.
        let original = Manager::new(fake.clone());
        let generation = original
            .activate(original_context.clone(), None)
            .unwrap()
            .generation;
        assert_eq!(original.read(&old, &generation).unwrap(), Some(secret()));
        let reopened = Manager::new(fake.clone());
        let generation = reopened.activate(current.clone(), None).unwrap().generation;
        let scoped = PilotSecretScope {
            configuration_id: current.configuration_id.clone(),
            ..old.clone()
        };
        assert_eq!(
            reopened.read(&scoped, &generation).unwrap(),
            attached.then(secret),
            "kind={kind:?}"
        );
        if !attached {
            assert_eq!(
                reopened.read(&old, &generation),
                Err(PilotSecretError::InvalidScope)
            );
        }
        assert_eq!(
            fake.values.lock().unwrap().get(&entry_name(&old).unwrap()),
            Some(&secret())
        );
    }
    assert_eq!(fake.deletes.load(Ordering::SeqCst), 0);
}

#[test]
fn policy_nonce_failure_prevents_pilot_writes_and_only_explicit_resume_recovers() {
    let (manager, fake, generation) = setup();
    let (policy, directory) = manager.policy_fixture();
    let before = policy.qualification_stamp().unwrap();
    manager.write(&scope(), &generation, &secret()).unwrap();
    assert!(policy.qualification_stamp().unwrap() != before);
    let path = directory.join("provider-secrets.json");
    let held = directory.join("synthetic-held.json");
    std::fs::rename(&path, &held).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        manager.write(&scope(), &generation, &secret()),
        Err(PilotSecretError::VaultUnavailable)
    );
    assert_eq!(
        manager.delete(&scope(), &generation),
        Err(PilotSecretError::VaultUnavailable)
    );
    assert_eq!(fake.writes.load(Ordering::SeqCst), 1);
    assert_eq!(fake.deletes.load(Ordering::SeqCst), 0);
    assert!(policy.qualification_stamp().is_err());
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&held, &path).unwrap();
    assert!(!policy.available());
    let mut replacement = context();
    replacement.owner_id = "owner:other-01".into();
    assert!(manager.activate(replacement, Some(&generation)).is_err());
    let refused = manager.activate(context(), None).unwrap();
    assert_eq!(refused.status, VaultStatus::VaultUnavailable);
    let resumed = manager.resume(&[scope()], &refused.generation).unwrap();
    assert_eq!(resumed.status, VaultStatus::Ready);
    assert_eq!(
        manager.read(&scope(), &resumed.generation),
        Ok(Some(secret()))
    );
    assert!(policy.qualification_stamp().unwrap() != before);
}

#[test]
fn finish_keeps_native_refusal_and_persistence_debt_until_explicit_retry() {
    let (manager, fake, generation) = setup();
    let (policy, directory) = manager.policy_fixture();
    let before = policy.qualification_stamp().unwrap();
    fake.failures
        .lock()
        .unwrap()
        .insert(1, PilotSecretError::InterventionRequired);
    let (started, release) = gate(&fake);
    let reading = {
        let manager = manager.clone();
        let generation = generation.clone();
        thread::spawn(move || manager.read(&scope(), &generation))
    };
    started
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    // Synthetic filesystem fault after the admitted read, before finish settles.
    let path = directory.join("provider-secrets.json");
    let held = directory.join("synthetic-held.json");
    std::fs::rename(&path, &held).unwrap();
    std::fs::create_dir(&path).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        reading.join().unwrap(),
        Err(PilotSecretError::InterventionRequired)
    );
    assert!(!policy.available());
    assert!(policy.qualification_stamp().is_err());
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&held, &path).unwrap();
    assert!(!policy.available());
    assert_eq!(
        manager.activate(context(), None).unwrap().status,
        VaultStatus::InterventionRequired
    );
    assert_eq!(
        manager.read(&scope(), &generation),
        Err(PilotSecretError::InterventionRequired)
    );
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    let resumed = manager.resume(&[scope()], &generation).unwrap();
    assert_eq!(resumed.status, VaultStatus::Ready);
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 1);
    assert!(policy.qualification_stamp().unwrap() != before);
}

fn transport_identity(
    manager: &Manager<Arc<Fake>>,
    generation: &str,
) -> manager::TransportIdentity {
    let mut transport = context();
    transport.owner_id = scope().resource_id;
    let lease = manager
        .activate(transport.clone(), Some(generation))
        .unwrap();
    manager::TransportIdentity {
        context: transport,
        generation: lease.generation,
        instance_creation_id: "creation:test-01".into(),
    }
}
fn instance_scope() -> PilotSecretScope {
    let mut instance = scope();
    instance.kind = PilotSecretKind::InstanceKey;
    instance.resource_id = "creation:test-01".into();
    instance
}
fn seed_transport(manager: &Manager<Arc<Fake>>, identity: &manager::TransportIdentity) {
    manager
        .write(&scope(), &identity.generation, &secret())
        .unwrap();
    manager
        .write(
            &instance_scope(),
            &identity.generation,
            &URL_SAFE_NO_PAD.encode([8; 32]),
        )
        .unwrap();
}

#[test]
fn private_pair_is_fresh_silent_and_old_handle_cannot_survive_a_b_a() {
    let (manager, fake, generation) = setup();
    let identity = transport_identity(&manager, &generation);
    seed_transport(&manager, &identity);
    let first = manager.capture_policy(&identity).unwrap();
    assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    let replacement = URL_SAFE_NO_PAD.encode([9; 32]);
    fake.values
        .lock()
        .unwrap()
        .insert(entry_name(&scope()).unwrap(), replacement.clone());
    // The ordinary cache keeps its value; the private reader bypasses it.
    assert_eq!(
        manager.read(&scope(), &identity.generation),
        Ok(Some(secret()))
    );
    let fresh = manager.capture_policy(&identity).unwrap();
    assert_eq!(fresh.peer().session_token, replacement);
    assert!(manager
        .consume_policy(&first, &identity, |_, _| Ok(()))
        .is_err());
    manager
        .write(&scope(), &identity.generation, &secret())
        .unwrap();
    assert!(manager
        .consume_policy(&first, &identity, |_, _| Ok(()))
        .is_err());
    let current = manager.capture_policy(&identity).unwrap();
    manager
        .consume_policy(&current, &identity, |lease, pair| {
            lease.check()?;
            assert_eq!(pair.session_token, secret());
            Ok(())
        })
        .unwrap();
    assert_eq!(fake.interactive.load(Ordering::SeqCst), 0);
    assert_eq!(fake.resumes.load(Ordering::SeqCst), 0);
}

#[test]
fn private_capture_refuses_unsupported_silence_without_changing_ordinary_reads() {
    let (manager, fake, generation) = setup();
    let identity = transport_identity(&manager, &generation);
    seed_transport(&manager, &identity);
    fake.refuse_silent_capture.store(true, Ordering::SeqCst);
    assert!(manager.capture_policy(&identity).is_err());
    assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        manager.read(&scope(), &identity.generation),
        Ok(Some(secret()))
    );
    assert!(manager.policy_fixture().0.available());
}

#[test]
fn private_pair_capture_serializes_real_classic_and_pilot_writers() {
    let _serial = crate::secrets::lock_test_store();
    let directory = tempfile::tempdir().unwrap();
    crate::secrets::init(directory.path()).unwrap();
    let fake = Arc::new(Fake::default());
    let manager =
        Arc::new(Manager::new(fake.clone()).using_policy(crate::secrets::policy::POLICY.clone()));
    let generation = manager.activate(context(), None).unwrap().generation;
    let identity = transport_identity(&manager, &generation);
    seed_transport(&manager, &identity);
    crate::secrets::set_api_key("synthetic-shared", "before").unwrap();
    let (started, release) = gate(&fake);
    let capturing = {
        let manager = manager.clone();
        let identity = identity.clone();
        thread::spawn(move || manager.capture_policy(&identity))
    };
    started
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let classic = thread::spawn(|| crate::secrets::set_api_key("synthetic-shared", "after"));
    let pilot = {
        let manager = manager.clone();
        let generation = identity.generation.clone();
        thread::spawn(move || {
            manager.write(
                &instance_scope(),
                &generation,
                &URL_SAFE_NO_PAD.encode([10; 32]),
            )
        })
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while crate::secrets::policy::POLICY.pending_for_test() < 2 {
        assert!(std::time::Instant::now() < deadline);
        thread::sleep(std::time::Duration::from_millis(1));
    }
    release.send(()).unwrap();
    assert!(capturing.join().unwrap().is_err());
    classic.join().unwrap().unwrap();
    pilot.join().unwrap().unwrap();
    let captured = manager.capture_policy(&identity).unwrap();
    assert!(captured.values().contains(&"after".to_string()));
    assert!(!captured.values().contains(&"before".to_string()));
    assert_eq!(
        captured.peer().instance_key,
        URL_SAFE_NO_PAD.encode([10; 32])
    );
}

#[test]
fn failed_private_read_revokes_queued_emission_and_requires_explicit_recovery() {
    let (manager, fake, generation) = setup();
    let identity = transport_identity(&manager, &generation);
    seed_transport(&manager, &identity);
    let snapshot = manager.capture_policy(&identity).unwrap();
    let next = fake.reads.load(Ordering::SeqCst) + 1;
    fake.failures
        .lock()
        .unwrap()
        .insert(next, PilotSecretError::InterventionRequired);
    let (started, release) = gate(&fake);
    let capturing = {
        let manager = manager.clone();
        let identity = identity.clone();
        thread::spawn(move || manager.capture_policy(&identity))
    };
    started
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let emitted = Arc::new(AtomicBool::new(false));
    let consuming = {
        let manager = manager.clone();
        let identity = identity.clone();
        let emitted = emitted.clone();
        thread::spawn(move || {
            manager.consume_policy(&snapshot, &identity, |_, _| {
                emitted.store(true, Ordering::SeqCst);
                Ok(())
            })
        })
    };
    release.send(()).unwrap();
    assert!(matches!(
        capturing.join().unwrap(),
        Err(PilotSecretError::InterventionRequired)
    ));
    assert!(consuming.join().unwrap().is_err());
    assert!(!emitted.load(Ordering::SeqCst));
    assert_eq!(
        manager
            .activate(identity.context.clone(), None)
            .unwrap()
            .status,
        VaultStatus::InterventionRequired
    );
    assert!(manager.capture_policy(&identity).is_err());
    let resumed = manager
        .resume(&[scope(), instance_scope()], &identity.generation)
        .unwrap();
    assert_eq!(resumed.status, VaultStatus::Ready);
    assert!(manager.capture_policy(&identity).is_err());
    let identity = manager::TransportIdentity {
        generation: resumed.generation,
        ..identity
    };
    assert!(manager.capture_policy(&identity).is_ok());
}

// A separately launched test process shares the real file owner, but uses only
// the injected synthetic vault. No platform credential service is contacted.
#[test]
#[ignore]
fn cooperative_pilot_writer_process() {
    use std::io::{BufRead, Write};
    let directory =
        std::path::PathBuf::from(std::env::var_os("MACRO_SYNTHETIC_POLICY_DIRECTORY").unwrap());
    crate::secrets::init(&directory).unwrap();
    let fake = Arc::new(Fake::default());
    let manager = Manager::new(fake.clone()).using_policy(crate::secrets::policy::POLICY.clone());
    let generation = manager.activate(context(), None).unwrap().generation;
    println!("POLICY_CHILD_READY");
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().lock().read_line(&mut input).unwrap();
    assert_eq!(input.trim(), "write");
    println!("POLICY_CHILD_ATTEMPT");
    std::io::stdout().flush().unwrap();
    manager.write(&scope(), &generation, &secret()).unwrap();
    assert_eq!(fake.writes.load(Ordering::SeqCst), 1);
    println!("POLICY_CHILD_WRITTEN");
    std::io::stdout().flush().unwrap();
}

#[test]
fn private_lease_excludes_a_cooperative_pilot_writer_in_another_process() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let owner = crate::secrets::policy::PolicyOwner::for_test(directory.path());
    owner.initialize(directory.path()).unwrap();
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::pilot_secrets::tests::cooperative_pilot_writer_process",
                "--ignored",
                "--nocapture",
            ])
            .env("MACRO_SYNTHETIC_POLICY_DIRECTORY", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (sent, received) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = line.unwrap();
            if line.starts_with("POLICY_CHILD_") {
                if sent.send(line).is_err() {
                    break;
                }
            }
        }
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_eq!(
            received
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            "POLICY_CHILD_READY"
        );
        let snapshot = owner.capture_private(|| Ok(())).unwrap();
        owner
            .consume_private(
                &snapshot,
                || Ok(()),
                |lease, _| {
                    writeln!(child.0.stdin.as_mut().unwrap(), "write").unwrap();
                    assert_eq!(
                        received
                            .recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap(),
                        "POLICY_CHILD_ATTEMPT"
                    );
                    assert!(received
                        .recv_timeout(std::time::Duration::from_millis(50))
                        .is_err());
                    lease.check()?;
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            received
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            "POLICY_CHILD_WRITTEN"
        );
        assert!(child.0.wait().unwrap().success());
        assert!(owner
            .consume_private(&snapshot, || Ok(()), |_, _| Ok(()))
            .is_err());
    }));
    drop(child);
    reader.join().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the explicitly supplied external local relay harness"]
async fn private_bootstrap_real_relay_correlates_scope_and_keeps_controller_rights_separate() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio_util::sync::CancellationToken;
    use transport::{Intent, Scope};
    let executable = |name: &str| std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join(name)).find(|path| path.is_file()).unwrap();
    let mut child = tokio::process::Command::new(executable("node"))
        .arg("--import").arg(std::env::var("MACRO_CONNECT_RELAY_LOADER").unwrap())
        .arg("--conditions=react-server").arg(std::env::var("MACRO_CONNECT_RELAY_HARNESS").unwrap())
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .kill_on_drop(true).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let seed: serde_json::Value = serde_json::from_str(&tokio::time::timeout(std::time::Duration::from_secs(15), output.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
    let address = format!("127.0.0.1:{}", seed["port"].as_u64().unwrap()).parse().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let db = crate::core::db_state::DbPool::default();
    db.set_ready(crate::db::create_pool(&directory.path().join("bootstrap.db")).await.unwrap()).await.unwrap();
    let ready = db.wait_until_ready_context().await.unwrap();
    let runtime = crate::connect::TransferRuntime::default();
    let budget = runtime.budget().unwrap();
    let codec = runtime.source_launcher(&executable("bun"), &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts"), &db).unwrap();
    let cancel = CancellationToken::new();
    let text = |value: &serde_json::Value, key: &str| value[key].as_str().unwrap().to_string();
    let fixture = |owner: &str, credentials: &str, controller: bool| {
        let fake = Arc::new(Fake::default());
        let manager = Arc::new(Manager::new(fake.clone()));
        let owner = &seed[owner]; let credentials = &seed[credentials];
        let context = PilotVaultContext { configuration_id: "config:synthetic".into(), relay_origin: text(&seed, "origin"), owner_id: text(owner, "session_id") };
        let generation = manager.activate(context.clone(), None).unwrap().generation;
        for (kind, resource_id, secret) in [(PilotSecretKind::SessionToken, context.owner_id.clone(), text(credentials,"token")),
            (PilotSecretKind::InstanceKey,text(credentials,"creation"),text(credentials,"key"))] {
            manager.write(&PilotSecretScope { configuration_id:context.configuration_id.clone(), relay_origin:context.relay_origin.clone(), kind, resource_id }, &generation, &secret).unwrap();
        }
        let scope = if controller { Scope::Controller { source_instance_id: text(credentials,"instance"), target_instance_id: None } }
            else { Scope::Producer { instance_id: text(credentials,"instance") } };
        (manager, fake, Intent { context, generation, instance_creation_id:text(credentials,"creation"), account_id:Some(text(&seed,"account_id")), device_id:Some(text(credentials,"device_id")), scope })
    };
    let (manager, fake, intent) = fixture("a","a",false);
    let verified = transport::bootstrap_owned(manager.clone(), intent, &runtime, &codec, &ready, address, true, &cancel).await.unwrap();
    verified.check().await.unwrap();
    // The first native decision uses canonical authenticated HTTP, not a SQL
    // receipt or a test-produced terminal. A new source is explicitly absent.
    let source_path = format!("/pilot/v2/transfers/sources/{}/synthetic-chat/decisions", text(&seed["a"], "instance"));
    let status_request = serde_json::json!({
        "transit_contract":"transfer-transit-1", "type":"decision.request",
        "request_id":uuid::Uuid::new_v4(), "request":{
            "decision_contract":"transfer-decision-1", "type":"decision_request",
            "operation":"reconcile", "operation_id":uuid::Uuid::new_v4(),
            "expected_revision":"0", "body":{"action":"source_status", "provenance":{
                "source":{"relay_origin":seed["origin"], "account_id":seed["account_id"],
                    "source_instance_id":seed["a"]["instance"], "source_conversation_id":"synthetic-chat"},
                "lineage_id":uuid::Uuid::new_v4(), "installation_id":uuid::Uuid::new_v4(),
                "birth_generation":uuid::Uuid::new_v4()
            }}
        }
    });
    let decision_output = verified.decision(manager.clone(), &ready, &source_path, status_request.clone(), serde_json::Value::Null).await.unwrap();
    let status:serde_json::Value=serde_json::from_slice(decision_output.bytes.as_slice()).unwrap();
    assert_eq!(status["result"]["kind"],"source_status");
    assert_eq!(status["result"]["status"]["status"],"not_found");
    drop(decision_output);
    let events = runtime.profile_events();
    use crate::connect::codec::Profile;
    assert_eq!(events.len(), 3);
    assert_eq!((events[0].0, events[0].2), (Profile::Bootstrap, false));
    assert_eq!(events[1], (Profile::Bootstrap, events[0].1, true));
    assert_eq!((events[2].0, events[2].2), (Profile::Persistent, false));

    assert_eq!(fake.interactive.load(Ordering::SeqCst),0);
    assert_eq!(fake.resumes.load(Ordering::SeqCst),0);
    manager.policy_fixture().0.change(|| ()).unwrap();
    assert_eq!(verified.check().await.err(),Some("policy_revoked"));
    assert_eq!(verified.decision(manager.clone(), &ready, &source_path, status_request, serde_json::Value::Null).await.err(),Some("policy_revoked"));
    verified.close().await.unwrap();
    // A real second process rotates the same persistent policy epoch without
    // changing the first owner's local revision. A retained bootstrap must fail.
    let (manager, _, intent) = fixture("a","a",false);
    let verified = transport::bootstrap_owned(manager.clone(), intent, &runtime, &codec, &ready, address, true, &cancel).await.unwrap();
    verified.check().await.unwrap();
    let (_, policy_directory) = manager.policy_fixture();
    let mut writer = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "commands::pilot_secrets::tests::cooperative_pilot_writer_process", "--ignored", "--nocapture"])
        .env("MACRO_SYNTHETIC_POLICY_DIRECTORY", policy_directory)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null())
        .kill_on_drop(true).spawn().unwrap();
    let mut writer_input = writer.stdin.take().unwrap();
    writer_input.write_all(b"write\n").await.unwrap();
    drop(writer_input);
    assert!(tokio::time::timeout(std::time::Duration::from_secs(10), writer.wait()).await.unwrap().unwrap().success());
    assert_eq!(verified.check().await.err(), Some("policy_revoked"));
    verified.close().await.unwrap();
    let (manager, _, intent) = fixture("a","a",true);
    assert_eq!(transport::bootstrap_owned(manager,intent,&runtime,&codec,&ready,address,true,&cancel).await.err(),Some("authority_unavailable"));
    // B's token and instance key are both valid, in A's account. Selecting A's
    // secret scope must still fail /me before any producer preflight is sent.
    input.write_all(b"{}\n").await.unwrap();input.flush().await.unwrap();
    let before: serde_json::Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();
    let (manager, _, intent) = fixture("a","b",false);
    assert_eq!(transport::bootstrap_owned(manager,intent,&runtime,&codec,&ready,address,true,&cancel).await.err(),Some("invalid_response"));
    input.write_all(b"{}\n").await.unwrap();input.flush().await.unwrap();
    let after: serde_json::Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(before["preflightRequests"],after["preflightRequests"]);
    for (mode, expected) in [("correlation","http_correlation"),("large-fixed","resource_limit"),("large-chunked","resource_limit")] {
        input.write_all(format!("{{\"mode\":\"{mode}\"}}\n").as_bytes()).await.unwrap();input.flush().await.unwrap();
        output.next_line().await.unwrap().unwrap();
        let (manager, _, intent)=fixture("a","a",false);
        assert_eq!(transport::bootstrap_owned(manager,intent,&runtime,&codec,&ready,address,true,&cancel).await.err(),Some(expected));
    }
    input.write_all(b"{\"mode\":\"normal\"}\n").await.unwrap();input.flush().await.unwrap();output.next_line().await.unwrap().unwrap();
    // Real /me serialization reads a short-lived session from synthetic SQLite.
    input.write_all(b"{\"shortSession\":true}\n").await.unwrap();input.flush().await.unwrap();output.next_line().await.unwrap().unwrap();
    let (short_manager, _, short_intent)=fixture("a","a",false);
    let short=transport::bootstrap_owned(short_manager.clone(),short_intent,&runtime,&codec,&ready,address,true,&cancel).await.unwrap();
    short.check().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3100)).await;
    assert_eq!(short.check().await.err(),Some("authority_expired"));short.close().await.unwrap();
    input.write_all(b"{\"restoreSession\":true}\n").await.unwrap();input.flush().await.unwrap();output.next_line().await.unwrap().unwrap();
    let (manager, _, intent)=fixture("b","b",false);
    let verified=transport::bootstrap_owned(manager.clone(),intent,&runtime,&codec,&ready,address,true,&cancel).await.unwrap();
    input.write_all(b"{\"revoke\":true}\n").await.unwrap();input.flush().await.unwrap();output.next_line().await.unwrap().unwrap();
    runtime.revoke();assert_eq!(verified.check().await.err(),Some("transport_retired"));verified.close().await.unwrap();
    let codec = runtime.source_launcher(&executable("bun"), &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts"), &db).unwrap();
    let (manager, _, intent)=fixture("a","a",false);
    assert_eq!(transport::bootstrap_owned(manager,intent,&runtime,&codec,&ready,address,true,&cancel).await.err(),Some("session_unavailable"));
    assert!(runtime.shutdown().await);
    assert!(budget.reserve(crate::connect_resources::TRANSIT_INSTANCE_LIMIT).is_ok());
    input.write_all(b"{\"stop\":true}\n").await.unwrap();input.flush().await.unwrap();drop(input);
    assert!(tokio::time::timeout(std::time::Duration::from_secs(10),child.wait()).await.unwrap().unwrap().success());
}


async fn transfer_target_event(lines:&mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>)->Result<serde_json::Value,&'static str> {
    while let Some(line)=lines.next_line().await.map_err(|_|"target_event_io")? {
        if line.len()>4096{return Err("target_event_limit");}
        if let Some(start)=line.find("SLICE_TARGET_EVENT:"){return serde_json::from_str(&line[start+19..]).map_err(|_|"target_event_json");}
    }Err("target_event_eof")
}

/// One evolving local product scenario. It stays red until source, real relay,
/// inactive target, native preparation and ACK are connected together.
#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="requires the explicitly supplied local transfer relay"]
async fn global_chat_macro_ai_local_transfer() {
    use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};
    use tokio_util::sync::CancellationToken;
    use transport::{Intent,Scope};
    use sha2::{Digest,Sha256};
    let executable=|name:&str|std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p|p.join(name)).find(|p|p.is_file()).unwrap();
    let mut relay=tokio::process::Command::new(executable("node"))
        .args(["--import",&std::env::var("MACRO_CONNECT_RELAY_LOADER").unwrap(),"--conditions=react-server",
            &std::env::var("MACRO_CONNECT_RELAY_HARNESS").unwrap()])
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let mut relay_input=relay.stdin.take().unwrap();
    let mut lines=BufReader::new(relay.stdout.take().unwrap()).lines();
    let seed:serde_json::Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    let address=format!("127.0.0.1:{}",seed["port"].as_u64().unwrap()).parse().unwrap();
    let directory=tempfile::tempdir().unwrap();
    let source=crate::core::db_state::DbPool::default();
    let source_pool=crate::db::create_pool(&directory.path().join("source.db")).await.unwrap();
    source.set_ready(source_pool.clone()).await.unwrap();
    let target=crate::core::db_state::DbPool::default();
    let target_pool=crate::db::create_pool(&directory.path().join("target.db")).await.unwrap();
    target.set_ready(target_pool.clone()).await.unwrap();
    let content="A short answer available on the other computer.";
    let provenance=tokio::process::Command::new(executable("bun")).args(["-e",r#"
        import {assistantProvenance} from './src/services/macroPilot/assistantProvenance';
        import {buildAssistantChatCompletionProviderItem} from './src/services/ai/chatCompletionsCodec';
        const stored=new Map();
        const text='A short answer available on the other computer.';
        const items=[buildAssistantChatCompletionProviderItem({visibleContent:text,apiContent:text,reasoningContent:'',reasoningDetails:[],toolCalls:[]})];
        await assistantProvenance({load:async k=>stored.get(k)??null,compareAndSwap:async(k,o,v)=>{stored.set(k,v);return true;}})
          .recordFinal('assistant',text,items);
        console.log(JSON.stringify({receipts:[...stored],items}));
    "#]).current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).output().await.unwrap();
    assert!(provenance.status.success(),"{}",String::from_utf8_lossy(&provenance.stderr));
    let response:serde_json::Value=serde_json::from_slice(&provenance.stdout).unwrap();
    let receipts:Vec<(String,String)>=serde_json::from_value(response["receipts"].clone()).unwrap();
    sqlx::raw_sql("INSERT INTO e_inactive_domain VALUES(1,16777216,64); INSERT INTO conversations(id,title,scope_mode,provider_id,model_id,created_at,updated_at) VALUES('chat','Local transfer','Chat','macro-ai','synthetic-model','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); INSERT INTO messages(id,conversation_id,role,content,created_at,context_refs_json) VALUES('user','chat','user','Can I continue on another computer?','2026-01-01T00:00:00Z','[]');")
        .execute(&source_pool).await.unwrap();
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,context_refs_json,completion_reason,provider_input_items_json) VALUES('assistant','chat','assistant',?,'2026-01-01T00:00:01Z','[]','final',?)")
        .bind(content).bind(response["items"].to_string()).execute(&source_pool).await.unwrap();
    for(key,value)in receipts {crate::db::repository::set_app_setting(&source_pool,&key,&value).await.unwrap();}
    let manager=Arc::new(Manager::new(Arc::new(Fake::default())));
    let a=&seed["a"];
    let text=|v:&serde_json::Value|v.as_str().unwrap().to_string();
    let context=PilotVaultContext{configuration_id:"config:local-transfer".into(),relay_origin:text(&seed["origin"]),owner_id:text(&a["session_id"])};
    let generation=manager.activate(context.clone(),None).unwrap().generation;
    for(kind,id,value)in[(PilotSecretKind::SessionToken,context.owner_id.clone(),text(&a["token"])),
        (PilotSecretKind::InstanceKey,text(&a["creation"]),text(&a["key"]))]{
        manager.write(&PilotSecretScope{configuration_id:context.configuration_id.clone(),relay_origin:context.relay_origin.clone(),kind,resource_id:id},&generation,&value).unwrap();
    }
    let runtime=crate::connect::TransferRuntime::default();
    let launcher=runtime.source_launcher(&executable("bun"),&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts"),&source).unwrap();
    let ready=source.wait_until_ready_context().await.unwrap();
    let cancel=CancellationToken::new();
    let intent=Intent{context,generation,instance_creation_id:text(&a["creation"]),account_id:Some(text(&seed["account_id"])),device_id:Some(text(&a["device_id"])),scope:Scope::Producer{instance_id:text(&a["instance"])}};
    let mut verified=transport::bootstrap_owned(manager.clone(),intent,&runtime,&launcher,&ready,address,true,&cancel).await.unwrap();
    verified.controller_for(manager.clone(),&ready,seed["b"]["instance"].as_str().unwrap()).await.unwrap();
    let authority=&verified.authority;
    let binding=serde_json::json!({"transfer_id":uuid::Uuid::new_v4(),"provenance":{
        "source":{"relay_origin":seed["origin"],"account_id":seed["account_id"],"source_instance_id":a["instance"],"source_conversation_id":"chat"},
        "lineage_id":uuid::Uuid::new_v4(),"installation_id":uuid::Uuid::new_v4(),"birth_generation":authority["recovery_generation"]},
        "epoch":"1","target_instance_id":seed["b"]["instance"],"relay_recovery_generation":authority["recovery_generation"],
        "initiator":authority["actor"],"source_producer_generation":authority["source_producer"]["generation"],"target_producer_generation":authority["target_producer"]["generation"]});
    let digest=|domain:&str,value:&serde_json::Value|{let mut h=Sha256::new();h.update(format!("macro-connect-{domain}-1\0"));h.update(serde_json::to_vec(value).unwrap());format!("{:x}",h.finalize())};
    let admission=crate::db::chat_admission::runtime::ChatAdmissionRuntime::default();
    admission.open_browser(source.clone(),"source-window","source-browser").await.unwrap();
    let inspection=admission.begin_reconciliation(&source,"source-window","source-browser","chat").await.unwrap();
    admission.complete_reconciliation(&source,"source-window","source-browser",&inspection,&crate::db::chat_admission::reconciliation::BrowserInspection{
        queue:vec![],unsaved:vec![],approvals:vec![],questions:vec![],drafts:vec![],steers:vec![]}).await.unwrap();
    let content_token=crate::db::conversation_content::conversation_content_version(&source_pool,"chat").await.unwrap();
    let revision:i64=sqlx::query_scalar("SELECT revision+1 FROM chat_admission_owners WHERE conversation_id='chat'").fetch_one(&source_pool).await.unwrap();
    let frozen=serde_json::json!({"format_version":"1","binding_digest":digest("transfer-binding",&binding),"ownership_revision":revision.to_string(),
        "content_incarnation":content_token.incarnation,"content_revision":content_token.revision,
        "sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&content_token).unwrap()))});
    let sent=serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.request","request_id":uuid::Uuid::new_v4(),"request":{
        "decision_contract":"transfer-decision-1","type":"decision_request","operation":"reserve","operation_id":uuid::Uuid::new_v4(),"expected_revision":"0",
        "transfer_id":binding["transfer_id"],"body":{"binding":binding,"frozen":frozen,"expected_ledger_revision":"1"}}});
    let verified=Arc::new(verified);
    let (reservation,_receipt)=crate::db::connect_transfer::reserve_verified_source(&source,&admission,"source-window","source-browser",&inspection,&verified,&sent).await.unwrap();
    let capture=crate::db::source_capture::SourceCapture::for_transfer(source.clone(),verified.clone(),reservation.transfer_id()).await.unwrap();
    let sealed=capture.capture_transfer(&reservation).await.unwrap();
    let config=crate::config::ConfigManager::initialize(directory.path().join("config")).await.unwrap();
    let normalized=launcher.normalize_capture(&config,&verified,&capture).await;
    let source_result=async {
        let job=normalized.as_ref().map_err(|e|*e)?;
        let manifest=reservation.source_manifest(&source,job).await.map_err(|_|"source_manifest")?;
        let source_path=format!("/pilot/v2/transfers/sources/{}/chat",a["instance"].as_str().unwrap());
        let wrap=|request:serde_json::Value|serde_json::json!({"transit_contract":"transfer-transit-1",
            "type":"decision.request","request_id":uuid::Uuid::new_v4(),"request":request});
        let birth=wrap(serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request",
            "operation":"lineage.create","operation_id":uuid::Uuid::new_v4(),"expected_revision":"0",
            "body":{"provenance":binding["provenance"],"mode":"initial_existing","creation_digest":frozen["sha256"]}}));
        let born=verified.source_decision(manager.clone(),&ready,&source,&reservation,job,&(source_path.clone()+"/decisions"),
            birth,serde_json::Value::Null,"lineage_enrolled").await?;
        drop(born);
        let expected=serde_json::json!({"binding":binding,"frozen":frozen,"manifest":null,"prepared":null,"terminal":null});
        let reserve_path=format!("{source_path}/targets/{}/reservations/{}/decisions",seed["b"]["instance"].as_str().unwrap(),reservation.transfer_id());
        let reserved=verified.source_decision(manager.clone(),&ready,&source,&reservation,job,&reserve_path,
            sent.clone(),expected.clone(),"source_frozen").await?;
        let reserved_reply:serde_json::Value=serde_json::from_slice(reserved.bytes.as_slice()).map_err(|_|"reserve_reply")?;
        if reserved_reply["result"]["status"]["phase"]!="reserved" {return Err("reserve_reply");}
        drop(reserved);
        let seal=wrap(serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request",
            "operation":"seal","operation_id":uuid::Uuid::new_v4(),"expected_revision":"1","transfer_id":reservation.transfer_id(),
            "body":{"manifest":manifest}}));
        let mut expected=expected;expected["manifest"]=manifest.clone();
        let known=format!("/pilot/v2/transfers/known/{}/decisions",reservation.transfer_id());
        let sealed_reply=verified.source_decision(manager.clone(),&ready,&source,&reservation,job,&known,
            seal,expected,"source_sealed").await?;
        let value:serde_json::Value=serde_json::from_slice(sealed_reply.bytes.as_slice()).map_err(|_|"seal_reply")?;
        if value["result"]["status"]["phase"]!="sealed" {return Err("seal_reply");}
        drop(sealed_reply);
        let (descriptor,archive)=job.normalized_for(&sealed.manifest)?;
        let session=serde_json::json!({"transfer_id":reservation.transfer_id(),"transit_id":uuid::Uuid::new_v4(),
            "binding_digest":digest("transfer-binding",&binding),"frozen_digest":digest("frozen",&frozen),
            "manifest_digest":digest("manifest",&manifest),"content_contract_sha256":descriptor["content_contract_sha256"],
            "portable_records":descriptor["records"].as_u64().unwrap().to_string(),
            "portable_fragments":archive.as_slice().split(|b|*b==b'\n').filter(|line|!line.is_empty()).count().saturating_sub(1).to_string(),
            "portable_payload_bytes":descriptor["bytes"].as_u64().unwrap().to_string(),"stream_bytes":archive.as_slice().len().to_string()});
        let opened=verified.transit(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/transit",reservation.transfer_id()),
            serde_json::json!({"transit_contract":"transfer-transit-1","type":"transit.open","request_id":uuid::Uuid::new_v4(),"session":session}),&session).await?
            .ok_or("transit_open_missing")?;
        let opened_value:serde_json::Value=serde_json::from_slice(opened.bytes.as_slice()).map_err(|_|"transit_open_reply")?;
        drop(opened);let opened=opened_value;
        if opened["session"]!=session || opened["cursor"]["next_offset"]!="0"{return Err("transit_open_reply");}
        let mut child=tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","commands::pilot_secrets::tests::global_chat_transfer_target","--ignored","--nocapture","--test-threads=1"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
        let mut input=child.stdin.take().unwrap();
        let mut initialization=serde_json::to_vec(&serde_json::json!({"seed":seed,"session":session,"sent":sent,"manifest":manifest,
            "database":directory.path().join("target.db")})).unwrap();initialization.push(b'\n');
        input.write_all(&initialization).await.unwrap();
        let mut target_events=BufReader::new(child.stdout.take().unwrap()).lines();
        let root=format!("/pilot/v2/transfers/transits/{}",session["transit_id"].as_str().unwrap());
        let mut offset=0usize;let mut sequence=0u64;
        while offset<archive.as_slice().len() {
            let delivery=verified.delivery(manager.clone(),&ready).await?;
            let pull:serde_json::Value=serde_json::from_slice(delivery.bytes.as_slice()).map_err(|_|"transit_pull")?;drop(delivery);
            let message=&pull["value"]["body"]["message"];
            if pull["branch"]!="transit" || pull["value"]["body"]["kind"]!="transit.pull" || message["transfer_id"]!=session["transfer_id"]
                || message["transit_id"]!=session["transit_id"] || message["offset"]!=offset.to_string() || message["sequence"]!=sequence.to_string()
            {return Err("transit_pull");}
            let end=(offset+65_536).min(archive.as_slice().len());
            let bytes=&archive.as_slice()[offset..end];
            let chunk=serde_json::json!({"transit_contract":"transfer-transit-1","type":"transit.chunk","request_id":uuid::Uuid::new_v4(),
                "transfer_id":session["transfer_id"],"transit_id":session["transit_id"],"sequence":sequence.to_string(),"offset":offset.to_string(),
                "length":bytes.len().to_string(),"sha256":format!("{:x}",Sha256::digest(bytes)),"eof":end==archive.as_slice().len(),
                "data_utf8":std::str::from_utf8(bytes).map_err(|_|"transit_utf8")?});
            verified.transit(manager.clone(),&ready,&(root.clone()+"/chunk"),chunk,&session).await?;
            offset=end;sequence+=1;
        }
        let event=transfer_target_event(&mut target_events).await?;
        if event["type"]!="prepared"{return Err("target_preparation_event");}
        let progress=verified.transit(manager.clone(),&ready,&(root.clone()+"/status"),serde_json::json!({"transit_contract":"transfer-transit-1",
            "type":"transit.status","request_id":uuid::Uuid::new_v4(),"transfer_id":session["transfer_id"],"transit_id":session["transit_id"]}),&session)
            .await?.ok_or("transit_progress")?;
        let progress_value:serde_json::Value=serde_json::from_slice(progress.bytes.as_slice()).map_err(|_|"transit_progress")?;drop(progress);let progress=progress_value;
        if progress["cursor"]["next_offset"]!=archive.as_slice().len().to_string() || progress["cursor"]["eof"]!=true {return Err("transit_progress");}
        let request=event["request"].clone();let expected=event["expected"].clone();
        let producer=&verified.authority["target_producer"];
        for key in ["instance_id","connection_id"]{if expected[key]!=producer[key]{return Err("target_scope_mismatch");}}
        if expected["producer_generation"]!=producer["generation"] || expected["binding_digest"]!=manifest["binding_digest"]
            || expected["prior_receipt_digest"]!=digest("manifest",&manifest) || request["transfer_id"]!=reservation.transfer_id()
        {return Err("target_scope_mismatch");}
        let challenge=serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.challenge","request_id":uuid::Uuid::new_v4(),"kind":"target_pinned","request":request});
        let reply=verified.metadata(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/challenges",reservation.transfer_id()),challenge.clone(),
            serde_json::json!({"kind":"challenge","sent":challenge,"exchange":expected})).await?;drop(reply);
        if transfer_target_event(&mut target_events).await?["type"]!="attested"{return Err("target_proof_event");}
        let expected=serde_json::json!({"binding":binding,"frozen":frozen,"manifest":manifest,"prepared":request["body"]["prepared"],"terminal":null});
        let reply=verified.decision(manager.clone(),&ready,&known,wrap(request),expected.clone()).await?;
        let value:serde_json::Value=serde_json::from_slice(reply.bytes.as_slice()).map_err(|_|"ready_reply")?;drop(reply);
        if value["result"]["status"]["phase"]!="target_ready"{return Err("ready_reply");}
        let ready_digest=value["result"]["receipt"]["subject_digest"].clone();
        let commit=wrap(serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":"commit",
            "operation_id":uuid::Uuid::new_v4(),"expected_revision":"3","transfer_id":reservation.transfer_id(),"body":{}}));
        let mut command=serde_json::to_vec(&commit["request"]).unwrap();command.push(b'\n');input.write_all(&command).await.unwrap();
        let event=transfer_target_event(&mut target_events).await?;
        let maintained=&event["expected"];
        if event["type"]!="maintained" || maintained["subject_digest"]!=ready_digest || maintained["prior_receipt_digest"]!=ready_digest
            || maintained["instance_id"]!=producer["instance_id"] || maintained["producer_generation"]!=producer["generation"]
            || maintained["connection_id"]!=producer["connection_id"] || maintained["binding_digest"]!=manifest["binding_digest"]
        {return Err("target_maintenance_scope");}
        let challenge=serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.challenge","request_id":uuid::Uuid::new_v4(),
            "kind":"target_maintained","request":commit["request"]});
        let reply=verified.metadata(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/challenges",reservation.transfer_id()),challenge.clone(),
            serde_json::json!({"kind":"challenge","sent":challenge,"exchange":maintained})).await?;drop(reply);
        if transfer_target_event(&mut target_events).await?["type"]!="maintained_attested"{return Err("target_maintenance_event");}
        let committed=verified.source_decision(manager.clone(),&ready,&source,&reservation,job,&known,commit,expected,"source_maintained").await?;
        let value:serde_json::Value=serde_json::from_slice(committed.bytes.as_slice()).map_err(|_|"commit_reply")?;drop(committed);
        if value["result"]["status"]["phase"]!="committed"{return Err("commit_reply");}
        assert_eq!(verified.committed_terminal(reservation.transfer_id()).await?["outcome"],"committed");
        input.write_all(b"{\"publish\":true}\n").await.unwrap();
        let published=transfer_target_event(&mut target_events).await?;
        if published["type"]!="published"{return Err("target_publication_event");}
        assert!(reservation.apply_committed_source(&source,job).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='chat'").fetch_one(&source_pool).await.unwrap(),"frozen");
        let request=published["request"].clone();let activation=&request["body"]["activation"];
        let expected=published["expected"].clone();
        let terminal=verified.committed_terminal(reservation.transfer_id()).await?;
        if activation["terminal_digest"]!=digest("terminal",&terminal) || activation["target_conversation_id"]!=terminal["prepared"]["target_conversation_id"]
            || expected["subject_digest"]!=digest("activation",activation) || expected["prior_receipt_digest"]!=digest("terminal",&terminal)
            || expected["instance_id"]!=producer["instance_id"] || expected["producer_generation"]!=producer["generation"] || expected["connection_id"]!=producer["connection_id"]
        {return Err("target_activation_scope");}
        let challenge=serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.challenge","request_id":uuid::Uuid::new_v4(),"kind":"target_activated","request":request});
        let reply=verified.metadata(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/challenges",reservation.transfer_id()),challenge.clone(),
            serde_json::json!({"kind":"challenge","sent":challenge,"exchange":expected})).await?;drop(reply);
        if transfer_target_event(&mut target_events).await?["type"]!="activation_attested"{return Err("target_activation_event");}
        let expected=serde_json::json!({"binding":binding,"frozen":frozen,"manifest":manifest,"prepared":terminal["prepared"],"terminal":terminal});
        let acknowledged=verified.decision(manager.clone(),&ready,&known,wrap(request),expected).await?;drop(acknowledged);
        reservation.apply_committed_source(&source,job).await.map_err(|_|"source_application")?;
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='chat'").fetch_one(&source_pool).await.unwrap(),"ceded");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM messages WHERE conversation_id='chat'").fetch_one(&source_pool).await.unwrap(),2);
        input.write_all(b"{\"stop\":true}\n").await.unwrap();drop(input);
        let child=child.wait_with_output().await.unwrap();
        if !child.status.success(){eprintln!("{} {}",String::from_utf8_lossy(&child.stdout),String::from_utf8_lossy(&child.stderr));return Err("target_instance_failed");}
        Ok::<_,&'static str>(())
    }.await;
    // Cleanup is explicit even while the target half of this scenario is red.
    drop(capture);drop(reservation);
    let verified=Arc::try_unwrap(verified).ok().unwrap();verified.close().await.unwrap();
    assert!(runtime.shutdown().await);
    relay_input.write_all(b"{\"stop\":true}\n").await.unwrap();drop(relay_input);
    assert!(relay.wait().await.unwrap().success());
    source_result.unwrap();
    let normalized=normalized.unwrap();
    let (descriptor,archive)=normalized.normalized_for(&sealed.manifest).unwrap();
    assert_eq!(descriptor["kind"],"portable_archive");
    assert!(std::str::from_utf8(archive.as_slice()).unwrap().contains("portable_archive"));
    // Both ordinary target publication and acknowledged source cession passed.
}

#[tokio::test]
#[ignore="target process of the local Global Chat scenario"]
async fn global_chat_transfer_target() {
    use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};
    use transport::{Intent,Scope};
    let mut input=BufReader::new(tokio::io::stdin()).lines();
    let data:serde_json::Value=serde_json::from_str(&input.next_line().await.unwrap().unwrap()).unwrap();
    let seed=&data["seed"];let b=&seed["b"];let session=&data["session"];
    let text=|v:&serde_json::Value|v.as_str().unwrap().to_owned();
    let owner=crate::core::db_state::DbPool::default();
    let pool=crate::db::create_pool(std::path::Path::new(data["database"].as_str().unwrap())).await.unwrap();
    owner.set_ready(pool.clone()).await.unwrap();
    sqlx::query("INSERT INTO e_inactive_domain VALUES(1,16777216,64)").execute(&pool).await.unwrap();
    let manager=Arc::new(Manager::new(Arc::new(Fake::default())));
    let context=PilotVaultContext{configuration_id:"config:local-target".into(),relay_origin:text(&seed["origin"]),owner_id:text(&b["session_id"])};
    let generation=manager.activate(context.clone(),None).unwrap().generation;
    for(kind,id,value)in[(PilotSecretKind::SessionToken,context.owner_id.clone(),text(&b["token"])),(PilotSecretKind::InstanceKey,text(&b["creation"]),text(&b["key"]))]{
        manager.write(&PilotSecretScope{configuration_id:context.configuration_id.clone(),relay_origin:context.relay_origin.clone(),kind,resource_id:id},&generation,&value).unwrap();
    }
    let bun=std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|p|p.join("bun")).find(|p|p.is_file()).unwrap();
    let runtime=crate::connect::TransferRuntime::default();
    let launcher=runtime.source_launcher(&bun,&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../copilot-bridge/src/entry.ts"),&owner).unwrap();
    let ready=owner.wait_until_ready_context().await.unwrap();
    let verified=Arc::new(transport::bootstrap_owned(manager.clone(),Intent{context,generation,instance_creation_id:text(&b["creation"]),
        account_id:Some(text(&seed["account_id"])),device_id:Some(text(&b["device_id"])),scope:Scope::Producer{instance_id:text(&b["instance"])}},
        &runtime,&launcher,&ready,format!("127.0.0.1:{}",seed["port"].as_u64().unwrap()).parse().unwrap(),true,&tokio_util::sync::CancellationToken::new()).await.unwrap());
    let opened=verified.transit(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/transit",session["transfer_id"].as_str().unwrap()),
        serde_json::json!({"transit_contract":"transfer-transit-1","type":"transit.open","request_id":uuid::Uuid::new_v4(),"session":session}),session).await.unwrap();drop(opened);
    let mut reservation=crate::db::connect_transfer::reserve_verified_target(&owner,&verified,&data["sent"],&data["manifest"]).await.unwrap();
    let root=format!("/pilot/v2/transfers/transits/{}",session["transit_id"].as_str().unwrap());
    let mut sequence=0i64;let mut offset=0i64;
    loop {
        let pull=serde_json::json!({"transit_contract":"transfer-transit-1","type":"transit.pull","request_id":uuid::Uuid::new_v4(),
            "transfer_id":session["transfer_id"],"transit_id":session["transit_id"],"sequence":sequence.to_string(),"offset":offset.to_string()});
        verified.transit(manager.clone(),&ready,&(root.clone()+"/pull"),pull,session).await.unwrap();
        let received=verified.delivery(manager.clone(),&ready).await.unwrap();
        let delivery:serde_json::Value=serde_json::from_slice(received.bytes.as_slice()).unwrap();drop(received);
        assert_eq!(delivery["branch"],"transit");assert_eq!(delivery["value"]["body"]["kind"],"transit.chunk");
        let chunk=&delivery["value"]["body"]["message"];
        let committed=reservation.stage_target(&owner,&data["sent"],&data["manifest"],chunk).await.unwrap();
        let mut ack=chunk.clone();ack.as_object_mut().unwrap().remove("data_utf8");ack["type"]=serde_json::json!("transit.ack");
        ack["request_id"]=serde_json::json!(uuid::Uuid::new_v4());ack["next_offset"]=serde_json::json!(committed.1.to_string());
        let progress=verified.transit(manager.clone(),&ready,&(root.clone()+"/ack"),ack,session).await.unwrap();drop(progress);
        (sequence,offset)=(committed.0,committed.1);if committed.2{break;}
    }
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT SUM(length(data)) FROM connect_raw_chunks").fetch_one(&pool).await.unwrap().to_string(),session["stream_bytes"]);
    let archive=reservation.staged_target(&owner,&data["sent"],&data["manifest"]).await.unwrap();
    let descriptor:serde_json::Value=serde_json::from_slice(archive.split(|b|*b==b'\n').next().unwrap()).unwrap();
    let storage=crate::db::inactive_storage::InactiveStorage::for_transfer(&owner,verified.clone(),data["sent"].clone(),data["manifest"].clone()).await.unwrap();
    let config_directory=tempfile::tempdir().unwrap();
    let config=crate::config::ConfigManager::initialize(config_directory.path().to_path_buf()).await.unwrap();
    let imported=launcher.import_archive(&config,&verified,&storage,&archive,&descriptor).await;
    let attached=if let Ok(imported)=&imported {reservation.attach_imported_target(&owner,&data["sent"],&data["manifest"],imported).await}else{Ok(())};
    let mut prepared=if let Ok(imported)=&imported {
        crate::db::repository::upsert_provider_config_by_id(&pool,"macro-ai","Synthetic Macro AI","openai","https://provider.example.invalid/v1",true).await.unwrap();
        let model:crate::db::models::ProviderModelInput=serde_json::from_value(serde_json::json!({"model_id":"macro-ai","name":"Synthetic Macro AI",
            "context_window_tokens":200000,"input_limit_tokens":200000,"output_limit_tokens":16384,"context_window_source":"manual"})).unwrap();
        crate::db::repository::upsert_provider_models(&pool,"macro-ai",&[model]).await.unwrap();
        launcher.prepare_archive(&config,&verified,&storage,imported,"macro-ai","macro-ai").await
    }else{Err("transfer_import_missing")};
    let pinned=if let (Ok(imported),Ok(prepared))=(&imported,&mut prepared) {
        reservation.pin_target(&owner,&config,imported,prepared,&data["sent"],&data["manifest"]).await
    }else{Ok(())};
    if pinned.is_ok() && prepared.is_ok() {
        assert_eq!(reservation.target_prepared().await.unwrap()["target_conversation_id"],prepared.as_ref().unwrap().native_prepared().unwrap().1.conversation_id.as_ref().unwrap().as_str());
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT phase FROM connect_preparations").fetch_one(&pool).await.unwrap(),"pinned");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversations").fetch_one(&pool).await.unwrap(),0);
        assert_ne!(reservation.target_prepared().await.unwrap()["lineage_id"],data["sent"]["request"]["body"]["binding"]["provenance"]["lineage_id"]);
        let ready_intent=serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":"ready",
            "operation_id":uuid::Uuid::new_v4(),"expected_revision":"2","transfer_id":session["transfer_id"],"body":{"prepared":reservation.target_prepared().await.unwrap()}});
        let expected=reservation.target_expectation(&owner,&config,prepared.as_ref().unwrap(),&ready_intent,"target_pinned").await.unwrap();
        assert_eq!(expected["instance_id"],b["instance"]);assert_eq!(expected["kind"],"target_pinned");
        assert!(reservation.target_expectation(&owner,&config,prepared.as_ref().unwrap(),&serde_json::json!({}),"target_pinned").await.is_err());
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"prepared","request":ready_intent,"expected":expected}));
        let delivery=verified.delivery(manager.clone(),&ready).await.unwrap();
        verified.attest_target(manager.clone(),&ready,&owner,&reservation,&config,prepared.as_ref().unwrap(),delivery).await.unwrap();
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"attested"}));
        let commit:serde_json::Value=serde_json::from_str(&input.next_line().await.unwrap().unwrap()).unwrap();
        let expected=reservation.target_expectation(&owner,&config,prepared.as_ref().unwrap(),&commit,"target_maintained").await.unwrap();
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"maintained","expected":expected}));
        let delivery=verified.delivery(manager.clone(),&ready).await.unwrap();
        verified.attest_target(manager.clone(),&ready,&owner,&reservation,&config,prepared.as_ref().unwrap(),delivery).await.unwrap();
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"maintained_attested"}));
        let publish:serde_json::Value=serde_json::from_str(&input.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(publish["publish"],true);
        let binding=&data["sent"]["request"]["body"]["binding"];let frozen=&data["sent"]["request"]["body"]["frozen"];
        let request=serde_json::json!({"transit_contract":"transfer-transit-1","type":"decision.request","request_id":uuid::Uuid::new_v4(),
            "request":{"decision_contract":"transfer-decision-1","type":"decision_request","operation":"reconcile","operation_id":uuid::Uuid::new_v4(),
                "expected_revision":"0","transfer_id":session["transfer_id"],"body":{"binding":binding,"frozen":frozen,"expected_ledger_revision":"1","action":"status"}}});
        let expected=serde_json::json!({"binding":binding,"frozen":frozen,"manifest":data["manifest"],"prepared":reservation.target_prepared().await.unwrap(),"terminal":null});
        let reply=verified.decision(manager.clone(),&ready,&format!("/pilot/v2/transfers/known/{}/decisions",session["transfer_id"].as_str().unwrap()),request,expected).await.unwrap();drop(reply);
        let conversation=reservation.publish_target(&owner,&config,prepared.as_ref().unwrap()).await.unwrap();
        let messages:Vec<String>=sqlx::query_scalar("SELECT content FROM messages WHERE conversation_id=? ORDER BY created_at,id").bind(&conversation).fetch_all(&pool).await.unwrap();
        assert_eq!(messages.len(),2);assert!(messages.iter().any(|s|s.contains("Can I continue on another computer?")));
        assert!(messages.iter().any(|s|s.contains("A short answer available on the other computer.")));
        assert!(messages.iter().all(|s|s=="Can I continue on another computer?" || s=="A short answer available on the other computer."));
        // Exercise the same historical-message renderer used by ChatZone with
        // the ordinary published rows, rather than displaying archive JSON.
        let mut renderer=tokio::process::Command::new(std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|p|p.join("bun")).find(|p|p.is_file()).unwrap())
            .args(["-e",r#"
                import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
                import {createInstance} from 'i18next';import {I18nextProvider} from 'react-i18next';
                import {HistoricalMessageContent} from './src/components/chat/HistoricalMessageContent';
                const i18n=createInstance();await i18n.init({lng:'en',resources:{en:{translation:{}}},initImmediate:false});
                const messages=JSON.parse(await Bun.stdin.text());
                console.log(renderToStaticMarkup(React.createElement(I18nextProvider,{i18n},messages.map((content,i)=>React.createElement(HistoricalMessageContent,{key:i,content,date:'2026-01-01T00:00:00Z'})))));
            "#]).current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        renderer.stdin.take().unwrap().write_all(&serde_json::to_vec(&messages).unwrap()).await.unwrap();
        let rendered=renderer.wait_with_output().await.unwrap();assert!(rendered.status.success(),"{}",String::from_utf8_lossy(&rendered.stderr));
        let html=String::from_utf8(rendered.stdout).unwrap();assert!(html.contains("data-chat-historical-message"));
        for message in &messages{assert!(html.contains(message));}assert!(!html.contains(&conversation));assert!(!html.contains("portable_archive"));
        let mut next=prepared.as_ref().unwrap().native_prepared().unwrap().1.clone();
        next.messages.push(serde_json::from_value(serde_json::json!({"role":"user","content":"Continue from this history."})).unwrap());
        let (provider,_,_,_)=crate::connect::runtime::transfer_target_snapshot(&config,&ready,"macro-ai","macro-ai").await.unwrap();
        let next_body=crate::ai::openai_compatible::build_transfer_request(&next,&provider).unwrap();
        assert_eq!(next_body["messages"].as_array().unwrap().last().unwrap()["content"],"Continue from this history.");
        for message in &messages{assert!(next_body.to_string().contains(message));}
        assert!(reservation.publish_target(&owner,&config,prepared.as_ref().unwrap()).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversations").fetch_one(&pool).await.unwrap(),1);
        let activation=reservation.target_activation().unwrap();
        let request=serde_json::json!({"decision_contract":"transfer-decision-1","type":"decision_request","operation":"activation.record",
            "operation_id":uuid::Uuid::new_v4(),"expected_revision":"4","transfer_id":session["transfer_id"],"body":{"activation":activation}});
        let expected=reservation.target_expectation(&owner,&config,prepared.as_ref().unwrap(),&request,"target_activated").await.unwrap();
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"published","conversation":conversation,"request":request,"expected":expected}));
        let delivery=verified.delivery(manager.clone(),&ready).await.unwrap();
        verified.attest_target(manager.clone(),&ready,&owner,&reservation,&config,prepared.as_ref().unwrap(),delivery).await.unwrap();
        println!("SLICE_TARGET_EVENT:{}",serde_json::json!({"type":"activation_attested"}));
        let stop:serde_json::Value=serde_json::from_str(&input.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(stop["stop"],true);
    }
    drop(storage);drop(reservation);
    Arc::try_unwrap(verified).ok().unwrap().close().await.unwrap();assert!(runtime.shutdown().await);
    assert_eq!(imported.unwrap().imported_storage().unwrap().receipt.phase,crate::db::inactive_storage::Phase::SealedStorage);
    attached.unwrap();pinned.unwrap();
    let prepared=prepared.unwrap();let (_,request,body,_)=prepared.native_prepared().unwrap();
    assert_eq!(request.provider_id,"macro-ai");assert_eq!(body["chat_template_kwargs"]["enable_thinking"],true);
    let serialized=body.to_string();assert!(serialized.contains("Can I continue on another computer?"));
    assert!(serialized.contains("A short answer available on the other computer."));
}
