//! File-based Keychain Services, matching the previous macOS backend.
//! Every Keychain Services call in this process must use SECURITY_LOCK. The
//! repository and vendored sources have no other credential/keychain callers.
use super::{status_error, Interaction, InteractionGuard, PilotSecretError, PilotSecretKind};
use std::{
    ffi::{c_char, c_void},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};

type Ref = *mut c_void;
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainGetUserInteractionAllowed(state: *mut u8) -> i32;
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
    fn SecKeychainCopyDomainDefault(domain: i32, keychain: *mut Ref) -> i32;
    fn SecKeychainGetStatus(keychain: Ref, status: *mut u32) -> i32;
    fn SecKeychainUnlock(
        keychain: Ref,
        password_len: u32,
        password: *const c_void,
        use_password: u8,
    ) -> i32;
    fn SecKeychainFindGenericPassword(
        keychain: Ref,
        service_len: u32,
        service: *const c_char,
        account_len: u32,
        account: *const c_char,
        password_len: *mut u32,
        password: *mut Ref,
        item: *mut Ref,
    ) -> i32;
    fn SecKeychainAddGenericPassword(
        keychain: Ref,
        service_len: u32,
        service: *const c_char,
        account_len: u32,
        account: *const c_char,
        password_len: u32,
        password: *const c_void,
        item: *mut Ref,
    ) -> i32;
    fn SecKeychainItemModifyAttributesAndData(
        item: Ref,
        attributes: *const c_void,
        len: u32,
        data: *const c_void,
    ) -> i32;
    fn SecKeychainItemDelete(item: Ref) -> i32;
    fn SecKeychainItemFreeContent(attributes: *mut c_void, data: Ref) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
    #[cfg(test)]
    fn CFRetain(value: *const c_void) -> *const c_void;
}

static SECURITY_LOCK: Mutex<()> = Mutex::new(());
static POLICY_UNCERTAIN: AtomicBool = AtomicBool::new(false);
static CORRELATION: AtomicU64 = AtomicU64::new(1);
struct Policy;
impl Interaction for Policy {
    fn get(&self) -> Result<bool, i32> {
        let mut value = 0;
        // SAFETY: valid output pointer, invoked only under SECURITY_LOCK.
        check(unsafe { SecKeychainGetUserInteractionAllowed(&mut value) })?;
        Ok(value != 0)
    }
    fn set(&self, allowed: bool) -> Result<(), i32> {
        let result = check(unsafe { SecKeychainSetUserInteractionAllowed(u8::from(allowed)) });
        if result.is_err() {
            POLICY_UNCERTAIN.store(true, Ordering::Release);
        }
        result
    }
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
struct Data(Ref);
impl Drop for Data {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { SecKeychainItemFreeContent(null_mut(), self.0) };
        }
    }
}
fn check(status: i32) -> Result<(), i32> {
    if status == 0 {
        Ok(())
    } else {
        Err(status)
    }
}

fn access<T>(
    operation: &'static str,
    kind: PilotSecretKind,
    interactive: bool,
    call: impl FnOnce(Ref, &mut i32) -> Result<T, i32>,
) -> Result<T, PilotSecretError> {
    #[cfg(test)]
    TEST_STATUS.with(|slot| slot.set(None));
    #[cfg(test)]
    if interactive && std::env::var_os("MACRO_PILOT_NATIVE_SMOKE").is_some() {
        return Err(PilotSecretError::VaultUnavailable);
    }
    let start = Instant::now();
    let correlation = CORRELATION.fetch_add(1, Ordering::Relaxed);
    let _lock = SECURITY_LOCK
        .lock()
        .map_err(|_| PilotSecretError::VaultUnavailable)?;
    if POLICY_UNCERTAIN.load(Ordering::Acquire) {
        return Err(PilotSecretError::VaultUnavailable);
    }
    let mut observed_status = 0;
    let result = (|| {
        let guard = InteractionGuard::enter(&Policy, interactive)?;
        let mut keychain = Owned(null_mut());
        let result = copy_target(&mut keychain.0).and_then(|_| {
            if keychain.0.is_null() {
                Err(-25295)
            } else {
                call(keychain.0, &mut observed_status)
            }
        });
        drop(keychain);
        guard.restore()?;
        result
    })();
    let system_status = result.as_ref().err().copied().unwrap_or(observed_status);
    #[cfg(test)]
    TEST_STATUS.with(|slot| slot.set(Some(system_status)));
    tracing::info!(
        operation,
        ?kind,
        duration_ms = start.elapsed().as_millis() as u64,
        system_status,
        correlation,
        "Pilot vault operation"
    );
    result.map_err(status_error)
}

// Production always resolves the user-domain default. Tests can borrow only a
// retained explicit reference on their own thread; the opt-in smoke fails closed
// when that reference is missing, including on a newly spawned thread.
fn copy_target(target: &mut Ref) -> Result<(), i32> {
    #[cfg(test)]
    {
        let injected = TEST_KEYCHAIN.with(std::cell::Cell::get);
        if !injected.is_null() {
            *target = unsafe { CFRetain(injected) }.cast_mut();
            return Ok(());
        }
        if std::env::var_os("MACRO_PILOT_NATIVE_SMOKE").is_some() {
            return Err(-25295);
        }
    }
    check(unsafe { SecKeychainCopyDomainDefault(0, target) })
}

