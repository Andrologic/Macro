use super::{command_error, CommandResult};
use crate::core::process::{
    background_command, is_known_visible_terminal_app_id, visible_terminal_command,
    ProcessLaunchVisibility,
};
use crate::project_path::{parse_wsl_unc_path, WslProjectPath};
use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExternalOpenAction {
    Editor,
    Terminal,
    Files,
}

impl ExternalOpenAction {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "editor" => Some(Self::Editor),
            "terminal" => Some(Self::Terminal),
            "files" => Some(Self::Files),
            _ => None,
        }
    }
}

impl ExternalOpenAction {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Terminal => "terminal",
            Self::Files => "files",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalAppOptionDto {
    pub id: String,
    pub label: String,
    pub action: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalAppCatalogDto {
    pub editor: Vec<ExternalAppOptionDto>,
    pub terminal: Vec<ExternalAppOptionDto>,
    pub files: Vec<ExternalAppOptionDto>,
}

struct ExternalLaunchCommand {
    program: String,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
}

fn external_launch_visibility(action: ExternalOpenAction, app_id: &str) -> ProcessLaunchVisibility {
    if action == ExternalOpenAction::Terminal && is_known_visible_terminal_app_id(app_id) {
        ProcessLaunchVisibility::VisibleTerminal
    } else {
        ProcessLaunchVisibility::HiddenBackgroundLauncher
    }
}

fn external_app_option(
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    kind: &str,
) -> ExternalAppOptionDto {
    ExternalAppOptionDto {
        id: id.to_string(),
        label: label.to_string(),
        action: action.as_str().to_string(),
        kind: kind.to_string(),
    }
}

fn none_external_app(action: ExternalOpenAction) -> ExternalAppOptionDto {
    external_app_option("none", "Do nothing", action, "none")
}

fn binary_candidates(binary: &str) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let path = Path::new(binary);
        if path.extension().is_some() {
            return vec![binary.to_string()];
        }

        return vec![
            format!("{}.exe", binary),
            format!("{}.cmd", binary),
            format!("{}.bat", binary),
            binary.to_string(),
        ];
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![binary.to_string()]
    }
}

fn is_binary_available(binary: &str) -> bool {
    resolve_binary_path(binary).is_some()
}

fn resolve_binary_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.exists().then(|| binary_path.to_path_buf());
    }

    let path_var = env::var_os("PATH")?;

    env::split_paths(&path_var).find_map(|dir| {
        binary_candidates(binary)
            .into_iter()
            .map(|candidate| dir.join(candidate))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(target_os = "macos")]
fn mac_app_bundle_path(names: &[&str]) -> Option<PathBuf> {
    let app_bundles = names
        .iter()
        .map(|name| {
            if name.ends_with(".app") {
                name.to_string()
            } else {
                format!("{}.app", name)
            }
        })
        .collect::<Vec<_>>();

    let mut candidate_roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices"),
    ];

    if let Some(home_dir) = env::var_os("HOME") {
        candidate_roots.push(PathBuf::from(&home_dir).join("Applications"));
        candidate_roots.push(PathBuf::from(home_dir).join("Applications/Utilities"));
    }

    candidate_roots.into_iter().find_map(|root| {
        app_bundles
            .iter()
            .map(|bundle| root.join(bundle))
            .find(|candidate| candidate.exists())
    })
}

#[cfg(target_os = "macos")]
fn mac_app_exists(names: &[&str]) -> bool {
    mac_app_bundle_path(names).is_some()
}

#[cfg(target_os = "macos")]
fn push_mac_app(
    apps: &mut Vec<ExternalAppOptionDto>,
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    bundle_names: &[&str],
    kind: &str,
) {
    if mac_app_exists(bundle_names) {
        apps.push(external_app_option(id, label, action, kind));
    }
}

