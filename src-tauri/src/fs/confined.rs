//! Handle-confined access for the generic file commands.
//!
//! Every operation opens its allowed root directory once and resolves the
//! request beneath that handle. The resolution never leaves the root and never
//! follows a link out of it: cap-std uses `openat2(RESOLVE_BENEATH)` on Linux,
//! an `openat(O_NOFOLLOW)` component walk on macOS and older Linux kernels,
//! and handle-relative `NtCreateFile` opens with reparse-point checks on
//! Windows. Relative symbolic links that stay inside the root still resolve.
//!
//! Each opened handle is then admitted before use: its physical path must stay
//! below the root, must not be private profile data, and a hard-linked regular
//! file must not share its identity with a private file. Reads, writes, and
//! removals go through the admitted handle, or through the admitted parent
//! directory with a single entry name, never by reopening a path by name.
use super::private_profile::{self, LinkedPrivateFiles};
use super::{nearest_existing_ancestor, normalize_path, path_is_same_or_descendant};
use crate::core::error::{io_error_to_backend_error, BackendError, Result};
use argentic_runtime::content_io::admitted::WorkspaceRootIdentity;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Physical identity of a filesystem object: device and inode on Unix,
/// volume serial number and file index on Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ObjectIdentity {
    pub(crate) volume: u64,
    pub(crate) index: u64,
}

/// Facts read from an open handle, or from an entry without following it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HandleFacts {
    pub(crate) identity: ObjectIdentity,
    pub(crate) links: u64,
    pub(crate) is_dir: bool,
    pub(crate) is_file: bool,
    pub(crate) is_link: bool,
}

struct RootInner {
    dir: Dir,
    lexical: PathBuf,
    /// Where the root was when it was opened; only used to derive spellings.
    real: PathBuf,
    identity: WorkspaceRootIdentity,
    links: Mutex<LinkedPrivateFiles>,
}

/// An allowed root directory, opened once for one operation.
#[derive(Clone)]
pub(crate) struct ConfinedRoot(Arc<RootInner>);

/// An admitted directory below a [`ConfinedRoot`].
pub(crate) struct ConfinedDir {
    dir: Dir,
    real: PathBuf,
    root: ConfinedRoot,
}

/// An admitted object (file or directory) opened below a [`ConfinedRoot`].
pub(crate) struct Opened {
    pub(crate) file: std::fs::File,
    pub(crate) facts: HandleFacts,
    pub(crate) real: PathBuf,
}

/// Where a request lands once its parent directory has been admitted.
pub(crate) enum Located {
    /// The root itself, or a spelling ending in `..` that must be opened whole.
    Object,
    /// A named entry of an admitted parent directory.
    Entry(ConfinedDir, OsString),
    /// A parent component does not exist.
    Missing,
}

fn outside(display: &Path) -> BackendError {
    BackendError::FilesystemPathOutsideWorkspace {
        message: format!("Path {:?} is outside the allowed root", display),
    }
}

fn not_a_file_target(display: &Path) -> BackendError {
    BackendError::FilesystemInvalidPath {
        message: format!(
            "Path '{}' is not a file target inside the allowed root",
            display.display()
        ),
    }
}

/// cap-std reports a resolution that would leave the root as this error;
/// `openat2(RESOLVE_BENEATH)` reports it as `EXDEV`.
fn is_escape(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::CrossesDevices
        || (error.kind() == std::io::ErrorKind::PermissionDenied
            && error.to_string().contains("outside of the filesystem"))
}

pub(crate) fn map_io(error: std::io::Error, display: &Path) -> BackendError {
    if is_escape(&error) {
        outside(display)
    } else {
        io_error_to_backend_error(error, display)
    }
}

fn read_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // Never block on a FIFO planted in the workspace.
        options.custom_flags(libc::O_NONBLOCK);
    }
    options
}

fn is_root(relative: &Path) -> bool {
    relative
        .components()
        .all(|component| matches!(component, Component::CurDir))
}

