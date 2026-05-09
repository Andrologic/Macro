use objc2::{define_class, msg_send, rc::Retained, MainThreadOnly};
use objc2_app_kit::{
    NSView, NSWindow, NSWindowButton, NSWindowDidExitFullScreenNotification,
    NSWindowWillCloseNotification, NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol,
};
use std::cell::RefCell;
use std::sync::{Mutex, OnceLock};

const DEFAULT_TRAFFIC_LIGHT_X: f64 = 15.0;
const DEFAULT_TRAFFIC_LIGHT_Y: f64 = 30.0;
const FULLSCREEN_EXIT_FAILSAFE_DELAY_SECONDS: f64 = 1.5;
const FULLSCREEN_EXIT_REAPPLY_DELAY_SECONDS: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrafficLightInset {
    pub x: f64,
    pub y: f64,
}

impl Default for TrafficLightInset {
    fn default() -> Self {
        Self {
            x: DEFAULT_TRAFFIC_LIGHT_X,
            y: DEFAULT_TRAFFIC_LIGHT_Y,
        }
    }
}

#[derive(Debug, Default)]
struct TrafficLightState {
    inset: TrafficLightInset,
    window_ptr: Option<usize>,
    fullscreen_exit_recovery: bool,
}

impl TrafficLightState {
    fn update_inset(&mut self, x: f64, y: f64) -> TrafficLightInset {
        self.inset = TrafficLightInset { x, y };
        self.inset
    }

    fn set_window(&mut self, window: &NSWindow) {
        self.set_window_ptr(window_ptr(window));
    }

    fn set_window_ptr(&mut self, ptr: usize) {
        self.window_ptr = Some(ptr);
    }

    fn clear_window_ptr(&mut self, ptr: usize) {
        if self.window_ptr == Some(ptr) {
            self.window_ptr = None;
            self.fullscreen_exit_recovery = false;
        }
    }

    fn begin_fullscreen_exit(&mut self) -> TrafficLightInset {
        self.fullscreen_exit_recovery = true;
        self.inset
    }

    fn finish_fullscreen_exit(&mut self) -> TrafficLightInset {
        self.fullscreen_exit_recovery = false;
        self.inset
    }
}

static TRAFFIC_LIGHT_STATE: OnceLock<Mutex<TrafficLightState>> = OnceLock::new();

thread_local! {
    static FULLSCREEN_OBSERVER: RefCell<Option<Retained<TrafficLightFullscreenObserver>>> =
        const { RefCell::new(None) };
}

fn traffic_light_state() -> &'static Mutex<TrafficLightState> {
    TRAFFIC_LIGHT_STATE.get_or_init(|| Mutex::new(TrafficLightState::default()))
}

fn with_state<T>(read: impl FnOnce(&mut TrafficLightState) -> T) -> T {
    let mut state = traffic_light_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    read(&mut state)
}

fn window_ptr(window: &NSWindow) -> usize {
    window as *const NSWindow as usize
}

fn remember_window(window: &NSWindow) {
    with_state(|state| state.set_window(window));
}

fn forget_window(window: &NSWindow) {
    let ptr = window_ptr(window);
    with_state(|state| state.clear_window_ptr(ptr));
}

fn stored_window_ptr() -> Option<*const NSWindow> {
    with_state(|state| state.window_ptr.map(|ptr| ptr as *const NSWindow))
}

fn with_stored_window(action: impl FnOnce(&NSWindow)) {
    let Some(window_ptr) = stored_window_ptr() else {
        return;
    };
    if window_ptr.is_null() {
        return;
    }

    // SAFETY: The pointer is captured from Tauri's main NSWindow and is only used
    // on the main AppKit thread while the application is alive.
    let window = unsafe { &*window_ptr };
    action(window);
}

fn window_from_notification(notification: &NSNotification) -> Option<Retained<NSWindow>> {
    notification.object()?.downcast::<NSWindow>().ok()
}

