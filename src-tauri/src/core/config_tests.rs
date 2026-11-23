#[cfg(test)]
mod tests {
    use crate::core::config::{
        test_finalize_desktop_workspace_path_for_mode, test_load_config_from_runtime_file,
        test_resolve_workspace_path_for_cwd, test_workspace_path_source_for_config, AppConfig,
        WorkspacePathSource,
    };
    use std::fs;
    use std::path::PathBuf;

    #[tokio::test]
    async fn malformed_portable_runtime_defers_to_approved_snapshot_without_losing_bytes() {
        use crate::config::{ConfigDocumentKind, ConfigManager};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let workspace = root.join("synthetic-workspace");
        let approved_path = root.join(".runtime/approved/user/runtime.json");
        fs::create_dir_all(approved_path.parent().unwrap()).unwrap();
        fs::write(
            &approved_path,
            serde_json::json!({
                "$schema": "runtime.schema.json", "schemaVersion": 1, "defaultWorkspace": workspace,
            })
            .to_string(),
        )
        .unwrap();
        fs::copy(&approved_path, root.join("runtime.json")).unwrap();
        let manager = ConfigManager::initialize(root.clone()).await.unwrap();
        let approved = manager
            .effective_user_document(ConfigDocumentKind::Runtime)
            .await;
        drop(manager);
        let path = root.join("runtime.json");
        fs::write(&path, b"{truncated").unwrap();
        let mut config = test_load_config_from_runtime_file(path.clone()).unwrap();
        let recovered = ConfigManager::initialize(root).await.unwrap();
        let runtime = recovered
            .effective_user_document(ConfigDocumentKind::Runtime)
            .await;
        assert_eq!(runtime, approved);
        crate::core::config::apply_runtime_workspace(&mut config, &runtime).unwrap();
        assert_eq!(config.workspace_path, workspace);
        assert_eq!(
            config.workspace_path_source,
            WorkspacePathSource::Configured
        );
        assert_eq!(fs::read(path).unwrap(), b"{truncated");
    }

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
        let app_data_dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();

        test_finalize_desktop_workspace_path_for_mode(&mut config, app_data_dir.path(), true)
            .unwrap();

        assert_eq!(config.workspace_path, app_data_dir.path().join("workspace"));
        assert!(config.workspace_path.is_dir());
    }

    #[test]
    fn default_workspace_blocked_by_a_file_reports_startup_recovery() {
        use crate::local_backup::{ProfileRecovery, ProfileRecoveryKind};

        let app_data_dir = tempfile::tempdir().unwrap();
        let workspace = app_data_dir.path().join("workspace");
        fs::write(&workspace, b"user data").unwrap();
        let mut config = AppConfig::default();

        let failure = ProfileRecovery::startup_step(
            "Failed to prepare desktop workspace",
            test_finalize_desktop_workspace_path_for_mode(&mut config, app_data_dir.path(), true),
        )
        .unwrap_err();
        assert_eq!(failure.kind, ProfileRecoveryKind::Startup);
        assert!(failure
            .diagnostics
            .contains("Failed to create default workspace directory"));
        assert_eq!(fs::read(&workspace).unwrap(), b"user data");
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

        test_finalize_desktop_workspace_path_for_mode(&mut config, &app_data_dir, true).unwrap();

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

        test_finalize_desktop_workspace_path_for_mode(&mut config, &app_data_dir, false).unwrap();

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

    #[test]
    fn test_runtime_document_defers_workspace_value_to_config_manager() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let runtime_path = temp_dir.path().join("runtime.json");
        let runtime_workspace = temp_dir.path().join("runtime-workspace");
        fs::write(
            &runtime_path,
            serde_json::json!({
                "schemaVersion": 1,
                "defaultWorkspace": runtime_workspace,
            })
            .to_string(),
        )
        .expect("write runtime config");

        let config = test_load_config_from_runtime_file(runtime_path)
            .expect("load legacy defaults without deserializing runtime aliases");

        assert!(config.workspace_path.is_absolute());
        assert_ne!(config.workspace_path, runtime_workspace);
        assert_eq!(config.workspace_path_source, WorkspacePathSource::Default);
    }
}
