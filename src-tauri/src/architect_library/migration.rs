use super::{
    editor_document,
    storage::{Failure, Storage},
    Error,
};
use crate::db::{
    architect_library::{storage_index as index, Document},
    DbResult,
};
use sqlx::{Connection, SqlitePool};
use std::{io, path::Path};

// The project editor can open the artifact layout. Keep cutover gated by
// the legacy discovery marker inside migrate().
const ENABLE_CUTOVER: bool = true;

pub(crate) async fn startup(pool: &SqlitePool, app_data: &Path) -> DbResult<()> {
    if ENABLE_CUTOVER || index::is_current(&mut *pool.acquire().await?).await? {
        migrate(pool, &Storage::new(app_data)).await?;
    }
    Ok(())
}

/// The browser is the only source of the last legacy discovery input. A
/// direct upgrade waits for that import's durable marker before switching.
pub(crate) async fn migrate(pool: &SqlitePool, storage: &Storage) -> DbResult<bool> {
    let _lease = storage.lease(true).await?;
    let mut writer = index::durable_writer(pool).await?;
    let mut tx = writer.begin_with("BEGIN IMMEDIATE").await?;
    if index::is_current(&mut tx).await? {
        tx.commit().await?;
        drop(writer);
        storage.reclaim_after_commit(pool).await;
        return Ok(true);
    }
    let imported: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM architect_legacy_import WHERE singleton=1)",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !imported {
        return Ok(false);
    }
    // Interrupted publications are unreachable while the old index is active.
    // Free that space first so an earlier disk-full error can be retried.
    storage.reclaim(pool).await?;
    index::begin_cutover(&mut tx).await?;
    let keys: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT id,0,revision FROM architect_blueprints
         UNION ALL SELECT blueprint_id,number,revision FROM architect_versions
         ORDER BY 1,2",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (blueprint, number, revision) in keys {
        let original: String = if number == 0 {
            sqlx::query_scalar("SELECT document FROM architect_blueprints WHERE id=?")
                .bind(&blueprint)
                .fetch_one(&mut *tx)
                .await?
        } else {
            sqlx::query_scalar(
                "SELECT document FROM architect_versions WHERE blueprint_id=? AND number=?",
            )
            .bind(&blueprint)
            .bind(number)
            .fetch_one(&mut *tx)
            .await?
        };
        let split = serde_json::from_str::<Document>(&original)
            .map_err(|error| error.to_string())
            .and_then(editor_document::split);
        let (replacement, diagnostics) = match split {
            Ok(split) => {
                let mut diagnostics = split.authoring.diagnostics.clone();
                let replacement =
                    match convert_row(storage, &blueprint, number == 0, split, &mut diagnostics) {
                        Ok(replacement) => replacement,
                        Err(error) if permanent_row_error(&error) => {
                            diagnostics.push(error.to_string());
                            None
                        }
                        Err(error) => return Err(error.into()),
                    };
                (replacement, diagnostics)
            }
            Err(diagnostic) => (None, vec![diagnostic]),
        };
        let original = storage.publish_recovery(
            &blueprint,
            original.as_bytes(),
            diagnostics,
            Default::default(),
        )?;
        index::plan(
            &mut tx,
            number,
            revision,
            replacement.as_ref().unwrap_or(&original),
            &original,
        )
        .await?;
    }
    index::finish_cutover(&mut tx).await?;
    storage.check(Failure::BeforeCommit)?;
    tx.commit().await?;
    drop(writer);
    storage.reclaim_after_commit(pool).await;
    Ok(true)
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
fn permanent_row_error(error: &Error) -> bool {
    use zip::result::ZipError;
    match error {
        Error::Io(source) => permanent_path_error(source),
        Error::ProjectIo { source, .. } => {
            permanent_path_error(source)
                || matches!(
                    source.kind(),
                    io::ErrorKind::AlreadyExists
                        | io::ErrorKind::IsADirectory
                        | io::ErrorKind::NotADirectory
                )
        }
        Error::InvalidArchive(ZipError::Io(source)) => permanent_path_error(source),
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

fn permanent_path_error(error: &io::Error) -> bool {
    #[cfg(unix)]
    let invalid = matches!(error.raw_os_error(), Some(libc::ENAMETOOLONG));
    #[cfg(windows)]
    let invalid = {
        use windows_sys::Win32::Foundation::{ERROR_FILENAME_EXCED_RANGE, ERROR_INVALID_NAME};
        error.raw_os_error().is_some_and(|code| {
            matches!(code as u32, ERROR_FILENAME_EXCED_RANGE | ERROR_INVALID_NAME)
        })
    };
    invalid
}
