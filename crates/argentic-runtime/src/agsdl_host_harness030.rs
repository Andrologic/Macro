//! Local installation observations only. No model request or qualification.
use crate::process::{background_contained_tokio_command, ContainedBackgroundProcess};
use serde_json::{json, Value};
use std::{ffi::OsStr, io, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

#[cfg(unix)]
fn executable_in_path(name: &str, path: &OsStr) -> io::Result<Option<PathBuf>> {
    use std::os::unix::fs::PermissionsExt;
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(name);
        match std::fs::metadata(&candidate) {
            Ok(meta) if meta.is_file() && meta.permissions().mode() & 0o111 != 0 => {
                return Ok(Some(candidate))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn reported_version(output: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(output).ok()?.trim();
    let version = semver::Version::parse(text).ok()?;
    // Retain what the named executable actually reported, without rounding.
    (version.to_string() == text).then(|| text.to_owned())
}

/// `None` means the environment could not be assessed. The returned harness
/// remains unqualified and has no adapter, capabilities, models or grants.
#[cfg(unix)]
pub(crate) async fn observe(name: &str) -> Option<Value> {
    if !matches!(name, "opencode" | "pi") {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    let executable = match executable_in_path(name, &path).ok()? {
        Some(executable) => executable,
        None => {
            return Some(
                json!({"harness":name,"version":null,"installation":"missing", "adapterId":null,"qualified":false,"capabilities":[],"models":[],"defaultModel":null}),
            )
        }
    };
    let mut command = background_contained_tokio_command(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut process = ContainedBackgroundProcess::spawn(command).ok()?;
    let stdout = match process.take_stdout() {
        Some(stdout) => stdout,
        None => {
            let _ = process.terminate_bounded().await;
            return None;
        }
    };
    let observed = tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        stdout.take(257).read_to_end(&mut bytes).await?;
        Ok::<_, io::Error>(bytes)
    })
    .await;
    // Reap only through the supervisor, preserving the process identity while
    // it checks descendants. A timeout or incomplete inspection is unassessed.
    let status = process.terminate_bounded().await.ok()?;
    let bytes = observed.ok()?.ok()?;
    if !status.success() || bytes.len() > 256 {
        return None;
    }
    let version = reported_version(&bytes)?;
    Some(
        json!({"harness":name,"version":version,"installation":"available", "adapterId":null,"qualified":false,"capabilities":[],"models":[],"defaultModel":null}),
    )
}

#[cfg(not(unix))]
pub(crate) async fn observe(_: &str) -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_is_bounded_semver_without_coercion() {
        assert_eq!(reported_version(b"1.19.5\n"), Some("1.19.5".into()));
        for invalid in ["v1.19.5", "1.19", "1.19.5 trailing", "", "01.19.5"] {
            assert!(reported_version(invalid.as_bytes()).is_none());
        }
    }
    #[cfg(unix)]
    #[test]
    fn named_executable_must_be_an_executable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode");
        std::fs::write(&path, b"synthetic").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(executable_in_path("opencode", dir.path().as_os_str())
            .unwrap()
            .is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            executable_in_path("opencode", dir.path().as_os_str()).unwrap(),
            Some(path)
        );
    }
}