/// Remove `root` from the front of `path` by components.
fn strip_root(path: &Path, root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        fn segments(value: &Path) -> Vec<String> {
            let normalized = value.to_string_lossy().replace('/', "\\");
            let normalized = normalized
                .strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .unwrap_or(normalized);
            normalized
                .strip_prefix(r"\\?\")
                .unwrap_or(&normalized)
                .split('\\')
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect()
        }
        let path = segments(path);
        let root = segments(root);
        if root.len() > path.len()
            || !root
                .iter()
                .zip(&path)
                .all(|(root, path)| root.eq_ignore_ascii_case(path))
        {
            return None;
        }
        return Some(path[root.len()..].iter().collect());
    }
    #[cfg(not(windows))]
    {
        path.strip_prefix(root).ok().map(Path::to_path_buf)
    }
}

impl ConfinedRoot {
    /// Open an allowed root. When `expected` is set, the opened directory must
    /// be the same physical directory that was validated earlier.
    pub(crate) fn open(workspace: &Path, expected: Option<WorkspaceRootIdentity>) -> Result<Self> {
        let lexical = if workspace.is_absolute() {
            normalize_path(workspace)
        } else {
            normalize_path(&std::env::current_dir()?.join(workspace))
        };
        private_profile::check(&lexical)?;
        let dir = Dir::open_ambient_dir(&lexical, ambient_authority())
            .map_err(|error| io_error_to_backend_error(error, &lexical))?;
        let identity = root_identity(&dir, &lexical)?;
        if expected.is_some_and(|expected| expected != identity) {
            return Err(BackendError::FilesystemInvalidPath {
                message: format!(
                    "Workspace root '{}' changed after server validation",
                    workspace.display()
                ),
            });
        }
        let real = os::real_path(&dir).map_err(|error| map_io(error, &lexical))?;
        let facts = os::facts(&dir).map_err(|error| map_io(error, &lexical))?;
        let mut links = LinkedPrivateFiles::default();
        links.admit(&real, &facts)?;
        Ok(Self(Arc::new(RootInner {
            dir,
            lexical,
            real,
            identity,
            links: Mutex::new(links),
        })))
    }

    pub(crate) fn identity(&self) -> WorkspaceRootIdentity {
        self.0.identity
    }

    /// The caller-visible location of `relative`, for messages and DTOs.
    pub(crate) fn display(&self, relative: &Path) -> PathBuf {
        if is_root(relative) {
            self.0.lexical.clone()
        } else {
            self.0.lexical.join(relative)
        }
    }

    /// Express a request relative to the root without normalizing it, so that
    /// `link/../name` is resolved physically by the handle walk exactly as the
    /// operating system would, instead of lexically as `name`.
    pub(crate) fn relative(&self, requested: &Path) -> Result<PathBuf> {
        let relative = if requested.is_absolute() {
            strip_root(requested, &self.0.lexical)
                .or_else(|| strip_root(requested, &self.0.real))
                .or_else(|| self.relative_through_ancestor(requested))
                .ok_or_else(|| outside(requested))?
        } else {
            requested.to_path_buf()
        };
        // Refuse spellings that climb above the root; physical escapes through
        // links are refused by the handle walk itself.
        let mut depth = 0usize;
        let mut kept = PathBuf::new();
        for component in relative.components() {
            match component {
                Component::Normal(name) => {
                    depth += 1;
                    kept.push(name);
                }
                Component::ParentDir => {
                    depth = depth.checked_sub(1).ok_or_else(|| outside(requested))?;
                    kept.push("..");
                }
                Component::CurDir => {}
                Component::RootDir | Component::Prefix(_) => return Err(outside(requested)),
            }
        }
        Ok(kept)
    }

    /// An absolute spelling through another alias of the root, such as a
    /// symbolic link to the workspace. The name-based resolution only derives
    /// the relative spelling; access still happens through the root handle.
    fn relative_through_ancestor(&self, requested: &Path) -> Option<PathBuf> {
        let (ancestor, canonical) = nearest_existing_ancestor(requested).ok()?;
        let missing = requested.strip_prefix(&ancestor).ok()?;
        Some(strip_root(&canonical, &self.0.real)?.join(missing))
    }

