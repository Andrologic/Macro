use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

// Covers the longest managed temporary basename, ".backup-" plus a UUID.
// Existing artifacts can be restored at the native limit because replay
// writes their exact names under a durable journal.
const TEMP_NAME_MARGIN: usize = ".backup-00000000-0000-0000-0000-000000000000".len();

pub(crate) fn admits_file(path: &Path) -> bool {
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
    // Include the terminating NUL and the directory creation allowance.
    fits_path(file, parent, margin, 260) && parent <= 248
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

pub(crate) fn create_private_file(path: &Path, executable: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if executable { 0o700 } else { 0o600 });
    }
    #[cfg(not(unix))]
    let _ = executable;
    options.open(path)
}

pub(crate) fn checkpoint(step: &str) -> io::Result<()> {
    #[cfg(test)]
    if std::env::var("MACRO_TEST_PROFILE_FAULT").is_ok_and(|fault| fault == step) {
        let fault = std::env::var("MACRO_TEST_PROFILE_FAULT_ACTION").unwrap();
        eprintln!("profile-fault: {step} {fault}");
        if fault == "crash" {
            #[cfg(unix)]
            unsafe {
                libc::raise(libc::SIGKILL);
            }
            std::process::exit(79);
        }
        let code = match fault.as_str() {
            #[cfg(unix)]
            "EACCES" => libc::EACCES,
            #[cfg(unix)]
            "ENOSPC" => libc::ENOSPC,
            #[cfg(unix)]
            "EIO" => libc::EIO,
            #[cfg(unix)]
            "ENAMETOOLONG" => libc::ENAMETOOLONG,
            #[cfg(windows)]
            "EACCES" => 5, // ERROR_ACCESS_DENIED
            #[cfg(windows)]
            "ENOSPC" => 112, // ERROR_DISK_FULL
            #[cfg(windows)]
            "EIO" => 1117, // ERROR_IO_DEVICE
            #[cfg(windows)]
            "ENAMETOOLONG" => 206, // ERROR_FILENAME_EXCED_RANGE
            _ => panic!("Unknown test filesystem fault: {fault}"),
        };
        return Err(io::Error::from_raw_os_error(code));
    }
    let _ = step;
    Ok(())
}
