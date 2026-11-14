//! Descriptor-bound reads and physical root identities shared with the host.
use cap_std::{ambient_authority, fs::Dir as CapabilityDir};
#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};
#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
use tokio::sync::Barrier;
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("IO error: {message}")]
    Io {
        message: String,
        #[source]
        source: std::io::Error,
    },
    #[error("File system error: {message}")]
    Filesystem { message: String },
    #[error("File system Not Found: {message}")]
    FilesystemNotFound { message: String },
    #[error("File system Permission denied: {message}")]
    FilesystemPermissionDenied { message: String },
    #[error("File system Already exists: {message}")]
    FilesystemAlreadyExists { message: String },
    #[error("File system Invalid path: {message}")]
    FilesystemInvalidPath { message: String },
    #[error("File system Disk full: {message}")]
    FilesystemDiskFull { message: String },
    #[error("File system Is a directory: {message}")]
    FilesystemIsDirectory { message: String },
    #[error("Resource pressure: {message}")]
    ResourcePressure { message: String },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkspaceRootIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: Option<u32>,
    #[cfg(windows)]
    file_index: Option<u64>,
}

impl WorkspaceRootIdentity {
    /// Lossless, opaque identity for comparing observations across IPC calls.
    /// Strings preserve native 64-bit identifiers without JavaScript rounding.
    pub fn observation_key(self) -> Option<String> {
        #[cfg(unix)]
        return Some(format!("unix:{:x}:{:x}", self.device, self.inode));
        #[cfg(windows)]
        return Some(format!("windows:{:x}:{:x}", self.volume?, self.file_index?));
    }
}

#[cfg(unix)]
pub fn workspace_root_identity_from_std(metadata: &std::fs::Metadata) -> WorkspaceRootIdentity {
    use std::os::unix::fs::MetadataExt;
    WorkspaceRootIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
pub fn workspace_root_identity_from_handle(
    handle: std::os::windows::io::RawHandle,
    workspace: &Path,
) -> Result<WorkspaceRootIdentity, ReadError> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(handle as _, &mut information) };
    if result == 0 {
        return Err(io_error_to_backend_error(
            std::io::Error::last_os_error(),
            workspace,
        ));
    }

    Ok(WorkspaceRootIdentity {
        volume: Some(information.dwVolumeSerialNumber),
        file_index: Some(
            ((information.nFileIndexHigh as u64) << u32::BITS) | information.nFileIndexLow as u64,
        ),
    })
}

#[cfg(windows)]
pub fn workspace_root_identity_from_std(
    workspace: &Path,
) -> Result<WorkspaceRootIdentity, ReadError> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(workspace)
        .map_err(|error| io_error_to_backend_error(error, workspace))?;
    workspace_root_identity_from_handle(file.as_raw_handle(), workspace)
}

#[cfg(unix)]
pub fn workspace_root_identity_from_cap(metadata: &cap_std::fs::Metadata) -> WorkspaceRootIdentity {
    use cap_std::fs::MetadataExt;
    WorkspaceRootIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
pub fn workspace_root_identity_from_cap(
    directory: &CapabilityDir,
    workspace: &Path,
) -> Result<WorkspaceRootIdentity, ReadError> {
    use std::os::windows::io::AsRawHandle;
    workspace_root_identity_from_handle(directory.as_raw_handle(), workspace)
}

pub fn workspace_root_identity(workspace: &Path) -> Result<WorkspaceRootIdentity, ReadError> {
    #[cfg(windows)]
    return workspace_root_identity_from_std(workspace);

    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(workspace)
            .map_err(|error| io_error_to_backend_error(error, workspace))?;
        Ok(workspace_root_identity_from_std(&metadata))
    }
}

