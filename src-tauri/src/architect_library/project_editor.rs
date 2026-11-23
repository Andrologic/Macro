use super::{
    archive, destination_parent,
    editor_document::{portable_path, Authoring, MacroSettings, Paths},
    private_directory, project, sync_directory, Error, Result,
};
use crate::db::architect_library::VersionKey;
use argentic_runtime::source::OpenedSource;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tempfile::TempDir;

pub(super) const RECOVERY_SOURCE: &str = "legacy-source.json";
pub(crate) const TEXT_LIMIT: usize = 1024 * 1024;
const PROJECT_BYTES: u64 = 256 * 1024 * 1024;
const PROJECT_FILES: usize = 8192;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ProjectTarget {
    Draft { blueprint_id: String, revision: i64 },
    Version { key: VersionKey },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FileChange {
    Write {
        path: String,
        text: String,
        executable: Option<bool>,
    },
    Remove {
        path: String,
    },
}

impl FileChange {
    fn path(&self) -> &str {
        match self {
            Self::Write { path, .. } | Self::Remove { path } => path,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsChange {
    hidden_agent_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "nullable")]
    entry_message_hint: Option<Option<String>>,
}

fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error> {
    Option::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditBatch {
    files: Vec<FileChange>,
    settings: Option<SettingsChange>,
    #[serde(default)]
    discard_migration_files: Vec<String>,
}

impl EditBatch {
    pub(super) fn has_file_changes(&self) -> bool {
        !self.discard_migration_files.is_empty()
            || self.files.iter().any(|file| file.path() != RECOVERY_SOURCE)
    }

    pub(super) fn check(&self) -> Result<()> {
        let mut size = 0usize;
        for change in &self.files {
            check_path(change.path())?;
            size = size.saturating_add(change.path().len() + 1);
            if let FileChange::Write { text, .. } = change {
                if text.contains('\0') {
                    return Err(Error::Editor("OPAQUE_PROJECT_FILE"));
                }
                size = size.saturating_add(text.len());
            }
        }
        if let Some(settings) = &self.settings {
            size = size.saturating_add(serde_json::to_vec(&settings.hidden_agent_ids)?.len());
            size = size.saturating_add(
                settings
                    .entry_message_hint
                    .as_ref()
                    .and_then(|hint| hint.as_ref())
                    .map_or(0, String::len),
            );
        }
        for path in &self.discard_migration_files {
            size = size.saturating_add(path.len() + 1);
        }
        if size > TEXT_LIMIT
            || self.files.len() + self.discard_migration_files.len() > PROJECT_FILES
        {
            return Err(Error::Editor("EDITOR_LIMIT"));
        }
        Ok(())
    }

    pub(super) fn apply(
        self,
        root: &Path,
        settings: &mut MacroSettings,
        authoring: &mut Authoring,
    ) -> Result<BTreeSet<String>> {
        let mut paths = disk_inventory(root)?;
        let mut added = BTreeSet::new();
        let mut inverse_size = 0usize;
        for change in self.files {
            let target = root.join(change.path());
            let inverse_cost = change.path().len()
                + 1
                + paths
                    .get(change.path())
                    .map_or(0, |file| file.size as usize);
            match change {
                FileChange::Write {
                    path,
                    text,
                    executable,
                } => {
                    let previous = paths.get(&path);
                    let executable = executable.unwrap_or_else(|| {
                        previous.is_some_and(|file| {
                            file.executable || authoring.executable_paths.contains(&path)
                        })
                    });
                    if let Some(previous) = previous {
                        match read_disk_file(root, previous)? {
                            ProjectFile::Text { .. } => {}
                            _ => return Err(Error::Editor("OPAQUE_PROJECT_FILE")),
                        }
                    } else {
                        reserve(paths.keys().map(String::as_str).chain([path.as_str()]))?;
                        added.insert(path.clone());
                    }
                    inverse_size = inverse_size.saturating_add(inverse_cost);
                    if inverse_size > TEXT_LIMIT {
                        return Err(Error::Editor("EDITOR_LIMIT"));
                    }
                    if previous.is_some() {
                        fs::remove_file(&target)?;
                    }
                    super::storage::write_project_file(root, &path, text.as_bytes())?;
                    #[cfg(unix)]
                    if executable {
                        use std::os::unix::fs::PermissionsExt;
                        let file = fs::File::open(&target)?;
                        file.set_permissions(fs::Permissions::from_mode(0o700))?;
                        file.sync_all()?;
                    }
                    if executable {
                        authoring.executable_paths.insert(path.clone());
                    } else {
                        authoring.executable_paths.remove(&path);
                    }
                    paths.insert(
                        path.clone(),
                        FileEntry {
                            path,
                            size: text.len() as u64,
                            executable,
                        },
                    );
                }
                FileChange::Remove { path } => {
                    if path == project::MANIFEST {
                        return Err(Error::Editor("MANIFEST_REQUIRED"));
                    }
                    if let Some(file) = paths.remove(&path) {
                        added.remove(&path);
                        if !matches!(read_disk_file(root, &file)?, ProjectFile::Text { .. }) {
                            return Err(Error::Editor("OPAQUE_PROJECT_FILE"));
                        }
                        inverse_size = inverse_size.saturating_add(inverse_cost);
                        if inverse_size > TEXT_LIMIT {
                            return Err(Error::Editor("EDITOR_LIMIT"));
                        }
                        fs::remove_file(&target)?;
                        let mut parent = target.parent().expect("portable path has a parent");
                        while parent != root {
                            match fs::remove_dir(parent) {
                                Ok(()) => parent = parent.parent().expect("inside project root"),
                                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {
                                    break
                                }
                                Err(error) => return Err(error.into()),
                            }
                        }
                        sync_directory(parent)?;
                        authoring.forget_file(&path);
                    }
                }
            }
        }
        check_inventory(&paths)?;
        if let Some(patch) = self.settings {
            let ids = patch
                .hidden_agent_ids
                .as_ref()
                .map(|_| &settings.hidden_agent_ids);
            inverse_size = inverse_size.saturating_add(serde_json::to_vec(&ids)?.len());
            if patch.entry_message_hint.is_some() {
                inverse_size = inverse_size
                    .saturating_add(settings.entry_message_hint.as_ref().map_or(0, String::len));
            }
            if inverse_size > TEXT_LIMIT {
                return Err(Error::Editor("EDITOR_LIMIT"));
            }
            if let Some(ids) = patch.hidden_agent_ids {
                settings.hidden_agent_ids = ids
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
            }
            if let Some(hint) = patch.entry_message_hint {
                settings.entry_message_hint = hint;
            }
        }
        for path in self.discard_migration_files {
            if !authoring.resolve_resource(&path) {
                return Err(Error::Editor("UNKNOWN_MIGRATION_FILE"));
            }
        }
        Ok(added)
    }
}

fn reserve<'a>(paths: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut reserved = Paths::default();
    for path in paths {
        if !reserved.reserve(path) {
            return Err(Error::Editor("PROJECT_PATH_COLLISION"));
        }
    }
    Ok(())
}

fn check_path(path: &str) -> Result<()> {
    if !portable_path(path) {
        return Err(Error::Editor("INVALID_PROJECT_PATH"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub path: String,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ProjectFile {
    Text { file: FileEntry, text: String },
    Binary { file: FileEntry },
    Oversized { file: FileEntry },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRead {
    pub revision: i64,
    pub content: ProjectFile,
}

fn text(bytes: &[u8]) -> Option<&str> {
    std::str::from_utf8(bytes)
        .ok()
        .filter(|text| !text.contains('\0'))
}

pub(super) fn archive_file(source: &OpenedSource, path: &str) -> Result<ProjectFile> {
    check_path(path)?;
    let member = project::members(source)?
        .find(|file| file.path == path)
        .ok_or(Error::Editor("PROJECT_FILE_NOT_FOUND"))?;
    let file = FileEntry {
        path: path.into(),
        size: member.bytes.len() as u64,
        executable: member.executable,
    };
    Ok(match member.bytes {
        bytes if bytes.len() > TEXT_LIMIT => ProjectFile::Oversized { file },
        bytes => match text(bytes) {
            Some(text) => ProjectFile::Text {
                file,
                text: text.into(),
            },
            None => ProjectFile::Binary { file },
        },
    })
}

pub(super) fn read_file(root: &Path, path: &str, authoring: &Authoring) -> Result<ProjectFile> {
    check_path(path)?;
    super::storage::require_dir(root, root)?;
    let mut parent = root.to_path_buf();
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        parent.push(part);
        let meta = match fs::symlink_metadata(&parent) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(Error::Editor("PROJECT_FILE_NOT_FOUND"))
            }
            Err(error) => return Err(error.into()),
        };
        if super::storage::is_link_or_reparse_point(&meta) {
            return Err(Error::Editor("INVALID_PROJECT_PATH"));
        }
        if parts.peek().is_none() && meta.is_file() {
            let mut file = entry(path.into(), &meta);
            file.executable |= authoring.executable_paths.contains(path);
            return read_disk_file(root, &file);
        }
        if !meta.is_dir() {
            break;
        }
    }
    Err(Error::Editor("PROJECT_FILE_NOT_FOUND"))
}

fn read_disk_file(root: &Path, file: &FileEntry) -> Result<ProjectFile> {
    if file.size > TEXT_LIMIT as u64 {
        return Ok(ProjectFile::Oversized { file: file.clone() });
    }
    let mut bytes = Vec::new();
    fs::File::open(root.join(&file.path))?
        .take(TEXT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > TEXT_LIMIT {
        return Ok(ProjectFile::Oversized { file: file.clone() });
    }
    Ok(match text(&bytes) {
        Some(text) => ProjectFile::Text {
            file: file.clone(),
            text: text.into(),
        },
        None => ProjectFile::Binary { file: file.clone() },
    })
}

fn entry(path: String, meta: &fs::Metadata) -> FileEntry {
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    FileEntry {
        path,
        size: meta.len(),
        executable,
    }
}

fn check_inventory(files: &BTreeMap<String, FileEntry>) -> Result<()> {
    if files.len() > PROJECT_FILES
        || files.values().map(|file| file.size).sum::<u64>() > PROJECT_BYTES
    {
        return Err(Error::Editor("PROJECT_LIMIT"));
    }
    Ok(())
}

pub(super) fn fits_inventory(files: &BTreeMap<String, Vec<u8>>) -> bool {
    files.len() <= PROJECT_FILES
        && files.values().map(|file| file.len() as u64).sum::<u64>() <= PROJECT_BYTES
}

pub(super) fn disk_inventory(root: &Path) -> Result<BTreeMap<String, FileEntry>> {
    let mut pending = vec![(root.to_path_buf(), String::new())];
    super::storage::require_dir(root, root)?;
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    let mut entries = 0;
    while let Some((directory, prefix)) = pending.pop() {
        for item in directory.read_dir()? {
            entries += 1;
            if entries > PROJECT_FILES * 64 {
                return Err(Error::Editor("PROJECT_LIMIT"));
            }
            let item = item?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| Error::Editor("INVALID_PROJECT_PATH"))?;
            let path = format!("{prefix}{name}");
            check_path(&path)?;
            let metadata = fs::symlink_metadata(item.path())?;
            if super::storage::is_link_or_reparse_point(&metadata) {
                return Err(Error::Editor("INVALID_PROJECT_PATH"));
            }
            if metadata.is_dir() {
                pending.push((item.path(), format!("{path}/")));
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
                if files.len() == PROJECT_FILES || total > PROJECT_BYTES {
                    return Err(Error::Editor("PROJECT_LIMIT"));
                }
                files.insert(path.clone(), entry(path, &metadata));
            } else {
                return Err(Error::Editor("INVALID_PROJECT_PATH"));
            }
        }
    }
    reserve(files.keys().map(String::as_str))?;
    Ok(files)
}

pub(super) fn validate_storage(root: &Path) -> Result<()> {
    if !disk_inventory(root)?.contains_key(project::MANIFEST) {
        return Err(Error::Editor("MANIFEST_REQUIRED"));
    }
    Ok(())
}

pub(super) fn copy_project(source: &Path, destination: &Path) -> Result<()> {
    let files = disk_inventory(source)?;
    copy_files(source, destination, files.keys())
}

fn copy_files<'a>(
    source: &Path,
    destination: &Path,
    paths: impl Iterator<Item = &'a String>,
) -> Result<()> {
    super::storage::ensure_dir(destination, destination)?;
    for path in paths {
        let target = destination.join(path);
        let parent = target.parent().expect("portable path has a parent");
        super::storage::ensure_dir(destination, parent)?;
        fs::copy(source.join(path), &target)?;
        fs::File::open(&target)?.sync_all()?;
        sync_directory(parent)?;
    }
    Ok(())
}

pub(super) fn export_draft(
    root: &Path,
    destination: &Path,
    authoring: &Authoring,
) -> Result<usize> {
    let files = disk_inventory(root)?;
    if !files.contains_key(project::MANIFEST) {
        return Err(Error::Editor("MANIFEST_REQUIRED"));
    }
    let parent = destination_parent(destination)?;
    let staged = private_directory(parent, ".agsdl-project-")?;
    copy_files(root, staged.path(), files.keys())?;
    #[cfg(windows)]
    project::write_executable_sidecar(
        staged.path(),
        files.values().map(|file| {
            (
                file.path.as_str(),
                file.executable || authoring.executable_paths.contains(&file.path),
            )
        }),
    )?;
    #[cfg(unix)]
    for path in &authoring.executable_paths {
        if files.get(path).is_some_and(|file| !file.executable) {
            use std::os::unix::fs::PermissionsExt;
            let file = fs::File::open(staged.path().join(path))?;
            file.set_permissions(fs::Permissions::from_mode(0o700))?;
            file.sync_all()?;
        }
    }
    project::publish_export(staged, parent, destination)?;
    Ok(files.len())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    pub source: String,
    pub origins: BTreeMap<String, super::preview::Location>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectView {
    pub revision: i64,
    pub files: Vec<FileEntry>,
    pub settings: MacroSettings,
    pub projection: Option<Projection>,
    pub diagnostics: Vec<super::Diagnostic>,
}

fn projection(source: &OpenedSource) -> Result<Projection> {
    let json = argentic_core::durable_json::value(source.authored_json())?;
    let mut origins = BTreeMap::new();
    let mut add_origin = |path: String| {
        if let Some((file, pointer)) = source.component_origin(&path) {
            origins.insert(
                path.clone(),
                super::preview::Location {
                    file: file.to_owned(),
                    pointer: pointer.to_owned(),
                },
            );
        }
    };
    for catalog in [
        "agents",
        "compositions",
        "content",
        "skills",
        "mcpServers",
        "harnesses",
    ] {
        if let Some(items) = json[catalog].as_object() {
            for id in items.keys() {
                let path = format!("/{catalog}/{}", id.replace('~', "~0").replace('/', "~1"));
                if catalog == "agents" {
                    add_origin(format!("{path}/harnessSettings"));
                }
                add_origin(path);
            }
        }
    }
    add_origin("/flow".into());
    Ok(Projection {
        source: source.authored_json().to_owned(),
        origins,
    })
}

impl ProjectView {
    pub(super) fn folder(
        root: &Path,
        revision: i64,
        settings: MacroSettings,
        authoring: &Authoring,
    ) -> Result<Self> {
        let files = disk_inventory(root)?;
        Self::folder_from_source(
            files,
            revision,
            settings,
            authoring,
            OpenedSource::open_path(root).map_err(Error::from),
        )
    }

    pub(super) fn folder_from_source(
        files: BTreeMap<String, FileEntry>,
        revision: i64,
        settings: MacroSettings,
        authoring: &Authoring,
        source: Result<OpenedSource>,
    ) -> Result<Self> {
        let files = files
            .into_values()
            .map(|mut file| {
                file.executable |= authoring.executable_paths.contains(&file.path);
                file
            })
            .collect();
        let (projection, mut diagnostics) = match source {
            Ok(source) => (Some(projection(&source)?), Vec::new()),
            Err(error @ (Error::Agsdl { .. } | Error::ProjectIo { .. })) => {
                (None, vec![error.diagnostic()])
            }
            Err(error) => return Err(error),
        };
        diagnostics.extend(authoring.project_diagnostics());
        Ok(Self {
            revision,
            files,
            settings,
            projection,
            diagnostics,
        })
    }

    pub(super) fn archive(
        source: &OpenedSource,
        revision: i64,
        settings: MacroSettings,
    ) -> Result<Self> {
        let files = project::members(source)?
            .map(|file| FileEntry {
                path: file.path.into(),
                size: file.bytes.len() as u64,
                executable: file.executable,
            })
            .collect();
        Ok(Self {
            revision,
            files,
            settings,
            projection: Some(projection(source)?),
            diagnostics: Vec::new(),
        })
    }

    pub(super) fn recovery(revision: i64, diagnostics: Vec<String>) -> Self {
        Self {
            revision,
            files: Vec::new(),
            settings: MacroSettings::default(),
            projection: None,
            diagnostics: diagnostics
                .into_iter()
                .map(super::Diagnostic::migration)
                .collect(),
        }
    }
}

pub(super) fn ensure_export_destination(root: &Path, destination: &Path) -> Result<()> {
    if destination_parent(destination)?
        .canonicalize()?
        .starts_with(root.canonicalize()?)
    {
        return Err(Error::InvalidDestination);
    }
    Ok(())
}

pub(super) fn create_stage(staging: &Path, source: TempDir) -> Result<(TempDir, PathBuf)> {
    let stage = private_directory(staging, ".draft-")?;
    let project = stage.path().join(super::storage::PROJECT);
    fs::rename(source.path(), &project)?;
    let _ = source.keep();
    Ok((stage, project))
}
