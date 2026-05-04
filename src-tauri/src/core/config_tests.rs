#[cfg(test)]
mod tests {
    use crate::core::config::{
        test_finalize_desktop_workspace_path_for_mode, test_resolve_workspace_path_for_cwd,
        test_workspace_path_source_for_config, AppConfig, WorkspacePathSource,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.workspace_path, PathBuf::from("."));
        assert_eq!(config.workspace_path_source, WorkspacePathSource::Default);
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
        assert_eq!(resolved, PathBuf::from("/tmp/project/src-tauri/docs"));
    }

    #[test]
    fn test_workspace_resolution_from_non_src_tauri_cwd_is_absolute() {
        let cwd = PathBuf::from("/tmp/project");
        let resolved = test_resolve_workspace_path_for_cwd(PathBuf::from("."), &cwd);
        assert_eq!(resolved, PathBuf::from("/tmp/project"));
    }

    #[test]
    fn test_desktop_default_workspace_resolution_uses_app_data_workspace() {
        let app_data_dir =
            PathBuf::from("/Users/example/Library/Application Support/com.macro.desktop");
        let mut config = AppConfig::default();

        test_finalize_desktop_workspace_path_for_mode(&mut config, &app_data_dir, true);

        assert_eq!(config.workspace_path, app_data_dir.join("workspace"));
    }

    #[test]
    fn test_desktop_default_workspace_resolution_keeps_configured_absolute_path() {
        let app_data_dir =
            PathBuf::from("/Users/example/Library/Application Support/com.macro.desktop");
        let mut config = AppConfig {
            workspace_path: PathBuf::from("/Users/example/dev/macro-workspace"),
            workspace_path_source: WorkspacePathSource::Configured,
            ..AppConfig::default()
        };

        test_finalize_desktop_workspace_path_for_mode(&mut config, &app_data_dir, true);

        assert_eq!(
            config.workspace_path,
            PathBuf::from("/Users/example/dev/macro-workspace")
        );
    }

    #[test]
    fn test_desktop_debug_default_workspace_resolution_keeps_dev_path() {
        let app_data_dir =
            PathBuf::from("/Users/example/Library/Application Support/com.macro.desktop");
        let mut config = AppConfig {
            workspace_path: PathBuf::from("/tmp/project"),
            ..AppConfig::default()
        };

        test_finalize_desktop_workspace_path_for_mode(&mut config, &app_data_dir, false);

        assert_eq!(config.workspace_path, PathBuf::from("/tmp/project"));
    }

    #[test]
    fn test_workspace_path_source_detects_configured_workspace_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let config_path = temp_dir.path().join("macro.toml");
        fs::write(&config_path, "workspace_path = \"/Users/example/dev\"\n").expect("write config");

        let source = test_workspace_path_source_for_config(config_path.to_str())
            .expect("detect workspace path source");

        assert_eq!(source, WorkspacePathSource::Configured);
    }

    #[test]
    fn test_workspace_path_source_defaults_when_config_omits_workspace_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let config_path = temp_dir.path().join("macro.toml");
        fs::write(
            &config_path,
            "[ai]\nlocal_api_url = \"http://localhost:11434\"\n",
        )
        .expect("write config");

        let source = test_workspace_path_source_for_config(config_path.to_str())
            .expect("detect workspace path source");

        assert_eq!(source, WorkspacePathSource::Default);
    }
}
