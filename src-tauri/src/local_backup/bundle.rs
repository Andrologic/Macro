use super::{
    architect_artifact_prefix, entry_digest, Archive, Entry, Result, DATABASE_ENTRIES, LIMIT,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::Digest;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "profile.json";

fn stream_hash(
    mut input: impl Read,
    mut output: impl Write,
    executable: bool,
) -> io::Result<String> {
    let mut digest = entry_digest(executable);
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn staged_path(root: &Path, name: &str) -> PathBuf {
    // The archive contains the full path. The private copy needs only a
    // fixed-width, collision-resistant name, even for PATH_MAX members.
    root.join(super::hash(name.as_bytes()))
}

impl Entry {
    pub(super) fn size(&self, name: &str) -> Result<u64> {
        if let Some(root) = &self.native {
            Ok(fs::metadata(staged_path(root.path(), name))
                .map_err(|error| error.to_string())?
                .len())
        } else {
            Ok(STANDARD
                .decode(&self.data)
                .map_err(|error| error.to_string())?
                .len() as u64)
        }
    }

    pub(super) fn copy_verified(&self, name: &str, output: impl Write) -> io::Result<()> {
        let checksum = if let Some(root) = &self.native {
            stream_hash(
                File::open(staged_path(root.path(), name))?,
                output,
                self.executable,
            )?
        } else {
            let bytes = STANDARD.decode(&self.data).map_err(io::Error::other)?;
            stream_hash(bytes.as_slice(), output, self.executable)?
        };
        if checksum != self.sha256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("File checksum mismatch for {name}"),
            ));
        }
        Ok(())
    }
}

fn streamed_name(name: &str) -> bool {
    DATABASE_ENTRIES.contains(&name) || architect_artifact_prefix(name).is_some()
}

pub(super) fn stage(
    root: &Arc<TempDir>,
    name: &str,
    input: impl Read,
    executable: bool,
) -> Result<Entry> {
    if !streamed_name(name) {
        return Err("Unexpected streamed profile backup entry".into());
    }
    let output = super::create_private_file(&staged_path(root.path(), name), false)
        .map_err(|error| error.to_string())?;
    Ok(Entry {
        data: String::new(),
        sha256: stream_hash(input, output, executable).map_err(|e| e.to_string())?,
        executable,
        native: Some(Arc::clone(root)),
    })
}

pub(super) fn write(archive: &Archive, file: &mut File) -> io::Result<()> {
    let manifest = serde_json::to_vec(archive)?;
    if manifest.len() as u64 > LIMIT {
        return Err(io::Error::other(
            "Profile backup metadata exceeds the 256 MiB limit",
        ));
    }
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file(MANIFEST, options)?;
    zip.write_all(&manifest)?;
    for (name, entry) in &archive.files {
        if let Some(root) = &entry.native {
            let size = fs::metadata(staged_path(root.path(), name))?.len();
            zip.start_file(name, options.large_file(size >= u64::from(u32::MAX)))?;
            entry.copy_verified(name, &mut zip)?;
        }
    }
    zip.finish()?;
    Ok(())
}

pub(super) fn load(path: &Path, data: &Path) -> Result<Archive> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || crate::architect_library::storage::is_link_or_reparse_point(&metadata)
    {
        return Err("Backup entry is not a regular file".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0; 4];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if header != *b"PK\x03\x04" {
        return serde_json::from_slice(&super::read_bounded(path)?).map_err(|e| e.to_string());
    }
    let mut zip = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut archive: Archive = {
        let mut manifest = zip.by_name(MANIFEST).map_err(|e| e.to_string())?;
        if manifest.size() > LIMIT || manifest.compression() != CompressionMethod::Stored {
            return Err("Invalid profile backup manifest".into());
        }
        let mut bytes = Vec::new();
        manifest
            .by_ref()
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("Profile backup manifest exceeds its limit".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    };
    super::validate_architect_paths(&archive.files)?;
    let root = Arc::new(super::private_staging(data)?);
    let mut manifest_seen = false;
    for index in 0..zip.len() {
        let mut member = zip.by_index(index).map_err(|e| e.to_string())?;
        let name = member.name().to_owned();
        if name == MANIFEST && !manifest_seen {
            manifest_seen = true;
            continue;
        }
        let entry = archive
            .files
            .get_mut(&name)
            .filter(|entry| streamed_name(&name) && entry.native.is_none() && entry.data.is_empty())
            .ok_or("Unexpected file in profile backup bundle")?;
        if !member.is_file()
            || member.compression() != CompressionMethod::Stored
            || member.compressed_size() != member.size()
        {
            return Err("Invalid file in profile backup bundle".into());
        }
        let snapshot = stage(&root, &name, &mut member, entry.executable)?;
        if snapshot.sha256 != entry.sha256 {
            return Err(format!("File checksum mismatch for {name}"));
        }
        entry.native = snapshot.native;
    }
    Ok(archive)
}
