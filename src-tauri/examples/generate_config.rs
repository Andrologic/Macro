#[path = "generate_config/artifacts.rs"]
mod artifacts;
#[path = "generate_config/register_config.rs"]
mod register_config;
#[path = "generate_config/register_ipc.rs"]
mod register_ipc;
#[path = "generate_config/registry.rs"]
mod registry;

use std::path::PathBuf;

fn main() -> Result<(), String> {
    let mut check = false;
    let mut domain = "config".to_owned();
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--check" => check = true,
            "--domain" => domain = args.next().ok_or("Missing --domain value")?,
            "--out-dir" => {
                output = Some(PathBuf::from(args.next().ok_or("Missing --out-dir value")?))
            }
            "--help" | "-h" => {
                println!("generate_config [--domain config|ipc] [--check] [--out-dir DIRECTORY]");
                println!("--out-dir replaces the repository root for output, retaining repository-relative paths.");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {argument}")),
        }
    }
    if domain != "config" && domain != "ipc" {
        return Err(format!("Unknown domain: {domain}; expected config or ipc"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root =
        output.unwrap_or_else(|| manifest.parent().expect("Rust manifest parent").to_owned());
    let ipc = domain == "ipc";
    let mut registry = registry::Registry::new(ipc);
    let mut outputs = Vec::new();
    if ipc {
        register_ipc::register(&mut registry)?;
    } else {
        register_config::register(&mut registry)?;
        outputs.push((
            root.join("src-tauri/config-schemas/v1"),
            register_config::schemas()?,
        ));
    }
    outputs.push((
        root.join("src/types/generated").join(&domain),
        registry.artifacts(ipc)?,
    ));
    // Validate every output before the first write. --check performs only reads.
    for (directory, files) in &outputs {
        artifacts::validate(directory, files, check)?;
    }
    if !check {
        for (directory, files) in &outputs {
            artifacts::write(directory, files)?;
        }
    }
    println!(
        "Artifacts {domain}: {}.",
        if check { "checked" } else { "generated" }
    );
    Ok(())
}
