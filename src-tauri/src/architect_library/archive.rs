use super::{
    destination_parent, private_directory, project, publish_path, sync_directory, sync_publication,
    Error, Result,
};
use argentic_runtime::source::{OpenedSource, SelectedFile};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const ARCHIVE_FORMAT: &str = "agsdl-archive-1";
pub const VERSION_FILENAME: &str = "version.agsdl";

// Bound the streamed copy before Argentic decodes selected members.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

pub(super) struct VerifiedArchive {
    snapshot: TempDir,
    pub sha256: String,
    pub has_history: bool,
}

impl VerifiedArchive {
    fn path(&self) -> PathBuf {
        self.snapshot.path().join(VERSION_FILENAME)
    }

    pub(super) fn size(&self) -> io::Result<u64> {
        Ok(std::fs::metadata(self.path())?.len())
    }

    fn copy_to(&self, target: &mut impl Write) -> Result<()> {
        io::copy(&mut File::open(self.path())?, target)?;
        Ok(())
    }
}

fn digest(path: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    io::copy(&mut File::open(path)?, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn read(
    path: &Path,
    expected_sha256: Option<&str>,
    staging_root: &Path,
) -> Result<(OpenedSource, VerifiedArchive)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::UnsupportedSource);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(Error::UnsupportedSource);
        }
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(Error::ArchiveLimit);
    }
    let snapshot = private_directory(staging_root, ".agsdl-archive-")?;
    let staged_path = snapshot.path().join(VERSION_FILENAME);
    let mut staged = crate::fs::profile::create_private_file(&staged_path, false)?;
    if io::copy(&mut file.take(MAX_ARCHIVE_BYTES + 1), &mut staged)? > MAX_ARCHIVE_BYTES {
        return Err(Error::ArchiveLimit);
    }
    drop(staged);
    let sha256 = digest(&staged_path)?;
    if expected_sha256.is_some_and(|expected| expected != sha256) {
        return Err(Error::DigestMismatch);
    }
    let source = OpenedSource::open_path(&staged_path)?;
    // Both readers use the same private file. Only Argentic retains decoded members.
    let has_history = ZipArchive::new(File::open(&staged_path)?)?
        .index_for_name("history.bundle")
        .is_some();
    Ok((
        source,
        VerifiedArchive {
            snapshot,
            sha256,
            has_history,
        },
    ))
}

/// The private artifact directory can receive Macro sidecars before publish.
/// Dropping the staged value discards it.
pub struct StagedVersion {
    directory: TempDir,
    sha256: String,
}

pub struct PublishedVersion {
    pub artifact_id: Uuid,
    pub archive_path: PathBuf,
    pub sha256: String,
}

impl StagedVersion {
    pub fn directory(&self) -> &Path {
        self.directory.path()
    }

    /// Publish under a fresh ID on the same filesystem. The caller owns the
    /// index transaction and must sync any sidecar files it adds.
    #[cfg(test)]
    pub fn publish(self, versions_root: &Path) -> Result<PublishedVersion> {
        self.publish_in(versions_root, true)
    }

    pub(super) fn publish_in(
        self,
        versions_root: &Path,
        sync_bucket: bool,
    ) -> Result<PublishedVersion> {
        sync_directory(self.directory.path())?;
        let artifact_id = Uuid::new_v4();
        let destination = versions_root.join(artifact_id.to_string());
        publish_path(self.directory.path(), &destination)?;
        let _ = self.directory.keep();
        if sync_bucket {
            sync_publication(versions_root, &destination)?;
        }
        Ok(PublishedVersion {
            artifact_id,
            archive_path: destination.join(VERSION_FILENAME),
            sha256: self.sha256,
        })
    }
}

/// Build a deterministic archive. Drop the original decoded members before
/// verifying the archive, so the verifier holds the only decoded selection.
pub fn stage_version(source: OpenedSource, staging_root: &Path) -> Result<StagedVersion> {
    stage_with_executables(source, staging_root, &BTreeSet::new())
}

pub(super) fn stage_with_executables(
    source: OpenedSource,
    staging_root: &Path,
    executable_paths: &BTreeSet<String>,
) -> Result<StagedVersion> {
    let directory = encode_version(&source, staging_root, executable_paths)?;
    drop(source);
    verify_staged(directory)
}

pub(super) fn stage_borrowed_version(
    source: &OpenedSource,
    staging_root: &Path,
) -> Result<StagedVersion> {
    verify_staged(encode_version(source, staging_root, &BTreeSet::new())?)
}

