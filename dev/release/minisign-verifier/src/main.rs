use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};

struct Asset {
    path: PathBuf,
    signature_path: PathBuf,
}

fn usage() {
    println!(
        "Usage: cargo run --manifest-path dev/release/minisign-verifier/Cargo.toml -- \\
  --public-key-b64 <tauri-public-key> \\
  --asset <path> --signature <path> [...]"
    );
}

fn next_argument(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("Argument {name} requires a value."))
}

fn expect_argument(args: &[String], index: &mut usize, expected: &str) -> Result<(), String> {
    *index += 1;
    if args.get(*index).map(String::as_str) == Some(expected) {
        Ok(())
    } else {
        Err(format!("Each --asset must be followed by {expected}."))
    }
}

fn parse_arguments(args: &[String]) -> Result<(String, Vec<Asset>), String> {
    let mut public_key = None;
    let mut assets = Vec::new();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--public-key-b64" => public_key = Some(next_argument(args, &mut index, "--public-key-b64")?),
            "--asset" => {
                let path = next_argument(args, &mut index, "--asset")?;
                expect_argument(args, &mut index, "--signature")?;
                let signature_path = next_argument(args, &mut index, "--signature")?;
                assets.push(Asset {
                    path: PathBuf::from(path),
                    signature_path: PathBuf::from(signature_path),
                });
            }
            "--help" => {
                usage();
                std::process::exit(0);
            }
            argument => return Err(format!("Unknown argument: {argument}")),
        }
        index += 1;
    }

    let public_key = public_key.ok_or_else(|| "Argument --public-key-b64 is required.".to_string())?;
    if assets.is_empty() {
        return Err("At least one --asset and --signature pair is required.".to_string());
    }
    Ok((public_key, assets))
}

fn verify(public_key_b64: &str, assets: &[Asset]) -> Result<(), String> {
    let public_key_text = BASE64
        .decode(public_key_b64)
        .map_err(|_| "Configured updater public key is not valid base64.".to_string())?;
    let public_key_text = String::from_utf8(public_key_text)
        .map_err(|_| "Configured updater public key is not valid UTF-8 minisign text.".to_string())?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("Configured updater public key is invalid: {error}"))?;

    for asset in assets {
        let bytes = fs::read(&asset.path)
            .map_err(|error| format!("Unable to read updater asset {}: {error}", asset.path.display()))?;
        let signature_b64 = fs::read_to_string(&asset.signature_path)
            .map_err(|error| format!("Unable to read updater signature {}: {error}", asset.signature_path.display()))?;
        let signature_text = BASE64
            .decode(signature_b64.trim())
            .map_err(|_| format!("Updater signature {} is not valid base64.", asset.signature_path.display()))?;
        let signature_text = String::from_utf8(signature_text)
            .map_err(|_| format!("Updater signature {} is not valid UTF-8 minisign text.", asset.signature_path.display()))?;
        let signature = Signature::decode(&signature_text)
            .map_err(|error| format!("Updater signature {} is invalid: {error}", asset.signature_path.display()))?;

        public_key
            .verify(&bytes, &signature, true)
            .map_err(|error| format!("Updater signature verification failed for {}: {error}", asset.path.display()))?;
    }

    println!("Verified {} minisign updater signature(s).", assets.len());
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match parse_arguments(&args).and_then(|(public_key, assets)| verify(&public_key, &assets)) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
