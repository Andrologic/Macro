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
    attach_on_connection(&mut *pool.acquire().await?, blueprint_id, conversation_id).await
}

async fn attach_on_connection(
    db: &mut SqliteConnection,
    blueprint_id: String,
    conversation_id: String,
) -> DbResult<Summary> {
    let row = sqlx::query(
        "UPDATE architect_blueprints SET conversation_id=?
         WHERE id=? AND EXISTS (SELECT 1 FROM conversations WHERE id=?)
           AND (conversation_id=? OR NOT EXISTS (
             SELECT 1 FROM conversations WHERE id=architect_blueprints.conversation_id
           ))
         RETURNING *",
    )
    .bind(&conversation_id)
    .bind(blueprint_id)
    .bind(&conversation_id)
    .bind(&conversation_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| invalid("conversation_conflict"))?;
    summary(&row)
}

/// Create the chat, restore its imported transcript and bind it in one transaction.
pub(crate) async fn ensure_conversation(
    pool: &SqlitePool,
    blueprint_id: String,
) -> DbResult<Summary> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT * FROM architect_blueprints WHERE id=?")
        .bind(&blueprint_id)
        .fetch_one(&mut *tx)
        .await?;
    let draft = draft(&row)?;
    let now = chrono::Utc::now().to_rfc3339();
    let existing = if let Some(id) = &draft.summary.conversation_id {
        let scope: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT scope_mode,task_id FROM conversations WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some((mode, task)) = scope {
            if mode != "Architect" || task.is_some() {
                return Err(invalid("conversation_conflict"));
            }
            Some(id.clone())
        } else {
            None
        }
    } else {
        None
    };
    let id = if let Some(id) = existing {
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES(?,?,'Architect',?,?)")
        .bind(&id).bind(&draft.summary.name).bind(&now).bind(&now).execute(&mut *tx).await?;
        id
    };
    let origins = draft
        .history
        .as_ref()
        .and_then(|h| h.get("origins"))
        .and_then(Value::as_array);
    let restore_key = format!("architect:restored-transcript:{blueprint_id}:{id}");
    let restored: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_settings WHERE key=?)")
            .bind(&restore_key)
            .fetch_one(&mut *tx)
            .await?;
    if restored && draft.summary.conversation_id.as_ref() == Some(&id) {
        return Ok(draft.summary);
    }
    let mut transcript = Vec::<Value>::new();
    for raw in origins
        .into_iter()
        .flatten()
        .filter_map(|o| o.get("transcript")?.as_str())
    {
        let messages: Vec<Value> = raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .map_err(|_| invalid("invalid_archived_transcript"))?;
        if messages.starts_with(&transcript) {
            transcript = messages;
        } else if !transcript.starts_with(&messages) {
            return Err(invalid("ambiguous_archived_transcript"));
        }
    }
    let existing: Vec<(String, String)> = if transcript.is_empty() {
        vec![]
    } else {
        sqlx::query_as("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at,id LIMIT ?")
            .bind(&id).bind(transcript.len() as i64).fetch_all(&mut *tx).await?
    };
    // A live conversation may have been edited since import. Never splice a divergent history.
    let compatible = existing
        .iter()
        .zip(&transcript)
        .all(|((role, content), m)| {
            m["role"].as_str() == Some(role.as_str())
                && m["content"].as_str() == Some(content.as_str())
        });
    let skip = if compatible {
        existing.len()
    } else {
        transcript.len()
    };
    for (ordinal, message) in transcript.iter().enumerate().skip(skip) {
        let role = message["role"]
            .as_str()
            .filter(|s| matches!(*s, "assistant" | "user"))
            .ok_or_else(|| invalid("invalid_archived_transcript"))?;
        let content = message["content"]
            .as_str()
            .ok_or_else(|| invalid("invalid_archived_transcript"))?;
        sqlx::query(
            "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(format!("{id}-{ordinal:016}"))
        .bind(&id)
        .bind(role)
        .bind(content)
        .bind(message["createdAt"].as_str().unwrap_or(&now))
        .execute(&mut *tx)
        .await?;
    }
    if skip < transcript.len() {
        super::repository::refresh_conversation_metadata_with_connection(&mut tx, id.clone(), None)
            .await?;
    }
    if !transcript.is_empty() {
        sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,'true',?)")
            .bind(restore_key)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    let linked = if draft.summary.conversation_id.as_ref() == Some(&id) {
        draft.summary
    } else {
        attach_on_connection(&mut tx, blueprint_id, id).await?
    };
    tx.commit().await?;
    Ok(linked)
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
    sqlx::query("UPDATE architect_blueprints SET history=?,conversation_id=(SELECT id FROM conversations WHERE id=?) WHERE id=?")
        .bind(history)
        .bind(input.conversation_id)
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
