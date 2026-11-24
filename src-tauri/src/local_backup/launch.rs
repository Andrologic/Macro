use super::*;
use crate::architect_launch::resources;
use sqlx::Row;

mod working_path;
use working_path::Encoding;

const WORKING: &str = "data/agsdl-working-folders/";
const SNAPSHOTS: &str = "config/agsdl-snapshots/";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Manifest {
    directories: BTreeSet<String>,
    links: BTreeMap<String, Link>,
    missing: BTreeSet<String>,
    // Absent in older archives, which used text paths for working members.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    working_paths: Option<Encoding>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Link {
    target: LinkTarget,
    directory: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
enum LinkTarget {
    Legacy(PathBuf),
    Native {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        managed: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suffix: Option<String>,
    },
}

#[derive(Default)]
struct References {
    snapshots: BTreeSet<String>,
    // External paths stay in their original database rows.
    working: BTreeMap<String, (String, String)>,
}

fn working_prefix(name: &str) -> Option<&str> {
    let mut parts = name.strip_prefix(WORKING)?.split('/');
    let key = parts.next().filter(|key| resources::snapshot_id(key))?;
    let folder = parts.next().filter(|folder| {
        folder.strip_prefix("run-").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
    })?;
    Some(&name[..WORKING.len() + key.len() + 1 + folder.len()])
}

fn working_name(data: &Path, path: &Path) -> Result<String> {
    let relative =
        working_path::strip_root(path, data).ok_or("Working path is outside the profile")?;
    let mut parts = relative.components();
    let root: PathBuf = parts.by_ref().take(3).collect();
    let mut name = format!("data/{}", archive_relative_path(&root)?);
    if working_prefix(&name) != Some(name.as_str()) {
        return Err("Invalid managed working folder".into());
    }
    for part in parts {
        let Component::Normal(part) = part else {
            return Err("Invalid managed working path".into());
        };
        name.push('/');
        name.push_str(&Encoding::encode(part));
    }
    Ok(name)
}

fn managed_link(data: &Path, target: &Path) -> Option<(String, Option<String>)> {
    if !target.is_absolute() {
        return None;
    }
    let (root, source_data, root_name) = target
        .ancestors()
        .filter_map(|root| {
            let owner = root.parent()?;
            let working = owner.parent()?;
            if working.file_name()? != resources::WORKING_FOLDERS {
                return None;
            }
            let name = format!(
                "{WORKING}{}/{}",
                owner.file_name()?.to_str()?,
                root.file_name()?.to_str()?
            );
            if working_prefix(&name) != Some(&name) {
                return None;
            }
            let source_data = working.parent()?;
            if source_data != data && source_data.canonicalize().ok().as_deref() != Some(data) {
                return None;
            }
            Some((root, source_data, name))
        })
        .last()?;
    let suffix = working_path::raw_suffix(target, root);
    let managed = working_name(source_data, target)
        .ok()
        .filter(|name| validate_working_name(name, Some(Encoding::NATIVE)).is_ok())
        .unwrap_or(root_name);
    let suffix = (!suffix.is_empty()).then(|| Encoding::encode(suffix));
    Some((managed, suffix))
}

pub(super) fn encoded_working_file(archive: &Archive, name: &str) -> bool {
    archive
        .launch
        .as_ref()
        .is_some_and(|manifest| manifest.working_paths.is_some())
        && working_prefix(name).is_some_and(|prefix| prefix.len() < name.len())
}

fn database_folder(path: &str, encoding: Option<Encoding>) -> Result<String> {
    let join_tail = |separators: &[char]| {
        let tail: Vec<_> = path.rsplitn(4, separators).take(3).collect();
        match tail.as_slice() {
            [folder, owner, root] => {
                let name = format!("data/{root}/{owner}/{folder}");
                (working_prefix(&name) == Some(name.as_str())).then_some(name)
            }
            _ => None,
        }
    };
    match encoding {
        Some(Encoding::UnixBytes) => join_tail(&['/']),
        Some(Encoding::WindowsUtf16Le) => join_tail(&['/', '\\']),
        None => join_tail(&['/']).or_else(|| join_tail(&['/', '\\'])),
    }
    .ok_or_else(|| "Invalid managed working folder".into())
}

fn snapshot_prefix(name: &str) -> Option<&str> {
    let (id, member) = name.strip_prefix(SNAPSHOTS)?.split_once('/')?;
    (resources::snapshot_id(id) && (member == "files.json" || member.starts_with("project/")))
        .then(|| &name[..SNAPSHOTS.len() + id.len()])
}

pub(super) fn destination_path(name: &str) -> bool {
    working_prefix(name).is_some()
        || snapshot_prefix(name).is_some()
        || name
            .strip_prefix(SNAPSHOTS)
            .is_some_and(resources::snapshot_id)
}

pub(super) fn file(name: &str) -> bool {
    working_prefix(name).is_some_and(|prefix| prefix.len() < name.len())
        || snapshot_prefix(name).is_some()
}

fn snapshot_ids(archive: &Archive) -> BTreeSet<&str> {
    archive
        .files
        .keys()
        .filter_map(|name| {
            name.strip_prefix(SNAPSHOTS)?
                .strip_suffix("/files.json")
                .filter(|id| resources::snapshot_id(id))
        })
        .collect()
}

async fn references(database: &Path, encoding: Option<Encoding>) -> Result<References> {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(database)
            .read_only(true),
    )
    .await
    .map_err(|error| error.to_string())?;
    let present: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='architect_launch_runs')",
    ).fetch_one(&mut db).await.map_err(|error| error.to_string())?;
    let mut result = References::default();
    if present {
        let rows = sqlx::query(
            "SELECT system_id,retained_snapshot_id,working_folder,owns_working_folder FROM architect_launch_runs",
        ).fetch_all(&mut db).await.map_err(|error| error.to_string())?;
        for row in rows {
            let id: String = row.get("retained_snapshot_id");
            if !resources::snapshot_id(&id) {
                return Err("Invalid retained snapshot reference".into());
            }
            result.snapshots.insert(id);
            if row.get("owns_working_folder") {
                let folder: String = row.get("working_folder");
                let name = database_folder(&folder, encoding)?;
                result.working.insert(name, (row.get("system_id"), folder));
            }
        }
    }
    db.close().await.map_err(|error| error.to_string())?;
    Ok(result)
}

