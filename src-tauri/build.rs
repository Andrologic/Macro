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
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    if target_os.as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource only supplies its manifest to binary targets. Use
        // the linker for the same Common Controls dependency in test binaries.
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("build Tauri Windows resources");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"");
    } else {
        tauri_build::build();
    }
    if target_os.as_deref() == Ok("macos") {
        // Runtime owns and archives the Swift bridge. Preserve deployment on
        // systems preceding LightweightCodeRequirements (macOS 14.4).
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,LightweightCodeRequirements");
    }
}
