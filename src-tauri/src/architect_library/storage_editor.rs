use super::*;
use crate::architect_library::project_editor::{
    self as editor, EditBatch, FileRead, ProjectTarget, ProjectView,
};
use crate::db::architect_library::{Summary, VersionSummary};
use serde_json::{Map, Value};
use sqlx::sqlite::SqliteRow;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftProject {
    #[serde(flatten)]
    pub summary: Summary,
    pub history: Option<Map<String, Value>>,
    pub storage_state: &'static str,
    pub project: ProjectView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionProject {
    #[serde(flatten)]
    pub summary: VersionSummary,
    pub project: ProjectView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedProject {
    pub draft: DraftProject,
    pub version: Option<SavedVersion>,
}

impl Storage {
    pub(crate) fn validate_project_name(name: &str) -> Result<()> {
        if name.trim().is_empty() || name.len() > 1024 {
            return Err(Error::Editor("INVALID_BLUEPRINT_NAME"));
        }
        Ok(())
    }

    fn draft_project_view(&self, row: &SqliteRow, artifact: &Artifact) -> DbResult<DraftProject> {
        let revision = row.try_get("revision")?;
        let path = self.checked_artifact_path(artifact)?;
        let project = match artifact.state {
            StorageState::Draft => {
                let (settings, authoring) = read_sidecars(&path)?;
                ProjectView::folder(&path.join(PROJECT), revision, settings, &authoring)?
            }
            StorageState::Recovery => {
                ProjectView::recovery(revision, read_json(&path.join("diagnostics.json"))?)
            }
            StorageState::Archive => return Err(Error::Editor("INVALID_PROJECT_STORAGE").into()),
        };
        Self::draft_header(row, artifact, project)
    }

    fn draft_header(
        row: &SqliteRow,
        artifact: &Artifact,
        project: ProjectView,
    ) -> DbResult<DraftProject> {
        Ok(DraftProject {
            summary: legacy::summary(row)?,
            history: legacy::history(row)?,
            storage_state: artifact.state.as_str(),
            project,
        })
    }

    pub(crate) async fn open_draft_project(
        &self,
        pool: &SqlitePool,
        id: &str,
    ) -> DbResult<DraftProject> {
        let _lease = self.lease(false).await?;
        let row = index::draft_row(pool, id).await?;
        self.draft_project_view(&row, &Artifact::from_row(&row, "id")?)
    }

    pub(crate) async fn open_version_project(
        &self,
        pool: &SqlitePool,
        key: &VersionKey,
    ) -> DbResult<VersionProject> {
        let _lease = self.lease(false).await?;
        let row = index::version_row(pool, key).await?;
        let artifact = Artifact::from_row(&row, "blueprint_id")?;
        let revision = row.try_get("revision")?;
        let path = self.checked_artifact_path(&artifact)?;
        let project = if artifact.state == StorageState::Recovery {
            ProjectView::recovery(revision, read_json(&path.join("diagnostics.json"))?)
        } else {
            let (settings, _) = read_sidecars(&path)?;
            let version = self.open_archive(&artifact)?;
            ProjectView::archive(version.source(), revision, settings)?
        };
        Ok(VersionProject {
            summary: legacy::version_summary(&row)?,
            project,
        })
    }

    fn check_draft(row: &SqliteRow, revision: i64, editable: bool) -> DbResult<Artifact> {
        if row.try_get::<i64, _>("revision")? != revision {
            return Err(DbError::Validation("stale_revision".into()));
        }
        if editable && row.try_get::<bool, _>("archived")? {
            return Err(DbError::Validation("archived_blueprint".into()));
        }
        let artifact = Artifact::from_row(row, "id")?;
        if artifact.state != StorageState::Draft {
            return Err(Error::Editor("PROJECT_NEEDS_REPAIR").into());
        }
        Ok(artifact)
    }

    pub(crate) async fn read_project_file(
        &self,
        pool: &SqlitePool,
        target: ProjectTarget,
        path: &str,
    ) -> DbResult<FileRead> {
        let _lease = self.lease(false).await?;
        match target {
            ProjectTarget::Draft {
                blueprint_id,
                revision,
            } => {
                let row = index::draft_row(pool, &blueprint_id).await?;
                let artifact =
                    self.checked_artifact_path(&Self::check_draft(&row, revision, false)?)?;
                let (_, authoring) = read_sidecars(&artifact)?;
                let content = editor::read_file(&artifact.join(PROJECT), path, &authoring)?;
                Ok(FileRead { revision, content })
            }
            ProjectTarget::Version { key } => {
                let row = index::version_row(pool, &key).await?;
                let version = self.open_archive(&Artifact::from_row(&row, "blueprint_id")?)?;
                Ok(FileRead {
                    revision: row.try_get("revision")?,
                    content: editor::archive_file(version.source(), path)?,
                })
            }
        }
    }

    pub(crate) async fn edit_project(
        &self,
        pool: &SqlitePool,
        id: &str,
        expected: i64,
        batch: EditBatch,
        save: bool,
    ) -> DbResult<ProjectView> {
        batch.check()?;
        let _lease = self.lease(save).await?;
        let row = index::draft_row(pool, id).await?;
        let current = Self::check_draft(&row, expected, true)?;
        let artifact_path = self.checked_artifact_path(&current)?;
        let (mut settings, mut authoring) = read_sidecars(&artifact_path)?;
        // Validation uses a scoped temporary directory that reclamation does not
        // scan. Its shared lease protects the immutable source being copied.
        let stage = private_directory(&self.staging()?, ".draft-").map_err(Error::from)?;
        let root = stage.path().join(PROJECT);
        editor::copy_project(&artifact_path.join(PROJECT), &root)?;
        let edits_source = batch.has_file_changes();
        let added = batch.apply(&root, &mut settings, &mut authoring)?;
        if edits_source {
            authoring.clear_fallback();
        }
        authoring.record_repair_candidates(added);
        let source = OpenedSource::open_path(&root).map_err(Error::from);
        if let Ok(source) = &source {
            authoring.accept_restored_files(source)?;
        }
        // A dry run also says what will not take part once the version runs. It never blocks.
        let reach = match (&source, save) {
            (Ok(source), false) => Some(super::super::preview::flow_reach(source)?),
            _ => None,
        };
        let mut view = ProjectView::folder_from_source(
            editor::disk_inventory(&root)?,
            expected,
            settings,
            &authoring,
            source,
        )?;
        if !save {
            if view.projection.is_some() {
                view.diagnostics
                    .extend(reach.iter().flat_map(reach_diagnostics));
            }
            return Ok(view);
        }
        sidecars(stage.path(), &view.settings, &authoring)?;
        let published = self.publish_project_stage(id, stage)?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let saved = index::update_draft(&mut tx, expected, &published).await?;
        view.revision = saved.try_get("revision")?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        drop(writer);
        self.reclaim_after_commit(pool).await;
        Ok(view)
    }

    pub(crate) async fn create_project_draft(
        &self,
        pool: &SqlitePool,
        project_id: &str,
        name: &str,
    ) -> DbResult<DraftProject> {
        let _lease = self.lease(true).await?;
        let staging = self.staging()?;
        let source = project::stage_starter(&staging, name)?;
        let (stage, root) = editor::create_stage(&staging, source)?;
        self.insert_project(
            pool,
            project_id,
            name,
            stage,
            &root,
            Authoring::default(),
            None,
        )
        .await
        .map(|result| result.draft)
    }

    async fn insert_project(
        &self,
        pool: &SqlitePool,
        project_id: &str,
        name: &str,
        stage: TempDir,
        root: &Path,
        authoring: Authoring,
        version: Option<archive::StagedVersion>,
    ) -> DbResult<ImportedProject> {
        Self::validate_project_name(name)?;
        let id = Uuid::new_v4().to_string();
        let settings = MacroSettings::default();
        sidecars(stage.path(), &settings, &authoring)?;
        let view = ProjectView::folder(root, 0, settings.clone(), &authoring)?;
        if view.projection.is_none() {
            return Err(self.invalid_projection(view).into());
        }
        let draft = self.publish_project_stage(&id, stage)?;
        let version = version
            .map(|version| self.publish_staged_version(&id, version, &settings, &authoring))
            .transpose()?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let row = index::insert_draft(&mut tx, project_id, name, &draft, None).await?;
        let revision = row.try_get("revision")?;
        let version = if let Some(version) = &version {
            Some(index::freeze(&mut tx, revision, None, version, None).await?)
        } else {
            None
        };
        let draft = Self::draft_header(&row, &draft, ProjectView { revision, ..view })?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        Ok(ImportedProject { draft, version })
    }

    fn invalid_projection(&self, mut view: ProjectView) -> Error {
        Error::Diagnostic(
            view.diagnostics
                .drain(..)
                .next()
                .unwrap_or_else(|| Error::Editor("PROJECT_NEEDS_REPAIR").diagnostic()),
        )
    }

    pub(crate) async fn import_project(
        &self,
        pool: &SqlitePool,
        project_id: &str,
        name: &str,
        candidate: &project::ImportCandidate,
    ) -> DbResult<ImportedProject> {
        Self::validate_project_name(name)?;
        let _lease = self.lease(true).await?;
        let staging = self.staging()?;
        let source = project::materialize(candidate.source(), &staging)?;
        let mut authoring = Authoring::default();
        authoring.executable_paths = project::members(candidate.source())?
            .filter(|file| file.executable)
            .map(|file| file.path.to_owned())
            .collect();
        let (stage, root) = editor::create_stage(&staging, source)?;
        let version = candidate
            .is_archive()
            .then(|| candidate.stage_version(&staging))
            .transpose()?;
        self.insert_project(pool, project_id, name, stage, &root, authoring, version)
            .await
    }

    pub(crate) async fn export_project(
        &self,
        pool: &SqlitePool,
        target: ProjectTarget,
        destination: &Path,
    ) -> DbResult<usize> {
        let _lease = self.lease(false).await?;
        editor::ensure_export_destination(&self.root, destination)?;
        let count = match target {
            ProjectTarget::Draft {
                blueprint_id,
                revision,
            } => {
                let row = index::draft_row(pool, &blueprint_id).await?;
                let path =
                    self.checked_artifact_path(&Self::check_draft(&row, revision, false)?)?;
                let root = path.join(PROJECT);
                require_dir(&self.root, &root).map_err(Error::from)?;
                editor::export_draft(&root, destination, &read_authoring(&path)?)?
            }
            ProjectTarget::Version { key } => {
                let row = index::version_row(pool, &key).await?;
                let version = self.open_archive(&Artifact::from_row(&row, "blueprint_id")?)?;
                project::export_project(version.source(), destination)?
            }
        };
        Ok(count)
    }

    pub(crate) async fn export_version_archive(
        &self,
        pool: &SqlitePool,
        key: &VersionKey,
        destination: &Path,
    ) -> DbResult<()> {
        let _lease = self.lease(false).await?;
        editor::ensure_export_destination(&self.root, destination)?;
        let row = index::version_row(pool, key).await?;
        self.open_archive(&Artifact::from_row(&row, "blueprint_id")?)?
            .export_archive(destination)?;
        Ok(())
    }
}

impl Storage {
    pub(super) fn publish_repair_starter(
        &self,
        id: &str,
        name: &str,
        original_source: String,
        diagnostics: &[String],
        executable_paths: BTreeSet<String>,
    ) -> Result<(Artifact, Document)> {
        let staging = self.staging()?;
        let starter = project::stage_starter(&staging, name)?;
        let (stage, root) = editor::create_stage(&staging, starter)?;
        let mut authoring = Authoring::default();
        authoring.executable_paths = executable_paths;
        authoring.merge_diagnostics(diagnostics);
        if !original_source.is_empty() && original_source.len() <= 8 * editor::TEXT_LIMIT {
            write_project_file(&root, editor::RECOVERY_SOURCE, original_source.as_bytes())?;
        }
        authoring.set_fallback(original_source);
        let settings = MacroSettings::default();
        sidecars(stage.path(), &settings, &authoring)?;
        let source = OpenedSource::open_path(&root)?;
        let projected = authoring.project_document(&settings, &root, Some(&source))?;
        let draft = self.publish_project_stage(id, stage)?;
        Ok((draft, projected))
    }

    pub(crate) async fn adapt_recovery_draft(
        &self,
        pool: &SqlitePool,
        id: &str,
        expected: i64,
        project_id: &str,
        name: &str,
    ) -> DbResult<DraftProject> {
        let _lease = self.lease(true).await?;
        let row = index::draft_row(pool, id).await?;
        let original = Artifact::from_row(&row, "id")?;
        if row.try_get::<i64, _>("revision")? != expected {
            return Err(DbError::Validation("stale_revision".into()));
        }
        if original.state != StorageState::Recovery {
            return Err(Error::Editor("PROJECT_NEEDS_REPAIR").into());
        }
        let (envelope, diagnostics) = self.read_recovery(&original)?;
        let document = recovery_document(&envelope).unwrap_or_else(empty_recovery_document);
        let id = Uuid::new_v4().to_string();
        let paths = self.draft_executables(&original)?;
        let retained = self.publish_recovery(&id, &envelope, diagnostics.clone(), paths.clone())?;
        let (draft, _) =
            self.publish_repair_starter(&id, name, document.source, &diagnostics, paths)?;
        let mut writer = index::durable_writer(pool).await?;
        let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
        let row = index::insert_draft(&mut tx, project_id, name, &draft, None).await?;
        index::retain_original(&mut tx, 0, row.try_get("revision")?, &retained).await?;
        let opened = self.draft_project_view(&row, &draft)?;
        self.check(Failure::BeforeCommit)?;
        tx.commit().await?;
        Ok(opened)
    }

    pub(crate) async fn execution_hidden_agents(
        &self,
        pool: &SqlitePool,
        execution_id: &str,
    ) -> DbResult<Vec<String>> {
        let _lease = self.lease(false).await?;
        let row = sqlx::query(
            "SELECT version.blueprint_id,version.artifact_id,version.storage_state,version.archive_sha256
             FROM architect_version_uses AS use_record
             JOIN architect_versions AS version ON version.blueprint_id=use_record.blueprint_id AND version.number=use_record.number
             WHERE use_record.kind='execution' AND use_record.owner_id=?",
        )
        .bind(execution_id)
        .fetch_optional(pool).await?;
        let Some(row) = row else {
            return Ok(Vec::new());
        };
        let artifact = Artifact::from_row(&row, "blueprint_id")?;
        if artifact.state != StorageState::Archive {
            return Ok(Vec::new());
        }
        let (settings, _) = read_sidecars(&self.checked_artifact_path(&artifact)?)?;
        Ok(settings.hidden_agent_ids)
    }
}

/// Warnings for agents the flow does not reach. One for the whole system when none is reached.
pub(crate) fn reach_diagnostics(reach: &super::super::preview::FlowReach) -> Vec<Diagnostic> {
    let pointer = |id: &str| format!("/agents/{}", id.replace('~', "~0").replace('/', "~1"));
    let warning = |code: &str, pointer: String, message: String| Diagnostic {
        code: code.into(),
        file: None,
        pointer,
        message,
        source: None,
    };
    if reach.declared.is_empty() {
        Vec::new()
    } else if reach.unreached.len() == reach.declared.len() {
        vec![warning(
            "NO_AGENT_REACHED",
            "/flow".into(),
            "No step of the flow hands work to any declared agent".into(),
        )]
    } else {
        reach
            .unreached
            .iter()
            .map(|id| {
                warning(
                    "AGENT_NOT_REACHED",
                    pointer(id),
                    format!("No step of the flow hands work to agent '{id}'"),
                )
            })
            .collect()
    }
}