fn encode_version(
    source: &OpenedSource,
    staging_root: &Path,
    executable_paths: &BTreeSet<String>,
) -> Result<TempDir> {
    let directory = private_directory(staging_root, ".agsdl-version-")?;
    let path = directory.path().join(VERSION_FILENAME);
    {
        let mut file = crate::fs::profile::create_private_file(&path, false)?;
        let needs_override = !executable_paths.is_empty()
            && project::members(source)?
                .any(|member| !member.executable && executable_paths.contains(member.path));
        if needs_override {
            write_archive_with_executables(source, executable_paths, &mut file)?;
        } else {
            source.write_archive(&mut file)?;
        }
        file.sync_all()?;
    }
    Ok(directory)
}

fn verify_staged(directory: TempDir) -> Result<StagedVersion> {
    let path = directory.path().join(VERSION_FILENAME);
    OpenedSource::open_path(&path)?;
    let sha256 = digest(&path)?;
    Ok(StagedVersion { directory, sha256 })
}

// The pinned writer takes the mode from the opened filesystem. Windows
// materialization keeps modes in Macro metadata because NTFS has no execute bit.
fn write_archive_with_executables(
    source: &OpenedSource,
    executable_paths: &BTreeSet<String>,
    file: impl Write + Seek,
) -> Result<()> {
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut files = serde_json::Map::new();
    for member in project::members(source)? {
        let executable = member.executable || executable_paths.contains(member.path);
        zip.start_file(
            format!("project/{}", member.path),
            options.unix_permissions(if executable { 0o755 } else { 0o644 }),
        )?;
        zip.write_all(member.bytes)?;
        files.insert(
            member.path.to_owned(),
            serde_json::json!({
                "size": member.bytes.len(),
                "sha256": format!("{:x}", Sha256::digest(member.bytes)),
                "executable": executable,
            }),
        );
    }
    zip.start_file("archive.json", options.unix_permissions(0o644))?;
    serde_json::to_writer(
        &mut zip,
        &serde_json::json!({
            "archiveFormat": ARCHIVE_FORMAT, "files": files,
        }),
    )?;
    zip.write_all(b"\n")?;
    zip.finish()?;
    Ok(())
}

pub(super) fn stage_exact(archive: &VerifiedArchive, staging_root: &Path) -> Result<StagedVersion> {
    let directory = private_directory(staging_root, ".agsdl-version-")?;
    let mut output =
        crate::fs::profile::create_private_file(&directory.path().join(VERSION_FILENAME), false)?;
    archive.copy_to(&mut output)?;
    output.sync_all()?;
    drop(output);
    Ok(StagedVersion {
        directory,
        sha256: archive.sha256.clone(),
    })
}

/// A version verified against its index digest and Argentic's inventory.
/// Keeps the exact archive on private disk for export and the selected members for
/// read-only access or adaptation.
pub struct VersionArchive {
    source: OpenedSource,
    archive: VerifiedArchive,
}

/// In backup validation the file was already copied and hashed in a private
/// stage. Validate the inventory directly against that verified digest.
pub(super) fn validate_private_version(
    path: &Path,
    expected: &str,
    verified: &str,
) -> Result<OpenedSource> {
    if expected != verified {
        return Err(Error::DigestMismatch);
    }
    if std::fs::metadata(path)?.len() > MAX_ARCHIVE_BYTES {
        return Err(Error::ArchiveLimit);
    }
    let source = OpenedSource::open_path(path)?;
    if ZipArchive::new(File::open(path)?)?
        .index_for_name("history.bundle")
        .is_some()
    {
        return Err(Error::UnexpectedHistory);
    }
    Ok(source)
}

pub(super) fn open_version(
    path: &Path,
    expected_sha256: &str,
    staging_root: &Path,
) -> Result<VersionArchive> {
    let (source, archive) = read(path, Some(expected_sha256), staging_root)?;
    if archive.has_history {
        return Err(Error::UnexpectedHistory);
    }
    Ok(VersionArchive { source, archive })
}

impl VersionArchive {
    pub fn source(&self) -> &OpenedSource {
        &self.source
    }

    pub fn members(&self) -> impl ExactSizeIterator<Item = SelectedFile<'_>> + '_ {
        project::members(&self.source).expect("a verified archive has members")
    }

    pub fn export_archive(&self, destination: &Path) -> Result<()> {
        let parent = destination_parent(destination)?;
        let staged = private_directory(parent, ".agsdl-export-")?;
        let path = staged.path().join(VERSION_FILENAME);
        // Stage privately and let the destination filesystem apply the umask.
        let mut output = File::create_new(&path)?;
        self.archive.copy_to(&mut output)?;
        output.sync_all()?;
        drop(output);
        publish_path(&path, destination)?;
        sync_publication(parent, destination)?;
        Ok(())
    }
}
