//! Private native allocation policy. No IPC command or public transfer is enabled.
//! Owners must retain each charge until the corresponding buffers and I/O are joined.
#![allow(dead_code)] // Private prerequisite; the transfer owner is composed separately.

use crate::config::{ConfigDocumentKind, ConfigManager, ConnectTransferResources};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
const MIN_WORKING: u64 = 64 * MIB;
const SAMPLE_TTL: Duration = Duration::from_secs(5);
pub(crate) const SQLITE_TRANSACTION_MARGIN: u64 = 16 * MIB;
pub(crate) const TRANSIT_INSTANCE_LIMIT: u64 = 32 * MIB;
pub(crate) const TRANSIT_PROCESS_LIMIT: u64 = 64 * MIB;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResourceError {
    PolicyUnavailable,
    MeasurementUnavailable,
    ResourceLimit,
    Busy,
}

pub(crate) async fn configured(
    manager: &ConfigManager,
) -> Result<ConnectTransferResources, ResourceError> {
    manager
        .with_effective_user_document(ConfigDocumentKind::Settings, parse_policy)
        .await
}

fn parse_policy(settings: &serde_json::Value) -> Result<ConnectTransferResources, ResourceError> {
    let policy: ConnectTransferResources = serde_json::from_value(
        settings
            .get("connectTransferResources")
            .cloned()
            .ok_or(ResourceError::PolicyUnavailable)?,
    )
    .map_err(|_| ResourceError::PolicyUnavailable)?;
    if !policy.valid() {
        return Err(ResourceError::PolicyUnavailable);
    }
    Ok(policy)
}

/// Admission is advisory about OS pressure. It does not promise a process RSS bound.
fn working_budget(
    policy: &ConnectTransferResources,
    total: u64,
    available: u64,
) -> Result<u64, ResourceError> {
    if !policy.valid() {
        return Err(ResourceError::PolicyUnavailable);
    }
    if total == 0 || available > total {
        return Err(ResourceError::MeasurementUnavailable);
    }
    let bytes = (u64::from(policy.working_ceiling_mi_b) * MIB)
        .min(total / 16)
        .min(available.saturating_sub(256 * MIB) / 4);
    let bytes = bytes / MIB * MIB;
    if bytes < MIN_WORKING {
        return Err(ResourceError::ResourceLimit);
    }
    Ok(bytes)
}

/// Logical growth remaining after the durable domain's existing retained charge.
/// A lowered ceiling preserves existing pins and only refuses additional growth.
fn disk_headroom(
    policy: &ConnectTransferResources,
    total: u64,
    available: u64,
    retained: u64,
) -> Result<u64, ResourceError> {
    if !policy.valid() {
        return Err(ResourceError::PolicyUnavailable);
    }
    if total == 0 || available > total {
        return Err(ResourceError::MeasurementUnavailable);
    }
    let reserve = (u64::from(policy.disk_floor_mi_b) * MIB).max((8 * 1024 * MIB).min(total / 20));
    Ok((u64::from(policy.retained_ceiling_mi_b) * MIB)
        .saturating_sub(retained)
        .min(available.saturating_sub(reserve) / 4))
}

pub(crate) fn native_disk_headroom(
    policy: &ConnectTransferResources,
    directory: &Path,
    retained: u64,
) -> Result<u64, ResourceError> {
    let total = fs2::total_space(directory).map_err(|_| ResourceError::MeasurementUnavailable)?;
    let available =
        fs2::available_space(directory).map_err(|_| ResourceError::MeasurementUnavailable)?;
    disk_headroom(policy, total, available, retained)
}

/// Reserve physical SQLite growth separately from logical retained bytes.
/// This margin is conservative accounting, not a formal SQLite page/WAL bound.
pub(crate) fn sqlite_growth_charge(new_data_and_metadata: u64) -> Result<u64, ResourceError> {
    new_data_and_metadata
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(SQLITE_TRANSACTION_MARGIN))
        .ok_or(ResourceError::ResourceLimit)
}

#[cfg_attr(test, derive(Default))]
pub(crate) struct WorkingOwner(Mutex<Weak<WorkingState>>);
pub(crate) static WORKING_OWNER: LazyLock<WorkingOwner> =
    LazyLock::new(|| WorkingOwner(Mutex::new(Weak::new())));
