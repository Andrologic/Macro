use super::{DbError, DbResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Document {
    source: String,
    annexes: BTreeMap<String, String>,
    // Preserve the complete editor envelope, including unknown metadata fields.
    #[serde(flatten)]
    metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Project {
    id: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionKey {
    blueprint_id: String,
    number: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    id: String,
    project_id: String,
    name: String,
    revision: i64,
    origin: Option<VersionKey>,
    conversation_id: Option<String>,
    archived: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct Draft {
    #[serde(flatten)]
    summary: Summary,
    history: Option<serde_json::Map<String, Value>>,
    document: Document,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationResolution {
    #[serde(flatten)]
    summary: Summary,
    draft_recovery: Option<DraftRecovery>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftRecovery {
    from_conversation_id: String,
    to_conversation_id: String,
    owned: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct VersionSummary {
    #[serde(flatten)]
    key: VersionKey,
    revision: i64,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Version {
    #[serde(flatten)]
    summary: VersionSummary,
    document: Document,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Import {
    conversation_id: Option<String>,
    history: Option<serde_json::Map<String, Value>>,
    source_project_id: String,
    source_id: String,
    project_name: String,
    name: String,
    document: Document,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    project_id: String,
    blueprint_id: String,
    pub(crate) imported: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    kind: String,
    owner_id: String,
}

fn invalid(reason: &str) -> DbError {
    DbError::Validation(reason.into())
}

fn encode(document: &Document) -> DbResult<String> {
    serde_json::to_string(document).map_err(|e| invalid(&e.to_string()))
}

fn decode(row: &sqlx::sqlite::SqliteRow) -> DbResult<Document> {
    serde_json::from_str(row.try_get("document")?).map_err(|e| invalid(&e.to_string()))
}

fn summary(row: &sqlx::sqlite::SqliteRow) -> DbResult<Summary> {
    let origin_id: Option<String> = row.try_get("origin_blueprint_id")?;
    let origin = match origin_id {
        Some(blueprint_id) => Some(VersionKey {
            blueprint_id,
            number: row.try_get("origin_number")?,
        }),
        None => None,
    };
    Ok(Summary {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        revision: row.try_get("revision")?,
        conversation_id: row.try_get("conversation_id")?,
        archived: row.try_get("archived")?,
        origin,
    })
}

fn draft(row: &sqlx::sqlite::SqliteRow) -> DbResult<Draft> {
    let history: Option<&str> = row.try_get("history")?;
    Ok(Draft {
        summary: summary(row)?,
        document: decode(row)?,
        history: history
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| invalid(&e.to_string()))?,
    })
}

fn version_summary(row: &sqlx::sqlite::SqliteRow) -> DbResult<VersionSummary> {
    Ok(VersionSummary {
        key: VersionKey {
            blueprint_id: row.try_get("blueprint_id")?,
            number: row.try_get("number")?,
        },
        revision: row.try_get("revision")?,
        note: row.try_get("note")?,
    })
}

pub(crate) async fn list_projects(pool: &SqlitePool) -> DbResult<Vec<Project>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id,name FROM architect_projects ORDER BY name,id")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name)| Project { id, name })
        .collect())
}

pub(crate) async fn create_project(pool: &SqlitePool, name: String) -> DbResult<Project> {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO architect_projects(id,name) VALUES (?,?)")
        .bind(&id)
        .bind(&name)
        .execute(pool)
        .await?;
    Ok(Project { id, name })
}

pub(crate) async fn list_blueprints(
    pool: &SqlitePool,
    project_id: String,
) -> DbResult<Vec<Summary>> {
    let rows = sqlx::query(
        "SELECT id,project_id,name,revision,conversation_id,archived,origin_blueprint_id,origin_number
         FROM architect_blueprints
         WHERE project_id=?
         ORDER BY name,id",
    ).bind(project_id).fetch_all(pool).await?;
    rows.iter().map(summary).collect()
}

async fn insert_blueprint(
    db: &mut SqliteConnection,
    project_id: &str,
    name: &str,
    document: String,
    origin: Option<&VersionKey>,
    source_id: Option<&str>,
) -> DbResult<Draft> {
    let row = sqlx::query(
        "INSERT INTO architect_blueprints(id,project_id,name,document,origin_blueprint_id,origin_number,source_id)
         VALUES (?,?,?,?,?,?,?)
         RETURNING *",
    )
        .bind(Uuid::new_v4().to_string()).bind(project_id).bind(name).bind(document)
        .bind(origin.map(|key| &key.blueprint_id)).bind(origin.map(|key| key.number)).bind(source_id)
        .fetch_one(db).await?;
    draft(&row)
}

pub(crate) async fn create_blueprint(
    pool: &SqlitePool,
    project_id: String,
    name: String,
    document: Document,
) -> DbResult<Draft> {
    insert_blueprint(
        &mut *pool.acquire().await?,
        &project_id,
        &name,
        encode(&document)?,
        None,
        None,
    )
    .await
}

pub(crate) async fn get_draft(pool: &SqlitePool, blueprint_id: String) -> DbResult<Draft> {
    let row = sqlx::query("SELECT * FROM architect_blueprints WHERE id=?")
        .bind(blueprint_id)
        .fetch_one(pool)
        .await?;
    draft(&row)
}

pub(crate) async fn attach_conversation(
    pool: &SqlitePool,
    blueprint_id: String,
    conversation_id: String,
) -> DbResult<Summary> {
    // A single UPDATE serializes both sides of the ownership check with other writers.
    let row = sqlx::query(
        "UPDATE architect_blueprints SET conversation_id=?1
         WHERE id=?2 AND EXISTS (
             SELECT 1 FROM conversations WHERE id=?1 AND scope_mode='Architect' AND task_id IS NULL
         ) AND NOT EXISTS (
             SELECT 1 FROM architect_blueprints WHERE conversation_id=?1 AND id<>?2
         ) AND NOT EXISTS (
             SELECT 1 FROM app_settings WHERE key='architect:conversation-owner:' || ?1
               AND value_json<>json_quote(?2)
         ) AND NOT EXISTS (
             SELECT 1 FROM architect_blueprints WHERE json_extract(history,'$.legacyConversationId')=?1
         ) AND (conversation_id=?1 OR NOT EXISTS (
             SELECT 1 FROM conversations WHERE id=architect_blueprints.conversation_id
         ))
         RETURNING *",
    )
    .bind(conversation_id)
    .bind(blueprint_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| invalid("conversation_conflict"))?;
    summary(&row)
}

async fn available_conversation(
    db: &mut SqliteConnection,
    blueprint_id: &str,
    candidate: Option<&str>,
) -> DbResult<Option<String>> {
    let id = sqlx::query_scalar(
        "SELECT id FROM conversations
         WHERE id=?1 AND scope_mode='Architect' AND task_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM architect_blueprints WHERE conversation_id=?1 AND id<>?2)
           AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key='architect:conversation-owner:' || ?1
                           AND value_json<>json_quote(?2))",
    )
    .bind(candidate)
    .bind(blueprint_id)
    .fetch_optional(db)
    .await?;
    Ok(id)
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ArchivedMessage {
    role: String,
    content: String,
    created_at: Option<String>,
}

fn archived_transcript(draft: &Draft) -> DbResult<Vec<ArchivedMessage>> {
    let origins = draft
        .history
        .as_ref()
        .and_then(|h| h.get("origins"))
        .and_then(Value::as_array);
    let mut transcript = Vec::new();
    for raw in origins
        .into_iter()
        .flatten()
        .filter_map(|o| o.get("transcript")?.as_str())
    {
        let messages: Vec<ArchivedMessage> = raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let message: ArchivedMessage = serde_json::from_str(line)
                    .map_err(|_| invalid("invalid_archived_transcript"))?;
                if !matches!(message.role.as_str(), "assistant" | "user") {
                    return Err(invalid("invalid_archived_transcript"));
                }
                Ok(message)
            })
            .collect::<DbResult<_>>()?;
        if messages.starts_with(&transcript) {
            transcript = messages;
        } else if !transcript.starts_with(&messages) {
            return Err(invalid("ambiguous_archived_transcript"));
        }
    }
    Ok(transcript)
}

/// Validate the binding and restore the transcript in the same transaction.
pub(crate) async fn ensure_conversation(
    pool: &SqlitePool,
    blueprint_id: String,
) -> DbResult<ConversationResolution> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT * FROM architect_blueprints WHERE id=?")
        .bind(&blueprint_id)
        .fetch_one(&mut *tx)
        .await?;
    let draft = draft(&row)?;
    let legacy_id = draft
        .history
        .as_ref()
        .and_then(|h| h.get("legacyConversationId"))
        .and_then(Value::as_str);
    let previous_id = draft.summary.conversation_id.as_deref().or(legacy_id);
    let now = chrono::Utc::now().to_rfc3339();
    let recovery_key = format!("architect:composer-recovery:{blueprint_id}");
    let mut candidate = None;
    let mut owned = false;
    if let Some(id) = previous_id {
        let owner_key = format!("architect:conversation-owner:{id}");
        let owner: Option<Option<String>> =
            sqlx::query_scalar("SELECT json_extract(value_json,'$') FROM app_settings WHERE key=?")
                .bind(&owner_key)
                .fetch_optional(&mut *tx)
                .await?;
        let available = available_conversation(&mut tx, &blueprint_id, Some(id)).await?;
        if owner
            .as_ref()
            .is_some_and(|value| value.as_deref() == Some(blueprint_id.as_str()))
        {
            owned = true;
            if available.is_some() && draft.summary.conversation_id.as_deref() == Some(id) {
                let receipt: Option<String> =
                    sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key=?")
                        .bind(&recovery_key)
                        .fetch_optional(&mut *tx)
                        .await?;
                let draft_recovery = receipt
                    .and_then(|value| serde_json::from_str::<DraftRecovery>(&value).ok())
                    .filter(|recovery| recovery.to_conversation_id == id);
                tx.commit().await?;
                return Ok(ConversationResolution {
                    summary: draft.summary,
                    draft_recovery,
                });
            }
        } else if owner.is_none() {
            // An importer may cite this ID even after switching to a private chat.
            // A restore marker alone cannot tell us who owns a historical chat.
            let contested: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM architect_blueprints WHERE id<>?2
                   AND (json_extract(history,'$.legacyConversationId')=?1 OR conversation_id=?1))
                 OR (?1 IS ?3 AND NOT EXISTS(SELECT 1 FROM app_settings
                   WHERE key='architect:legacy-chat-claim:' || ?1 AND value_json=json_quote(?2)))",
            )
            .bind(id)
            .bind(&blueprint_id)
            .bind(legacy_id)
            .fetch_one(&mut *tx)
            .await?;
            if !contested {
                owned = available.is_some();
                candidate = available;
            }
        }
    }
    let transcript = archived_transcript(&draft)?;
    let mut already_restored = false;
    if let Some(id) = candidate.as_ref().filter(|_| !transcript.is_empty()) {
        // The binding above is exclusive. Migration 047 also copied private IDs
        // into historical provenance, so equality with legacy_id is immaterial.
        already_restored =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_settings WHERE key IN (?,?))")
                .bind(format!("architect:verified-transcript:{blueprint_id}:{id}"))
                .bind(format!("architect:restored-transcript:{blueprint_id}:{id}"))
                .fetch_one(&mut *tx)
                .await?;
    }
    if let Some(id) = candidate
        .as_ref()
        .filter(|_| !transcript.is_empty() && !already_restored)
    {
        let local: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id LIMIT ?",
        )
        .bind(id)
        .bind(transcript.len() as i64)
        .fetch_all(&mut *tx)
        .await?;
        already_restored = local.len() == transcript.len()
            && local
                .iter()
                .zip(&transcript)
                .all(|((role, content, date), message)| {
                    role == &message.role
                        && content == &message.content
                        && message
                            .created_at
                            .as_ref()
                            .is_none_or(|expected| expected == date)
                });
        if !already_restored && !local.is_empty() {
            // Keep the old history intact when the archive diverges.
            candidate = None;
        }
    }
    let id = if let Some(id) = candidate {
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES(?,?,'Architect',?,?)")
            .bind(&id).bind(&draft.summary.name).bind(&now).bind(&now).execute(&mut *tx).await?;
        id
    };
    for (ordinal, message) in transcript.iter().enumerate().filter(|_| !already_restored) {
        // A replica can reuse every historical message ID. Only this chat's IDs
        // reach SQLite, ordered by transcript position when timestamps tie.
        sqlx::query(
            "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(format!("{id}-{ordinal:016}"))
        .bind(&id)
        .bind(&message.role)
        .bind(&message.content)
        .bind(message.created_at.as_deref().unwrap_or(&now))
        .execute(&mut *tx)
        .await?;
    }
    if !already_restored && !transcript.is_empty() {
        super::repository::refresh_conversation_metadata_with_connection(&mut tx, id.clone(), None)
            .await?;
    }
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,json_quote(?),?)")
        .bind(format!("architect:conversation-owner:{id}"))
        .bind(&blueprint_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    let draft_recovery = previous_id
        .filter(|from| *from != id)
        .map(|from| DraftRecovery {
            from_conversation_id: from.into(),
            to_conversation_id: id.clone(),
            owned,
        });
    if let Some(recovery) = &draft_recovery {
        // Preserve the old chat and its provenance after the binding moves.
        sqlx::query(
            "INSERT OR IGNORE INTO app_settings(key,value_json,updated_at) VALUES(?,'null',?)",
        )
        .bind(format!(
            "architect:conversation-owner:{}",
            recovery.from_conversation_id
        ))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
                     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
            .bind(recovery_key)
            .bind(serde_json::to_string(recovery).map_err(|error| invalid(&error.to_string()))?)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    let linked = if draft.summary.conversation_id.as_ref() == Some(&id) {
        draft.summary
    } else {
        let row =
            sqlx::query("UPDATE architect_blueprints SET conversation_id=? WHERE id=? RETURNING *")
                .bind(id)
                .bind(blueprint_id)
                .fetch_one(&mut *tx)
                .await?;
        summary(&row)?
    };
    tx.commit().await?;
    Ok(ConversationResolution {
        summary: linked,
        draft_recovery,
    })
}

pub(crate) async fn require_editable(pool: &SqlitePool, blueprint_id: &str) -> DbResult<()> {
    let archived: bool = sqlx::query_scalar("SELECT archived FROM architect_blueprints WHERE id=?")
        .bind(blueprint_id)
        .fetch_one(pool)
        .await?;
    if archived {
        return Err(invalid("archived_blueprint"));
    }
    Ok(())
}

pub(crate) async fn save_draft(
    pool: &SqlitePool,
    blueprint_id: String,
    expected_revision: i64,
    document: Document,
) -> DbResult<Draft> {
    let row = sqlx::query(
        "UPDATE architect_blueprints SET document=?,revision=revision+1
         WHERE id=? AND revision=?
         RETURNING *",
    )
    .bind(encode(&document)?)
    .bind(blueprint_id)
    .bind(expected_revision)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| invalid("stale_revision"))?;
    draft(&row)
}

