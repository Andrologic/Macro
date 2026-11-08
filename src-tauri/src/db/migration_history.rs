//! Published migration identities, including the two incompatible version-10 branches.
use super::*;

const LEDGER_SCHEMA: &str = "CREATE TABLE migration_identity_history (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(version,name))";

async fn validate_ledger(c: &mut SqliteConnection) -> DbResult<()> {
    let ddl: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='migration_identity_history'",
    )
    .fetch_optional(&mut *c)
    .await?;
    let objects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE tbl_name='migration_identity_history' COLLATE NOCASE AND sql IS NOT NULL")
        .fetch_one(&mut *c).await?;
    if ddl.as_deref() != Some(LEDGER_SCHEMA) || objects != 1 {
        return Err(DbError::Migration(
            "Invalid migration identity ledger schema".into(),
        ));
    }
    Ok(())
}

pub(crate) const NAMES: &[&str] = &[
    "001_initial",
    "002_disable_unconfigured_default_providers",
    "003_agent_runs",
    "004_message_search",
    "005_runtime_schema",
    "006_generation_attempts",
    "007_tool_invocations",
    "008_agent_run_transitions",
    "009_conversation_goals",
    "010_pilot_tool_trace_revisions",
    "011_conversation_management",
    "012_pilot_files",
    "013_conversation_content_versions",
    "014_conversation_catalog_version",
    "015_inactive_storage",
    "016_source_capture",
    "017_chat_admission",
    "018_connect_transfer",
    "019_connect_publication",
    "020_tool_results",
    "021_agsdl_execution",
    "022_execution_host",
    "023_execution_ui_intents",
    "024_execution_process_receipts",
    "025_visible_message_search",
    "026_execution_native_operations",
    "027_execution_work_protocol",
    "028_execution_work_admission",
    "029_execution_human_public",
    "030_execution_flow",
    "031_execution_start_entry",
    "032_execution_ui_intent_start030",
    "033_execution_flow_owner030",
];

pub(crate) fn destinations(version: i64, name: &str) -> DbResult<Vec<i64>> {
    if version > 0 && NAMES.get((version - 1) as usize) == Some(&name) {
        return Ok(vec![version]);
    }
    let versions = match (version, name) {
        (5, "005_pilot_tool_trace_revisions") => vec![5, 10],
        (6, "006_pilot_tool_trace_revisions") => vec![10],
        (7, "007_conversation_management") => vec![11],
        (10, "010_tool_results") => vec![20],
        (10, "010_visible_message_search") => vec![25],
        (11, "011_agsdl_execution") => vec![21],
        (12, "012_execution_host") => vec![22],
        (13, "013_execution_ui_intents") => vec![23],
        (14, "014_execution_process_receipts") => vec![24],
        (15, "015_parallel_v10_reconciliation") => vec![20, 25],
        (16, "016_execution_native_operations") => vec![26],
        (17, "017_execution_work_protocol") => vec![27],
        (18, "018_execution_work_admission") => vec![28],
        _ => {
            return Err(DbError::Migration(format!(
                "Unknown migration identity {version}/{name}; database left unchanged"
            )))
        }
    };
    Ok(versions)
}

/// Inspect without modifying the source, also used by archive validation.
pub(crate) async fn canonical_versions(c: &mut SqliteConnection) -> DbResult<Vec<i64>> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT version,name FROM schema_migrations ORDER BY version")
            .fetch_all(&mut *c)
            .await?;
    let mut versions = HashSet::new();
    for (v, n) in &rows {
        versions.extend(destinations(*v, n)?);
    }
    validate_migration_history(&versions)?;
    // AgSDL was published after the shared v9 baseline. Visible search could
    // occupy v10 while the engine existed at v11, before reconciliation v15.
    if versions.iter().any(|v| *v >= 20) && !versions.contains(&9)
        || versions.contains(&21) && !(versions.contains(&20) || versions.contains(&25))
        || versions.contains(&22) && !versions.contains(&21)
        || versions.contains(&23) && !versions.contains(&22)
        || versions.contains(&24) && !versions.contains(&23)
        || versions.contains(&26) && !(versions.contains(&24) && versions.contains(&25))
        || versions.contains(&27) && !versions.contains(&26)
        || versions.contains(&28) && !versions.contains(&27)
        || versions.contains(&29) && !versions.contains(&28)
        || versions.contains(&30) && !versions.contains(&29)
        || versions.contains(&31) && !versions.contains(&30)
        || versions.contains(&32) && !versions.contains(&31)
        || versions.contains(&33) && !versions.contains(&32)
    {
        return Err(DbError::Migration(
            "Inconsistent AgSDL migration history".into(),
        ));
    }
    let mut versions: Vec<_> = versions.into_iter().collect();
    versions.sort_unstable();
    Ok(versions)
}

