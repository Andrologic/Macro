use crate::core::error::{BackendError, Result};
use crate::core::process::background_tokio_command;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslProjectPath {
    pub distro: String,
    pub linux_path: String,
    pub original_path: String,
    pub unc_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectPathKind {
    Windows(PathBuf),
    Wsl(WslProjectPath),
}

#[derive(Debug, Clone)]
pub struct WslCommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl WslCommandOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }

    pub fn combined_text(&self) -> String {
        let stdout = self.stdout_text();
        let stderr = self.stderr_text();
        match (stdout.is_empty(), stderr.is_empty()) {
            (true, true) => String::new(),
            (false, true) => stdout,
            (true, false) => stderr,
            (false, false) => format!("{}\n{}", stdout, stderr),
        }
    }
}

#[derive(Debug)]
pub struct BoundedWslStream {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: usize,
}

impl BoundedWslStream {
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn retained_bytes(&self) -> usize {
        self.head.len().saturating_add(self.tail.len())
    }

    pub fn truncated(&self) -> bool {
        self.total_bytes > self.retained_bytes()
    }

    pub fn text(&self, label: &str) -> String {
        let mut text = String::from_utf8_lossy(&self.head).into_owned();
        if self.truncated() {
            let omitted = self.total_bytes.saturating_sub(self.retained_bytes());
            text.push_str(&format!(
                "\n\n[... {label} TRUNCATED: omitted {omitted} bytes; retained the first {} and last {} bytes ...]\n\n",
                self.head.len(),
                self.tail.len()
            ));
        }
        if !self.tail.is_empty() {
            let tail = self.tail.iter().copied().collect::<Vec<_>>();
            text.push_str(&String::from_utf8_lossy(&tail));
        }
        text.trim().to_string()
    }
}

struct BoundedByteCollector {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    head_limit: usize,
    tail_limit: usize,
    total_bytes: usize,
}

impl BoundedByteCollector {
    fn new(max_bytes: usize) -> Self {
        let max_bytes = max_bytes.max(2);
        let tail_limit = max_bytes / 4;
        Self {
            head: Vec::with_capacity(max_bytes.saturating_sub(tail_limit)),
            tail: VecDeque::with_capacity(tail_limit),
            head_limit: max_bytes.saturating_sub(tail_limit),
            tail_limit,
            total_bytes: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        let head_remaining = self.head_limit.saturating_sub(self.head.len());
        let split = head_remaining.min(bytes.len());
        self.head.extend_from_slice(&bytes[..split]);
        if split < bytes.len() && self.tail_limit > 0 {
            self.tail.extend(&bytes[split..]);
            let excess = self.tail.len().saturating_sub(self.tail_limit);
            self.tail.drain(..excess);
        }
    }

    fn finish(self) -> BoundedWslStream {
        BoundedWslStream {
            head: self.head,
            tail: self.tail,
            total_bytes: self.total_bytes,
        }
    }
}

#[derive(Debug)]
pub struct BoundedWslCommandOutput {
    pub status: ExitStatus,
    pub stdout: BoundedWslStream,
    pub stderr: BoundedWslStream,
}

async fn read_bounded_stream<R>(
    mut reader: R,
    max_bytes: usize,
) -> std::io::Result<BoundedWslStream>
where
    R: AsyncRead + Unpin,
{
    let mut collector = BoundedByteCollector::new(max_bytes);
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        collector.push(&chunk[..read]);
    }
    Ok(collector.finish())
}

fn normalize_wsl_linux_path(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| part.replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", joined.trim_matches('/'))
    }
}

pub fn wsl_unc_path(distro: &str, linux_path: &str) -> String {
    let path = linux_path.trim_start_matches('/').replace('/', "\\");
    if path.is_empty() {
        format!(r"\\wsl.localhost\{}", distro)
    } else {
        format!(r"\\wsl.localhost\{}\{}", distro, path)
    }
}

