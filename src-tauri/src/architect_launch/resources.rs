use super::*;
use argentic_runtime::source::{OpenedSource, RetainedSource};
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

// Serialize changes to retained ownership with admission and startup cleanup.
pub(super) async fn launch_lease(host_root: &Path) -> Result<File> {
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
        fs2::FileExt::lock_exclusive(&file)?;
        Ok::<_, std::io::Error>(file)
    })
    .await
    .map_err(|_| storage_failure())?
    .map_err(|_| storage_failure())
}

pub(super) async fn database_key(pool: &SqlitePool) -> Result<String> {
    let path: String =
        sqlx::query_scalar("SELECT file FROM pragma_database_list WHERE name = 'main'")
            .fetch_one(pool)
            .await?;
    if path.is_empty() {
        return Err(storage_failure());
    }
    let path = Path::new(&path)
        .canonicalize()
        .map_err(|_| storage_failure())?;
    let identity = crate::fs::operations::workspace_root_identity(&path)
        .ok()
        .and_then(|identity| identity.observation_key())
        .ok_or_else(storage_failure)?;
    let mut key = Sha256::new();
    key.update(path.as_os_str().as_encoded_bytes());
    key.update([0]);
    key.update(identity);
    Ok(format!("{:x}", key.finalize()))
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

fn working_root(data: &Path, database: &str, create: bool) -> io::Result<Option<PathBuf>> {
    match managed_root(data, WORKING_FOLDERS, create)? {
        Some(root) => managed_root(&root, database, create),
        None => Ok(None),
    }
}

pub(super) fn new_working_folder(data: &Path, database: &str) -> Result<TempDir> {
    let root = working_root(data, database, true)
        .map_err(|_| storage_failure())?
        .ok_or_else(storage_failure)?;
    tempfile::Builder::new()
        .prefix("run-")
        .tempdir_in(root)
        .map_err(|_| storage_failure())
}

fn snapshot_id(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn snapshot_owners(path: &Path) -> io::Result<Option<BTreeSet<String>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_owners(root: &Path, path: &Path, owners: &BTreeSet<String>) -> io::Result<()> {
    let mut pending = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(&mut pending, owners)?;
    pending.as_file().sync_all()?;
    pending.persist(path)?;
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    Ok(())
}

// Argentic uses the same content-addressed store for every database under
// this configuration root. Legacy copies have no ownership proof.
pub(super) fn retain_snapshot(
    host: &Path,
    database: &str,
    source: &OpenedSource,
    scope: &mut Value,
) -> Result<RetainedSource> {
    let root = managed_root(host, SNAPSHOTS, true)
        .map_err(|_| storage_failure())?
        .ok_or_else(storage_failure)?;
    let existing = fs::read_dir(&root)
        .and_then(|entries| {
            entries
                .map(|entry| entry.map(|item| item.file_name()))
                .collect::<io::Result<BTreeSet<_>>>()
        })
        .map_err(|_| storage_failure())?;
    let retained = source.retain(host)?;
    retained.bind_scope(scope)?;
    let id = scope["projectSnapshot"]
        .as_str()
        .filter(|name| snapshot_id(name))
        .ok_or_else(storage_failure)?;
    let path = root.join(format!("{id}.owners.json"));
    let mut owners = match snapshot_owners(&path).map_err(|_| storage_failure())? {
        Some(owners) => owners,
        None if !existing.contains(std::ffi::OsStr::new(id)) => BTreeSet::new(),
        None => return Ok(retained),
    };
    if owners.insert(database.to_owned()) {
        write_owners(&root, &path, &owners).map_err(|_| storage_failure())?;
    }
    Ok(retained)
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
    let database = database_key(pool).await?;
    let _lease = launch_lease(host).await?;
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT retained_snapshot_id,working_folder FROM architect_launch_runs")
            .fetch_all(pool)
            .await?;
    let (snapshots, folders): (BTreeSet<_>, BTreeSet<_>) = rows.into_iter().unzip();
    let data = data.to_owned();
    let host = host.to_owned();
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        if let Some(root) = managed_root(&host, SNAPSHOTS, false)? {
            for item in fs::read_dir(&root)? {
                let item = item?;
                let name = item.file_name();
                let name = name.to_string_lossy();
                if item.file_type()?.is_dir() && name.starts_with(".tmp") {
                    remove_snapshot(&item.path())?;
                }
                let Some(id) = name
                    .strip_suffix(".owners.json")
                    .filter(|id| snapshot_id(id))
                else {
                    continue;
                };
                if snapshots.contains(id) || !item.file_type()?.is_file() {
                    continue;
                }
                let Some(mut owners) = snapshot_owners(&item.path())? else {
                    continue;
                };
                if !owners.remove(&database) {
                    continue;
                }
                if owners.is_empty() {
                    match remove_snapshot(&root.join(id)) {
                        Ok(()) => (),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                        Err(error) => return Err(error),
                    }
                    fs::remove_file(item.path())?;
                } else {
                    write_owners(&root, &item.path(), &owners)?;
                }
            }
        }
        if let Some(root) = working_root(&data, &database, false)? {
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
