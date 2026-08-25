use macro_lib::config::{
    schema_for_kind, ConfigApplyMode, ConfigChangeSource, ConfigDescriptor, ConfigDiagnostic,
    ConfigDocument, ConfigDocumentKind, ConfigLifecycle, ConfigMergeStrategy, ConfigOrigin,
    ConfigPatchRequest, ConfigPatchResult, ConfigProvenance, ConfigScope, ConfigSensitivity,
    ConfigSnapshot, ConfigValidationResult, JsonPatchOperation, PendingSensitiveConfigChange,
};
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::{Config, TS};

fn write_or_check(path: &Path, mut contents: Vec<u8>, check: bool) -> Result<(), String> {
    if !contents.ends_with(b"\n") {
        contents.push(b'\n');
    }
    if check {
        let current = fs::read(path)
            .map_err(|error| format!("Artefact manquant {} : {error}", path.display()))?;
        if current != contents {
            return Err(format!(
                "Artefact obsolète {}. Exécutez bun run config:generate.",
                path.display()
            ));
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn export_type<T: TS + 'static>(
    config: &Config,
    directory: &Path,
    check: bool,
) -> Result<(), String> {
    let target = directory.join(format!("{}.ts", T::name(&config)));
    let contents = T::export_to_string(config)
        .map_err(|error| error.to_string())?
        .into_bytes();
    write_or_check(&target, contents, check)
}

fn main() -> Result<(), String> {
    let check = std::env::args().any(|argument| argument == "--check");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository_root = manifest_dir
        .parent()
        .ok_or_else(|| "Le manifeste Rust n’a pas de dossier parent.".to_string())?;
    let schema_root = manifest_dir.join("config-schemas").join("v1");
    let type_root = repository_root
        .join("src")
        .join("types")
        .join("generated")
        .join("config");
    let ts_config = Config::default().with_out_dir(manifest_dir.join("bindings"));

    for kind in ConfigDocumentKind::ALL {
        let bytes =
            serde_json::to_vec_pretty(&schema_for_kind(kind)).map_err(|error| error.to_string())?;
        write_or_check(&schema_root.join(kind.schema_file_name()), bytes, check)?;
    }

    let mut type_names = Vec::new();
    macro_rules! export_types {
        ($($type:ty),+ $(,)?) => {
            $(
                export_type::<$type>(&ts_config, &type_root, check)?;
                type_names.push(<$type>::name(&ts_config));
            )+
        };
    }
    export_types!(
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
    let index = type_names
        .iter()
        .map(|name| format!("export type {{ {name} }} from './{name}';"))
        .collect::<Vec<_>>()
        .join("\n");
    write_or_check(&type_root.join("index.ts"), index.into_bytes(), check)?;

    println!(
        "Artefacts de configuration {}.",
        if check { "vérifiés" } else { "générés" }
    );
    Ok(())
}
