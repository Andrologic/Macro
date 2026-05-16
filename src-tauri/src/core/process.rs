use std::ffi::OsStr;

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
