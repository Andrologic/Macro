use super::*;
use argentic_runtime::source::{OpenedSource, RetainedSource};
use std::{fs, io};
use tempfile::TempDir;
use walkdir::WalkDir;

pub(crate) const SNAPSHOTS: &str = "agsdl-snapshots";
pub(crate) const WORKING_FOLDERS: &str = "agsdl-working-folders";

fn storage_failure() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "STORAGE",
        "launchResources",
        "The archive launch storage is unavailable",
    )
}

// Serialize changes to retained ownership with admission and startup cleanup.
pub(crate) async fn launch_lease(host_root: &Path) -> Result<File> {
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

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct DatabaseOwner {
    id: uuid::Uuid,
    path: PathBuf,
    identity: String,
    // Stable across replacements at the same path and verified renames.
    pub(super) key: String,
    legacy_key: String,
}

fn ownership_key(path: &Path, identity: &str) -> String {
    let mut key = Sha256::new();
    key.update(path.as_os_str().as_encoded_bytes());
    key.update([0]);
    key.update(identity);
    format!("{:x}", key.finalize())
}

// The host registry stays outside SQLite backups. A database restored at a
// new path gets a new identity unless the registered file itself moved.
// The launch lease protects both registration and use of the returned key.
pub(super) async fn database_owner(pool: &SqlitePool, host: &Path) -> Result<DatabaseOwner> {
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
    let path_text = path.to_str().ok_or_else(storage_failure)?;
    let identity = crate::fs::operations::workspace_root_identity(&path)
        .ok()
        .and_then(|identity| identity.observation_key())
        .ok_or_else(storage_failure)?;
    let stored: Option<(String, String)> =
        sqlx::query_as("SELECT id,path FROM architect_launch_database WHERE singleton=1")
            .fetch_optional(pool)
            .await?;
    let registry = host.join(".agsdl-database-owners.json");
    let mut owners = read_registry(&registry)?;
    let index = owners
        .iter()
        .position(|entry| entry.path == path)
        .or_else(|| {
            let (id, previous_path) = stored.as_ref()?;
            let id = uuid::Uuid::parse_str(id).ok()?;
            owners.iter().position(|entry| {
                entry.id == id
                    && entry.path == Path::new(previous_path)
                    && entry.identity == identity
                    && matches!(entry.path.try_exists(), Ok(false))
            })
        });
    let mut registry_changed = true;
    let owner = if let Some(index) = index {
        let owner = &mut owners[index];
        registry_changed = owner.identity != identity || owner.path != path;
        owner.path = path.clone();
        owner.identity = identity;
        owner.clone()
    } else {
        let id = uuid::Uuid::new_v4();
        let owner = DatabaseOwner {
            id,
            key: ownership_key(&path, &id.to_string()),
            legacy_key: ownership_key(&path, &identity),
            path: path.clone(),
            identity,
        };
        owners.push(owner.clone());
        owner
    };
    let id = owner.id.to_string();
    if registry_changed {
        // Publish the registry first. If the SQLite write fails, retry at
        // the same path uses the same owner and never loses its resources.
        write_json(host, &registry, &owners).map_err(|_| storage_failure())?;
    }
    if !stored
        .as_ref()
        .is_some_and(|(known_id, known_path)| known_id == &id && known_path == path_text)
    {
        sqlx::query(
            "INSERT INTO architect_launch_database(singleton,id,path) VALUES (1,?,?)
             ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,path=excluded.path",
        )
        .bind(id)
        .bind(path_text)
        .execute(pool)
        .await?;
    }
    Ok(owner)
}

fn read_registry(path: &Path) -> Result<Vec<DatabaseOwner>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| storage_failure()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(storage_failure()),
    }
}

/// Reserve the destination profile's existing key before the restore writes
/// its replacement database. Startup fills in the new file identity.
pub(crate) fn reserve_backup_owner(data: &Path, host: &Path) -> Result<String> {
    let path = data
        .canonicalize()
        .map_err(|_| storage_failure())?
        .join("macro.db");
    let registry = host.join(".agsdl-database-owners.json");
    let mut owners = read_registry(&registry)?;
    if let Some(owner) = owners.iter().find(|owner| owner.path == path) {
        return Ok(owner.key.clone());
    }
    let id = uuid::Uuid::new_v4();
    let key = ownership_key(&path, &id.to_string());
    owners.push(DatabaseOwner {
        id,
        path,
        identity: String::new(),
        key: key.clone(),
        legacy_key: key.clone(),
    });
    write_json(host, &registry, &owners).map_err(|_| storage_failure())?;
    Ok(key)
}

pub(crate) fn backup_snapshot_needs_owner(root: &Path, id: &str, owner: &str) -> io::Result<bool> {
    let path = root.join(format!("{id}.owners.json"));
    Ok(snapshot_owners(&path)?.is_some_and(|owners| !owners.contains(owner)))
}

