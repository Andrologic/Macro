//! Native project and immutable archive operations for Architect.

pub mod archive;
pub(crate) mod editor_document;
pub(crate) mod imports;
pub(crate) mod migration;
mod preview;
pub mod project;
pub(crate) mod project_editor;
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
        file: Option<String>,
        pointer: String,
        message: String,
    },
    #[error("Could not read project file {path:?} at {file}#{pointer}: {source}")]
    ProjectIo {
        file: String,
        pointer: String,
        path: String,
        #[source]
        source: io::Error,
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
    #[error("The destination folder {0:?} does not exist")]
    DestinationParentMissing(PathBuf),
    #[error("Published {destination:?}, but could not sync its directory: {source}")]
    PublishedNotSynced {
        destination: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    Editor(&'static str),
    #[error("{}", .0.message)]
    Diagnostic(Diagnostic),
    #[error("Invalid destination path")]
    InvalidDestination,
    #[error("Filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("Could not read or write project JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<EngineFailure> for Error {
    fn from(error: EngineFailure) -> Self {
        let mut file = None;
        if error.code == "PROJECT" {
            // The pinned runtime flattens its project failure into
            // file#pointer: detail. Parse that boundary before mapping IO.
            let separator = format!("#{}: ", error.pointer);
            if let Some((location, detail)) = error.message.split_once(&separator) {
                if let Some((path, source)) = project_io(location, detail) {
                    return Self::ProjectIo {
                        file: location.into(),
                        pointer: error.pointer,
                        path: path.into(),
                        source,
                    };
                }
                file = Some(location.into());
            }
        }
        Self::Agsdl {
            code: error.code,
            file,
            pointer: error.pointer,
            message: error.message,
        }
    }
}

fn project_io<'a>(file: &'a str, detail: &'a str) -> Option<(&'a str, io::Error)> {
    let (_, code) = detail.rsplit_once(" (os error ")?;
    let source = io::Error::from_raw_os_error(code.strip_suffix(')')?.parse().ok()?);
    // Match the entire system message. JSON diagnostics can quote arbitrary
    // strings, including text that merely ends with an OS error number.
    let description = source.to_string();
    let path = if detail == description {
        file
    } else {
        let path = detail.strip_suffix(&description)?.strip_suffix(": ")?;
        if !editor_document::portable_path(path) {
            return None;
        }
        path
    };
    Some((path, source))
}

fn destination_parent(destination: &Path) -> Result<&Path> {
    if destination.file_name().is_none() {
        return Err(Error::InvalidDestination);
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(parent),
        Ok(_) => Err(Error::InvalidDestination),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Err(Error::DestinationParentMissing(parent.to_path_buf()))
        }
        Err(error) => Err(error.into()),
    }
}

fn publish_error(error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::AlreadyExists {
        Error::DestinationExists
    } else {
        Error::Io(error)
    }
}

fn publish_path(source: &Path, destination: &Path) -> Result<()> {
    crate::fs::profile::rename_without_replacement(source, destination).map_err(publish_error)
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

pub(crate) fn private_directory(root: &Path, prefix: &str) -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(test)]
    crate::fs::profile::check("mkdir", &root.join(prefix))?;
    builder.tempdir_in(root)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    crate::fs::profile::sync_directory(path)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod storage_tests;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub file: Option<String>,
    pub pointer: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<DiagnosticSource>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSource {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

impl Diagnostic {
    fn migration(message: String) -> Self {
        Self {
            code: "MIGRATION".into(),
            file: None,
            pointer: String::new(),
            message,
            source: None,
        }
    }
}

impl Error {
    pub(crate) fn diagnostic(self) -> Diagnostic {
        fn make(code: &str, message: String) -> Diagnostic {
            Diagnostic {
                code: code.into(),
                message,
                file: None,
                pointer: String::new(),
                source: None,
            }
        }
        let message = self.to_string();
        match self {
            Self::Diagnostic(diagnostic) => diagnostic,
            Self::ProjectIo {
                file,
                pointer,
                path,
                ..
            } => Diagnostic {
                file: Some(file),
                pointer,
                source: Some(DiagnosticSource {
                    kind: "io",
                    path: Some(path),
                }),
                ..make("PROJECT", message)
            },
            Self::Agsdl {
                code,
                file,
                pointer,
                message,
            } => Diagnostic {
                file,
                pointer,
                source: (code == "PROJECT").then_some(DiagnosticSource {
                    kind: "invalidContent",
                    path: None,
                }),
                ..make(&code, message)
            },
            Self::Editor(code) => make(code, message),
            Self::UnsupportedSource => make("UNSUPPORTED_SOURCE", message),
            Self::SymbolicLink(_) => make("PROJECT_PATH", message),
            Self::ArchiveLimit => make("ARCHIVE_LIMIT", message),
            Self::InvalidArchive(_) | Self::UnexpectedHistory => make("ARCHIVE_LAYOUT", message),
            Self::DigestMismatch => make("ARCHIVE_INTEGRITY", message),
            Self::DestinationExists => make("DESTINATION_EXISTS", message),
            Self::DestinationParentMissing(path) => Diagnostic {
                file: Some(path.to_string_lossy().into_owned()),
                ..make("DESTINATION_PARENT_MISSING", message)
            },
            Self::InvalidDestination => make("INVALID_DESTINATION", message),
            Self::PublishedNotSynced { .. } => make("PUBLISHED_NOT_SYNCED", message),
            Self::Json(_) => make("INVALID_JSON", message),
            Self::Io(_) | Self::Storage(_) => make("PROJECT_STORAGE", message),
        }
    }
}