fn snapshot_root(config: &Path) -> PathBuf {
    config.join(resources::SNAPSHOTS)
}

fn data_path(data: &Path, name: &str) -> PathBuf {
    data.join(
        name.strip_prefix("data/")
            .expect("validated working folder"),
    )
}

pub(super) async fn lease(config: &Path) -> Result<Option<fs::File>> {
    if !config.exists() {
        return Ok(None);
    }
    safe_parent(&snapshot_root(config), config)?;
    resources::launch_lease(config)
        .await
        .map(Some)
        .map_err(|e| e.message)
}

fn collect_working(
    data: &Path,
    path: &Path,
    manifest: &mut Manifest,
    files: &mut BTreeMap<String, Entry>,
    staging: &Arc<tempfile::TempDir>,
) -> Result<()> {
    safe_parent(path, data)?;
    for item in walkdir::WalkDir::new(path).follow_root_links(false) {
        let item = item.map_err(|error| error.to_string())?;
        let path = item.path();
        let name = working_name(data, path)?;
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            #[cfg(windows)]
            let directory = {
                use std::os::windows::fs::FileTypeExt;
                metadata.file_type().is_symlink_dir()
            };
            #[cfg(not(windows))]
            let directory = false;
            let target = fs::read_link(path).map_err(|error| error.to_string())?;
            let (managed, suffix) = match managed_link(data, &target) {
                Some((name, suffix)) => (Some(name), suffix),
                None => (None, None),
            };
            let target = LinkTarget::Native {
                path: Encoding::encode(target.as_os_str()),
                managed,
                suffix,
            };
            manifest.links.insert(name, Link { target, directory });
        } else if metadata.is_dir() && !storage::is_link_or_reparse_point(&metadata) {
            manifest.directories.insert(name);
        } else if metadata.is_file() && !storage::is_link_or_reparse_point(&metadata) {
            stage_artifact(files, staging, name, path, &metadata)?;
        } else {
            return Err("Unsupported managed working folder entry".into());
        }
    }
    Ok(())
}

