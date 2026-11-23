use super::{
    editor_document,
    storage::{Failure, Storage},
    Error,
};
use crate::db::{
    architect_library::{storage_index as index, Document},
    DbResult,
};
use crate::fs::profile::{self, ProfileFile};
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqlitePool};
use std::{
    io::{self, Write},
    path::Path,
};

#[derive(Clone, Copy, Serialize)]
pub(crate) struct Progress {
    pub completed: usize,
    pub total: usize,
}

#[cfg(test)]
pub(crate) async fn startup(pool: &SqlitePool, app_data: &Path) -> DbResult<()> {
    migrate(pool, &Storage::new(app_data)).await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn migrate(pool: &SqlitePool, storage: &Storage) -> DbResult<()> {
    migrate_with_progress(pool, storage, |_| {}).await
}

#[derive(Deserialize, Serialize)]
struct PlannedRow {
    number: i64,
    revision: i64,
    source_digest: String,
    artifact: index::Artifact,
    original: index::Artifact,
}

type RowKey = (String, i64, i64);

async fn legacy_keys(db: &mut sqlx::SqliteConnection) -> DbResult<Vec<RowKey>> {
    Ok(sqlx::query_as(
        "SELECT id,0,revision FROM architect_blueprints
         UNION ALL SELECT blueprint_id,number,revision FROM architect_versions
         ORDER BY 1,2",
    )
    .fetch_all(db)
    .await?)
}

fn read_plan(path: &Path) -> Vec<PlannedRow> {
    let plan = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    plan.unwrap_or_default()
}

fn write_plan(path: &Path, rows: &[PlannedRow]) -> super::Result<()> {
    let parent = path.parent().ok_or(Error::InvalidDestination)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    let mut output = ProfileFile::new(file.as_file_mut(), path);
    serde_json::to_writer(&mut output, rows)?;
    output.flush()?;
    profile::sync_file(file.as_file(), path)?;
    profile::persist(file, path, true)?;
    super::sync_directory(parent)?;
    Ok(())
}

/// Keep the legacy index visible while publishing artifacts. Persist completed
/// blueprints so a crash can resume. The final writer only switches the index.
pub(crate) async fn migrate_with_progress(
    pool: &SqlitePool,
    storage: &Storage,
    progress: impl Fn(Progress) + Send + Sync,
) -> DbResult<()> {
    let _lease = storage.lease(true).await?;
    let mut reader = pool.acquire().await?;
    if index::is_current(&mut reader).await? {
        drop(reader);
        if let Err(error) = storage.discard_migration_plans() {
            tracing::warn!(%error, "Could not discard completed Architect migration plans");
        }
        storage.reclaim_after_commit(pool).await;
        return Ok(());
    }
    let keys = legacy_keys(&mut reader).await?;
    drop(reader);
    let dir = storage.migration_plans()?;
    let mut completed = 0;
    let mut publications = Vec::new();
    let mut keep = std::collections::BTreeSet::new();
    for group in keys.chunk_by(|left, right| left.0 == right.0) {
        let path = dir.join(format!("{:x}.json", Sha256::digest(group[0].0.as_bytes())));
        let rows = read_plan(&path);
        for row in &rows {
            keep.insert(storage.artifact_path(&row.artifact));
            keep.insert(storage.artifact_path(&row.original));
        }
        publications.push((group, path, rows));
    }
    storage.reclaim_except(keep)?;
    progress(Progress {
        completed,
        total: keys.len(),
    });

    let mut planned = Vec::with_capacity(keys.len());
    // Independent blueprints can publish concurrently. Drain the whole batch
    // before returning an error so no publication outlives the storage lease.
    for batch in publications.chunks(8) {
        let results = join_all(batch.iter().map(|(group, path, previous)| {
            prepare_blueprint(pool, storage, group, path, previous)
        }))
        .await;
        for result in results {
            let rows = result?;
            completed += rows.len();
            planned.extend(rows);
            progress(Progress {
                completed,
                total: keys.len(),
            });
        }
    }

    let mut writer = index::durable_writer(pool).await?;
    let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
    if legacy_keys(&mut tx).await? != keys {
        return Err(Error::Storage(
            "Architect library changed during cutover; retry migration".into(),
        )
        .into());
    }
    index::begin_cutover(&mut tx).await?;
    for row in planned {
        index::plan(
            &mut tx,
            row.number,
            row.revision,
            &row.artifact,
            &row.original,
        )
        .await?;
    }
    index::finish_cutover(&mut tx).await?;
    storage.check(Failure::BeforeCommit)?;
    tx.commit().await?;
    drop(writer);
    if let Err(error) = storage.discard_migration_plans() {
        tracing::warn!(%error, "Could not discard completed Architect migration plans");
    }
    storage.reclaim_after_commit(pool).await;
    Ok(())
}

async fn prepare_blueprint(
    pool: &SqlitePool,
    storage: &Storage,
    group: &[RowKey],
    path: &Path,
    previous: &[PlannedRow],
) -> DbResult<Vec<PlannedRow>> {
    let mut rows = Vec::with_capacity(group.len());
    let mut changed = previous.len() != group.len();
    let mut published = Vec::new();
    let publisher = storage.batch_publication();
    for (blueprint, number, revision) in group {
        let query = if *number == 0 {
            sqlx::query_scalar(
                "SELECT CAST(document AS BLOB) FROM architect_blueprints WHERE id=? AND revision=?",
            )
            .bind(blueprint)
            .bind(revision)
        } else {
            sqlx::query_scalar("SELECT CAST(document AS BLOB) FROM architect_versions WHERE blueprint_id=? AND number=? AND revision=?")
                    .bind(blueprint).bind(number).bind(revision)
        };
        let original: Vec<u8> = query.fetch_one(pool).await?;
        let source_digest = format!("{:x}", Sha256::digest(&original));
        if let Some(row) = previous.iter().find(|row| {
            row.number == *number
                && row.revision == *revision
                && row.source_digest == source_digest
                && row.original.blueprint_id == *blueprint
                && row.artifact.blueprint_id == *blueprint
                && storage.artifact_path(&row.original).is_dir()
                && storage.artifact_path(&row.artifact).is_dir()
        }) {
            rows.push(PlannedRow {
                number: *number,
                revision: *revision,
                source_digest,
                artifact: row.artifact.clone(),
                original: row.original.clone(),
            });
        } else {
            let storage = publisher.clone();
            let blueprint = blueprint.clone();
            let is_draft = *number == 0;
            let (artifact, original) = tokio::task::spawn_blocking(move || {
                convert_original(&storage, &blueprint, is_draft, &original)
            })
            .await
            .map_err(io::Error::other)
            .map_err(Error::from)??;
            published.push(rows.len());
            rows.push(PlannedRow {
                number: *number,
                revision: *revision,
                source_digest,
                artifact,
                original,
            });
            changed = true;
        }
    }
    if changed {
        storage.sync_artifact_buckets(published.into_iter().flat_map(|position| {
            let row = &rows[position];
            [&row.artifact, &row.original]
        }))?;
        write_plan(path, &rows)?;
    }
    Ok(rows)
}

/// Publish a historical blueprint discovered after the index cutover.
pub(crate) async fn insert_discovered_blueprint(
    db: &mut sqlx::SqliteConnection,
    storage: &Storage,
    project_id: &str,
    name: &str,
    document: String,
) -> DbResult<String> {
    use sqlx::Row;

    let blueprint = uuid::Uuid::new_v4().to_string();
    let (draft, draft_original, version, version_original) = tokio::task::spawn_blocking({
        let storage = storage.clone();
        let blueprint = blueprint.clone();
        move || -> super::Result<_> {
            let (draft, draft_original) =
                convert_original(&storage, &blueprint, true, document.as_bytes())?;
            let (version, version_original) =
                convert_original(&storage, &blueprint, false, document.as_bytes())?;
            Ok((draft, draft_original, version, version_original))
        }
    })
    .await
    .map_err(io::Error::other)
    .map_err(Error::from)??;
    let row = index::insert_draft(db, project_id, name, &draft, None).await?;
    let revision = row.try_get("revision")?;
    index::freeze(db, revision, None, &version, None).await?;
    // The imported draft is new, so the frozen version is always version 1.
    index::retain_original(db, 0, revision, &draft_original).await?;
    index::retain_original(db, 1, revision, &version_original).await?;
    Ok(blueprint)
}

fn convert_original(
    storage: &Storage,
    blueprint: &str,
    is_draft: bool,
    original: &[u8],
) -> super::Result<(index::Artifact, index::Artifact)> {
    let split = std::str::from_utf8(original)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<Document>(text).map_err(|error| error.to_string()))
        .and_then(editor_document::split);
    let (replacement, diagnostics) = match split {
        Ok(split) => {
            let mut diagnostics = split.authoring.diagnostics.clone();
            let replacement =
                match convert_row(storage, blueprint, is_draft, split, &mut diagnostics) {
                    Ok(replacement) => replacement,
                    Err(error) if permanent_row_error(&error) => {
                        diagnostics.push(error.to_string());
                        None
                    }
                    Err(error) => return Err(error),
                };
            (replacement, diagnostics)
        }
        Err(diagnostic) => (None, vec![diagnostic]),
    };
    let original =
        storage.publish_recovery(blueprint, original, diagnostics, Default::default())?;
    Ok((replacement.unwrap_or_else(|| original.clone()), original))
}

