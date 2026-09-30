//! Lifecycle callbacks invalidate immediately; recovery reads only on a worker.
use super::session::SessionGate;
use objc2::{define_class, msg_send, rc::Retained, MainThreadOnly};
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
    NSWorkspaceSessionDidBecomeActiveNotification, NSWorkspaceSessionDidResignActiveNotification,
    NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSDistributedNotificationCenter, NSNotification,
    NSNotificationSuspensionBehavior, NSObject, NSObjectProtocol, NSString,
};
use std::{cell::RefCell, ffi::c_void};

thread_local! {
    static OBSERVER: RefCell<Option<Retained<PilotVaultObserver>>> = const { RefCell::new(None) };
    static SESSION: RefCell<SessionGate> = const { RefCell::new(SessionGate { awake: true, active: false, unlocked: false }) };
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> *const c_void;
    static kCGSessionOnConsoleKey: *const c_void;
    static kCGSessionLoginDoneKey: *const c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
    static kCFBooleanTrue: *const c_void;
    fn CFRelease(value: *const c_void);
}

fn active_console() -> bool {
    // SAFETY: CG returns an owned CF dictionary or NULL. Only public Boolean
    // session properties are inspected, and the owned dictionary is released.
    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return false;
        }
        let active = CFDictionaryGetValue(session, kCGSessionOnConsoleKey) == kCFBooleanTrue
            && CFDictionaryGetValue(session, kCGSessionLoginDoneKey) == kCFBooleanTrue;
        CFRelease(session);
        active
    }
}

fn suspend(reason: &'static str) {
    if let Some(manager) = super::MANAGER.get() {
        manager.suspend_for(reason, true);
    }
}

fn recover(reason: &'static str) {
    let confirmed = SESSION.with(|state| state.borrow().can_recover());
    tracing::info!(reason, confirmed, "Macro Connect session return");
    if !confirmed {
        return;
    }
    let Some(manager) = super::MANAGER.get().cloned() else {
        return;
    };
    let Some((scopes, generation)) = manager.take_recovery() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = manager.recover_silently(&scopes, &generation);
        tracing::info!(mode = "silent", result = ?result.as_ref().map(|lease| lease.status),
            "Macro Connect credential recovery");
    });
}

define_class!(
    // SAFETY: No Rust ivars; NSObject has no additional subclass requirements.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct PilotVaultObserver;
    unsafe impl NSObjectProtocol for PilotVaultObserver {}
    impl PilotVaultObserver {
        #[unsafe(method(pilotVaultSleep:))]
        fn sleep(&self, _notification: &NSNotification) {
            SESSION.with(|state| state.borrow_mut().sleep());
            suspend("system_sleep");
        }
        #[unsafe(method(pilotVaultScreenSleep:))]
        fn screen_sleep(&self, _notification: &NSNotification) {
            // Display power alone does not revoke an authorized session. A lock
            // or session resignation has its own immediate invalidation path.
            tracing::info!(reason = "screen_sleep", action = "retain_authorized_session", "Macro Connect lifecycle");
        }
        #[unsafe(method(pilotVaultResign:))]
        fn resign(&self, _notification: &NSNotification) {
            SESSION.with(|state| state.borrow_mut().resign());
            suspend("session_resigned");
        }
        #[unsafe(method(pilotVaultLock:))]
        fn lock(&self, _notification: &NSNotification) {
            SESSION.with(|state| state.borrow_mut().lock());
            suspend("screen_locked");
        }
        #[unsafe(method(pilotVaultWake:))]
        fn wake(&self, _notification: &NSNotification) {
            SESSION.with(|state| { let mut state = state.borrow_mut(); state.awake = true; state.active = active_console(); });
            recover("system_wake");
        }
        #[unsafe(method(pilotVaultActive:))]
        fn active(&self, _notification: &NSNotification) {
            SESSION.with(|state| state.borrow_mut().active = active_console());
            recover("session_active");
        }
        #[unsafe(method(pilotVaultUnlock:))]
        fn unlock(&self, _notification: &NSNotification) {
            SESSION.with(|state| { let mut state = state.borrow_mut(); state.unlocked = true; state.active = active_console(); });
            recover("screen_unlocked");
        }
    }
);

pub(super) fn install() {
    let Some(mtm) = MainThreadMarker::new() else {
        super::suspend("observer_unavailable");
        return;
    };
    OBSERVER.with(|cell| {
        if cell.borrow().is_some() {
            return;
        }
        let allocated = PilotVaultObserver::alloc(mtm).set_ivars(());
        // SAFETY: NSObject initialization and selectors declared above, on main
        // thread. Observer retained for the process/main-loop lifetime.
        let observer: Retained<PilotVaultObserver> = unsafe { msg_send![super(allocated), init] };
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        unsafe {
            for (name, selector) in [
                (
                    NSWorkspaceWillSleepNotification,
                    objc2::sel!(pilotVaultSleep:),
                ),
                (
                    NSWorkspaceScreensDidSleepNotification,
                    objc2::sel!(pilotVaultScreenSleep:),
                ),
                (
                    NSWorkspaceSessionDidResignActiveNotification,
                    objc2::sel!(pilotVaultResign:),
                ),
                (NSWorkspaceDidWakeNotification, objc2::sel!(pilotVaultWake:)),
                (
                    NSWorkspaceSessionDidBecomeActiveNotification,
                    objc2::sel!(pilotVaultActive:),
                ),
            ] {
                workspace.addObserver_selector_name_object(&observer, selector, Some(name), None);
            }
            // macOS distributed lock notifications are not a public stable API.
            // Missing unlock evidence fails closed; wake never substitutes for it.
            for (name, selector) in [
                ("com.apple.screenIsLocked", objc2::sel!(pilotVaultLock:)),
                ("com.apple.screenIsUnlocked", objc2::sel!(pilotVaultUnlock:)),
            ] {
                NSDistributedNotificationCenter::defaultCenter()
                    .addObserver_selector_name_object_suspensionBehavior(
                        &observer,
                        selector,
                        Some(&NSString::from_str(name)),
                        None,
                        NSNotificationSuspensionBehavior::DeliverImmediately,
                    );
            }
        }
        *cell.borrow_mut() = Some(observer);
    });
}
