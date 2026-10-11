//! On-demand, host-wide CPU and physical RAM telemetry. No process enumeration.
//! Each cache miss measures CPU across at least 250 ms; completed samples live 5 s.
//! Linux RAM used = MemTotal - MemAvailable, from /proc/meminfo in KiB.
//! macOS RAM used = (internal - purgeable + wired + compressor) * page size.
//! This counts resident anonymous, wired and compressed storage, excludes file cache
//! and purgeable pages, and does not count the compressor's uncompressed equivalent.
//! macOS total = hw.memsize. Windows used = ullTotalPhys - ullAvailPhys, excluding
//! standby/free/zero pages. These are OS-specific physical-memory definitions.
//! Windows CPU coverage on multi-group hosts (>64 logical processors) is unverified.
//! A partial per-processor reply yields measurement_failed, never a subset metric.

use chrono::{DateTime, SecondsFormat, SubsecRound, Utc};
use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CPU_INTERVAL: Duration = Duration::from_millis(250);
const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum HostTelemetryAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum HostTelemetryReason {
    UnsupportedPlatform,
    MeasurementFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HostTelemetryDto {
    pub sample_id: String,
    /// UTC RFC 3339 timestamps, taken when the measurement completes.
    pub observed_at: String,
    pub expires_at: String,
    pub availability: HostTelemetryAvailability,
    pub reason: Option<HostTelemetryReason>,
    /// Aggregate busy CPU time / aggregate elapsed CPU time, normalized to 0..100.
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
}

type MeasurementResult<T> = Result<T, HostTelemetryReason>;
const FAILED: HostTelemetryReason = HostTelemetryReason::MeasurementFailed;

#[derive(Debug, Clone, Copy)]
struct CpuCounters {
    busy: u64,
    idle: u64,
}

fn cpu_percent(before: CpuCounters, after: CpuCounters) -> MeasurementResult<f64> {
    let busy = after.busy.checked_sub(before.busy).ok_or(FAILED)?;
    let idle = after.idle.checked_sub(before.idle).ok_or(FAILED)?;
    let total = busy
        .checked_add(idle)
        .filter(|total| *total > 0)
        .ok_or(FAILED)?;
    Ok((100.0 * busy as f64 / total as f64).clamp(0.0, 100.0))
}

#[derive(Debug, Clone, Copy)]
struct Memory {
    used: u64,
    total: u64,
}

impl Memory {
    fn new(used: u64, total: u64) -> MeasurementResult<Self> {
        if total == 0 || used > total {
            return Err(FAILED);
        }
        Ok(Self { used, total })
    }
}

// Keep OS reads behind this boundary so tests only supply synthetic counters.
trait Collector {
    fn cpu(&mut self) -> MeasurementResult<CpuCounters>;
    fn memory(&mut self) -> MeasurementResult<Memory>;
}

trait Clock {
    fn monotonic(&self) -> Instant;
    fn utc(&self) -> DateTime<Utc>;
    fn wait(&self, duration: Duration);
}

struct SystemClock;
impl Clock for SystemClock {
    fn monotonic(&self) -> Instant {
        Instant::now()
    }
    fn utc(&self) -> DateTime<Utc> {
        Utc::now()
    }
    fn wait(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[derive(Default)]
struct Sampler {
    cached: Option<(Instant, DateTime<Utc>, HostTelemetryDto)>,
}

impl Sampler {
    fn read(&mut self, collector: &mut impl Collector, clock: &impl Clock) -> HostTelemetryDto {
        if let Some((completed, observed, dto)) = &self.cached {
            let now = clock.utc();
            let utc_valid = *observed <= now
                && now < *observed + chrono::Duration::seconds(CACHE_TTL.as_secs() as i64);
            if clock
                .monotonic()
                .checked_duration_since(*completed)
                .is_some_and(|age| age < CACHE_TTL)
                && utc_valid
            {
                return dto.clone();
            }
        }
        let measurement = (|| {
            let before = collector.cpu()?;
            // Start the interval after the first read to guarantee >=250 ms between reads.
            let started = clock.monotonic();
            clock.wait(CPU_INTERVAL);
            if clock
                .monotonic()
                .checked_duration_since(started)
                .is_none_or(|elapsed| elapsed < CPU_INTERVAL)
            {
                return Err(FAILED);
            }
            let after = collector.cpu()?;
            let cpu = cpu_percent(before, after)?;
            let memory = collector.memory()?;
            // Validate injected and native values at the same boundary.
            let memory = Memory::new(memory.used, memory.total)?;
            Ok((cpu, memory))
        })();
        let completed = clock.monotonic();
        // Match the millisecond precision of observedAt/expiresAt on the wire.
        let observed = clock.utc().trunc_subsecs(3);
        let dto = HostTelemetryDto::from_measurement(measurement, observed);
        self.cached = Some((completed, observed, dto.clone()));
        dto
    }
}

impl HostTelemetryDto {
    fn from_measurement(result: MeasurementResult<(f64, Memory)>, observed: DateTime<Utc>) -> Self {
        let (availability, reason, cpu_percent, memory_used_bytes, memory_total_bytes) =
            match result {
                Ok((cpu, memory)) => (
                    HostTelemetryAvailability::Available,
                    None,
                    Some(cpu),
                    Some(memory.used),
                    Some(memory.total),
                ),
                Err(reason) => (
                    HostTelemetryAvailability::Unavailable,
                    Some(reason),
                    None,
                    None,
                    None,
                ),
            };
        Self {
            sample_id: uuid::Uuid::new_v4().to_string(),
            observed_at: observed.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: (observed + chrono::Duration::seconds(CACHE_TTL.as_secs() as i64))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            availability,
            reason,
            cpu_percent,
            memory_used_bytes,
            memory_total_bytes,
        }
    }
}

struct NativeCollector;
impl Collector for NativeCollector {
    fn cpu(&mut self) -> MeasurementResult<CpuCounters> {
        platform::cpu()
    }
    fn memory(&mut self) -> MeasurementResult<Memory> {
        platform::memory()
    }
}

static SAMPLER: LazyLock<Mutex<Sampler>> = LazyLock::new(|| Mutex::new(Sampler::default()));

/// Concurrent requests share a single completed sample, including failures.
/// The blocking pool owns only the requested measurement and its short wait.
#[tauri::command]
pub async fn host_telemetry_read() -> HostTelemetryDto {
    tauri::async_runtime::spawn_blocking(|| match SAMPLER.lock() {
        Ok(mut sampler) => sampler.read(&mut NativeCollector, &SystemClock),
        Err(_) => HostTelemetryDto::from_measurement(Err(FAILED), Utc::now()),
    })
    .await
    .unwrap_or_else(|_| HostTelemetryDto::from_measurement(Err(FAILED), Utc::now()))
}

#[cfg(any(target_os = "linux", test))]
mod linux_values {
    use super::*;

    pub(super) fn cpu(stat: &str) -> MeasurementResult<CpuCounters> {
        let mut fields = stat.lines().next().ok_or(FAILED)?.split_whitespace();
        if fields.next() != Some("cpu") {
            return Err(FAILED);
        }
        let ticks: Vec<u64> = fields
            .map(|field| field.parse::<u64>().map_err(|_| FAILED))
            .collect::<MeasurementResult<_>>()?;
        if ticks.len() < 8 {
            return Err(FAILED);
        }
        // guest and guest_nice are already included in user and nice.
        let busy = [0, 1, 2, 5, 6, 7]
            .into_iter()
            .try_fold(0u64, |sum, index| {
                sum.checked_add(ticks[index]).ok_or(FAILED)
            })?;
        // iowait is idle. A backwards idle/busy aggregate fails the delta check.
        let idle = ticks[3].checked_add(ticks[4]).ok_or(FAILED)?;
        Ok(CpuCounters { busy, idle })
    }

    pub(super) fn memory(meminfo: &str) -> MeasurementResult<Memory> {
        let mut total = None;
        let mut available = None;
        for line in meminfo.lines() {
            let mut fields = line.split_whitespace();
            let target = match fields.next() {
                Some("MemTotal:") => &mut total,
                Some("MemAvailable:") => &mut available,
                _ => continue,
            };
            if target.is_some() {
                return Err(FAILED);
            }
            let kib = fields
                .next()
                .ok_or(FAILED)?
                .parse::<u64>()
                .map_err(|_| FAILED)?;
            if fields.next() != Some("kB") || fields.next().is_some() {
                return Err(FAILED);
            }
            *target = Some(kib.checked_mul(1024).ok_or(FAILED)?);
        }
        let total = total.ok_or(FAILED)?;
        Memory::new(
            total.checked_sub(available.ok_or(FAILED)?).ok_or(FAILED)?,
            total,
        )
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    pub(super) fn cpu() -> MeasurementResult<CpuCounters> {
        use std::io::{BufRead, BufReader, Read};
        let file = std::fs::File::open("/proc/stat").map_err(|_| FAILED)?;
        let mut aggregate = String::new();
        // Only the first, aggregate CPU row is needed, not per-CPU or process counts.
        BufReader::new(file.take(4096))
            .read_line(&mut aggregate)
            .map_err(|_| FAILED)?;
        if !aggregate.ends_with('\n') {
            return Err(FAILED);
        }
        linux_values::cpu(&aggregate)
    }
    pub(super) fn memory() -> MeasurementResult<Memory> {
        linux_values::memory(&std::fs::read_to_string("/proc/meminfo").map_err(|_| FAILED)?)
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_memory(
    internal: u64,
    purgeable: u64,
    wired: u64,
    compressor: u64,
    page_size: u64,
    total: u64,
) -> MeasurementResult<Memory> {
    if page_size == 0 {
        return Err(FAILED);
    }
    let used = internal
        .checked_sub(purgeable)
        .and_then(|pages| pages.checked_add(wired))
        .and_then(|pages| pages.checked_add(compressor))
        .and_then(|pages| pages.checked_mul(page_size))
        .ok_or(FAILED)?;
    Memory::new(used, total)
}

#[cfg(target_os = "macos")]
// Keep the existing libc Mach bindings instead of adding a Mach dependency.
#[allow(deprecated)]
mod platform {
    use super::*;
    // libc exposes the Mach statistics bindings but not port deallocation.
    unsafe extern "C" {
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
    }
    struct HostPort(libc::mach_port_t);
    impl HostPort {
        fn new() -> MeasurementResult<Self> {
            // SAFETY: mach_host_self takes no parameters and returns an owned send right.
            let port = unsafe { libc::mach_host_self() };
            if port == 0 {
                Err(FAILED)
            } else {
                Ok(Self(port))
            }
        }
    }
    impl Drop for HostPort {
        fn drop(&mut self) {
            // SAFETY: this guard owns the send right returned by mach_host_self.
            unsafe {
                mach_port_deallocate(libc::mach_task_self(), self.0);
            }
        }
    }
    pub(super) fn cpu() -> MeasurementResult<CpuCounters> {
        let host = HostPort::new()?;
        // SAFETY: zero is valid for this C integer structure; count matches its size.
        let mut info: libc::host_cpu_load_info = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
        let status = unsafe {
            libc::host_statistics(
                host.0,
                libc::HOST_CPU_LOAD_INFO,
                std::ptr::addr_of_mut!(info).cast(),
                &mut count,
            )
        };
        if status != libc::KERN_SUCCESS || count != libc::HOST_CPU_LOAD_INFO_COUNT {
            return Err(FAILED);
        }
        let ticks = info.cpu_ticks;
        Ok(CpuCounters {
            busy: u64::from(ticks[libc::CPU_STATE_USER as usize])
                + u64::from(ticks[libc::CPU_STATE_SYSTEM as usize])
                + u64::from(ticks[libc::CPU_STATE_NICE as usize]),
            idle: u64::from(ticks[libc::CPU_STATE_IDLE as usize]),
        })
    }
    pub(super) fn memory() -> MeasurementResult<Memory> {
        let host = HostPort::new()?;
        // SAFETY: zero is valid for the C structure and its size/count match the buffer.
        let mut info: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let status = unsafe {
            libc::host_statistics64(
                host.0,
                libc::HOST_VM_INFO64,
                std::ptr::addr_of_mut!(info).cast(),
                &mut count,
            )
        };
        if status != libc::KERN_SUCCESS || count != libc::HOST_VM_INFO64_COUNT {
            return Err(FAILED);
        }
        let mut total = 0u64;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: name is NUL-terminated, output points to an initialized u64 of size bytes.
        let status = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                std::ptr::addr_of_mut!(total).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 || size != std::mem::size_of::<u64>() {
            return Err(FAILED);
        }
        // SAFETY: sysconf returns the runtime page size without writing memory.
        let page_size =
            u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).map_err(|_| FAILED)?;
        macos_memory(
            u64::from(info.internal_page_count),
            u64::from(info.purgeable_count),
            u64::from(info.wire_count),
            u64::from(info.compressor_page_count),
            page_size,
            total,
        )
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_cpu(times: impl IntoIterator<Item = (i64, i64, i64)>) -> MeasurementResult<CpuCounters> {
    let mut counters = CpuCounters { busy: 0, idle: 0 };
    let mut count = 0;
    for (idle, kernel, user) in times {
        let idle = u64::try_from(idle).map_err(|_| FAILED)?;
        let kernel = u64::try_from(kernel).map_err(|_| FAILED)?;
        let user = u64::try_from(user).map_err(|_| FAILED)?;
        // Windows kernel time includes idle time.
        let busy = kernel
            .checked_sub(idle)
            .and_then(|kernel| kernel.checked_add(user))
            .ok_or(FAILED)?;
        counters.busy = counters.busy.checked_add(busy).ok_or(FAILED)?;
        counters.idle = counters.idle.checked_add(idle).ok_or(FAILED)?;
        count += 1;
    }
    if count == 0 {
        Err(FAILED)
    } else {
        Ok(counters)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows_sys::Wdk::System::SystemInformation::{
        NtQuerySystemInformation, SystemProcessorPerformanceInformation,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{GetActiveProcessorCount, ALL_PROCESSOR_GROUPS};
    use windows_sys::Win32::System::WindowsProgramming::SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION;

    pub(super) fn cpu() -> MeasurementResult<CpuCounters> {
        // GetSystemTimes only covers the calling group on hosts with >64 processors.
        // Try the documented per-processor array. Multi-group hardware is unverified;
        // reject replies that omit processors instead of publishing a subset.
        let count = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) } as usize;
        if count == 0 || count > 4096 {
            return Err(FAILED);
        }
        let mut info = vec![SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION::default(); count];
        let size = u32::try_from(std::mem::size_of_val(info.as_slice())).map_err(|_| FAILED)?;
        let mut returned = 0u32;
        // SAFETY: the vector contains count writable C structures; byte size matches it.
        let status = unsafe {
            NtQuerySystemInformation(
                SystemProcessorPerformanceInformation,
                info.as_mut_ptr().cast(),
                size,
                &mut returned,
            )
        };
        // Reject partial groups, topology changes and truncated replies rather than reporting a subset.
        if status < 0 || returned != size {
            return Err(FAILED);
        }
        windows_cpu(
            info.iter()
                .map(|cpu| (cpu.IdleTime, cpu.KernelTime, cpu.UserTime)),
        )
    }
    pub(super) fn memory() -> MeasurementResult<Memory> {
        let mut info = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: info is a writable C structure and dwLength declares its exact size.
        if unsafe { GlobalMemoryStatusEx(&mut info) } == 0 {
            return Err(FAILED);
        }
        Memory::new(
            info.ullTotalPhys
                .checked_sub(info.ullAvailPhys)
                .ok_or(FAILED)?,
            info.ullTotalPhys,
        )
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub(super) fn cpu() -> MeasurementResult<CpuCounters> {
        Err(HostTelemetryReason::UnsupportedPlatform)
    }
    pub(super) fn memory() -> MeasurementResult<Memory> {
        Err(HostTelemetryReason::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;

    struct FakeClock {
        base: Instant,
        millis: Cell<u64>,
        utc_millis: Cell<i64>,
        waits: Cell<usize>,
        early: bool,
    }
    impl FakeClock {
        fn new() -> Self {
            Self {
                base: Instant::now(),
                millis: Cell::new(0),
                utc_millis: Cell::new(0),
                waits: Cell::new(0),
                early: false,
            }
        }
        fn advance(&self, millis: u64) {
            self.millis.set(self.millis.get() + millis);
            self.utc_millis.set(self.utc_millis.get() + millis as i64);
        }
    }
    impl Clock for FakeClock {
        fn monotonic(&self) -> Instant {
            self.base + Duration::from_millis(self.millis.get())
        }
        fn utc(&self) -> DateTime<Utc> {
            DateTime::from_timestamp_millis(self.utc_millis.get()).unwrap()
        }
        fn wait(&self, duration: Duration) {
            self.waits.set(self.waits.get() + 1);
            self.advance(if self.early {
                249
            } else {
                duration.as_millis() as u64
            });
        }
    }
    struct FakeCollector {
        cpus: VecDeque<MeasurementResult<CpuCounters>>,
        memory: MeasurementResult<Memory>,
        reads: usize,
    }
    impl FakeCollector {
        fn valid() -> Self {
            Self {
                cpus: VecDeque::from([
                    Ok(CpuCounters {
                        busy: 100,
                        idle: 300,
                    }),
                    Ok(CpuCounters {
                        busy: 150,
                        idle: 450,
                    }),
                    Ok(CpuCounters {
                        busy: 200,
                        idle: 600,
                    }),
                    Ok(CpuCounters {
                        busy: 250,
                        idle: 750,
                    }),
                ]),
                memory: Ok(Memory {
                    used: 512,
                    total: 1024,
                }),
                reads: 0,
            }
        }
    }
    impl Collector for FakeCollector {
        fn cpu(&mut self) -> MeasurementResult<CpuCounters> {
            self.reads += 1;
            self.cpus
                .pop_front()
                .expect("unexpected system-counter read")
        }
        fn memory(&mut self) -> MeasurementResult<Memory> {
            self.memory
        }
    }
    fn assert_failed(dto: &HostTelemetryDto, reason: HostTelemetryReason) {
        assert_eq!(dto.availability, HostTelemetryAvailability::Unavailable);
        assert_eq!(dto.reason, Some(reason));
        assert_eq!(dto.cpu_percent, None);
        assert_eq!(dto.memory_used_bytes, None);
        assert_eq!(dto.memory_total_bytes, None);
    }

    #[test]
    fn deltas_are_global_and_handle_idle_busy_resets_and_overflow() {
        let before = CpuCounters { busy: 10, idle: 20 };
        assert_eq!(
            cpu_percent(before, CpuCounters { busy: 20, idle: 50 }).unwrap(),
            25.0
        );
        assert_eq!(
            cpu_percent(before, CpuCounters { busy: 10, idle: 50 }).unwrap(),
            0.0
        );
        assert_eq!(
            cpu_percent(before, CpuCounters { busy: 20, idle: 20 }).unwrap(),
            100.0
        );
        for after in [
            before,
            CpuCounters { busy: 9, idle: 30 },
            CpuCounters { busy: 20, idle: 19 },
            CpuCounters {
                busy: u64::MAX,
                idle: u64::MAX,
            },
        ] {
            assert!(cpu_percent(before, after).is_err());
        }
    }

    #[test]
    fn first_read_waits_and_cache_expires_at_exactly_five_seconds() {
        let clock = FakeClock::new();
        let mut collector = FakeCollector::valid();
        let mut sampler = Sampler::default();
        let first = sampler.read(&mut collector, &clock);
        assert_eq!(first.cpu_percent, Some(25.0));
        assert_eq!(first.availability, HostTelemetryAvailability::Available);
        assert_eq!(first.reason, None);
        assert_eq!(first.memory_used_bytes, Some(512));
        assert_eq!(first.memory_total_bytes, Some(1024));
        assert_eq!(first.observed_at, "1970-01-01T00:00:00.250Z");
        assert_eq!(first.expires_at, "1970-01-01T00:00:05.250Z");
        assert_eq!(
            uuid::Uuid::parse_str(&first.sample_id)
                .unwrap()
                .get_version_num(),
            4
        );
        assert_eq!(collector.reads, 2);
        clock.advance(4999);
        assert_eq!(sampler.read(&mut collector, &clock), first);
        assert_eq!(collector.reads, 2);
        clock.advance(1);
        let next = sampler.read(&mut collector, &clock);
        assert_ne!(next.sample_id, first.sample_id);
        assert_eq!(collector.reads, 4);
        assert_eq!(clock.waits.get(), 2);
    }

    #[test]
    fn utc_jumps_invalidate_future_and_expired_cached_samples() {
        for utc_millis in [-1000, 5250] {
            let clock = FakeClock::new();
            let mut collector = FakeCollector::valid();
            let mut sampler = Sampler::default();
            let first = sampler.read(&mut collector, &clock);
            // Monotonic time has not advanced, but the UTC validity window has changed.
            clock.utc_millis.set(utc_millis);
            let next = sampler.read(&mut collector, &clock);
            assert_ne!(next.sample_id, first.sample_id);
            assert_eq!(collector.reads, 4);
            assert_eq!(clock.waits.get(), 2);
            let observed = DateTime::parse_from_rfc3339(&next.observed_at).unwrap();
            let expires = DateTime::parse_from_rfc3339(&next.expires_at).unwrap();
            assert!(observed <= clock.utc());
            assert!(clock.utc() < expires);
            assert_eq!(sampler.read(&mut collector, &clock), next);
            assert_eq!(collector.reads, 4);
        }
    }

    #[test]
    fn interval_shorter_than_250_ms_is_unavailable() {
        let mut clock = FakeClock::new();
        clock.early = true;
        let mut collector = FakeCollector::valid();
        let dto = Sampler::default().read(&mut collector, &clock);
        assert_failed(&dto, FAILED);
        assert_eq!(collector.reads, 1);
    }

    #[test]
    fn unavailable_samples_cache_failures_and_recover_after_expiry() {
        for reason in [FAILED, HostTelemetryReason::UnsupportedPlatform] {
            let clock = FakeClock::new();
            let mut collector = FakeCollector::valid();
            collector.cpus.push_front(Err(reason));
            let mut sampler = Sampler::default();
            let first = sampler.read(&mut collector, &clock);
            assert_failed(&first, reason);
            assert_eq!(clock.waits.get(), 0);
            assert_eq!(sampler.read(&mut collector, &clock), first);
            assert_eq!(collector.reads, 1);
            clock.advance(5000);
            assert_eq!(
                sampler.read(&mut collector, &clock).availability,
                HostTelemetryAvailability::Available
            );
        }
    }

    #[test]
    fn second_counter_and_memory_errors_clear_every_metric() {
        for stage in 0..3 {
            let mut collector = FakeCollector::valid();
            match stage {
                0 => collector.cpus[1] = Err(FAILED),
                1 => collector.memory = Err(FAILED),
                _ => {
                    collector.memory = Ok(Memory {
                        used: 1025,
                        total: 1024,
                    })
                }
            }
            assert_failed(
                &Sampler::default().read(&mut collector, &FakeClock::new()),
                FAILED,
            );
        }
    }

    #[test]
    fn linux_cpu_excludes_guest_double_count_and_memory_uses_available() {
        let cpu = linux_values::cpu("cpu 10 2 3 40 5 6 7 8 10 2\ncpu0 1 2 3 4").unwrap();
        assert_eq!((cpu.busy, cpu.idle), (36, 45));
        let memory =
            linux_values::memory("MemTotal: 1000 kB\nMemFree: 1 kB\nMemAvailable: 400 kB").unwrap();
        assert_eq!((memory.used, memory.total), (600 * 1024, 1000 * 1024));
        for stat in [
            "",
            "cpu0 1 2 3 4 5 6 7 8",
            "cpu 1 2",
            "cpu x 0 0 0 0 0 0 0",
            "cpu 18446744073709551615 1 0 0 0 0 0 0",
        ] {
            assert!(linux_values::cpu(stat).is_err());
        }
        for mem in [
            "MemTotal: 1 kB",
            "MemTotal: 0 kB\nMemAvailable: 0 kB",
            "MemTotal: 1 kB\nMemAvailable: 2 kB",
            "MemTotal: 1 MB\nMemAvailable: 0 kB",
            "MemTotal: 18446744073709551615 kB\nMemAvailable: 0 kB",
            "MemTotal: 1 kB\nMemTotal: 1 kB\nMemAvailable: 0 kB",
        ] {
            assert!(linux_values::memory(mem).is_err());
        }
    }

    #[test]
    fn macos_memory_counts_compressed_storage_and_excludes_purgeable() {
        let memory = macos_memory(100, 10, 20, 5, 4096, 1000000).unwrap();
        assert_eq!(memory.used, 115 * 4096);
        assert!(macos_memory(1, 2, 0, 0, 4096, 1000000).is_err());
        assert!(macos_memory(u64::MAX, 0, 1, 0, 4096, u64::MAX).is_err());
        assert!(macos_memory(1, 0, 0, 0, 0, 1000000).is_err());
        assert!(macos_memory(100, 0, 0, 0, 4096, 4096).is_err());
    }

    #[test]
    fn windows_cpu_aggregates_all_processors_and_subtracts_kernel_idle() {
        let cpu = windows_cpu([(20, 30, 40), (10, 20, 30)]).unwrap();
        assert_eq!((cpu.busy, cpu.idle), (90, 30));
        assert!(windows_cpu([]).is_err());
        assert!(windows_cpu([(-1, 0, 0)]).is_err());
        assert!(windows_cpu([(20, 10, 30)]).is_err());
        assert!(windows_cpu([(0, i64::MAX, i64::MAX); 2]).is_err());
    }

    #[test]
    fn dto_serializes_camel_case_and_closed_reasons_with_null_metrics() {
        let dto = HostTelemetryDto::from_measurement(Err(FAILED), FakeClock::new().utc());
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["availability"], "unavailable");
        assert_eq!(json["reason"], "measurement_failed");
        assert!(json["cpuPercent"].is_null());
        assert!(json["memoryUsedBytes"].is_null());
        assert!(json["memoryTotalBytes"].is_null());
        assert!(json.get("sampleId").is_some());
        assert!(json.get("instanceId").is_none());
        assert!(json.get("sample_id").is_none());
        assert_eq!(json.as_object().unwrap().len(), 8);
    }
}
