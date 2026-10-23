//! Strict policy reads never repair or normalize secret storage.
use super::*;
use serde_json::Value;

// Reject duplicate object keys before Value can discard a shadowed credential.
// Serde remains the JSON parser; this visitor only checks map uniqueness.
struct UniqueKeys;
impl<'de> serde::Deserialize<'de> for UniqueKeys {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<UniqueKeys, M::Error> {
                let mut keys = std::collections::BTreeSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(serde::de::Error::custom("duplicate secret field"));
                    }
                    map.next_value::<UniqueKeys>()?;
                }
                Ok(UniqueKeys)
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut seq: S,
            ) -> Result<UniqueKeys, S::Error> {
                while seq.next_element::<UniqueKeys>()?.is_some() {}
                Ok(UniqueKeys)
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
fn unique_keys(contents: &str) -> Result<(), SecretError> {
    serde_json::from_str::<UniqueKeys>(contents)
        .map(|_| ())
        .map_err(|_| SecretError::PolicyUnavailable)
}

fn object_fields(value: &Value, allowed: &[&str]) -> Result<(), SecretError> {
    let object = value.as_object().ok_or(SecretError::PolicyUnavailable)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(SecretError::PolicyUnavailable);
    }
    Ok(())
}

fn session_shape(value: &Value) -> Result<(), SecretError> {
    let decoded;
    let value = if let Some(serialized) = value.as_str() {
        unique_keys(serialized)?;
        decoded = serde_json::from_str::<Value>(serialized)
            .map_err(|_| SecretError::PolicyUnavailable)?;
        &decoded
    } else {
        value
    };
    let current = [
        "access_token",
        "refresh_token",
        "access_token_expires_at",
        "account_id",
        "auth_source",
    ];
    if value.get("payload").is_some() {
        object_fields(value, &["version", "kind", "payload"])?;
        match (
            value.get("version").and_then(Value::as_u64),
            value.get("kind").and_then(Value::as_str),
        ) {
            (Some(2), Some("chatgpt_session")) => object_fields(&value["payload"], &current)?,
            (Some(1), Some("chatgpt")) => object_fields(
                &value["payload"],
                &[
                    "access_token",
                    "refresh_token",
                    "id_token",
                    "account_id",
                    "client_id",
                    "last_refresh",
                    "source",
                ],
            )?,
            _ => return Err(SecretError::PolicyUnavailable),
        }
    } else {
        object_fields(value, &current)?;
    }
    parse_chatgpt_secret_value(value).ok_or(SecretError::PolicyUnavailable)?;
    Ok(())
}

