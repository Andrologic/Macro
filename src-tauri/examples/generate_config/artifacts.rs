use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub type Artifacts = BTreeMap<String, Vec<u8>>;

pub fn insert(files: &mut Artifacts, name: String, mut bytes: Vec<u8>) {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    files.insert(name, bytes);
}

/// Verify the actual imports emitted by ts-rs, including every transitive file.
/// Resolve relative imports inside the output tree, never against existing files.
pub fn verify_imports(files: &Artifacts) -> Result<(), String> {
    for (file, bytes) in files.iter().filter(|(name, _)| name.ends_with(".ts")) {
        let source = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
        for line in source.lines().filter(|line| line.starts_with("import ")) {
            let (names, target) = line
                .strip_prefix("import type { ")
                .and_then(|line| line.split_once(" } from \""))
                .and_then(|(names, target)| target.strip_suffix("\";").map(|t| (names, t)))
                .ok_or_else(|| format!("Unsupported generated import in {file}: {line}"))?;
            let mut parts: Vec<_> = file.split('/').collect();
            parts.pop();
            if !target.starts_with("./") && !target.starts_with("../") {
                return Err(format!("Non-local import in {file}: {target}"));
            }
            for part in target.split('/') {
                match part {
                    "." => (),
                    ".." => {
                        parts
                            .pop()
                            .ok_or_else(|| format!("Import escapes output in {file}: {target}"))?;
                    }
                    part if part.is_empty() || part.contains(['\\', ':']) => {
                        return Err(format!("Invalid import in {file}: {target}"))
                    }
                    part => parts.push(part),
                }
            }
            let imported = files
                .get(&format!("{}.ts", parts.join("/")))
                .ok_or_else(|| format!("Unresolved import in {file}: {target}"))?;
            let imported = std::str::from_utf8(imported).map_err(|error| error.to_string())?;
            for name in names.split(", ") {
                if !imported.lines().any(|line| {
                    line.strip_prefix(&format!("export type {name}"))
                        .is_some_and(|tail| tail.starts_with(" =") || tail.starts_with('<'))
                }) {
                    return Err(format!("Unresolved symbol {name} in {file} from {target}"));
                }
            }
        }
    }
    Ok(())
}

fn existing_files(root: &Path, directory: &Path, result: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(directory)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err(format!("Symlink output directory: {}", directory.display()));
    }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            existing_files(root, &entry.path(), result)?;
        } else if kind.is_file() {
            result.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
        } else {
            return Err(format!(
                "Unsupported output entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

/// Read-only, including when the directory or an expected file is absent.
pub fn validate(directory: &Path, files: &Artifacts, check: bool) -> Result<(), String> {
    let mut existing = Vec::new();
    existing_files(directory, directory, &mut existing)?;
    existing.sort();
    for path in existing {
        if !files.contains_key(&path.to_string_lossy().replace('\\', "/")) {
            return Err(format!(
                "Unexpected artifact: {}",
                directory.join(path).display()
            ));
        }
    }
    if check {
        for (name, expected) in files {
            let path = directory.join(name);
            let current = fs::read(&path)
                .map_err(|error| format!("Missing artifact {}: {error}", path.display()))?;
            if &current != expected {
                return Err(format!("Outdated artifact: {}", path.display()));
            }
        }
    }
    Ok(())
}

pub fn write(directory: &Path, files: &Artifacts) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    for (name, bytes) in files {
        let path = directory.join(name);
        fs::create_dir_all(path.parent().ok_or("Output parent missing")?)
            .map_err(|error| error.to_string())?;
        fs::write(path, bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixtures() -> Artifacts {
        BTreeMap::from([
            (
                "Root.ts".into(),
                include_bytes!("fixtures/Root.ts.fixture").to_vec(),
            ),
            (
                "Child.ts".into(),
                include_bytes!("fixtures/Child.ts.fixture").to_vec(),
            ),
            (
                "Leaf.ts".into(),
                include_bytes!("fixtures/Leaf.ts.fixture").to_vec(),
            ),
        ])
    }

    #[test]
    fn imports_must_resolve_transitively_and_export_the_named_symbol() {
        let mut files = fixtures();
        verify_imports(&files).unwrap();
        files.remove("Leaf.ts");
        assert!(verify_imports(&files).unwrap_err().contains("Child.ts"));
        files.insert("Leaf.ts".into(), b"export type Wrong = string;\n".to_vec());
        assert!(verify_imports(&files)
            .unwrap_err()
            .contains("Unresolved symbol Leaf"));
        files.insert(
            "Leaf.ts".into(),
            b"import type { X } from \"../X\";\n".to_vec(),
        );
        assert!(verify_imports(&files).is_err());
    }

    #[test]
    fn nested_imports_resolve_relative_to_the_importer() {
        let files = BTreeMap::from([
            (
                "Root.ts".into(),
                b"import type { Child } from \"./nested/Child\";\nexport type Root = Child;\n"
                    .to_vec(),
            ),
            (
                "nested/Child.ts".into(),
                b"import type { Leaf } from \"../Leaf\";\nexport type Child = Leaf;\n".to_vec(),
            ),
            (
                "Leaf.ts".into(),
                include_bytes!("fixtures/Leaf.ts.fixture").to_vec(),
            ),
        ]);
        verify_imports(&files).unwrap();
        let mut broken = files;
        broken.insert(
            "nested/Child.ts".into(),
            b"import type { Leaf } from \"../../Leaf\";\nexport type Child = Leaf;\n".to_vec(),
        );
        assert!(verify_imports(&broken)
            .unwrap_err()
            .contains("escapes output"));
    }

    #[test]
    fn check_never_repairs_missing_changed_or_extra_files() {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "macro-generator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let files = fixtures();
        assert!(validate(&root, &files, true).is_err());
        assert!(!root.exists());
        write(&root, &files).unwrap();
        validate(&root, &files, true).unwrap();
        fs::write(root.join("Leaf.ts"), b"changed").unwrap();
        assert!(validate(&root, &files, true).is_err());
        assert_eq!(fs::read(root.join("Leaf.ts")).unwrap(), b"changed");
        write(&root, &files).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/old.ts"), b"old").unwrap();
        assert!(validate(&root, &files, true)
            .unwrap_err()
            .contains("Unexpected"));
        assert_eq!(fs::read(root.join("nested/old.ts")).unwrap(), b"old");
        fs::remove_file(root.join("nested/old.ts")).unwrap();
        fs::remove_file(root.join("Root.ts")).unwrap();
        assert!(validate(&root, &files, true).is_err());
        assert!(!root.join("Root.ts").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
