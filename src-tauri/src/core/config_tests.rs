#[cfg(test)]
mod tests {
    use crate::core::config::{test_resolve_workspace_path_for_cwd, AppConfig};
    use std::path::PathBuf;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.workspace_path, PathBuf::from("."));
    }

    #[test]
    fn test_workspace_resolution_from_src_tauri_cwd() {
        let cwd = PathBuf::from("/tmp/project/src-tauri");
        let resolved = test_resolve_workspace_path_for_cwd(PathBuf::from("."), &cwd);
        assert_eq!(resolved, PathBuf::from("/tmp/project"));
    }

    #[test]
    fn test_workspace_resolution_keeps_custom_path() {
        let cwd = PathBuf::from("/tmp/project/src-tauri");
        let resolved = test_resolve_workspace_path_for_cwd(PathBuf::from("docs"), &cwd);
        assert_eq!(resolved, PathBuf::from("docs"));
    }
}
