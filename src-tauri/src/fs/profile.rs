use std::{
    fs::{File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::Path,
};

// Covers the longest managed temporary basename, ".backup-" plus a UUID.
// Existing artifacts can be restored at the native limit because replay
// writes their exact names under a durable journal.
const TEMP_NAME_MARGIN: usize = ".backup-00000000-0000-0000-0000-000000000000".len();

pub(crate) fn fits_export_destination(path: &Path) -> bool {
    fits_file(path, TEMP_NAME_MARGIN)
}

pub(crate) fn fits_existing_file(path: &Path) -> bool {
    fits_file(path, 0)
}

fn fits_file(path: &Path, margin: usize) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let units = |path: &Path| path.as_os_str().as_bytes().len();
        fits_path(
            units(path),
            path.parent().map_or(0, units),
            margin,
            libc::PATH_MAX as usize,
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let units = |path: &Path| path.as_os_str().encode_wide().count();
        fits_win32(units(path), path.parent().map_or(0, units), margin)
    }
}

#[cfg(any(windows, test))]
pub(crate) fn fits_win32(file: usize, parent: usize, margin: usize) -> bool {
    // std::fs uses extended-length wide paths on Windows. The system limit
    // includes the terminating NUL and any verbatim prefix.
    fits_path(file, parent, margin, 32_767 - 8)
}

fn fits_path(file: usize, parent: usize, margin: usize, limit: usize) -> bool {
    file.max(parent + 1 + margin) < limit
}

pub(crate) fn create_private_root(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    set_private_mode(path, true)?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn set_private_mode(path: &Path, directory: bool) -> io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(if directory {
            flags | libc::O_DIRECTORY
        } else {
            flags
        })
        .open(path)?;
    let metadata = file.metadata()?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unexpected profile file type",
        ));
    }
    let mode = if directory { 0o700 } else { 0o600 };
    if metadata.permissions().mode() & 0o7777 != mode {
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

pub(crate) fn create_private_file(path: &Path, executable: bool) -> io::Result<ProfileFile<File>> {
    check("create", path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if executable { 0o700 } else { 0o600 });
    }
    #[cfg(not(unix))]
    let _ = executable;
    options.open(path).map(|file| ProfileFile::new(file, path))
}

pub(crate) struct ProfileFile<T> {
    inner: T,
    #[cfg(test)]
    path: std::path::PathBuf,
}

impl<T> ProfileFile<T> {
    pub(crate) fn new(inner: T, path: &Path) -> Self {
        let _ = path;
        Self {
            inner,
            #[cfg(test)]
            path: path.to_owned(),
        }
    }
}

impl ProfileFile<File> {
    pub(crate) fn sync_all(&self) -> io::Result<()> {
        #[cfg(test)]
        check("sync-file", &self.path)?;
        self.inner.sync_all()
    }
}

impl<T: Write> Write for ProfileFile<T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        #[cfg(test)]
        if let Some(fault) = fault::at("write", &self.path) {
            // A failed write can leave a partially updated file behind.
            if buffer.len() > 1 {
                self.inner.write_all(&buffer[..buffer.len() / 2])?;
            }
            return fault.fail();
        }
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<T: Seek> Seek for ProfileFile<T> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.inner.seek(position)
    }
}

pub(crate) fn mkdir(builder: &std::fs::DirBuilder, path: &Path) -> io::Result<()> {
    check("mkdir", path)?;
    builder.create(path)
}

pub(crate) fn lock_exclusive(file: &File, path: &Path) -> io::Result<()> {
    check("lock", path)?;
    fs2::FileExt::lock_exclusive(file)
}

pub(crate) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    check("rename", to)?;
    std::fs::rename(from, to)
}

pub(crate) fn rename_without_replacement(from: &Path, to: &Path) -> io::Result<()> {
    check("rename", to)?;
    #[cfg(windows)]
    {
        fn extended(path: &Path) -> io::Result<std::path::PathBuf> {
            let path = std::path::absolute(path)?;
            let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
            let basename = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
            Ok(parent.canonicalize()?.join(basename))
        }
        return crate::fs::operations::rename_without_replacement(&extended(from)?, &extended(to)?);
    }
    #[cfg(not(windows))]
    crate::fs::operations::rename_without_replacement(from, to)
}

pub(crate) fn persist(temp: tempfile::NamedTempFile, to: &Path, replace: bool) -> io::Result<()> {
    check("rename", to)?;
    if replace {
        temp.persist(to)
    } else {
        temp.persist_noclobber(to)
    }
    .map(|_| ())
    .map_err(|error| error.error)
}

pub(crate) fn available_space(path: &Path) -> io::Result<u64> {
    check("space", path)?;
    fs2::available_space(path)
}

pub(crate) fn sync_file(file: &File, target: &Path) -> io::Result<()> {
    check("sync-file", target)?;
    file.sync_all()
}

pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    check("sync-dir", path)?;
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(crate) fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    check("unlink", path)?;
    std::fs::remove_file(path)
}

pub(crate) fn remove_dir(path: &Path) -> io::Result<()> {
    check("rmdir", path)?;
    std::fs::remove_dir(path)
}

pub(crate) fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    check("remove-tree", path)?;
    std::fs::remove_dir_all(path)
}

pub(crate) fn check(operation: &str, path: &Path) -> io::Result<()> {
    #[cfg(test)]
    if let Some(fault) = fault::at(operation, path) {
        return fault.fail();
    }
    let _ = (operation, path);
    Ok(())
}

#[cfg(test)]
mod fault {
    use std::{
        io,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            LazyLock,
        },
    };

    struct FaultSettings {
        operation: String,
        target: String,
        action: String,
        occurrence: usize,
        persistent: bool,
        hits: AtomicUsize,
    }

    static SETTINGS: LazyLock<Option<FaultSettings>> = LazyLock::new(|| {
        let selector = std::env::var("MACRO_TEST_PROFILE_FAULT").ok()?;
        let (operation, target) = selector.split_once(':').expect("operator:target");
        let action = std::env::var("MACRO_TEST_PROFILE_FAULT_ACTION").unwrap();
        let (persistent, action) = match action.strip_prefix("persistent-") {
            Some(rest) => (true, rest.to_owned()),
            None => (false, action),
        };
        Some(FaultSettings {
            operation: operation.into(),
            target: target.into(),
            action,
            occurrence: std::env::var("MACRO_TEST_PROFILE_FAULT_NTH")
                .ok()
                .map_or(1, |value| value.parse().unwrap()),
            persistent,
            hits: AtomicUsize::new(0),
        })
    });

    pub(super) struct Fault<'a> {
        operation: &'a str,
        path: &'a Path,
        action: &'a str,
    }

    pub(super) fn at<'a>(operation: &'a str, path: &'a Path) -> Option<Fault<'a>> {
        let settings = SETTINGS.as_ref()?;
        if operation != settings.operation || !matches_target(path, &settings.target) {
            return None;
        }
        let hit = settings.hits.fetch_add(1, Ordering::Relaxed) + 1;
        (hit == settings.occurrence || settings.persistent && hit >= settings.occurrence).then_some(
            Fault {
                operation,
                path,
                action: &settings.action,
            },
        )
    }

    fn matches_target(path: &Path, target: &str) -> bool {
        if let Some(relative) = target.strip_prefix("data/") {
            return std::env::var_os("MACRO_TEST_PROFILE_DATA")
                .is_some_and(|root| path == Path::new(&root).join(relative));
        }
        if let Some(relative) = target.strip_prefix("config/") {
            return std::env::var_os("MACRO_TEST_PROFILE_CONFIG")
                .is_some_and(|root| path == Path::new(&root).join(relative));
        }
        if let Some(member) = target.strip_prefix("library/") {
            return std::env::var_os("MACRO_TEST_PROFILE_DATA")
                .and_then(|root| {
                    path.strip_prefix(Path::new(&root).join("architect-library/blueprints"))
                        .ok()
                })
                .is_some_and(|path| path.to_string_lossy().replace('\\', "/").contains(member));
        }
        path.to_string_lossy().replace('\\', "/").contains(target)
    }

    impl Fault<'_> {
        pub(super) fn fail<T>(self) -> io::Result<T> {
            eprintln!(
                "profile-fault: {} {} {}",
                self.operation,
                self.action,
                self.path.display()
            );
            if self.action == "crash" {
                #[cfg(unix)]
                unsafe {
                    libc::raise(libc::SIGKILL);
                }
                std::process::exit(79);
            }
            let code = match self.action {
                #[cfg(unix)]
                "EACCES" => libc::EACCES,
                #[cfg(unix)]
                "ENOSPC" => libc::ENOSPC,
                #[cfg(unix)]
                "EIO" => libc::EIO,
                #[cfg(unix)]
                "ENAMETOOLONG" => libc::ENAMETOOLONG,
                #[cfg(unix)]
                "EEXIST" => libc::EEXIST,
                #[cfg(windows)]
                "EACCES" => 5,
                #[cfg(windows)]
                "ENOSPC" => 112,
                #[cfg(windows)]
                "EIO" => 1117,
                #[cfg(windows)]
                "ENAMETOOLONG" => 206,
                #[cfg(windows)]
                "EEXIST" => 183,
                action => panic!("Unknown test filesystem fault: {action}"),
            };
            Err(io::Error::from_raw_os_error(code))
        }
    }
}

#[cfg(test)]
pub(crate) fn mutated(name: &str) -> bool {
    std::env::var("MACRO_TEST_PROFILE_MUTATION").as_deref() == Ok(name)
}
