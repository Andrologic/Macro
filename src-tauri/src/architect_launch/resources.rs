use super::*;
use std::{fs, io};
use tempfile::TempDir;
use walkdir::WalkDir;

const SNAPSHOTS: &str = "agsdl-snapshots";
const WORKING_FOLDERS: &str = "agsdl-working-folders";

fn storage_failure() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "STORAGE",
        "launchResources",
        "The archive launch storage is unavailable",
    )
}

// Launches hold a shared lease from allocation until admission and attachment.
// Startup and deletion must hold an exclusive lease while reclaiming resources.
pub(crate) async fn launch_lease(host_root: &Path, exclusive: bool) -> Result<File> {
    let path = host_root.join(".agsdl-snapshot-lifetime.lock");
    tokio::task::spawn_blocking(move || {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path)?;
        if exclusive {
            fs2::FileExt::lock_exclusive(&file)?;
        } else {
            fs2::FileExt::lock_shared(&file)?;
        }
        Ok::<_, std::io::Error>(file)
    })
    .await
    .map_err(|_| storage_failure())?
    .map_err(|_| storage_failure())
}

fn managed_root(data: &Path, name: &str, create: bool) -> io::Result<Option<PathBuf>> {
    let path = data.canonicalize()?.join(name);
    if create {
        fs::create_dir_all(&path)?;
    }
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() && path.canonicalize()? == path => Ok(Some(path)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        _ => Err(io::Error::other("Invalid archive resource directory")),
    }
}

pub(super) fn new_working_folder(data: &Path) -> Result<TempDir> {
    let root = managed_root(data, WORKING_FOLDERS, true)
        .map_err(|_| storage_failure())?
        .ok_or_else(storage_failure)?;
    tempfile::Builder::new()
        .prefix("run-")
        .tempdir_in(root)
        .map_err(|_| storage_failure())
}

pub(super) fn seal_snapshot(project: &Path, workspace: &Path) -> Result<()> {
    let snapshot = project.parent().ok_or_else(storage_failure)?;
    if workspace.starts_with(snapshot) || snapshot.starts_with(workspace) {
        return Err(failure(
            "PERMISSION",
            "workingFolder",
            "Workspace overlaps private archive storage",
        ));
    }
    for item in WalkDir::new(snapshot)
        .contents_first(true)
        .follow_root_links(false)
    {
        let item = item.map_err(|_| storage_failure())?;
        let metadata = item
            .path()
            .symlink_metadata()
            .map_err(|_| storage_failure())?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(storage_failure());
        }
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.is_file() && metadata.nlink() != 1 {
                return Err(storage_failure());
            }
            let executable = metadata.is_dir() || metadata.permissions().mode() & 0o111 != 0;
            fs::Permissions::from_mode(if executable { 0o500 } else { 0o400 })
        };
        #[cfg(not(unix))]
        let permissions = {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(true);
            permissions
        };
        fs::set_permissions(item.path(), permissions).map_err(|_| storage_failure())?;
    }
    Ok(())
}

/// Called with the exclusive launch lease by startup and run deletion.
pub(super) fn remove_snapshot(path: &Path) -> io::Result<()> {
    for item in WalkDir::new(path).follow_root_links(false) {
        let item = item?;
        if item.file_type().is_symlink() {
            continue;
        }
        #[cfg(unix)]
        if item.file_type().is_dir() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(item.path(), fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(windows)]
        {
            let mut permissions = item.metadata()?.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(item.path(), permissions)?;
        }
    }
    fs::remove_dir_all(path)
}

pub(crate) async fn cleanup(pool: &SqlitePool, data: &Path, host: &Path) -> Result<()> {
    if !schema_ready(pool).await? {
        return Ok(());
    }
    let _lease = launch_lease(host, true).await?;
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT retained_snapshot_id,working_folder FROM architect_launch_runs")
            .fetch_all(pool)
            .await?;
    let (snapshots, folders): (BTreeSet<_>, BTreeSet<_>) = rows.into_iter().unzip();
    let data = data.to_owned();
    let host = host.to_owned();
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        if let Some(root) = managed_root(&host, SNAPSHOTS, false)? {
            for item in fs::read_dir(root)? {
                let item = item?;
                let name = item.file_name();
                let name = name.to_string_lossy();
                let snapshot_id =
                    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit());
                if item.file_type()?.is_dir()
                    && (name.starts_with(".tmp") || snapshot_id)
                    && !snapshots.contains(name.as_ref())
                {
                    remove_snapshot(&item.path())?;
                }
            }
        }
        if let Some(root) = managed_root(&data, WORKING_FOLDERS, false)? {
            for item in fs::read_dir(root)? {
                let item = item?;
                let path = item.path();
                if item.file_type()?.is_dir()
                    && item.file_name().to_string_lossy().starts_with("run-")
                    && !path.to_str().is_some_and(|name| folders.contains(name))
                {
                    fs::remove_dir_all(path)?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| storage_failure())?
    .map_err(|_| storage_failure())
}
