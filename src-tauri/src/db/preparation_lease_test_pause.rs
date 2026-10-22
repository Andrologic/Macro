//! Test-only native worker pause shared by the two preparation owners.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Condvar, Mutex,
};
pub(crate) struct Pause {
    pub entered: mpsc::Sender<()>,
    pub once: AtomicBool,
    pub released: Mutex<bool>,
    pub wake: Condvar,
}
impl Pause {
    fn wait(&self) -> i32 {
        if self.once.swap(true, Ordering::SeqCst) {
            return 0;
        }
        if self.entered.send(()).is_err() {
            return 1;
        }
        let Ok(mut released) = self.released.lock() else {
            return 1;
        };
        while !*released {
            match self.wake.wait(released) {
                Ok(value) => released = value,
                Err(_) => return 1,
            }
        }
        0
    }
    pub fn release(&self) {
        if let Ok(mut released) = self.released.lock() {
            *released = true;
            self.wake.notify_all();
        }
    }
}
pub(crate) unsafe extern "C" fn hold_commit(context: *mut std::ffi::c_void) -> i32 {
    // Context is an Arc kept by the test and OS controller until worker close.
    unsafe { &*context.cast::<Pause>() }.wait()
}
pub(crate) unsafe extern "C" fn hold_begin(
    context: *mut std::ffi::c_void,
    action: i32,
    arg: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> i32 {
    if action == libsqlite3_sys::SQLITE_TRANSACTION
        && !arg.is_null()
        && unsafe { std::ffi::CStr::from_ptr(arg) }.to_bytes() == b"BEGIN"
    {
        unsafe { &*context.cast::<Pause>() }.wait()
    } else {
        libsqlite3_sys::SQLITE_OK
    }
}