    /// Where the root handle is now. A root moved after it was opened keeps
    /// its handle, so containment is judged against its current location.
    fn current_real(&self) -> Result<PathBuf> {
        os::real_path(&self.0.dir).map_err(|error| map_io(error, &self.0.lexical))
    }

    fn admit(&self, file: std::fs::File, display: &Path, tree: bool) -> Result<Opened> {
        let facts = os::facts(&file).map_err(|error| map_io(error, display))?;
        let real = os::real_path(&file).map_err(|error| map_io(error, display))?;
        if !path_is_same_or_descendant(&real, &self.current_real()?) {
            return Err(outside(display));
        }
        let mut links = self
            .0
            .links
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tree {
            links.admit_tree(&real, &facts)?;
        } else {
            links.admit(&real, &facts)?;
        }
        Ok(Opened { file, facts, real })
    }

    /// Admit an entry described without opening it (listing and stat).
    pub(crate) fn admit_entry(&self, real: &Path, facts: &HandleFacts) -> Result<()> {
        self.0
            .links
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .admit(real, facts)
    }

    fn root_dir(&self) -> Result<ConfinedDir> {
        let dir = self
            .0
            .dir
            .try_clone()
            .map_err(|error| map_io(error, &self.0.lexical))?;
        Ok(ConfinedDir {
            dir,
            real: self.current_real()?,
            root: self.clone(),
        })
    }

    /// Open the object named by `relative`, following links that stay inside
    /// the root, and admit the resulting handle.
    pub(crate) fn open_object(&self, relative: &Path) -> Result<Opened> {
        let display = self.display(relative);
        hooks::run(hooks::Point::BeforeOpen, &display);
        let file = match self.open_beneath(relative) {
            Err(error) if is_escape(&error) => {
                // The handle walk refuses every absolute link, even one that
                // points back inside the root. Derive the physical spelling by
                // name and open that beneath the root again: a link that really
                // leaves the root has no such spelling and is refused.
                let physical = self
                    .physical_relative(relative)
                    .ok_or_else(|| outside(&display))?;
                self.open_beneath(&physical)
                    .map_err(|error| map_io(error, &display))?
            }
            result => result.map_err(|error| map_io(error, &display))?,
        };
        self.admit(file, &display, false)
    }

    fn open_beneath(&self, relative: &Path) -> std::io::Result<std::fs::File> {
        if is_root(relative) {
            return Ok(self.0.dir.try_clone()?.into_std_file());
        }
        let mut options = read_options();
        options.maybe_dir(true);
        Ok(self.0.dir.open_with(relative, &options)?.into_std())
    }

    fn physical_relative(&self, relative: &Path) -> Option<PathBuf> {
        let real = self.current_real().ok()?;
        let canonical = real.join(relative).canonicalize().ok()?;
        strip_root(&canonical, &real)
    }

    /// Open a directory named by `relative` and admit it.
    pub(crate) fn open_dir(&self, relative: &Path) -> Result<ConfinedDir> {
        let display = self.display(relative);
        let opened = self.open_object(relative)?;
        if !opened.facts.is_dir {
            return Err(BackendError::FilesystemIsFile {
                message: format!("Path '{}' is a file, not a directory", display.display()),
            });
        }
        Ok(ConfinedDir {
            dir: Dir::from_std_file(opened.file),
            real: opened.real,
            root: self.clone(),
        })
    }

