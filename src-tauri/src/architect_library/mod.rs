//! Native project and immutable archive operations for Architect.

pub mod archive;
mod preview;
pub mod project;

pub use preview::*;

use argentic_runtime::persistence::dto::EngineFailure;
use std::io;
use std::path::Path;

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
