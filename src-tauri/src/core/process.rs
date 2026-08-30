use std::ffi::OsStr;
use std::io;
use std::process::ExitStatus;
use std::time::Duration;

#[cfg(unix)]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(unix)]
use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};

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
#[cfg(target_os = "windows")]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process_handle: windows_sys::Win32::Foundation::HANDLE) -> i32;
}

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
#[cfg(unix)]
const CONTAINMENT_ID_ENV: &str = "MACRO_PROCESS_CONTAINMENT_ID";
#[cfg(unix)]
static NEXT_CONTAINMENT_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
type JobObjectHandle = OwnedHandle;

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct UnixContainmentMarker {
    file: std::fs::File,
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl UnixContainmentMarker {
    fn create(containment_id: &str) -> io::Result<Self> {
        use std::os::fd::AsRawFd;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("macro-process-{containment_id}-{nonce}.lock"));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            let error = io::Error::last_os_error();
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self { file, path })
    }
}

#[cfg(target_os = "macos")]
impl Drop for UnixContainmentMarker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

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
    #[cfg(unix)]
    containment_id: String,
    #[cfg(target_os = "macos")]
    containment_marker: UnixContainmentMarker,
    #[cfg(windows)]
    job_object: JobObjectHandle,
}

impl ContainedBackgroundProcess {
    pub fn spawn(mut command: tokio::process::Command) -> io::Result<Self> {
        apply_background_containment(&mut command);
        #[cfg(unix)]
        let containment_id = next_containment_id();
        #[cfg(unix)]
        command.env(CONTAINMENT_ID_ENV, &containment_id);
        #[cfg(target_os = "macos")]
        let containment_marker = {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;

            let marker = UnixContainmentMarker::create(&containment_id)?;
            let marker_descriptor = marker.file.as_raw_fd();
            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::fcntl(marker_descriptor, libc::F_SETFD, 0) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            marker
        };
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command
                    .as_std_mut()
                    .pre_exec(install_linux_process_supervisor);
            }
        }
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
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
        #[cfg(windows)]
        if let Err(error) = resume_child_process(&child) {
            unsafe { TerminateJobObject(job_object.as_raw_handle() as _, ERROR_PROCESS_ABORTED) };
            return Err(error);
        }
        Ok(Self {
            child,
            #[cfg(unix)]
            process_group_id,
            #[cfg(unix)]
            containment_id,
            #[cfg(target_os = "macos")]
            containment_marker,
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

    #[cfg(unix)]
    fn containment_marker_path(&self) -> Option<&Path> {
        #[cfg(target_os = "macos")]
        {
            Some(&self.containment_marker.path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
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
        let process_ids = suspend_unix_process_tree(
            self.process_group_id,
            &self.containment_id,
            self.containment_marker_path(),
        );
        for process_id in process_ids {
            signal_process(process_id, libc::SIGKILL);
        }
        if let Some(process_group_id) = self.process_group_id {
            signal_process_group(process_group_id, libc::SIGKILL);
        }
        let reap_timeout = if grace_period.is_zero() {
            HARD_REAP_TIMEOUT
        } else {
            grace_period
        };
        match tokio::time::timeout(reap_timeout, self.child.wait()).await {
            Ok(status) => status,
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "contained process tree did not exit after SIGKILL",
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

#[cfg(windows)]
fn resume_child_process(child: &tokio::process::Child) -> io::Result<()> {
    let Some(process_handle) = child.raw_handle() else {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "tokio child did not expose a raw process handle",
        ));
    };
    let status = unsafe { NtResumeProcess(process_handle) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "failed to resume contained process after job assignment: NTSTATUS {status:#x}"
        )))
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_id: u32, signal: i32) {
    let _ = unsafe { libc::kill(-(process_group_id as libc::pid_t), signal) };
}

#[cfg(unix)]
fn signal_process(process_id: u32, signal: i32) {
    let _ = unsafe { libc::kill(process_id as libc::pid_t, signal) };
}

#[cfg(unix)]
fn next_containment_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT_CONTAINMENT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(target_os = "linux")]
fn install_linux_process_supervisor() -> io::Result<()> {
    let mut status_pipe = [-1; 2];
    if unsafe { libc::pipe2(status_pipe.as_mut_ptr(), libc::O_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }

    let supervisor_process_id = unsafe { libc::fork() };
    if supervisor_process_id == -1 {
        unsafe {
            libc::close(status_pipe[0]);
            libc::close(status_pipe[1]);
        }
        return Err(io::Error::last_os_error());
    }
    if supervisor_process_id == 0 {
        unsafe {
            libc::close(status_pipe[0]);
        }
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == -1 {
            return Err(io::Error::last_os_error());
        }

        let command_process_id = unsafe { libc::fork() };
        if command_process_id == -1 {
            return Err(io::Error::last_os_error());
        }
        if command_process_id == 0 {
            unsafe {
                libc::close(status_pipe[1]);
            }
            return Ok(());
        }

        close_linux_file_descriptors_except(status_pipe[1]);
        supervise_linux_command(command_process_id, status_pipe[1]);
    }

    unsafe {
        libc::close(status_pipe[1]);
    }
    close_linux_file_descriptors_except(status_pipe[0]);
    let command_status = read_linux_command_status(status_pipe[0]);
    unsafe {
        libc::close(status_pipe[0]);
    }
    exit_linux_process_with_status(command_status)
}

#[cfg(target_os = "linux")]
fn supervise_linux_command(command_process_id: libc::pid_t, status_descriptor: i32) -> ! {
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let mut command_status_reported = false;
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(-1, &mut status, 0) };
        if waited == command_process_id {
            write_linux_command_status(status_descriptor, status);
            unsafe {
                libc::close(status_descriptor);
            }
            command_status_reported = true;
            continue;
        }
        if waited >= 0 {
            continue;
        }

        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::ECHILD) if command_status_reported => unsafe { libc::_exit(0) },
            _ => unsafe { libc::_exit(1) },
        }
    }
}

