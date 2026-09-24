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
    gate: Mutex<Option<ReadGate>>,
}
impl Vault for Arc<Fake> {
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
    let detached = manager.invalidate(Some(&generation)).unwrap();
    assert_ne!(detached.generation, generation);
    let next = manager.activate(context(), None).unwrap();
    fake.values.lock().unwrap().clear();
    release.send(()).unwrap();
    assert_eq!(task.join().unwrap(), Err(PilotSecretError::ContextChanged));
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
    let invalidated = manager.invalidate(Some(&generation)).unwrap();
    assert_ne!(invalidated.generation, in_flight.generation);
    release.send(()).unwrap();
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
    manager.invalidate(Some(&generation)).unwrap();
    release_tx.send(()).unwrap();
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
