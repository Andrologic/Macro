//! Native, authenticated launch primitives. Callers must provide physical
//! termination and reap before this can be used for content reads.
use std::ffi::{c_char, c_void, CString};
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr::NonNull;
use std::time::Duration;

#[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
type QaOutputHook = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
#[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
static QA_OUTPUT_HOOK: std::sync::OnceLock<std::sync::Mutex<Option<QaOutputHook>>> =
    std::sync::OnceLock::new();

#[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
pub(super) fn pause_next_output(
) -> io::Result<(std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>)> {
    let (ready_send, ready_receive) = std::sync::mpsc::channel();
    let (release_send, release_receive) = std::sync::mpsc::channel();
    let mut hook = QA_OUTPUT_HOOK
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| io::Error::other("QA output hook poisoned"))?;
    if hook.is_some() {
        return Err(io::Error::other("QA output hook already installed"));
    }
    *hook = Some((ready_send, release_receive));
    Ok((ready_receive, release_send))
}

unsafe extern "C" {
    fn agsdl_content_macos_available() -> i32;
    fn agsdl_content_macos_launch(
        executable: *const c_char,
        component: *const c_char,
        parent_fd: i32,
        result: *mut *mut c_void,
        output_fd: *mut i32,
        control_fd: *mut i32,
    ) -> i32;
    fn agsdl_content_macos_wait_bounded(
        handle: *mut c_void,
        timeout_milliseconds: u32,
        status: *mut i32,
        signal: *mut i32,
    ) -> i32;
}

pub(super) fn available() -> bool {
    unsafe { agsdl_content_macos_available() == 1 }
}

#[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
unsafe extern "C" {
    fn agsdl_content_macos_qa_arm_swap(target: *const c_char, replacement: *const c_char) -> i32;
}