#[cfg(target_os = "linux")]
fn read_linux_command_status(descriptor: i32) -> i32 {
    let mut status = 0_i32;
    let mut read_bytes = 0_usize;
    while read_bytes < std::mem::size_of::<i32>() {
        let result = unsafe {
            libc::read(
                descriptor,
                (&mut status as *mut i32 as *mut u8).add(read_bytes) as *mut _,
                std::mem::size_of::<i32>() - read_bytes,
            )
        };
        if result > 0 {
            read_bytes += result as usize;
            continue;
        }
        if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        unsafe { libc::_exit(1) }
    }
    status
}

#[cfg(target_os = "linux")]
fn write_linux_command_status(descriptor: i32, status: i32) {
    let mut written_bytes = 0_usize;
    while written_bytes < std::mem::size_of::<i32>() {
        let result = unsafe {
            libc::write(
                descriptor,
                (&status as *const i32 as *const u8).add(written_bytes) as *const _,
                std::mem::size_of::<i32>() - written_bytes,
            )
        };
        if result > 0 {
            written_bytes += result as usize;
            continue;
        }
        if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return;
    }
}

#[cfg(target_os = "linux")]
fn close_linux_file_descriptors_except(preserved_descriptor: i32) {
    let close_range = |first: u32, last: u32| {
        first > last || unsafe { libc::syscall(libc::SYS_close_range, first, last, 0_u32) } == 0
    };
    let lower_closed =
        preserved_descriptor <= 0 || close_range(0, (preserved_descriptor - 1) as u32);
    let upper_closed = close_range((preserved_descriptor + 1) as u32, u32::MAX);
    if lower_closed && upper_closed {
        return;
    }

    for descriptor in 0..65_536 {
        if descriptor != preserved_descriptor {
            let _ = unsafe { libc::close(descriptor) };
        }
    }
}

#[cfg(target_os = "linux")]
fn exit_linux_process_with_status(status: i32) -> ! {
    if libc::WIFEXITED(status) {
        unsafe { libc::_exit(libc::WEXITSTATUS(status)) }
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        unsafe {
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
            libc::_exit(128 + signal);
        }
    }
    unsafe { libc::_exit(1) }
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct UnixProcessRecord {
    process_id: u32,
    parent_id: u32,
    process_group_id: u32,
}

#[cfg(unix)]
fn parse_unix_process_table(output: &str) -> Vec<UnixProcessRecord> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let process_id = fields.next()?.parse().ok()?;
            let parent_id = fields.next()?.parse().ok()?;
            let process_group_id = fields.next()?.parse().ok()?;
            Some(UnixProcessRecord {
                process_id,
                parent_id,
                process_group_id,
            })
        })
        .collect()
}