fn convert_row(
    storage: &Storage,
    blueprint: &str,
    is_draft: bool,
    split: editor_document::Split,
    diagnostics: &mut Vec<String>,
) -> super::Result<Option<index::Artifact>> {
    if is_draft && !super::project_editor::fits_inventory(&split.files) {
        diagnostics.push(
            "The migrated project exceeds the editor inventory limit. Download the original envelope, then adapt this draft for repair and restore the resources in a smaller project."
                .into(),
        );
        return Ok(None);
    }
    // Frozen projects can later become drafts through version adaptation.
    let mut draft = storage.stage_split(split, is_draft.then_some(blueprint))?;
    *diagnostics = draft.authoring.diagnostics.clone();
    if is_draft {
        super::project_editor::validate_storage(&draft.root())?;
        return storage.publish_draft(blueprint, draft).map(Some);
    }
    match draft.source.take() {
        Some(source) => storage
            .publish_archive(
                blueprint,
                source,
                &draft.root(),
                &draft.settings,
                &draft.authoring,
            )
            .map(Some),
        None => Ok(None),
    }
}

// A row that cannot be converted keeps its original envelope as its current
// artifact. Operational failures leave the SQLite cutover retryable.
pub(super) fn permanent_row_error(error: &Error) -> bool {
    use zip::result::ZipError;
    match error {
        Error::Io(_) | Error::ProjectIo { .. } | Error::InvalidArchive(ZipError::Io(_)) => false,
        Error::Json(error) => !error.is_io(),
        Error::Agsdl { code, .. } => !matches!(code.as_str(), "STORAGE" | "SOURCE_UNAVAILABLE"),
        Error::UnsupportedSource
        | Error::SymbolicLink(_)
        | Error::ArchiveLimit
        | Error::InvalidArchive(_)
        | Error::DigestMismatch
        | Error::UnexpectedHistory
        | Error::Editor(_)
        | Error::Diagnostic(_)
        | Error::InvalidDestination => true,
        Error::DestinationExists | Error::PublishedNotSynced { .. } | Error::Storage(_) => false,
    }
}
