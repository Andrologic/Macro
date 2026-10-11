//! The display name is a label, never an authentication or device identifier.
#[cfg(not(target_os = "windows"))]
use std::process::Command;

#[tauri::command]
pub fn pilot_device_name() -> String {
    #[cfg(target_os = "macos")]
    let name = Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    #[cfg(target_os = "windows")]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let name = Command::new("hostname")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    let name: String = name
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    if name.is_empty() {
        "Macro desktop".to_owned()
    } else {
        name
    }
}
