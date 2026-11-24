//! Local scheduling. Each occurrence is claimed before starting work so a
//! restart cannot submit it twice. The archive Start transaction links the run.
use super::{start::LaunchRequest, *};
use chrono::{Local, TimeZone};
use sqlx::Row;
use std::future::Future;
use timing::{Timing, TimingInput};
use uuid::Uuid;

mod timing;

pub(crate) const SCHEMA_VERSION: i64 = 53;
pub(crate) const SCHEMA_NAME: &str = "053_architect_launch_schedules";

pub(self) fn invalid(code: &str, pointer: &str) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        code,
        pointer,
        "The scheduled launch could not be saved or started",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SchedulePolicy {
    catch_up: bool,
    allow_overlap: bool,
    always_latest: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveSchedule {
    id: Option<String>,
    launch: LaunchRequest,
    timing: Option<TimingInput>,
    policy: SchedulePolicy,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    configuration: LaunchConfiguration,
    start_message: Option<String>,
    launch_values: Option<Value>,
    model_overrides: BTreeMap<String, ModelOverride>,
    folder_binding: Option<String>,
    reuse_folder: bool,
    policy: SchedulePolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schedule {
    id: String,
    version: VersionKey,
    system_label: String,
    latest_number: i64,
    next_at_ms: Option<i64>,
    suspended: bool,
    starting: bool,
    issue_code: Option<String>,
    issue_at_ms: Option<i64>,
    configuration: LaunchConfiguration,
    start_message: Option<String>,
    launch_values: Option<Value>,
    model_overrides: BTreeMap<String, ModelOverride>,
    policy: SchedulePolicy,
}

fn version_for(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<VersionKey> {
    Ok(VersionKey {
        blueprint_id: row.try_get("blueprint_id")?,
        number: row.try_get(column)?,
    })
}

async fn schema_ready(pool: &SqlitePool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?)")
            .bind(SCHEMA_VERSION)
            .fetch_one(pool)
            .await?,
    )
}

pub(crate) async fn list(pool: &SqlitePool) -> Result<Vec<Schedule>> {
    if !schema_ready(pool).await? {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT s.*, b.name,
            (SELECT MAX(number) FROM architect_versions WHERE blueprint_id=s.blueprint_id AND storage_state='archive') AS latest_number
         FROM architect_launch_schedules s JOIN architect_blueprints b ON b.id=s.blueprint_id
         ORDER BY s.next_at_ms IS NULL, s.next_at_ms, b.name, s.id"
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let settings: Settings = serde_json::from_str(row.try_get("settings_json")?)?;
            let version = version_for(&row, "number")?;
            Ok(Schedule {
                id: row.try_get("id")?,
                system_label: row.try_get("name")?,
                latest_number: row
                    .try_get::<Option<i64>, _>("latest_number")?
                    .unwrap_or(version.number),
                version,
                next_at_ms: row.try_get("next_at_ms")?,
                suspended: row.try_get("suspended")?,
                starting: row.try_get::<Option<i64>, _>("inflight_at_ms")?.is_some(),
                issue_code: row.try_get("issue_code")?,
                issue_at_ms: row.try_get("issue_at_ms")?,
                configuration: settings.configuration,
                start_message: settings.start_message,
                launch_values: settings.launch_values,
                model_overrides: settings.model_overrides,
                policy: settings.policy,
            })
        })
        .collect()
}