    /// Admit the parent directory of `relative` and return it with the final
    /// entry name. With `create`, missing parents are created one at a time,
    /// each inside a directory handle that was admitted first.
    pub(crate) fn locate(&self, relative: &Path, create: bool) -> Result<Located> {
        let mut components: Vec<Component> = relative.components().collect();
        let name = match components.pop() {
            Some(Component::Normal(name)) => name.to_os_string(),
            _ => return Ok(Located::Object),
        };
        let mut parent = self.root_dir()?;
        let mut prefix = PathBuf::new();
        for component in components {
            prefix.push(component);
            parent = match self.open_dir(&prefix) {
                Ok(dir) => dir,
                Err(BackendError::FilesystemNotFound { .. }) if !create => {
                    return Ok(Located::Missing)
                }
                Err(BackendError::FilesystemNotFound { .. }) => {
                    let Component::Normal(child) = component else {
                        return Err(not_a_file_target(&self.display(relative)));
                    };
                    parent.create_child_dir(child)?
                }
                Err(error) => return Err(error),
            };
        }
        hooks::run(hooks::Point::AfterParent, &self.display(relative));
        Ok(Located::Entry(parent, name))
    }

    /// Like [`Self::locate`], for operations that need a named file target.
    pub(crate) fn locate_entry(
        &self,
        relative: &Path,
        create: bool,
    ) -> Result<Option<(ConfinedDir, OsString)>> {
        match self.locate(relative, create)? {
            Located::Entry(parent, name) => Ok(Some((parent, name))),
            Located::Missing => Ok(None),
            Located::Object => Err(not_a_file_target(&self.display(relative))),
        }
    }
}

impl ConfinedDir {
    pub(crate) fn real(&self) -> &Path {
        &self.real
    }

    pub(crate) fn dir(&self) -> &Dir {
        &self.dir
    }

    fn display(&self, name: &OsStr) -> PathBuf {
        self.real.join(name)
    }

    /// Wrap an admitted directory handle.
    pub(crate) fn from_opened(root: &ConfinedRoot, opened: Opened) -> Self {
        Self {
            dir: Dir::from_std_file(opened.file),
            real: opened.real,
            root: root.clone(),
        }
    }

    /// Open a child directory without following a final link, and admit it.
    pub(crate) fn open_child_dir(&self, name: &OsStr) -> Result<ConfinedDir> {
        let opened = self.open_entry(name, &nofollow_read_options(true), false)?;
        if !opened.facts.is_dir {
            return Err(BackendError::FilesystemIsFile {
                message: format!(
                    "Path '{}' is a file, not a directory",
                    self.display(name).display()
                ),
            });
        }
        Ok(Self::from_opened(&self.root, opened))
    }

    fn create_child_dir(&self, name: &OsStr) -> Result<ConfinedDir> {
        match self.dir.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(map_io(error, &self.display(name))),
        }
        self.open_child_dir(name)
    }

    /// Describe an entry without following it.
    pub(crate) fn entry_facts(&self, name: &OsStr) -> std::io::Result<HandleFacts> {
        os::entry_facts(&self.dir, name)
    }

    /// Open one entry of this directory without following a final link, and
    /// admit the handle. `tree` also refuses a directory containing private data.
    pub(crate) fn open_entry(
        &self,
        name: &OsStr,
        options: &OpenOptions,
        tree: bool,
    ) -> Result<Opened> {
        let display = self.display(name);
        let file = self
            .dir
            .open_with(name, options)
            .map_err(|error| map_io(error, &display))?
            .into_std();
        let opened = self.root.admit(file, &display, tree)?;
        if opened.facts.is_link {
            return Err(BackendError::FilesystemInvalidPath {
                message: format!("'{}' is a symbolic link", display.display()),
            });
        }
        Ok(opened)
    }

    /// Admit a named entry that is only described, not opened.
    pub(crate) fn admit_entry(&self, name: &OsStr, facts: &HandleFacts) -> Result<()> {
        self.root.admit_entry(&self.display(name), facts)
    }
}

/// Read options that never follow a final symbolic link.
pub(crate) fn nofollow_read_options(maybe_dir: bool) -> OpenOptions {
    let mut options = read_options();
    options.follow(FollowSymlinks::No);
    if maybe_dir {
        options.maybe_dir(true);
    }
    options
}

/// Read and write options that never follow a final symbolic link.
pub(crate) fn nofollow_read_write_options() -> OpenOptions {
    let mut options = nofollow_read_options(false);
    options.write(true);
    options
}

