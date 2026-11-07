//! Desktop-owned upload bytes, immutable intents and atomic message association.
//! The local host installs authority bindings; remote payloads cannot grant them.
use super::models::{ConversationCitation, Message};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row, Sqlite, SqlitePool, Transaction};
use std::collections::HashSet;

type Result<T> = std::result::Result<T, String>;
type Tx<'a> = Transaction<'a, Sqlite>;
pub type Clock<'a> = &'a (dyn Fn() -> i64 + Send + Sync);
const CHUNK: usize = 64 * 1024;
const FILE: i64 = 2 * 1024 * 1024;
const BATCH_BYTES: i64 = 8 * 1024 * 1024;
const ABSOLUTE_MS: i64 = 15 * 60 * 1000;
const IDLE_MS: i64 = 2 * 60 * 1000;
const RECEIPTS: i64 = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotConversationKind {
    Chat,
    Implement,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileRef {
    pub conversation_id: String,
    pub conversation_kind: PilotConversationKind,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileScope {
    pub account_id: String,
    pub session_id: String,
    pub instance_id: String,
    pub authority_binding: String,
    pub r#ref: PilotFileRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileGuard {
    pub scope: PilotFileScope,
    pub execute_before: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileAuthorizeInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub active: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileBeginInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub intent_id: String,
    pub batch_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub total_bytes: i64,
    pub sha256: String,
    pub intent_expires_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileChunkInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub transfer_id: String,
    pub offset_bytes: i64,
    pub data_base64: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileTransferInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub transfer_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotFileState {
    Receiving,
    Finalized,
    Attached,
    Aborted,
    Expired,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotFileReceipt {
    pub r#ref: PilotFileRef,
    pub intent_id: String,
    pub batch_id: String,
    pub transfer_id: String,
    pub attachment_id: Option<String>,
    pub state: PilotFileState,
    pub received_bytes: i64,
    pub total_bytes: i64,
    pub sha256: String,
    pub observed_at: String,
    pub expires_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotPrepareSendInput {
    pub intent_expires_at: String,
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub send_intent_id: String,
    pub content: String,
    pub attachment_ids: Vec<String>,
    pub expected_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotSendReadInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub send_intent_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotSendState {
    MessagePersisted,
    LaunchUncertain,
    Confirmed,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotSendMarkInput {
    pub user_message_id: String,
    pub assistant_message_id: Option<String>,
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub send_intent_id: String,
    pub expected_revision: i64,
    pub state: PilotSendState,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotSendReceipt {
    pub attachment_ids: Vec<String>,
    pub assistant_message_id: Option<String>,
    pub context_state: PilotFileContextState,
    pub r#ref: PilotFileRef,
    pub send_intent_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub state: PilotSendState,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotFileContextRef {
    pub id: String,
    pub title: String,
    pub content: String,
    pub size_bytes: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotFileImage {
    pub attachment_id: String,
    pub file_name: String,
    pub mime_type: String,
    #[serde(rename = "readyDataURL")]
    pub ready_data_url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotPreparedSend {
    pub message: Message,
    pub citations: Vec<ConversationCitation>,
    pub receipt: PilotSendReceipt,
    pub context_refs: Vec<PilotFileContextRef>,
    pub images: Vec<PilotFileImage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotFileSource {
    pub source_kind: PilotFileSourceKind,
    pub citation_id: Option<String>,
    pub citation_scope: Option<PilotCitationScope>,
    pub content_state: PilotFileContentState,
    pub source_id: String,
    pub message_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub total_bytes: i64,
    pub sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotFileReadInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub source_id: String,
    pub offset_bytes: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotFileRead {
    pub source: PilotFileSource,
    pub offset_bytes: i64,
    pub data_base64: String,
    pub next_offset_bytes: Option<i64>,
}

fn db(_: sqlx::Error) -> String {
    "unavailable".into()
}
fn invalid<T>() -> Result<T> {
    Err("validation_failed".into())
}
fn json<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| "validation_failed".into())
}
fn owner(s: &PilotFileScope) -> Result<String> {
    json(&(&s.account_id, &s.session_id, &s.instance_id))
}
fn timestamp(s: &str) -> Result<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.timestamp_millis())
        .map_err(|_| "validation_failed".into())
}
fn date(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339())
        .ok_or_else(|| "validation_failed".into())
}
pub fn system_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn id(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) {
        invalid()
    } else {
        Ok(())
    }
}
fn valid_hash(s: &str) -> Result<()> {
    if s.len() != 64
        || !s
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        invalid()
    } else {
        Ok(())
    }
}
fn scope_valid(s: &PilotFileScope) -> Result<()> {
    for v in [
        &s.account_id,
        &s.session_id,
        &s.instance_id,
        &s.authority_binding,
        &s.r#ref.conversation_id,
    ] {
        id(v)?;
    }
    for v in [&s.r#ref.workspace_id, &s.r#ref.project_id, &s.r#ref.task_id]
        .into_iter()
        .flatten()
    {
        id(v)?;
    }
    if s.r#ref.conversation_kind == PilotConversationKind::Implement
        && (s.r#ref.workspace_id.is_none() || s.r#ref.task_id.is_none())
    {
        return invalid();
    }
    Ok(())
}
fn deadline(d: &str, clock: Clock<'_>) -> Result<()> {
    if timestamp(d)? <= clock() {
        Err("expired".into())
    } else {
        Ok(())
    }
}
async fn tx(pool: &SqlitePool) -> Result<Tx<'_>> {
    pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)
}
async fn target(t: &mut Tx<'_>, s: &PilotFileScope) -> Result<i64> {
    target_with_archive(t, s, false).await
}
async fn target_with_archive(
    t: &mut Tx<'_>,
    s: &PilotFileScope,
    allow_archived: bool,
) -> Result<i64> {
    let row = sqlx::query("SELECT c.scope_mode,c.project_id,c.task_id,m.archived,m.revision FROM conversations c JOIN conversation_management m ON m.conversation_id=c.id WHERE c.id=?")
        .bind(&s.r#ref.conversation_id).fetch_optional(&mut **t).await.map_err(db)?.ok_or("not_found")?;
    let kind: String = row.get("scope_mode");
    let expected = match s.r#ref.conversation_kind {
        PilotConversationKind::Chat => "Chat",
        PilotConversationKind::Implement => "Implement",
    };
    if kind != expected
        || row.get::<Option<String>, _>("project_id") != s.r#ref.project_id
        || row.get::<Option<String>, _>("task_id") != s.r#ref.task_id
        || (!allow_archived && row.get::<i64, _>("archived") != 0)
    {
        return Err("scope_mismatch".into());
    }
    Ok(row.get("revision"))
}
async fn guard(t: &mut Tx<'_>, s: &PilotFileScope, d: &str, clock: Clock<'_>) -> Result<()> {
    scope_valid(s)?;
    deadline(d, clock)?;
    let allowed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pilot_file_authorities WHERE owner_key=? AND binding=? AND active=1",
    )
    .bind(owner(s)?)
    .bind(&s.authority_binding)
    .fetch_one(&mut **t)
    .await
    .map_err(db)?;
    if allowed != 1 {
        return Err("unauthorized".into());
    }
    target(t, s).await?;
    deadline(d, clock)
}
async fn commit(mut t: Tx<'_>, s: &PilotFileScope, d: &str, clock: Clock<'_>) -> Result<()> {
    guard(&mut t, s, d, clock).await?;
    t.commit().await.map_err(db)
}

/// Local host only. A retired opaque binding is permanently rejected on reuse.
pub async fn authorize(
    pool: &SqlitePool,
    i: PilotFileAuthorizeInput,
    clock: Clock<'_>,
) -> Result<()> {
    scope_valid(&i.scope)?;
    if i.active {
        deadline(&i.execute_before, clock)?;
    }
    let mut t = tx(pool).await?;
    if i.active {
        target_with_archive(&mut t, &i.scope, true).await?;
    }
    let key = owner(&i.scope)?;
    let current =
        sqlx::query("SELECT binding,active FROM pilot_file_authorities WHERE owner_key=?")
            .bind(&key)
            .fetch_optional(&mut *t)
            .await
            .map_err(db)?;
    if !i.active {
        let current = current.ok_or("unauthorized")?;
        if current.get::<String, _>("binding") != i.scope.authority_binding {
            return Err("unauthorized".into());
        }
        sqlx::query("UPDATE pilot_file_authorities SET active=0 WHERE owner_key=? AND binding=?")
            .bind(&key)
            .bind(&i.scope.authority_binding)
            .execute(&mut *t)
            .await
            .map_err(db)?;
        return t.commit().await.map_err(db);
    }
    if let Some(r) = &current {
        if !i.active && r.get::<String, _>("binding") != i.scope.authority_binding {
            return Err("unauthorized".into());
        }
        if i.active
            && r.get::<String, _>("binding") == i.scope.authority_binding
            && r.get::<i64, _>("active") == 1
        {
            deadline(&i.execute_before, clock)?;
            return t.commit().await.map_err(db);
        }
    }
    if i.active {
        let used: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pilot_file_binding_history WHERE owner_key=? AND binding=?",
        )
        .bind(&key)
        .bind(&i.scope.authority_binding)
        .fetch_one(&mut *t)
        .await
        .map_err(db)?;
        if used != 0 {
            return Err("unauthorized".into());
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pilot_file_binding_history")
            .fetch_one(&mut *t)
            .await
            .map_err(db)?;
        if count >= 4096 {
            return Err("resource_limit".into());
        }
        deadline(&i.execute_before, clock)?;
        sqlx::query("INSERT INTO pilot_file_binding_history VALUES (?,?)")
            .bind(&key)
            .bind(&i.scope.authority_binding)
            .execute(&mut *t)
            .await
            .map_err(db)?;
    }
    deadline(&i.execute_before, clock)?;
    sqlx::query("INSERT INTO pilot_file_authorities VALUES (?,?,?,?) ON CONFLICT(owner_key) DO UPDATE SET binding=excluded.binding,active=excluded.active")
        .bind(&key).bind(&i.scope.instance_id).bind(&i.scope.authority_binding).bind(i.active as i64).execute(&mut *t).await.map_err(db)?;
    deadline(&i.execute_before, clock)?;
    t.commit().await.map_err(db)
}

async fn cleanup(t: &mut Tx<'_>, s: &PilotFileScope, d: &str, clock: Clock<'_>) -> Result<()> {
    guard(t, s, d, clock).await?;
    let now = clock();
    sqlx::query("UPDATE pilot_file_transfers SET state='expired',data=X'',attachment_id=NULL WHERE instance_id=? AND state IN ('receiving','finalized') AND (expires_at<=? OR last_progress_at<=?)")
        .bind(&s.instance_id).bind(now).bind(now-IDLE_MS).execute(&mut **t).await.map_err(db)?;
    guard(t, s, d, clock).await?;
    sqlx::query("DELETE FROM pilot_file_chunks WHERE transfer_id IN (SELECT id FROM pilot_file_transfers WHERE instance_id=? AND state IN ('expired','aborted'))")
        .bind(&s.instance_id).execute(&mut **t).await.map_err(db)?;
    guard(t, s, d, clock).await?;
    sqlx::query("DELETE FROM pilot_file_transfers WHERE instance_id=? AND state IN ('expired','aborted','attached') AND expires_at<=?")
        .bind(&s.instance_id).bind(now).execute(&mut **t).await.map_err(db)?;
    Ok(())
}
fn transfer_receipt(
    r: &SqliteRow,
    s: &PilotFileScope,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    let state: String = r.get("state");
    Ok(PilotFileReceipt {
        r#ref: s.r#ref.clone(),
        intent_id: r.get("intent_id"),
        batch_id: r.get("batch_id"),
        transfer_id: r.get("id"),
        attachment_id: r.get("attachment_id"),
        state: match state.as_str() {
            "receiving" => PilotFileState::Receiving,
            "finalized" => PilotFileState::Finalized,
            "attached" => PilotFileState::Attached,
            "aborted" => PilotFileState::Aborted,
            _ => PilotFileState::Expired,
        },
        received_bytes: r.get("received_bytes"),
        total_bytes: r.get("total_bytes"),
        sha256: r.get("sha256"),
        observed_at: date(clock())?,
        expires_at: date(if matches!(state.as_str(), "receiving" | "finalized") {
            r.get::<i64, _>("expires_at")
                .min(r.get::<i64, _>("last_progress_at") + IDLE_MS)
        } else {
            r.get("expires_at")
        })?,
    })
}
async fn transfer(
    t: &mut Tx<'_>,
    s: &PilotFileScope,
    transfer_id: &str,
    bytes: bool,
) -> Result<SqliteRow> {
    id(transfer_id)?;
    let q = if bytes {
        "SELECT * FROM pilot_file_transfers WHERE id=? AND scope_key=?"
    } else {
        "SELECT id,intent_id,batch_id,attachment_id,state,received_bytes,total_bytes,sha256,expires_at,intent_digest,last_progress_at FROM pilot_file_transfers WHERE id=? AND scope_key=?"
    };
    sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(transfer_id)
        .bind(json(s)?)
        .fetch_optional(&mut **t)
        .await
        .map_err(db)?
        .ok_or_else(|| "not_found".into())
}

pub async fn begin(
    pool: &SqlitePool,
    i: PilotFileBeginInput,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    for v in [&i.intent_id, &i.batch_id] {
        id(v)?;
    }
    valid_hash(&i.sha256)?;
    if i.file_name.is_empty()
        || i.file_name.len() > 480
        || i.file_name.chars().count() > 120
        || i.file_name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        || !(1..=FILE).contains(&i.total_bytes)
        || !mime_allowed(&i.mime_type)
    {
        return invalid();
    }
    let expires = timestamp(&i.intent_expires_at)?;
    let digest = hash(
        json(&(
            &i.scope,
            &i.intent_id,
            &i.batch_id,
            &i.file_name,
            &i.mime_type,
            i.total_bytes,
            &i.sha256,
            expires,
        ))?
        .as_bytes(),
    );
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let existing =
        sqlx::query("SELECT * FROM pilot_file_transfers WHERE scope_key=? AND intent_id=?")
            .bind(json(&i.scope)?)
            .bind(&i.intent_id)
            .fetch_optional(&mut *t)
            .await
            .map_err(db)?;
    if let Some(r) = existing {
        if r.get::<String, _>("intent_digest") != digest {
            return Err("intent_conflict".into());
        }
        let out = transfer_receipt(&r, &i.scope, clock)?;
        commit(t, &i.scope, &i.execute_before, clock).await?;
        return Ok(out);
    }
    if expires <= clock() || expires > clock() + ABSOLUTE_MS {
        return Err("expired".into());
    }
    let quotas=sqlx::query("SELECT COUNT(*) AS receipts,COALESCE(SUM(CASE WHEN state IN ('receiving','finalized') THEN total_bytes ELSE 0 END),0) AS bytes,SUM(CASE WHEN state IN ('receiving','finalized') THEN 1 ELSE 0 END) AS count,COALESCE(SUM(CASE WHEN session_id=? AND state IN ('receiving','finalized') THEN total_bytes ELSE 0 END),0) AS session_bytes,COALESCE(SUM(CASE WHEN session_id=? AND state IN ('receiving','finalized') THEN 1 ELSE 0 END),0) AS session_count FROM pilot_file_transfers WHERE instance_id=?")
        .bind(&i.scope.session_id).bind(&i.scope.session_id).bind(&i.scope.instance_id).fetch_one(&mut *t).await.map_err(db)?;
    if quotas.get::<i64, _>("receipts") >= RECEIPTS
        || quotas.get::<i64, _>("bytes") + i.total_bytes > 32 * 1024 * 1024
        || quotas.get::<Option<i64>, _>("count").unwrap_or(0) >= 32
        || quotas.get::<i64, _>("session_bytes") + i.total_bytes > 16 * 1024 * 1024
        || quotas.get::<i64, _>("session_count") >= 16
    {
        return Err("resource_limit".into());
    }
    let batch=sqlx::query("SELECT COUNT(*) AS count,COALESCE(SUM(total_bytes),0) AS bytes,MIN(expires_at) AS expires FROM pilot_file_transfers WHERE scope_key=? AND batch_id=?")
        .bind(json(&i.scope)?).bind(&i.batch_id).fetch_one(&mut *t).await.map_err(db)?;
    if batch.get::<i64, _>("count") >= 10
        || batch.get::<i64, _>("bytes") + i.total_bytes > BATCH_BYTES
        || batch
            .get::<Option<i64>, _>("expires")
            .is_some_and(|e| e != expires)
    {
        return Err("resource_limit".into());
    }
    let effect_deadline = date(expires.min(timestamp(&i.execute_before)?))?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    // Same write transaction as the E owner. Existing per-instance/session
    // byte/count limits above remain independent and unchanged.
    super::inactive_budget::admit(&mut t, i.total_bytes).await?;
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    sqlx::query("INSERT INTO pilot_file_transfers(id,scope_key,owner_key,ref_key,instance_id,session_id,intent_id,batch_id,intent_digest,file_name,mime_type,total_bytes,sha256,state,created_at,last_progress_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'receiving',?,?,?)")
        .bind(&transfer_id).bind(json(&i.scope)?).bind(owner(&i.scope)?).bind(json(&i.scope.r#ref)?).bind(&i.scope.instance_id).bind(&i.scope.session_id).bind(&i.intent_id).bind(&i.batch_id).bind(digest).bind(&i.file_name).bind(&i.mime_type).bind(i.total_bytes).bind(&i.sha256).bind(clock()).bind(clock()).bind(expires).execute(&mut *t).await.map_err(db)?;
    let out = transfer_receipt(
        &transfer(&mut t, &i.scope, &transfer_id, false).await?,
        &i.scope,
        clock,
    )?;
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}

pub async fn chunk(
    pool: &SqlitePool,
    i: PilotFileChunkInput,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    valid_hash(&i.sha256)?;
    if i.offset_bytes < 0 || i.data_base64.len() > CHUNK.div_ceil(3) * 4 {
        return invalid();
    }
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let r = transfer(&mut t, &i.scope, &i.transfer_id, false).await?;
    let effect_deadline = date(
        r.get::<i64, _>("expires_at")
            .min(r.get::<i64, _>("last_progress_at") + IDLE_MS)
            .min(timestamp(&i.execute_before)?),
    )?;
    deadline(&effect_deadline, clock)?;
    let total: i64 = r.get("total_bytes");
    let received: i64 = r.get("received_bytes");
    let state: String = r.get("state");
    if !matches!(state.as_str(), "receiving" | "finalized" | "attached") {
        return Err("expired".into());
    }
    // Decode only after authorization and both encoded-size and remaining-byte checks.
    if i.data_base64.is_empty()
        || i.offset_bytes > received
        || i.offset_bytes > total
        || i.data_base64.len() > (((total - i.offset_bytes).min(CHUNK as i64) + 2) / 3) as usize * 4
    {
        return invalid();
    }
    let data = STANDARD
        .decode(&i.data_base64)
        .map_err(|_| "validation_failed")?;
    if data.is_empty()
        || data.len() > CHUNK
        || i.offset_bytes + data.len() as i64 > total
        || hash(&data) != i.sha256
    {
        return invalid();
    }
    let old = sqlx::query(
        "SELECT size_bytes,sha256 FROM pilot_file_chunks WHERE transfer_id=? AND offset_bytes=?",
    )
    .bind(&i.transfer_id)
    .bind(i.offset_bytes)
    .fetch_optional(&mut *t)
    .await
    .map_err(db)?;
    if let Some(old) = old {
        if old.get::<i64, _>("size_bytes") != data.len() as i64
            || old.get::<String, _>("sha256") != i.sha256
        {
            return Err("intent_conflict".into());
        }
    } else {
        if state != "receiving" || i.offset_bytes != received {
            return Err("offset_conflict".into());
        }
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        sqlx::query("UPDATE pilot_file_transfers SET data=CAST(data || ? AS BLOB),received_bytes=received_bytes+?,last_progress_at=? WHERE id=?")
            .bind(&data).bind(data.len() as i64).bind(clock()).bind(&i.transfer_id).execute(&mut *t).await.map_err(db)?;
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        sqlx::query("INSERT INTO pilot_file_chunks VALUES (?,?,?,?)")
            .bind(&i.transfer_id)
            .bind(i.offset_bytes)
            .bind(data.len() as i64)
            .bind(&i.sha256)
            .execute(&mut *t)
            .await
            .map_err(db)?;
    }
    let out = transfer_receipt(
        &transfer(&mut t, &i.scope, &i.transfer_id, false).await?,
        &i.scope,
        clock,
    )?;
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}

pub async fn status(
    pool: &SqlitePool,
    i: PilotFileTransferInput,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let out = transfer_receipt(
        &transfer(&mut t, &i.scope, &i.transfer_id, false).await?,
        &i.scope,
        clock,
    )?;
    commit(t, &i.scope, &i.execute_before, clock).await?;
    Ok(out)
}
pub async fn finalize(
    pool: &SqlitePool,
    i: PilotFileTransferInput,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let r = transfer(&mut t, &i.scope, &i.transfer_id, true).await?;
    let effect_deadline = date(
        r.get::<i64, _>("expires_at")
            .min(r.get::<i64, _>("last_progress_at") + IDLE_MS)
            .min(timestamp(&i.execute_before)?),
    )?;
    deadline(&effect_deadline, clock)?;
    let state: String = r.get("state");
    if state == "receiving" {
        let data: Vec<u8> = r.get("data");
        if r.get::<i64, _>("received_bytes") != r.get::<i64, _>("total_bytes")
            || data.len() as i64 != r.get::<i64, _>("total_bytes")
            || hash(&data) != r.get::<String, _>("sha256")
        {
            return Err("integrity_failed".into());
        }
        validate_content(&r.get::<String, _>("mime_type"), &data)?;
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        sqlx::query("UPDATE pilot_file_transfers SET state='finalized',attachment_id=?,last_progress_at=? WHERE id=?")
            .bind(uuid::Uuid::new_v4().to_string()).bind(clock()).bind(&i.transfer_id).execute(&mut *t).await.map_err(db)?;
    } else if !matches!(state.as_str(), "finalized" | "attached") {
        return Err("expired".into());
    }
    let out = transfer_receipt(
        &transfer(&mut t, &i.scope, &i.transfer_id, false).await?,
        &i.scope,
        clock,
    )?;
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}
pub async fn abort(
    pool: &SqlitePool,
    i: PilotFileTransferInput,
    clock: Clock<'_>,
) -> Result<PilotFileReceipt> {
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let r = transfer(&mut t, &i.scope, &i.transfer_id, false).await?;
    if r.get::<String, _>("state") == "attached" {
        return Err("intent_conflict".into());
    }
    if matches!(
        r.get::<String, _>("state").as_str(),
        "receiving" | "finalized"
    ) {
        guard(&mut t, &i.scope, &i.execute_before, clock).await?;
        sqlx::query("UPDATE pilot_file_transfers SET state='aborted',data=X'',attachment_id=NULL WHERE id=?")
            .bind(&i.transfer_id)
            .execute(&mut *t)
            .await
            .map_err(db)?;
        guard(&mut t, &i.scope, &i.execute_before, clock).await?;
        sqlx::query("DELETE FROM pilot_file_chunks WHERE transfer_id=?")
            .bind(&i.transfer_id)
            .execute(&mut *t)
            .await
            .map_err(db)?;
    }
    let out = transfer_receipt(
        &transfer(&mut t, &i.scope, &i.transfer_id, false).await?,
        &i.scope,
        clock,
    )?;
    commit(t, &i.scope, &i.execute_before, clock).await?;
    Ok(out)
}

fn send_receipt(r: &SqliteRow, s: &PilotFileScope, intent: &str) -> Result<PilotSendReceipt> {
    Ok(PilotSendReceipt {
        attachment_ids: serde_json::from_str(&r.get::<String, _>("attachment_ids_json"))
            .map_err(|_| "unavailable")?,
        assistant_message_id: r.get("assistant_message_id"),
        context_state: if r.get::<String, _>("context_state") == "ready" {
            PilotFileContextState::Ready
        } else {
            PilotFileContextState::Unavailable
        },
        r#ref: s.r#ref.clone(),
        send_intent_id: intent.into(),
        message_id: r.get("message_id"),
        turn_id: r.get("turn_id"),
        revision: r.get("revision"),
        state: match r.get::<String, _>("state").as_str() {
            "message_persisted" => PilotSendState::MessagePersisted,
            "launch_uncertain" => PilotSendState::LaunchUncertain,
            "confirmed" => PilotSendState::Confirmed,
            _ => return Err("unavailable".into()),
        },
    })
}
async fn send(t: &mut Tx<'_>, s: &PilotFileScope, intent: &str) -> Result<SqliteRow> {
    id(intent)?;
    sqlx::query(
        "SELECT * FROM pilot_file_sends WHERE owner_key=? AND ref_key=? AND send_intent_id=?",
    )
    .bind(owner(s)?)
    .bind(json(&s.r#ref)?)
    .bind(intent)
    .fetch_optional(&mut **t)
    .await
    .map_err(db)?
    .ok_or_else(|| "not_found".into())
}
async fn prepared(t: &mut Tx<'_>, receipt: PilotSendReceipt) -> Result<PilotPreparedSend> {
    let bounds=sqlx::query("SELECT COUNT(*) AS count,COALESCE(SUM(total_bytes),0) AS total,COALESCE(MAX(length(data)),0) AS maximum,COALESCE(SUM(CASE WHEN length(data)<>total_bytes THEN 1 ELSE 0 END),0) AS invalid FROM pilot_message_attachments WHERE message_id=?").bind(&receipt.message_id).fetch_one(&mut **t).await.map_err(db)?;
    if bounds.get::<i64, _>("count") != receipt.attachment_ids.len() as i64
        || bounds.get::<i64, _>("count") > 10
        || bounds.get::<i64, _>("total") > BATCH_BYTES
        || bounds.get::<i64, _>("maximum") > FILE
        || bounds.get::<i64, _>("invalid") > 0
    {
        return Err("integrity_failed".into());
    }
    let mut rows=sqlx::query("SELECT id AS attachment_id,file_name,mime_type,data,total_bytes FROM pilot_message_attachments WHERE message_id=? ORDER BY id")
        .bind(&receipt.message_id).fetch_all(&mut **t).await.map_err(db)?;
    rows.sort_by_key(|r| {
        receipt
            .attachment_ids
            .iter()
            .position(|id| id == &r.get::<String, _>("attachment_id"))
    });
    let message_row = sqlx::query("SELECT * FROM messages WHERE id=?")
        .bind(&receipt.message_id)
        .fetch_one(&mut **t)
        .await
        .map_err(db)?;
    let message = Message {
        id: message_row.get("id"),
        conversation_id: message_row.get("conversation_id"),
        turn_id: message_row.get("turn_id"),
        role: message_row.get("role"),
        content: message_row.get("content"),
        created_at: message_row.get("created_at"),
        token_count: message_row.get("token_count"),
        tool_traces_json: message_row.get("tool_traces_json"),
        hidden_context: message_row.get("hidden_context"),
        provider_input_items_json: message_row.get("provider_input_items_json"),
        provider_turn_state_json: message_row.get("provider_turn_state_json"),
        context_refs_json: message_row.get("context_refs_json"),
        completion_reason: message_row.get("completion_reason"),
        generation_attempts_json: message_row.get("generation_attempts_json"),
    };
    let citation_bounds=sqlx::query("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(c.content AS BLOB))),0) AS total,COALESCE(SUM(CASE WHEN a.id IS NULL OR c.content IS NULL OR length(CAST(c.content AS BLOB))<>a.total_bytes OR CAST(c.content AS BLOB)<>a.data OR c.type<>'file' OR c.scope<>'context' OR c.path IS NULL OR c.path<>('attachment://' || a.id) THEN 1 ELSE 0 END),0) AS invalid FROM conversation_citations c LEFT JOIN pilot_message_attachments a ON a.id=c.id AND a.message_id=c.message_id AND a.mime_type NOT LIKE 'image/%' WHERE c.message_id=? AND c.source='pilot_attachment'").bind(&receipt.message_id).fetch_one(&mut **t).await.map_err(db)?;
    let text_count = rows
        .iter()
        .filter(|r| !r.get::<String, _>("mime_type").starts_with("image/"))
        .count();
    if citation_bounds.get::<i64, _>("count") != text_count as i64
        || citation_bounds.get::<i64, _>("total") > BATCH_BYTES
        || citation_bounds.get::<i64, _>("invalid") > 0
    {
        return Err("integrity_failed".into());
    }
    let citation_rows = sqlx::query(
        "SELECT * FROM conversation_citations WHERE message_id=? AND source='pilot_attachment'",
    )
    .bind(&receipt.message_id)
    .fetch_all(&mut **t)
    .await
    .map_err(db)?;
    let citations = citation_rows
        .into_iter()
        .map(|r| ConversationCitation {
            id: r.get("id"),
            conversation_id: r.get("conversation_id"),
            message_id: r.get("message_id"),
            r#type: r.get("type"),
            scope: r.get("scope"),
            source: r.get("source"),
            title: r.get("title"),
            snippet: r.get("snippet"),
            content: r.get("content"),
            url: r.get("url"),
            favicon: r.get("favicon"),
            path: r.get("path"),
            language: r.get("language"),
            size_bytes: r.get("size_bytes"),
            kind: r.get("kind"),
            reason: r.get("reason"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect();
    let mut out = PilotPreparedSend {
        message,
        citations,
        receipt,
        context_refs: vec![],
        images: vec![],
    };
    for r in rows {
        let mime: String = r.get("mime_type");
        let data: Vec<u8> = r.get("data");
        let attachment_id: String = r.get("attachment_id");
        if mime.starts_with("image/") {
            out.images.push(PilotFileImage {
                attachment_id,
                file_name: r.get("file_name"),
                ready_data_url: image_data_url(&mime, &data)?,
                mime_type: mime,
            });
        } else {
            out.context_refs.push(PilotFileContextRef {
                id: attachment_id,
                title: r.get("file_name"),
                content: String::from_utf8(data).map_err(|_| "integrity_failed")?,
                size_bytes: r.get("total_bytes"),
            });
        }
    }
    Ok(out)
}
pub async fn prepare_send(
    pool: &SqlitePool,
    i: PilotPrepareSendInput,
    clock: Clock<'_>,
) -> Result<PilotPreparedSend> {
    id(&i.send_intent_id)?;
    timestamp(&i.intent_expires_at)?;
    if i.content.len() > 1024 * 1024
        || i.attachment_ids.is_empty()
        || i.attachment_ids.len() > 10
        || i.expected_revision < 0
    {
        return invalid();
    }
    let mut unique = HashSet::new();
    for a in &i.attachment_ids {
        id(a)?;
        if !unique.insert(a) {
            return invalid();
        }
    }
    let digest = hash(
        json(&(
            &i.scope,
            &i.send_intent_id,
            &i.intent_expires_at,
            &i.content,
            &i.attachment_ids,
            i.expected_revision,
        ))?
        .as_bytes(),
    );
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    match send(&mut t, &i.scope, &i.send_intent_id).await {
        Ok(r) => {
            if r.get::<String, _>("scope_key") != json(&i.scope)? {
                return Err("unauthorized".into());
            }
            if r.get::<String, _>("digest") != digest {
                return Err("intent_conflict".into());
            }
            let replay_deadline = date(
                r.get::<i64, _>("intent_expires_at")
                    .min(timestamp(&i.execute_before)?),
            )?;
            guard(&mut t, &i.scope, &replay_deadline, clock).await?;
            let out = prepared(&mut t, send_receipt(&r, &i.scope, &i.send_intent_id)?).await?;
            commit(t, &i.scope, &replay_deadline, clock).await?;
            return Ok(out);
        }
        Err(e) if e == "not_found" => {}
        Err(e) => return Err(e),
    }
    let intent_expiry = timestamp(&i.intent_expires_at)?;
    let mut effect_deadline = date(intent_expiry.min(timestamp(&i.execute_before)?))?;
    if intent_expiry <= clock() || intent_expiry > clock() + ABSOLUTE_MS {
        return Err("expired".into());
    }
    deadline(&i.intent_expires_at, clock)?;
    if target(&mut t, &i.scope).await? != i.expected_revision {
        return Err("stale_revision".into());
    }
    let mut rows = vec![];
    let mut total = 0;
    let mut batch: Option<String> = None;
    for a in &i.attachment_ids {
        let r=sqlx::query("SELECT id,attachment_id,batch_id,total_bytes,expires_at,last_progress_at FROM pilot_file_transfers WHERE attachment_id=? AND scope_key=? AND state='finalized'").bind(a).bind(json(&i.scope)?).fetch_optional(&mut *t).await.map_err(db)?.ok_or("not_found")?;
        let b: String = r.get("batch_id");
        if batch.as_ref().is_some_and(|v| v != &b) {
            return Err("scope_mismatch".into());
        }
        batch = Some(b);
        total += r.get::<i64, _>("total_bytes");
        if total > BATCH_BYTES {
            return Err("resource_limit".into());
        }
        effect_deadline = date(
            timestamp(&effect_deadline)?
                .min(r.get::<i64, _>("expires_at"))
                .min(r.get::<i64, _>("last_progress_at") + IDLE_MS),
        )?;
        rows.push(r);
    }
    // All reservations have passed their metadata quotas before any BLOB is read.
    let mut payloads = Vec::with_capacity(rows.len());
    for metadata in rows {
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        payloads.push(transfer(&mut t, &i.scope, &metadata.get::<String, _>("id"), true).await?);
    }
    let rows = payloads;
    let message_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let now = date(clock())?;
    let refs:Vec<_>=rows.iter().filter(|r|!r.get::<String,_>("mime_type").starts_with("image/")).map(|r|serde_json::json!({"id":r.get::<String,_>("attachment_id"),"kind":"file","path":format!("attachment://{}",r.get::<String,_>("attachment_id")),"title":r.get::<String,_>("file_name")})).collect();
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    sqlx::query("INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at,context_refs_json) VALUES (?,?,?,'user',?,?,?)")
        .bind(&message_id).bind(&i.scope.r#ref.conversation_id).bind(&turn_id).bind(&i.content).bind(&now).bind(json(&refs)?).execute(&mut *t).await.map_err(db)?;
    for r in rows {
        let mime: String = r.get("mime_type");
        if !mime.starts_with("image/") {
            let data: Vec<u8> = r.get("data");
            let content = String::from_utf8(data).map_err(|_| "integrity_failed")?;
            guard(&mut t, &i.scope, &effect_deadline, clock).await?;
            sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,path,title,content,size_bytes,created_at,updated_at) VALUES (?,?,?,'file','context','pilot_attachment',?,?,?,?,?,?)")
                .bind(r.get::<String,_>("attachment_id")).bind(&i.scope.r#ref.conversation_id).bind(&message_id).bind(format!("attachment://{}",r.get::<String,_>("attachment_id"))).bind(r.get::<String,_>("file_name")).bind(content).bind(r.get::<i64,_>("total_bytes")).bind(&now).bind(&now).execute(&mut *t).await.map_err(db)?;
        }
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        sqlx::query("INSERT INTO pilot_message_attachments(id,owner_key,instance_id,ref_key,message_id,file_name,mime_type,total_bytes,sha256,data) SELECT attachment_id,owner_key,instance_id,ref_key,?,file_name,mime_type,total_bytes,sha256,data FROM pilot_file_transfers WHERE id=?")
            .bind(&message_id).bind(r.get::<String,_>("id")).execute(&mut *t).await.map_err(db)?;
        guard(&mut t, &i.scope, &effect_deadline, clock).await?;
        sqlx::query(
            "UPDATE pilot_file_transfers SET state='attached',message_id=?,data=X'' WHERE id=?",
        )
        .bind(&message_id)
        .bind(r.get::<String, _>("id"))
        .execute(&mut *t)
        .await
        .map_err(db)?;
    }
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    if target(&mut t, &i.scope).await? != i.expected_revision {
        return Err("stale_revision".into());
    }
    sqlx::query("UPDATE conversations SET message_count=COALESCE(message_count,0)+1,last_message=?,updated_at=? WHERE id=?")
        .bind(&i.content).bind(&now).bind(&i.scope.r#ref.conversation_id).execute(&mut *t).await.map_err(db)?;
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    sqlx::query("INSERT INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,context_state,intent_expires_at) VALUES (?,?,?,?,?,?,?,'message_persisted',?,'ready',?)")
        .bind(owner(&i.scope)?).bind(json(&i.scope.r#ref)?).bind(&i.send_intent_id).bind(json(&i.scope)?).bind(digest).bind(&message_id).bind(&turn_id).bind(json(&i.attachment_ids)?).bind(intent_expiry).execute(&mut *t).await.map_err(db)?;
    let r = send(&mut t, &i.scope, &i.send_intent_id).await?;
    let out = prepared(&mut t, send_receipt(&r, &i.scope, &i.send_intent_id)?).await?;
    deadline(&i.intent_expires_at, clock)?;
    // The existing conversation_management_update trigger advances revision
    // once for our own conversation UPDATE within this BEGIN IMMEDIATE.
    if Some(target(&mut t, &i.scope).await?) != i.expected_revision.checked_add(1) {
        return Err("stale_revision".into());
    }
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}
pub async fn send_read(
    pool: &SqlitePool,
    i: PilotSendReadInput,
    clock: Clock<'_>,
) -> Result<PilotSendReceipt> {
    let mut t = tx(pool).await?;
    receipt_guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    let mut out = send_receipt(
        &send(&mut t, &i.scope, &i.send_intent_id).await?,
        &i.scope,
        &i.send_intent_id,
    )?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pilot_message_attachments WHERE message_id=?")
            .bind(&out.message_id)
            .fetch_one(&mut *t)
            .await
            .map_err(db)?;
    if count != out.attachment_ids.len() as i64 {
        out.context_state = PilotFileContextState::Unavailable;
    }
    receipt_guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    t.commit().await.map_err(db)?;
    Ok(out)
}
pub async fn send_mark(
    pool: &SqlitePool,
    i: PilotSendMarkInput,
    clock: Clock<'_>,
) -> Result<PilotSendReceipt> {
    let mut t = tx(pool).await?;
    guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    let r = send(&mut t, &i.scope, &i.send_intent_id).await?;
    if r.get::<String, _>("scope_key") != json(&i.scope)? {
        return Err("unauthorized".into());
    }
    let old = send_receipt(&r, &i.scope, &i.send_intent_id)?;
    let effect_deadline = date(
        r.get::<i64, _>("intent_expires_at")
            .min(timestamp(&i.execute_before)?),
    )?;
    deadline(&effect_deadline, clock)?;
    id(&i.user_message_id)?;
    if old.message_id != i.user_message_id {
        return Err("intent_conflict".into());
    }
    if i.state == PilotSendState::Confirmed {
        let assistant = i.assistant_message_id.as_ref().ok_or("validation_failed")?;
        id(assistant)?;
        let exists:i64=sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id=? AND conversation_id=? AND turn_id=? AND role='assistant'").bind(assistant).bind(&i.scope.r#ref.conversation_id).bind(&old.turn_id).fetch_one(&mut *t).await.map_err(db)?;
        if exists != 1 {
            return Err("not_found".into());
        }
    } else if i.assistant_message_id.is_some() {
        return invalid();
    }
    if old.revision != i.expected_revision {
        return Err("stale_revision".into());
    }
    let state = match (&old.state, &i.state) {
        (PilotSendState::MessagePersisted, PilotSendState::LaunchUncertain) => "launch_uncertain",
        (PilotSendState::LaunchUncertain, PilotSendState::Confirmed) => "confirmed",
        _ => return Err("intent_conflict".into()),
    };
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    sqlx::query("UPDATE pilot_file_sends SET state=?,assistant_message_id=?,revision=revision+1 WHERE owner_key=? AND ref_key=? AND send_intent_id=? AND revision=?")
        .bind(state).bind(&i.assistant_message_id).bind(owner(&i.scope)?).bind(json(&i.scope.r#ref)?).bind(&i.send_intent_id).bind(i.expected_revision).execute(&mut *t).await.map_err(db)?;
    let out = send_receipt(
        &send(&mut t, &i.scope, &i.send_intent_id).await?,
        &i.scope,
        &i.send_intent_id,
    )?;
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}

/// Catalog metadata is checked before any content allocation. IDs attest native
/// rows and their digest; a path in citation metadata is never interpreted.
pub async fn list(
    pool: &SqlitePool,
    i: PilotFileGuard,
    clock: Clock<'_>,
) -> Result<Vec<PilotFileSource>> {
    let mut t = tx(pool).await?;
    guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    let summary=sqlx::query("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM (SELECT length(CAST(file_name AS BLOB))+length(CAST(a.id AS BLOB))+length(CAST(a.message_id AS BLOB))+256 AS size FROM pilot_message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.instance_id=? AND a.ref_key=? AND m.conversation_id=? UNION ALL SELECT length(CAST(c.title AS BLOB))+length(CAST(c.id AS BLOB))+length(CAST(COALESCE(m.id,'') AS BLOB))+256 FROM conversation_citations c JOIN conversations v ON v.id=c.conversation_id LEFT JOIN messages m ON m.id=c.message_id AND m.conversation_id=c.conversation_id WHERE c.conversation_id=? AND c.content IS NOT NULL AND c.source<>'pilot_attachment' LIMIT 2001)")
        .bind(&i.scope.instance_id).bind(json(&i.scope.r#ref)?).bind(&i.scope.r#ref.conversation_id).bind(&i.scope.r#ref.conversation_id).fetch_one(&mut *t).await.map_err(db)?;
    if summary.get::<i64, _>("count") > 2000 || summary.get::<i64, _>("bytes") > 1024 * 1024 {
        return Err("resource_limit".into());
    }
    let attachments=sqlx::query("SELECT a.id,a.message_id,a.file_name,a.mime_type,a.total_bytes,a.sha256,length(a.data) AS actual FROM pilot_message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.instance_id=? AND a.ref_key=? AND m.conversation_id=? LIMIT 2001")
        .bind(&i.scope.instance_id).bind(json(&i.scope.r#ref)?).bind(&i.scope.r#ref.conversation_id).fetch_all(&mut *t).await.map_err(db)?;
    let citations=sqlx::query("SELECT c.id,COALESCE(m.id,'') AS message_id,c.title,c.scope,COALESCE(length(CAST(c.content AS BLOB)),0) AS total_bytes FROM conversation_citations c JOIN conversations v ON v.id=c.conversation_id LEFT JOIN messages m ON m.id=c.message_id AND m.conversation_id=c.conversation_id WHERE c.conversation_id=? AND c.content IS NOT NULL AND c.source <> 'pilot_attachment' LIMIT 2001")
        .bind(&i.scope.r#ref.conversation_id).fetch_all(&mut *t).await.map_err(db)?;
    if attachments.len() + citations.len() > 2000 {
        return Err("resource_limit".into());
    }
    let mut metadata = 0usize;
    for r in &attachments {
        metadata += r.get::<String, _>("file_name").len()
            + r.get::<String, _>("message_id").len()
            + r.get::<String, _>("id").len()
            + 256;
        if r.get::<i64, _>("total_bytes") > FILE
            || r.get::<i64, _>("total_bytes") != r.get::<i64, _>("actual")
        {
            return Err("resource_limit".into());
        }
    }
    for r in &citations {
        metadata += r.get::<String, _>("title").len()
            + r.get::<String, _>("message_id").len()
            + r.get::<String, _>("id").len()
            + 256;
    }
    if metadata > 1024 * 1024 {
        return Err("resource_limit".into());
    }
    guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    sqlx::query("DELETE FROM pilot_file_sources WHERE expires_at<=?")
        .bind(clock())
        .execute(&mut *t)
        .await
        .map_err(db)?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pilot_file_sources WHERE instance_id=? AND scope_key<>?",
    )
    .bind(&i.scope.instance_id)
    .bind(json(&i.scope)?)
    .fetch_one(&mut *t)
    .await
    .map_err(db)?;
    if existing + attachments.len() as i64 + citations.len() as i64 > 4000 {
        return Err("resource_limit".into());
    }
    let mut out = vec![];
    for r in attachments {
        let native_id: String = r.get("id");
        let digest: String = r.get("sha256");
        let source_id = register_source(
            &mut t,
            &i.scope,
            &i.execute_before,
            "attachment",
            &native_id,
            &digest,
            clock,
        )
        .await?;
        out.push(PilotFileSource {
            source_kind: if r.get::<String, _>("mime_type").starts_with("image/") {
                PilotFileSourceKind::MessageImage
            } else {
                PilotFileSourceKind::Attachment
            },
            citation_id: None,
            citation_scope: None,
            content_state: PilotFileContentState::Available,
            source_id,
            message_id: r.get("message_id"),
            file_name: r.get("file_name"),
            mime_type: r.get("mime_type"),
            total_bytes: r.get("total_bytes"),
            sha256: Some(digest),
        });
    }
    for r in citations {
        let native_id: String = r.get("id");
        let scope = citation_scope(&r.get::<String, _>("scope"))?;
        let too_large = r.get::<i64, _>("total_bytes") > FILE;
        let digest = if too_large {
            None
        } else {
            guard(&mut t, &i.scope, &i.execute_before, clock).await?;
            let content:String=sqlx::query_scalar("SELECT content FROM conversation_citations WHERE id=? AND length(CAST(content AS BLOB))<=?").bind(&native_id).bind(FILE).fetch_one(&mut *t).await.map_err(db)?;
            Some(hash(content.as_bytes()))
        };
        let source_id = register_source(
            &mut t,
            &i.scope,
            &i.execute_before,
            "citation",
            &native_id,
            digest.as_deref().unwrap_or("too_large"),
            clock,
        )
        .await?;
        out.push(PilotFileSource {
            source_id,
            source_kind: PilotFileSourceKind::Citation,
            citation_id: Some(native_id),
            citation_scope: Some(scope),
            content_state: if too_large {
                PilotFileContentState::TooLarge
            } else {
                PilotFileContentState::Available
            },
            message_id: r.get("message_id"),
            file_name: r.get("title"),
            mime_type: "text/plain".into(),
            total_bytes: r.get("total_bytes"),
            sha256: digest,
        });
    }
    commit(t, &i.scope, &i.execute_before, clock).await?;
    Ok(out)
}
async fn register_source(
    t: &mut Tx<'_>,
    s: &PilotFileScope,
    d: &str,
    kind: &str,
    native_id: &str,
    digest: &str,
    clock: Clock<'_>,
) -> Result<String> {
    let old:Option<String>=sqlx::query_scalar("SELECT id FROM pilot_file_sources WHERE scope_key=? AND kind=? AND native_id=? AND sha256=?")
        .bind(json(s)?).bind(kind).bind(native_id).bind(digest).fetch_optional(&mut **t).await.map_err(db)?;
    if let Some(old) = old {
        return Ok(old);
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pilot_file_sources WHERE instance_id=?")
            .bind(&s.instance_id)
            .fetch_one(&mut **t)
            .await
            .map_err(db)?;
    if count >= 4000 {
        return Err("resource_limit".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    guard(t, s, d, clock).await?;
    sqlx::query("INSERT INTO pilot_file_sources VALUES (?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(json(s)?)
        .bind(&s.instance_id)
        .bind(kind)
        .bind(native_id)
        .bind(digest)
        .bind(clock() + 5 * 60 * 1000)
        .execute(&mut **t)
        .await
        .map_err(db)?;
    Ok(id)
}
pub async fn read(
    pool: &SqlitePool,
    i: PilotFileReadInput,
    clock: Clock<'_>,
) -> Result<PilotFileRead> {
    id(&i.source_id)?;
    if i.offset_bytes < 0 || i.offset_bytes > FILE {
        return invalid();
    }
    let mut t = tx(pool).await?;
    guard(&mut t, &i.scope, &i.execute_before, clock).await?;
    let registration=sqlx::query("SELECT kind,native_id,sha256,expires_at FROM pilot_file_sources WHERE id=? AND scope_key=? AND expires_at>?")
        .bind(&i.source_id).bind(json(&i.scope)?).bind(clock()).fetch_optional(&mut *t).await.map_err(db)?.ok_or("not_found")?;
    let effect_deadline = date(
        registration
            .get::<i64, _>("expires_at")
            .min(timestamp(&i.execute_before)?),
    )?;
    guard(&mut t, &i.scope, &effect_deadline, clock).await?;
    let kind: String = registration.get("kind");
    let native_id: String = registration.get("native_id");
    // The source belongs to this durable conversation. Attachment rows also
    // require their original message; toolbox citations can have no message.
    let r=if kind=="attachment" {
        sqlx::query("SELECT a.message_id,a.file_name,a.mime_type,a.data,NULL AS citation_scope FROM pilot_message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND a.instance_id=? AND a.ref_key=? AND m.conversation_id=? AND length(a.data)<=?")
            .bind(&native_id).bind(&i.scope.instance_id).bind(json(&i.scope.r#ref)?).bind(&i.scope.r#ref.conversation_id).bind(FILE).fetch_optional(&mut *t).await.map_err(db)?
    } else {
        sqlx::query("SELECT COALESCE(m.id,'') AS message_id,c.scope AS citation_scope,c.title AS file_name,'text/plain' AS mime_type,CAST(c.content AS BLOB) AS data FROM conversation_citations c JOIN conversations v ON v.id=c.conversation_id LEFT JOIN messages m ON m.id=c.message_id AND m.conversation_id=c.conversation_id WHERE c.id=? AND c.conversation_id=? AND c.content IS NOT NULL AND length(CAST(c.content AS BLOB))<=?")
            .bind(&native_id).bind(&i.scope.r#ref.conversation_id).bind(FILE).fetch_optional(&mut *t).await.map_err(db)?
    }.ok_or("not_found")?;
    let data: Vec<u8> = r.get("data");
    let digest = hash(&data);
    if digest != registration.get::<String, _>("sha256") {
        return Err("stale_revision".into());
    }
    if i.offset_bytes as usize > data.len() {
        return invalid();
    }
    let end = (i.offset_bytes as usize + CHUNK).min(data.len());
    let out = PilotFileRead {
        source: PilotFileSource {
            source_kind: if kind == "citation" {
                PilotFileSourceKind::Citation
            } else if r.get::<String, _>("mime_type").starts_with("image/") {
                PilotFileSourceKind::MessageImage
            } else {
                PilotFileSourceKind::Attachment
            },
            citation_id: if kind == "citation" {
                Some(native_id)
            } else {
                None
            },
            citation_scope: r
                .get::<Option<String>, _>("citation_scope")
                .as_deref()
                .map(citation_scope)
                .transpose()?,
            content_state: PilotFileContentState::Available,
            source_id: i.source_id,
            message_id: r.get("message_id"),
            file_name: r.get("file_name"),
            mime_type: r.get("mime_type"),
            total_bytes: data.len() as i64,
            sha256: Some(digest),
        },
        offset_bytes: i.offset_bytes,
        data_base64: STANDARD.encode(&data[i.offset_bytes as usize..end]),
        next_offset_bytes: (end < data.len()).then_some(end as i64),
    };
    commit(t, &i.scope, &effect_deadline, clock).await?;
    Ok(out)
}

fn mime_allowed(m: &str) -> bool {
    matches!(
        m,
        "text/plain"
            | "text/markdown"
            | "text/csv"
            | "text/tab-separated-values"
            | "text/html"
            | "text/css"
            | "text/javascript"
            | "application/xml"
            | "application/x-ndjson"
            | "application/javascript"
            | "application/yaml"
            | "application/x-yaml"
            | "application/json"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
    )
}
fn validate_content(m: &str, b: &[u8]) -> Result<()> {
    if b.is_empty() || b.len() as i64 > FILE || !mime_allowed(m) {
        return invalid();
    }
    match m {
        "image/png" => validate_png(b),
        "image/jpeg" => validate_jpeg(b),
        "image/gif" => validate_gif(b),
        "image/webp" => validate_webp(b),
        _ => {
            let text = std::str::from_utf8(b).map_err(|_| "validation_failed")?;
            if text
                .chars()
                .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
            {
                return invalid();
            }
            if m == "application/json" {
                serde_json::from_str::<serde_json::Value>(text).map_err(|_| "validation_failed")?;
            }
            Ok(())
        }
    }
}
fn dimensions(w: u32, h: u32) -> Result<()> {
    if w == 0 || h == 0 || w > 4096 || h > 4096 || w as u64 * h as u64 > 4_194_304 {
        invalid()
    } else {
        Ok(())
    }
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes(b.try_into().unwrap())
}
fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes(b.try_into().unwrap())
}
fn le16(b: &[u8]) -> u32 {
    u16::from_le_bytes(b.try_into().unwrap()) as u32
}
fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for v in b {
        c ^= *v as u32;
        for _ in 0..8 {
            c = (c >> 1) ^ if c & 1 != 0 { 0xedb88320 } else { 0 };
        }
    }
    !c
}
fn validate_png(b: &[u8]) -> Result<()> {
    if !b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return invalid();
    }
    let mut p = 8;
    let mut header = false;
    let mut data = false;
    let mut ended_data = false;
    while p + 12 <= b.len() {
        let n = be32(&b[p..p + 4]) as usize;
        if n > b.len() - p - 12 {
            return invalid();
        }
        let kind = &b[p + 4..p + 8];
        let payload = &b[p + 8..p + 8 + n];
        if crc32(&b[p + 4..p + 8 + n]) != be32(&b[p + 8 + n..p + 12 + n]) {
            return invalid();
        }
        match kind {
            b"IHDR" => {
                if header || p != 8 || n != 13 {
                    return invalid();
                }
                dimensions(be32(&payload[..4]), be32(&payload[4..8]))?;
                header = true;
            }
            b"IDAT" => {
                if !header || ended_data {
                    return invalid();
                }
                data = true;
            }
            b"IEND" => {
                if n != 0 || !data || p + 12 != b.len() {
                    return invalid();
                }
                return tauri::image::Image::from_bytes(b)
                    .map(|_| ())
                    .map_err(|_| "validation_failed".into());
            }
            b"acTL" | b"fcTL" | b"fdAT" => return invalid(),
            _ => {
                if data {
                    ended_data = true;
                }
                if kind[0] & 32 == 0 && kind != b"PLTE" {
                    return invalid();
                }
            }
        }
        p += 12 + n;
    }
    invalid()
}
fn validate_jpeg(b: &[u8]) -> Result<()> {
    if !b.starts_with(&[255, 216]) || !b.ends_with(&[255, 217]) {
        return invalid();
    }
    let mut p = 2;
    let mut frame = false;
    let mut scan = false;
    while p < b.len() {
        if b[p] != 255 {
            return invalid();
        }
        while p < b.len() && b[p] == 255 {
            p += 1;
        }
        if p >= b.len() {
            return invalid();
        }
        let marker = b[p];
        p += 1;
        if marker == 217 {
            return if frame && scan && p == b.len() {
                Ok(())
            } else {
                invalid()
            };
        }
        if marker == 0 || marker == 216 || (208..=215).contains(&marker) || p + 2 > b.len() {
            return invalid();
        }
        let n = u16::from_be_bytes([b[p], b[p + 1]]) as usize;
        if n < 2 || p + n > b.len() {
            return invalid();
        }
        if matches!(marker, 192 | 193 | 194) {
            if frame || n < 11 {
                return invalid();
            }
            dimensions(
                u16::from_be_bytes([b[p + 5], b[p + 6]]) as u32,
                u16::from_be_bytes([b[p + 3], b[p + 4]]) as u32,
            )?;
            if n != 8 + 3 * b[p + 7] as usize || b[p + 2] != 8 {
                return invalid();
            }
            frame = true;
        }
        if marker == 218 {
            if !frame || n < 8 || n != 6 + 2 * b[p + 2] as usize {
                return invalid();
            }
            scan = true;
            p += n;
            let start = p;
            while p + 1 < b.len() {
                if b[p] == 255 {
                    if b[p + 1] == 0 || (208..=215).contains(&b[p + 1]) {
                        p += 2;
                        continue;
                    }
                    break;
                }
                p += 1;
            }
            if p == start {
                return invalid();
            }
            continue;
        }
        p += n;
    }
    invalid()
}
fn gif_blocks(b: &[u8], p: &mut usize) -> Result<()> {
    loop {
        if *p >= b.len() {
            return invalid();
        }
        let n = b[*p] as usize;
        *p += 1;
        if n == 0 {
            return Ok(());
        }
        if n > b.len() - *p {
            return invalid();
        }
        *p += n;
    }
}
fn validate_gif(b: &[u8]) -> Result<()> {
    if b.len() < 14 || !(b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return invalid();
    }
    dimensions(le16(&b[6..8]), le16(&b[8..10]))?;
    let mut p = 13;
    if b[10] & 128 != 0 {
        p += 3 * (1usize << ((b[10] & 7) + 1));
    }
    let mut images = 0;
    while p < b.len() {
        let tag = b[p];
        p += 1;
        match tag {
            59 => {
                return if images > 0 && p == b.len() {
                    Ok(())
                } else {
                    invalid()
                }
            }
            33 => {
                if p >= b.len() {
                    return invalid();
                }
                p += 1;
                gif_blocks(b, &mut p)?;
            }
            44 => {
                if p + 9 > b.len() {
                    return invalid();
                }
                dimensions(le16(&b[p + 4..p + 6]), le16(&b[p + 6..p + 8]))?;
                let flags = b[p + 8];
                p += 9;
                if flags & 128 != 0 {
                    p += 3 * (1usize << ((flags & 7) + 1));
                }
                if p >= b.len() || !(2..=8).contains(&b[p]) {
                    return invalid();
                }
                p += 1;
                // Image data needs a nonempty first sub-block; a terminator
                // alone is not an encoded frame. Extensions may be empty.
                if p >= b.len() || b[p] == 0 {
                    return invalid();
                }
                gif_blocks(b, &mut p)?;
                images += 1;
                if images > 32 {
                    return invalid();
                }
            }
            _ => return invalid(),
        }
    }
    invalid()
}
fn validate_webp(b: &[u8]) -> Result<()> {
    if b.len() < 20
        || &b[..4] != b"RIFF"
        || &b[8..12] != b"WEBP"
        || le32(&b[4..8]) as usize != b.len() - 8
    {
        return invalid();
    }
    let mut p = 12;
    let mut image = false;
    while p + 8 <= b.len() {
        let n = le32(&b[p + 4..p + 8]) as usize;
        if n > b.len() - p - 8 {
            return invalid();
        }
        let body = &b[p + 8..p + 8 + n];
        match &b[p..p + 4] {
            b"VP8 " => {
                if image || n < 10 || body[0] & 1 != 0 || body[3..6] != [157, 1, 42] {
                    return invalid();
                }
                dimensions(le16(&body[6..8]) & 16383, le16(&body[8..10]) & 16383)?;
                image = true;
            }
            b"VP8L" => {
                if image || n < 6 || body[0] != 47 {
                    return invalid();
                }
                let v = le32(&body[1..5]);
                if v >> 29 != 0 {
                    return invalid();
                }
                dimensions((v & 16383) + 1, ((v >> 14) & 16383) + 1)?;
                image = true;
            }
            b"VP8X" => {
                if p != 12 || n != 10 || body[0] & 2 != 0 {
                    return invalid();
                }
                let w = body[4] as u32 | ((body[5] as u32) << 8) | ((body[6] as u32) << 16);
                let h = body[7] as u32 | ((body[8] as u32) << 8) | ((body[9] as u32) << 16);
                dimensions(w + 1, h + 1)?;
            }
            b"ALPH" | b"ICCP" | b"EXIF" | b"XMP " => {}
            _ => return invalid(),
        }
        p += 8 + n + (n & 1);
    }
    if image && p == b.len() {
        Ok(())
    } else {
        invalid()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotFileContextState {
    Ready,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PilotInspectAttachmentsInput {
    pub scope: PilotFileScope,
    pub execute_before: String,
    pub attachment_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PilotAttachmentMetadata {
    pub attachment_id: String,
    pub mime_type: String,
    pub file_name: String,
    pub total_bytes: i64,
    pub sha256: String,
}
pub async fn inspect_attachments(
    pool: &SqlitePool,
    i: PilotInspectAttachmentsInput,
    clock: Clock<'_>,
) -> Result<Vec<PilotAttachmentMetadata>> {
    if i.attachment_ids.is_empty() || i.attachment_ids.len() > 10 {
        return invalid();
    }
    let mut t = tx(pool).await?;
    cleanup(&mut t, &i.scope, &i.execute_before, clock).await?;
    let mut total = 0;
    let mut seen = HashSet::new();
    let mut batch: Option<String> = None;
    let mut out = vec![];
    for a in i.attachment_ids {
        id(&a)?;
        if !seen.insert(a.clone()) {
            return invalid();
        }
        let r=sqlx::query("SELECT attachment_id,file_name,mime_type,total_bytes,sha256,batch_id FROM pilot_file_transfers WHERE attachment_id=? AND scope_key=? AND state='finalized'").bind(&a).bind(json(&i.scope)?).fetch_optional(&mut *t).await.map_err(db)?.ok_or("not_found")?;
        total += r.get::<i64, _>("total_bytes");
        if total > BATCH_BYTES {
            return Err("resource_limit".into());
        }
        let b: String = r.get("batch_id");
        if batch.as_ref().is_some_and(|v| v != &b) {
            return Err("scope_mismatch".into());
        }
        batch = Some(b);
        out.push(PilotAttachmentMetadata {
            attachment_id: a,
            mime_type: r.get("mime_type"),
            file_name: r.get("file_name"),
            total_bytes: r.get("total_bytes"),
            sha256: r.get("sha256"),
        });
    }
    commit(t, &i.scope, &i.execute_before, clock).await?;
    Ok(out)
}

async fn receipt_guard(
    t: &mut Tx<'_>,
    s: &PilotFileScope,
    d: &str,
    clock: Clock<'_>,
) -> Result<()> {
    scope_valid(s)?;
    deadline(d, clock)?;
    let allowed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pilot_file_authorities WHERE owner_key=? AND binding=? AND active=1",
    )
    .bind(owner(s)?)
    .bind(&s.authority_binding)
    .fetch_one(&mut **t)
    .await
    .map_err(db)?;
    if allowed != 1 {
        return Err("unauthorized".into());
    }
    target_with_archive(t, s, true).await?;
    deadline(d, clock)
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotFileSourceKind {
    Attachment,
    MessageImage,
    Citation,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotCitationScope {
    Context,
    Source,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotFileContentState {
    Available,
    TooLarge,
    Unavailable,
}
fn citation_scope(s: &str) -> Result<PilotCitationScope> {
    match s {
        "context" => Ok(PilotCitationScope::Context),
        "source" => Ok(PilotCitationScope::Source),
        _ => Err("validation_failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    const START: i64 = 1_800_000_000_000;
    async fn fixture() -> (SqlitePool, PilotFileScope, AtomicI64) {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&p)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/001_initial.sql"))
            .execute(&p)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE messages ADD COLUMN generation_attempts_json TEXT")
            .execute(&p)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/007_conversation_management.sql"))
            .execute(&p)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/012_pilot_files.sql"))
            .execute(&p)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/015_inactive_storage.sql"))
            .execute(&p)
            .await
            .unwrap();
        // This manual historical fixture needs the real missing runtime table
        // before the source-version triggers and shared preparation domain.
        crate::db::ensure_conversation_compactions(&mut *p.acquire().await.unwrap())
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/016_source_capture.sql"))
            .execute(&p)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES ('conversation','Synthetic','Chat','now','now')").execute(&p).await.unwrap();
        let s = PilotFileScope {
            account_id: "account".into(),
            session_id: "session".into(),
            instance_id: "instance".into(),
            authority_binding: "generation-1".into(),
            r#ref: PilotFileRef {
                conversation_id: "conversation".into(),
                conversation_kind: PilotConversationKind::Chat,
                workspace_id: Some("workspace:configuration".into()),
                project_id: None,
                task_id: None,
            },
        };
        let time = AtomicI64::new(START);
        auth(&p, &s, true, &|| time.load(Ordering::SeqCst)).await;
        (p, s, time)
    }
    fn d() -> String {
        date(START + 60 * 60 * 1000).unwrap()
    }
    async fn auth(p: &SqlitePool, s: &PilotFileScope, active: bool, c: Clock<'_>) {
        authorize(
            p,
            PilotFileAuthorizeInput {
                scope: s.clone(),
                execute_before: d(),
                active,
            },
            c,
        )
        .await
        .unwrap();
    }
    fn b(s: &PilotFileScope, intent: &str, batch: &str, content: &[u8]) -> PilotFileBeginInput {
        PilotFileBeginInput {
            scope: s.clone(),
            execute_before: d(),
            intent_id: intent.into(),
            batch_id: batch.into(),
            file_name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            total_bytes: content.len() as i64,
            sha256: hash(content),
            intent_expires_at: date(START + ABSOLUTE_MS).unwrap(),
        }
    }
    fn transfer_input(s: &PilotFileScope, id: &str) -> PilotFileTransferInput {
        PilotFileTransferInput {
            scope: s.clone(),
            execute_before: d(),
            transfer_id: id.into(),
        }
    }
    async fn upload(
        p: &SqlitePool,
        s: &PilotFileScope,
        intent: &str,
        batch: &str,
        bytes: &[u8],
        c: Clock<'_>,
    ) -> PilotFileReceipt {
        let r = begin(p, b(s, intent, batch, bytes), c).await.unwrap();
        for (index, part) in bytes.chunks(CHUNK).enumerate() {
            chunk(
                p,
                PilotFileChunkInput {
                    scope: s.clone(),
                    execute_before: d(),
                    transfer_id: r.transfer_id.clone(),
                    offset_bytes: (index * CHUNK) as i64,
                    data_base64: STANDARD.encode(part),
                    sha256: hash(part),
                },
                c,
            )
            .await
            .unwrap();
        }
        finalize(p, transfer_input(s, &r.transfer_id), c)
            .await
            .unwrap()
    }
    fn prep(s: &PilotFileScope, a: &str) -> PilotPrepareSendInput {
        PilotPrepareSendInput {
            scope: s.clone(),
            execute_before: d(),
            intent_expires_at: date(START + ABSOLUTE_MS).unwrap(),
            send_intent_id: "send-intent".into(),
            content: "Review this".into(),
            attachment_ids: vec![a.into()],
            expected_revision: 1,
        }
    }
    #[tokio::test]
    async fn intent_offsets_and_digest_are_immutable_and_replays_do_not_extend_idle() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let input = b(&s, "intent", "batch", b"abc");
        let r = begin(&p, input.clone(), &c).await.unwrap();
        let mut conflict = input.clone();
        conflict.file_name = "other.txt".into();
        assert_eq!(
            begin(&p, conflict, &c).await.unwrap_err(),
            "intent_conflict"
        );
        let mut ch = PilotFileChunkInput {
            scope: s.clone(),
            execute_before: d(),
            transfer_id: r.transfer_id.clone(),
            offset_bytes: 1,
            data_base64: STANDARD.encode(b"abc"),
            sha256: hash(b"abc"),
        };
        assert!(chunk(&p, ch.clone(), &c).await.is_err());
        ch.offset_bytes = 0;
        chunk(&p, ch.clone(), &c).await.unwrap();
        time.store(START + IDLE_MS - 1, Ordering::SeqCst);
        chunk(&p, ch.clone(), &c).await.unwrap();
        begin(&p, input, &c).await.unwrap();
        time.store(START + IDLE_MS, Ordering::SeqCst);
        let expired = status(&p, transfer_input(&s, &r.transfer_id), &c)
            .await
            .unwrap();
        assert_eq!(expired.state, PilotFileState::Expired);
        let bytes: i64 =
            sqlx::query_scalar("SELECT length(data) FROM pilot_file_transfers WHERE id=?")
                .bind(&r.transfer_id)
                .fetch_one(&p)
                .await
                .unwrap();
        assert_eq!(bytes, 0);
    }
    #[tokio::test]
    async fn quotas_reserve_before_bytes_and_include_finalized_orphans() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        for n in 0..4 {
            let mut i = b(&s, &format!("file-{n}"), "batch", b"x");
            i.total_bytes = FILE;
            begin(&p, i, &c).await.unwrap();
        }
        let mut i = b(&s, "fifth", "batch", b"x");
        i.total_bytes = FILE;
        assert_eq!(begin(&p, i, &c).await.unwrap_err(), "resource_limit");
        let bytes: i64 = sqlx::query_scalar("SELECT SUM(length(data)) FROM pilot_file_transfers")
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(bytes, 0);
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "orphan", "batch", b"abc", &c).await;
        for n in 0..15 {
            begin(
                &p,
                b(&s, &format!("n-{n}"), &format!("batch-{n}"), b"x"),
                &c,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            begin(&p, b(&s, "extra", "extra", b"x"), &c)
                .await
                .unwrap_err(),
            "resource_limit"
        );
        assert_eq!(
            status(&p, transfer_input(&s, &r.transfer_id), &c)
                .await
                .unwrap()
                .state,
            PilotFileState::Finalized
        );
    }
    #[tokio::test]
    async fn exact_scope_revocation_and_restoration_reject_old_transfers() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = begin(&p, b(&s, "intent", "batch", b"abc"), &c)
            .await
            .unwrap();
        let mut other = s.clone();
        other.account_id = "other".into();
        assert_eq!(
            status(&p, transfer_input(&other, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "unauthorized"
        );
        auth(&p, &s, false, &c).await;
        assert_eq!(
            status(&p, transfer_input(&s, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "unauthorized"
        );
        assert_eq!(
            authorize(
                &p,
                PilotFileAuthorizeInput {
                    scope: s.clone(),
                    execute_before: d(),
                    active: true
                },
                &c
            )
            .await
            .unwrap_err(),
            "unauthorized"
        );
        let mut restored = s.clone();
        restored.authority_binding = "generation-2".into();
        auth(&p, &restored, true, &c).await;
        assert_eq!(
            status(&p, transfer_input(&restored, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "not_found"
        );
        assert_eq!(
            status(&p, transfer_input(&s, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "unauthorized"
        );
    }
    #[tokio::test]
    async fn expired_commit_rolls_back_all_effects() {
        let (p, s, _) = fixture().await;
        let calls = AtomicI64::new(0);
        let c = || {
            if calls.fetch_add(1, Ordering::SeqCst) > 12 {
                START + 60 * 60 * 1000
            } else {
                START
            }
        };
        assert!(begin(&p, b(&s, "intent", "batch", b"abc"), &c)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pilot_file_transfers")
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn atomic_send_receipts_real_context_and_confirmed_assistant_cas() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "upload", "batch", b"hello", &c).await;
        let i = prep(&s, r.attachment_id.as_ref().unwrap());
        let inspection = inspect_attachments(
            &p,
            PilotInspectAttachmentsInput {
                scope: s.clone(),
                execute_before: d(),
                attachment_ids: i.attachment_ids.clone(),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(inspection.len(), 1);
        let out = prepare_send(&p, i.clone(), &c).await.unwrap();
        assert_eq!(out.message.id, out.receipt.message_id);
        assert_eq!(
            out.message.turn_id.as_deref(),
            Some(out.receipt.turn_id.as_str())
        );
        assert_eq!(out.citations[0].message_id, out.message.id);
        assert_eq!(out.citations[0].source, "pilot_attachment");
        assert_eq!(
            out.citations[0].path.as_deref(),
            Some(format!("attachment://{}", out.receipt.attachment_ids[0]).as_str())
        );
        assert_eq!(out.context_refs[0].content, "hello");
        let persisted_refs: serde_json::Value =
            serde_json::from_str(out.message.context_refs_json.as_deref().unwrap()).unwrap();
        assert_eq!(persisted_refs[0]["kind"], "file");
        assert_eq!(
            persisted_refs[0]["path"],
            format!("attachment://{}", i.attachment_ids[0])
        );
        let replay = prepare_send(&p, i.clone(), &c).await.unwrap();
        assert_eq!(out.receipt.message_id, replay.receipt.message_id);
        let mut changed_expiry = i.clone();
        changed_expiry.intent_expires_at = date(START + 14 * 60 * 1000).unwrap();
        assert_eq!(
            prepare_send(&p, changed_expiry, &c).await.unwrap_err(),
            "intent_conflict"
        );
        let mut mismatch = i.clone();
        mismatch.content = "changed".into();
        assert_eq!(
            prepare_send(&p, mismatch, &c).await.unwrap_err(),
            "intent_conflict"
        );
        let mark = PilotSendMarkInput {
            scope: s.clone(),
            execute_before: d(),
            send_intent_id: i.send_intent_id.clone(),
            expected_revision: 1,
            state: PilotSendState::LaunchUncertain,
            user_message_id: out.message.id.clone(),
            assistant_message_id: None,
        };
        let uncertain = send_mark(&p, mark.clone(), &c).await.unwrap();
        assert_eq!(uncertain.state, PilotSendState::LaunchUncertain);
        assert_eq!(uncertain.revision, 2);
        assert_eq!(
            send_mark(&p, mark.clone(), &c).await.unwrap_err(),
            "stale_revision"
        );
        let mut confirm = mark;
        confirm.expected_revision = 2;
        confirm.state = PilotSendState::Confirmed;
        confirm.assistant_message_id = Some("assistant".into());
        assert_eq!(
            send_mark(&p, confirm.clone(), &c).await.unwrap_err(),
            "not_found"
        );
        sqlx::query("INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES ('assistant','conversation','wrong','assistant','','now')").execute(&p).await.unwrap();
        assert_eq!(
            send_mark(&p, confirm.clone(), &c).await.unwrap_err(),
            "not_found"
        );
        sqlx::query("UPDATE messages SET turn_id=? WHERE id='assistant'")
            .bind(&out.receipt.turn_id)
            .execute(&p)
            .await
            .unwrap();
        let confirmed = send_mark(&p, confirm, &c).await.unwrap();
        assert_eq!(confirmed.state, PilotSendState::Confirmed);
        assert_eq!(confirmed.assistant_message_id.as_deref(), Some("assistant"));
        auth(&p, &s, false, &c).await;
        let mut restored = s.clone();
        restored.authority_binding = "new".into();
        auth(&p, &restored, true, &c).await;
        sqlx::query(
            "UPDATE conversation_management SET archived=1 WHERE conversation_id='conversation'",
        )
        .execute(&p)
        .await
        .unwrap();
        let reconciled = send_read(
            &p,
            PilotSendReadInput {
                scope: restored.clone(),
                execute_before: d(),
                send_intent_id: i.send_intent_id.clone(),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(reconciled.message_id, out.message.id);
        assert!(prepare_send(
            &p,
            PilotPrepareSendInput {
                scope: restored,
                ..i
            },
            &c
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn abort_frees_bytes_and_never_removes_attached_data() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "intent", "batch", b"abc", &c).await;
        let out = prepare_send(&p, prep(&s, r.attachment_id.as_ref().unwrap()), &c)
            .await
            .unwrap();
        assert_eq!(
            abort(&p, transfer_input(&s, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "intent_conflict"
        );
        time.store(START + ABSOLUTE_MS * 2 + 1, Ordering::SeqCst);
        let mut next = b(&s, "next", "next", b"abc");
        next.intent_expires_at = date(time.load(Ordering::SeqCst) + ABSOLUTE_MS).unwrap();
        begin(&p, next, &c).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pilot_file_transfers WHERE id=?")
            .bind(&r.transfer_id)
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let bytes: Vec<u8> =
            sqlx::query_scalar("SELECT data FROM pilot_message_attachments WHERE message_id=?")
                .bind(out.message.id)
                .fetch_one(&p)
                .await
                .unwrap();
        assert_eq!(bytes, b"abc");
    }
    #[tokio::test]
    async fn opaque_catalog_provenance_digest_and_five_minute_expiry() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "intent", "batch", b"hello", &c).await;
        prepare_send(&p, prep(&s, r.attachment_id.as_ref().unwrap()), &c)
            .await
            .unwrap();
        let g = PilotFileGuard {
            scope: s.clone(),
            execute_before: d(),
        };
        let entries = list(&p, g.clone(), &c).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(matches!(
            entries[0].source_kind,
            PilotFileSourceKind::Attachment
        ));
        let read_input = PilotFileReadInput {
            scope: s.clone(),
            execute_before: d(),
            source_id: entries[0].source_id.clone(),
            offset_bytes: 0,
        };
        assert_eq!(
            STANDARD
                .decode(read(&p, read_input.clone(), &c).await.unwrap().data_base64)
                .unwrap(),
            b"hello"
        );
        let mut arbitrary = read_input.clone();
        arbitrary.source_id = "/tmp/private.txt".into();
        assert_eq!(read(&p, arbitrary, &c).await.unwrap_err(), "not_found");
        time.store(START + 5 * 60 * 1000 - 1, Ordering::SeqCst);
        assert_eq!(
            list(&p, g, &c).await.unwrap()[0].source_id,
            entries[0].source_id
        );
        time.store(START + 5 * 60 * 1000, Ordering::SeqCst);
        assert_eq!(read(&p, read_input, &c).await.unwrap_err(), "not_found");
    }
    #[test]
    fn strict_utf8_mime_and_image_container_rejection() {
        assert!(validate_content("text/plain", b"\xff").is_err());
        assert!(validate_content("text/plain", b"a\0b").is_err());
        assert!(validate_content("text/plain", "é\n".as_bytes()).is_ok());
        for (mime, data) in [
            ("image/png", &b"\x89PNG\r\n\x1a\n"[..]),
            ("image/jpeg", &[255, 216, 255, 217][..]),
            ("image/gif", &b"GIF89a"[..]),
            ("image/webp", &b"RIFF0000WEBP"[..]),
        ] {
            assert!(validate_content(mime, data).is_err());
        }
    }
    #[tokio::test]
    async fn expired_local_revoke_preserves_new_binding_and_cleanup_needs_no_requests() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "intent", "batch", b"abc", &c).await;
        let revoke = PilotFileAuthorizeInput {
            scope: s.clone(),
            execute_before: date(START - 1).unwrap(),
            active: false,
        };
        authorize(&p, revoke.clone(), &c).await.unwrap();
        let mut new = s.clone();
        new.authority_binding = "restored".into();
        auth(&p, &new, true, &c).await;
        assert_eq!(authorize(&p, revoke, &c).await.unwrap_err(), "unauthorized");
        time.store(START + IDLE_MS, Ordering::SeqCst);
        expire_staging(&p, &c).await.unwrap();
        let state: (String, i64) =
            sqlx::query_as("SELECT state,length(data) FROM pilot_file_transfers WHERE id=?")
                .bind(&r.transfer_id)
                .fetch_one(&p)
                .await
                .unwrap();
        assert_eq!(state, ("expired".into(), 0));
        time.store(START + ABSOLUTE_MS, Ordering::SeqCst);
        expire_staging(&p, &c).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pilot_file_transfers")
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn current_other_mobile_reads_attached_messages_but_cannot_read_old_uploads() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let r = upload(&p, &s, "intent", "batch", b"local message context", &c).await;
        let sent = prepare_send(&p, prep(&s, r.attachment_id.as_ref().unwrap()), &c)
            .await
            .unwrap();
        auth(&p, &s, false, &c).await;
        let mut mobile = s.clone();
        mobile.account_id = "other-account".into();
        mobile.session_id = "other-mobile".into();
        mobile.authority_binding = "other-generation".into();
        auth(&p, &mobile, true, &c).await;
        assert_eq!(
            status(&p, transfer_input(&mobile, &r.transfer_id), &c)
                .await
                .unwrap_err(),
            "not_found"
        );
        let entries = list(
            &p,
            PilotFileGuard {
                scope: mobile.clone(),
                execute_before: d(),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message_id, sent.message.id);
        let bytes = read(
            &p,
            PilotFileReadInput {
                scope: mobile,
                execute_before: d(),
                source_id: entries[0].source_id.clone(),
                offset_bytes: 0,
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(
            STANDARD.decode(bytes.data_base64).unwrap(),
            b"local message context"
        );
    }
    #[tokio::test]
    async fn toolbox_citations_use_conversation_authority_without_a_message() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,content,path,created_at,updated_at) VALUES ('toolbox','conversation','manual-synthetic','file','context','manual','Notes','Toolbox bytes','attachment://manual-synthetic/notes.txt','now','now')").execute(&p).await.unwrap();
        let entries = list(
            &p,
            PilotFileGuard {
                scope: s.clone(),
                execute_before: d(),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].message_id.is_empty());
        assert_eq!(entries[0].citation_id.as_deref(), Some("toolbox"));
        assert!(matches!(
            entries[0].citation_scope.as_ref(),
            Some(PilotCitationScope::Context)
        ));
        let input = PilotFileReadInput {
            scope: s.clone(),
            execute_before: d(),
            source_id: entries[0].source_id.clone(),
            offset_bytes: 0,
        };
        let bytes = read(&p, input.clone(), &c).await.unwrap();
        assert!(bytes.source.message_id.is_empty());
        assert_eq!(
            STANDARD.decode(bytes.data_base64).unwrap(),
            b"Toolbox bytes"
        );
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES ('other','Other','Chat','now','now')").execute(&p).await.unwrap();
        sqlx::query("UPDATE conversation_citations SET conversation_id='other' WHERE id='toolbox'")
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(read(&p, input, &c).await.unwrap_err(), "not_found");
    }
    #[tokio::test]
    async fn large_citations_are_metadata_only_and_changed_bytes_invalidate_attestation() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES ('source-message','conversation','assistant','','now')").execute(&p).await.unwrap();
        for (id, content) in [
            ("large", "x".repeat(FILE as usize + 1)),
            ("small", "original".into()),
        ] {
            sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,content,path,created_at,updated_at) VALUES (?,'conversation','source-message','file','source','synthetic','Source',?,'/untrusted/path','now','now')").bind(id).bind(content).execute(&p).await.unwrap();
        }
        let entries = list(
            &p,
            PilotFileGuard {
                scope: s.clone(),
                execute_before: d(),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        let large = entries
            .iter()
            .find(|v| v.citation_id.as_deref() == Some("large"))
            .unwrap();
        assert!(matches!(
            large.content_state,
            PilotFileContentState::TooLarge
        ));
        assert!(large.sha256.is_none());
        let small = entries
            .iter()
            .find(|v| v.citation_id.as_deref() == Some("small"))
            .unwrap();
        assert!(matches!(
            small.citation_scope,
            Some(PilotCitationScope::Source)
        ));
        sqlx::query("UPDATE conversation_citations SET content='changed' WHERE id='small'")
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(
            read(
                &p,
                PilotFileReadInput {
                    scope: s,
                    execute_before: d(),
                    source_id: small.source_id.clone(),
                    offset_bytes: 0
                },
                &c
            )
            .await
            .unwrap_err(),
            "stale_revision"
        );
    }
    #[tokio::test]
    async fn instance_counts_and_session_bytes_are_reserved_before_allocation() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        for n in 0..8 {
            let mut i = b(&s, &format!("large-{n}"), &format!("batch-{n}"), b"x");
            i.total_bytes = FILE;
            begin(&p, i, &c).await.unwrap();
        }
        assert_eq!(
            begin(&p, b(&s, "byte-over", "byte-over", b"x"), &c)
                .await
                .unwrap_err(),
            "resource_limit"
        );
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        for session in 0..3 {
            let mut scope = s.clone();
            scope.session_id = format!("mobile-{session}");
            scope.authority_binding = format!("binding-{session}");
            auth(&p, &scope, true, &c).await;
            for n in 0..16 {
                let i = b(&scope, &format!("intent-{n}"), &format!("batch-{n}"), b"x");
                let out = begin(&p, i, &c).await;
                if session < 2 {
                    out.unwrap();
                } else {
                    assert_eq!(out.unwrap_err(), "resource_limit");
                    break;
                }
            }
        }
    }
    #[tokio::test]
    async fn canonical_unicode_filenames_and_mixed_attachment_order_survive_restore() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        for name in ["", "a/b", "a\\b", "a\0b"] {
            let mut i = b(&s, "bad-name", "batch", b"x");
            i.file_name = name.into();
            assert_eq!(begin(&p, i, &c).await.unwrap_err(), "validation_failed");
        }
        let mut i = b(&s, "too-many-chars", "batch", b"x");
        i.file_name = "é".repeat(121);
        assert_eq!(begin(&p, i, &c).await.unwrap_err(), "validation_failed");
        let mut i = b(&s, "max-unicode", "batch", b"x");
        i.file_name = "𠮷".repeat(120);
        let first = begin(&p, i, &c).await.unwrap();
        abort(&p, transfer_input(&s, &first.transfer_id), &c)
            .await
            .unwrap();
        let mut ids = vec![];
        for n in 0..10 {
            let bytes = if n % 2 == 0 {
                synthetic_png()
            } else {
                format!("text {n}").into_bytes()
            };
            let mut i = b(&s, &format!("mix-{n}"), "mixed-batch", &bytes);
            if n % 2 == 0 {
                i.mime_type = "image/png".into();
            }
            let r = begin(&p, i, &c).await.unwrap();
            chunk(
                &p,
                PilotFileChunkInput {
                    scope: s.clone(),
                    execute_before: d(),
                    transfer_id: r.transfer_id.clone(),
                    offset_bytes: 0,
                    data_base64: STANDARD.encode(&bytes),
                    sha256: hash(&bytes),
                },
                &c,
            )
            .await
            .unwrap();
            ids.push(
                finalize(&p, transfer_input(&s, &r.transfer_id), &c)
                    .await
                    .unwrap()
                    .attachment_id
                    .unwrap(),
            );
        }
        ids.sort();
        ids.reverse();
        let mut i = prep(&s, &ids[0]);
        i.attachment_ids = ids.clone();
        let out = prepare_send(&p, i.clone(), &c).await.unwrap();
        let image_ids = out
            .images
            .iter()
            .map(|image| image.attachment_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            image_ids,
            ids.iter()
                .filter(|id| out.images.iter().any(|image| &image.attachment_id == *id))
                .cloned()
                .collect::<Vec<_>>()
        );
        assert_eq!(out.images.len(), 5);
        assert_eq!(out.context_refs.len(), 5);
        let paths = out
            .citations
            .iter()
            .map(|citation| citation.path.clone().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), 5);
        let restored = message_images(&p, &out.message.id).await.unwrap();
        assert_eq!(
            restored
                .iter()
                .map(|image| image.attachment_id.clone())
                .collect::<Vec<_>>(),
            image_ids
        );
        sqlx::query("UPDATE conversation_citations SET content='changed' WHERE id=?")
            .bind(&out.citations[0].id)
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(
            prepare_send(&p, i, &c).await.unwrap_err(),
            "integrity_failed"
        );
    }

    #[test]
    fn gif_frames_require_image_payload() {
        let empty = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;";
        let valid = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00;";
        assert_eq!(validate_gif(empty).unwrap_err(), "validation_failed");
        assert!(validate_gif(valid).is_ok());
        for length in 0..valid.len() {
            assert!(validate_gif(&valid[..length]).is_err());
        }
    }
    #[tokio::test]
    async fn empty_gif_cannot_be_finalized_or_associated() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let bytes = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;";
        let mut input = b(&s, "empty-gif", "batch", bytes);
        input.mime_type = "image/gif".into();
        input.file_name = "empty.gif".into();
        let begun = begin(&p, input, &c).await.unwrap();
        chunk(
            &p,
            PilotFileChunkInput {
                scope: s.clone(),
                execute_before: d(),
                transfer_id: begun.transfer_id.clone(),
                offset_bytes: 0,
                data_base64: STANDARD.encode(bytes),
                sha256: hash(bytes),
            },
            &c,
        )
        .await
        .unwrap();
        assert_eq!(
            finalize(&p, transfer_input(&s, &begun.transfer_id), &c)
                .await
                .unwrap_err(),
            "validation_failed"
        );
        let receipt = status(&p, transfer_input(&s, &begun.transfer_id), &c)
            .await
            .unwrap();
        assert_eq!(receipt.state, PilotFileState::Receiving);
        assert!(receipt.attachment_id.is_none());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pilot_message_attachments")
                .fetch_one(&p)
                .await
                .unwrap(),
            0
        );
    }
    fn synthetic_png() -> Vec<u8> {
        use std::io::Write;
        fn part(bytes: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
            let mut crc_input = kind.to_vec();
            crc_input.extend_from_slice(data);
            bytes.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        }
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut header = vec![];
        header.extend_from_slice(&1u32.to_be_bytes());
        header.extend_from_slice(&1u32.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        part(&mut bytes, b"IHDR", &header);
        let mut z = flate2::write::ZlibEncoder::new(vec![], flate2::Compression::default());
        z.write_all(&[0, 64, 128, 255, 255]).unwrap();
        part(&mut bytes, b"IDAT", &z.finish().unwrap());
        part(&mut bytes, b"IEND", &[]);
        bytes
    }
    #[tokio::test]
    async fn sqlite_image_bytes_restore_without_upload_authority_or_cache() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let bytes = synthetic_png();
        assert!(validate_content("image/png", &bytes).is_ok());
        let mut input = b(&s, "image", "batch", &bytes);
        input.mime_type = "image/png".into();
        input.file_name = "synthetic.png".into();
        let begun = begin(&p, input, &c).await.unwrap();
        chunk(
            &p,
            PilotFileChunkInput {
                scope: s.clone(),
                execute_before: d(),
                transfer_id: begun.transfer_id.clone(),
                offset_bytes: 0,
                data_base64: STANDARD.encode(&bytes),
                sha256: hash(&bytes),
            },
            &c,
        )
        .await
        .unwrap();
        let r = finalize(&p, transfer_input(&s, &begun.transfer_id), &c)
            .await
            .unwrap();
        let send = prepare_send(&p, prep(&s, r.attachment_id.as_ref().unwrap()), &c)
            .await
            .unwrap();
        assert_eq!(send.images.len(), 1);
        assert!(send.citations.is_empty());
        auth(&p, &s, false, &c).await;
        let images = message_images(&p, &send.message.id).await.unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].ready_data_url, send.images[0].ready_data_url);
        assert_eq!(
            message_images(&p, "not-a-message").await.unwrap_err(),
            "not_found"
        );
        sqlx::query("UPDATE pilot_message_attachments SET total_bytes=? WHERE message_id=?")
            .bind(BATCH_BYTES + 1)
            .bind(&send.message.id)
            .execute(&p)
            .await
            .unwrap();
        assert_eq!(
            message_images(&p, &send.message.id).await.unwrap_err(),
            "resource_limit"
        );
    }
    #[tokio::test]
    async fn finalized_expiry_and_abort_clear_attachment_ids_in_canonical_receipts() {
        let (p, s, time) = fixture().await;
        let c = || time.load(Ordering::SeqCst);
        let finalized = upload(&p, &s, "expires", "batch", b"abc", &c).await;
        let abortable = upload(&p, &s, "aborts", "batch", b"def", &c).await;
        assert!(finalized.attachment_id.is_some());
        let aborted = abort(&p, transfer_input(&s, &abortable.transfer_id), &c)
            .await
            .unwrap();
        assert_eq!(aborted.state, PilotFileState::Aborted);
        assert!(aborted.attachment_id.is_none());
        assert_eq!(aborted.received_bytes, 3);
        time.store(START + IDLE_MS, Ordering::SeqCst);
        let expired = status(&p, transfer_input(&s, &finalized.transfer_id), &c)
            .await
            .unwrap();
        assert_eq!(expired.state, PilotFileState::Expired);
        assert!(expired.attachment_id.is_none());
        assert_eq!(expired.received_bytes, 3);
        assert_eq!(expired.total_bytes, 3);
        assert_eq!(expired.sha256, hash(b"abc"));
    }
}

/// Time-only maintenance touches staging and opaque source receipts. Attached
/// message bytes and durable send identities are retained with their messages.
pub async fn expire_staging(pool: &SqlitePool, clock: Clock<'_>) -> Result<()> {
    let mut t = tx(pool).await?;
    let now = clock();
    sqlx::query("UPDATE pilot_file_transfers SET state='expired',data=X'',attachment_id=NULL WHERE state IN ('receiving','finalized') AND (expires_at<=? OR last_progress_at<=?)").bind(now).bind(now-IDLE_MS).execute(&mut *t).await.map_err(db)?;
    sqlx::query("DELETE FROM pilot_file_chunks WHERE transfer_id IN (SELECT id FROM pilot_file_transfers WHERE state IN ('aborted','expired'))").execute(&mut *t).await.map_err(db)?;
    sqlx::query("DELETE FROM pilot_file_transfers WHERE expires_at<=?")
        .bind(now)
        .execute(&mut *t)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM pilot_file_sources WHERE expires_at<=?")
        .bind(now)
        .execute(&mut *t)
        .await
        .map_err(db)?;
    t.commit().await.map_err(db)
}

// Reserve the complete representation before encoding, without a second
// temporary base64 String. Aggregate raw-image limits are checked by callers.
fn image_data_url(mime: &str, bytes: &[u8]) -> Result<String> {
    if bytes.is_empty()
        || bytes.len() > FILE as usize
        || !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
    {
        return Err("integrity_failed".into());
    }
    let mut out = String::with_capacity(mime.len() + 13 + 4 * bytes.len().div_ceil(3));
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");
    STANDARD.encode_string(bytes, &mut out);
    Ok(out)
}

/// Local display/replay hydration, not a remotely addressable filesystem read.
pub async fn message_images(pool: &SqlitePool, message_id: &str) -> Result<Vec<PilotFileImage>> {
    id(message_id)?;
    let mut t = tx(pool).await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id=? AND role='user'")
            .bind(message_id)
            .fetch_one(&mut *t)
            .await
            .map_err(db)?;
    if exists != 1 {
        return Err("not_found".into());
    }
    let bounds=sqlx::query("SELECT COUNT(*) AS count,COALESCE(SUM(total_bytes),0) AS total,COALESCE(SUM(length(data)),0) AS actual,COALESCE(MAX(length(data)),0) AS maximum,COALESCE(SUM(CASE WHEN length(data)<>total_bytes OR total_bytes<1 OR length(file_name)>120 OR length(CAST(file_name AS BLOB))>480 OR mime_type NOT IN ('text/plain','text/markdown','text/csv','text/tab-separated-values','text/html','text/css','text/javascript','application/json','application/xml','application/x-ndjson','application/javascript','application/yaml','application/x-yaml','image/png','image/jpeg','image/gif','image/webp') THEN 1 ELSE 0 END),0) AS invalid FROM pilot_message_attachments WHERE message_id=?").bind(message_id).fetch_one(&mut *t).await.map_err(db)?;
    if bounds.get::<i64, _>("count") > 10
        || bounds.get::<i64, _>("total") > BATCH_BYTES
        || bounds.get::<i64, _>("actual") > BATCH_BYTES
        || bounds.get::<i64, _>("maximum") > FILE
        || bounds.get::<i64, _>("invalid") != 0
    {
        return Err("resource_limit".into());
    }
    let rows=sqlx::query("SELECT a.id,a.file_name,a.mime_type,a.sha256,a.data FROM pilot_message_attachments a JOIN pilot_file_sends s ON s.message_id=a.message_id JOIN json_each(s.attachment_ids_json) ordering ON ordering.value=a.id WHERE a.message_id=? AND a.mime_type IN ('image/png','image/jpeg','image/gif','image/webp') ORDER BY CAST(ordering.key AS INTEGER)").bind(message_id).fetch_all(&mut *t).await.map_err(db)?;
    let mut out = vec![];
    for r in rows {
        let mime: String = r.get("mime_type");
        let bytes: Vec<u8> = r.get("data");
        if hash(&bytes) != r.get::<String, _>("sha256") {
            return Err("integrity_failed".into());
        }
        out.push(PilotFileImage {
            attachment_id: r.get("id"),
            file_name: r.get("file_name"),
            ready_data_url: image_data_url(&mime, &bytes)?,
            mime_type: mime,
        });
    }
    t.commit().await.map_err(db)?;
    Ok(out)
}
