use std::{fs, io, path::Path};

fn copy_parity_source(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_parity_source(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn expose_for_parity(root: &Path, path: &str, item: &str) {
    let path = root.join(path);
    let text = fs::read_to_string(&path).expect("read locked Argentic source");
    assert!(text.contains(item), "Argentic parity hook changed: {item}");
    fs::write(&path, text.replacen(item, &format!("pub(crate) {item}"), 1))
        .expect("write test-only Argentic source");
}

fn main() {
    println!("cargo:rustc-check-cfg=cfg(argentic_editor_parity)");
    println!("cargo:rerun-if-env-changed=ARGENTIC_EDITOR_PARITY_CORE");
    if let Some(core) = std::env::var_os("ARGENTIC_EDITOR_PARITY_CORE") {
        let core = std::path::PathBuf::from(core);
        let numbers = core.join("../argentic-runtime/src/native_numbers.rs");
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let parity_core = output.join("argentic-parity");
        for directory in ["src", "assets"] {
            let source = core.join(directory);
            println!("cargo:rerun-if-changed={}", source.display());
            copy_parity_source(&source, &parity_core.join(directory))
                .expect("copy locked Argentic source for editor parity");
        }
        // The parity tests exercise pure internals. Only visibility changes in this
        // copy. Macro still links the Cargo dependency as-is for production.
        for (file, item) in [
            ("lib.rs", "mod resource;"),
            ("lib.rs", "mod native_json;"),
            ("compile/host.rs", "fn encode("),
            ("compile/configuration.rs", "fn json(value:"),
            ("graph/mod.rs", "fn immediate_dominators("),
        ] {
            expose_for_parity(&parity_core.join("src"), file, item);
        }
        let source = parity_core.join("src/lib.rs");
        let codec = parity_core.join("src/native_json.rs");
        fs::write(
            output.join("argentic_editor_core.rs"),
            format!(
                "#[path = {source:?}]\nmod argentic_core;\n\
                 pub(crate) use argentic_core::{{calculation, compile, exact, graph, native, native_json, reader, resource, validate, \
                 validate_document_json, SourceBudget, AGSDL_040, GRAPH_LIMIT_CODE, MAX_SOURCE_BYTES, MAX_SOURCE_WORK}};\n"
            ),
        ).expect("write editor parity module");
        fs::write(
            output.join("argentic_editor_codec.rs"),
            format!(
                "#[path = {codec:?}]\nmod codec;\n#[path = {numbers:?}]\nmod native_numbers;\n"
            ),
        )
        .expect("write editor parity codec modules");
        println!("cargo:rustc-cfg=argentic_editor_parity");
    }
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    if target_os.as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource only supplies its manifest to binary targets. Use
        // the linker for the same Common Controls dependency in test binaries.
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("build Tauri Windows resources");
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        tauri_build::build();
    }
    if target_os.as_deref() == Ok("macos") {
        // Runtime owns and archives the Swift bridge. Preserve deployment on
        // systems preceding LightweightCodeRequirements (macOS 14.4).
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,LightweightCodeRequirements");
    }
}
