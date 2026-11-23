use super::{
    archive, destination_parent,
    editor_document::{self, Authoring, MacroSettings},
    private_directory, project, publish_error, sync_directory, Diagnostic, Error, Result,
};
use crate::db::{
    architect_library::{
        self as legacy,
        storage_index::{self as index, Artifact, StorageState},
        Document, Draft, SavedVersion, Version, VersionKey,
    },
    DbError, DbResult,
};
use crate::fs::profile::{self, create_private_file, fits_existing_file};
use argentic_runtime::source::OpenedSource;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

pub(crate) const ROOT: &str = "architect-library";
pub(super) const PROJECT: &str = "project";
pub(crate) const SETTINGS: &str = "macro-settings.json";
pub(crate) const AUTHORING: &str = "authoring.json";
pub(crate) const ORIGINAL: &str = "original-envelope.json";

#[path = "storage_editor.rs"]
pub(crate) mod editor;

#[derive(Clone)]
pub(crate) struct Storage {
    root: PathBuf,
    sync_bucket: bool,
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
            sync_bucket: true,
            #[cfg(test)]
            failure: None,
        }
    }

    pub(super) fn batch_publication(&self) -> Self {
        Self {
            sync_bucket: false,
            ..self.clone()
        }
    }

    pub(super) fn sync_artifact_buckets<'a>(
        &self,
        artifacts: impl Iterator<Item = &'a Artifact>,
    ) -> Result<()> {
        let buckets: BTreeSet<_> = artifacts
            .map(|artifact| self.bucket(&artifact.blueprint_id, artifact.state))
            .collect();
        for bucket in buckets {
            sync_directory(&bucket)?;
        }
        Ok(())
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
            ensure_dir(&root, &root)?;
            let lock = root.join(".lock");
            if fs::symlink_metadata(&lock)
                .is_ok_and(|meta| !meta.is_file() || is_link_or_reparse_point(&meta))
            {
                return Err(Error::Storage("Invalid Architect storage lock".into()));
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let file = options.open(&lock)?;
            if exclusive {
                profile::lock_exclusive(&file, &lock)?;
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
        ensure_dir(&self.root, &dir)?;
        Ok(dir)
    }

    pub(super) fn inspection_staging(&self) -> Result<PathBuf> {
        let dir = self.staging()?.join("inspection");
        ensure_dir(&self.root, &dir)?;
        Ok(dir)
    }

    pub(crate) fn reclaim_inspection_staging(&self) -> Result<()> {
        let dir = self.root.join("staging/inspection");
        match require_dir(&self.root, &dir) {
            Ok(()) => remove_entry(&dir),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    // Called under the exclusive migration lease.
    pub(super) fn migration_plans(&self) -> Result<PathBuf> {
        let dir = self.root.join("migration");
        ensure_dir(&self.root, &dir)?;
        if let Err(error) = reclaim_migration_temps(&dir) {
            tracing::warn!(%error, "Could not remove temporary Architect migration plans");
        }
        Ok(dir)
    }

    pub(super) fn discard_migration_plans(&self) -> Result<()> {
        match remove_entry(&self.root.join("migration")) {
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    pub(crate) fn artifact_path(&self, artifact: &Artifact) -> PathBuf {
        self.bucket(&artifact.blueprint_id, artifact.state)
            .join(artifact.id.to_string())
    }

    fn checked_artifact_path(&self, artifact: &Artifact) -> Result<PathBuf> {
        let path = self.artifact_path(artifact);
        require_dir(&self.root, &path)?;
        Ok(path)
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
        ensure_dir(&self.root, &bucket)?;
        sync_stage_directories(stage.path())?;
        self.check(Failure::BeforePublish)?;
        profile::rename_without_replacement(stage.path(), &bucket.join(id.to_string()))
            .map_err(publish_error)?;
        let _ = stage.keep();
        if self.sync_bucket {
            sync_directory(&bucket)?;
        }
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
        self.publish_staged_version(blueprint_id, stage, settings, &version_authoring)
    }

    fn publish_staged_version(
        &self,
        blueprint_id: &str,
        stage: archive::StagedVersion,
        settings: &MacroSettings,
        authoring: &Authoring,
    ) -> Result<Artifact> {
        sidecars(stage.directory(), settings, authoring)?;
        let bucket = self.bucket(blueprint_id, StorageState::Archive);
        ensure_dir(&self.root, &bucket)?;
        self.check(Failure::BeforePublish)?;
        let published = stage.publish_in(&bucket, self.sync_bucket)?;
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
        executable_paths: BTreeSet<String>,
    ) -> Result<Artifact> {
        let stage = private_directory(&self.staging()?, ".recovery-")?;
        write_file(&stage.path().join(ORIGINAL), envelope)?;
        write_json(&stage.path().join("diagnostics.json"), &diagnostics)?;
        if !executable_paths.is_empty() {
            let mut authoring = Authoring::default();
            authoring.executable_paths = executable_paths;
            write_json(&stage.path().join(AUTHORING), &authoring)?;
        }
        self.publish(stage, blueprint_id, StorageState::Recovery)
    }

    pub(super) fn stage_split(
        &self,
        mut split: editor_document::Split,
        draft_blueprint: Option<&str>,
    ) -> Result<PreparedDraft> {
        let stage = private_directory(&self.staging()?, ".draft-")?;
        let root = stage.path().join(PROJECT);
        let published = draft_blueprint.map(|blueprint| self.draft_root(blueprint));
        for base in std::iter::once(root.as_path()).chain(published.as_deref()) {
            if !fits_existing_file(&base.join(project::MANIFEST)) {
                return Err(Error::Storage(
                    "Architect profile directory exceeds the filesystem path limit".into(),
                ));
            }
            for name in split.paths() {
                check_project_path(base, name)?;
            }
        }
        ensure_staging_dir(stage.path(), &root)?;
        let written: BTreeSet<_> = split.files.keys().cloned().collect();
        for (name, bytes) in split.files {
            write_staged_project_file(&root, &name, &bytes, draft_blueprint.is_some())?;
        }
        let source = match OpenedSource::open_path(&root).map_err(Error::from) {
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
            Err(error)
                if match &error {
                    // A missing annex is repairable. Errors reading any generated
                    // file or other OS failures must leave cutover retryable.
                    Error::ProjectIo { path, source, .. } => {
                        source.kind() != io::ErrorKind::NotFound || written.contains(path)
                    }
                    Error::Agsdl { code, .. } => {
                        matches!(code.as_str(), "STORAGE" | "SOURCE_UNAVAILABLE")
                    }
                    _ => true,
                } =>
            {
                return Err(error)
            }
            Err(error) => {
                split.authoring.diagnostics.push(error.to_string());
                None
            }
        };
        if source.is_none() {
            split.authoring.set_fallback(split.source);
        }
        if draft_blueprint.is_some() {
            sidecars(stage.path(), &split.settings, &split.authoring)?;
        }
        Ok(PreparedDraft {
            stage,
            settings: split.settings,
            authoring: split.authoring,
            source,
            upgraded: split.upgraded,
        })
    }

    fn draft_root(&self, blueprint: &str) -> PathBuf {
        self.bucket(blueprint, StorageState::Draft)
            .join(Uuid::nil().to_string())
            .join(PROJECT)
    }

    fn check_draft_paths(&self, blueprint: &str, root: &Path) -> Result<()> {
        let destination = self.draft_root(blueprint);
        for name in super::project_editor::disk_inventory(root)?.keys() {
            check_project_path(&destination, name)?;
        }
        Ok(())
    }

    fn publish_project_stage(&self, blueprint: &str, stage: TempDir) -> Result<Artifact> {
        self.check_draft_paths(blueprint, &stage.path().join(PROJECT))?;
        self.publish(stage, blueprint, StorageState::Draft)
    }

    pub(super) fn publish_draft(
        &self,
        blueprint: &str,
        prepared: PreparedDraft,
    ) -> Result<Artifact> {
        self.publish_project_stage(blueprint, prepared.stage)
    }

    #[cfg(test)]
    fn publish_editor(
        &self,
        blueprint: &str,
        document: Document,
        executable_paths: BTreeSet<String>,
    ) -> Result<(Artifact, Document, Vec<String>)> {
        match editor_document::split(document.clone()) {
            Ok(mut split) => {
                split.inherit_executables(executable_paths);
                let draft = self.stage_split(split, Some(blueprint))?;
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
                    executable_paths,
                )?;
                Ok((artifact, document, diagnostics))
            }
        }
    }

    fn draft_executables(&self, artifact: &Artifact) -> Result<BTreeSet<String>> {
        Ok(read_authoring(&self.checked_artifact_path(artifact)?)?.executable_paths)
    }

    #[cfg(test)]
    fn read_draft(&self, artifact: &Artifact) -> Result<(Document, Vec<String>)> {
        if artifact.state == StorageState::Recovery {
            let (bytes, diagnostics) = self.read_recovery(artifact)?;
            return Ok((
                recovery_document(&bytes).unwrap_or_else(empty_recovery_document),
                diagnostics,
            ));
        }
        let path = self.checked_artifact_path(artifact)?;
        let (settings, authoring) = read_sidecars(&path)?;
        let root = path.join(PROJECT);
        require_dir(&self.root, &root)?;
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

    fn read_recovery(&self, artifact: &Artifact) -> Result<(Vec<u8>, Vec<String>)> {
        let path = self.checked_artifact_path(artifact)?;
        Ok((
            read_file(&path.join(ORIGINAL))?,
            read_json(&path.join("diagnostics.json"))?,
        ))
    }

    /// The caller holds a lease or is validating a private backup copy.
    pub(crate) fn open_archive(&self, artifact: &Artifact) -> Result<archive::VersionArchive> {
        if artifact.state != StorageState::Archive {
            return Err(Error::Storage("Version needs repair".into()));
        }
        archive::open_version(
            &self
                .checked_artifact_path(artifact)?
                .join(archive::VERSION_FILENAME),
            artifact.sha256.as_deref().ok_or(Error::DigestMismatch)?,
            &self.staging()?,
        )
    }

    pub(crate) fn validate_artifact(
        &self,
        artifact: &Artifact,
        archive_digest: Option<&str>,
    ) -> Result<()> {
        match artifact.state {
            StorageState::Draft => {
                let path = self.checked_artifact_path(artifact)?;
                read_sidecars(&path)?;
                // A working draft may have invalid JSON or missing references.
                super::project_editor::validate_storage(&path.join(PROJECT))?;
            }
            StorageState::Archive => {
                let path = self.checked_artifact_path(artifact)?;
                let (settings, authoring) = read_sidecars(&path)?;
                let source = archive::validate_private_version(
                    &path.join(archive::VERSION_FILENAME),
                    artifact.sha256.as_deref().ok_or(Error::DigestMismatch)?,
                    archive_digest.ok_or(Error::DigestMismatch)?,
                )?;
                authoring.archive_document(&settings, &source)?;
            }
            StorageState::Recovery => {
                let path = self.checked_artifact_path(artifact)?;
                open_regular_file(&path.join(ORIGINAL))?;
                read_json::<Vec<String>>(&path.join("diagnostics.json"))?;
                read_authoring(&path)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
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

    #[cfg(test)]
    pub(crate) async fn get_draft(&self, pool: &SqlitePool, id: String) -> DbResult<Draft> {
        let _lease = self.lease(false).await?;
        let row = index::draft_row(pool, &id).await?;
        let (document, diagnostics) = self.read_draft(&Artifact::from_row(&row, "id")?)?;
        index::draft_view(&row, document, diagnostics)
    }

    #[cfg(test)]
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
            let mut draft = self.stage_split(split, Some(&id))?;
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
            let path = self.checked_artifact_path(&draft)?;
            let (settings, authoring) = read_sidecars(&path)?;
            let root = path.join(PROJECT);
            require_dir(&self.root, &root).map_err(Error::from)?;
            if authoring.has_fallback() || authoring.has_unresolved_resources() {
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

    #[cfg(test)]
    pub(crate) async fn get_version(
        &self,
        pool: &SqlitePool,
        key: VersionKey,
    ) -> DbResult<Version> {
        let _lease = self.lease(false).await?;
        let row = index::version_row(pool, &key).await?;
        let artifact = Artifact::from_row(&row, "blueprint_id")?;
        let (document, diagnostics) = if artifact.state == StorageState::Recovery {
            let (bytes, diagnostics) = self.read_recovery(&artifact)?;
            (
                recovery_document(&bytes).unwrap_or_else(empty_recovery_document),
                diagnostics,
            )
        } else {
            let (settings, authoring) = read_sidecars(&self.checked_artifact_path(&artifact)?)?;
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
            let (envelope, mut diagnostics) = self.read_recovery(&artifact)?;
            let document = recovery_document(&envelope).unwrap_or_else(empty_recovery_document);
            let paths = self.draft_executables(&artifact)?;
            let starter_source = document.source.clone();
            let prepared = match editor_document::split(document) {
                Ok(mut split) if super::project_editor::fits_inventory(&split.files) => {
                    split.inherit_executables(paths.clone());
                    split.authoring.merge_diagnostics(&diagnostics);
                    match self.stage_split(split, Some(&id)) {
                        Ok(prepared) => Some(prepared),
                        Err(error) if super::migration::permanent_row_error(&error) => {
                            diagnostics.push(error.to_string());
                            None
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(_) => None,
                Err(diagnostic) => {
                    diagnostics.push(diagnostic);
                    None
                }
            };
            original =
                Some(self.publish_recovery(&id, &envelope, diagnostics.clone(), paths.clone())?);
            if let Some(prepared) = prepared {
                let projected = prepared.document()?;
                let diagnostics = prepared.authoring.diagnostics.clone();
                let draft = self.publish_draft(&id, prepared)?;
                (draft, projected, diagnostics)
            } else {
                let (draft, projected) =
                    self.publish_repair_starter(&id, &name, starter_source, &diagnostics, paths)?;
                (draft, projected, diagnostics)
            }
        } else {
            let version = self.open_archive(&artifact)?;
            let (settings, authoring) = read_sidecars(&self.checked_artifact_path(&artifact)?)?;
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
            let draft = self.publish_project_stage(&id, stage)?;
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
        let mut original =
            open_regular_file(&self.checked_artifact_path(&artifact)?.join(ORIGINAL))
                .map_err(Error::from)?;
        let parent = destination_parent(destination)?;
        if parent
            .canonicalize()
            .map_err(Error::from)?
            .starts_with(self.root.canonicalize().map_err(Error::from)?)
        {
            return Err(Error::InvalidDestination.into());
        }
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(Error::from)?;
        io::copy(&mut original, file.as_file_mut()).map_err(Error::from)?;
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
        let references = index::artifact_references(&mut *pool.acquire().await?).await?;
        self.reclaim_except(
            references
                .iter()
                .map(|artifact| self.artifact_path(artifact))
                .collect(),
        )?;
        Ok(())
    }

    pub(super) fn reclaim_except(&self, references: BTreeSet<PathBuf>) -> Result<()> {
        self.check(Failure::Reclaim)?;
        let staging = self.staging()?;
        for entry in fs::read_dir(&staging).map_err(Error::from)? {
            let entry = entry.map_err(Error::from)?;
            if [
                ".draft-",
                ".recovery-",
                ".agsdl-version-",
                ".agsdl-project-",
                ".agsdl-archive-",
            ]
            .iter()
            .any(|prefix| entry.file_name().to_string_lossy().starts_with(prefix))
            {
                remove_entry(&entry.path())?;
            }
        }
        let blueprints = self.root.join("blueprints");
        ensure_dir(&self.root, &blueprints).map_err(Error::from)?;
        for blueprint in fs::read_dir(&blueprints).map_err(Error::from)? {
            let blueprint = blueprint.map_err(Error::from)?;
            let metadata = fs::symlink_metadata(blueprint.path()).map_err(Error::from)?;
            if !metadata.is_dir()
                || is_link_or_reparse_point(&metadata)
                || !valid_blueprint_directory(&blueprint.file_name().to_string_lossy())
            {
                continue;
            }
            for bucket in ["drafts", "versions", "recovery"] {
                let directory = blueprint.path().join(bucket);
                match fs::symlink_metadata(&directory) {
                    Ok(metadata) if metadata.is_dir() && !is_link_or_reparse_point(&metadata) => {}
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

pub(crate) fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

// The caller supplies a trusted parent of the managed root. Walk from the
// root, so an existing final directory cannot hide a linked ancestor.
fn walk_directories(root: &Path, path: &Path, create: bool, sync: bool) -> io::Result<()> {
    let invalid = || io::Error::other("Expected Architect storage directory");
    let relative = path.strip_prefix(root).map_err(|_| invalid())?;
    let mut current = root.to_path_buf();
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            let Component::Normal(name) = component else {
                return Err(invalid());
            };
            current.push(name);
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse_point(&metadata) => continue,
            Ok(metadata) if metadata.is_file() => {
                return Err(io::Error::new(
                    io::ErrorKind::NotADirectory,
                    "Expected Architect storage directory",
                ));
            }
            Ok(_) => return Err(invalid()),
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let parent = current.parent().ok_or_else(invalid)?;
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match profile::mkdir(&builder, &current) {
            Ok(()) if sync => sync_directory(parent)?,
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&current)?;
                if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
                    return Err(invalid());
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(crate) fn ensure_dir(root: &Path, path: &Path) -> io::Result<()> {
    walk_directories(root, path, true, true)
}

pub(super) fn require_dir(root: &Path, path: &Path) -> io::Result<()> {
    walk_directories(root, path, false, false)
}

pub(crate) fn ensure_staging_dir(root: &Path, path: &Path) -> io::Result<()> {
    walk_directories(root, path, true, false)
}

pub(super) fn sync_stage_directories(path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            sync_stage_directories(&entry.path())?;
        }
    }
    sync_directory(path)
}

fn reclaim_migration_temps(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().as_encoded_bytes().starts_with(b".tmp") && entry.file_type()?.is_file()
        {
            profile::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link_or_reparse_point(&metadata) {
        return Err(Error::Storage("Invalid Architect reclamation path".into()));
    }
    if metadata.is_dir() {
        profile::remove_dir_all(path)?;
    } else {
        profile::remove_file(path)?;
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
    Ok((settings, read_authoring(path)?))
}

fn read_authoring(path: &Path) -> Result<Authoring> {
    match read_json::<Authoring>(&path.join(AUTHORING)) {
        Ok(mut authoring) => {
            authoring.restore_migration_guards();
            Ok(authoring)
        }
        Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            Ok(Authoring::default())
        }
        result => result,
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&read_file(path)?)?)
}

pub(super) fn recovery_document(bytes: &[u8]) -> Option<Document> {
    let source = std::str::from_utf8(bytes).ok()?;
    Some(serde_json::from_str(source).unwrap_or_else(|_| Document {
        source: source.to_owned(),
        ..empty_recovery_document()
    }))
}

pub(super) fn empty_recovery_document() -> Document {
    Document {
        source: String::new(),
        annexes: Default::default(),
        metadata: Default::default(),
    }
}

pub(super) fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    open_regular_file(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn open_regular_file(path: &Path) -> io::Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || is_link_or_reparse_point(&metadata) {
        return Err(io::Error::other("Expected regular Architect storage file"));
    }
    File::open(path)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_file(path, &serde_json::to_vec(value)?)
}

// Only classify errors from materializing a member inside a new private
// project. The same errors at the library root can require operator repair.
fn invalid_stage_path(path: &Path, error: &io::Error) -> bool {
    if !invalid_path_error(error) {
        return false;
    }
    // A permanent diagnostic needs an observable path conflict or limit.
    // A failed operation by itself does not prove the member is unpublishable.
    match fs::symlink_metadata(path) {
        Ok(_) => error.kind() == io::ErrorKind::AlreadyExists,
        Err(observed) => invalid_path_error(&observed),
    }
}

fn invalid_path_error(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::AlreadyExists | io::ErrorKind::NotADirectory | io::ErrorKind::IsADirectory
    ) {
        return true;
    }
    #[cfg(unix)]
    return error.raw_os_error() == Some(libc::ENAMETOOLONG);
    #[cfg(windows)]
    return matches!(
        error.raw_os_error(),
        Some(code) if code == windows_sys::Win32::Foundation::ERROR_INVALID_NAME as i32
            || code == windows_sys::Win32::Foundation::ERROR_FILENAME_EXCED_RANGE as i32
    );
}

pub(super) fn check_project_path(root: &Path, name: &str) -> Result<()> {
    if !editor_document::portable_path(name) || !fits_existing_file(&root.join(name)) {
        return Err(Error::Diagnostic(Diagnostic {
            code: "PROJECT_PATH".into(),
            file: Some(name.into()),
            pointer: String::new(),
            message: format!(
                "Project file {name:?} exceeds the filesystem path limit or uses an invalid name"
            ),
            source: None,
        }));
    }
    Ok(())
}

pub(super) fn write_project_file(root: &Path, path: &str, bytes: &[u8]) -> Result<()> {
    let mut file = create_project_file(root, path)?;
    Ok(write_project_contents(&mut file, bytes, true)?)
}

fn write_staged_project_file(root: &Path, name: &str, bytes: &[u8], durable: bool) -> Result<()> {
    let mut file = create_project_file(root, name).map_err(|error| match error {
        Error::Io(source) => {
            let invalid_path = invalid_stage_path(&root.join(name), &source);
            staged_member_error(name, source, invalid_path)
        }
        error => error,
    })?;
    write_project_contents(&mut file, bytes, durable)
        .map_err(|source| staged_member_error(name, source, false))
}

fn staged_member_error(name: &str, source: io::Error, invalid_path: bool) -> Error {
    #[cfg(test)]
    let invalid_path = invalid_path
        || source.kind() == io::ErrorKind::StorageFull
            && profile::mutated("classify-disk-full-as-permanent");
    if invalid_path {
        Error::Diagnostic(Diagnostic {
            code: "PROJECT_PATH".into(),
            file: Some(name.into()),
            pointer: String::new(),
            message: format!("Could not materialize project file {name:?}: {source}"),
            source: None,
        })
    } else {
        Error::ProjectIo {
            file: name.into(),
            pointer: String::new(),
            path: name.into(),
            source,
        }
    }
}

fn create_project_file(root: &Path, name: &str) -> Result<profile::ProfileFile<File>> {
    check_project_path(root, name)?;
    let path = root.join(name);
    let parent = path.parent().ok_or(Error::InvalidDestination)?;
    ensure_staging_dir(root, parent)?;
    Ok(create_private_file(&path, false)?)
}

fn write_project_contents(
    file: &mut profile::ProfileFile<File>,
    bytes: &[u8],
    durable: bool,
) -> io::Result<()> {
    file.write_all(bytes)?;
    if durable {
        file.sync_all()?;
    }
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = create_private_file(path, false)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