#[cfg(test)]
thread_local! {
    static TEST_KEYCHAIN: std::cell::Cell<Ref> = const { std::cell::Cell::new(null_mut()) };
    static TEST_STATUS: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
#[path = "macos_smoke.rs"]
mod native_smoke;

fn find(
    keychain: Ref,
    service: &str,
    key: &str,
    data: Option<(&mut u32, &mut Ref)>,
    item: &mut Ref,
) -> i32 {
    let (len, bytes) = data.map_or((null_mut(), null_mut()), |(len, data)| {
        (len as *mut u32, data as *mut Ref)
    });
    // SAFETY: lengths match the byte buffers; all outputs remain alive through
    // the call. For deletion/update BOTH password outputs are NULL. Apple only
    // retrieves secret data if passwordLength or passwordData is requested.
    unsafe {
        SecKeychainFindGenericPassword(
            keychain,
            service.len() as u32,
            service.as_ptr().cast(),
            key.len() as u32,
            key.as_ptr().cast(),
            len,
            bytes,
            item,
        )
    }
}

/// Explicit user action only. Unlocking the selected keychain permits creating
/// a new entry but does not grant write ACL authorization for existing items.
pub(super) fn unlock(kind: PilotSecretKind) -> Result<(), PilotSecretError> {
    access("unlock", kind, true, |keychain, _| {
        let mut flags = 0;
        check(unsafe { SecKeychainGetStatus(keychain, &mut flags) })?;
        if flags & 1 != 0 {
            return Ok(());
        } // kSecUnlockStateStatus
        check(unsafe { SecKeychainUnlock(keychain, 0, null(), 0) })
    })
}

pub(super) fn read(
    service: &str,
    key: &str,
    kind: PilotSecretKind,
    interactive: bool,
) -> Result<Option<String>, PilotSecretError> {
    let bytes = access("read", kind, interactive, |keychain, observed_status| {
        let mut item = Owned(null_mut());
        let mut data = Data(null_mut());
        let mut length = 0;
        let status = find(
            keychain,
            service,
            key,
            Some((&mut length, &mut data.0)),
            &mut item.0,
        );
        if status == -25300 {
            *observed_status = status;
            return Ok(None);
        }
        check(status)?;
        if length != 43 || data.0.is_null() {
            return Ok(Some(Vec::new()));
        }
        Ok(Some(
            unsafe { std::slice::from_raw_parts(data.0.cast::<u8>(), length as usize) }.to_vec(),
        ))
    })?;
    bytes
        .map(|bytes| String::from_utf8(bytes).map_err(|_| PilotSecretError::InvalidSecret))
        .transpose()
}

pub(super) fn write(
    service: &str,
    key: &str,
    kind: PilotSecretKind,
    secret: &str,
) -> Result<(), PilotSecretError> {
    access("write", kind, false, |keychain, _observed_status| {
        let mut item = Owned(null_mut());
        let status = find(keychain, service, key, None, &mut item.0);
        if status == -25300 {
            return check(unsafe {
                SecKeychainAddGenericPassword(
                    keychain,
                    service.len() as u32,
                    service.as_ptr().cast(),
                    key.len() as u32,
                    key.as_ptr().cast(),
                    secret.len() as u32,
                    secret.as_ptr().cast(),
                    null_mut(),
                )
            });
        }
        check(status)?;
        if item.0.is_null() {
            return Err(-25304);
        }
        check(unsafe {
            SecKeychainItemModifyAttributesAndData(
                item.0,
                null(),
                secret.len() as u32,
                secret.as_ptr().cast(),
            )
        })
    })
}

pub(super) fn delete(
    service: &str,
    key: &str,
    kind: PilotSecretKind,
) -> Result<(), PilotSecretError> {
    access("delete", kind, false, |keychain, observed_status| {
        let mut item = Owned(null_mut());
        let status = find(keychain, service, key, None, &mut item.0);
        if status == -25300 {
            *observed_status = status;
            return Ok(());
        }
        check(status)?;
        if item.0.is_null() {
            return Err(-25304);
        }
        // Return the actual deletion result. No password data was requested.
        let status = unsafe { SecKeychainItemDelete(item.0) };
        *observed_status = status;
        match status {
            0 | -25300 => Ok(()),
            status => Err(status),
        }
    })
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    /// Policy-only probe: no keychain is opened, searched, created or unlocked.
    /// Get/set do not authenticate and cannot present a credential prompt.
    #[test]
    fn native_interaction_policy_restores_previous_true_and_false() {
        let _lock = SECURITY_LOCK.lock().unwrap();
        let original = Policy.get().unwrap();
        for previous in [false, true] {
            let baseline = InteractionGuard::enter(&Policy, previous).unwrap();
            {
                let silent = InteractionGuard::enter(&Policy, false).unwrap();
                assert!(!Policy.get().unwrap());
                {
                    let explicit = InteractionGuard::enter(&Policy, true).unwrap();
                    assert!(Policy.get().unwrap());
                    explicit.restore().unwrap();
                }
                assert!(!Policy.get().unwrap());
                silent.restore().unwrap();
            }
            assert_eq!(Policy.get().unwrap(), previous);
            baseline.restore().unwrap();
            assert_eq!(Policy.get().unwrap(), original);
        }
    }
}