enum PolicySource {
    Live(ConfigManager),
    #[cfg(test)]
    Fixed(ConnectTransferResources),
}
impl PolicySource {
    async fn with_current<T>(
        &self,
        operation: impl FnOnce(&ConnectTransferResources) -> Result<T, ResourceError>,
    ) -> Result<T, ResourceError> {
        match self {
            Self::Live(manager) => {
                manager
                    .with_effective_user_document(ConfigDocumentKind::Settings, |document| {
                        operation(&parse_policy(document)?)
                    })
                    .await
            }
            #[cfg(test)]
            Self::Fixed(policy) => operation(policy),
        }
    }
}
struct WorkingState {
    ceiling: u64,
    policy: PolicySource,
    allocation: Mutex<Allocation>,
}
struct Allocation {
    charged: u64,
    available_budget: u64,
    sampled: Instant,
}
pub(crate) struct WorkingLease(Arc<WorkingState>);
pub(crate) struct WorkingCharge {
    state: Arc<WorkingState>,
    bytes: u64,
}
impl WorkingOwner {
    pub(crate) async fn admit(
        &self,
        manager: &ConfigManager,
    ) -> Result<WorkingLease, ResourceError> {
        manager
            .with_effective_user_document(ConfigDocumentKind::Settings, |document| {
                self.admit_measured(
                    &parse_policy(document)?,
                    PolicySource::Live(manager.clone()),
                    crate::host_telemetry::available_memory()
                        .map_err(|_| ResourceError::MeasurementUnavailable)?,
                    Instant::now(),
                )
            })
            .await
    }
    #[cfg(test)]
    fn admit_with(
        &self,
        policy: ConnectTransferResources,
        memory: (u64, u64),
        now: Instant,
    ) -> Result<WorkingLease, ResourceError> {
        self.admit_measured(&policy.clone(), PolicySource::Fixed(policy), memory, now)
    }
    fn admit_measured(
        &self,
        policy: &ConnectTransferResources,
        source: PolicySource,
        memory: (u64, u64),
        now: Instant,
    ) -> Result<WorkingLease, ResourceError> {
        let mut owner = self.0.lock().map_err(|_| ResourceError::ResourceLimit)?;
        if owner.upgrade().is_some() {
            return Err(ResourceError::Busy);
        }
        let ceiling = working_budget(policy, memory.0, memory.1)?;
        let state = Arc::new(WorkingState {
            ceiling,
            policy: source,
            allocation: Mutex::new(Allocation {
                charged: 0,
                available_budget: ceiling,
                sampled: now,
            }),
        });
        *owner = Arc::downgrade(&state);
        Ok(WorkingLease(state))
    }
}
impl WorkingLease {
    /// Call at a heavy-phase boundary. During paging, reserve also refreshes RAM at 5 s.
    pub(crate) async fn before_phase(&self) -> Result<(), ResourceError> {
        self.0
            .policy
            .with_current(|policy| {
                let mut allocation = self
                    .0
                    .allocation
                    .lock()
                    .map_err(|_| ResourceError::ResourceLimit)?;
                self.refresh(
                    &mut allocation,
                    policy,
                    crate::host_telemetry::available_memory()
                        .map_err(|_| ResourceError::MeasurementUnavailable),
                    Instant::now(),
                )
            })
            .await
    }
    fn refresh(
        &self,
        allocation: &mut Allocation,
        policy: &ConnectTransferResources,
        memory: Result<(u64, u64), ResourceError>,
        now: Instant,
    ) -> Result<(), ResourceError> {
        allocation.available_budget = 0;
        let (total, available) = memory?;
        allocation.available_budget = working_budget(policy, total, available)?.min(self.0.ceiling);
        allocation.sampled = now;
        if allocation.charged > allocation.available_budget {
            return Err(ResourceError::ResourceLimit);
        }
        Ok(())
    }
    /// Every charge revalidates the approved live ceiling, even inside the RAM TTL.
    /// The ConfigManager read guard covers both the policy check and charge update.
    pub(crate) async fn reserve(&self, bytes: u64) -> Result<WorkingCharge, ResourceError> {
        self.0
            .policy
            .with_current(|policy| {
                self.reserve_under_policy(bytes, policy, Instant::now(), || {
                    crate::host_telemetry::available_memory()
                        .map_err(|_| ResourceError::MeasurementUnavailable)
                })
            })
            .await
    }
    #[cfg(test)]
    fn reserve_with(
        &self,
        bytes: u64,
        now: Instant,
        read: impl FnOnce() -> Result<(u64, u64), ResourceError>,
    ) -> Result<WorkingCharge, ResourceError> {
        let PolicySource::Fixed(policy) = &self.0.policy else {
            panic!("live policy requires its ConfigManager guard")
        };
        self.reserve_under_policy(bytes, policy, now, read)
    }
    fn reserve_under_policy(
        &self,
        bytes: u64,
        policy: &ConnectTransferResources,
        now: Instant,
        read: impl FnOnce() -> Result<(u64, u64), ResourceError>,
    ) -> Result<WorkingCharge, ResourceError> {
        let mut allocation = self
            .0
            .allocation
            .lock()
            .map_err(|_| ResourceError::ResourceLimit)?;
        if now.saturating_duration_since(allocation.sampled) >= SAMPLE_TTL {
            self.refresh(&mut allocation, policy, read(), now)?;
        }
        let charged = allocation
            .charged
            .checked_add(bytes)
            .ok_or(ResourceError::ResourceLimit)?;
        if charged
            > allocation
                .available_budget
                .min(u64::from(policy.working_ceiling_mi_b) * MIB)
        {
            return Err(ResourceError::ResourceLimit);
        }
        allocation.charged = charged;
        Ok(WorkingCharge {
            state: self.0.clone(),
            bytes,
        })
    }
}
impl Drop for WorkingCharge {
    fn drop(&mut self) {
        if let Ok(mut allocation) = self.state.allocation.lock() {
            allocation.charged -= self.bytes;
        }
    }
}

