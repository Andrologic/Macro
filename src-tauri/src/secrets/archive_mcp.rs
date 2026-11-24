//! The archive runtime reads credentials only through these typed keys.
use super::{policy::POLICY, SecretError};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ArchiveMcpKey(String);

impl ArchiveMcpKey {
    pub(crate) fn from_digest(digest: [u8; 32]) -> Self {
        Self(format!(
            "archive-mcp:{:x}",
            sha2::digest::Output::<sha2::Sha256>::from(digest)
        ))
    }
}

/// Both identifiers used before credentials were bound to their destination.
pub(crate) struct LegacyArchiveMcpKey([String; 2]);

impl LegacyArchiveMcpKey {
    pub(crate) fn from_digest(digest: [u8; 32]) -> Self {
        let digest = sha2::digest::Output::<sha2::Sha256>::from(digest);
        Self([
            format!("architect-launch:{digest:x}"),
            format!("archive-mcp:{digest:x}"),
        ])
    }
}

pub(crate) fn has_legacy(key: &LegacyArchiveMcpKey) -> Result<bool, SecretError> {
    POLICY.read(|data| {
        Ok(key
            .0
            .iter()
            .any(|id| data.namespaces.archive_mcp.contains_key(id)))
    })
}

/// The launch service must prove the destination before attempting this move.
pub(crate) fn reassociate_legacy(
    old: &LegacyArchiveMcpKey,
    new: &ArchiveMcpKey,
    valid: impl Fn(&str) -> bool,
) -> Result<bool, SecretError> {
    POLICY.mutation(|store, mut data| {
        let keys = &mut data.namespaces.archive_mcp;
        if let Some(current) = keys.get(&new.0) {
            return Ok(valid(current));
        }
        let mut values = old.0.iter().filter_map(|id| keys.get(id));
        let Some(value) = values.next() else {
            return Ok(false);
        };
        if !valid(value) || values.any(|other| other != value) {
            return Ok(false);
        }
        let value = value.clone();
        for id in &old.0 {
            keys.remove(id);
        }
        keys.insert(new.0.clone(), value);
        store.write_file(&data)?;
        Ok(true)
    })
}

pub(super) fn legacy_id(id: &str) -> bool {
    id.strip_prefix("architect-launch:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

pub(crate) fn get(key: &ArchiveMcpKey) -> Result<Option<String>, SecretError> {
    POLICY.read(|data| Ok(data.namespaces.archive_mcp.get(&key.0).cloned()))
}

pub(crate) fn set(key: &ArchiveMcpKey, value: &str) -> Result<(), SecretError> {
    POLICY.mutation(|store, mut data| {
        data.namespaces
            .archive_mcp
            .insert(key.0.clone(), value.into());
        store.write_file(&data)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_keys_never_resolve_through_the_provider_namespace() {
        let _guard = crate::secrets::lock_test_store();
        let data = tempfile::tempdir().unwrap();
        let old_id = format!("architect-launch:{}", "a".repeat(64));
        let path = data.path().join("provider-secrets.json");
        std::fs::write(&path, json!({
            "version": 2,
            "namespaces": {"providers": {(old_id.clone()): "legacy-credential", "other": "kept"}}
        }).to_string()).unwrap();
        crate::secrets::init(data.path()).unwrap();

        assert!(crate::secrets::get_api_key(&old_id).unwrap().is_none());
        assert_eq!(
            crate::secrets::get_api_key("other").unwrap().as_deref(),
            Some("kept")
        );
        let key = ArchiveMcpKey::from_digest([42; 32]);
        assert!(get(&key).unwrap().is_none());
        set(&key, "archive-credential").unwrap();
        assert!(crate::secrets::get_api_key(&key.0).unwrap().is_none());
        crate::secrets::set_api_key(&key.0, "provider-credential").unwrap();
        assert_eq!(
            crate::secrets::get_api_key(&key.0).unwrap().as_deref(),
            Some("provider-credential")
        );
        assert_eq!(get(&key).unwrap().as_deref(), Some("archive-credential"));

        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(
            saved["namespaces"]["archiveMcp"][old_id],
            "legacy-credential"
        );
    }
}
