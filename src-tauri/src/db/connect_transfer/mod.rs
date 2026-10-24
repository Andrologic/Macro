//! Private SQLite prerequisites for F. No transport, attestation, prepared pin or
//! terminal constructor exists here. The storage inputs are not authority.
#![allow(dead_code)]
mod journal;
mod schema;
mod staging;

use super::{preparation_lease::Lease, DbError, DbResult};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};

pub(super) use journal::Reservation;
pub(super) use journal::{reserve_source, LocalReservation};
pub(crate) use schema::remove_reference_schema_in;
pub(super) use schema::validate_schema;
const CONTROL: usize = 98_304;
fn invalid(code: &str) -> DbError {
    DbError::Validation(code.into())
}
fn add(left: i64, right: i64) -> DbResult<i64> {
    left.checked_add(right)
        .ok_or_else(|| invalid("resource_limit"))
}
fn hash(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}
fn control(bytes: &[u8], max: usize) -> DbResult<()> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(invalid("resource_limit"));
    }
    Ok(())
}
fn uuid(value: &str) -> DbResult<()> {
    if uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        != Some(value)
    {
        return Err(invalid("connect_transfer_invalid_identity"));
    }
    Ok(())
}
fn fingerprint<T: Serialize>(value: &T) -> DbResult<(Vec<u8>, i64)> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid("connect_transfer_invalid_input"))?;
    Ok((
        hash(&bytes),
        i64::try_from(bytes.len()).map_err(|_| invalid("resource_limit"))?,
    ))
}
// Logical retained bytes include row headers, text/blob payloads and duplicated
// index keys. Physical page/WAL admission remains the future native owner’s job.
fn charge(payload: i64, indexes: i64, fixed: i64) -> DbResult<i64> {
    add(add(payload, indexes)?, fixed)
}
async fn lease(pool: &SqlitePool) -> DbResult<Lease> {
    let mut lease = Lease::new(pool.acquire().await?);
    sqlx::query("PRAGMA recursive_triggers=ON")
        .execute(&mut *lease)
        .await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *lease)
        .await?;
    Ok(lease)
}
async fn admit(db: &mut SqliteConnection, extra: i64) -> DbResult<()> {
    let domain: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_domain WHERE singleton=1")
            .fetch_one(&mut *db)
            .await?;
    if domain != 1 {
        return Err(invalid("connect_transfer_budget_unconfigured"));
    }
    super::inactive_budget::admit(db, extra)
        .await
        .map_err(|code| invalid(&code))
}

async fn admit_journal(db: &mut SqliteConnection, extra: i64) -> DbResult<()> {
    admit(db, extra).await?;
    let maximum: i64 =
        sqlx::query_scalar("SELECT max_receipts FROM e_inactive_domain WHERE singleton=1")
            .fetch_one(&mut *db)
            .await?;
    let count = super::inactive_budget::journal_count(db)
        .await
        .map_err(|code| invalid(&code))?;
    if count >= maximum {
        return Err(invalid("resource_limit"));
    }
    Ok(())
}
pub(crate) async fn restart_hold(pool: &SqlitePool) -> DbResult<()> {
    use sqlx::Connection;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    hold_in(&mut tx, false).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

pub(super) async fn capture_leased(db: &mut SqliteConnection, id: i64) -> DbResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=?)",
    )
    .bind(id)
    .fetch_one(db)
    .await?
        != 0)
}
pub(super) async fn import_leased(db: &mut SqliteConnection, id: i64) -> DbResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=?)",
    )
    .bind(id)
    .fetch_one(db)
    .await?
        != 0)
}
/// Startup and restore keep accepted work but invalidate its ability to emit.
/// Neither a restart nor this local marker resolves a reservation or its lease.
pub(super) async fn hold_in(db: &mut SqliteConnection, restored: bool) -> DbResult<()> {
    validate_schema(db).await?;
    sqlx::query("UPDATE connect_transfers SET phase='reconciliation_required',restore_hold=MAX(restore_hold,?)")
        .bind(i64::from(restored)).execute(db).await?;
    Ok(())
}
