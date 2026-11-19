fn main() {
    println!("cargo:rustc-check-cfg=cfg(argentic_editor_parity)");
    println!("cargo:rerun-if-env-changed=ARGENTIC_EDITOR_PARITY_CORE");
    if let Some(core) = std::env::var_os("ARGENTIC_EDITOR_PARITY_CORE") {
        let core = std::path::PathBuf::from(core);
        let source = core.join("src/lib.rs");
        let codec = core.join("src/native_json.rs");
        let numbers = core.join("../argentic-runtime/src/native_numbers.rs");
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        std::fs::write(
            output.join("argentic_editor_core.rs"),
            format!("#[path = {source:?}]\nmod argentic_core;\n"),
        )
        .expect("write editor parity module");
        std::fs::write(
            output.join("argentic_editor_codec.rs"),
            format!(
                "#[path = {codec:?}]\nmod codec;\n#[path = {numbers:?}]\nmod native_numbers;\n"
            ),
        )
        .expect("write editor parity codec modules");
        println!("cargo:rustc-cfg=argentic_editor_parity");
    }
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Runtime owns and archives the Swift bridge. Preserve deployment on
        // systems preceding LightweightCodeRequirements (macOS 14.4).
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,LightweightCodeRequirements");
    }
}