pub(crate) async fn save(
    manager: &ConfigManager,
    pool: &SqlitePool,
    app_data: &Path,
    input: SaveSchedule,
    now: impl Fn() -> i64,
) -> Result<String> {
    let SaveSchedule {
        id,
        launch,
        timing,
        policy,
    } = input;
    let timing = match (id.is_some(), timing) {
        (false, Some(timing)) => Some(timing.validate(now())?),
        (true, None) => None,
        _ => return Err(invalid("INVALID_SCHEDULE_DATE", "timing")),
    };
    let (preview, permissions, machine) = prepare_with_consent(
        manager,
        pool,
        app_data,
        launch.version,
        Some(launch.configuration),
        launch.model_overrides.clone(),
    )
    .await?;
    if let Some(blocker) = preview.blockers.first() {
        return Err(invalid(blocker.code, &blocker.subject));
    }
    entry::encode_message(
        preview.permissions.entry_point.is_some(),
        preview.start_message_required,
        preview.launch_fields.as_ref(),
        launch.start_message.as_deref(),
        launch.launch_values.as_ref(),
    )?;
    if let Some(secret) = preview.secrets.iter().find(|secret| !secret.stored) {
        return Err(invalid("MCP_SECRETS_UNAVAILABLE", &secret.server));
    }
    if preview.consent_token.is_some() && preview.consent_token != launch.consent_token {
        return Err(invalid("CONSENT_REQUIRED", "permissions"));
    }
    if preview.folder_reuse_token.is_some()
        && preview.folder_reuse_token != launch.folder_reuse_token
    {
        return Err(invalid("WORKING_FOLDER_IN_USE", "workingFolder"));
    }
    let folder_binding = preview
        .configuration
        .working_folder
        .as_deref()
        .map(|folder| {
            folder_reuse_token(&start::scope_for(
                folder,
                &owner(&preview.version.blueprint_id),
            )?)
        })
        .transpose()?;
    if let Some(confirmed) = &launch.folder_reuse_token {
        if Some(confirmed) != folder_binding.as_ref() {
            return Err(invalid("WORKING_FOLDER_CHANGED", "workingFolder"));
        }
    }
    let settings = Settings {
        configuration: preview.configuration,
        start_message: launch.start_message,
        launch_values: launch.launch_values,
        model_overrides: launch.model_overrides,
        reuse_folder: policy.allow_overlap || launch.folder_reuse_token.is_some(),
        folder_binding,
        policy,
    };

    let mut db = pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(timing) = &timing {
        if timing.first_at_ms <= now() {
            return Err(invalid("INVALID_SCHEDULE_DATE", "firstAtMs"));
        }
    }
    let key = &preview.version;
    let id = persist(&mut db, id, key, &settings, timing).await?;
    // Keep inherited consent on this version even if the older version is removed.
    record_consent(
        &mut db,
        key,
        &machine,
        &permissions,
        preview.consent_token.is_some(),
    )
    .await?;
    db.commit().await?;
    Ok(id)
}

async fn persist(
    db: &mut SqliteConnection,
    id: Option<String>,
    key: &VersionKey,
    settings: &Settings,
    timing: Option<Timing>,
) -> Result<String> {
    let settings = serde_json::to_string(settings)?;
    if let Some(id) = id {
        let updated = sqlx::query(
            "UPDATE architect_launch_schedules SET number=?,settings_json=?,issue_code=NULL,issue_at_ms=NULL
             WHERE id=? AND blueprint_id=? AND inflight_at_ms IS NULL"
        ).bind(key.number).bind(settings).bind(&id).bind(&key.blueprint_id)
            .execute(&mut *db).await?.rows_affected();
        if updated == 0 {
            return Err(invalid("SCHEDULE_CHANGED", "id"));
        }
        pin(db, &id, key).await?;
        return Ok(id);
    }
    let timing = timing.ok_or_else(|| invalid("INVALID_SCHEDULE_DATE", "timing"))?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO architect_launch_schedules(id,blueprint_id,number,settings_json,timing_json,next_at_ms)
         VALUES (?,?,?,?,?,?)"
    ).bind(&id).bind(&key.blueprint_id).bind(key.number).bind(settings)
        .bind(serde_json::to_string(&timing)?).bind(timing.first_at_ms).execute(&mut *db).await?;
    pin(db, &id, key).await?;
    Ok(id)
}

