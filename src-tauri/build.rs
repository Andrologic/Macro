fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Runtime owns and archives the Swift bridge. Preserve deployment on
        // systems preceding LightweightCodeRequirements (macOS 14.4).
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,LightweightCodeRequirements");
    }
}