#[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
pub(super) fn arm_image_swap(target: &Path, replacement: &Path) -> io::Result<()> {
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid QA target"))?;
    let replacement = CString::new(replacement.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid QA replacement"))?;
    if unsafe { agsdl_content_macos_qa_arm_swap(target.as_ptr(), replacement.as_ptr()) } != 0 {
        return Err(io::Error::other("Cannot arm QA image substitution"));
    }
    Ok(())
}

pub(super) struct Launch {
    handle: Option<NonNull<c_void>>,
    pub(super) output: OwnedFd,
    control: Option<OwnedFd>,
}

// The native handle is used by one Rust owner and must not be accessed in
// parallel. Foundation's wait API may be called from a blocking worker.
unsafe impl Send for Launch {}

pub(super) struct Exit {
    pub(super) status: i32,
    pub(super) signal: bool,
}

impl Launch {
    #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
    pub(super) fn qa_handle_identity(&self) -> Option<usize> {
        self.handle.map(|handle| handle.as_ptr() as usize)
    }

    #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
    pub(super) fn qa_control_open(&self) -> bool {
        self.control.is_some()
    }

    pub(super) fn start(executable: &Path, name: &Path, parent_fd: RawFd) -> io::Result<Self> {
        let executable = CString::new(executable.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid helper executable")
        })?;
        let name = CString::new(name.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid file component"))?;
        let mut handle = std::ptr::null_mut();
        let mut output = -1;
        let mut control = -1;
        let code = unsafe {
            agsdl_content_macos_launch(
                executable.as_ptr(),
                name.as_ptr(),
                parent_fd,
                &mut handle,
                &mut output,
                &mut control,
            )
        };
        if code != 0 {
            return Err(io::Error::other(format!(
                "Content helper launch failed ({code})"
            )));
        }
        let handle = NonNull::new(handle)
            .ok_or_else(|| io::Error::other("Content helper returned no process"))?;
        if output < 0 || control < 0 {
            return Err(io::Error::other(
                "Content helper returned invalid descriptors",
            ));
        }
        Ok(Self {
            handle: Some(handle),
            output: unsafe { OwnedFd::from_raw_fd(output) },
            control: Some(unsafe { OwnedFd::from_raw_fd(control) }),
        })
    }

    /// Closing the only parent writer requests self-termination in the helper.
    pub(super) fn cancel(&mut self) {
        #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
        let control_fd = {
            use std::os::fd::AsRawFd;
            self.control.as_ref().map(AsRawFd::as_raw_fd)
        };
        self.control.take();
        #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
        if let Some(fd) = control_fd {
            let after = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            eprintln!("content QA: closed control fd {fd}; fcntl after={after}");
        }
    }

    /// A timeout does not consume the native handle. On completion Foundation
    /// reaps the process and the bridge consumes the handle exactly once.
    pub(super) fn wait(&mut self, timeout: Duration) -> io::Result<Option<Exit>> {
        let handle = self
            .handle
            .ok_or_else(|| io::Error::other("Helper already reaped"))?;
        let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
        let mut status = 0;
        let mut signal = 0;
        match unsafe {
            agsdl_content_macos_wait_bounded(handle.as_ptr(), millis, &mut status, &mut signal)
        } {
            0 => {
                self.handle = None;
                Ok(Some(Exit {
                    status,
                    signal: signal != 0,
                }))
            }
            5 => Ok(None),
            code => Err(io::Error::other(format!(
                "Content helper wait failed ({code})"
            ))),
        }
    }
}

/// The worker retains the native handle until Foundation proves process exit,
/// including after reporting uncertain termination to the asynchronous caller.
pub(super) fn read_supervised(
    executable: &Path,
    name: &Path,
    directory: OwnedFd,
    cancel: tokio_util::sync::CancellationToken,
    sender: tokio::sync::oneshot::Sender<io::Result<Vec<u8>>>,
) {
    use std::os::fd::AsRawFd;
    use std::time::Instant;

    if cancel.is_cancelled() {
        let _ = sender.send(Err(io::Error::other("Content read cancelled")));
        return;
    }
    let mut launch = match Launch::start(executable, name, directory.as_raw_fd()) {
        Ok(launch) => launch,
        Err(error) => {
            let _ = sender.send(Err(error));
            return;
        }
    };
    let mut sender = Some(sender);
    let mut bytes = Vec::new();
    let mut failure: Option<io::Error> = None;
    let mut cancelled_at: Option<Instant> = None;
    let mut exited: Option<Exit> = None;
    let mut eof = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    let fd = launch.output.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        failure = Some(io::Error::last_os_error());
    }
    loop {
        let mut made_progress = false;
        if failure.is_none() && (cancel.is_cancelled() || Instant::now() >= deadline) {
            failure = Some(io::Error::other(if cancel.is_cancelled() {
                "Content read cancelled"
            } else {
                "Content helper timed out"
            }));
        }
        if failure.is_some() && cancelled_at.is_none() {
            #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
            eprintln!("content QA: requesting helper cancellation");
            launch.cancel();
            cancelled_at = Some(Instant::now());
        }
        if exited.is_none() {
            match launch.wait(Duration::ZERO) {
                Ok(Some(status)) => exited = Some(status),
                Ok(None) => {}
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        if failure.is_none() && !eof {
            let mut buffer = [0u8; 8192];
            let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count > 0 {
                made_progress = true;
                bytes.extend_from_slice(&buffer[..count as usize]);
                #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
                {
                    let hook = QA_OUTPUT_HOOK
                        .get_or_init(Default::default)
                        .lock()
                        .ok()
                        .and_then(|mut hook| hook.take());
                    if let Some((ready, release)) = hook {
                        if ready.send(()).is_err()
                            || release.recv_timeout(Duration::from_secs(5)).is_err()
                        {
                            failure = Some(io::Error::other("QA output hook failed"));
                        }
                    }
                }
                if bytes.len() as u64 > super::file_helper::MAX_BYTES {
                    failure = Some(io::Error::other("Content exceeds limit"));
                }
            } else if count == 0 {
                eof = true;
            } else {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::WouldBlock
                    && error.kind() != io::ErrorKind::Interrupted
                {
                    failure = Some(error);
                }
            }
        }
        if let Some(status) = &exited {
            if failure.is_some() || eof {
                let result = if let Some(error) = failure.take() {
                    Err(error)
                } else if status.signal || status.status != 0 {
                    Err(match (status.signal, status.status) {
                        (false, 2) => io::Error::new(
                            io::ErrorKind::Unsupported,
                            "Content helper could not enforce its guard",
                        ),
                        (false, 3) => io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Content helper refused the file",
                        ),
                        _ => io::Error::other(format!(
                            "Content helper exited with status {} (signal: {})",
                            status.status, status.signal
                        )),
                    })
                } else if cancel.is_cancelled() {
                    Err(io::Error::other("Content read cancelled"))
                } else {
                    Ok(bytes)
                };
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
                return;
            }
        }
        if cancelled_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(5)) {
            if let Some(sender) = sender.take() {
                #[cfg(all(feature = "agsdl-content-qa", debug_assertions))]
                eprintln!("content QA: helper exit not observed after cancellation");
                let _ = sender.send(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Content helper termination is uncertain",
                )));
            }
        }
        if !made_progress {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