async fn pin(db: &mut SqliteConnection, id: &str, key: &VersionKey) -> Result<()> {
    sqlx::query(
        "INSERT INTO architect_version_uses(kind,owner_id,blueprint_id,number) VALUES ('schedule',?,?,?)
         ON CONFLICT(kind,owner_id) DO UPDATE SET number=excluded.number"
    ).bind(id).bind(&key.blueprint_id).bind(key.number).execute(db).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ScheduleAction {
    Suspend,
    Resume,
    Dismiss { at_ms: i64 },
    Delete,
}

pub(crate) async fn act(
    pool: &SqlitePool,
    id: &str,
    action: ScheduleAction,
    now: i64,
) -> Result<()> {
    let mut db = pool.begin_with("BEGIN IMMEDIATE").await?;
    match action {
        ScheduleAction::Delete => {
            sqlx::query("DELETE FROM architect_launch_schedules WHERE id=?")
                .bind(id)
                .execute(&mut *db)
                .await?;
            sqlx::query("DELETE FROM architect_version_uses WHERE kind='schedule' AND owner_id=?")
                .bind(id)
                .execute(&mut *db)
                .await?;
        }
        ScheduleAction::Suspend => {
            sqlx::query("UPDATE architect_launch_schedules SET suspended=1 WHERE id=?")
                .bind(id)
                .execute(&mut *db)
                .await?;
        }
        ScheduleAction::Resume => {
            sqlx::query("UPDATE architect_launch_schedules SET suspended=0,resumed_at_ms=? WHERE id=? AND suspended=1")
                .bind(now).bind(id).execute(&mut *db).await?;
        }
        ScheduleAction::Dismiss { at_ms } => {
            sqlx::query("UPDATE architect_launch_schedules SET issue_code=NULL,issue_at_ms=NULL WHERE id=? AND issue_at_ms=?")
                .bind(id).bind(at_ms).execute(&mut *db).await?;
        }
    }
    db.commit().await?;
    Ok(())
}

pub(crate) struct Occurrence {
    id: String,
    due_at: i64,
    folder_binding: Option<String>,
}

impl Occurrence {
    pub(super) fn check_folder(&self, scope: &Value) -> Result<()> {
        if self.folder_binding.as_deref() != Some(folder_reuse_token(scope)?.as_str()) {
            return Err(invalid("WORKING_FOLDER_CHANGED", "workingFolder"));
        }
        Ok(())
    }

    pub(super) async fn link(
        &self,
        db: &mut SqliteConnection,
        system_id: &str,
        key: &VersionKey,
    ) -> Result<()> {
        let updated = sqlx::query(
            "UPDATE architect_launch_schedules SET number=?
             WHERE id=? AND inflight_at_ms=? AND suspended=0",
        )
        .bind(key.number)
        .bind(&self.id)
        .bind(self.due_at)
        .execute(&mut *db)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(invalid("SCHEDULE_CANCELLED", "id"));
        }
        pin(db, &self.id, key).await?;
        sqlx::query("INSERT INTO architect_launch_schedule_runs(system_id,schedule_id,due_at_ms) VALUES (?,?,?)")
            .bind(system_id).bind(&self.id).bind(self.due_at).execute(db).await?;
        Ok(())
    }
}

async fn has_active_run(db: &mut SqliteConnection, id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1 FROM architect_launch_schedule_runs link
            JOIN engine_flow030_runs run USING(system_id)
            WHERE link.schedule_id=? AND (
                json_extract(run.state_json,'$.verdict') IS NULL OR
                EXISTS(SELECT 1 FROM json_each(run.state_json,'$.activations') WHERE json_extract(value,'$.physical')=1)
            )
        )"
    ).bind(id).fetch_one(db).await?)
}

fn skip_missed(timing: &Timing, due: i64, cutoff: i64) -> Option<i64> {
    // A deadline at the instant Macro became available is still a live deadline.
    timing.due(due, cutoff - 1, &Local).1
}