pub fn parse_wsl_unc_path(value: &str) -> Option<WslProjectPath> {
    let original_path = value.trim().to_string();
    let normalized = original_path.replace('/', "\\");
    let normalized_lower = normalized.to_ascii_lowercase();
    let without_prefix = if normalized_lower.starts_with(r"\\wsl$\") {
        &normalized[r"\\wsl$\".len()..]
    } else if normalized_lower.starts_with(r"\\wsl.localhost\") {
        &normalized[r"\\wsl.localhost\".len()..]
    } else {
        return None;
    };
    let parts = without_prefix
        .split('\\')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let distro = parts.first()?.trim();
    if distro.is_empty() {
        return None;
    }
    let linux_path = normalize_wsl_linux_path(&parts[1..]);
    Some(WslProjectPath {
        distro: distro.to_string(),
        unc_path: wsl_unc_path(distro, &linux_path),
        linux_path,
        original_path,
    })
}

pub fn classify_project_path(workspace_path: &Path, value: &str) -> ProjectPathKind {
    if let Some(wsl_path) = parse_wsl_unc_path(value) {
        return ProjectPathKind::Wsl(wsl_path);
    }
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace_path.join(path)
    };
    ProjectPathKind::Windows(resolved)
}

pub fn is_wsl_path(value: &str) -> bool {
    parse_wsl_unc_path(value).is_some()
}

pub fn join_wsl_path(base: &WslProjectPath, relative_path: &str) -> Result<WslProjectPath> {
    let relative = relative_path.trim().replace('\\', "/");
    if relative.is_empty() || relative == "." {
        return Ok(base.clone());
    }
    if relative.starts_with('/') {
        return Ok(WslProjectPath {
            distro: base.distro.clone(),
            unc_path: wsl_unc_path(&base.distro, &relative),
            linux_path: normalize_linux_path(&relative)?,
            original_path: wsl_unc_path(&base.distro, &relative),
        });
    }
    let joined = format!("{}/{}", base.linux_path.trim_end_matches('/'), relative);
    let linux_path = normalize_linux_path(&joined)?;
    Ok(WslProjectPath {
        distro: base.distro.clone(),
        unc_path: wsl_unc_path(&base.distro, &linux_path),
        linux_path,
        original_path: base.original_path.clone(),
    })
}

pub fn normalize_linux_path(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    let is_absolute = path.starts_with('/');
    let normalized_separators = path.replace('\\', "/");
    for part in normalized_separators.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(BackendError::FilesystemPathOutsideWorkspace {
                        message: format!("Path escapes WSL workspace: {}", path),
                    });
                }
            }
            value => parts.push(value),
        }
    }
    let joined = parts.join("/");
    Ok(if is_absolute {
        if joined.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", joined)
        }
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    })
}

fn classify_wsl_launch_error(error: std::io::Error) -> BackendError {
    if error.kind() == std::io::ErrorKind::NotFound {
        BackendError::Git {
            message: "WSL is not available. Install or enable WSL, then try again.".to_string(),
        }
    } else if error.kind() == std::io::ErrorKind::PermissionDenied {
        BackendError::PermissionDenied("Permission denied while launching WSL.".to_string())
    } else {
        BackendError::Git {
            message: format!("Failed to launch WSL: {}", error),
        }
    }
}

fn classify_wsl_failure(wsl_path: &WslProjectPath, output: &WslCommandOutput) -> BackendError {
    let stderr = output.stderr_text();
    let lower = stderr.to_lowercase();
    if lower.contains("there is no distribution")
        || lower.contains("distribution") && lower.contains("not found")
        || lower.contains("specified distribution")
    {
        return BackendError::Git {
            message: format!("WSL distribution not found: {}", wsl_path.distro),
        };
    }
    if lower.contains("permission denied") {
        return BackendError::PermissionDenied(format!(
            "Permission denied in WSL distribution {}.",
            wsl_path.distro
        ));
    }
    BackendError::Git {
        message: if stderr.is_empty() {
            format!("WSL command failed in {}.", wsl_path.distro)
        } else {
            stderr
        },
    }
}

pub async fn run_wsl_command(
    wsl_path: &WslProjectPath,
    program: &str,
    args: &[String],
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    run_wsl_command_with_stdin(wsl_path, program, args, None, timeout_duration).await
}

