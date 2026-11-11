fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let source = "src/agsdl_content/macos_launcher.swift";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("Unsupported macOS architecture for content helper QA"),
    };
    let deployment = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "13.0".into());
    let target = format!("{arch}-apple-macosx{deployment}");
    let object = out.join("agsdl_content_launcher.o");
    let mut compiler = std::process::Command::new("swiftc");
    compiler.args([
        "-target",
        &target,
        "-parse-as-library",
        "-emit-object",
        source,
    ]);
    // This hook exists only in the explicit macOS debug QA build. If a QA
    // configuration omits it, linking the QA-only FFI must fail closed.
    if std::env::var("PROFILE").as_deref() == Ok("debug")
        && std::env::var_os("CARGO_FEATURE_AGSDL_CONTENT_QA").is_some()
    {
        compiler.args(["-D", "AGSDL_CONTENT_TESTING"]);
    }
    let status = compiler
        .arg("-module-cache-path")
        .arg(out.join("swift-module-cache"))
        .arg("-o")
        .arg(&object)
        .status()
        .expect("start swiftc");
    assert!(status.success(), "Swift content helper compilation failed");
    let info = std::process::Command::new("swiftc")
        .args(["-target", &target, "-print-target-info"])
        .output()
        .expect("query Swift target");
    assert!(
        info.status.success(),
        "Swift target information unavailable"
    );
    let info: serde_json::Value = serde_json::from_slice(&info.stdout).expect("Swift target JSON");
    let paths = info
        .pointer("/paths/runtimeLibraryPaths")
        .and_then(serde_json::Value::as_array)
        .expect("Swift runtime library paths");
    for path in paths {
        println!(
            "cargo:rustc-link-search=native={}",
            path.as_str().expect("Swift runtime path")
        );
    }
    println!("cargo:rustc-link-arg={}", object.display());
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,LightweightCodeRequirements");
}
