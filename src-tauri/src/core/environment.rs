use std::collections::HashSet;
use std::ffi::OsString;
use std::process::Command;

#[cfg(target_os = "macos")]
const REQUIRED_MACOS_PATHS: [&str; 7] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

pub fn init_process_environment() {
    #[cfg(target_os = "macos")]
    init_macos_process_environment();
}

#[cfg(target_os = "macos")]
fn init_macos_process_environment() {
    let shell_path = load_path_from_path_helper();
    let current_path = std::env::var("PATH").ok();
    let merged = merge_path_candidates(shell_path.as_deref(), current_path.as_deref());
    std::env::set_var("PATH", merged);
}

#[cfg(target_os = "macos")]
fn load_path_from_path_helper() -> Option<String> {
    let output = Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    extract_path_from_path_helper_output(&stdout)
}

#[cfg(target_os = "macos")]
fn extract_path_from_path_helper_output(output: &str) -> Option<String> {
    let marker = "PATH=\"";
    let start = output.find(marker)? + marker.len();
    let remainder = &output[start..];
    let end = remainder.find('"')?;
    let path = remainder[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(target_os = "macos")]
fn merge_path_candidates(shell_path: Option<&str>, current_path: Option<&str>) -> OsString {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();

    for entry in REQUIRED_MACOS_PATHS {
        if seen.insert(entry.to_string()) {
            ordered.push(entry.to_string());
        }
    }

    for source in [shell_path, current_path] {
        if let Some(path) = source {
            for entry in path.split(':').map(str::trim).filter(|value| !value.is_empty()) {
                if seen.insert(entry.to_string()) {
                    ordered.push(entry.to_string());
                }
            }
        }
    }

    OsString::from(ordered.join(":"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn extracts_path_from_path_helper_output() {
        let output = r#"PATH="/usr/bin:/bin:/opt/homebrew/bin"; export PATH;"#;
        assert_eq!(
            extract_path_from_path_helper_output(output).as_deref(),
            Some("/usr/bin:/bin:/opt/homebrew/bin")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn merges_required_and_discovered_paths_without_duplicates() {
        let merged = merge_path_candidates(
            Some("/usr/bin:/bin:/opt/homebrew/bin"),
            Some("/Users/example/bin:/usr/local/bin:/usr/bin"),
        );
        assert_eq!(
            merged.to_string_lossy(),
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/example/bin"
        );
    }
}
