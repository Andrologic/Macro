//! Opt-in real Keychain Services smoke. All credentials and keychains are synthetic.
//! See README.native-smoke.md beside this file before running it.
use super::*;
use std::{ffi::CString, os::unix::ffi::OsStrExt, path::PathBuf};

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainCreate(
        path: *const c_char,
        length: u32,
        password: *const c_void,
        prompt_user: u8,
        initial_access: Ref,
        keychain: *mut Ref,
    ) -> i32;
    fn SecKeychainDelete(keychain: Ref) -> i32;
    fn SecKeychainLock(keychain: Ref) -> i32;
    fn SecKeychainCopySearchList(list: *mut Ref) -> i32;
    fn SecKeychainGetPath(keychain: Ref, length: *mut u32, path: *mut c_char) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> *const c_void;
    fn CFEqual(left: *const c_void, right: *const c_void) -> u8;
}

const PASSWORD: &[u8] = b"macro-pilot-disposable-synthetic-password";
const SERVICE: &str = "macro.pilot.native-smoke.synthetic";
const KIND: PilotSecretKind = PilotSecretKind::SessionToken;

// Creation, lock/unlock and cleanup use the same mutex/policy guard as access.
// No operation here is allowed to enable UI, including error recovery.
fn silent<T>(operation: &'static str, call: impl FnOnce() -> Result<T, i32>) -> Result<T, String> {
    let _lock = SECURITY_LOCK
        .lock()
        .map_err(|_| "security mutex poisoned".to_owned())?;
    if POLICY_UNCERTAIN.load(Ordering::Acquire) {
        return Err("interaction policy uncertain".into());
    }
    let guard = InteractionGuard::enter(&Policy, false)
        .map_err(|status| format!("{operation}: policy OSStatus={status}"))?;
    let start = Instant::now();
    let result = call();
    let restored = guard.restore();
    eprintln!(
        "native smoke operation={operation} duration_ms={} OSStatus={}",
        start.elapsed().as_millis(),
        result.as_ref().err().copied().unwrap_or(0)
    );
    restored.map_err(|status| format!("{operation}: restore OSStatus={status}"))?;
    result.map_err(|status| format!("{operation}: OSStatus={status}"))
}

fn search_list() -> Result<Owned, i32> {
    let mut list = Owned(null_mut());
    check(unsafe { SecKeychainCopySearchList(&mut list.0) })?;
    if list.0.is_null() {
        return Err(-50);
    }
    Ok(list)
}

// Authentication failure is the observed locked-keychain result on some macOS
// versions. Do not relabel it as cancellation or accept arbitrary storage errors.
fn blocked<T>(result: Result<T, PilotSecretError>, operation: &str) -> Result<(), String> {
    let status = TEST_STATUS.with(std::cell::Cell::get);
    match (result, status) {
        (Err(PilotSecretError::InterventionRequired), Some(-25308 | -25315))
        | (Err(PilotSecretError::VaultUnavailable), Some(-25293)) => Ok(()),
        _ => Err(format!(
            "{operation}: unexpected locked result, OSStatus={status:?}"
        )),
    }
}