async fn freeze(
    db: &mut SqliteConnection,
    id: &str,
    revision: i64,
    note: Option<String>,
) -> DbResult<VersionSummary> {
    let number: i64 = sqlx::query_scalar(
        "UPDATE architect_blueprints SET last_number=last_number+1
         WHERE id=? AND revision=?
         RETURNING last_number",
    )
    .bind(id)
    .bind(revision)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| invalid("stale_revision"))?;
    sqlx::query(
        "INSERT INTO architect_versions(blueprint_id,number,revision,note,document)
         SELECT id,last_number,revision,?,document
         FROM architect_blueprints
         WHERE id=?",
    )
    .bind(&note)
    .bind(id)
    .execute(db)
    .await?;
    Ok(VersionSummary {
        key: VersionKey {
            blueprint_id: id.into(),
            number,
        },
        revision,
        note,
    })
}

pub(crate) async fn save_version(
    pool: &SqlitePool,
    blueprint_id: String,
    expected_revision: i64,
    note: Option<String>,
) -> DbResult<VersionSummary> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let version = freeze(&mut tx, &blueprint_id, expected_revision, note).await?;
    tx.commit().await?;
    Ok(version)
}

pub(crate) async fn list_versions(
    pool: &SqlitePool,
    blueprint_id: String,
) -> DbResult<Vec<VersionSummary>> {
    let rows = sqlx::query(
        "SELECT blueprint_id,number,revision,note
         FROM architect_versions
         WHERE blueprint_id=?
         ORDER BY number DESC",
    )
    .bind(blueprint_id)
    .fetch_all(pool)
    .await?;
    rows.iter().map(version_summary).collect()
}