async fn run_wsl_command_raw(
    wsl_path: &WslProjectPath,
    program: &str,
    args: &[String],
    stdin: Option<Vec<u8>>,
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let mut command = background_tokio_command("wsl.exe");
    command
        .arg("-d")
        .arg(&wsl_path.distro)
        .arg("--")
        .arg(program);
    for arg in args {
        command.arg(arg);
    }
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    command.kill_on_drop(true);
    let mut child = command.spawn().map_err(classify_wsl_launch_error)?;
    if let Some(input) = stdin {
        let mut child_stdin = child.stdin.take().ok_or_else(|| BackendError::Filesystem {
            message: "Failed to open stdin for the WSL command.".to_string(),
        })?;
        child_stdin
            .write_all(&input)
            .await
            .map_err(|error| BackendError::Filesystem {
                message: format!("Failed to write to WSL: {}", error),
            })?;
        drop(child_stdin);
    }
    let output = timeout(timeout_duration, child.wait_with_output())
        .await
        .map_err(|_| BackendError::Git {
            message: "WSL command timed out.".to_string(),
        })?
        .map_err(|error| BackendError::Git {
            message: format!("WSL command failed: {}", error),
        })?;
    let output = WslCommandOutput {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    };
    Ok(output)
}

async fn run_wsl_command_bounded_raw(
    wsl_path: &WslProjectPath,
    program: &str,
    args: &[String],
    timeout_duration: Duration,
    stdout_max_bytes: usize,
) -> Result<BoundedWslCommandOutput> {
    let mut command = background_tokio_command("wsl.exe");
    command
        .arg("-d")
        .arg(&wsl_path.distro)
        .arg("--")
        .arg(program)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for arg in args {
        command.arg(arg);
    }
    let mut child = command.spawn().map_err(classify_wsl_launch_error)?;
    let stdout = child.stdout.take().ok_or_else(|| BackendError::Git {
        message: "Failed to capture bounded WSL stdout.".to_string(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| BackendError::Git {
        message: "Failed to capture bounded WSL stderr.".to_string(),
    })?;
    let stdout_task = tokio::spawn(read_bounded_stream(stdout, stdout_max_bytes));
    let stderr_task = tokio::spawn(read_bounded_stream(stderr, 64 * 1024));

    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(result) => result.map_err(|error| BackendError::Git {
            message: format!("WSL command failed: {error}"),
        })?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(BackendError::Git {
                message: "WSL command timed out.".to_string(),
            });
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| BackendError::Git {
            message: format!("Failed to join bounded WSL stdout reader: {error}"),
        })?
        .map_err(|error| BackendError::Git {
            message: format!("Failed to read bounded WSL stdout: {error}"),
        })?;
    let stderr = stderr_task
        .await
        .map_err(|error| BackendError::Git {
            message: format!("Failed to join bounded WSL stderr reader: {error}"),
        })?
        .map_err(|error| BackendError::Git {
            message: format!("Failed to read bounded WSL stderr: {error}"),
        })?;
    Ok(BoundedWslCommandOutput {
        status,
        stdout,
        stderr,
    })
}

pub async fn run_wsl_command_with_stdin(
    wsl_path: &WslProjectPath,
    program: &str,
    args: &[String],
    stdin: Option<Vec<u8>>,
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let output = run_wsl_command_raw(wsl_path, program, args, stdin, timeout_duration).await?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(classify_wsl_failure(wsl_path, &output))
    }
}

pub async fn run_wsl_command_allow_failure(
    wsl_path: &WslProjectPath,
    program: &str,
    args: &[String],
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    run_wsl_command_raw(wsl_path, program, args, None, timeout_duration).await
}

pub async fn run_wsl_git(
    wsl_path: &WslProjectPath,
    args: &[String],
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let mut git_args = vec!["-C".to_string(), wsl_path.linux_path.clone()];
    git_args.extend(args.iter().cloned());
    match run_wsl_command(wsl_path, "git", &git_args, timeout_duration).await {
        Ok(output) => Ok(output),
        Err(BackendError::Git { message }) if message.to_lowercase().contains("git: not found") => {
            Err(BackendError::Git {
                message: format!(
                    "Git is not available in WSL distribution '{}'.",
                    wsl_path.distro
                ),
            })
        }
        Err(error) => Err(error),
    }
}

