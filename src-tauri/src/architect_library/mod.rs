//! Native project and immutable archive operations for Architect.

pub mod archive;
pub(crate) mod editor_document;
pub(crate) mod migration;
mod preview;
pub mod project;
pub(crate) mod storage;

pub use preview::*;

use argentic_runtime::persistence::dto::EngineFailure;
use std::io;
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Expected an AgSDL project folder, agsdl.json or .agsdl archive")]
    UnsupportedSource,
    #[error("{message}")]
    Agsdl {
        code: String,
        pointer: String,
        message: String,
    },
    #[error("The selected project path is a symbolic link: {0}")]
    SymbolicLink(std::path::PathBuf),
    #[error("Archive exceeds the AgSDL input limit")]
    ArchiveLimit,
    #[error("Invalid archive: {0}")]
    InvalidArchive(#[from] zip::result::ZipError),
    #[error("Stored archive digest does not match the version")]
    DigestMismatch,
    #[error("Stored version contains Git history")]
    UnexpectedHistory,
    #[error("Destination already exists")]
    DestinationExists,
    #[error("Published {destination:?}, but could not sync its directory: {source}")]
    PublishedNotSynced {
        destination: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    Storage(String),
    #[error("Invalid destination path")]
    InvalidDestination,
    #[error("Filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("Could not read or write project JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<EngineFailure> for Error {
    fn from(error: EngineFailure) -> Self {
        Self::Agsdl {
            code: error.code,
            pointer: error.pointer,
            message: error.message,
        }
    }
}

fn destination_parent(destination: &Path) -> Result<&Path> {
    if destination.file_name().is_none() {
        return Err(Error::InvalidDestination);
    }
    Ok(destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new(".")))
}

fn publish_error(error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::AlreadyExists {
        Error::DestinationExists
    } else {
        Error::Io(error)
    }
}

fn publish_path(source: &Path, destination: &Path) -> Result<()> {
    crate::fs::operations::rename_without_replacement(source, destination).map_err(publish_error)
}

fn sync_publication(parent: &Path, destination: &Path) -> Result<()> {
    #[cfg(test)]
    let result = if FAIL_PUBLICATION_SYNC.take() {
        Err(io::Error::other("injected directory sync failure"))
    } else {
        sync_directory(parent)
    };
    #[cfg(not(test))]
    let result = sync_directory(parent);
    result.map_err(|source| Error::PublishedNotSynced {
        destination: destination.to_path_buf(),
        source,
    })
}

#[cfg(test)]
thread_local! {
    static FAIL_PUBLICATION_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn private_directory(root: &Path, prefix: &str) -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(root)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path; // The Windows no-replace move uses MOVEFILE_WRITE_THROUGH.
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod storage_tests;