pub(crate) async fn get_version(pool: &SqlitePool, key: VersionKey) -> DbResult<Version> {
    let row = sqlx::query("SELECT * FROM architect_versions WHERE blueprint_id=? AND number=?")
        .bind(key.blueprint_id)
        .bind(key.number)
        .fetch_one(pool)
        .await?;
    Ok(Version {
        summary: version_summary(&row)?,
        document: decode(&row)?,
    })
}

pub(crate) async fn delete_version(pool: &SqlitePool, key: VersionKey) -> DbResult<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM architect_version_uses WHERE blueprint_id=? AND number=?)",
    )
    .bind(&key.blueprint_id)
    .bind(key.number)
    .fetch_one(&mut *tx)
    .await?;
    if used {
        return Err(invalid("version_in_use"));
    }
    sqlx::query("DELETE FROM architect_versions WHERE blueprint_id=? AND number=?")
        .bind(key.blueprint_id)
        .bind(key.number)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn adapt_version(
    pool: &SqlitePool,
    key: VersionKey,
    project_id: String,
    name: String,
) -> DbResult<Draft> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let document = sqlx::query_scalar(
        "SELECT document FROM architect_versions WHERE blueprint_id=? AND number=?",
    )
    .bind(&key.blueprint_id)
    .bind(key.number)
    .fetch_one(&mut *tx)
    .await?;
    let draft = insert_blueprint(&mut tx, &project_id, &name, document, Some(&key), None).await?;
    tx.commit().await?;
    Ok(draft)
}

