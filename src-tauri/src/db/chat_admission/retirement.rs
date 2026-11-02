//! Local task closure is distinct from a terminal external-effect receipt.
use super::{durable_lease, invalid, DbResult};
use crate::{
    ai::{admitted_http::AdmittedHttp, AiState},
    core::db_state::DbPool,
};
use sqlx::Connection;

/// Called under the browser lifecycle lock. Every executable descendant owns a
/// StreamReservation before its journal row is admitted. Logical tool markers
/// without a request_id own only their recursively registered executor children.
/// No network or task join occurs while a SQLite transaction is held.
pub(super) async fn close_unknown_roots(
    owner: &DbPool,
    ai: &AiState,
    http: &AdmittedHttp,
    caller: &str,
    conversation: &str,
    new_turn: &str,
) -> DbResult<Vec<String>> {
    let guard = owner
        .source_ready(None)
        .await
        .map_err(|_| invalid("chat_admission_unavailable"))?;
    let generation = guard.ready.catalog_generation.clone();
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    // Start with unresolved rows, using the owner/phase index. Ordinary
    // completed history is not walked again before every new user turn.
    let roots: Vec<(String,Option<String>,String,String)> = sqlx::query_as("WITH RECURSIVE ancestors(id,parent_id) AS (SELECT p.operation_id,p.parent_id FROM chat_admission_operations p JOIN chat_admission_owners o ON o.conversation_id=p.conversation_id AND o.incarnation=p.incarnation AND o.mode='open' WHERE p.conversation_id=? AND p.kind IN ('provider','tool') AND p.phase='unknown' UNION SELECT p.operation_id,p.parent_id FROM chat_admission_operations p JOIN ancestors a ON a.parent_id=p.operation_id) SELECT root.operation_id,root.browser_caller,root.runtime_generation,root.turn_id FROM ancestors a JOIN chat_admission_operations root ON root.operation_id=a.id WHERE root.parent_id IS NULL AND root.local_closed_at IS NULL")
        .bind(conversation).fetch_all(&mut *tx).await?;
    if roots.is_empty() {
        tx.commit().await?;
        lease.committed = true;
        return Ok(Vec::new());
    }
    if roots.iter().any(|(_, window, epoch, turn)| {
        window.as_deref() != Some(caller) || epoch != &generation || turn == new_turn
    }) {
        return Err(invalid("chat_admission_effect_unreconciled"));
    }
    let mut requests = Vec::new();
    for (root, _, _, _) in &roots {
        let owned: Vec<String> = sqlx::query_scalar("WITH RECURSIVE family(id) AS (SELECT operation_id FROM chat_admission_operations WHERE operation_id=? UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN family f ON p.parent_id=f.id) SELECT request_id FROM chat_admission_operations WHERE operation_id IN (SELECT id FROM family) AND request_id IS NOT NULL")
            .bind(root).fetch_all(&mut *tx).await?;
        requests.extend(owned);
        // Revoke every already admitted descendant before releasing SQLite.
        // Existing unknown and terminal receipts keep their original meaning.
        sqlx::query("WITH RECURSIVE family(id) AS (SELECT operation_id FROM chat_admission_operations WHERE operation_id=? UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN family f ON p.parent_id=f.id) UPDATE chat_admission_operations SET phase=CASE WHEN phase='prepared' THEN 'no_effect' ELSE 'unknown' END,revision=revision+1 WHERE operation_id IN (SELECT id FROM family) AND kind IN ('turn','compaction','provider','tool') AND phase IN ('prepared','dispatched','result_pending')")
            .bind(root).execute(&mut *tx).await?;
        let tools: Vec<(String,String,String,String)> = sqlx::query_as("WITH RECURSIVE family(id) AS (SELECT operation_id FROM chat_admission_operations WHERE operation_id=? UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN family f ON p.parent_id=f.id) SELECT conversation_id,turn_id,message_id,call_id FROM chat_admission_operations WHERE operation_id IN (SELECT id FROM family) AND kind='tool' AND call_id IS NOT NULL AND phase='unknown'")
            .bind(root).fetch_all(&mut *tx).await?;
        for (conversation_id, turn_id, message_id, call_id) in tools {
            super::super::tool_invocations::mark_unknown_on_connection(
                &mut tx,
                super::super::tool_invocations::ToolInvocationIdentity {
                    conversation_id,
                    turn_id,
                    message_id,
                    call_id,
                },
            )
            .await?;
        }
    }
    tx.commit().await?;
    lease.committed = true;
    drop(lease);
    drop(guard);
    for request in &requests {
        // Includes provider, MCP, terminal, FS, configuration, skills and web
        // executor registrations. Err is a joined error, never remote success.
        let _ = ai.cancel_stream_task(request).await;
        http.remove(caller, request).await;
    }
    let guard = owner
        .source_ready(Some(&generation))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = durable_lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    for (root, _, _, _) in &roots {
        close_proven_root(&mut tx, root).await?;
        let closed:i64=sqlx::query_scalar("SELECT local_closed_at IS NOT NULL FROM chat_admission_operations WHERE operation_id=?").bind(root).fetch_one(&mut *tx).await?;
        if closed != 1 {
            return Err(invalid("chat_admission_local_lifetime_unreconciled"));
        }
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(roots.into_iter().map(|(root, _, _, _)| root).collect())
}

/// Only executable request rows need physical receipts. Logical tool markers
/// retain their remote uncertainty independently of their executor descendants.
pub(super) async fn close_proven_root(db: &mut sqlx::SqliteConnection, root: &str) -> DbResult<()> {
    sqlx::query("UPDATE chat_admission_operations AS root SET local_closed_at=COALESCE(local_closed_at,?) WHERE root.operation_id=? AND root.parent_id IS NULL AND root.phase IN ('unknown','completed','no_effect') AND NOT EXISTS(WITH RECURSIVE family(id) AS (SELECT operation_id FROM chat_admission_operations WHERE parent_id=root.operation_id UNION ALL SELECT p.operation_id FROM chat_admission_operations p JOIN family f ON p.parent_id=f.id) SELECT 1 FROM chat_admission_operations p WHERE p.operation_id IN (SELECT id FROM family) AND p.kind IN ('provider','tool') AND p.request_id IS NOT NULL AND p.phase<>'no_effect' AND p.local_closed_at IS NULL)")
        .bind(chrono::Utc::now().to_rfc3339()).bind(root).execute(db).await?;
    Ok(())
}
