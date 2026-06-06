use crate::core::error::{BackendError, Result};
use crate::core::process::background_tokio_command;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
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
}