pub(crate) async fn record_use(pool: &SqlitePool, key: VersionKey, usage: Usage) -> DbResult<()> {
    let pinned = sqlx::query(
        "INSERT INTO architect_version_uses(kind, owner_id, blueprint_id, number)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, owner_id) DO UPDATE SET owner_id=excluded.owner_id
         WHERE blueprint_id=excluded.blueprint_id AND number=excluded.number",
    )
    .bind(usage.kind)
    .bind(usage.owner_id)
    .bind(key.blueprint_id)
    .bind(key.number)
    .execute(pool)
    .await?;
    if pinned.rows_affected() == 0 {
        return Err(invalid("usage_version_conflict"));
    }
    Ok(())
}

pub(crate) async fn release_use(pool: &SqlitePool, key: VersionKey, usage: Usage) -> DbResult<()> {
    sqlx::query(
        "DELETE
         FROM architect_version_uses
         WHERE kind=? AND owner_id=? AND blueprint_id=? AND number=?",
    )
    .bind(usage.kind)
    .bind(usage.owner_id)
    .bind(key.blueprint_id)
    .bind(key.number)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn list_uses(pool: &SqlitePool, key: VersionKey) -> DbResult<Vec<Usage>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind,owner_id
         FROM architect_version_uses
         WHERE blueprint_id=? AND number=?
         ORDER BY kind,owner_id",
    )
    .bind(key.blueprint_id)
    .bind(key.number)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, owner_id)| Usage { kind, owner_id })
        .collect())
}