fn recognized(value: &Value) -> Result<ProviderSecretsFile, SecretError> {
    object_fields(
        value,
        &[
            "version",
            "policyEpoch",
            "api_keys",
            "namespaces",
            "chatgpt_sessions",
        ],
    )?;
    if value
        .get("version")
        .is_some_and(|v| !matches!(v.as_u64(), Some(0..=2)))
    {
        return Err(SecretError::PolicyUnavailable);
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut check_map = |map: &Value| -> Result<(), SecretError> {
        for (key, value) in map.as_object().ok_or(SecretError::PolicyUnavailable)? {
            if !value.is_string() || !ids.insert(key.clone()) {
                return Err(SecretError::PolicyUnavailable);
            }
        }
        Ok(())
    };
    if let Some(namespaces) = value.get("namespaces") {
        object_fields(
            namespaces,
            &["providers", "speech", "mcp", "webSearch", "system"],
        )?;
        for map in namespaces.as_object().unwrap().values() {
            check_map(map)?;
        }
    }
    if let Some(keys) = value.get("api_keys") {
        check_map(keys)?;
    }
    if let Some(sessions) = value.get("chatgpt_sessions") {
        for session in sessions
            .as_object()
            .ok_or(SecretError::PolicyUnavailable)?
            .values()
        {
            session_shape(session)?;
        }
    }
    if let Some(epoch) = value.get("policyEpoch") {
        let epoch = epoch
            .as_str()
            .and_then(|v| uuid::Uuid::parse_str(v).ok())
            .filter(|v| !v.is_nil())
            .ok_or(SecretError::PolicyUnavailable)?;
        if value["policyEpoch"].as_str() != Some(epoch.hyphenated().to_string().as_str()) {
            return Err(SecretError::PolicyUnavailable);
        }
    }
    parse_provider_secrets_file(&value.to_string()).map_err(|_| SecretError::PolicyUnavailable)
}

impl ProviderSecretsFile {
    pub(in crate::secrets) fn policy_values(&self) -> Result<Vec<String>, SecretError> {
        let mut values: Vec<String> = self.api_keys.values().cloned().collect();
        for secret in self.chatgpt_sessions.values() {
            values.push(secret.access_token.clone());
            values.push(secret.refresh_token.clone());
        }
        // Preserve only recognized legacy secret fields, not account/client
        // metadata or an arbitrary copy of the storage document.
        for raw in self.raw_chatgpt_sessions.values() {
            let decoded;
            let value = if let Some(serialized) = raw.as_str() {
                decoded = serde_json::from_str::<Value>(serialized)
                    .map_err(|_| SecretError::PolicyUnavailable)?;
                &decoded
            } else {
                raw
            };
            if value.get("version").and_then(Value::as_u64) == Some(1)
                && value.get("kind").and_then(Value::as_str) == Some("chatgpt")
            {
                let legacy: SecretEnvelope<LegacyChatGptSecret> =
                    serde_json::from_value(value.clone())
                        .map_err(|_| SecretError::PolicyUnavailable)?;
                values.push(legacy.payload.id_token);
            }
        }
        Ok(values)
    }
}

impl LocalSecretStore {
    /// Caller owns the common gate and file lock. This path never repairs.
    fn policy_file_exists(&self) -> Result<bool, SecretError> {
        match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) if metadata.file_type().is_file() => Ok(true),
            Ok(_) => Err(SecretError::PolicyUnavailable),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    fn restore_pending(&self) -> Result<bool, SecretError> {
        let parent = self.path.parent().ok_or(SecretError::PolicyUnavailable)?;
        Ok(parent.join("local-backup/restoring.json").try_exists()?)
    }

    pub(in crate::secrets) fn read_policy_file(&self) -> Result<ProviderSecretsFile, SecretError> {
        self.read_policy_file_mode(false)
    }

    fn read_policy_file_mode(&self, restoring: bool) -> Result<ProviderSecretsFile, SecretError> {
        if (!restoring && self.restore_pending()?) || self.migration_journal_path().try_exists()? {
            return Err(SecretError::PolicyUnavailable);
        }
        if !self.policy_file_exists()? {
            return Err(SecretError::PolicyUnavailable);
        }
        let contents = std::fs::read_to_string(&self.path)?;
        let value =
            serde_json::from_str::<Value>(&contents).map_err(|_| SecretError::PolicyUnavailable)?;
        unique_keys(&contents)?;
        let data = recognized(&value)?;
        if data.version != SECRET_FILE_VERSION || data.policy_epoch.is_none() {
            return Err(SecretError::PolicyUnavailable);
        }
        Ok(data)
    }

    /// Startup / explicit recovery only, under the same continuous file lock.
    pub(in crate::secrets) fn prepare_policy_file(
        &self,
    ) -> Result<ProviderSecretsFile, SecretError> {
        self.prepare_policy_file_mode(false)
    }

    /// Only the startup owner, while holding the continuous restore exclusion.
    pub(in crate::secrets) fn prepare_restored_policy_file(
        &self,
    ) -> Result<ProviderSecretsFile, SecretError> {
        self.prepare_policy_file_mode(true)
    }

    fn prepare_policy_file_mode(
        &self,
        restoring: bool,
    ) -> Result<ProviderSecretsFile, SecretError> {
        if !restoring && self.restore_pending()? {
            return Err(SecretError::PolicyUnavailable);
        }
        self.policy_file_exists()?;
        self.recover_pending_migration()?;
        let contents = if self.policy_file_exists()? {
            std::fs::read_to_string(&self.path)?
        } else {
            String::new()
        };
        let mut data = if contents.trim().is_empty() {
            ProviderSecretsFile::default()
        } else {
            match serde_json::from_str::<Value>(&contents) {
                Ok(value) => {
                    unique_keys(&contents)?;
                    recognized(&value)?
                }
                Err(_) => {
                    // Value also rejects valid JSON outside its number/depth
                    // representation. IgnoredAny uses this parser's iterative
                    // syntax-only path, without constructing a value tree.
                    let syntax_error =
                        match serde_json::from_str::<serde::de::IgnoredAny>(&contents) {
                            Err(error) if error.is_syntax() || error.is_eof() => error,
                            _ => return Err(SecretError::PolicyUnavailable),
                        };
                    // Rename plus parent fsync establishes the durable refusal
                    // before a replacement document can be published.
                    self.quarantine_corrupt_file(&syntax_error)?;
                    ProviderSecretsFile::default()
                }
            }
        };
        data.policy_epoch = Some(uuid::Uuid::new_v4());
        if data.version < SECRET_FILE_VERSION && self.path.exists() {
            self.migrate_versioned_file(&data)?;
        } else {
            self.write_file(&data)?;
        }
        self.read_policy_file_mode(restoring)
    }

    /// Ordinary invalidation cannot repair or accept a missing epoch.
    pub(in crate::secrets) fn rotate_policy_file(
        &self,
    ) -> Result<ProviderSecretsFile, SecretError> {
        let mut data = self.read_policy_file()?;
        data.policy_epoch = Some(uuid::Uuid::new_v4());
        self.write_file(&data)?;
        self.read_policy_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_marker_blocks_capture_rotation_and_uncoordinated_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalSecretStore::new(directory.path().join(SECRET_FILE_NAME));
        with_test_store_file_lock(&store, |store| {
            store.prepare_policy_file()?;
            let before = std::fs::read(&store.path)?;
            let backup = directory.path().join("local-backup");
            std::fs::create_dir(&backup)?;
            let marker = backup.join("restoring.json");
            let opaque = b"existing restore journal bytes";
            std::fs::write(&marker, opaque)?;
            assert!(store.read_policy_file().is_err());
            assert!(store.rotate_policy_file().is_err());
            assert!(store.prepare_policy_file().is_err());
            assert_eq!(std::fs::read(&store.path)?, before);
            assert_eq!(std::fs::read(&marker)?, opaque);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn policy_file_strict_reads_preserve_unknown_and_unreadable_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SECRET_FILE_NAME);
        let store = LocalSecretStore::new(path.clone());
        for input in [
            br#"{"version":99}"#.as_slice(),
            br#"{"version":99,"version":2}"#,
            br#"{"version":2,"api_keys":{"same":"hidden","same":"visible"}}"#,
            br#"{"version":2,"chatgpt_sessions":{"test":"{\"access_token\":\"hidden\",\"access_token\":\"visible\",\"refresh_token\":\"r\",\"auth_source\":\"oauth\"}"}}"#,
            br#"{"version":2,"futureSecret":"synthetic"}"#,
            br#"{"version":2,"chatgpt_sessions":{"future":{"token":"synthetic"}}}"#,
            br#"{"version":2,"namespaces":[]}"#,
            br#"{"version":2,"policyEpoch":"invalid"}"#,
            br#"{"version":2,"api_keys":{"same":"a"},"namespaces":{"providers":{"same":"b"}}}"#,
            &[0xff, 0xfe],
        ] {
            std::fs::write(&path, input).unwrap();
            with_test_store_file_lock(&store, |store| {
                assert!(store.read_policy_file().is_err());
                assert!(store.prepare_policy_file().is_err());
                assert_eq!(std::fs::read(&path).unwrap(), input);
                Ok(())
            })
            .unwrap();
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
        }
    }

    #[test]
    fn policy_file_rotation_is_fresh_and_keeps_legacy_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SECRET_FILE_NAME);
        let store = LocalSecretStore::new(path.clone());
        let session = serde_json::json!({"version":1,"kind":"chatgpt","payload":{
            "access_token":"synthetic-access","refresh_token":"synthetic-refresh",
            "id_token":"synthetic-id","account_id":null,"client_id":"synthetic-client",
            "last_refresh":null,"source":"oauth"
        }});
        let input = serde_json::json!({"version":2,"chatgpt_sessions":{"test":session},"namespaces":{"providers":{"test":"synthetic-key"}}});
        std::fs::write(&path, input.to_string()).unwrap();
        with_test_store_file_lock(&store, |store| {
            assert!(store.read_policy_file().is_err());
            let first = store.prepare_policy_file()?;
            let second = store.rotate_policy_file()?;
            assert_ne!(first.policy_epoch, second.policy_epoch);
            assert_eq!(first.api_keys, second.api_keys);
            assert_eq!(first.chatgpt_sessions, second.chatgpt_sessions);
            let persisted: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            assert_eq!(persisted["chatgpt_sessions"]["test"], session);
            assert_eq!(persisted["version"], 2);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn policy_file_reconciles_exact_migration_before_startup_rotation() {
        let _test_guard = super::super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SECRET_FILE_NAME);
        let store = LocalSecretStore::new(path.clone());
        let original = br#"{ "version":1, "api_keys":{"test":"synthetic"} }"#;
        std::fs::write(&path, original).unwrap();
        with_test_store_file_lock(&store, |store| {
            install_migration_failure_after_replace(path.clone());
            assert!(store.prepare_policy_file().is_err());
            let target: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            let journal: SecretMigrationJournal =
                serde_json::from_slice(&std::fs::read(store.migration_journal_path())?)?;
            assert_eq!(journal.target_sha256, secret_digest(&std::fs::read(&path)?));
            assert!(store.read_policy_file().is_err());
            let recovered = store.prepare_policy_file()?;
            assert_ne!(
                target["policyEpoch"],
                serde_json::to_value(recovered.policy_epoch)?
            );
            assert_eq!(
                std::fs::read(directory.path().join("provider-secrets.json.v1.bak"))?,
                original
            );
            assert!(!store.migration_journal_path().exists());
            assert_eq!(recovered.api_keys["test"], "synthetic");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn startup_preserves_syntactically_valid_unrepresentable_documents() {
        let _serial = crate::secrets::lock_test_store();
        for version in [2, 99] {
            for value in [
                "1e999".to_string(),
                "-1e999".to_string(),
                format!("{}0{}", "[".repeat(140), "]".repeat(140)),
            ] {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().join(SECRET_FILE_NAME);
                let original = format!(
                    r#"{{"version":{version},"futureSecret":{value},"api_keys":{{"key":"synthetic-preserve"}}}}"#
                );
                assert!(serde_json::from_str::<Value>(&original).is_err());
                assert!(serde_json::from_str::<serde::de::IgnoredAny>(&original).is_ok());
                std::fs::write(&path, &original).unwrap();
                let archive = directory.path().join("provider-secrets.json.v0.bak");
                std::fs::write(&archive, b"historical synthetic bytes").unwrap();
                assert!(crate::secrets::init(directory.path()).is_err());
                assert!(!crate::secrets::policy::POLICY.available());
                assert!(crate::secrets::policy::POLICY
                    .capture_private(|| Ok(()))
                    .is_err());
                assert_eq!(std::fs::read(&path).unwrap(), original.as_bytes());
                assert_eq!(
                    std::fs::read(&archive).unwrap(),
                    b"historical synthetic bytes"
                );
                assert!(!std::fs::read_dir(directory.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
            }
        }
    }

    #[test]
    fn policy_file_corruption_is_repaired_only_by_explicit_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SECRET_FILE_NAME);
        let store = LocalSecretStore::new(path.clone());
        let original = b"{ broken synthetic JSON";
        std::fs::write(&path, original).unwrap();
        with_test_store_file_lock(&store, |store| {
            assert!(store.read_policy_file().is_err());
            assert!(store.rotate_policy_file().is_err());
            assert_eq!(std::fs::read(&path)?, original);
            let ready = store.prepare_policy_file()?;
            assert!(ready.policy_epoch.is_some());
            assert!(ready.api_keys.is_empty());
            let quarantine = std::fs::read_dir(directory.path())?
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("provider-secrets.json.corrupt-")
                })
                .unwrap();
            assert_eq!(std::fs::read(quarantine.path())?, original);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    #[ignore]
    fn repair_checkpoint_child() {
        let directory =
            std::path::PathBuf::from(std::env::var_os("MACRO_SYNTHETIC_REPAIR_DIRECTORY").unwrap());
        let point = std::env::var("MACRO_SYNTHETIC_REPAIR_POINT").unwrap();
        *REPAIR_CHECKPOINT.lock().unwrap() =
            Some((directory.join(SECRET_FILE_NAME), point.clone()));
        let result = crate::secrets::init(&directory);
        assert_eq!(
            point, "quarantine-sync-error",
            "crash checkpoint was not reached"
        );
        assert!(result.is_err());
        assert!(!crate::secrets::policy::POLICY.available());
        assert!(crate::secrets::policy::POLICY
            .capture_private(|| Ok(()))
            .is_err());
        assert!(crate::secrets::set_api_key("synthetic", "forbidden").is_err());
        std::process::exit(74);
    }

    #[test]
    fn interrupted_repairs_preserve_raw_bytes_and_require_fresh_startup() {
        for point in [
            "quarantine-rename",
            "quarantine-synced",
            "canonical-replaced",
            "quarantine-sync-error",
            "migration-journal",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(SECRET_FILE_NAME);
            let owner = crate::secrets::policy::PolicyOwner::for_test(directory.path());
            owner.initialize(directory.path()).unwrap();
            let old = owner.capture_private(|| Ok(())).unwrap();
            let original: &[u8] = if point == "migration-journal" {
                br#"{"version":0,"api_keys":{"test":"synthetic"}}"#
            } else {
                b"{ broken synthetic JSON"
            };
            std::fs::write(&path, original).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "secrets::store::policy_file::tests::repair_checkpoint_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("MACRO_SYNTHETIC_REPAIR_DIRECTORY", directory.path())
                .env("MACRO_SYNTHETIC_REPAIR_POINT", point)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(if point == "quarantine-sync-error" {
                    74
                } else {
                    73
                }),
                "point={point}"
            );
            assert!(owner
                .consume_private(&old, || Ok(()), |_, _| Ok(()))
                .is_err());
            let preserved = if point == "migration-journal" {
                assert_eq!(std::fs::read(&path).unwrap(), original);
                directory.path().join("provider-secrets.json.v0.bak")
            } else {
                std::fs::read_dir(directory.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("provider-secrets.json.corrupt-")
                    })
                    .unwrap()
                    .path()
            };
            assert_eq!(std::fs::read(&preserved).unwrap(), original);
            let before_retry = std::fs::read(&path).ok();
            owner.initialize(directory.path()).unwrap();
            let fresh = owner.capture_private(|| Ok(())).unwrap();
            assert!(owner
                .consume_private(&old, || Ok(()), |_, _| Ok(()))
                .is_err());
            assert!(owner
                .consume_private(&fresh, || Ok(()), |_, _| Ok(()))
                .is_ok());
            if point == "migration-journal" {
                assert_eq!(fresh.values(), ["synthetic"]);
                assert!(!directory.path().join(SECRET_MIGRATION_FILE_NAME).exists());
            } else {
                assert!(fresh.values().is_empty());
            }
            assert_ne!(Some(std::fs::read(&path).unwrap()), before_retry);
            assert_eq!(std::fs::read(&preserved).unwrap(), original);
        }
    }
}
