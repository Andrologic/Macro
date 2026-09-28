use super::{DbError, DbResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Connection, Row, SqlitePool};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffectClass {
    ReadOnly,
    WorkspaceMutation,
    ExternalEffect,
}

impl ToolEffectClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::WorkspaceMutation => "workspace_mutation",
            Self::ExternalEffect => "external_effect",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolInvocationStatus {
    Pending,
    Completed,
    Unknown,
}

impl ToolInvocationStatus {
    fn from_db(value: &str) -> DbResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "completed" => Ok(Self::Completed),
            "unknown" => Ok(Self::Unknown),
            _ => Err(DbError::Validation("Invalid tool invocation status".into())),
        }
    }
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocationIdentity {
    pub conversation_id: String,
    pub turn_id: String,
    pub message_id: String,
    pub call_id: String,
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RecordToolInvocationInput {
    #[serde(flatten)]
    #[ts(flatten)]
    pub identity: ToolInvocationIdentity,
    pub tool_name: String,
    pub effect_class: ToolEffectClass,
    pub arguments: Value,
    pub remote_execution_id: Option<String>,
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct CompleteToolInvocationInput {
    #[serde(flatten)]
    #[ts(flatten)]
    pub identity: ToolInvocationIdentity,
    pub receipt_id: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ToolInvocation {
    pub conversation_id: String,
    pub turn_id: String,
    pub message_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub effect_class: ToolEffectClass,
    pub arguments_sha256: String,
    pub remote_execution_id: Option<String>,
    pub status: ToolInvocationStatus,
    pub receipt_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RecordToolInvocationResult {
    pub invocation: ToolInvocation,
    /// Only the first successful insert can dispatch. A retry, at any status, cannot.
    pub is_new: bool,
}

fn nonempty(value: &str, field: &str) -> DbResult<()> {
    if value.trim().is_empty() {
        return Err(DbError::Validation(format!(
            "Tool invocation {field} must not be empty"
        )));
    }
    Ok(())
}

fn opaque_id(value: &str, field: &str) -> DbResult<()> {
    nonempty(value, field)?;
    if value.len() > 512 || value.chars().any(char::is_control) {
        return Err(DbError::Validation(format!(
            "Invalid tool invocation {field}"
        )));
    }
    Ok(())
}

fn validate_identity(identity: &ToolInvocationIdentity) -> DbResult<()> {
    for (field, value) in [
        ("conversation_id", &identity.conversation_id),
        ("turn_id", &identity.turn_id),
        ("message_id", &identity.message_id),
        ("call_id", &identity.call_id),
    ] {
        opaque_id(value, field)?;
    }
    Ok(())
}

fn map_row(row: SqliteRow) -> DbResult<ToolInvocation> {
    let effect_class = match row.get::<&str, _>("effect_class") {
        "read_only" => ToolEffectClass::ReadOnly,
        "workspace_mutation" => ToolEffectClass::WorkspaceMutation,
        "external_effect" => ToolEffectClass::ExternalEffect,
        _ => return Err(DbError::Validation("Invalid tool effect class".into())),
    };
    Ok(ToolInvocation {
        conversation_id: row.get("conversation_id"),
        turn_id: row.get("turn_id"),
        message_id: row.get("message_id"),
        call_id: row.get("call_id"),
        tool_name: row.get("tool_name"),
        effect_class,
        arguments_sha256: row.get("arguments_sha256"),
        remote_execution_id: row.get("remote_execution_id"),
        status: ToolInvocationStatus::from_db(row.get("status"))?,
        receipt_id: row.get("receipt_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn arguments_digest(value: &Value) -> DbResult<String> {
    fn append(value: &Value, digest: &mut Sha256) -> Result<(), serde_json::Error> {
        match value {
            Value::Object(map) => {
                digest.update(b"{");
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort_unstable();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        digest.update(b",");
                    }
                    digest.update(serde_json::to_vec(key)?);
                    digest.update(b":");
                    append(map.get(key).expect("key from map"), digest)?;
                }
                digest.update(b"}");
            }
            Value::Array(items) => {
                digest.update(b"[");
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        digest.update(b",");
                    }
                    append(item, digest)?;
                }
                digest.update(b"]");
            }
            _ => digest.update(serde_json::to_vec(value)?),
        }
        Ok(())
    }
    let mut digest = Sha256::new();
    append(value, &mut digest)
        .map_err(|_| DbError::Validation("Invalid tool invocation arguments".into()))?;
    Ok(format!("{:x}", digest.finalize()))
}

async fn get_on_connection(
    connection: &mut sqlx::SqliteConnection,
    identity: &ToolInvocationIdentity,
) -> DbResult<Option<ToolInvocation>> {
    let row = sqlx::query(
        "SELECT * FROM tool_invocations WHERE conversation_id = ? AND turn_id = ? AND message_id = ? AND call_id = ?",
    )
    .bind(&identity.conversation_id)
    .bind(&identity.turn_id)
    .bind(&identity.message_id)
    .bind(&identity.call_id)
    .fetch_optional(connection)
    .await?;
    row.map(map_row).transpose()
}

pub async fn record(
    pool: &SqlitePool,
    input: RecordToolInvocationInput,
) -> DbResult<RecordToolInvocationResult> {
    validate_identity(&input.identity)?;
    nonempty(&input.tool_name, "tool_name")?;
    if let Some(id) = &input.remote_execution_id {
        opaque_id(id, "remote_execution_id")?;
    }
    // Sort object keys at every depth, regardless of serde_json's map feature.
    // Never persist the supplied arguments or put them in an error message.
    let digest = arguments_digest(&input.arguments)?;
    // The shared pool uses WAL/NORMAL. A successful pre-dispatch insert must
    // survive power loss before is_new can authorize the effect.
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *connection)
        .await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let now = chrono::Utc::now().to_rfc3339();
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO tool_invocations (conversation_id, turn_id, message_id, call_id, tool_name, effect_class, arguments_sha256, remote_execution_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&input.identity.conversation_id)
    .bind(&input.identity.turn_id)
    .bind(&input.identity.message_id)
    .bind(&input.identity.call_id)
    .bind(&input.tool_name)
    .bind(input.effect_class.as_str())
    .bind(&digest)
    .bind(&input.remote_execution_id)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .rows_affected() == 1;
    let row = get_on_connection(&mut tx, &input.identity)
        .await?
        .ok_or_else(|| DbError::Validation("Tool invocation conversation does not exist".into()))?;
    if row.tool_name != input.tool_name
        || row.effect_class != input.effect_class
        || row.arguments_sha256 != digest
        || row.remote_execution_id != input.remote_execution_id
    {
        return Err(DbError::Validation(
            "Conflicting tool invocation identity".into(),
        ));
    }
    tx.commit().await?;
    sqlx::query("PRAGMA synchronous = NORMAL")
        .execute(&mut *connection)
        .await?;
    Ok(RecordToolInvocationResult {
        invocation: row,
        is_new: inserted,
    })
}

pub async fn complete(
    pool: &SqlitePool,
    input: CompleteToolInvocationInput,
) -> DbResult<ToolInvocation> {
    validate_identity(&input.identity)?;
    opaque_id(&input.receipt_id, "receipt_id")?;
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *connection)
        .await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let previous = get_on_connection(&mut tx, &input.identity)
        .await?
        .ok_or_else(|| DbError::Validation("Tool invocation not found".into()))?;
    if previous.status == ToolInvocationStatus::Completed {
        if previous.receipt_id != Some(input.receipt_id) {
            return Err(DbError::Validation(
                "Conflicting tool invocation receipt".into(),
            ));
        }
        tx.commit().await?;
        sqlx::query("PRAGMA synchronous = NORMAL")
            .execute(&mut *connection)
            .await?;
        return Ok(previous);
    }
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE tool_invocations SET status = 'completed', receipt_id = ?, updated_at = ? WHERE conversation_id = ? AND turn_id = ? AND message_id = ? AND call_id = ?")
        .bind(&input.receipt_id)
        .bind(&now)
        .bind(&input.identity.conversation_id)
        .bind(&input.identity.turn_id)
        .bind(&input.identity.message_id)
        .bind(&input.identity.call_id)
        .execute(&mut *tx).await?;
    let row = get_on_connection(&mut tx, &input.identity)
        .await?
        .expect("row locked by transaction");
    tx.commit().await?;
    sqlx::query("PRAGMA synchronous = NORMAL")
        .execute(&mut *connection)
        .await?;
    Ok(row)
}

pub async fn mark_unknown(
    pool: &SqlitePool,
    identity: ToolInvocationIdentity,
) -> DbResult<ToolInvocation> {
    validate_identity(&identity)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE tool_invocations SET status = 'unknown', updated_at = ? WHERE conversation_id = ? AND turn_id = ? AND message_id = ? AND call_id = ? AND status = 'pending'")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&identity.conversation_id)
        .bind(&identity.turn_id)
        .bind(&identity.message_id)
        .bind(&identity.call_id)
        .execute(&mut *tx).await?;
    let row = get_on_connection(&mut tx, &identity)
        .await?
        .ok_or_else(|| DbError::Validation("Tool invocation not found".into()))?;
    tx.commit().await?;
    Ok(row)
}

pub async fn list_unresolved(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Vec<ToolInvocation>> {
    nonempty(conversation_id, "conversation_id")?;
    sqlx::query("SELECT * FROM tool_invocations WHERE conversation_id = ? AND status IN ('pending', 'unknown') ORDER BY created_at, turn_id, message_id, call_id")
        .bind(conversation_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_row)
        .collect()
}

pub async fn reconcile_pending_after_restart(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        "UPDATE tool_invocations SET status = 'unknown', updated_at = ? WHERE status = 'pending'",
    )
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, repository};
    use serde_json::json;
    use tempfile::TempDir;

    fn identity(conversation_id: &str) -> ToolInvocationIdentity {
        ToolInvocationIdentity {
            conversation_id: conversation_id.into(),
            turn_id: "turn-1".into(),
            message_id: "message-1".into(),
            call_id: "call-1".into(),
        }
    }

    fn input(conversation_id: &str) -> RecordToolInvocationInput {
        RecordToolInvocationInput {
            identity: identity(conversation_id),
            tool_name: "write".into(),
            effect_class: ToolEffectClass::WorkspaceMutation,
            arguments: json!({"secret": "never-persist-this", "path": "example.txt"}),
            remote_execution_id: Some("remote-1".into()),
        }
    }

    async fn setup() -> (TempDir, SqlitePool, String) {
        let temp = TempDir::new().unwrap();
        let pool = create_pool(&temp.path().join("macro.db")).await.unwrap();
        let conversation_id = repository::create_conversation(
            &pool,
            crate::db::models::CreateConversationInput {
                title: Some("Synthetic".into()),
                scope_mode: "Chat".into(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap()
        .id;
        (temp, pool, conversation_id)
    }

    #[tokio::test]
    async fn records_atomically_retries_and_rejects_conflicting_arguments() {
        let (_temp, pool, conversation_id) = setup().await;
        let first = record(&pool, input(&conversation_id)).await.unwrap();
        assert!(first.is_new);
        assert_eq!(first.invocation.status, ToolInvocationStatus::Pending);
        assert_eq!(first.invocation.arguments_sha256.len(), 64);
        let retry = record(&pool, input(&conversation_id)).await.unwrap();
        assert!(!retry.is_new);
        assert_eq!(retry.invocation.created_at, first.invocation.created_at);
        let mut reordered = input(&conversation_id);
        reordered.arguments =
            serde_json::from_str(r#"{"path":"example.txt","secret":"never-persist-this"}"#)
                .unwrap();
        let reordered = record(&pool, reordered).await.unwrap();
        assert!(!reordered.is_new);
        assert_eq!(
            reordered.invocation.arguments_sha256,
            first.invocation.arguments_sha256
        );
        let mut conflict = input(&conversation_id);
        conflict.arguments = json!({"secret": "different"});
        assert!(matches!(
            record(&pool, conflict).await,
            Err(DbError::Validation(_))
        ));
        let mut changed_tool = input(&conversation_id);
        changed_tool.tool_name = "delete".into();
        assert!(record(&pool, changed_tool).await.is_err());
        assert_eq!(
            list_unresolved(&pool, &conversation_id)
                .await
                .unwrap()
                .len(),
            1
        );
        let raw = format!("{first:?}");
        assert!(!raw.contains("never-persist-this"));
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('tool_invocations')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(!columns
            .iter()
            .any(|column| column == "arguments" || column == "result"));
    }

    #[tokio::test]
    async fn concurrent_writers_cannot_replace_the_first_fingerprint() {
        let (_temp, pool, conversation_id) = setup().await;
        let first = input(&conversation_id);
        let mut second = input(&conversation_id);
        second.arguments = json!({"path": "other.txt"});
        let (left, right) = tokio::join!(record(&pool, first), record(&pool, second));
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        assert_eq!(
            list_unresolved(&pool, &conversation_id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn identical_concurrent_records_authorize_only_one_dispatch() {
        let (_temp, pool, conversation_id) = setup().await;
        let (left, right) = tokio::join!(
            record(&pool, input(&conversation_id)),
            record(&pool, input(&conversation_id)),
        );
        assert_eq!(
            usize::from(left.unwrap().is_new) + usize::from(right.unwrap().is_new),
            1
        );
    }

    #[tokio::test]
    async fn completion_requires_an_existing_intent_and_a_receipt() {
        let (_temp, pool, conversation_id) = setup().await;
        let completion = CompleteToolInvocationInput {
            identity: identity(&conversation_id),
            receipt_id: "accepted-1".into(),
        };
        assert!(complete(&pool, completion).await.is_err());
        assert!(list_unresolved(&pool, &conversation_id)
            .await
            .unwrap()
            .is_empty());
        record(&pool, input(&conversation_id)).await.unwrap();
        assert!(complete(
            &pool,
            CompleteToolInvocationInput {
                identity: identity(&conversation_id),
                receipt_id: " ".into()
            }
        )
        .await
        .is_err());
        assert_eq!(
            list_unresolved(&pool, &conversation_id).await.unwrap()[0].status,
            ToolInvocationStatus::Pending
        );
        let completed = complete(
            &pool,
            CompleteToolInvocationInput {
                identity: identity(&conversation_id),
                receipt_id: "accepted-1".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(completed.status, ToolInvocationStatus::Completed);
        assert!(list_unresolved(&pool, &conversation_id)
            .await
            .unwrap()
            .is_empty());
        let completed_retry = record(&pool, input(&conversation_id)).await.unwrap();
        assert!(!completed_retry.is_new);
        assert_eq!(
            completed_retry.invocation.receipt_id.as_deref(),
            Some("accepted-1")
        );
        assert!(complete(
            &pool,
            CompleteToolInvocationInput {
                identity: identity(&conversation_id),
                receipt_id: "accepted-2".into()
            }
        )
        .await
        .is_err());
        let mut other = input(&conversation_id);
        other.identity.call_id = "call-2".into();
        record(&pool, other).await.unwrap();
        let mut duplicate_receipt = identity(&conversation_id);
        duplicate_receipt.call_id = "call-2".into();
        assert!(complete(
            &pool,
            CompleteToolInvocationInput {
                identity: duplicate_receipt,
                receipt_id: "accepted-1".into(),
            }
        )
        .await
        .is_ok());
        assert_eq!(
            mark_unknown(&pool, identity(&conversation_id))
                .await
                .unwrap()
                .status,
            ToolInvocationStatus::Completed
        );
    }

    #[tokio::test]
    async fn restart_makes_pending_unknown_and_cascade_removes_history() {
        let (temp, pool, conversation_id) = setup().await;
        record(&pool, input(&conversation_id)).await.unwrap();
        pool.close().await;
        let reopened = create_pool(&temp.path().join("macro.db")).await.unwrap();
        reconcile_pending_after_restart(&reopened).await.unwrap();
        let unresolved = list_unresolved(&reopened, &conversation_id).await.unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].status, ToolInvocationStatus::Unknown);
        assert!(unresolved[0].receipt_id.is_none());
        let retry = record(&reopened, input(&conversation_id)).await.unwrap();
        assert!(!retry.is_new);
        assert_eq!(retry.invocation.status, ToolInvocationStatus::Unknown);
        complete(
            &reopened,
            CompleteToolInvocationInput {
                identity: identity(&conversation_id),
                receipt_id: "late-confirmation".into(),
            },
        )
        .await
        .unwrap();
        assert!(list_unresolved(&reopened, &conversation_id)
            .await
            .unwrap()
            .is_empty());
        repository::delete_conversation(&reopened, &conversation_id)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tool_invocations")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
