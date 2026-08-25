use std::ffi::OsStr;
use std::io;
use std::process::ExitStatus;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::Foundation::ERROR_PROCESS_ABORTED;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessLaunchVisibility {
    HiddenBackgroundLauncher,
    VisibleTerminal,
}

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(not(target_os = "windows"))]
pub const CREATE_NO_WINDOW: u32 = 0;

pub fn background_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    apply_std_visibility(
        &mut command,
        ProcessLaunchVisibility::HiddenBackgroundLauncher,
    );
    command
}

pub fn visible_terminal_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    apply_std_visibility(&mut command, ProcessLaunchVisibility::VisibleTerminal);
    command
}

pub fn background_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    apply_tokio_visibility(
        &mut command,
        ProcessLaunchVisibility::HiddenBackgroundLauncher,
    );
    command
}

pub fn visible_terminal_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    apply_tokio_visibility(&mut command, ProcessLaunchVisibility::VisibleTerminal);
    command
}

#[cfg(target_os = "windows")]
fn apply_std_visibility(command: &mut std::process::Command, visibility: ProcessLaunchVisibility) {
    use std::os::windows::process::CommandExt;

    if windows_creation_flags_for_visibility(visibility) != 0 {
        command.creation_flags(windows_creation_flags_for_visibility(visibility));
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_std_visibility(
    _command: &mut std::process::Command,
    _visibility: ProcessLaunchVisibility,
) {
}

#[cfg(target_os = "windows")]
fn apply_tokio_visibility(
    command: &mut tokio::process::Command,
    visibility: ProcessLaunchVisibility,
) {
    if windows_creation_flags_for_visibility(visibility) != 0 {
        command.creation_flags(windows_creation_flags_for_visibility(visibility));
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_tokio_visibility(
    _command: &mut tokio::process::Command,
    _visibility: ProcessLaunchVisibility,
) {
}

pub fn windows_creation_flags_for_visibility(visibility: ProcessLaunchVisibility) -> u32 {
    match visibility {
        ProcessLaunchVisibility::HiddenBackgroundLauncher => CREATE_NO_WINDOW,
        ProcessLaunchVisibility::VisibleTerminal => 0,
    }
}

pub fn is_known_visible_terminal_app_id(app_id: &str) -> bool {
    let app_id = app_id.trim().to_ascii_lowercase();
    matches!(
        app_id.as_str(),
        "windows-terminal"
            | "powershell"
            | "pwsh"
            | "command-prompt"
            | "wezterm"
            | "ghostty"
            | "kitty"
            | "terminal"
            | "gnome-terminal"
            | "konsole"
            | "xfce4-terminal"
            | "tilix"
            | "mate-terminal"
    )
}

pub const DEFAULT_TERMINATION_GRACE_PERIOD: Duration = Duration::from_secs(2);
const HARD_REAP_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
type JobObjectHandle = OwnedHandle;

pub fn background_contained_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = background_tokio_command(program);
    apply_background_containment(&mut command);
    command
}

pub fn apply_background_containment(command: &mut tokio::process::Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

#[derive(Debug)]
pub struct ContainedBackgroundProcess {
    child: tokio::process::Child,
    #[cfg(unix)]
    process_group_id: Option<u32>,
    #[cfg(windows)]
    job_object: JobObjectHandle,
}

impl ContainedBackgroundProcess {
    pub fn spawn(mut command: tokio::process::Command) -> io::Result<Self> {
        apply_background_containment(&mut command);
        let child = command.spawn()?;
        #[cfg(unix)]
        let process_group_id = child.id();
        #[cfg(windows)]
        let job_object = match attach_child_to_job_object(&child) {
            Ok(job_object) => job_object,
            Err(error) => {
                let mut child = child;
                let _ = child.start_kill();
                return Err(error);
            }
        };
        Ok(Self {
            child,
            #[cfg(unix)]
            process_group_id,
            #[cfg(windows)]
            job_object,
        })
    }

    pub fn spawn_background(program: impl AsRef<OsStr>) -> io::Result<Self> {
        Self::spawn(background_contained_tokio_command(program))
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    #[cfg(unix)]
    pub fn unix_process_group_id(&self) -> Option<u32> {
        self.process_group_id
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    pub async fn terminate_bounded(&mut self) -> io::Result<ExitStatus> {
        self.terminate_with_grace(DEFAULT_TERMINATION_GRACE_PERIOD)
            .await
    }

    pub async fn terminate_with_grace(&mut self, grace_period: Duration) -> io::Result<ExitStatus> {
        #[cfg(unix)]
        {
            self.terminate_unix(grace_period).await
        }
        #[cfg(windows)]
        {
            self.terminate_windows(grace_period).await
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = grace_period;
            self.child.start_kill()?;
            match tokio::time::timeout(HARD_REAP_TIMEOUT, self.child.wait()).await {
                Ok(status) => status,
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "contained process did not exit after kill",
                )),
            }
        }
    }

    #[cfg(unix)]
    async fn terminate_unix(&mut self, grace_period: Duration) -> io::Result<ExitStatus> {
        let mut graceful_status = None;
        if !grace_period.is_zero() {
            if let Some(process_group_id) = self.process_group_id {
                signal_process_group(process_group_id, libc::SIGTERM);
            }
            if let Ok(status) = tokio::time::timeout(grace_period, self.child.wait()).await {
                graceful_status = Some(status?);
            }
        }
        // The leader may exit while a detached descendant ignores SIGTERM. Always
        // close the original group before returning a graceful leader status.
        if let Some(process_group_id) = self.process_group_id {
            signal_process_group(process_group_id, libc::SIGKILL);
        }
        if let Some(status) = graceful_status {
            return Ok(status);
        }
        match tokio::time::timeout(HARD_REAP_TIMEOUT, self.child.wait()).await {
            Ok(status) => status,
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "contained process group did not exit after SIGKILL",
            )),
        }
    }

    #[cfg(windows)]
    async fn terminate_windows(&mut self, grace_period: Duration) -> io::Result<ExitStatus> {
        // Descendants can remain in the job after its original leader exits.
        // Terminating an empty job is harmless, so never gate this on child.id().
        unsafe { TerminateJobObject(self.job_object.as_raw_handle() as _, ERROR_PROCESS_ABORTED) };
        let reap_timeout = if grace_period.is_zero() {
            HARD_REAP_TIMEOUT
        } else {
            grace_period
        };
        match tokio::time::timeout(reap_timeout, self.child.wait()).await {
            Ok(status) => status,
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "contained process tree did not exit after job termination",
            )),
        }
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_id: u32, signal: i32) {
    let _ = unsafe { libc::kill(-(process_group_id as libc::pid_t), signal) };
}

#[cfg(windows)]
fn attach_child_to_job_object(child: &tokio::process::Child) -> io::Result<JobObjectHandle> {
    use std::mem::size_of_val;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let raw_job_object = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw_job_object.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job_object = JobObjectHandle::from_raw_handle(raw_job_object as _);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job_object.as_raw_handle() as _,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            size_of_val(&limits) as u32,
        );
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        let Some(process_handle) = child.raw_handle() else {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "tokio child did not expose a raw process handle",
            ));
        };
        if AssignProcessToJobObject(job_object.as_raw_handle() as _, process_handle) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job_object)
    }
}