/// Common v2/F transit accounting. Cache/source limits remain separate domains.
#[derive(Default)]
struct TransitState {
    charged: u64,
    instances: std::collections::HashMap<uuid::Uuid, Weak<TransitInstanceState>>,
}
#[cfg_attr(test, derive(Default))]
pub(crate) struct TransitOwner(Arc<Mutex<TransitState>>);
pub(crate) static TRANSIT_OWNER: LazyLock<TransitOwner> =
    LazyLock::new(|| TransitOwner(Arc::new(Mutex::new(TransitState::default()))));
struct TransitInstanceState {
    process: Arc<Mutex<TransitState>>,
    charged: Mutex<u64>,
}
pub(crate) struct TransitInstance(Arc<TransitInstanceState>);
pub(crate) struct TransitCharge {
    instance: Arc<TransitInstanceState>,
    bytes: u64,
}
impl TransitOwner {
    /// The native application supplies its stable PC identity, never a connection,
    /// poll or generation identifier. No IPC constructor exposes this domain.
    pub(crate) fn instance(&self, pc: uuid::Uuid) -> Result<TransitInstance, ResourceError> {
        let mut process = self.0.lock().map_err(|_| ResourceError::ResourceLimit)?;
        if let Some(instance) = process.instances.get(&pc).and_then(Weak::upgrade) {
            return Ok(TransitInstance(instance));
        }
        process
            .instances
            .retain(|_, instance| instance.strong_count() != 0);
        let instance = Arc::new(TransitInstanceState {
            process: self.0.clone(),
            charged: Mutex::new(0),
        });
        process.instances.insert(pc, Arc::downgrade(&instance));
        Ok(TransitInstance(instance))
    }
}
impl TransitInstance {
    pub(crate) fn reserve(&self, bytes: u64) -> Result<TransitCharge, ResourceError> {
        let mut process = self
            .0
            .process
            .lock()
            .map_err(|_| ResourceError::ResourceLimit)?;
        let mut instance = self
            .0
            .charged
            .lock()
            .map_err(|_| ResourceError::ResourceLimit)?;
        let next_process = process
            .charged
            .checked_add(bytes)
            .ok_or(ResourceError::ResourceLimit)?;
        let next_instance = instance
            .checked_add(bytes)
            .ok_or(ResourceError::ResourceLimit)?;
        if next_process > TRANSIT_PROCESS_LIMIT || next_instance > TRANSIT_INSTANCE_LIMIT {
            return Err(ResourceError::ResourceLimit);
        }
        process.charged = next_process;
        *instance = next_instance;
        Ok(TransitCharge {
            instance: self.0.clone(),
            bytes,
        })
    }
}
impl Drop for TransitCharge {
    fn drop(&mut self) {
        if let Ok(mut process) = self.instance.process.lock() {
            if let Ok(mut instance) = self.instance.charged.lock() {
                process.charged -= self.bytes;
                *instance -= self.bytes;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn connect_resources_live_config_restricts_an_existing_lease() {
        use crate::config::{
            ConfigChangeSource, ConfigPatchRequest, ConfigScope, JsonPatchOperation,
        };
        let directory = tempfile::tempdir().unwrap();
        let manager = ConfigManager::initialize(directory.path().join("config"))
            .await
            .unwrap();
        let owner = WorkingOwner::default();
        let policy = configured(&manager).await.unwrap();
        // Synthetic RAM keeps this race independent of pressure from other tests.
        // The policy owner and approved file publication are the production paths.
        let lease = owner
            .admit_measured(
                &policy,
                PolicySource::Live(manager.clone()),
                (16 * 1024 * MIB, 8 * 1024 * MIB),
                Instant::now(),
            )
            .unwrap();
        let held = lease.reserve(128 * MIB).await.unwrap();
        for ceiling in [64, 4096] {
            let document = manager
                .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
                .await
                .unwrap();
            manager
                .apply_patch(ConfigPatchRequest {
                    kind: ConfigDocumentKind::Settings,
                    scope: ConfigScope::User,
                    expected_etag: document.etag,
                    patch: vec![JsonPatchOperation {
                        op: "add".into(),
                        path: "/connectTransferResources".into(),
                        from: None,
                        value: Some(serde_json::json!({"workingCeilingMiB": ceiling})),
                    }],
                    source: ConfigChangeSource::UserInterface,
                })
                .await
                .unwrap();
            if ceiling == 64 {
                assert!(matches!(
                    lease.reserve(1).await,
                    Err(ResourceError::ResourceLimit)
                ));
                assert_eq!(lease.0.allocation.lock().unwrap().charged, 128 * MIB);
                assert!(matches!(
                    owner.admit(&manager).await,
                    Err(ResourceError::Busy)
                ));
            } else {
                // Raising configuration cannot enlarge this job's frozen W.
                assert!(matches!(
                    lease.reserve(385 * MIB).await,
                    Err(ResourceError::ResourceLimit)
                ));
                let remaining = lease.reserve(384 * MIB).await.unwrap();
                drop(remaining);
            }
        }
        drop(held);
        let final_charge = lease.reserve(512 * MIB).await.unwrap();
        drop(lease);
        assert!(matches!(
            owner.admit(&manager).await,
            Err(ResourceError::Busy)
        ));
        drop(final_charge);
    }

    #[test]
    fn connect_resources_pc_replacement_keeps_retiring_charges() {
        let owner = TransitOwner::default();
        let pc = uuid::Uuid::from_u128(7);
        let poll = owner.instance(pc).unwrap();
        let control = owner.instance(pc).unwrap();
        let held = poll.reserve(27 * MIB).unwrap();
        assert!(matches!(
            control.reserve(27 * MIB),
            Err(ResourceError::ResourceLimit)
        ));
        drop(poll);
        drop(control);
        let replacement = owner.instance(pc).unwrap();
        assert!(matches!(
            replacement.reserve(27 * MIB),
            Err(ResourceError::ResourceLimit)
        ));
        let remaining = replacement.reserve(5 * MIB).unwrap();
        drop(held);
        let next = replacement.reserve(27 * MIB).unwrap();
        assert_eq!(owner.0.lock().unwrap().charged, 32 * MIB);
        drop(remaining);
        drop(next);
        drop(replacement);
        let fresh = owner.instance(pc).unwrap();
        assert!(fresh.reserve(32 * MIB).is_ok());
    }

    #[test]
    fn connect_resources_native_measurements_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let policy = ConnectTransferResources::default();
        let headroom = native_disk_headroom(&policy, directory.path(), 0).unwrap();
        assert!(headroom <= u64::from(policy.retained_ceiling_mi_b) * MIB);
        assert_eq!(
            native_disk_headroom(&policy, &directory.path().join("absent"), 0),
            Err(ResourceError::MeasurementUnavailable)
        );
        let (total, available) = crate::host_telemetry::available_memory().unwrap();
        assert!(total > 0 && available <= total);
    }

    #[test]
    fn connect_resources_concurrent_transit_shares_one_process_limit() {
        let owner = TransitOwner::default();
        let start = Arc::new(std::sync::Barrier::new(4));
        let finish = Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|id| {
                let instance = owner.instance(uuid::Uuid::from_u128(id + 1)).unwrap();
                let start = start.clone();
                let finish = finish.clone();
                std::thread::spawn(move || {
                    start.wait();
                    let charge = instance.reserve(27 * MIB);
                    finish.wait();
                    charge.is_ok()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            2
        );
        assert_eq!(owner.0.lock().unwrap().charged, 0);
    }

    #[test]
    fn connect_resources_transit_keeps_32_and_64_mib_domains() {
        let owner = TransitOwner::default();
        let first = owner.instance(uuid::Uuid::from_u128(1)).unwrap();
        let second = owner.instance(uuid::Uuid::from_u128(2)).unwrap();
        let third = owner.instance(uuid::Uuid::from_u128(3)).unwrap();
        let first_charge = first.reserve(27 * MIB).unwrap();
        assert!(matches!(
            first.reserve(27 * MIB),
            Err(ResourceError::ResourceLimit)
        ));
        let second_charge = second.reserve(27 * MIB).unwrap();
        assert!(matches!(
            third.reserve(27 * MIB),
            Err(ResourceError::ResourceLimit)
        ));
        drop(first);
        assert!(matches!(
            third.reserve(27 * MIB),
            Err(ResourceError::ResourceLimit)
        ));
        drop(first_charge);
        let third_charge = third.reserve(27 * MIB).unwrap();
        drop(second_charge);
        drop(third_charge);
        assert_eq!(owner.0.lock().unwrap().charged, 0);
    }

    #[test]
    fn connect_resources_exact_formulas_and_pressure() {
        let policy = ConnectTransferResources::default();
        assert_eq!(
            working_budget(&policy, 16 * 1024 * MIB, 8 * 1024 * MIB),
            Ok(512 * MIB)
        );
        assert_eq!(working_budget(&policy, 1024 * MIB, 512 * MIB), Ok(64 * MIB));
        assert_eq!(
            working_budget(&policy, 1024 * MIB, 512 * MIB - 1),
            Err(ResourceError::ResourceLimit)
        );
        assert_eq!(
            working_budget(&policy, MIB, 2 * MIB),
            Err(ResourceError::MeasurementUnavailable)
        );
        assert_eq!(
            disk_headroom(&policy, 100 * 1024 * MIB, 9 * 1024 * MIB, 0),
            Ok(1024 * MIB)
        );
        assert_eq!(
            disk_headroom(&policy, 100 * 1024 * MIB, 90 * 1024 * MIB, 9000 * MIB),
            Ok(0)
        );
        assert_eq!(sqlite_growth_charge(2 * MIB), Ok(24 * MIB));
        assert_eq!(
            sqlite_growth_charge(u64::MAX),
            Err(ResourceError::ResourceLimit)
        );
    }
    #[test]
    fn connect_resources_owner_survives_retirement_until_charges_close() {
        let owner = WorkingOwner::default();
        let policy = ConnectTransferResources::default();
        let now = Instant::now();
        let memory = (16 * 1024 * MIB, 8 * 1024 * MIB);
        let lease = owner.admit_with(policy.clone(), memory, now).unwrap();
        let charge = lease
            .reserve_with(512 * MIB, now, || panic!("no cached refresh"))
            .unwrap();
        assert!(matches!(
            lease.reserve_with(1, now, || unreachable!()),
            Err(ResourceError::ResourceLimit)
        ));
        drop(lease);
        assert!(matches!(
            owner.admit_with(policy.clone(), memory, now),
            Err(ResourceError::Busy)
        ));
        drop(charge);
        assert!(owner.admit_with(policy, memory, now).is_ok());
    }
    #[test]
    fn connect_resources_failed_refresh_preserves_owners_and_closes_growth() {
        let owner = WorkingOwner::default();
        let now = Instant::now();
        let lease = owner
            .admit_with(
                ConnectTransferResources::default(),
                (16 * 1024 * MIB, 8 * 1024 * MIB),
                now,
            )
            .unwrap();
        let charge = lease
            .reserve_with(128 * MIB, now, || unreachable!())
            .unwrap();
        let later = now + SAMPLE_TTL;
        assert!(matches!(
            lease.reserve_with(1, later, || Err(ResourceError::MeasurementUnavailable)),
            Err(ResourceError::MeasurementUnavailable)
        ));
        assert!(matches!(
            lease.reserve_with(1, later, || Ok((1024 * MIB, 512 * MIB))),
            Err(ResourceError::ResourceLimit)
        ));
        drop(charge);
        let restored = lease
            .reserve_with(64 * MIB, later + SAMPLE_TTL, || Ok((1024 * MIB, 512 * MIB)))
            .unwrap();
        drop(restored);
    }
}
