//! Observers only invalidate state. Waking/unlocking never starts keychain I/O.
use objc2::{define_class, msg_send, rc::Retained, MainThreadOnly};
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceScreensDidSleepNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSDistributedNotificationCenter, NSNotification,
    NSNotificationSuspensionBehavior, NSObject, NSObjectProtocol, NSString,
};
use std::cell::RefCell;

thread_local! {
    static OBSERVER: RefCell<Option<Retained<PilotVaultObserver>>> = const { RefCell::new(None) };
}

define_class!(
    // SAFETY: No Rust ivars; NSObject has no additional subclass requirements.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct PilotVaultObserver;
    unsafe impl NSObjectProtocol for PilotVaultObserver {}
    impl PilotVaultObserver {
        #[unsafe(method(pilotVaultSuspend:))]
        fn vault_suspend(&self, _notification: &NSNotification) { super::suspend(); }
    }
);

pub(super) fn install() {
    let Some(mtm) = MainThreadMarker::new() else {
        super::suspend();
        return;
    };
    OBSERVER.with(|cell| {
        if cell.borrow().is_some() {
            return;
        }
        let allocated = PilotVaultObserver::alloc(mtm).set_ivars(());
        // SAFETY: NSObject initialization and selectors declared above, on main
        // thread. The observer is retained for the process/main-loop lifetime.
        let observer: Retained<PilotVaultObserver> = unsafe { msg_send![super(allocated), init] };
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        unsafe {
            for name in [
                NSWorkspaceWillSleepNotification,
                NSWorkspaceScreensDidSleepNotification,
                NSWorkspaceSessionDidResignActiveNotification,
            ] {
                workspace.addObserver_selector_name_object(
                    &observer,
                    objc2::sel!(pilotVaultSuspend:),
                    Some(name),
                    None,
                );
            }
            // macOS lock notification. The documented workspace session/sleep
            // notifications above also suspend conservatively.
            NSDistributedNotificationCenter::defaultCenter()
                .addObserver_selector_name_object_suspensionBehavior(
                    &observer,
                    objc2::sel!(pilotVaultSuspend:),
                    Some(&NSString::from_str("com.apple.screenIsLocked")),
                    None,
                    NSNotificationSuspensionBehavior::DeliverImmediately,
                );
        }
        *cell.borrow_mut() = Some(observer);
    });
}
