use super::artifacts::{insert, Artifacts};
use super::registry::Registry;
use macro_lib::config::{
    schema_for_kind, ConfigApplyMode, ConfigChangeSource, ConfigDescriptor, ConfigDiagnostic,
    ConfigDocument, ConfigDocumentKind, ConfigLifecycle, ConfigMergeStrategy, ConfigOrigin,
    ConfigPatchRequest, ConfigPatchResult, ConfigProvenance, ConfigScope, ConfigSensitivity,
    ConfigSnapshot, ConfigValidationResult, JsonPatchOperation, PendingSensitiveConfigChange,
};

pub fn schemas() -> Result<Artifacts, String> {
    let mut files = Artifacts::new();
    for kind in ConfigDocumentKind::ALL {
        let bytes =
            serde_json::to_vec_pretty(&schema_for_kind(kind)).map_err(|error| error.to_string())?;
        insert(&mut files, kind.schema_file_name().to_owned(), bytes);
    }
    Ok(files)
}

pub fn register(registry: &mut Registry) -> Result<(), String> {
    macro_rules! register_types {
        ($($ty:ty),+ $(,)?) => { $(registry.add::<$ty>("config")?;)+ };
    }
    register_types!(
        ConfigDocumentKind,
        ConfigScope,
        ConfigMergeStrategy,
        ConfigSensitivity,
        ConfigApplyMode,
        ConfigLifecycle,
        ConfigDescriptor,
        ConfigOrigin,
        ConfigProvenance,
        ConfigDiagnostic,
        ConfigDocument,
        ConfigSnapshot,
        JsonPatchOperation,
        ConfigChangeSource,
        PendingSensitiveConfigChange,
        ConfigPatchRequest,
        ConfigPatchResult,
        ConfigValidationResult,
    );
    Ok(())
}
