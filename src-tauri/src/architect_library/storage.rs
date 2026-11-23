use super::{
    archive, destination_parent,
    editor_document::{self, Authoring, MacroSettings},
    private_directory, project, publish_error, sync_directory, Error, Result,
};
use crate::db::{
    architect_library::{
        self as legacy,
        storage_index::{self as index, Artifact, StorageState},
        Document, Draft, SavedVersion, Version, VersionKey,
    },
    DbError, DbResult,
};
use argentic_runtime::source::OpenedSource;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqlitePool};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

pub(crate) const ROOT: &str = "architect-library";
pub(super) const PROJECT: &str = "project";
pub(crate) const SETTINGS: &str = "macro-settings.json";
pub(crate) const AUTHORING: &str = "authoring.json";
pub(crate) const ORIGINAL: &str = "original-envelope.json";

impl From<Error> for DbError {
    fn from(error: Error) -> Self {
        Self::Validation(error.to_string())
    }
}

pub(crate) struct Storage {
    root: PathBuf,
    #[cfg(test)]
    failure: Option<Failure>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    BeforePublish,
    AfterPublish,
    BeforeCommit,
    Reclaim,
}

impl Storage {
    pub(crate) fn new(app_data: &Path) -> Self {
        Self {
            root: app_data.join(ROOT),
            #[cfg(test)]
            failure: None,
        }
    }

    #[cfg(test)]
    pub(super) fn with_failure(mut self, failure: Failure) -> Self {
        self.failure = Some(failure);
        self
    }

    pub(super) fn check(&self, point: Failure) -> Result<()> {
        #[cfg(test)]
        if self.failure == Some(point) {
            return Err(io::Error::other("injected Architect storage failure").into());
        }
        let _ = point;
        Ok(())
    }

