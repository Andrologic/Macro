//! One DB-wide logical retention domain shared by native reservation and E.
use sqlx::{Row, SqliteConnection};

pub(super) const DOMAIN_BYTES: i64 = 24;
pub(super) const NATIVE_BUDGET: i64 = 16 * 1024 * 1024;
pub(super) const NATIVE_MAX_RECEIPTS: i64 = 64;

pub(super) async fn retained(db: &mut SqliteConnection) -> Result<i64, String> {
    // SQLite's final + can promote to REAL on overflow. Read independent sums
    // and add with checked native integers instead of accepting a rounded total.
    let totals: (i64,i64,i64,i64,i64,i64,i64,i64,i64,i64,i64,i64) = sqlx::query_as("SELECT COALESCE((SELECT SUM(charge_bytes) FROM e_inactive_imports),0),COALESCE((SELECT SUM(charge_bytes) FROM e_source_captures),0),COALESCE((SELECT SUM(total_bytes) FROM pilot_file_transfers WHERE state IN ('receiving','finalized')),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_transfers),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_exchanges),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_raw_prefix),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_raw_chunks),0),CASE WHEN EXISTS(SELECT 1 FROM e_inactive_domain) THEN 24 ELSE 0 END,COALESCE((SELECT SUM(charge_bytes) FROM connect_preparations),0),COALESCE((SELECT SUM(charge_bytes) FROM conversation_portable_archives),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_activation_receipts),0),COALESCE((SELECT SUM(charge_bytes) FROM connect_local_deletions),0)")
        .fetch_one(db).await.map_err(|_| "database_unavailable".to_string())?;
    [
        totals.0, totals.1, totals.2, totals.3, totals.4, totals.5, totals.6, totals.7, totals.8,
        totals.9, totals.10, totals.11,
    ]
    .into_iter()
    .try_fold(0_i64, |total, bytes| {
        if bytes < 0 {
            return Err("database_unavailable".into());
        }
        total
            .checked_add(bytes)
            .ok_or_else(|| "resource_limit".into())
    })
}

pub(super) async fn admit(db: &mut SqliteConnection, extra: i64) -> Result<(), String> {
    let domain = sqlx::query("SELECT budget_bytes FROM e_inactive_domain WHERE singleton=1")
        .fetch_optional(&mut *db)
        .await
        .map_err(|_| "database_unavailable")?;
    if let Some(row) = domain {
        let total = retained(db).await?;
        let budget: i64 = row
            .try_get("budget_bytes")
            .map_err(|_| "database_unavailable")?;
        if extra < 0 || total.checked_add(extra).ok_or("resource_limit")? > budget {
            return Err("resource_limit".into());
        }
    } else {
        let count = journal_count(db).await?;
        if count != 0 {
            return Err("database_unavailable".into());
        }
    }
    Ok(())
}

pub(super) async fn admit_e(
    db: &mut SqliteConnection,
    extra: i64,
    budget: i64,
    maximum: i64,
) -> Result<(), String> {
    let existing: Option<(i64, i64)> =
        sqlx::query_as("SELECT budget_bytes,max_receipts FROM e_inactive_domain WHERE singleton=1")
            .fetch_optional(&mut *db)
            .await
            .map_err(|_| "database_unavailable")?;
    if let Some(values) = existing {
        if values != (budget, maximum) {
            return Err("policy_conflict".into());
        }
        return admit(db, extra).await;
    }
    let count = journal_count(&mut *db).await?;
    if count != 0 {
        return Err("database_unavailable".into());
    }
    let total = retained(db).await?;
    if extra < 0
        || budget <= 0
        || maximum <= 0
        || total
            .checked_add(extra)
            .and_then(|v| v.checked_add(DOMAIN_BYTES))
            .ok_or("resource_limit")?
            > budget
    {
        return Err("resource_limit".into());
    }
    sqlx::query("INSERT INTO e_inactive_domain VALUES(1,?,?)")
        .bind(budget)
        .bind(maximum)
        .execute(db)
        .await
        .map_err(|_| "database_unavailable")?;
    Ok(())
}

pub(super) async fn journal_count(db: &mut SqliteConnection) -> Result<i64, String> {
    let counts:(i64,i64,i64,i64,i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM e_inactive_imports),(SELECT COUNT(*) FROM e_source_captures),(SELECT COUNT(*) FROM connect_transfers),(SELECT COUNT(*) FROM connect_exchanges),(SELECT COUNT(*) FROM connect_raw_prefix),(SELECT COUNT(*) FROM connect_preparations),(SELECT COUNT(*) FROM conversation_portable_archives),(SELECT COUNT(*) FROM connect_activation_receipts),(SELECT COUNT(*) FROM connect_local_deletions)")
        .fetch_one(db).await.map_err(|_|"database_unavailable".to_string())?;
    [
        counts.0, counts.1, counts.2, counts.3, counts.4, counts.5, counts.6, counts.7, counts.8,
    ]
    .into_iter()
    .try_fold(0_i64, |total, count| {
        total
            .checked_add(count)
            .ok_or_else(|| "resource_limit".into())
    })
}