/// Called under the launch lease before publishing a restored snapshot.
pub(crate) fn register_backup_snapshot(root: &Path, id: &str, owner: &str) -> io::Result<()> {
    let path = root.join(format!("{id}.owners.json"));
    let mut owners = snapshot_owners(&path)?.unwrap_or_default();
    if owners.insert(owner.to_owned()) {
        write_json(root, &path, &owners)?;
    }
    Ok(())
}

/// Undo ownership acquired to publish a new snapshot during restore. Another
/// profile may have claimed it after the restoring process died.
pub(crate) fn rollback_backup_snapshot(root: &Path, id: &str, owner: &str) -> io::Result<()> {
    let path = root.join(format!("{id}.owners.json"));
    let Some(mut owners) = snapshot_owners(&path)? else {
        return Ok(());
    };
    if !owners.remove(owner) {
        return Ok(());
    }
    if owners.is_empty() {
        match remove_snapshot(&root.join(id)) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        crate::fs::profile::remove_file(&path)?;
        crate::fs::profile::sync_directory(root)
    } else {
        write_json(root, &path, &owners)
    }
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

pub(crate) fn snapshot_id(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn snapshot_owners(path: &Path) -> io::Result<Option<BTreeSet<String>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_json(root: &Path, path: &Path, value: &impl Serialize) -> io::Result<()> {
    let mut pending = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(&mut pending, value)?;
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
        write_json(&root, &path, &owners).map_err(|_| storage_failure())?;
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
    seal_snapshot_tree(snapshot)
}

pub(crate) fn seal_snapshot_tree(snapshot: &Path) -> Result<()> {
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
pub(crate) fn remove_snapshot(path: &Path) -> io::Result<()> {
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

pub(crate) fn remove_working_tree(path: &Path) -> io::Result<()> {
    crate::fs::profile::check("remove-tree", path)?;
    // Unix unlinks entries through their parent directory. Windows also
    // requires clearing the read-only attribute on files themselves.
    let mut pending = vec![path.to_owned()];
    while let Some(entry) = pending.pop() {
        let metadata = match fs::symlink_metadata(&entry) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound && entry != path => continue,
            Err(error) => return Err(error),
        };
        if crate::architect_library::storage::is_link_or_reparse_point(&metadata) {
            continue;
        }
        #[cfg(unix)]
        if metadata.is_dir() {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = metadata.permissions().mode();
            if mode & 0o300 != 0o300 {
                fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
                    .open(&entry)?
                    .set_permissions(fs::Permissions::from_mode(mode | 0o300))?;
            }
        }
        #[cfg(windows)]
        {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                fs::set_permissions(&entry, permissions)?;
            }
        }
        if metadata.is_dir() {
            for child in fs::read_dir(&entry)? {
                let child = child?;
                #[cfg(unix)]
                if !child.file_type()?.is_dir() {
                    continue;
                }
                pending.push(child.path());
            }
        }
    }
    fs::remove_dir_all(path)
}

pub(crate) async fn cleanup(pool: &SqlitePool, data: &Path, host: &Path) -> Result<()> {
    if !schema_ready(pool).await? {
        return Ok(());
    }
    let lease = launch_lease(host).await?;
    cleanup_locked(pool, data, host, lease).await
}

pub(super) async fn cleanup_locked(
    pool: &SqlitePool,
    data: &Path,
    host: &Path,
    lease: File,
) -> Result<()> {
    let database = database_owner(pool, host).await?;
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT retained_snapshot_id,
            CASE WHEN owns_working_folder THEN working_folder END FROM architect_launch_runs",
    )
    .fetch_all(pool)
    .await?;
    let (snapshots, folders): (BTreeSet<_>, BTreeSet<_>) = rows.into_iter().unzip();
    let data = data.to_owned();
    let host = host.to_owned();
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        let _lease = lease;
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
                if !item.file_type()?.is_file() {
                    continue;
                }
                let Some(mut owners) = snapshot_owners(&item.path())? else {
                    continue;
                };
                let legacy = owners.remove(&database.legacy_key);
                if snapshots.contains(id) {
                    // A restored profile may reference a shared snapshot it
                    // has never launched. Register it before another owner
                    // can reclaim its now-unreferenced copy.
                    if owners.insert(database.key.clone()) || legacy {
                        write_json(&root, &item.path(), &owners)?;
                    }
                    continue;
                }
                if !owners.remove(&database.key) && !legacy {
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
                    write_json(&root, &item.path(), &owners)?;
                }
            }
        }
        for key in [&database.key, &database.legacy_key] {
            if let Some(root) = working_root(&data, key, false)? {
                for item in fs::read_dir(root)? {
                    let item = item?;
                    let name = item.file_name();
                    if item.file_type()?.is_dir()
                        && name.to_string_lossy().starts_with("run-")
                        && !folders.iter().flatten().any(|folder| {
                            let path = Path::new(folder);
                            path.file_name() == Some(name.as_os_str())
                                && path.parent().and_then(Path::file_name) == Some(key.as_ref())
                        })
                    {
                        remove_working_tree(&item.path())?;
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| storage_failure())?
    .map_err(|_| storage_failure())
}