    /// A process-independent lease also protects a backup's SQLite snapshot
    /// until all of its referenced files have been read.
    pub(crate) async fn lease(&self, exclusive: bool) -> Result<File> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            ensure_dir(&root)?;
            let lock = root.join(".lock");
            if fs::symlink_metadata(&lock).is_ok_and(|meta| !meta.is_file()) {
                return Err(Error::Storage("Invalid Architect storage lock".into()));
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let file = options.open(lock)?;
            if exclusive {
                fs2::FileExt::lock_exclusive(&file)?;
            } else {
                fs2::FileExt::lock_shared(&file)?;
            }
            Ok(file)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(super) fn staging(&self) -> Result<PathBuf> {
        let dir = self.root.join("staging");
        ensure_dir(&dir)?;
        Ok(dir)
    }

    pub(crate) fn artifact_path(&self, artifact: &Artifact) -> PathBuf {
        self.bucket(&artifact.blueprint_id, artifact.state)
            .join(artifact.id.to_string())
    }

    fn bucket(&self, blueprint: &str, state: StorageState) -> PathBuf {
        let name = match state {
            StorageState::Draft => "drafts",
            StorageState::Archive => "versions",
            StorageState::Recovery => "recovery",
        };
        // In-app IDs are UUIDs. Preserve older/nonstandard SQLite identities
        // without interpreting them as path parts.
        let blueprint = Uuid::parse_str(blueprint)
            .ok()
            .filter(|id| id.to_string() == blueprint)
            .map_or_else(
                || format!("{:x}", Sha256::digest(blueprint)),
                |id| id.to_string(),
            );
        self.root.join("blueprints").join(blueprint).join(name)
    }

    fn publish(&self, stage: TempDir, blueprint_id: &str, state: StorageState) -> Result<Artifact> {
        let id = Uuid::new_v4();
        let bucket = self.bucket(blueprint_id, state);
        ensure_dir(&bucket)?;
        sync_directory(stage.path())?;
        self.check(Failure::BeforePublish)?;
        crate::fs::operations::rename_without_replacement(
            stage.path(),
            &bucket.join(id.to_string()),
        )
        .map_err(publish_error)?;
        let _ = stage.keep();
        sync_directory(&bucket)?;
        sync_directory(&self.staging()?)?;
        self.check(Failure::AfterPublish)?;
        Ok(Artifact {
            blueprint_id: blueprint_id.into(),
            id,
            state,
            sha256: None,
        })
    }

    pub(super) fn publish_archive(
        &self,
        blueprint_id: &str,
        source: OpenedSource,
        root: &Path,
        settings: &MacroSettings,
        authoring: &Authoring,
    ) -> Result<Artifact> {
        let version_authoring = authoring.for_version(root, &source)?;
        let stage = archive::stage_with_executables(
            source,
            &self.staging()?,
            &version_authoring.executable_paths,
        )?;
        sidecars(stage.directory(), settings, &version_authoring)?;
        let bucket = self.bucket(blueprint_id, StorageState::Archive);
        ensure_dir(&bucket)?;
        self.check(Failure::BeforePublish)?;
        let published = stage.publish(&bucket)?;
        sync_directory(&self.staging()?)?;
        self.check(Failure::AfterPublish)?;
        Ok(Artifact {
            blueprint_id: blueprint_id.into(),
            id: published.artifact_id,
            state: StorageState::Archive,
            sha256: Some(published.sha256),
        })
    }

    pub(super) fn publish_recovery(
        &self,
        blueprint_id: &str,
        envelope: &[u8],
        diagnostics: Vec<String>,
    ) -> Result<Artifact> {
        let stage = private_directory(&self.staging()?, ".recovery-")?;
        write_file(&stage.path().join(ORIGINAL), envelope)?;
        write_json(&stage.path().join("diagnostics.json"), &diagnostics)?;
        self.publish(stage, blueprint_id, StorageState::Recovery)
    }

    pub(super) fn stage_split(&self, mut split: editor_document::Split) -> Result<PreparedDraft> {
        let stage = private_directory(&self.staging()?, ".draft-")?;
        let root = stage.path().join(PROJECT);
        ensure_dir(&root)?;
        for (name, bytes) in &split.files {
            write_project_file(&root, name, bytes)?;
        }
        let source = match OpenedSource::open_path(&root) {
            Ok(source) => {
                let reopened = argentic_core::durable_json::value(source.authored_json())?;
                if reopened == split.normalized {
                    split.resources_complete.then_some(source)
                } else {
                    split
                        .authoring
                        .diagnostics
                        .push("Assembled project differs from the converted document".into());
                    None
                }
            }
            Err(error) if matches!(error.code.as_str(), "STORAGE" | "SOURCE_UNAVAILABLE") => {
                return Err(error.into());
            }
            Err(error) => {
                // The reader reports path I/O and invalid project data with
                // the same code. Our own files must still be accessible before
                // we treat a missing authored resource as a draft diagnostic.
                for path in split.files.keys() {
                    File::open(root.join(path))?;
                }
                split.authoring.diagnostics.push(error.message);
                None
            }
        };
        if source.is_none() {
            split.authoring.set_fallback(split.source);
        }
        sidecars(stage.path(), &split.settings, &split.authoring)?;
        Ok(PreparedDraft {
            stage,
            settings: split.settings,
            authoring: split.authoring,
            source,
            upgraded: split.upgraded,
        })
    }

    pub(super) fn publish_draft(
        &self,
        blueprint: &str,
        prepared: PreparedDraft,
    ) -> Result<Artifact> {
        self.publish(prepared.stage, blueprint, StorageState::Draft)
    }

    fn publish_editor(
        &self,
        blueprint: &str,
        document: Document,
        executable_paths: BTreeSet<String>,
    ) -> Result<(Artifact, Document, Vec<String>)> {
        match editor_document::split(document.clone()) {
            Ok(mut split) => {
                split.inherit_executables(executable_paths);
                let draft = self.stage_split(split)?;
                let document = draft.document()?;
                let diagnostics = draft.authoring.diagnostics.clone();
                let artifact = self.publish_draft(blueprint, draft)?;
                Ok((artifact, document, diagnostics))
            }
            Err(diagnostic) => {
                let diagnostics = vec![diagnostic];
                let artifact = self.publish_recovery(
                    blueprint,
                    &serde_json::to_vec(&document)?,
                    diagnostics.clone(),
                )?;
                Ok((artifact, document, diagnostics))
            }
        }
    }

    fn draft_executables(&self, artifact: &Artifact) -> Result<BTreeSet<String>> {
        if artifact.state != StorageState::Draft {
            return Ok(BTreeSet::new());
        }
        let (_, authoring) = read_sidecars(&self.artifact_path(artifact))?;
        Ok(authoring.executable_paths)
    }

    fn read_draft(&self, artifact: &Artifact) -> Result<(Document, Vec<String>)> {
        if artifact.state == StorageState::Recovery {
            return self.read_recovery(artifact);
        }
        let path = self.artifact_path(artifact);
        let (settings, authoring) = read_sidecars(&path)?;
        let root = path.join(PROJECT);
        let source = if authoring.has_fallback() {
            None
        } else {
            Some(OpenedSource::open_path(&root)?)
        };
        Ok((
            authoring.project_document(&settings, &root, source.as_ref())?,
            authoring.diagnostics,
        ))
    }

    fn read_recovery(&self, artifact: &Artifact) -> Result<(Document, Vec<String>)> {
        let path = self.artifact_path(artifact);
        let bytes = read_file(&path.join(ORIGINAL))?;
        let document = serde_json::from_slice(&bytes)
            .or_else(|_| {
                String::from_utf8(bytes).map(|source| Document {
                    source,
                    annexes: Default::default(),
                    metadata: Default::default(),
                })
            })
            .map_err(io::Error::other)?;
        Ok((document, read_json(&path.join("diagnostics.json"))?))
    }

    /// The caller holds a lease or is validating a private backup copy.
    pub(crate) fn open_archive(&self, artifact: &Artifact) -> Result<archive::VersionArchive> {
        if artifact.state != StorageState::Archive {
            return Err(Error::Storage("Version needs repair".into()));
        }
        archive::open_version(
            &self.artifact_path(artifact).join(archive::VERSION_FILENAME),
            artifact.sha256.as_deref().ok_or(Error::DigestMismatch)?,
        )
    }

    pub(crate) fn validate_artifact(&self, artifact: &Artifact) -> Result<()> {
        match artifact.state {
            StorageState::Draft => {
                let manifest = self
                    .artifact_path(artifact)
                    .join(PROJECT)
                    .join(project::MANIFEST);
                let value: serde_json::Value = read_json(&manifest)?;
                if value["projectFormat"] != project::PROJECT_FORMAT {
                    return Err(Error::Storage(
                        "Invalid stored AgSDL project manifest".into(),
                    ));
                }
                self.read_draft(artifact)?;
            }
            StorageState::Archive => {
                let path = self.artifact_path(artifact);
                let (settings, authoring) = read_sidecars(&path)?;
                let version = self.open_archive(artifact)?;
                authoring.archive_document(&settings, version.source())?;
            }
            StorageState::Recovery => {
                self.read_recovery(artifact)?;
            }
        }
        Ok(())
    }

    pub(crate) async fn create(
        &self,
        pool: &SqlitePool,
        project: String,
        name: String,
        document: Document,
    ) -> DbResult<Draft> {
        let _lease = self.lease(true).await?;
        let id = Uuid::new_v4().to_string();
        let (artifact, document, diagnostics) =
            self.publish_editor(&id, document, BTreeSet::new())?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let row = index::insert_draft(&mut tx, &project, &name, &artifact, None).await?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        index::draft_view(&row, document, diagnostics)
    }

    pub(crate) async fn get_draft(&self, pool: &SqlitePool, id: String) -> DbResult<Draft> {
        let _lease = self.lease(false).await?;
        let row = index::draft_row(pool, &id).await?;
        let (document, diagnostics) = self.read_draft(&Artifact::from_row(&row, "id")?)?;
        index::draft_view(&row, document, diagnostics)
    }

    pub(crate) async fn save_draft(
        &self,
        pool: &SqlitePool,
        id: String,
        expected: i64,
        document: Document,
    ) -> DbResult<Draft> {
        let _lease = self.lease(true).await?;
        let row = index::draft_row(pool, &id).await?;
        let current = Artifact::from_row(&row, "id")?;
        let paths = self.draft_executables(&current)?;
        let (artifact, document, diagnostics) = self.publish_editor(&id, document, paths)?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let row = index::update_draft(&mut tx, expected, &artifact).await?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        drop(writer);
        self.reclaim_after_commit(pool).await;
        index::draft_view(&row, document, diagnostics)
    }

    pub(crate) async fn freeze(
        &self,
        pool: &SqlitePool,
        id: String,
        expected: i64,
        note: Option<String>,
        edited: Option<Document>,
    ) -> DbResult<SavedVersion> {
        let _lease = self.lease(true).await?;
        let row = index::draft_row(pool, &id).await?;
        if row.try_get::<bool, _>("archived")? {
            return Err(DbError::Validation("archived_blueprint".into()));
        }
        if row.try_get::<i64, _>("revision")? != expected {
            return Err(DbError::Validation("stale_revision".into()));
        }
        let mut updated = None;
        let mut converted = None;
        let artifact = if let Some(document) = edited {
            let mut split = editor_document::split(document).map_err(DbError::AgsdlUpgrade)?;
            split.inherit_executables(self.draft_executables(&Artifact::from_row(&row, "id")?)?);
            let mut draft = self.stage_split(split)?;
            if draft.upgraded {
                converted = Some(draft.document()?);
            }
            let source = draft.take_valid_source()?;
            let artifact = self.publish_archive(
                &id,
                source,
                &draft.root(),
                &draft.settings,
                &draft.authoring,
            )?;
            updated = Some(self.publish_draft(&id, draft)?);
            artifact
        } else {
            let draft = Artifact::from_row(&row, "id")?;
            if draft.state != StorageState::Draft {
                return Err(DbError::Validation("blueprint_needs_repair".into()));
            }
            let path = self.artifact_path(&draft);
            let (settings, authoring) = read_sidecars(&path)?;
            let root = path.join(PROJECT);
            if authoring.has_fallback() {
                return Err(DbError::AgsdlUpgrade(authoring.diagnostics.join("\n")));
            }
            let source = OpenedSource::open_path(&root).map_err(Error::from)?;
            self.publish_archive(&id, source, &root, &settings, &authoring)?
        };
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let revision = if let Some(updated) = updated {
            index::update_draft(&mut tx, expected, &updated)
                .await?
                .try_get("revision")?
        } else {
            expected
        };
        let saved = index::freeze(&mut tx, revision, note, &artifact, converted).await?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        drop(writer);
        self.reclaim_after_commit(pool).await;
        Ok(saved)
    }

    pub(crate) async fn get_version(
        &self,
        pool: &SqlitePool,
        key: VersionKey,
    ) -> DbResult<Version> {
        let _lease = self.lease(false).await?;
        let row = index::version_row(pool, &key).await?;
        let artifact = Artifact::from_row(&row, "blueprint_id")?;
        let (document, diagnostics) = if artifact.state == StorageState::Recovery {
            self.read_recovery(&artifact)?
        } else {
            let (settings, authoring) = read_sidecars(&self.artifact_path(&artifact))?;
            let version = self.open_archive(&artifact)?;
            (
                authoring.archive_document(&settings, version.source())?,
                authoring.diagnostics,
            )
        };
        index::version_view(&row, document, diagnostics)
    }

    pub(crate) async fn adapt_version(
        &self,
        pool: &SqlitePool,
        key: VersionKey,
        project_id: String,
        name: String,
    ) -> DbResult<Draft> {
        let _lease = self.lease(true).await?;
        let row = index::version_row(pool, &key).await?;
        let artifact = Artifact::from_row(&row, "blueprint_id")?;
        let id = Uuid::new_v4().to_string();
        let mut original = None;
        let (draft, document, diagnostics) = if artifact.state == StorageState::Recovery {
            let (document, diagnostics) = self.read_recovery(&artifact)?;
            let envelope =
                read_file(&self.artifact_path(&artifact).join(ORIGINAL)).map_err(Error::from)?;
            let retained = self.publish_recovery(&id, &envelope, diagnostics.clone())?;
            match editor_document::split(document.clone()) {
                Ok(mut split) => {
                    split.authoring.merge_diagnostics(&diagnostics);
                    let prepared = self.stage_split(split)?;
                    let diagnostics = prepared.authoring.diagnostics.clone();
                    let projected = prepared.document()?;
                    let draft = self.publish_draft(&id, prepared)?;
                    original = Some(retained);
                    (draft, projected, diagnostics)
                }
                Err(_) => (retained, document, diagnostics),
            }
        } else {
            let version = self.open_archive(&artifact)?;
            let (settings, authoring) = read_sidecars(&self.artifact_path(&artifact))?;
            let stage = private_directory(&self.staging()?, ".draft-").map_err(Error::from)?;
            let project = project::materialize(version.source(), stage.path())?;
            let root = stage.path().join(PROJECT);
            fs::rename(project.path(), &root).map_err(Error::from)?;
            let _ = project.keep();
            let mut authoring = authoring.restore_unselected(&root)?;
            authoring.executable_paths = version
                .members()
                .filter(|file| file.executable)
                .map(|file| file.path.to_owned())
                .collect();
            let document = authoring.project_document(&settings, &root, Some(version.source()))?;
            let diagnostics = authoring.diagnostics.clone();
            sidecars(stage.path(), &settings, &authoring)?;
            let draft = self.publish(stage, &id, StorageState::Draft)?;
            (draft, document, diagnostics)
        };
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let row = index::insert_draft(&mut tx, &project_id, &name, &draft, Some(&key)).await?;
        if artifact.state == StorageState::Recovery {
            index::retain_draft_original(
                &mut tx,
                row.try_get("revision")?,
                original.as_ref().unwrap_or(&draft),
            )
            .await?;
        }
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        index::draft_view(&row, document, diagnostics)
    }

    pub(crate) async fn delete_version(&self, pool: &SqlitePool, key: VersionKey) -> DbResult<()> {
        let _lease = self.lease(true).await?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        legacy::delete_version_in(&mut tx, &key).await?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        drop(writer);
        self.reclaim_after_commit(pool).await;
        Ok(())
    }

    pub(crate) async fn export_original(
        &self,
        pool: &SqlitePool,
        blueprint: String,
        revision: i64,
        number: Option<i64>,
        destination: &Path,
    ) -> DbResult<()> {
        let _lease = self.lease(false).await?;
        let artifact = if let Some(artifact) =
            index::original(pool, &blueprint, revision, number.unwrap_or(0)).await?
        {
            artifact
        } else if number.is_none() {
            let row = index::draft_row(pool, &blueprint).await?;
            let artifact = Artifact::from_row(&row, "id")?;
            if row.try_get::<i64, _>("revision")? != revision
                || artifact.state != StorageState::Recovery
            {
                return Err(DbError::Validation("original_envelope_unavailable".into()));
            }
            artifact
        } else {
            return Err(DbError::Validation("original_envelope_unavailable".into()));
        };
        let bytes =
            read_file(&self.artifact_path(&artifact).join(ORIGINAL)).map_err(Error::from)?;
        let parent = destination_parent(destination)?;
        if parent
            .canonicalize()
            .map_err(Error::from)?
            .starts_with(self.root.canonicalize().map_err(Error::from)?)
        {
            return Err(Error::InvalidDestination.into());
        }
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(Error::from)?;
        file.write_all(&bytes).map_err(Error::from)?;
        file.as_file().sync_all().map_err(Error::from)?;
        file.persist_noclobber(destination)
            .map_err(|error| publish_error(error.error))?;
        sync_directory(parent).map_err(Error::from)?;
        Ok(())
    }

    pub(super) async fn reclaim_after_commit(&self, pool: &SqlitePool) {
        if let Err(error) = self.reclaim(pool).await {
            tracing::warn!(%error, "Architect storage reclamation will retry");
        }
    }

    /// Only called under the exclusive lease, when the index is committed.
    pub(super) async fn reclaim(&self, pool: &SqlitePool) -> DbResult<()> {
        self.check(Failure::Reclaim)?;
        let references: BTreeSet<_> = index::artifact_references(&mut *pool.acquire().await?)
            .await?
            .iter()
            .map(|artifact| self.artifact_path(artifact))
            .collect();
        let staging = self.staging()?;
        for entry in fs::read_dir(&staging).map_err(Error::from)? {
            let entry = entry.map_err(Error::from)?;
            if [
                ".draft-",
                ".recovery-",
                ".agsdl-version-",
                ".agsdl-project-",
            ]
            .iter()
            .any(|prefix| entry.file_name().to_string_lossy().starts_with(prefix))
            {
                remove_entry(&entry.path())?;
            }
        }
        let blueprints = self.root.join("blueprints");
        ensure_dir(&blueprints).map_err(Error::from)?;
        for blueprint in fs::read_dir(&blueprints).map_err(Error::from)? {
            let blueprint = blueprint.map_err(Error::from)?;
            if !blueprint.file_type().map_err(Error::from)?.is_dir()
                || !valid_blueprint_directory(&blueprint.file_name().to_string_lossy())
            {
                continue;
            }
            for bucket in ["drafts", "versions", "recovery"] {
                let directory = blueprint.path().join(bucket);
                match fs::symlink_metadata(&directory) {
                    Ok(metadata) if metadata.is_dir() => {}
                    Ok(_) => {
                        return Err(
                            Error::Storage("Invalid Architect artifact directory".into()).into(),
                        )
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(Error::from(error).into()),
                }
                let entries = match fs::read_dir(directory) {
                    Ok(entries) => entries,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(Error::from(error).into()),
                };
                for entry in entries {
                    let entry = entry.map_err(Error::from)?;
                    if canonical_uuid(&entry.file_name().to_string_lossy())
                        && !references.contains(&entry.path())
                    {
                        remove_entry(&entry.path())?;
                    }
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn canonical_uuid(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}

pub(crate) fn valid_blueprint_directory(id: &str) -> bool {
    canonical_uuid(id)
        || (id.len() == 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

pub(super) struct PreparedDraft {
    stage: TempDir,
    pub(super) settings: MacroSettings,
    pub(super) authoring: Authoring,
    pub(super) source: Option<OpenedSource>,
    upgraded: bool,
}

impl PreparedDraft {
    pub(super) fn root(&self) -> PathBuf {
        self.stage.path().join(PROJECT)
    }

    fn document(&self) -> Result<Document> {
        self.authoring
            .project_document(&self.settings, &self.root(), self.source.as_ref())
    }

    fn take_valid_source(&mut self) -> DbResult<OpenedSource> {
        self.source
            .take()
            .ok_or_else(|| DbError::AgsdlUpgrade(self.authoring.diagnostics.join("\n")))
    }
}

pub(crate) fn ensure_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => return Err(io::Error::other("Expected Architect storage directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Invalid Architect storage path"))?;
    ensure_dir(parent)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => ensure_dir(path),
        Err(error) => Err(error),
    }
}

fn remove_entry(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    sync_directory(path.parent().ok_or(Error::InvalidDestination)?)?;
    Ok(())
}

fn sidecars(path: &Path, settings: &MacroSettings, authoring: &Authoring) -> Result<()> {
    write_json(&path.join(SETTINGS), settings)?;
    write_json(&path.join(AUTHORING), authoring)
}

fn read_sidecars(path: &Path) -> Result<(MacroSettings, Authoring)> {
    let settings: MacroSettings = read_json(&path.join(SETTINGS))?;
    settings.check_schema()?;
    let authoring = match read_json(&path.join(AUTHORING)) {
        Ok(authoring) => authoring,
        Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => Authoring::default(),
        Err(error) => return Err(error),
    };
    Ok((settings, authoring))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&read_file(path)?)?)
}

pub(super) fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::other("Expected regular Architect storage file"));
    }
    fs::read(path)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_file(path, &serde_json::to_vec(value)?)
}

pub(super) fn write_project_file(root: &Path, path: &str, bytes: &[u8]) -> Result<()> {
    let path = root.join(path);
    let parent = path.parent().ok_or(Error::InvalidDestination)?;
    ensure_dir(parent)?;
    write_file(&path, bytes)?;
    sync_directory(parent)?;
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