pub(super) async fn capture(
    archive: &mut Archive,
    database: &Path,
    data: &Path,
    config: &Path,
    raw: bool,
) -> Result<()> {
    let references = match references(database, Some(Encoding::NATIVE)).await {
        Ok(references) => references,
        // C3 preserves even an unreadable original database as raw bytes.
        Err(_) if raw => References::default(),
        Err(error) => return Err(error),
    };
    let mut manifest = Manifest::default();
    let staging = Arc::new(private_staging(data)?);
    // Architect creates working folders beneath the canonical profile path.
    let data = &data.canonicalize().map_err(|error| error.to_string())?;
    for id in references.snapshots {
        let path = snapshot_root(config).join(&id);
        safe_parent(&path, config)?;
        if !path.try_exists().map_err(|e| e.to_string())? {
            manifest.missing.insert(format!("{SNAPSHOTS}{id}"));
            continue;
        }
        let index_path = path.join("files.json");
        safe_parent(&index_path, config)?;
        let index: SnapshotIndex = serde_json::from_slice(&read_bounded(&index_path)?)
            .map_err(|error| error.to_string())?;
        walk_tree(config, &path, &mut None, &mut |name, path, _| {
            let name = format!(
                "config/{}",
                name.strip_prefix("data/").expect("walk_tree prefix")
            );
            let prefix = format!("{SNAPSHOTS}{id}/project/");
            let executable = name
                .strip_prefix(&prefix)
                .and_then(|path| index.files.get(path))
                .is_some_and(|entry| entry.executable);
            let input = fs::File::open(path).map_err(|error| error.to_string())?;
            let entry = bundle::stage(&staging, &name, input, executable)?;
            archive.files.insert(name, entry);
            Ok(())
        })?;
    }
    if raw {
        // Reserve the complete private tree, including leftovers from a
        // previous launch or an unreadable DB. No user folder can live here.
        let root = data.join(resources::WORKING_FOLDERS);
        safe_parent(&root, data)?;
        if root.try_exists().map_err(|e| e.to_string())? {
            for owner in fs::read_dir(&root).map_err(|e| e.to_string())? {
                let owner = owner.map_err(|e| e.to_string())?.path();
                safe_parent(&owner, data)?;
                for folder in fs::read_dir(owner).map_err(|e| e.to_string())? {
                    collect_working(
                        data,
                        &folder.map_err(|e| e.to_string())?.path(),
                        &mut manifest,
                        &mut archive.files,
                        &staging,
                    )?;
                }
            }
        }
    } else {
        for name in references.working.into_keys() {
            let path = data_path(data, &name);
            if path.try_exists().map_err(|e| e.to_string())? {
                collect_working(data, &path, &mut manifest, &mut archive.files, &staging)?;
            } else {
                // A previous Macro version could restore a row without its
                // files. Preserve that absence without reading another profile.
                manifest.missing.insert(name);
            }
        }
    }
    if raw
        || !manifest.directories.is_empty()
        || !manifest.missing.is_empty()
        || !snapshot_ids(archive).is_empty()
    {
        manifest.working_paths = (!manifest.directories.is_empty()).then_some(Encoding::NATIVE);
        archive.launch = Some(manifest);
    }
    Ok(())
}

pub(super) fn check_targets(archive: &Archive, data: &Path, config: &Path) -> Result<()> {
    if archive.launch.is_none() {
        return Ok(());
    }
    safe_parent(&data.join(resources::WORKING_FOLDERS), data)?;
    for name in archive
        .files
        .keys()
        .filter(|name| snapshot_prefix(name).is_some())
    {
        let path = destination(name, data, config)?;
        if !fits_existing_file(&path) {
            return Err(format!(
                "Launch resource {name:?} exceeds the destination filesystem path limit"
            ));
        }
        safe_parent(&path, config)?;
    }
    Ok(())
}

fn validate_working_name(name: &str, encoding: Option<Encoding>) -> Result<&str> {
    let prefix = working_prefix(name).ok_or("Invalid launch working path")?;
    if let Some(encoding) = encoding {
        if let Some(relative) = name[prefix.len()..].strip_prefix('/') {
            for part in relative.split('/') {
                encoding.component(part)?;
            }
        }
    } else {
        destination(name, Path::new("data"), Path::new("config"))?;
    }
    Ok(prefix)
}

