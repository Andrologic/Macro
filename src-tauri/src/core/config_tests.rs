#[cfg(test)]
mod tests {
    use crate::core::config::AppConfig;
    use std::path::PathBuf;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.workspace_path, PathBuf::from("."));
        assert_eq!(config.db_path, PathBuf::from("macro.db"));
    }
}