pub fn open_workspace_capability(
    workspace: &Path,
    validated_path: &Path,
    expected_identity: Option<WorkspaceRootIdentity>,
) -> Result<(Arc<CapabilityDir>, PathBuf), ReadError> {
    let lexical_workspace = normalize_path(workspace);
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| io_error_to_backend_error(error, workspace))?;
    let relative_path = validated_path
        .strip_prefix(&lexical_workspace)
        .or_else(|_| validated_path.strip_prefix(&canonical_workspace))
        .map(Path::to_path_buf)
        .map_err(|_| ReadError::FilesystemInvalidPath {
            message: format!(
                "Path '{}' cannot be addressed relative to workspace '{}'",
                validated_path.display(),
                workspace.display()
            ),
        })?;
    if relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ReadError::FilesystemInvalidPath {
            message: format!(
                "Path '{}' is not a writable file target inside the workspace",
                validated_path.display()
            ),
        });
    }
    let directory = CapabilityDir::open_ambient_dir(&canonical_workspace, ambient_authority())
        .map_err(|error| io_error_to_backend_error(error, &canonical_workspace))?;
    if let Some(expected_identity) = expected_identity {
        #[cfg(unix)]
        let actual_identity = workspace_root_identity_from_cap(
            &directory
                .dir_metadata()
                .map_err(|error| io_error_to_backend_error(error, &canonical_workspace))?,
        );
        #[cfg(windows)]
        let actual_identity = workspace_root_identity_from_cap(&directory, &canonical_workspace)?;
        if actual_identity != expected_identity {
            return Err(ReadError::FilesystemInvalidPath {
                message: format!(
                    "Workspace root '{}' changed after server validation",
                    workspace.display()
                ),
            });
        }
    }
    Ok((Arc::new(directory), relative_path))
}

/// Open and read a confined regular file only after native admission. The final
/// component cannot become a symlink between policy evaluation and the read.
/// This does not grant access: callers must evaluate the original and resolved
/// paths in `admit`, including their captured and current policy ceilings.
pub async fn read_file_bytes_with_admission<F, Fut>(
    path: &Path,
    cancel: &tokio_util::sync::CancellationToken,
    owner: Option<crate::content_io::ContentResourceOwner>,
    admit: F,
) -> Result<(Vec<u8>, PathBuf, WorkspaceRootIdentity), ReadError>
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = Result<(), ReadError>>,
{
    if !path.is_absolute() {
        return Err(ReadError::FilesystemInvalidPath {
            message: "An admitted read requires an absolute path.".into(),
        });
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| io_error_to_backend_error(e, path))?;
    let parent = resolved
        .parent()
        .ok_or_else(|| ReadError::FilesystemInvalidPath {
            message: "A regular file target is required.".into(),
        })?;
    let identity = workspace_root_identity(parent)?;
    admit(resolved.clone()).await?;
    if workspace_root_identity(parent)? != identity
        || path.canonicalize().ok().as_ref() != Some(&resolved)
    {
        return Err(ReadError::FilesystemInvalidPath {
            message: "File location changed during admitted read.".into(),
        });
    }
    let metadata = std::fs::symlink_metadata(&resolved)
        .map_err(|e| io_error_to_backend_error(e, &resolved))?;
    if !metadata.is_file() {
        return Err(ReadError::FilesystemIsDirectory {
            message: format!("The path '{}' is not a regular file.", resolved.display()),
        });
    }
    #[cfg(any(
        test,
        feature = "dev-support",
        all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
    ))]
    pause_before_content_open(&resolved).await;
    let (directory, relative) = open_workspace_capability(parent, &resolved, Some(identity))?;
    let bytes = crate::content_io::file_helper::read_confined(&directory, &relative, cancel, owner)
        .await
        .map_err(|e| io_error_to_backend_error(e, &resolved))?;
    if workspace_root_identity(parent)? != identity
        || path.canonicalize().ok().as_ref() != Some(&resolved)
    {
        return Err(ReadError::FilesystemInvalidPath {
            message: "File location changed before admitted read.".into(),
        });
    }
    if cancel.is_cancelled() {
        return Err(ReadError::Filesystem {
            message: "Content read cancelled.".into(),
        });
    }
    Ok((bytes, resolved, identity))
}