async fn claim(
    pool: &SqlitePool,
    id: &str,
    now: i64,
    available_since: i64,
) -> Result<Option<(Occurrence, LaunchRequest)>> {
    let mut db = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query(
        "SELECT s.*,
            (SELECT MAX(number) FROM architect_versions WHERE blueprint_id=s.blueprint_id AND storage_state='archive') AS latest_number
         FROM architect_launch_schedules s
         WHERE id=? AND suspended=0 AND inflight_at_ms IS NULL AND next_at_ms<=?"
    )
    .bind(id)
    .bind(now)
    .fetch_optional(&mut *db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let settings: Settings = serde_json::from_str(row.try_get("settings_json")?)?;
    let timing: Timing = serde_json::from_str(row.try_get("timing_json")?)?;
    let mut next = Some(row.try_get::<i64, _>("next_at_ms")?);
    if !settings.policy.catch_up {
        let available_since = row
            .try_get::<Option<i64>, _>("resumed_at_ms")?
            .map_or(available_since, |resumed| resumed.max(available_since));
        if let Some(missed) = next.filter(|due| *due < available_since) {
            next = skip_missed(&timing, missed, available_since);
        }
    }
    let mut occurrence = None;
    let mut issue = None;
    if let Some(due) = next.filter(|due| *due <= now) {
        let (due_at, following) = timing.due(due, now, &Local);
        next = following;
        if !settings.policy.allow_overlap && has_active_run(&mut db, id).await? {
            issue = Some(("SCHEDULE_OVERLAP", due_at));
        } else {
            occurrence = Some(Occurrence {
                id: id.to_owned(),
                due_at,
                folder_binding: settings.folder_binding.clone(),
            });
        }
    }
    sqlx::query(
        "UPDATE architect_launch_schedules SET next_at_ms=?,inflight_at_ms=?,
         issue_code=COALESCE(?,issue_code),issue_at_ms=COALESCE(?,issue_at_ms) WHERE id=?",
    )
    .bind(next)
    .bind(occurrence.as_ref().map(|value| value.due_at))
    .bind(issue.map(|(code, _)| code))
    .bind(issue.map(|(_, at)| at))
    .bind(id)
    .execute(&mut *db)
    .await?;
    db.commit().await?;
    let Some(occurrence) = occurrence else {
        return Ok(None);
    };
    let mut version = version_for(&row, "number")?;
    if settings.policy.always_latest {
        version.number = row
            .try_get::<Option<i64>, _>("latest_number")?
            .unwrap_or(version.number);
    }
    let name = Local
        .timestamp_millis_opt(occurrence.due_at)
        .single()
        .map(|time| time.format("%Y-%m-%d %H:%M %:z").to_string());
    let request = LaunchRequest {
        version,
        name,
        configuration: settings.configuration,
        start_message: settings.start_message,
        launch_values: settings.launch_values,
        model_overrides: settings.model_overrides,
        consent_token: None,
        folder_reuse_token: settings.folder_binding.filter(|_| settings.reuse_folder),
    };
    Ok(Some((occurrence, request)))
}

async fn recover(pool: &SqlitePool) -> Result<()> {
    // Start may have committed just before Macro exited. Its durable run is
    // already visible in Operate after the runtime's own restart recovery.
    let mut db = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "UPDATE architect_launch_schedules AS s SET issue_code='SCHEDULE_INTERRUPTED',issue_at_ms=inflight_at_ms
         WHERE inflight_at_ms IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM architect_launch_schedule_runs link WHERE link.schedule_id=s.id
                 AND link.due_at_ms=s.inflight_at_ms
         )"
    ).execute(&mut *db).await?;
    sqlx::query("UPDATE architect_launch_schedules SET inflight_at_ms=NULL WHERE inflight_at_ms IS NOT NULL")
        .execute(&mut *db).await?;
    db.commit().await?;
    Ok(())
}