pub(crate) async fn import_blueprint(pool: &SqlitePool, input: Import) -> DbResult<ImportResult> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let result = import_in(&mut tx, input).await?;
    tx.commit().await?;
    Ok(result)
}

fn validate_import_source(source: &str) -> DbResult<()> {
    if source.len() > 1024 * 1024 {
        return Err(invalid("AgSDL document exceeds the 1 MiB editor limit"));
    }
    #[derive(Deserialize)]
    struct Diagnostic {
        code: String,
        message: String,
    }
    #[derive(Deserialize)]
    struct Report {
        diagnostics: Vec<Diagnostic>,
    }
    let report = argentic_core::validate_document_json(source.as_bytes(), None)
        .map_err(|error| invalid(&error.message))?;
    let report: Report = serde_json::from_str(&report).map_err(|e| invalid(&e.to_string()))?;
    // Incomplete semantic drafts still open in Architect. Syntax failures do not.
    if let Some(error) = report
        .diagnostics
        .iter()
        .find(|issue| issue.code == "PARSE")
    {
        return Err(invalid(&error.message));
    }
    #[derive(Deserialize)]
    struct Header {
        contract: String,
    }
    let header: Header = serde_json::from_str(source).map_err(|e| invalid(&e.to_string()))?;
    if header.contract != "agsdl-0.3.0" {
        return Err(invalid("unsupported_agsdl_contract"));
    }
    Ok(())
}