#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
static CONTENT_BEFORE_OPEN_HOOKS: LazyLock<Mutex<HashMap<PathBuf, (Arc<Barrier>, Arc<Barrier>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
pub fn install_content_before_open_hook(
    path: PathBuf,
    reached: Arc<Barrier>,
    release: Arc<Barrier>,
) {
    CONTENT_BEFORE_OPEN_HOOKS
        .lock()
        .expect("content hook mutex")
        .insert(path, (reached, release));
}

#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
pub fn content_before_open_hook_pending(path: &Path, remove: bool) -> bool {
    let mut hooks = CONTENT_BEFORE_OPEN_HOOKS
        .lock()
        .expect("content hook mutex");
    if remove {
        hooks.remove(path).is_some()
    } else {
        hooks.contains_key(path)
    }
}

#[cfg(any(
    test,
    feature = "dev-support",
    all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions)
))]
async fn pause_before_content_open(path: &Path) {
    let hook = CONTENT_BEFORE_OPEN_HOOKS
        .lock()
        .expect("content hook mutex")
        .remove(path);
    if let Some((reached, release)) = hook {
        reached.wait().await;
        release.wait().await;
    }
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();

    // Handle empty path
    if path.components().next().is_none() {
        return result;
    }

    for component in path.components() {
        match component {
            std::path::Component::CurDir => {} // Ignore `.` components
            std::path::Component::ParentDir => {
                result.pop();
            } // Remove the last component for `..`
            _ => result.push(component),
        }
    }
    result
}

pub fn is_too_many_open_files_error(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(24)
        || err
            .to_string()
            .to_lowercase()
            .contains("too many open files")
}

pub fn io_error_to_backend_error(err: std::io::Error, path: &std::path::Path) -> ReadError {
    use std::io::ErrorKind;

    if is_too_many_open_files_error(&err) {
        return ReadError::ResourcePressure {
            message: format!(
                "Too many open files while reading workspace path: {}",
                path.display()
            ),
        };
    }

    match err.kind() {
        ErrorKind::NotFound => ReadError::FilesystemNotFound {
            message: format!("Path not found: {}", path.display()),
        },
        ErrorKind::PermissionDenied => ReadError::FilesystemPermissionDenied {
            message: format!("Permission denied: {}", path.display()),
        },
        ErrorKind::AlreadyExists => ReadError::FilesystemAlreadyExists {
            message: format!("File or directory already exists: {}", path.display()),
        },
        ErrorKind::InvalidInput => ReadError::FilesystemInvalidPath {
            message: format!("Invalid path: {}", path.display()),
        },
        ErrorKind::WriteZero | ErrorKind::OutOfMemory => ReadError::FilesystemDiskFull {
            message: format!("No space left on device for path: {}", path.display()),
        },
        ErrorKind::Other => {
            let msg = err.to_string();
            if msg.contains("is a directory") {
                ReadError::FilesystemIsDirectory {
                    message: format!("Expected a file but found a directory: {}", path.display()),
                }
            } else {
                ReadError::Io {
                    message: msg,
                    source: err,
                }
            }
        }
        _ => ReadError::Io {
            message: err.to_string(),
            source: err,
        },
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn replaced_root_cannot_open_a_capability_with_the_previous_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let identity = workspace_root_identity(&root).unwrap();
        std::fs::rename(&root, temp.path().join("retired")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(matches!(
            open_workspace_capability(&root, &root.join("data"), Some(identity)),
            Err(ReadError::FilesystemInvalidPath { .. })
        ));
    }
    #[tokio::test]
    async fn root_swap_during_admission_is_refused_before_reader_launch() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let retired = temp.path().join("retired");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("data"), b"approved").unwrap();
        let result = read_file_bytes_with_admission(
            &root.join("data"),
            &tokio_util::sync::CancellationToken::new(),
            None,
            |_| async {
                std::fs::rename(&root, &retired).unwrap();
                std::fs::create_dir(&root).unwrap();
                std::fs::write(root.join("data"), b"replacement").unwrap();
                Ok(())
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(ReadError::FilesystemInvalidPath { .. })
        ));
    }
}
