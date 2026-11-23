use super::{
    destination_parent, private_directory, project, publish_path, sync_directory, sync_publication,
    Error, Result,
};
use argentic_runtime::source::{OpenedSource, SelectedFile};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use uuid::Uuid;
use zip::ZipArchive;

pub const ARCHIVE_FORMAT: &str = "agsdl-archive-1";
pub const VERSION_FILENAME: &str = "version.agsdl";

// Match Argentic's compressed input bound before buffering the exact bytes.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

pub(super) struct VerifiedArchive {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub has_history: bool,
}

pub(super) fn read(
    path: &Path,
    expected_sha256: Option<&str>,
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
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(Error::ArchiveLimit);
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    if expected_sha256.is_some_and(|expected| expected != sha256) {
        return Err(Error::DigestMismatch);
    }
    let source = OpenedSource::open_archive_bytes(&bytes)?;
    // Argentic has already verified every ZIP entry, including any history.
    let has_history = ZipArchive::new(Cursor::new(&bytes))?
        .index_for_name("history.bundle")
        .is_some();
    Ok((
        source,
        VerifiedArchive {
            bytes: if has_history { Vec::new() } else { bytes },
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
    pub fn publish(self, versions_root: &Path) -> Result<PublishedVersion> {
        sync_directory(self.directory.path())?;
        let artifact_id = Uuid::new_v4();
        let destination = versions_root.join(artifact_id.to_string());
        publish_path(self.directory.path(), &destination)?;
        let _ = self.directory.keep();
        sync_publication(versions_root, &destination)?;
        Ok(PublishedVersion {
            artifact_id,
            archive_path: destination.join(VERSION_FILENAME),
            sha256: self.sha256,
        })
    }
}

/// Build a deterministic archive from a verified project source.
pub fn stage_version(source: &OpenedSource, staging_root: &Path) -> Result<StagedVersion> {
    stage(staging_root, source, None)
}

pub(super) fn stage(
    staging_root: &Path,
    source: &OpenedSource,
    exact_archive: Option<&[u8]>,
) -> Result<StagedVersion> {
    let directory = private_directory(staging_root, ".agsdl-version-")?;
    let path = directory.path().join(VERSION_FILENAME);
    {
        let mut file = File::create_new(&path)?;
        if let Some(bytes) = exact_archive {
            file.write_all(bytes)?;
        } else {
            source.write_archive(&mut file)?;
        }
        file.sync_all()?;
    }
    OpenedSource::open_path(&path)?;
    let mut hash = Sha256::new();
    let mut file = File::open(&path)?;
    std::io::copy(&mut file, &mut hash)?;
    Ok(StagedVersion {
        directory,
        sha256: format!("{:x}", hash.finalize()),
    })
}

/// A version verified against its index digest and Argentic's inventory.
/// Retains the exact archive bytes for export and the selected members for
/// read-only access or adaptation.
pub struct VersionArchive {
    source: OpenedSource,
    archive: VerifiedArchive,
}

pub fn open_version(path: &Path, expected_sha256: &str) -> Result<VersionArchive> {
    let (source, archive) = read(path, Some(expected_sha256))?;
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
        let mut file = File::create_new(&path)?;
        file.write_all(&self.archive.bytes)?;
        file.sync_all()?;
        drop(file);
        publish_path(&path, destination)?;
        sync_publication(parent, destination)?;
        Ok(())
    }
}