/// Options that create a new file and never follow or replace an entry.
pub(crate) fn create_new_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    options.follow(FollowSymlinks::No);
    options
}

#[cfg(unix)]
fn root_identity(dir: &Dir, path: &Path) -> Result<WorkspaceRootIdentity> {
    let metadata = dir
        .dir_metadata()
        .map_err(|error| io_error_to_backend_error(error, path))?;
    Ok(argentic_runtime::content_io::admitted::workspace_root_identity_from_cap(&metadata))
}

#[cfg(windows)]
fn root_identity(dir: &Dir, path: &Path) -> Result<WorkspaceRootIdentity> {
    argentic_runtime::content_io::admitted::workspace_root_identity_from_cap(dir, path)
        .map_err(Into::into)
}

/// Platform handle inspection.
pub(crate) mod os {
    use super::{HandleFacts, ObjectIdentity};
    use cap_std::fs::Dir;
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    fn facts_from_stat(stat: &libc::stat) -> HandleFacts {
        let format = stat.st_mode & libc::S_IFMT;
        HandleFacts {
            identity: ObjectIdentity {
                volume: stat.st_dev as u64,
                index: stat.st_ino as u64,
            },
            links: stat.st_nlink as u64,
            is_dir: format == libc::S_IFDIR,
            is_file: format == libc::S_IFREG,
            is_link: format == libc::S_IFLNK,
        }
    }

