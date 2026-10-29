//! Explicit copy of a conversation the restore barrier holds: a new, open
//! conversation from its visible history, with new IDs and no inherited work.
use super::{durable_lease, invalid};
use crate::db::{models::Conversation, DbResult};
use sqlx::{Connection, Row, SqlitePool};
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoredCopy {
    pub conversation: Conversation,
    /// Each copied source message ID with its copy's, in history order.
    pub messages: Vec<(String, String)>,
}

/// The conversation's admission mode, or None for an unknown conversation.
pub(crate) async fn admission_mode(
    pool: &SqlitePool,
    conversation: &str,
) -> DbResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT mode FROM chat_admission_owners WHERE conversation_id=?")
            .bind(conversation)
            .fetch_optional(pool)
            .await?,
    )
}

/// Copies the messages and citations of a held conversation into a new Chat.
/// Turns, provider items, tool traces, goals, runs, queues and Pilot sends stay
/// behind; the source stays held. Images are copied by the caller, which reads
/// them through the ordinary image paths.
pub(crate) async fn copy_restored(
    pool: &SqlitePool,
    conversation: &str,
    title: &str,
) -> DbResult<RestoredCopy> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(invalid("conversation_title_invalid"));
    }
    let mut lease = durable_lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    let mode: Option<String> =
        sqlx::query_scalar("SELECT mode FROM chat_admission_owners WHERE conversation_id=?")
            .bind(conversation)
            .fetch_optional(&mut *tx)
            .await?;
    if mode.as_deref() != Some("restore_hold") {
        return Err(invalid("conversation_not_restored"));
    }
    let source =
        sqlx::query("SELECT provider_id,model_id,reasoning_effort FROM conversations WHERE id=?")
            .bind(conversation)
            .fetch_one(&mut *tx)
            .await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO conversations(id,title,description,scope_mode,task_id,group_id,project_id,provider_id,model_id,reasoning_effort,created_at,updated_at,message_count,is_pinned) VALUES(?,?,NULL,'Chat',NULL,NULL,NULL,?,?,?,?,?,0,0)")
        .bind(&id)
        .bind(title)
        .bind(source.get::<Option<String>, _>("provider_id"))
        .bind(source.get::<Option<String>, _>("model_id"))
        .bind(source.get::<Option<String>, _>("reasoning_effort"))
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    // The history order is (created_at, id): sorted new IDs keep its ties.
    let rows = sqlx::query("SELECT id,role,content,created_at,token_count,hidden_context,context_refs_json,completion_reason FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY created_at ASC, id ASC")
        .bind(conversation)
        .fetch_all(&mut *tx)
        .await?;
    let mut ids: Vec<String> = rows
        .iter()
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    ids.sort_unstable();
    let messages: Vec<(String, String)> = rows
        .iter()
        .map(|row| row.get::<String, _>("id"))
        .zip(ids)
        .collect();
    let message_ids: HashMap<&str, &str> = messages
        .iter()
        .map(|(old, new)| (old.as_str(), new.as_str()))
        .collect();
    let citations = sqlx::query("SELECT * FROM conversation_citations WHERE conversation_id=? ORDER BY created_at ASC, id ASC")
        .bind(conversation)
        .fetch_all(&mut *tx)
        .await?;
    let citation_ids: HashMap<String, String> = citations
        .iter()
        .filter(|row| message_ids.contains_key(row.get::<&str, _>("message_id")))
        .map(|row| (row.get("id"), uuid::Uuid::new_v4().to_string()))
        .collect();
    for (row, (_, new)) in rows.iter().zip(&messages) {
        // References to copied citations follow them; others are kept as is.
        let refs = row
            .get::<Option<String>, _>("context_refs_json")
            .map(|raw| {
                let mut refs: serde_json::Value =
                    serde_json::from_str(&raw).map_err(|_| invalid("context_refs_invalid"))?;
                for item in refs.as_array_mut().into_iter().flatten() {
                    if let Some(copy) = item["id"].as_str().and_then(|id| citation_ids.get(id)) {
                        item["id"] = serde_json::json!(copy);
                    }
                }
                Ok::<_, crate::db::DbError>(refs.to_string())
            })
            .transpose()?;
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,token_count,hidden_context,context_refs_json,completion_reason) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(new)
            .bind(&id)
            .bind(row.get::<String, _>("role"))
            .bind(row.get::<String, _>("content"))
            .bind(row.get::<String, _>("created_at"))
            .bind(row.get::<Option<i64>, _>("token_count"))
            .bind(row.get::<Option<String>, _>("hidden_context"))
            .bind(refs)
            .bind(row.get::<Option<String>, _>("completion_reason"))
            .execute(&mut *tx)
            .await?;
    }
    for row in &citations {
        let Some(copy) = citation_ids.get(row.get::<&str, _>("id")) else {
            continue;
        };
        sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,snippet,content,url,favicon,path,language,size_bytes,kind,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(copy)
            .bind(&id)
            .bind(message_ids[row.get::<&str, _>("message_id")])
            .bind(row.get::<String, _>("type"))
            .bind(row.get::<String, _>("scope"))
            .bind(row.get::<String, _>("source"))
            .bind(row.get::<String, _>("title"))
            .bind(row.get::<Option<String>, _>("snippet"))
            .bind(row.get::<Option<String>, _>("content"))
            .bind(row.get::<Option<String>, _>("url"))
            .bind(row.get::<Option<String>, _>("favicon"))
            .bind(row.get::<Option<String>, _>("path"))
            .bind(row.get::<Option<String>, _>("language"))
            .bind(row.get::<Option<i64>, _>("size_bytes"))
            .bind(row.get::<Option<String>, _>("kind"))
            .bind(row.get::<Option<String>, _>("reason"))
            .bind(row.get::<String, _>("created_at"))
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    // A new branch of work: recent now, whatever the history's dates.
    crate::db::repository::refresh_conversation_metadata_with_connection(
        &mut tx,
        id.clone(),
        Some(now.clone()),
    )
    .await?;
    tx.commit().await?;
    lease.committed = true;
    let conversation = crate::db::repository::get_conversation(pool, &id)
        .await?
        .ok_or_else(|| invalid("conversation_copy_missing"))?;
    Ok(RestoredCopy {
        conversation,
        messages,
    })
}
