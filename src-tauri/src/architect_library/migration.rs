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
use std::path::Path;

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
        crate::architect_launch::migrate(&mut tx).await?;
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
                let mut draft = storage.stage_split(split)?;
                let mut diagnostics = draft.authoring.diagnostics.clone();
                let replacement = if number == 0 {
                    Some(storage.publish_draft(&blueprint, draft)?)
                } else if let Some(source) = draft.source.take() {
                    match storage.publish_archive(
                        &blueprint,
                        source,
                        &draft.root(),
                        &draft.settings,
                        &draft.authoring,
                    ) {
                        Ok(archive) => Some(archive),
                        Err(Error::Agsdl { code, message, .. })
                            if (code == "PROJECT" && message.starts_with("archive.json#:"))
                                || code == "INPUT_LIMIT" =>
                        {
                            diagnostics.push(message);
                            None
                        }
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    None
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
    crate::architect_launch::migrate(&mut tx).await?;
    storage.check(Failure::BeforeCommit)?;
    tx.commit().await?;
    drop(writer);
    storage.reclaim_after_commit(pool).await;
    Ok(true)
}