struct Fixture {
    keychain: Owned,
    directory: PathBuf,
    original_search_list: Owned,
    deleted: bool,
    clean: bool,
}
impl Fixture {
    fn create() -> Result<Self, String> {
        let temporary = tempfile::Builder::new()
            .prefix("macro-pilot-native-smoke-")
            .tempdir()
            .map_err(|_| "temporary directory creation failed")?;
        let directory = temporary
            .path()
            .canonicalize()
            .map_err(|_| "temporary directory resolution failed")?;
        // Apple treats any path containing /login.keychain specially. Reject it
        // even in a caller-selected TMPDIR ancestor, before Security sees it.
        if directory
            .as_os_str()
            .as_bytes()
            .windows(b"/login.keychain".len())
            .any(|part| part == b"/login.keychain")
        {
            return Err("temporary path could select login-keychain behavior".into());
        }
        let path = CString::new(
            directory
                .join("fixture.keychain")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .map_err(|_| "invalid temporary path")?;
        let original_search_list = silent("snapshot-search-list", search_list)?;
        let _owned_directory = temporary.keep();
        let mut fixture = Self {
            keychain: Owned(null_mut()),
            directory,
            original_search_list,
            deleted: false,
            clean: false,
        };
        silent("create", || {
            // Explicit nonempty password, promptUser=false, ignored initialAccess=NULL.
            check(unsafe {
                SecKeychainCreate(
                    path.as_ptr(),
                    PASSWORD.len() as u32,
                    PASSWORD.as_ptr().cast(),
                    0,
                    null_mut(),
                    &mut fixture.keychain.0,
                )
            })?;
            if fixture.keychain.0.is_null() {
                return Err(-25295);
            }
            Ok(())
        })?;
        // Query only our returned reference. Never inspect a personal keychain path.
        let returned = silent("verify-created-path", || {
            let mut path = vec![0u8; 4096];
            let mut length = path.len() as u32;
            check(unsafe {
                SecKeychainGetPath(fixture.keychain.0, &mut length, path.as_mut_ptr().cast())
            })?;
            if length as usize > path.len() {
                return Err(-50);
            }
            path.truncate(length as usize);
            Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&path)))
        })?;
        if returned.parent() != Some(fixture.directory.as_path())
            || !["fixture.keychain", "fixture.keychain-db"]
                .iter()
                .any(|name| returned.file_name() == Some(std::ffi::OsStr::new(name)))
        {
            return Err("created keychain path is outside the exclusive fixture directory".into());
        }
        fixture.unlock()?;
        Ok(fixture)
    }

    fn unlock(&self) -> Result<(), String> {
        if self.keychain.0.is_null() {
            return Err("fixture has no keychain".into());
        }
        silent("unlock-with-synthetic-password", || {
            check(unsafe {
                SecKeychainUnlock(
                    self.keychain.0,
                    PASSWORD.len() as u32,
                    PASSWORD.as_ptr().cast(),
                    1,
                )
            })
        })
    }

    fn lock(&self) -> Result<(), String> {
        if self.keychain.0.is_null() {
            return Err("fixture has no keychain".into());
        }
        silent("lock-synthetic-keychain", || {
            check(unsafe { SecKeychainLock(self.keychain.0) })?;
            let mut flags = 0;
            check(unsafe { SecKeychainGetStatus(self.keychain.0, &mut flags) })?;
            if flags & 1 != 0 {
                return Err(-50);
            }
            Ok(())
        })
    }

    fn cleanup(&mut self) -> Result<(), String> {
        if self.clean {
            return Ok(());
        }
        if !self.keychain.0.is_null() {
            silent("delete-synthetic-keychain", || {
                if !self.deleted {
                    // Single owned reference, never NULL, array, or search-list replacement.
                    check(unsafe { SecKeychainDelete(self.keychain.0) })?;
                    self.deleted = true;
                }
                let list = search_list()?;
                for index in 0..unsafe { CFArrayGetCount(list.0) } {
                    let value = unsafe { CFArrayGetValueAtIndex(list.0, index) };
                    if unsafe { CFEqual(value, self.keychain.0) } != 0 {
                        return Err(-50);
                    }
                }
                // Compare opaque list metadata only; never restore or replace it.
                if unsafe { CFEqual(self.original_search_list.0, list.0) } == 0 {
                    return Err(-50);
                }
                Ok(())
            })?;
        }
        // remove_dir succeeds only if native deletion left no files. Never hide
        // a residue with recursive deletion; retain its exact directory on failure.
        std::fs::remove_dir(&self.directory)
            .map_err(|_| format!("fixture residue: {}", self.directory.display()))?;
        self.clean = true;
        eprintln!(
            "native smoke cleanup=verified search_reference_absent=true search_list_unchanged=true directory_absent=true"
        );
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!(
                "native smoke cleanup failed: {error}; fixture={}",
                self.directory.display()
            );
        }
    }
}