fn schedule_recovery(observer: &TrafficLightFullscreenObserver, delay_seconds: f64) {
    // SAFETY: The selector is implemented by TrafficLightFullscreenObserver below,
    // and scheduling happens on the AppKit main run loop.
    unsafe {
        let _: () = msg_send![
            observer,
            performSelector: objc2::sel!(recoverTrafficLightsAfterFullscreenExit:),
            withObject: Option::<&NSObject>::None,
            afterDelay: delay_seconds
        ];
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements for this observer, and
    // the class stores no Rust-owned ivars.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct TrafficLightFullscreenObserver;

    // SAFETY: NSObjectProtocol has no additional safety requirements.
    unsafe impl NSObjectProtocol for TrafficLightFullscreenObserver {}

    impl TrafficLightFullscreenObserver {
        #[unsafe(method_id(init))]
        fn init(this: objc2::rc::Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(());
            unsafe { msg_send![super(this), init] }
        }

        #[unsafe(method(windowWillExitFullScreen:))]
        fn window_will_exit_full_screen(&self, notification: &NSNotification) {
            handle_window_will_exit_full_screen(notification);
            schedule_recovery(self, FULLSCREEN_EXIT_FAILSAFE_DELAY_SECONDS);
        }

        #[unsafe(method(windowDidExitFullScreen:))]
        fn window_did_exit_full_screen(&self, notification: &NSNotification) {
            handle_window_did_exit_full_screen(notification);
            schedule_recovery(self, 0.0);
            schedule_recovery(self, FULLSCREEN_EXIT_REAPPLY_DELAY_SECONDS);
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, notification: &NSNotification) {
            handle_window_will_close(notification);
        }

        #[unsafe(method(recoverTrafficLightsAfterFullscreenExit:))]
        fn recover_traffic_lights_after_fullscreen_exit(&self, _object: Option<&NSObject>) {
            reapply_and_show_stored_traffic_lights();
        }
    }
);

impl TrafficLightFullscreenObserver {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let observer = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(observer), init] }
    }
}

pub fn install_fullscreen_recovery(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|webview| {
            // SAFETY: Tauri provides the owning NSWindow for this webview.
            let ns_window: &NSWindow = unsafe { &*webview.ns_window().cast() };
            remember_window(ns_window);
            let inset = with_state(|state| state.inset);
            unsafe {
                apply_traffic_light_inset(ns_window, inset);
            }

            FULLSCREEN_OBSERVER.with(|cell| {
                if cell.borrow().is_some() {
                    return;
                }

                let Some(mtm) = MainThreadMarker::new() else {
                    tracing::warn!(
                        "Cannot install macOS traffic light recovery off the main thread"
                    );
                    return;
                };

                let observer = TrafficLightFullscreenObserver::new(mtm);
                let center = NSNotificationCenter::defaultCenter();

                unsafe {
                    center.addObserver_selector_name_object(
                        &observer,
                        objc2::sel!(windowWillExitFullScreen:),
                        Some(NSWindowWillExitFullScreenNotification),
                        Some(ns_window),
                    );
                    center.addObserver_selector_name_object(
                        &observer,
                        objc2::sel!(windowDidExitFullScreen:),
                        Some(NSWindowDidExitFullScreenNotification),
                        Some(ns_window),
                    );
                    center.addObserver_selector_name_object(
                        &observer,
                        objc2::sel!(windowWillClose:),
                        Some(NSWindowWillCloseNotification),
                        Some(ns_window),
                    );
                }

                cell.replace(Some(observer));
            });
        })
        .map_err(|error| error.to_string())
}