#[cfg(target_os = "macos")]
fn mac_app_executable_path(bundle_names: &[&str], executable_names: &[&str]) -> Option<PathBuf> {
    let bundle_path = mac_app_bundle_path(bundle_names)?;
    let executable_dir = bundle_path.join("Contents/MacOS");

    for executable_name in executable_names {
        let candidate = executable_dir.join(executable_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    std::fs::read_dir(&executable_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn mac_binary_or_app_executable(
    binary_names: &[&str],
    bundle_names: &[&str],
    executable_names: &[&str],
) -> Option<String> {
    binary_names
        .iter()
        .find(|binary_name| is_binary_available(binary_name))
        .map(|binary_name| (*binary_name).to_string())
        .or_else(|| {
            mac_app_executable_path(bundle_names, executable_names)
                .map(|path| path.to_string_lossy().to_string())
        })
}

#[cfg(not(target_os = "macos"))]
fn push_binary_app(
    apps: &mut Vec<ExternalAppOptionDto>,
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    binary_name: &str,
    kind: &str,
) {
    if is_binary_available(binary_name) {
        apps.push(external_app_option(id, label, action, kind));
    }
}

#[cfg(target_os = "macos")]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_mac_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        &["Visual Studio Code"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        &["Visual Studio Code - Insiders", "VS Code - Insiders"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        &["VSCodium"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        &["Cursor"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        &["Windsurf"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        &["Zed"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "antigravity",
        "Antigravity",
        ExternalOpenAction::Editor,
        &["Antigravity"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        &["Sublime Text"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "bbedit",
        "BBEdit",
        ExternalOpenAction::Editor,
        &["BBEdit"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "nova",
        "Nova",
        ExternalOpenAction::Editor,
        &["Nova"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "textmate",
        "TextMate",
        ExternalOpenAction::Editor,
        &["TextMate"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        &["Fleet"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "intellij-idea",
        "IntelliJ IDEA",
        ExternalOpenAction::Editor,
        &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "pycharm",
        "PyCharm",
        ExternalOpenAction::Editor,
        &["PyCharm", "PyCharm CE", "PyCharm Professional"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "webstorm",
        "WebStorm",
        ExternalOpenAction::Editor,
        &["WebStorm"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "phpstorm",
        "PhpStorm",
        ExternalOpenAction::Editor,
        &["PhpStorm"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "goland",
        "GoLand",
        ExternalOpenAction::Editor,
        &["GoLand"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "clion",
        "CLion",
        ExternalOpenAction::Editor,
        &["CLion"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rider",
        "Rider",
        ExternalOpenAction::Editor,
        &["Rider"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rubymine",
        "RubyMine",
        ExternalOpenAction::Editor,
        &["RubyMine"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rustrover",
        "RustRover",
        ExternalOpenAction::Editor,
        &["RustRover"],
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_mac_app(
        &mut terminal,
        "terminal",
        "Terminal",
        ExternalOpenAction::Terminal,
        &["Terminal"],
        "builtin",
    );
    push_mac_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        &["Ghostty"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        &["WezTerm"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        &["kitty", "Kitty"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "alacritty",
        "Alacritty",
        ExternalOpenAction::Terminal,
        &["Alacritty"],
        "detected",
    );

    let mut files = vec![none_external_app(ExternalOpenAction::Files)];
    push_mac_app(
        &mut files,
        "finder",
        "Finder",
        ExternalOpenAction::Files,
        &["Finder"],
        "builtin",
    );
    push_mac_app(
        &mut files,
        "path-finder",
        "Path Finder",
        ExternalOpenAction::Files,
        &["Path Finder"],
        "detected",
    );
    push_mac_app(
        &mut files,
        "forklift",
        "ForkLift",
        ExternalOpenAction::Files,
        &["ForkLift"],
        "detected",
    );
    push_mac_app(
        &mut files,
        "commander-one",
        "Commander One",
        ExternalOpenAction::Files,
        &["Commander One"],
        "detected",
    );

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

#[cfg(target_os = "windows")]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_binary_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        "code",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        "code-insiders",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        "codium",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        "cursor",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        "windsurf",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        "zed",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        "subl",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "lapce",
        "Lapce",
        ExternalOpenAction::Editor,
        "lapce",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        "fleet",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "intellij-idea",
        "IntelliJ IDEA",
        ExternalOpenAction::Editor,
        "idea64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "pycharm",
        "PyCharm",
        ExternalOpenAction::Editor,
        "pycharm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "webstorm",
        "WebStorm",
        ExternalOpenAction::Editor,
        "webstorm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "phpstorm",
        "PhpStorm",
        ExternalOpenAction::Editor,
        "phpstorm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "goland",
        "GoLand",
        ExternalOpenAction::Editor,
        "goland64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "clion",
        "CLion",
        ExternalOpenAction::Editor,
        "clion64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "rider",
        "Rider",
        ExternalOpenAction::Editor,
        "rider64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "rustrover",
        "RustRover",
        ExternalOpenAction::Editor,
        "rustrover64",
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_binary_app(
        &mut terminal,
        "windows-terminal",
        "Windows Terminal",
        ExternalOpenAction::Terminal,
        "wt",
        "detected",
    );
    terminal.push(external_app_option(
        "powershell",
        "PowerShell",
        ExternalOpenAction::Terminal,
        "builtin",
    ));
    push_binary_app(
        &mut terminal,
        "pwsh",
        "PowerShell 7",
        ExternalOpenAction::Terminal,
        "pwsh",
        "detected",
    );
    terminal.push(external_app_option(
        "command-prompt",
        "Command Prompt",
        ExternalOpenAction::Terminal,
        "builtin",
    ));
    push_binary_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        "wezterm",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        "ghostty",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        "kitty",
        "detected",
    );
    let files = vec![
        none_external_app(ExternalOpenAction::Files),
        external_app_option(
            "explorer",
            "File Explorer",
            ExternalOpenAction::Files,
            "builtin",
        ),
    ];

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_binary_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        "code",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        "code-insiders",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        "codium",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "code-oss",
        "Code - OSS",
        ExternalOpenAction::Editor,
        "code-oss",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        "cursor",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        "windsurf",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        "zed",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        "subl",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "lapce",
        "Lapce",
        ExternalOpenAction::Editor,
        "lapce",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        "fleet",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "kate",
        "Kate",
        ExternalOpenAction::Editor,
        "kate",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "geany",
        "Geany",
        ExternalOpenAction::Editor,
        "geany",
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_binary_app(
        &mut terminal,
        "gnome-terminal",
        "GNOME Terminal",
        ExternalOpenAction::Terminal,
        "gnome-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "konsole",
        "Konsole",
        ExternalOpenAction::Terminal,
        "konsole",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "xfce4-terminal",
        "Xfce Terminal",
        ExternalOpenAction::Terminal,
        "xfce4-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "tilix",
        "Tilix",
        ExternalOpenAction::Terminal,
        "tilix",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "mate-terminal",
        "MATE Terminal",
        ExternalOpenAction::Terminal,
        "mate-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        "kitty",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        "wezterm",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        "ghostty",
        "detected",
    );
    let mut files = vec![none_external_app(ExternalOpenAction::Files)];
    push_binary_app(
        &mut files,
        "xdg-open",
        "System File Browser",
        ExternalOpenAction::Files,
        "xdg-open",
        "builtin",
    );
    push_binary_app(
        &mut files,
        "nautilus",
        "Nautilus",
        ExternalOpenAction::Files,
        "nautilus",
        "detected",
    );
    push_binary_app(
        &mut files,
        "dolphin",
        "Dolphin",
        ExternalOpenAction::Files,
        "dolphin",
        "detected",
    );
    push_binary_app(
        &mut files,
        "thunar",
        "Thunar",
        ExternalOpenAction::Files,
        "thunar",
        "detected",
    );
    push_binary_app(
        &mut files,
        "nemo",
        "Nemo",
        ExternalOpenAction::Files,
        "nemo",
        "detected",
    );
    push_binary_app(
        &mut files,
        "caja",
        "Caja",
        ExternalOpenAction::Files,
        "caja",
        "detected",
    );
    push_binary_app(
        &mut files,
        "pcmanfm",
        "PCManFM",
        ExternalOpenAction::Files,
        "pcmanfm",
        "detected",
    );

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

fn target_parent_dir(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        Some(path.to_path_buf())
    } else {
        path.parent().map(Path::to_path_buf)
    }
}

#[cfg(target_os = "macos")]
fn mac_open_known_app_command(
    bundle_names: &[&str],
    target_path: &Path,
) -> CommandResult<ExternalLaunchCommand> {
    let bundle_path = mac_app_bundle_path(bundle_names)
        .ok_or_else(|| command_error("Configured macOS app was not found."))?;
    let app_name = bundle_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| command_error("Configured macOS app bundle is invalid."))?;

    Ok(ExternalLaunchCommand {
        program: "open".to_string(),
        args: vec![
            "-a".to_string(),
            app_name.to_string(),
            target_path.to_string_lossy().to_string(),
        ],
        current_dir: target_parent_dir(target_path),
    })
}

#[cfg(target_os = "windows")]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn escape_cmd_literal(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(target_os = "windows")]
fn windows_binary_program(binary: &str) -> CommandResult<String> {
    resolve_binary_path(binary)
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| command_error(format!("App launch binary not found: {}", binary)))
}

#[cfg(target_os = "windows")]
fn windows_binary_launch_command(
    binary: &str,
    args: Vec<String>,
    target_path: &Path,
) -> CommandResult<ExternalLaunchCommand> {
    Ok(ExternalLaunchCommand {
        program: windows_binary_program(binary)?,
        args,
        current_dir: target_parent_dir(target_path),
    })
}

#[cfg(target_os = "windows")]
fn build_wsl_external_open_command(
    wsl_path: &WslProjectPath,
    action: ExternalOpenAction,
    app_id: &str,
) -> CommandResult<ExternalLaunchCommand> {
    match action {
        ExternalOpenAction::Editor => {
            let binary =
                match app_id {
                    "vscode" => "code",
                    "vscode-insiders" => "code-insiders",
                    "vscodium" => "codium",
                    _ => return Err(command_error(
                        "VS Code with Remote WSL is required to open a WSL project in the editor.",
                    )),
                };
            Ok(ExternalLaunchCommand {
                program: windows_binary_program(binary)?,
                args: vec![
                    "--remote".to_string(),
                    format!("wsl+{}", wsl_path.distro),
                    wsl_path.linux_path.clone(),
                ],
                current_dir: None,
            })
        }
        ExternalOpenAction::Terminal => match app_id {
            "windows-terminal" => Ok(ExternalLaunchCommand {
                program: windows_binary_program("wt")?,
                args: vec![
                    "new-tab".to_string(),
                    "wsl.exe".to_string(),
                    "-d".to_string(),
                    wsl_path.distro.clone(),
                    "--cd".to_string(),
                    wsl_path.linux_path.clone(),
                ],
                current_dir: None,
            }),
            "powershell" => Ok(ExternalLaunchCommand {
                program: "powershell".to_string(),
                args: vec![
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    format!(
                        "wsl.exe -d '{}' --cd '{}'",
                        escape_powershell_literal(&wsl_path.distro),
                        escape_powershell_literal(&wsl_path.linux_path)
                    ),
                ],
                current_dir: None,
            }),
            "pwsh" => Ok(ExternalLaunchCommand {
                program: windows_binary_program("pwsh")?,
                args: vec![
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    format!(
                        "wsl.exe -d '{}' --cd '{}'",
                        escape_powershell_literal(&wsl_path.distro),
                        escape_powershell_literal(&wsl_path.linux_path)
                    ),
                ],
                current_dir: None,
            }),
            "command-prompt" => Ok(ExternalLaunchCommand {
                program: "cmd".to_string(),
                args: vec![
                    "/K".to_string(),
                    format!(
                        r#"wsl.exe -d "{}" --cd "{}""#,
                        escape_cmd_literal(&wsl_path.distro),
                        escape_cmd_literal(&wsl_path.linux_path)
                    ),
                ],
                current_dir: None,
            }),
            _ => Ok(ExternalLaunchCommand {
                program: "wsl.exe".to_string(),
                args: vec![
                    "-d".to_string(),
                    wsl_path.distro.clone(),
                    "--cd".to_string(),
                    wsl_path.linux_path.clone(),
                ],
                current_dir: None,
            }),
        },
        ExternalOpenAction::Files => Ok(ExternalLaunchCommand {
            program: "explorer".to_string(),
            args: vec![wsl_path.unc_path.clone()],
            current_dir: None,
        }),
    }
}

#[cfg(not(target_os = "windows"))]
fn build_wsl_external_open_command(
    _wsl_path: &WslProjectPath,
    _action: ExternalOpenAction,
    _app_id: &str,
) -> CommandResult<ExternalLaunchCommand> {
    Err(command_error(
        "WSL project opening is only available on Windows.",
    ))
}

#[cfg(target_os = "macos")]
fn mac_binary_or_app_command(
    binary_names: &[&str],
    bundle_names: &[&str],
    executable_names: &[&str],
    args: Vec<String>,
    target_path: &Path,
) -> CommandResult<ExternalLaunchCommand> {
    let program = mac_binary_or_app_executable(binary_names, bundle_names, executable_names)
        .ok_or_else(|| command_error("App is installed but no launch binary was found."))?;

    Ok(ExternalLaunchCommand {
        program,
        args,
        current_dir: target_parent_dir(target_path),
    })
}

fn build_external_open_command(
    target_path: &Path,
    app_id: &str,
) -> CommandResult<ExternalLaunchCommand> {
    #[cfg(target_os = "macos")]
    let command = match app_id {
        "vscode" => mac_open_known_app_command(&["Visual Studio Code"], target_path)?,
        "vscode-insiders" => mac_open_known_app_command(
            &["Visual Studio Code - Insiders", "VS Code - Insiders"],
            target_path,
        )?,
        "vscodium" => mac_open_known_app_command(&["VSCodium"], target_path)?,
        "cursor" => mac_open_known_app_command(&["Cursor"], target_path)?,
        "windsurf" => mac_open_known_app_command(&["Windsurf"], target_path)?,
        "zed" => mac_open_known_app_command(&["Zed"], target_path)?,
        "antigravity" => mac_open_known_app_command(&["Antigravity"], target_path)?,
        "sublime-text" => mac_open_known_app_command(&["Sublime Text"], target_path)?,
        "bbedit" => mac_open_known_app_command(&["BBEdit"], target_path)?,
        "nova" => mac_open_known_app_command(&["Nova"], target_path)?,
        "textmate" => mac_open_known_app_command(&["TextMate"], target_path)?,
        "fleet" => mac_open_known_app_command(&["Fleet"], target_path)?,
        "intellij-idea" => mac_open_known_app_command(
            &[
                "IntelliJ IDEA",
                "IntelliJ IDEA CE",
                "IntelliJ IDEA Ultimate",
            ],
            target_path,
        )?,
        "pycharm" => mac_open_known_app_command(
            &["PyCharm", "PyCharm CE", "PyCharm Professional"],
            target_path,
        )?,
        "webstorm" => mac_open_known_app_command(&["WebStorm"], target_path)?,
        "phpstorm" => mac_open_known_app_command(&["PhpStorm"], target_path)?,
        "goland" => mac_open_known_app_command(&["GoLand"], target_path)?,
        "clion" => mac_open_known_app_command(&["CLion"], target_path)?,
        "rider" => mac_open_known_app_command(&["Rider"], target_path)?,
        "rubymine" => mac_open_known_app_command(&["RubyMine"], target_path)?,
        "rustrover" => mac_open_known_app_command(&["RustRover"], target_path)?,
        "terminal" => mac_open_known_app_command(&["Terminal"], target_path)?,
        "ghostty" => mac_binary_or_app_command(
            &["ghostty"],
            &["Ghostty"],
            &["ghostty"],
            vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "wezterm" => mac_binary_or_app_command(
            &["wezterm"],
            &["WezTerm"],
            &["wezterm", "wezterm-gui"],
            vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "kitty" => mac_binary_or_app_command(
            &["kitty"],
            &["kitty", "Kitty"],
            &["kitty"],
            vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "alacritty" => mac_binary_or_app_command(
            &["alacritty"],
            &["Alacritty"],
            &["alacritty"],
            vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "finder" => mac_open_known_app_command(&["Finder"], target_path)?,
        "path-finder" => mac_open_known_app_command(&["Path Finder"], target_path)?,
        "forklift" => mac_open_known_app_command(&["ForkLift"], target_path)?,
        "commander-one" => mac_open_known_app_command(&["Commander One"], target_path)?,
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    #[cfg(target_os = "windows")]
    let command = match app_id {
        "vscode" => windows_binary_launch_command(
            "code",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "vscode-insiders" => windows_binary_launch_command(
            "code-insiders",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "vscodium" => windows_binary_launch_command(
            "codium",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "cursor" => windows_binary_launch_command(
            "cursor",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "windsurf" => windows_binary_launch_command(
            "windsurf",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "zed" => windows_binary_launch_command(
            "zed",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "sublime-text" => windows_binary_launch_command(
            "subl",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "lapce" => windows_binary_launch_command(
            "lapce",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "fleet" => windows_binary_launch_command(
            "fleet",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "intellij-idea" => windows_binary_launch_command(
            "idea64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "pycharm" => windows_binary_launch_command(
            "pycharm64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "webstorm" => windows_binary_launch_command(
            "webstorm64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "phpstorm" => windows_binary_launch_command(
            "phpstorm64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "goland" => windows_binary_launch_command(
            "goland64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "clion" => windows_binary_launch_command(
            "clion64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "rider" => windows_binary_launch_command(
            "rider64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "rustrover" => windows_binary_launch_command(
            "rustrover64",
            vec![target_path.to_string_lossy().to_string()],
            target_path,
        )?,
        "windows-terminal" => windows_binary_launch_command(
            "wt",
            vec![
                "new-tab".to_string(),
                "--startingDirectory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "powershell" => ExternalLaunchCommand {
            program: "powershell".to_string(),
            args: vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!(
                    "Set-Location -LiteralPath '{}'",
                    escape_powershell_literal(&target_path.to_string_lossy())
                ),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "command-prompt" => ExternalLaunchCommand {
            program: "cmd".to_string(),
            args: vec![
                "/K".to_string(),
                format!(
                    r#"cd /d "{}""#,
                    escape_cmd_literal(&target_path.to_string_lossy())
                ),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "pwsh" => windows_binary_launch_command(
            "pwsh",
            vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!(
                    "Set-Location -LiteralPath '{}'",
                    escape_powershell_literal(&target_path.to_string_lossy())
                ),
            ],
            target_path,
        )?,
        "wezterm" => windows_binary_launch_command(
            "wezterm",
            vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "ghostty" => windows_binary_launch_command(
            "ghostty",
            vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "kitty" => windows_binary_launch_command(
            "kitty",
            vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "explorer" => ExternalLaunchCommand {
            program: "explorer".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let command = match app_id {
        "vscode" => ExternalLaunchCommand {
            program: "code".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscode-insiders" => ExternalLaunchCommand {
            program: "code-insiders".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscodium" => ExternalLaunchCommand {
            program: "codium".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "code-oss" => ExternalLaunchCommand {
            program: "code-oss".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "cursor" => ExternalLaunchCommand {
            program: "cursor".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "windsurf" => ExternalLaunchCommand {
            program: "windsurf".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "zed" => ExternalLaunchCommand {
            program: "zed".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "sublime-text" => ExternalLaunchCommand {
            program: "subl".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "lapce" => ExternalLaunchCommand {
            program: "lapce".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "fleet" => ExternalLaunchCommand {
            program: "fleet".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "kate" => ExternalLaunchCommand {
            program: "kate".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "geany" => ExternalLaunchCommand {
            program: "geany".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "gnome-terminal" => ExternalLaunchCommand {
            program: "gnome-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "konsole" => ExternalLaunchCommand {
            program: "konsole".to_string(),
            args: vec![
                "--workdir".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "xfce4-terminal" => ExternalLaunchCommand {
            program: "xfce4-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "tilix" => ExternalLaunchCommand {
            program: "tilix".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "mate-terminal" => ExternalLaunchCommand {
            program: "mate-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "kitty" => ExternalLaunchCommand {
            program: "kitty".to_string(),
            args: vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "wezterm" => ExternalLaunchCommand {
            program: "wezterm".to_string(),
            args: vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "ghostty" => ExternalLaunchCommand {
            program: "ghostty".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "xdg-open" => ExternalLaunchCommand {
            program: "xdg-open".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "nautilus" => ExternalLaunchCommand {
            program: "nautilus".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "dolphin" => ExternalLaunchCommand {
            program: "dolphin".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "thunar" => ExternalLaunchCommand {
            program: "thunar".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "nemo" => ExternalLaunchCommand {
            program: "nemo".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "caja" => ExternalLaunchCommand {
            program: "caja".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "pcmanfm" => ExternalLaunchCommand {
            program: "pcmanfm".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    Ok(command)
}

#[tauri::command]
pub async fn list_external_apps() -> CommandResult<ExternalAppCatalogDto> {
    Ok(build_external_app_catalog())
}

#[tauri::command]
pub async fn open_external_target(
    target_path: String,
    action: String,
    app_id: String,
) -> CommandResult<()> {
    let action = ExternalOpenAction::parse(&action)
        .ok_or_else(|| command_error(format!("Unsupported open action: {}", action)))?;
    let app_catalog = build_external_app_catalog();
    let action_apps = match action {
        ExternalOpenAction::Editor => &app_catalog.editor,
        ExternalOpenAction::Terminal => &app_catalog.terminal,
        ExternalOpenAction::Files => &app_catalog.files,
    };

    if !action_apps.iter().any(|app| app.id == app_id) {
        return Err(command_error(format!(
            "App id \"{}\" is not available for {}.",
            app_id,
            action.as_str()
        )));
    }

    let trimmed_target_path = target_path.trim();
    let launch = if let Some(wsl_path) = parse_wsl_unc_path(trimmed_target_path) {
        build_wsl_external_open_command(&wsl_path, action, app_id.as_str())?
    } else {
        let resolved_path = PathBuf::from(trimmed_target_path);
        let canonical_path = resolved_path
            .canonicalize()
            .map_err(|error| command_error(format!("Open target not found: {}", error)))?;
        build_external_open_command(&canonical_path, app_id.as_str())?
    };
    let visibility = external_launch_visibility(action, app_id.as_str());

    tokio::task::spawn_blocking(move || {
        let mut command = match visibility {
            ProcessLaunchVisibility::HiddenBackgroundLauncher => {
                background_command(&launch.program)
            }
            ProcessLaunchVisibility::VisibleTerminal => visible_terminal_command(&launch.program),
        };
        command.args(&launch.args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());

        if let Some(current_dir) = launch.current_dir {
            command.current_dir(current_dir);
        }

        command
            .spawn()
            .map(|_| ())
            .map_err(|error| command_error(format!("Failed to launch external app: {}", error)))
    })
    .await
    .map_err(|error| command_error(format!("External launch task failed: {}", error)))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    use std::env;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[cfg(target_os = "windows")]
    static PATH_TEST_LOCK: Mutex<()> = Mutex::new(());
    #[test]
    fn binary_candidates_expands_windows_script_extensions() {
        #[cfg(target_os = "windows")]
        assert_eq!(
            binary_candidates("code"),
            vec![
                "code.exe".to_string(),
                "code.cmd".to_string(),
                "code.bat".to_string(),
                "code".to_string(),
            ]
        );

        #[cfg(not(target_os = "windows"))]
        assert_eq!(binary_candidates("code"), vec!["code".to_string()]);
    }

    #[test]
    fn external_launch_visibility_keeps_explicit_terminals_visible() {
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Terminal, "windows-terminal"),
            ProcessLaunchVisibility::VisibleTerminal
        );
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Terminal, "powershell"),
            ProcessLaunchVisibility::VisibleTerminal
        );
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Terminal, "command-prompt"),
            ProcessLaunchVisibility::VisibleTerminal
        );
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Terminal, "PowerShell"),
            ProcessLaunchVisibility::VisibleTerminal
        );
    }

    #[test]
    fn external_launch_visibility_hides_background_launchers() {
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Editor, "vscode"),
            ProcessLaunchVisibility::HiddenBackgroundLauncher
        );
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Files, "explorer"),
            ProcessLaunchVisibility::HiddenBackgroundLauncher
        );
        assert_eq!(
            external_launch_visibility(ExternalOpenAction::Editor, "command-prompt"),
            ProcessLaunchVisibility::HiddenBackgroundLauncher
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_binary_path_finds_windows_cmd_candidate_on_path() {
        let _guard = PATH_TEST_LOCK.lock().expect("lock PATH test");
        let original_path = env::var_os("PATH");
        let temp_dir = TempDir::new().expect("temp dir");
        let code_cmd = temp_dir.path().join("code.cmd");
        fs::write(&code_cmd, "@echo off\r\n").expect("write code.cmd");

        let next_path = match original_path.as_ref() {
            Some(path) => env::join_paths(
                std::iter::once(temp_dir.path().to_path_buf()).chain(env::split_paths(path)),
            )
            .expect("join PATH"),
            None => temp_dir.path().as_os_str().to_os_string(),
        };

        env::set_var("PATH", next_path);
        let resolved = resolve_binary_path("code").expect("resolve code");
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }

        assert_eq!(resolved, code_cmd);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_vscode_open_command_uses_resolved_cmd_candidate() {
        let _guard = PATH_TEST_LOCK.lock().expect("lock PATH test");
        let original_path = env::var_os("PATH");
        let temp_dir = TempDir::new().expect("temp dir");
        let code_cmd = temp_dir.path().join("code.cmd");
        fs::write(&code_cmd, "@echo off\r\n").expect("write code.cmd");

        let next_path = match original_path.as_ref() {
            Some(path) => env::join_paths(
                std::iter::once(temp_dir.path().to_path_buf()).chain(env::split_paths(path)),
            )
            .expect("join PATH"),
            None => temp_dir.path().as_os_str().to_os_string(),
        };

        env::set_var("PATH", next_path);
        let command = build_external_open_command(temp_dir.path(), "vscode")
            .expect("build vscode launch command");
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }

        assert_eq!(command.program, code_cmd.to_string_lossy().to_string());
        assert_eq!(
            command.args,
            vec![temp_dir.path().to_string_lossy().to_string()]
        );
    }
}