pub(super) async fn normalize(c: &mut SqliteConnection) -> DbResult<()> {
    canonical_versions(c).await?;
    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT version,name,applied_at FROM schema_migrations ORDER BY version")
            .fetch_all(&mut *c)
            .await?;
    if !table_exists(c, "migration_identity_history".into()).await? {
        sqlx::raw_sql(LEDGER_SCHEMA).execute(&mut *c).await?;
    }
    validate_ledger(c).await?;
    for (v, n, date) in &rows {
        let targets = destinations(*v, n)?;
        if targets != [*v] || NAMES[(*v - 1) as usize] != n {
            sqlx::query("INSERT INTO migration_identity_history VALUES (?,?,?) ON CONFLICT(version,name) DO NOTHING")
                .bind(v)
                .bind(n)
                .bind(date)
                .execute(&mut *c)
                .await?;
            let saved: String = sqlx::query_scalar(
                "SELECT applied_at FROM migration_identity_history WHERE version=? AND name=?",
            )
            .bind(v)
            .bind(n)
            .fetch_one(&mut *c)
            .await?;
            if &saved != date {
                return Err(DbError::Migration(
                    "Conflicting migration identity ledger timestamp".into(),
                ));
            }
            if *v != 5 {
                sqlx::query("DELETE FROM schema_migrations WHERE version=?")
                    .bind(v)
                    .execute(&mut *c)
                    .await?;
            }
        }
    }
    for (v, n, date) in &rows {
        for target in destinations(*v, n)? {
            if *v == 5 && n == "005_pilot_tool_trace_revisions" && target == 5 {
                continue;
            }
            // The reconciliation stamp proves both schemas were installed; it
            // does not replace an earlier tool-results stamp or its timestamp.
            sqlx::query("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)")
                .bind(target)
                .bind(NAMES[(target - 1) as usize])
                .bind(date)
                .execute(&mut *c)
                .await?;
        }
    }
    Ok(())
}

/// Prune a disposable reference only, never an archive or live database.
pub(crate) async fn remove_reference_schema(
    c: &mut SqliteConnection,
    versions: &[i64],
) -> DbResult<()> {
    // This connection is a disposable, empty reference. Reconstruct the
    // historical definition before removing the new foreign-key parent.
    if !versions.contains(&33) {
        sqlx::query("DROP TABLE IF EXISTS engine_flow030_handoffs")
            .execute(&mut *c)
            .await?;
        sqlx::query("DROP TABLE IF EXISTS engine_flow030_owners")
            .execute(&mut *c)
            .await?;
    }
    if !versions.contains(&32) {
        sqlx::query("DROP TABLE engine_ui_intents")
            .execute(&mut *c)
            .await?;
        sqlx::raw_sql(include_str!("migrations/013_execution_ui_intents.sql"))
            .execute(&mut *c)
            .await?;
    }
    if !versions.contains(&31) {
        sqlx::query("DROP TRIGGER IF EXISTS engine_delivery020_reject_030")
            .execute(&mut *c)
            .await?;
        sqlx::query("DROP TRIGGER IF EXISTS engine_start030_record_entry")
            .execute(&mut *c)
            .await?;
        sqlx::query("DROP TABLE IF EXISTS engine_start030_entries")
            .execute(&mut *c)
            .await?;
    }
    if !versions.contains(&30) {
        sqlx::query("DROP TRIGGER IF EXISTS engine_start020_reject_030")
            .execute(&mut *c)
            .await?;
        for table in [
            "engine_start030_requests",
            "engine_flow030_outbox",
            "engine_flow030_events",
            "engine_flow030_runs",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
                .execute(&mut *c)
                .await?;
        }
    }
    if !versions.contains(&29) {
        for table in [
            "engine_human_requests030",
            "engine_human_works030",
            "engine_human_public030",
            "engine_human_public_works030",
            "engine_human_submissions030",
        ] {
            for operation in ["insert", "update", "delete"] {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "DROP TRIGGER {table}_projection_{operation}"
                )))
                .execute(&mut *c)
                .await?;
            }
        }
        for table in [
            "engine_human_submissions030",
            "engine_human_public_works030",
            "engine_human_public030",
            "engine_human_projection030",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE {table}")))
                .execute(&mut *c)
                .await?;
        }
    }
    if !versions.contains(&25) {
        sqlx::raw_sql(
            "DROP TRIGGER messages_search_insert;
             DROP TRIGGER messages_search_delete;
             DROP TRIGGER messages_search_update;
             DROP TRIGGER messages_search_update_insert;
             DROP TABLE message_search;
             DROP VIEW message_search_content;",
        )
        .execute(&mut *c)
        .await?;
        sqlx::raw_sql(include_str!("migrations/004_message_search.sql"))
            .execute(&mut *c)
            .await?;
    }
    for (version, table) in [
        (28, "engine_work_admission030"),
        (27, "engine_human_link_events030"),
        (27, "engine_human_works030"),
        (27, "engine_human_requests030"),
        (27, "engine_work_checks030"),
        (27, "engine_work_events030"),
        (27, "engine_work_protocol030"),
        (26, "engine_native_operations"),
        (24, "engine_effect_processes"),
        (23, "engine_ui_intents"),
    ] {
        if !versions.contains(&version) {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE {table}")))
                .execute(&mut *c)
                .await?;
        }
    }
    if !versions.contains(&22) {
        for statement in [
            "DROP TABLE engine_prepared_terminals",
            "DROP TABLE engine_approvals",
            "DROP TABLE engine_responses",
            "DROP TABLE engine_response_closures",
            "DROP TABLE engine_host_captures",
        ] {
            sqlx::query(statement).execute(&mut *c).await?;
        }
    }
    if !versions.contains(&21) {
        for statement in [
            "DROP TABLE engine_events",
            "DROP TABLE engine_effects",
            "DROP TABLE engine_deliveries",
            "DROP TABLE engine_systems",
        ] {
            sqlx::query(statement).execute(&mut *c).await?;
        }
    }
    if !versions.contains(&20) {
        for statement in [
            "DROP TRIGGER tool_result_requires_completion_insert",
            "DROP TRIGGER tool_result_requires_completion_update",
            "ALTER TABLE tool_invocations DROP COLUMN result_json",
        ] {
            sqlx::query(statement).execute(&mut *c).await?;
        }
    }
    Ok(())
}