pub(super) fn validate_paths(archive: &Archive) -> Result<()> {
    let mut paths = BTreeSet::new();
    let Some(manifest) = &archive.launch else {
        return if archive.files.keys().any(|name| destination_path(name)) {
            Err("Launch backup manifest is missing".into())
        } else {
            Ok(())
        };
    };
    for name in &manifest.directories {
        let prefix = validate_working_name(name, manifest.working_paths)?;
        if name != prefix
            && !manifest
                .directories
                .contains(name.rsplit_once('/').unwrap().0)
        {
            return Err("Missing launch parent directory".into());
        }
        paths.insert(name.as_str());
    }
    for name in manifest.links.keys().chain(
        archive
            .files
            .keys()
            .filter(|name| working_prefix(name).is_some()),
    ) {
        let prefix = validate_working_name(name, manifest.working_paths)?;
        if name == prefix
            || !paths.insert(name)
            || !manifest
                .directories
                .contains(name.rsplit_once('/').unwrap().0)
        {
            return Err("Invalid launch member or missing directory".into());
        }
    }
    for name in archive.files.keys().filter(|name| destination_path(name)) {
        if !file(name) {
            return Err("Invalid launch backup file".into());
        }
        if snapshot_prefix(name).is_some() {
            destination(name, Path::new("data"), Path::new("config"))?;
        }
    }
    for link in manifest.links.values() {
        match (&link.target, manifest.working_paths) {
            (
                LinkTarget::Native {
                    path,
                    managed,
                    suffix,
                },
                Some(encoding),
            ) => {
                encoding.link(path)?;
                if let Some(managed) = managed {
                    validate_working_name(managed, Some(encoding))?;
                }
                if let Some(suffix) = suffix {
                    if managed.is_none() {
                        return Err("Managed launch link suffix has no working folder".into());
                    }
                    encoding.link_suffix(suffix)?;
                }
            }
            (LinkTarget::Legacy(target), None)
                if !target.as_os_str().is_empty()
                    && !target.as_os_str().as_encoded_bytes().contains(&0) => {}
            _ => return Err("Invalid launch link target".into()),
        }
    }
    for name in &manifest.missing {
        destination(name, Path::new("data"), Path::new("config"))?;
        let snapshot = name
            .strip_prefix(SNAPSHOTS)
            .is_some_and(resources::snapshot_id);
        if !snapshot && working_prefix(name) != Some(name.as_str()) {
            return Err("Invalid missing launch resource reference".into());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct SnapshotIndex {
    files: BTreeMap<String, SnapshotFile>,
}

#[derive(Deserialize)]
struct SnapshotFile {
    sha256: String,
    size: u64,
    executable: bool,
}

struct DigestWriter(Sha256);
impl Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn validate_snapshots(archive: &Archive) -> Result<()> {
    let mut expected = BTreeSet::new();
    for id in snapshot_ids(archive) {
        let name = format!("{SNAPSHOTS}{id}/files.json");
        let entry = &archive.files[&name];
        if entry.executable || entry.sha256 != id || entry.size(&name)? > LIMIT {
            return Err("Invalid retained snapshot index".into());
        }
        let mut bytes = Vec::new();
        entry
            .copy_verified(&name, &mut bytes)
            .map_err(|e| e.to_string())?;
        expected.insert(name);
        let index: SnapshotIndex = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        for (path, member) in index.files {
            let name = format!("{SNAPSHOTS}{id}/project/{path}");
            let entry = archive
                .files
                .get(&name)
                .ok_or("Missing retained snapshot member")?;
            let mut digest = DigestWriter(Sha256::new());
            entry
                .copy_verified(&name, &mut digest)
                .map_err(|e| e.to_string())?;
            if member.sha256 != format!("{:x}", digest.0.finalize())
                || entry.size(&name)? != member.size
                || entry.executable != member.executable
            {
                return Err("Retained snapshot member differs from its index".into());
            }
            expected.insert(name);
        }
    }
    if archive
        .files
        .keys()
        .filter(|name| snapshot_prefix(name).is_some())
        .ne(expected.iter())
    {
        return Err("Unexpected retained snapshot member".into());
    }
    Ok(())
}

pub(super) async fn validate(archive: &Archive, database: &Path) -> Result<()> {
    let Some(manifest) = &archive.launch else {
        // Earlier profile backups only contained the database references.
        return Ok(());
    };
    let references = references(database, manifest.working_paths).await?;
    let mut actual: BTreeSet<String> = snapshot_ids(archive)
        .into_iter()
        .map(|id| format!("{SNAPSHOTS}{id}"))
        .chain(
            manifest
                .directories
                .iter()
                .filter(|name| working_prefix(name) == Some(name.as_str()))
                .cloned(),
        )
        .collect();
    if manifest
        .missing
        .iter()
        .any(|name| !actual.insert(name.clone()))
    {
        return Err("Launch resource is both present and missing".into());
    }
    let expected: BTreeSet<_> = references
        .snapshots
        .into_iter()
        .map(|id| format!("{SNAPSHOTS}{id}"))
        .chain(references.working.into_keys())
        .collect();
    if actual != expected {
        return Err("Launch resources do not match the backup database".into());
    }
    validate_snapshots(archive)
}

pub(super) async fn filter_preserved(archive: &mut Archive, database: &Path) -> Result<()> {
    let Some(manifest) = &mut archive.launch else {
        return Ok(());
    };
    let references = references(database, manifest.working_paths).await?;
    let retain = |name: &str| {
        working_prefix(name).is_some_and(|prefix| references.working.contains_key(prefix))
    };
    manifest.directories.retain(|name| retain(name));
    manifest.links.retain(|name, _| retain(name));
    archive
        .files
        .retain(|name, _| working_prefix(name).is_none() || retain(name));
    for name in references.working.keys() {
        if !manifest.directories.contains(name) {
            manifest.missing.insert(name.clone());
        }
    }
    Ok(())
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct SnapshotRollback {
    owner: String,
    ids: BTreeSet<String>,
    #[serde(default)]
    claims: BTreeSet<String>,
}

pub(super) fn plan_snapshots(
    archive: &Archive,
    config: &Path,
    owner: &str,
) -> Result<SnapshotRollback> {
    let root = snapshot_root(config);
    let mut ids = BTreeSet::new();
    let mut claims = BTreeSet::new();
    for id in snapshot_ids(archive) {
        let target = root.join(id);
        safe_parent(&target, config)?;
        if !target.try_exists().map_err(|e| e.to_string())? {
            ids.insert(id.to_owned());
        } else {
            if resources::backup_snapshot_needs_owner(&root, id, owner)
                .map_err(|e| e.to_string())?
            {
                claims.insert(id.to_owned());
            }
            // Shared content-addressed copies can still be used by another
            // database. Verify and reuse them without writing through them.
            let prefix = format!("{SNAPSHOTS}{id}/");
            for (name, entry) in archive
                .files
                .range(prefix.clone()..)
                .take_while(|(name, _)| name.starts_with(&prefix))
            {
                let path = target.join(&name[prefix.len()..]);
                safe_parent(&path, config)?;
                let mut writer = DigestWriter(entry_digest(entry.executable));
                io::copy(
                    &mut fs::File::open(path).map_err(|e| e.to_string())?,
                    &mut writer,
                )
                .map_err(|e| e.to_string())?;
                if format!("{:x}", writer.0.finalize()) != entry.sha256 {
                    return Err("Existing retained snapshot differs from the backup".into());
                }
            }
        }
    }
    Ok(SnapshotRollback {
        owner: owner.to_owned(),
        ids,
        claims,
    })
}

pub(super) fn apply_snapshots(
    archive: &Archive,
    config: &Path,
    plan: &SnapshotRollback,
) -> Result<()> {
    if plan.ids.is_empty() && plan.claims.is_empty() {
        return Ok(());
    }
    let root = snapshot_root(config);
    storage::ensure_staging_dir(config, &root).map_err(|e| e.to_string())?;
    for id in &plan.claims {
        resources::register_backup_snapshot(&root, id, &plan.owner).map_err(|e| e.to_string())?;
    }
    for id in &plan.ids {
        let staged = tempfile::Builder::new()
            .prefix(".tmp-restore-")
            .tempdir_in(&root)
            .map_err(|e| e.to_string())?;
        let prefix = format!("{SNAPSHOTS}{id}/");
        let mut dirs = BTreeSet::new();
        let mut written = Vec::with_capacity(FILE_SYNC_BATCH);
        for (name, entry) in archive
            .files
            .range(prefix.clone()..)
            .take_while(|(name, _)| name.starts_with(&prefix))
        {
            let path = staged.path().join(&name[prefix.len()..]);
            write_launch_file(name, entry, &path, staged.path(), &mut dirs, &mut written)?;
        }
        sync_written_files(&mut written)?;
        resources::seal_snapshot_tree(staged.path()).map_err(|e| e.message)?;
        sync_dirs(dirs)?;
        resources::register_backup_snapshot(&root, id, &plan.owner).map_err(|e| e.to_string())?;
        let source = staged.keep();
        profile::rename_without_replacement(&source, &root.join(id)).map_err(|e| e.to_string())?;
        sync_directory(&root)?;
        sync_directory(config)?;
    }
    Ok(())
}

pub(super) fn rollback_snapshots(config: &Path, plan: &SnapshotRollback) -> Result<()> {
    let mut ids = plan.ids.iter().chain(&plan.claims).peekable();
    if ids.peek().is_none() {
        return Ok(());
    }
    if !resources::snapshot_id(&plan.owner) || ids.clone().any(|id| !resources::snapshot_id(id)) {
        return Err("Invalid launch restore journal".into());
    }
    let root = snapshot_root(config);
    safe_parent(&root, config)?;
    for id in ids {
        resources::rollback_backup_snapshot(&root, id, &plan.owner).map_err(|e| e.to_string())?;
    }
    if root.is_dir() {
        for entry in root.read_dir().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tmp-restore-")
            {
                resources::remove_snapshot(&entry.path()).map_err(|e| e.to_string())?;
            }
        }
        sync_directory(&root)?;
    }
    Ok(())
}

pub(super) async fn relocate_working(
    archive: &mut Archive,
    data: &Path,
    owner: &str,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut paths = BTreeMap::new();
    let Some(manifest) = &mut archive.launch else {
        return Ok(paths);
    };
    let staging = Arc::new(private_staging(data)?);
    let path = staging.path().join("working.db");
    copy_entry_to_file(&archive.files["data/macro.db"], "data/macro.db", &path)?;
    let references = references(&path, manifest.working_paths).await?;
    if references.working.is_empty() {
        return Ok(paths);
    }
    let data = data.canonicalize().map_err(|error| error.to_string())?;
    let mut db = connection(&path).await?;
    let mut changed = false;
    let mut targets = BTreeSet::new();
    let mut legacy_relocations = Vec::new();
    for (name, (id, old)) in references.working {
        let folder = name.rsplit_once('/').unwrap().1;
        let mut basename = folder.to_owned();
        // A run basename can collide when two source owners merge or when
        // the destination filesystem ignores case. Give each row its own root.
        while !targets.insert(basename.to_ascii_lowercase()) {
            basename = format!("run-{}", uuid::Uuid::new_v4().simple());
        }
        let target = data
            .join(resources::WORKING_FOLDERS)
            .join(owner)
            .join(basename);
        let target_text = target
            .to_str()
            .ok_or("Invalid managed working folder destination")?;
        if target_text != old {
            sqlx::query("UPDATE architect_launch_runs SET working_folder=? WHERE system_id=?")
                .bind(target_text)
                .bind(id)
                .execute(&mut db)
                .await
                .map_err(|e| e.to_string())?;
            changed = true;
            if manifest.working_paths.is_none() {
                legacy_relocations.push((PathBuf::from(old), target.clone()));
            }
        }
        paths.insert(name, target);
    }
    for link in manifest.links.values_mut() {
        if let LinkTarget::Legacy(target) = &mut link.target {
            if !target.is_absolute() {
                continue;
            }
            for (old, new) in &legacy_relocations {
                if let Some(root) = target.ancestors().find(|root| {
                    working_path::strip_root(root, old)
                        .is_some_and(|suffix| suffix.as_os_str().is_empty())
                }) {
                    *target =
                        working_path::with_suffix(new, working_path::raw_suffix(target, root));
                    break;
                }
            }
        }
    }
    db.close().await.map_err(|e| e.to_string())?;
    if changed {
        archive.files.remove("data/macro.db");
        add_database_file(&mut archive.files, &staging, "data/macro.db", &path)?;
    }
    Ok(paths)
}

struct WorkingRestore<'a> {
    data: &'a Path,
    paths: &'a BTreeMap<String, PathBuf>,
    encoding: Option<Encoding>,
    raw: bool,
    skipped: BTreeMap<String, &'static str>,
}

impl WorkingRestore<'_> {
    fn path(&self, name: &str) -> Result<Option<PathBuf>> {
        let prefix = working_prefix(name).ok_or("Invalid launch working folder")?;
        let mut path = if self.raw {
            data_path(self.data, prefix)
        } else {
            self.paths
                .get(prefix)
                .ok_or("Unmapped launch working folder")?
                .clone()
        };
        if let Some(relative) = name[prefix.len()..].strip_prefix('/') {
            if let Some(encoding) = self.encoding {
                for part in relative.split('/') {
                    let Some(component) = encoding.component(part)? else {
                        return Ok(None);
                    };
                    path.push(component);
                }
            } else {
                path.push(relative);
            }
        }
        Ok(fits_existing_file(&path).then_some(path))
    }

    fn omitted(&self, name: &str) -> bool {
        std::iter::successors(Some(name), |name| {
            name.rsplit_once('/').map(|(parent, _)| parent)
        })
        .any(|name| self.skipped.contains_key(name))
    }

    fn omit(&mut self, name: &str, reason: &'static str) -> Result<()> {
        if self.raw {
            return Err(format!(
                "Cannot recover working resource {}: {reason}",
                self.describe(name)
            ));
        }
        self.skipped.insert(name.to_owned(), reason);
        Ok(())
    }

    fn create<T>(
        &mut self,
        name: &str,
        create: impl FnOnce(&Path) -> io::Result<T>,
    ) -> Result<Option<(PathBuf, T)>> {
        if self.omitted(name) {
            return Ok(None);
        }
        let Some(path) = self.path(name)? else {
            self.omit(name, "name or path length unsupported by the destination")?;
            return Ok(None);
        };
        match create(&path) {
            Ok(value) => Ok(Some((path, value))),
            Err(error) if unavailable_name(&error, &path) => {
                self.omit(name, "name conflicts with another entry or is unsupported by the destination filesystem")?;
                Ok(None)
            }
            Err(error) => Err(format!(
                "Cannot restore working resource {}: {error}",
                self.describe(name)
            )),
        }
    }

    fn describe(&self, name: &str) -> String {
        let prefix = working_prefix(name).expect("validated working name");
        match (self.encoding, name[prefix.len()..].strip_prefix('/')) {
            (Some(encoding), Some(relative)) => {
                let parts: Vec<_> = relative
                    .split('/')
                    .map(|part| encoding.describe(part))
                    .collect();
                format!("{prefix}/{}", parts.join("/"))
            }
            _ => format!("{name:?}"),
        }
    }

    fn diagnostics(&self) -> String {
        if self.skipped.is_empty() {
            return String::new();
        }
        let mut report = format!("Skipped {} working-folder entries or directory trees during restore. The source archive retains their contents.", self.skipped.len());
        for (name, reason) in &self.skipped {
            let line = format!("\n{}: {reason}", self.describe(name));
            if report.len() + line.len() > 64 * 1024 {
                report.push_str("\nFurther entries omitted from this diagnostic.");
                break;
            }
            report.push_str(&line);
        }
        report
    }
}

fn unavailable_name(error: &io::Error, path: &Path) -> bool {
    if error.kind() == io::ErrorKind::AlreadyExists {
        #[cfg(test)]
        if profile::mutated("treat-eexist-as-alias") {
            return true;
        }
        return fs::symlink_metadata(path).is_ok();
    }
    // Verify that the volume rejects the name itself. An unrelated I/O
    // failure during creation must still trigger rollback.
    invalid_name(error) && fs::symlink_metadata(path).is_err_and(|error| invalid_name(&error))
}

fn invalid_name(error: &io::Error) -> bool {
    #[cfg(unix)]
    return matches!(
        error.raw_os_error(),
        Some(libc::ENAMETOOLONG | libc::EINVAL)
    );
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{ERROR_FILENAME_EXCED_RANGE, ERROR_INVALID_NAME};
        return error.raw_os_error().is_some_and(|code| {
            code == ERROR_FILENAME_EXCED_RANGE as i32 || code == ERROR_INVALID_NAME as i32
        });
    }
}