pub async fn set_traffic_light_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let inset = with_state(|state| state.update_inset(x, y));
    let (sender, receiver) = tokio::sync::oneshot::channel();

    window
        .with_webview(move |webview| {
            let result = unsafe {
                let ns_window: &NSWindow = &*webview.ns_window().cast();
                remember_window(ns_window);
                apply_traffic_light_inset(ns_window, inset);
                set_traffic_light_buttons_hidden(ns_window, false);
                Ok::<(), String>(())
            };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;

    receiver.await.map_err(|error| error.to_string())?
}

fn handle_window_will_exit_full_screen(notification: &NSNotification) {
    let Some(window) = window_from_notification(notification) else {
        return;
    };
    remember_window(&window);
    let inset = with_state(|state| state.begin_fullscreen_exit());

    unsafe {
        set_traffic_light_buttons_hidden(&window, true);
        apply_traffic_light_inset(&window, inset);
    }
}

fn handle_window_did_exit_full_screen(notification: &NSNotification) {
    let Some(window) = window_from_notification(notification) else {
        return;
    };
    remember_window(&window);
    let inset = with_state(|state| state.finish_fullscreen_exit());

    unsafe {
        apply_traffic_light_inset(&window, inset);
        set_traffic_light_buttons_hidden(&window, false);
    }
}

fn handle_window_will_close(notification: &NSNotification) {
    let Some(window) = window_from_notification(notification) else {
        return;
    };
    forget_window(&window);
}

fn reapply_and_show_stored_traffic_lights() {
    let inset = with_state(|state| state.finish_fullscreen_exit());
    with_stored_window(|window| unsafe {
        apply_traffic_light_inset(window, inset);
        set_traffic_light_buttons_hidden(window, false);
    });
}

unsafe fn traffic_light_buttons(
    window: &NSWindow,
) -> Option<Vec<Retained<objc2_app_kit::NSButton>>> {
    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let miniaturize = window.standardWindowButton(NSWindowButton::MiniaturizeButton)?;
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    let mut buttons = vec![close, miniaturize];
    if let Some(zoom) = zoom {
        buttons.push(zoom);
    }
    Some(buttons)
}

pub unsafe fn apply_traffic_light_inset(window: &NSWindow, inset: TrafficLightInset) {
    let Some(buttons) = traffic_light_buttons(window) else {
        return;
    };
    let [close, miniaturize, ..] = buttons.as_slice() else {
        return;
    };

    let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
        return;
    };

    let close_rect = NSView::frame(close);
    let title_bar_frame_height = close_rect.size.height + inset.y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(miniaturize).origin.x - close_rect.origin.x;

    for (index, button) in buttons.iter().enumerate() {
        let mut rect = NSView::frame(button);
        rect.origin.x = inset.x + (index as f64 * space_between);
        button.setFrameOrigin(rect.origin);
    }

    title_bar_container_view.layoutSubtreeIfNeeded();
    title_bar_container_view.setNeedsDisplay(true);
    title_bar_container_view.displayIfNeeded();
}

unsafe fn set_traffic_light_buttons_hidden(window: &NSWindow, hidden: bool) {
    let Some(buttons) = traffic_light_buttons(window) else {
        return;
    };

    for button in buttons {
        button.setHidden(hidden);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_light_state_defaults_to_configured_inset() {
        let state = TrafficLightState::default();

        assert_eq!(state.inset, TrafficLightInset { x: 15.0, y: 30.0 });
        assert!(!state.fullscreen_exit_recovery);
    }

    #[test]
    fn traffic_light_state_updates_requested_inset() {
        let mut state = TrafficLightState::default();

        assert_eq!(
            state.update_inset(23.0, 45.0),
            TrafficLightInset { x: 23.0, y: 45.0 }
        );
        assert_eq!(state.inset, TrafficLightInset { x: 23.0, y: 45.0 });
    }

    #[test]
    fn fullscreen_recovery_reuses_latest_requested_inset() {
        let mut state = TrafficLightState::default();
        state.update_inset(30.0, 60.0);

        assert_eq!(
            state.begin_fullscreen_exit(),
            TrafficLightInset { x: 30.0, y: 60.0 }
        );
        assert!(state.fullscreen_exit_recovery);
        assert_eq!(
            state.finish_fullscreen_exit(),
            TrafficLightInset { x: 30.0, y: 60.0 }
        );
        assert!(!state.fullscreen_exit_recovery);
    }

    #[test]
    fn clearing_tracked_window_cancels_pending_recovery() {
        let mut state = TrafficLightState::default();
        state.set_window_ptr(42);
        state.begin_fullscreen_exit();

        state.clear_window_ptr(42);

        assert_eq!(state.window_ptr, None);
        assert!(!state.fullscreen_exit_recovery);
    }

    #[test]
    fn clearing_an_unrelated_window_keeps_current_recovery_state() {
        let mut state = TrafficLightState::default();
        state.set_window_ptr(42);
        state.begin_fullscreen_exit();

        state.clear_window_ptr(7);

        assert_eq!(state.window_ptr, Some(42));
        assert!(state.fullscreen_exit_recovery);
    }
}
