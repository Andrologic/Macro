use super::{
    archive, destination_parent, private_directory, publish_path, sync_directory, sync_publication,
    Error, ImportPreview, Result,
};
use argentic_runtime::source::OpenedSource;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;
use uuid::Uuid;

pub const PROJECT_FORMAT: &str = "agsdl-project-1";
pub const MANIFEST: &str = "agsdl.json";

/// Keep this snapshot behind the short-lived import handle. Later operations
/// use these bytes, even if the original selection changes or disappears.
pub struct ImportCandidate {
    source: OpenedSource,
    archive: Option<archive::VerifiedArchive>,
}

impl ImportCandidate {
    pub fn open(path: &Path) -> Result<Self> {
        let path: std::path::PathBuf = std::path::absolute(path)?.components().collect();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(Error::SymbolicLink(path));
        }
        if metadata.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("agsdl"))
        {
            let (source, archive) = archive::read(&path, None)?;
            return Ok(Self {
                source,
                archive: Some(archive),
            });
        }
        if !metadata.is_dir() {
            if !metadata.is_file() || path.file_name().is_none_or(|name| name != MANIFEST) {
                return Err(Error::UnsupportedSource);
            }
            let parent = path.parent().expect("absolute manifest has a parent");
            if fs::symlink_metadata(parent)?.file_type().is_symlink() {
                return Err(Error::SymbolicLink(parent.into()));
            }
        }
        let source = OpenedSource::open_path(&path)?;
        let _ = members(&source)?;
        Ok(Self {
            source,
            archive: None,
        })
    }

    pub(super) fn is_archive(&self) -> bool {
        self.archive.is_some()
    }

    pub(super) fn retained_bytes(&self) -> Result<u64> {
        let members = members(&self.source)?
            .map(|file| file.bytes.len() as u64)
            .sum::<u64>();
        let archive = self
            .archive
            .as_ref()
            .map(archive::VerifiedArchive::size)
            .transpose()?;
        Ok(members + archive.unwrap_or(0) + self.source.authored_json().len() as u64)
    }

    pub fn source(&self) -> &OpenedSource {
        &self.source
    }

    pub fn preview(&self) -> Result<ImportPreview> {
        let (format, digest, history) = if let Some(archive) = &self.archive {
            (
                archive::ARCHIVE_FORMAT,
                archive.sha256.clone(),
                archive.has_history,
            )
        } else {
            (PROJECT_FORMAT, project_digest(&self.source)?, false)
        };
        super::preview::inspect(&self.source, format, digest, history)
    }

    pub fn stage_version(self, staging_root: &Path) -> Result<archive::StagedVersion> {
        if let Some(archive) = self.archive.filter(|archive| !archive.has_history) {
            drop(self.source);
            return archive::stage_exact(archive, staging_root);
        }
        archive::stage_version(self.source, staging_root)
    }
}

pub(super) fn members(
    source: &OpenedSource,
) -> Result<impl ExactSizeIterator<Item = argentic_runtime::source::SelectedFile<'_>> + '_> {
    source.selected_files().ok_or(Error::UnsupportedSource)
}

fn project_digest(source: &OpenedSource) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(PROJECT_FORMAT.as_bytes());
    for file in members(source)? {
        hash.update((file.path.len() as u64).to_be_bytes());
        hash.update(file.path.as_bytes());
        hash.update(u64::from(file.executable).to_be_bytes());
        hash.update((file.bytes.len() as u64).to_be_bytes());
        hash.update(file.bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Materialize only files selected by Argentic into a private temporary directory.
/// On Windows the staging root must have a suitably private ACL. The caller owns its lifetime and may atomically publish it.
pub fn materialize(source: &OpenedSource, staging_root: &Path) -> Result<TempDir> {
    let files = members(source)?;
    let directory = private_directory(staging_root, ".agsdl-project-")?;
    let root = directory.path();
    let mut directories = BTreeSet::from([root.to_path_buf()]);
    for member in files {
        let path = root.join(member.path);
        let parent = path.parent().expect("selected member has a parent");
        fs::create_dir_all(parent)?;
        directories.extend(
            parent
                .ancestors()
                .take_while(|path| *path != root)
                .map(Path::to_path_buf),
        );
        write_member(&path, member.bytes, member.executable)?;
    }
    #[cfg(windows)]
    write_executable_sidecar(source, root)?;
    for path in directories.iter().rev() {
        sync_directory(path)?;
    }
    Ok(directory)
}

fn write_member(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o700 } else { 0o600 };
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    file.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn write_executable_sidecar(source: &OpenedSource, root: &Path) -> Result<()> {
    let roots: BTreeSet<_> = members(source)?
        .map(|member| {
            member
                .path
                .split('/')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        })
        .collect();
    let executable: Vec<_> = members(source)?
        .filter(|member| member.executable)
        .map(|member| member.path)
        .collect();
    if executable.is_empty() {
        return Ok(());
    }
    let prefix = ".agsdl-executables";
    let mut name = prefix.to_owned();
    let mut suffix = 0;
    while roots.contains(&name) {
        suffix += 1;
        name = format!("{prefix}.{suffix}");
    }
    let sidecar = format!("AgSDL executable paths v1\n{}", executable.join("\n"));
    write_member(&root.join(name), sidecar.as_bytes(), false)
}

/// Export to a new folder alongside a private staging directory on the same
/// volume. An existing destination is never replaced, even on a race.
pub fn export_project(source: &OpenedSource, destination: &Path) -> Result<usize> {
    let parent = destination_parent(destination)?;
    let count = members(source)?.len();
    let staged = materialize(source, parent)?;
    publish_path(staged.path(), destination)?;
    let _ = staged.keep();
    sync_publication(parent, destination)?;
    Ok(count)
}

/// Step B's starter document as a project. With no named components or flow
/// yet, the manifest is the only selected file.
pub fn stage_starter(staging_root: &Path, title: &str) -> Result<TempDir> {
    let directory = private_directory(staging_root, ".agsdl-project-")?;
    let manifest = json!({
        "projectFormat": PROJECT_FORMAT,
        "contract": argentic_core::AGSDL_040,
        "id": format!("system-{}", Uuid::new_v4()),
        "title": title,
        "agents": {},
    });
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    write_member(&directory.path().join(MANIFEST), &bytes, false)?;
    OpenedSource::open_path(directory.path())?;
    sync_directory(directory.path())?;
    Ok(directory)
}