struct Injection;
impl Injection {
    fn enter(fixture: &Fixture) -> Self {
        assert!(!fixture.keychain.0.is_null());
        TEST_KEYCHAIN.with(|slot| {
            assert!(slot.get().is_null());
            slot.set(fixture.keychain.0);
        });
        Self
    }
}
impl Drop for Injection {
    fn drop(&mut self) {
        TEST_KEYCHAIN.with(|slot| slot.set(null_mut()));
    }
}

fn exercise(fixture: &Fixture) -> Result<(), String> {
    let _injection = Injection::enter(fixture);
    let first = "A".repeat(43);
    let second = "E".repeat(42) + "A";
    // These are the production adapter entry points, not copies of its queries.
    write(SERVICE, "roundtrip", KIND, &first).map_err(|e| format!("write: {e:?}"))?;
    assert!(
        read(SERVICE, "roundtrip", KIND, false).map_err(|e| format!("read: {e:?}"))? == Some(first),
        "roundtrip mismatch"
    );
    write(SERVICE, "roundtrip", KIND, &second).map_err(|e| format!("update: {e:?}"))?;
    assert!(
        read(SERVICE, "roundtrip", KIND, false).map_err(|e| format!("read update: {e:?}"))?
            == Some(second),
        "update mismatch"
    );
    delete(SERVICE, "roundtrip", KIND).map_err(|e| format!("delete: {e:?}"))?;
    assert!(read(SERVICE, "roundtrip", KIND, false)
        .map_err(|e| format!("read absent: {e:?}"))?
        .is_none());
    delete(SERVICE, "roundtrip", KIND).map_err(|e| format!("delete absent: {e:?}"))?;
    write(SERVICE, "locked", KIND, &"A".repeat(43)).map_err(|e| format!("seed: {e:?}"))?;
    fixture.lock()?;
    let start = Instant::now();
    blocked(read(SERVICE, "locked", KIND, false), "locked read")?;
    blocked(
        write(SERVICE, "locked", KIND, &"A".repeat(43)),
        "locked write",
    )?;
    let deleted = match delete(SERVICE, "locked", KIND) {
        Ok(()) => true,
        Err(error) => {
            blocked::<()>(Err(error), "locked delete")?;
            false
        }
    };
    eprintln!(
        "native smoke locked_operations duration_ms={} delete_succeeded={deleted}",
        start.elapsed().as_millis()
    );
    // Observed latency bound, not a cancellation mechanism for a hung OS service.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(5),
        "locked operations exceeded smoke latency bound"
    );
    fixture.unlock()?;
    let value =
        read(SERVICE, "locked", KIND, false).map_err(|e| format!("read after unlock: {e:?}"))?;
    assert!(value.is_none() == deleted, "locked delete outcome mismatch");
    delete(SERVICE, "locked", KIND).map_err(|e| format!("final delete: {e:?}"))?;
    Ok(())
}

#[test]
#[ignore = "opt-in real disposable keychain; see README.native-smoke.md"]
fn isolated_native_silent_smoke() {
    assert_eq!(
        std::env::var("MACRO_PILOT_NATIVE_SMOKE").as_deref(),
        Ok("1"),
        "explicit smoke opt-in required"
    );
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_test_writer()
        .try_init();
    // Missing injection must never resolve the user's default keychain.
    assert!(matches!(
        read(SERVICE, "no-injection", KIND, false),
        Err(PilotSecretError::VaultUnavailable)
    ));
    let original_policy = {
        let _lock = SECURITY_LOCK.lock().unwrap();
        Policy.get().unwrap()
    };
    let mut fixture = Fixture::create().expect("synthetic keychain creation failed");
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| exercise(&fixture)));
    let cleanup = fixture.cleanup();
    cleanup.expect("synthetic keychain cleanup failed");
    let restored_policy = {
        let _lock = SECURITY_LOCK.lock().unwrap();
        Policy.get().unwrap()
    };
    assert_eq!(
        original_policy, restored_policy,
        "interaction policy changed"
    );
    eprintln!("native smoke interaction_policy_restored=true");
    outcome
        .expect("native smoke assertion failed")
        .expect("native smoke operation failed");
}