pub(super) fn apply_working(
    archive: &Archive,
    data: &Path,
    paths: &BTreeMap<String, PathBuf>,
    raw: bool,
) -> Result<String> {
    let Some(manifest) = &archive.launch else {
        return Ok(String::new());
    };
    let data = &data.canonicalize().map_err(|error| error.to_string())?;
    if raw {
        remove_working_tree(data, &data.join(resources::WORKING_FOLDERS))?;
    } else {
        for target in paths.values().filter(|path| fits_existing_file(path)) {
            remove_working_tree(data, target)?;
        }
    }
    let mut restore = WorkingRestore {
        data,
        paths,
        encoding: manifest.working_paths,
        raw,
        skipped: BTreeMap::new(),
    };
    let mut dirs = BTreeSet::new();
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    for name in &manifest.directories {
        // The manifest orders each parent before its children. Create each
        // directory exclusively so aliases cannot merge two subtrees.
        if let Some((path, ())) = restore.create(name, |path| {
            if working_prefix(name) == Some(name.as_str()) {
                storage::ensure_staging_dir(data, path.parent().unwrap())?;
            }
            profile::mkdir(&builder, path)
        })? {
            record_dirs(&mut dirs, &path, data);
        }
    }
    let mut written = Vec::with_capacity(FILE_SYNC_BATCH);
    for (name, entry) in archive
        .files
        .range(WORKING.to_owned()..)
        .take_while(|(name, _)| name.starts_with(WORKING))
    {
        if let Some((_, mut file)) = restore.create(name, |path| {
            profile::create_private_file(path, entry.executable)
        })? {
            entry
                .copy_verified(name, &mut file)
                .map_err(|error| error.to_string())?;
            written.push(file);
            if written.len() == FILE_SYNC_BATCH {
                sync_written_files(&mut written)?;
            }
        }
    }
    sync_written_files(&mut written)?;
    // Never traverse a restored link. All parents and regular files have
    // already been created and validated against the manifest.
    for (name, link) in &manifest.links {
        if restore.omitted(name) {
            continue;
        }
        let mut directory = link.directory;
        let target = match &link.target {
            LinkTarget::Legacy(target) => Some(target.clone()),
            LinkTarget::Native {
                path,
                managed,
                suffix,
            } => {
                let relocated = managed.as_deref().and_then(|name| {
                    let prefix = working_prefix(name)?;
                    let root = paths.get(prefix)?;
                    (!raw).then_some((name, prefix, root))
                });
                if let Some((managed, prefix, root)) = relocated {
                    if suffix.is_none() || managed != prefix {
                        directory |= manifest.directories.contains(managed);
                    }
                    if restore.omitted(managed) {
                        None
                    } else if let Some(suffix) = suffix {
                        restore
                            .encoding
                            .expect("validated link encoding")
                            .link_suffix(suffix)?
                            .map(|suffix| working_path::with_suffix(root, suffix.as_os_str()))
                            .filter(|target| fits_existing_file(target))
                    } else {
                        restore.path(managed)?
                    }
                } else {
                    restore
                        .encoding
                        .expect("validated link encoding")
                        .link(path)?
                }
            }
        };
        let Some(target) = target else {
            restore.omit(name, "link target is unavailable on the destination")?;
            continue;
        };
        if let Some((_, false)) =
            restore.create(name, |path| create_working_link(&target, path, directory))?
        {
            restore.omit(name, "destination does not support creating this symlink")?;
        }
    }
    sync_dirs(dirs)?;
    Ok(restore.diagnostics())
}