pub async fn run_wsl_git_allow_failure(
    wsl_path: &WslProjectPath,
    args: &[String],
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let mut git_args = vec!["-C".to_string(), wsl_path.linux_path.clone()];
    git_args.extend(args.iter().cloned());
    let output =
        run_wsl_command_allow_failure(wsl_path, "git", &git_args, timeout_duration).await?;
    if !output.status.success()
        && output
            .stderr_text()
            .to_lowercase()
            .contains("git: not found")
    {
        return Err(BackendError::Git {
            message: format!(
                "Git is not available in WSL distribution '{}'.",
                wsl_path.distro
            ),
        });
    }
    Ok(output)
}

pub async fn run_wsl_git_bounded_allow_failure(
    wsl_path: &WslProjectPath,
    args: &[String],
    timeout_duration: Duration,
    stdout_max_bytes: usize,
) -> Result<BoundedWslCommandOutput> {
    let mut git_args = vec!["-C".to_string(), wsl_path.linux_path.clone()];
    git_args.extend(args.iter().cloned());
    let output = run_wsl_command_bounded_raw(
        wsl_path,
        "git",
        &git_args,
        timeout_duration,
        stdout_max_bytes,
    )
    .await?;
    if !output.status.success()
        && output
            .stderr
            .text("WSL STDERR")
            .to_lowercase()
            .contains("git: not found")
    {
        return Err(BackendError::Git {
            message: format!(
                "Git is not available in WSL distribution '{}'.",
                wsl_path.distro
            ),
        });
    }
    Ok(output)
}

pub async fn run_wsl_shell(
    wsl_path: &WslProjectPath,
    script: &str,
    args: &[String],
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let mut shell_args = vec![
        "-lc".to_string(),
        script.to_string(),
        "macro-wsl".to_string(),
    ];
    shell_args.extend(args.iter().cloned());
    run_wsl_command(wsl_path, "sh", &shell_args, timeout_duration).await
}

pub async fn run_wsl_shell_with_stdin(
    wsl_path: &WslProjectPath,
    script: &str,
    args: &[String],
    stdin: Vec<u8>,
    timeout_duration: Duration,
) -> Result<WslCommandOutput> {
    let mut shell_args = vec![
        "-lc".to_string(),
        script.to_string(),
        "macro-wsl".to_string(),
    ];
    shell_args.extend(args.iter().cloned());
    run_wsl_command_with_stdin(wsl_path, "sh", &shell_args, Some(stdin), timeout_duration).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wsl_unc_supports_wsl_dollar() {
        let parsed = parse_wsl_unc_path(r"\\wsl$\Ubuntu\home\oscar\repo").expect("parse");
        assert_eq!(parsed.distro, "Ubuntu");
        assert_eq!(parsed.linux_path, "/home/oscar/repo");
        assert_eq!(parsed.unc_path, r"\\wsl.localhost\Ubuntu\home\oscar\repo");
    }

    #[test]
    fn parse_wsl_unc_supports_wsl_localhost() {
        let parsed = parse_wsl_unc_path(r"\\wsl.localhost\Debian\var\www\app").expect("parse");
        assert_eq!(parsed.distro, "Debian");
        assert_eq!(parsed.linux_path, "/var/www/app");
    }

    #[test]
    fn parse_wsl_unc_prefix_is_case_insensitive() {
        let parsed = parse_wsl_unc_path(r"\\WSL.LOCALHOST\Ubuntu\home\oscar\repo").expect("parse");
        assert_eq!(parsed.distro, "Ubuntu");
        assert_eq!(parsed.linux_path, "/home/oscar/repo");
    }

    #[test]
    fn normalize_linux_path_rejects_escape_above_root() {
        let error = normalize_linux_path("../secret").expect_err("escape rejected");
        assert!(matches!(
            error,
            BackendError::FilesystemPathOutsideWorkspace { .. }
        ));
    }

    #[test]
    fn bounded_wsl_stream_retains_head_tail_and_exact_byte_count() {
        let mut collector = BoundedByteCollector::new(8);
        collector.push(b"abcdefghij");
        let output = collector.finish();
        assert_eq!(output.total_bytes(), 10);
        assert_eq!(output.retained_bytes(), 8);
        assert!(output.truncated());
        let text = output.text("TEST");
        assert!(text.starts_with("abcdef"));
        assert!(text.ends_with("ij"));
        assert!(text.contains("omitted 2 bytes"));
    }
}