pub(crate) async fn import_in(db: &mut SqliteConnection, input: Import) -> DbResult<ImportResult> {
    if input.source_project_id.trim().is_empty() || input.source_id.trim().is_empty() {
        return Err(invalid("missing_source_identity"));
    }
    validate_import_source(&input.document.source)?;
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT p.id,b.id
         FROM architect_projects p
         JOIN architect_blueprints b ON b.project_id=p.id
         WHERE p.source_project_id=? AND b.source_id=?",
    )
    .bind(&input.source_project_id)
    .bind(&input.source_id)
    .fetch_optional(&mut *db)
    .await?;
    if let Some((project_id, blueprint_id)) = existing {
        return Ok(ImportResult {
            project_id,
            blueprint_id,
            imported: false,
        });
    }
    sqlx::query(
        "INSERT INTO architect_projects(id,name,source_project_id)
         VALUES (?,?,?)
         ON CONFLICT (source_project_id) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&input.project_name)
    .bind(&input.source_project_id)
    .execute(&mut *db)
    .await?;
    let project_id: String =
        sqlx::query_scalar("SELECT id FROM architect_projects WHERE source_project_id=?")
            .bind(input.source_project_id)
            .fetch_one(&mut *db)
            .await?;
    let draft = insert_blueprint(
        db,
        &project_id,
        &input.name,
        encode(&input.document)?,
        None,
        Some(&input.source_id),
    )
    .await?;
    let blueprint_id = draft.summary.id;
    let mut history = input.history;
    if let Some(id) = &input.conversation_id {
        history
            .get_or_insert_with(Default::default)
            .insert("legacyConversationId".into(), Value::String(id.clone()));
    }
    let history = history.map(|value| Value::Object(value).to_string());
    let candidate =
        available_conversation(db, &blueprint_id, input.conversation_id.as_deref()).await?;
    sqlx::query("UPDATE architect_blueprints SET history=?,conversation_id=? WHERE id=?")
        .bind(history)
        .bind(candidate)
        .bind(&blueprint_id)
        .execute(&mut *db)
        .await?;
    freeze(db, &blueprint_id, draft.summary.revision, None).await?;
    Ok(ImportResult {
        project_id,
        blueprint_id,
        imported: true,
    })
}

/// Strip the library from a disposable reference built to match a pre-46 profile.
pub(crate) async fn remove_reference_schema(db: &mut SqliteConnection) -> DbResult<()> {
    sqlx::raw_sql(
        "DROP TABLE IF EXISTS architect_version_uses;
         DROP TABLE IF EXISTS architect_versions;
         DROP TABLE IF EXISTS architect_blueprints;
         DROP TABLE IF EXISTS architect_projects;",
    )
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
