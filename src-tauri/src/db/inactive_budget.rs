//! One DB-wide logical retention domain. No budget exists before an E admission.
use sqlx::{Row, SqliteConnection};

pub(super) const DOMAIN_BYTES: i64 = 24;

pub(super) async fn retained(db: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COALESCE((SELECT SUM(charge_bytes) FROM e_inactive_imports),0)+COALESCE((SELECT SUM(total_bytes) FROM pilot_file_transfers WHERE state IN ('receiving','finalized')),0)+CASE WHEN EXISTS(SELECT 1 FROM e_inactive_domain) THEN 24 ELSE 0 END")
        .fetch_one(db).await.map_err(|_| "database_unavailable".into())
}

pub(super) async fn admit(db: &mut SqliteConnection, extra: i64) -> Result<(), String> {
    let domain = sqlx::query("SELECT budget_bytes FROM e_inactive_domain WHERE singleton=1")
        .fetch_optional(&mut *db)
        .await
        .map_err(|_| "database_unavailable")?;
    if let Some(row) = domain {
        let total = retained(db).await?;
        if extra < 0
            || total.checked_add(extra).ok_or("resource_limit")? > row.get::<i64, _>("budget_bytes")
        {
            return Err("resource_limit".into());
        }
    } else {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_imports")
            .fetch_one(db)
            .await
            .map_err(|_| "database_unavailable")?;
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
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_imports")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| "database_unavailable")?;
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