#[cfg(unix)]
fn read_unix_process_table() -> io::Result<Vec<UnixProcessRecord>> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            "ps failed while reading process descendants",
        ));
    }
    Ok(parse_unix_process_table(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(unix)]
fn descendant_process_ids(root_id: u32, table: &[UnixProcessRecord]) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for record in table {
        children_by_parent
            .entry(record.parent_id)
            .or_default()
            .push(record.process_id);
    }
    let mut descendants = HashSet::new();
    let mut pending = vec![root_id];
    while let Some(parent_id) = pending.pop() {
        if let Some(children) = children_by_parent.get(&parent_id) {
            for &child_id in children {
                if descendants.insert(child_id) {
                    pending.push(child_id);
                }
            }
        }
    }
    descendants
}

#[cfg(target_os = "linux")]
fn processes_with_containment_id(containment_id: &str) -> HashSet<u32> {
    let expected = format!("{CONTAINMENT_ID_ENV}={containment_id}").into_bytes();
    let own_process_id = std::process::id();
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let process_id = entry.file_name().to_str()?.parse::<u32>().ok()?;
            if process_id == own_process_id {
                return None;
            }
            let environment = std::fs::read(entry.path().join("environ")).ok()?;
            environment
                .split(|byte| *byte == 0)
                .any(|value| value == expected)
                .then_some(process_id)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn processes_with_containment_marker(marker_path: Option<&Path>) -> HashSet<u32> {
    let Some(marker_path) = marker_path else {
        return HashSet::new();
    };
    let own_process_id = std::process::id();
    let Ok(output) = std::process::Command::new("/usr/sbin/lsof")
        .args(["-n", "-P", "-F", "p", "--"])
        .arg(marker_path)
        .output()
    else {
        return HashSet::new();
    };
    if !output.status.success() {
        return HashSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p')?.parse::<u32>().ok())
        .filter(|process_id| *process_id != own_process_id)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn processes_with_containment_marker(_marker_path: Option<&Path>) -> HashSet<u32> {
    HashSet::new()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn processes_with_containment_id(containment_id: &str) -> HashSet<u32> {
    let expected = format!("{CONTAINMENT_ID_ENV}={containment_id}");
    let own_process_id = std::process::id();
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axeww", "-o", "pid=,command="])
        .output()
    else {
        return HashSet::new();
    };
    if !output.status.success() {
        return HashSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let split_at = line.find(char::is_whitespace)?;
            let process_id = line[..split_at].parse::<u32>().ok()?;
            (process_id != own_process_id && line[split_at..].contains(&expected))
                .then_some(process_id)
        })
        .collect()
}

#[cfg(unix)]
fn suspend_unix_process_tree(
    root_id: Option<u32>,
    containment_id: &str,
    containment_marker_path: Option<&Path>,
) -> Vec<u32> {
    if let Some(root_id) = root_id {
        signal_process_group(root_id, libc::SIGSTOP);
    }
    let mut process_ids = root_id.into_iter().collect::<HashSet<_>>();
    for _ in 0..8 {
        let previous_len = process_ids.len();
        process_ids.extend(processes_with_containment_id(containment_id));
        process_ids.extend(processes_with_containment_marker(containment_marker_path));
        if let Ok(table) = read_unix_process_table() {
            if let Some(process_group_id) = root_id {
                process_ids.extend(
                    table
                        .iter()
                        .filter(|record| record.process_group_id == process_group_id)
                        .map(|record| record.process_id),
                );
            }
            let roots = process_ids.iter().copied().collect::<Vec<_>>();
            for root in roots {
                process_ids.extend(descendant_process_ids(root, &table));
            }
        }
        for &process_id in &process_ids {
            signal_process(process_id, libc::SIGSTOP);
        }
        if process_ids.len() == previous_len {
            break;
        }
        std::thread::yield_now();
    }
    let mut process_ids = process_ids.into_iter().collect::<Vec<_>>();
    process_ids.sort_unstable();
    process_ids
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
            for process_id in suspend_unix_process_tree(
                self.process_group_id,
                &self.containment_id,
                self.containment_marker_path(),
            ) {
                signal_process(process_id, libc::SIGKILL);
            }
            if let Some(process_group_id) = self.process_group_id {
                signal_process_group(process_group_id, libc::SIGKILL);
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

    #[cfg(target_os = "macos")]
    const MACOS_DOUBLE_FORK_HELPER_ENV: &str = "MACRO_TEST_DOUBLE_FORK_MARKER";
    #[cfg(target_os = "macos")]
    const MACOS_DOUBLE_FORK_ARGV0_PREFIX: &str = "macro-double-fork-marker=";
    #[cfg(target_os = "macos")]
    const MACOS_DOUBLE_FORK_TEST_NAME: &str =
        "core::process::tests::contained_process_terminates_a_macos_double_fork_with_cleared_environment";

    #[cfg(target_os = "macos")]
    fn macos_double_fork_reexec_marker() -> Option<std::path::PathBuf> {
        std::env::args()
            .next()?
            .strip_prefix(MACOS_DOUBLE_FORK_ARGV0_PREFIX)
            .map(std::path::PathBuf::from)
    }

    #[cfg(target_os = "macos")]
    fn spawn_macos_double_fork_helper_if_requested() -> bool {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let Ok(marker) = std::env::var(MACOS_DOUBLE_FORK_HELPER_ENV) else {
            return false;
        };
        let executable = std::env::current_exe().expect("current test executable");
        let executable = CString::new(executable.as_os_str().as_bytes()).expect("executable path");
        let helper_argv0 = CString::new(format!("{MACOS_DOUBLE_FORK_ARGV0_PREFIX}{marker}"))
            .expect("helper marker argument");
        let test_name = CString::new(MACOS_DOUBLE_FORK_TEST_NAME).expect("test name");
        let exact = CString::new("--exact").expect("exact argument");
        let nocapture = CString::new("--nocapture").expect("nocapture argument");
        let arguments = [
            helper_argv0.as_ptr(),
            test_name.as_ptr(),
            exact.as_ptr(),
            nocapture.as_ptr(),
            std::ptr::null(),
        ];
        let empty_environment = [std::ptr::null()];

        unsafe {
            let session_child = libc::fork();
            if session_child == -1 {
                libc::_exit(111);
            }
            if session_child != 0 {
                return true;
            }
            if libc::setsid() == -1 {
                libc::_exit(112);
            }
            let daemon = libc::fork();
            if daemon == -1 {
                libc::_exit(113);
            }
            if daemon != 0 {
                libc::_exit(0);
            }
            libc::execve(
                executable.as_ptr(),
                arguments.as_ptr(),
                empty_environment.as_ptr(),
            );
            libc::_exit(114);
        }
    }

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

    #[cfg(windows)]
    #[tokio::test]
    async fn contained_process_captures_an_immediate_windows_descendant() {
        use super::{background_contained_tokio_command, ContainedBackgroundProcess};
        use std::time::Duration;
        let temp = tempfile::TempDir::new().expect("temp dir");
        let marker = temp.path().join("escaped-descendant.txt");
        let child_script = format!(
            "Start-Sleep -Milliseconds 750; Set-Content -LiteralPath '{}' -Value escaped",
            marker.to_string_lossy().replace('\'', "''")
        );
        let parent_script = format!(
            "Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList @('-NoProfile','-Command','{}')",
            child_script.replace('\'', "''")
        );
        let mut command = background_contained_tokio_command("powershell.exe");
        command.args(["-NoProfile", "-Command", &parent_script]);
        let mut process = ContainedBackgroundProcess::spawn(command).expect("spawn parent");
        process.wait().await.expect("wait parent");
        process
            .terminate_with_grace(Duration::ZERO)
            .await
            .expect("terminate job");
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        assert!(!marker.exists(), "descendant escaped its Windows job");
    }

    #[cfg(unix)]
    #[test]
    fn unix_process_table_finds_nested_descendants() {
        let table = super::parse_unix_process_table("10 1 10\n11 10 10\n12 11 12\n20 1 20\n");
        let descendants = super::descendant_process_ids(10, &table);

        assert_eq!(descendants, [11, 12].into_iter().collect());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn contained_process_terminates_a_setsid_descendant() {
        use super::{background_contained_tokio_command, ContainedBackgroundProcess};
        use std::process::Stdio;
        use std::time::Duration;

        let setsid_available = std::process::Command::new("sh")
            .args(["-c", "command -v setsid >/dev/null 2>&1"])
            .status()
            .expect("probe setsid")
            .success();
        if !setsid_available {
            return;
        }

        let temp = tempfile::TempDir::new().expect("temp dir");
        let marker = temp.path().join("escaped-descendant.txt");
        let marker_arg = marker.to_string_lossy().replace('\'', "'\\''");
        let script = format!(
            "setsid sh -c 'sleep 1; printf survived > \"$1\"' sh '{marker_arg}' & sleep 30"
        );
        let mut command = background_contained_tokio_command("sh");
        command
            .args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ContainedBackgroundProcess::spawn(command).expect("spawn parent");
        tokio::time::sleep(Duration::from_millis(150)).await;
        process
            .terminate_with_grace(Duration::ZERO)
            .await
            .expect("terminate contained process tree");
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(!marker.exists(), "setsid descendant escaped containment");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn contained_process_wait_preserves_the_command_exit_status() {
        use super::{background_contained_tokio_command, ContainedBackgroundProcess};
        use std::process::Stdio;
        use std::time::Duration;

        let mut command = background_contained_tokio_command("sh");
        command
            .args(["-c", "exit 23"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ContainedBackgroundProcess::spawn(command).expect("spawn command");
        let status = tokio::time::timeout(Duration::from_secs(1), process.wait())
            .await
            .expect("wait must return after the command exits")
            .expect("wait for command status");

        assert_eq!(status.code(), Some(23));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn contained_process_terminates_a_double_fork_with_cleared_environment() {
        use super::{background_contained_tokio_command, ContainedBackgroundProcess};
        use std::process::Stdio;
        use std::time::Duration;

        let setsid_available = std::process::Command::new("sh")
            .args(["-c", "command -v setsid >/dev/null 2>&1"])
            .status()
            .expect("probe setsid")
            .success();
        if !setsid_available {
            return;
        }

        let temp = tempfile::TempDir::new().expect("temp dir");
        let marker = temp.path().join("escaped-cleared-environment.txt");
        let marker_arg = marker.to_string_lossy().replace('\'', "'\\''");
        let script = format!(
            "setsid -f env -i /bin/sh -c 'sleep 1; printf survived > \"$1\"' sh '{marker_arg}'"
        );
        let mut command = background_contained_tokio_command("sh");
        command
            .args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ContainedBackgroundProcess::spawn(command).expect("spawn parent");
        // The shell and setsid launcher both exit before this delay. The
        // per-command subreaper remains alive while the daemon is running.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let status = tokio::time::timeout(Duration::from_secs(1), process.wait())
            .await
            .expect("wait must return after the command exits")
            .expect("wait for command status");
        assert!(status.success(), "the command status must be preserved");
        process
            .terminate_with_grace(Duration::ZERO)
            .await
            .expect("terminate double-forked process tree");
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(
            !marker.exists(),
            "double-forked descendant with a cleared environment escaped containment"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn contained_process_terminates_a_macos_double_fork_with_cleared_environment() {
        use super::{background_contained_tokio_command, ContainedBackgroundProcess};
        use std::process::Stdio;
        use std::time::Duration;

        if let Some(marker) = macos_double_fork_reexec_marker() {
            std::thread::sleep(Duration::from_secs(1));
            std::fs::write(marker, "survived").expect("write escaped daemon marker");
            return;
        }
        if spawn_macos_double_fork_helper_if_requested() {
            return;
        }

        let temp = tempfile::TempDir::new().expect("temp dir");
        let marker = temp.path().join("escaped-macos-double-fork.txt");
        let mut command = background_contained_tokio_command(
            std::env::current_exe().expect("current test executable"),
        );
        command
            .args([MACOS_DOUBLE_FORK_TEST_NAME, "--exact", "--nocapture"])
            .env(MACOS_DOUBLE_FORK_HELPER_ENV, &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ContainedBackgroundProcess::spawn(command).expect("spawn helper");
        let status = tokio::time::timeout(Duration::from_secs(1), process.wait())
            .await
            .expect("wait must return after the helper exits")
            .expect("wait for helper status");
        assert!(status.success(), "the helper status must be preserved");
        process
            .terminate_with_grace(Duration::ZERO)
            .await
            .expect("terminate macOS double-forked process tree");
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(
            !marker.exists(),
            "macOS double-forked descendant with a cleared environment escaped containment"
        );
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