    /// Facts of an open handle.
    #[cfg(unix)]
    pub(crate) fn facts(handle: &impl std::os::fd::AsFd) -> std::io::Result<HandleFacts> {
        use std::os::fd::AsRawFd;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the descriptor is borrowed for the call and `stat` is writable.
        if unsafe { libc::fstat(handle.as_fd().as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fstat succeeded and initialized the structure.
        Ok(facts_from_stat(unsafe { &stat.assume_init() }))
    }

    /// Facts of a directory entry, without following a final link.
    #[cfg(unix)]
    pub(crate) fn entry_facts(dir: &Dir, name: &OsStr) -> std::io::Result<HandleFacts> {
        use std::os::fd::{AsFd, AsRawFd};
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the directory descriptor is borrowed and `name` is one entry
        // name, resolved relative to it without following a final link.
        let result = unsafe {
            libc::fstatat(
                dir.as_fd().as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fstatat succeeded and initialized the structure.
        Ok(facts_from_stat(unsafe { &stat.assume_init() }))
    }

    /// Facts of a path, without following a final link (private scans only).
    #[cfg(unix)]
    pub(crate) fn path_facts(path: &Path) -> std::io::Result<HandleFacts> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path)?;
        let file_type = metadata.file_type();
        Ok(HandleFacts {
            identity: ObjectIdentity {
                volume: metadata.dev(),
                index: metadata.ino(),
            },
            links: metadata.nlink(),
            is_dir: file_type.is_dir(),
            is_file: file_type.is_file(),
            is_link: file_type.is_symlink(),
        })
    }

    /// The physical path of an open handle.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(crate) fn real_path(handle: &impl std::os::fd::AsFd) -> std::io::Result<PathBuf> {
        use std::os::fd::AsRawFd;
        std::fs::read_link(format!("/proc/self/fd/{}", handle.as_fd().as_raw_fd()))
    }

    /// The physical path of an open handle.
    #[cfg(target_vendor = "apple")]
    pub(crate) fn real_path(handle: &impl std::os::fd::AsFd) -> std::io::Result<PathBuf> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
        // SAFETY: F_GETPATH writes at most PATH_MAX bytes into the buffer.
        let result = unsafe {
            libc::fcntl(
                handle.as_fd().as_raw_fd(),
                libc::F_GETPATH,
                buffer.as_mut_ptr(),
            )
        };
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
        let length = buffer.iter().position(|byte| *byte == 0).unwrap_or(0);
        Ok(PathBuf::from(OsStr::from_bytes(&buffer[..length])))
    }

    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
    ))]
    pub(crate) fn real_path(_handle: &impl std::os::fd::AsFd) -> std::io::Result<PathBuf> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Handle paths are unavailable on this platform.",
        ))
    }

    #[cfg(windows)]
    fn facts_from_raw(handle: std::os::windows::io::RawHandle) -> std::io::Result<HandleFacts> {
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT,
        };
        // SAFETY: the structure is plain data and fully written on success.
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle is borrowed for the duration of the call.
        if unsafe { GetFileInformationByHandle(handle as _, &mut information) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let attributes = information.dwFileAttributes;
        let is_link = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_dir = !is_link && attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        Ok(HandleFacts {
            identity: ObjectIdentity {
                volume: information.dwVolumeSerialNumber as u64,
                index: ((information.nFileIndexHigh as u64) << 32)
                    | information.nFileIndexLow as u64,
            },
            links: information.nNumberOfLinks as u64,
            is_dir,
            is_file: !is_link && !is_dir,
            is_link,
        })
    }

    /// Facts of an open handle.
    #[cfg(windows)]
    pub(crate) fn facts(
        handle: &impl std::os::windows::io::AsHandle,
    ) -> std::io::Result<HandleFacts> {
        use std::os::windows::io::AsRawHandle;
        facts_from_raw(handle.as_handle().as_raw_handle())
    }

    /// Facts of a directory entry, without following a final reparse point.
    #[cfg(windows)]
    pub(crate) fn entry_facts(dir: &Dir, name: &OsStr) -> std::io::Result<HandleFacts> {
        use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
        use cap_std::fs::{OpenOptions, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let mut options = OpenOptions::new();
        options
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        options.follow(FollowSymlinks::No);
        options.maybe_dir(true);
        let file = dir.open_with(name, &options)?.into_std();
        facts(&file)
    }

    /// Facts of a path, without following a final reparse point (private scans only).
    #[cfg(windows)]
    pub(crate) fn path_facts(path: &Path) -> std::io::Result<HandleFacts> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let file = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        facts(&file)
    }

    /// The physical path of an open handle.
    #[cfg(windows)]
    pub(crate) fn real_path(
        handle: &impl std::os::windows::io::AsHandle,
    ) -> std::io::Result<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
        };
        let raw = handle.as_handle().as_raw_handle();
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: the handle is borrowed and the buffer length is passed.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    raw as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if length < buffer.len() {
                let path = std::ffi::OsString::from_wide(&buffer[..length]);
                let path = path.to_string_lossy();
                let path = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
                    format!(r"\\{rest}")
                } else {
                    path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
                };
                return Ok(PathBuf::from(path));
            }
            buffer.resize(length + 1, 0);
        }
    }
}

/// Deterministic test hooks between admission and use.
pub(crate) mod hooks {
    use std::path::Path;

    #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
    pub(crate) enum Point {
        /// Before a request is opened beneath the root.
        BeforeOpen,
        /// After the parent directory was admitted, before the entry is used.
        AfterParent,
        /// After a directory tree was admitted, before it is removed.
        BeforeRemove,
    }

    #[cfg(test)]
    type Hook = Box<dyn FnOnce() + Send>;

    #[cfg(test)]
    static HOOKS: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<(Point, std::path::PathBuf), Hook>>,
    > = std::sync::LazyLock::new(Default::default);

    /// Run `hook` once when an operation on `path` reaches `point`.
    #[cfg(test)]
    pub(crate) fn install(point: Point, path: &Path, hook: impl FnOnce() + Send + 'static) {
        HOOKS
            .lock()
            .expect("confined hooks")
            .insert((point, path.to_path_buf()), Box::new(hook));
    }

    #[cfg(test)]
    pub(crate) fn run(point: Point, path: &Path) {
        let hook = HOOKS
            .lock()
            .expect("confined hooks")
            .remove(&(point, path.to_path_buf()));
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(crate) fn run(_point: Point, _path: &Path) {}
}