impl Drop for ContainedBackgroundProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            if matches!(self.child.try_wait(), Ok(None)) {
                if let Some(process_group_id) = self.process_group_id {
                    signal_process_group(process_group_id, libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        {
            unsafe {
                TerminateJobObject(self.job_object.as_raw_handle() as _, ERROR_PROCESS_ABORTED)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_known_visible_terminal_app_id, windows_creation_flags_for_visibility,
        ProcessLaunchVisibility, CREATE_NO_WINDOW,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn background_visibility_maps_to_hidden_windows_flag() {
        assert_eq!(
            windows_creation_flags_for_visibility(
                ProcessLaunchVisibility::HiddenBackgroundLauncher
            ),
            CREATE_NO_WINDOW
        );
    }

    #[test]
    fn visible_terminal_visibility_has_no_hidden_windows_flag() {
        assert_eq!(
            windows_creation_flags_for_visibility(ProcessLaunchVisibility::VisibleTerminal),
            0
        );
    }

    #[test]
    fn visible_terminal_app_ids_are_case_insensitive() {
        assert!(is_known_visible_terminal_app_id("PowerShell"));
        assert!(is_known_visible_terminal_app_id("windows-terminal"));
        assert!(!is_known_visible_terminal_app_id("code"));
    }

    #[test]
    fn application_processes_use_process_wrappers() {
        let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut violations = Vec::new();
        scan_for_raw_command_new(&src_root, &mut violations);

        assert!(
            violations.is_empty(),
            "Use background_command/background_tokio_command/visible_terminal_command for process launches:\n{}",
            violations.join("\n")
        );
    }

    fn scan_for_raw_command_new(path: &Path, violations: &mut Vec<String>) {
        let entries = fs::read_dir(path).expect("read source directory");
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_for_raw_command_new(&path, violations);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("rs") {
                continue;
            }
            if is_raw_command_new_exception(&path) {
                continue;
            }

            let content = fs::read_to_string(&path).expect("read source file");
            for (index, line) in content.lines().enumerate() {
                if line.contains("Command::new(")
                    || line.contains("std::process::Command::new(")
                    || line.contains("tokio::process::Command::new(")
                {
                    violations.push(format!("{}:{}: {}", path.display(), index + 1, line.trim()));
                }
            }
        }
    }

    fn is_raw_command_new_exception(path: &Path) -> bool {
        let normalized = path.to_string_lossy().replace('\\', "/");
        normalized.ends_with("/src/core/process.rs")
            || normalized.ends_with("/src/core/environment.rs")
            || normalized.contains("/tests/")
    }
}