async fn tick<F, Fut>(
    pool: &SqlitePool,
    now: i64,
    available_since: i64,
    mut launch: F,
) -> Result<()>
where
    F: FnMut(Occurrence, LaunchRequest) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM architect_launch_schedules
         WHERE suspended=0 AND inflight_at_ms IS NULL AND next_at_ms<=? ORDER BY next_at_ms,id",
    )
    .bind(now)
    .fetch_all(pool)
    .await?;
    for id in ids {
        let Some((occurrence, request)) = claim(pool, &id, now, available_since).await? else {
            continue;
        };
        let due_at = occurrence.due_at;
        let result = launch(occurrence, request).await;
        let issue = result.as_ref().err().map(|error| error.code.as_str());
        settle(pool, &id, due_at, issue).await?;
    }
    Ok(())
}

async fn settle(pool: &SqlitePool, id: &str, due_at: i64, issue: Option<&str>) -> Result<()> {
    let mut db = pool.begin_with("BEGIN IMMEDIATE").await?;
    let restored = sqlx::query(
        "UPDATE architect_launch_schedules AS s SET next_at_ms=inflight_at_ms,inflight_at_ms=NULL
         WHERE id=? AND inflight_at_ms=? AND (? OR suspended=1) AND NOT EXISTS (
            SELECT 1 FROM architect_launch_schedule_runs link
            WHERE link.schedule_id=s.id AND link.due_at_ms=s.inflight_at_ms
         )",
    )
    .bind(id)
    .bind(due_at)
    .bind(issue == Some("SCHEDULE_CANCELLED"))
    .execute(&mut *db)
    .await?;
    if restored.rows_affected() == 0 {
        sqlx::query(
            "UPDATE architect_launch_schedules SET inflight_at_ms=NULL,
             issue_code=COALESCE(?,issue_code),issue_at_ms=COALESCE(?,issue_at_ms)
             WHERE id=? AND inflight_at_ms=?",
        )
        .bind(issue)
        .bind(issue.map(|_| due_at))
        .bind(id)
        .bind(due_at)
        .execute(&mut *db)
        .await?;
    }
    db.commit().await?;
    Ok(())
}

pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn start_worker(app: tauri::AppHandle) {
    use crate::core::db_state::{DbInitializationState, DbPool};
    use tauri::Manager;

    tauri::async_runtime::spawn(async move {
        let db = app.state::<DbPool>();
        let mut generation = String::new();
        let mut recovered = false;
        let mut available_since = now();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let DbInitializationState::Ready(ready) = db.current() else {
                continue;
            };
            let Ok(guard) = db.source_ready(Some(&ready.catalog_generation)).await else {
                continue;
            };
            let pool = &guard.ready.pool;
            if generation != ready.catalog_generation {
                if !generation.is_empty() {
                    available_since = now();
                }
                generation = ready.catalog_generation.clone();
                recovered = false;
            }
            if !recovered {
                match schema_ready(pool).await {
                    Ok(false) => continue,
                    Ok(true) => {}
                    Err(error) => {
                        tracing::warn!(code = %error.code, "Could not check scheduled launch storage");
                        continue;
                    }
                }
                if let Err(error) = recover(pool).await {
                    tracing::warn!(code = %error.code, "Could not recover scheduled launches");
                    continue;
                }
                recovered = true;
            }
            let app = &app;
            let result = tick(
                pool,
                now(),
                available_since,
                |occurrence, request| async move {
                    crate::commands::agsdl_execution::start_archive(
                        app,
                        pool,
                        request,
                        Some(occurrence),
                    )
                    .await
                    .map(|_| ())
                },
            )
            .await;
            if let Err(error) = result {
                tracing::warn!(code = %error.code, "Could not process scheduled launches");
                // Reconcile any claim whose outcome could not be published before the next tick.
                recovered = false;
            }
        }
    });
}

#[cfg(test)]
mod tests;
