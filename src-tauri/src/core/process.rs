//! Shared native process containment and joining.
pub use argentic_runtime::process::*;

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};
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