fn create_working_link(target: &Path, path: &Path, directory: bool) -> io::Result<bool> {
    profile::check("symlink", path)?;
    #[cfg(unix)]
    let result = {
        let _ = directory;
        std::os::unix::fs::symlink(target, path)
    };
    #[cfg(windows)]
    let result = if directory {
        std::os::windows::fs::symlink_dir(target, path)
    } else {
        std::os::windows::fs::symlink_file(target, path)
    };
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::Unsupported => Ok(false),
        #[cfg(windows)]
        Err(error)
            if error.raw_os_error()
                == Some(windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn remove_working_tree(data: &Path, path: &Path) -> Result<()> {
    safe_parent(path, data)?;
    match profile::remove_dir_all(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn record_dirs(dirs: &mut BTreeSet<PathBuf>, path: &Path, root: &Path) {
    dirs.extend(
        path.ancestors()
            .take_while(|dir| dir.starts_with(root))
            .map(Path::to_owned),
    );
}

fn write_launch_file(
    name: &str,
    entry: &Entry,
    path: &Path,
    root: &Path,
    dirs: &mut BTreeSet<PathBuf>,
    written: &mut Vec<ProfileFile<fs::File>>,
) -> Result<()> {
    let parent = path.parent().ok_or("Missing launch resource parent")?;
    if !dirs.contains(parent) {
        storage::ensure_staging_dir(root, parent).map_err(|error| error.to_string())?;
        record_dirs(dirs, parent, root);
    }
    written.push(write_journaled(path, name, entry)?);
    if written.len() == FILE_SYNC_BATCH {
        sync_written_files(written)?;
    }
    Ok(())
}

fn sync_dirs(dirs: BTreeSet<PathBuf>) -> Result<()> {
    for path in dirs.into_iter().rev() {
        sync_directory(&path)?;
    }
    Ok(())
}
