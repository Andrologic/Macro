//! Atomic local publication only. No export, IPC input or production constructor.
//! Real canonical transport, worker/native builders and resource leases remain
//! missing composition dependencies. A DB terminal is data, never fresh authority.
use super::*;
use sqlx::{Connection, Row};

pub(super) struct PublishWrite {
    pub(super) transfer_id: String,
    pub(super) terminal_fingerprint: Vec<u8>,
    pub(super) preparation_fingerprint: Vec<u8>,
    pub(super) local_generation: String,
    pub(super) configuration_digest: Vec<u8>,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct LocalPublication {
    pub(super) conversation_id: String,
    pub(super) receipt: Vec<u8>,
}
pub(super) async fn publish(pool: &SqlitePool, input: &PublishWrite) -> DbResult<LocalPublication> {
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    crate::db::chat_admission::validate_schema(&mut tx).await?;
    let row=sqlx::query("SELECT p.*,t.terminal_fingerprint,t.terminal_prepared_digest,t.terminal_exact,t.terminal_digest,t.terminal_outcome,t.restore_hold,t.phase AS transfer_phase,t.local_role FROM connect_preparations p JOIN connect_transfers t USING(transfer_id) WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    if row.get::<Vec<u8>, _>("fingerprint") != input.preparation_fingerprint
        || row
            .get::<Option<Vec<u8>>, _>("terminal_fingerprint")
            .as_deref()
            != Some(input.terminal_fingerprint.as_slice())
        || row.get::<String, _>("local_role") != "target"
        || row.get::<Option<String>, _>("terminal_outcome").as_deref() != Some("committed")
        || row.get::<Option<Vec<u8>>, _>("terminal_prepared_digest")
            != row.get::<Option<Vec<u8>>, _>("prepared_digest")
    {
        return Err(invalid("connect_publication_conflict"));
    }
    if let Some(receipt)=sqlx::query("SELECT conversation_id,local_receipt,preparation_fingerprint,terminal_digest FROM connect_activation_receipts WHERE transfer_id=?").bind(&input.transfer_id).fetch_optional(&mut *tx).await? {
        if receipt.get::<Vec<u8>,_>("preparation_fingerprint")!=input.preparation_fingerprint || receipt.get::<Vec<u8>,_>("terminal_digest")!=row.get::<Vec<u8>,_>("terminal_digest") {return Err(invalid("connect_publication_conflict"));}
        let result=LocalPublication{conversation_id:receipt.get("conversation_id"),receipt:receipt.get("local_receipt")};
        tx.commit().await?;lease.committed=true;return Ok(result);
    }
    if row.get::<String, _>("phase") != "pinned"
        || row.get::<Option<Vec<u8>>, _>("pin_fingerprint").is_none()
        || row.get::<i64, _>("restore_hold") != 0
        || row.get::<String, _>("transfer_phase") == "reconciliation_required"
        || row.get::<String, _>("local_generation") != input.local_generation
        || row.get::<Vec<u8>, _>("configuration_digest") != input.configuration_digest
    {
        return Err(invalid("connect_publication_hold"));
    }
    super::preparation::check_import(&mut tx, &input.transfer_id).await?;
    let conversation: String = row.get("target_conversation_id");
    // Logical copies/indexes are admitted before ordinary rows. The real native
    // resource owner must additionally preflight memory/pages/WAL/free space;
    // this closed storage implementation does not pretend to reserve a volume.
    let copied:i64=sqlx::query_scalar("SELECT COALESCE(SUM(bytes),0) FROM connect_projection_fields WHERE transfer_id=? AND kind<>'asset'").bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    let extra = charge(
        copied
            .checked_mul(4)
            .ok_or_else(|| invalid("resource_limit"))?,
        add(
            row.get::<i64, _>("message_count")
                .checked_mul(512)
                .ok_or_else(|| invalid("resource_limit"))?,
            row.get::<i64, _>("citation_count")
                .checked_mul(1024)
                .ok_or_else(|| invalid("resource_limit"))?,
        )?,
        4096,
    )?;
    super::preparation::grow(&mut tx, &input.transfer_id, extra).await?;
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,project_id,group_id,task_id,provider_id,model_id,reasoning_effort,created_at,updated_at,message_count,is_pinned) VALUES(?,?,'Chat',NULL,NULL,NULL,?,?,?,?,?,?,0)")
        .bind(&conversation).bind(row.get::<String,_>("title")).bind(row.get::<String,_>("provider_id")).bind(row.get::<String,_>("model_id")).bind(row.get::<Option<String>,_>("reasoning_effort")).bind(row.get::<String,_>("created_at")).bind(row.get::<String,_>("created_at")).bind(row.get::<i64,_>("message_count")).execute(&mut *tx).await?;
    let mut cursor = -1_i64;
    loop {
        let item=sqlx::query("SELECT ordinal,id,role,created_at FROM connect_projection_messages WHERE transfer_id=? AND ordinal>? ORDER BY ordinal LIMIT 1").bind(&input.transfer_id).bind(cursor).fetch_optional(&mut *tx).await?;
        let Some(item) = item else { break };
        cursor = item.get("ordinal");
        sqlx::query(
            "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,'',?)",
        )
        .bind(item.get::<String, _>("id"))
        .bind(&conversation)
        .bind(item.get::<String, _>("role"))
        .bind(item.get::<String, _>("created_at"))
        .execute(&mut *tx)
        .await?;
        let id: i64 = sqlx::query_scalar("SELECT rowid FROM messages WHERE id=?")
            .bind(item.get::<String, _>("id"))
            .fetch_one(&mut *tx)
            .await?;
        copy_text(
            &mut tx,
            &input.transfer_id,
            "message",
            cursor,
            "content",
            "messages",
            "content",
            id,
        )
        .await?;
        // Incremental blob writes bypass SQL triggers. Empty/zero-filled text
        // indexed during construction had no terms. Index the final text once.
        sqlx::query("INSERT INTO message_search(rowid,content) SELECT rowid,content FROM messages WHERE rowid=?").bind(id).execute(&mut *tx).await?;
    }
    cursor = -1;
    loop {
        let item=sqlx::query("SELECT ordinal,id,message_id,type,scope,kind FROM connect_projection_citations WHERE transfer_id=? AND ordinal>? ORDER BY ordinal LIMIT 1").bind(&input.transfer_id).bind(cursor).fetch_optional(&mut *tx).await?;
        let Some(item) = item else { break };
        cursor = item.get("ordinal");
        sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,kind,created_at,updated_at) VALUES(?,?,?,?,?,'','',?,?,?)").bind(item.get::<String,_>("id")).bind(&conversation).bind(item.get::<String,_>("message_id")).bind(item.get::<String,_>("type")).bind(item.get::<String,_>("scope")).bind(item.get::<Option<String>,_>("kind")).bind(row.get::<String,_>("created_at")).bind(row.get::<String,_>("created_at")).execute(&mut *tx).await?;
        let id: i64 = sqlx::query_scalar("SELECT rowid FROM conversation_citations WHERE id=?")
            .bind(item.get::<String, _>("id"))
            .fetch_one(&mut *tx)
            .await?;
        for field in ["source", "title", "snippet", "content"] {
            copy_text(
                &mut tx,
                &input.transfer_id,
                "citation",
                cursor,
                field,
                "conversation_citations",
                field,
                id,
            )
            .await?;
        }
    }
    // Assets publish by the immutable relation/view in 019, without a second
    // copy, file rename, fabricated Pilot send or UI cache as a commit condition.
    let archive_charge = charge(64, 128, 256)?;
    admit(&mut tx, archive_charge).await?;
    sqlx::query("INSERT INTO conversation_portable_archives VALUES(?,?,?,?,?,?,?)")
        .bind(&conversation)
        .bind(&input.transfer_id)
        .bind(row.get::<i64, _>("import_id"))
        .bind(row.get::<i64, _>("import_revision"))
        .bind(row.get::<Vec<u8>, _>("storage_manifest"))
        .bind(row.get::<Vec<u8>, _>("mapping_hash"))
        .bind(archive_charge)
        .execute(&mut *tx)
        .await?;
    // Local receipt, deliberately different from a canonical activation receipt.
    let receipt = serde_json::to_vec(&(
        1,
        &input.transfer_id,
        &conversation,
        row.get::<Vec<u8>, _>("terminal_digest"),
        row.get::<Vec<u8>, _>("prepared_digest"),
        row.get::<Vec<u8>, _>("projection_hash"),
    ))
    .map_err(|_| invalid("connect_publication_receipt"))?;
    let exact: Vec<u8> = row.get("terminal_exact");
    let receipt_charge = charge(add(receipt.len() as i64, exact.len() as i64)?, 256, 256)?;
    admit_journal(&mut tx, receipt_charge).await?;
    sqlx::query("INSERT INTO connect_activation_receipts VALUES(?,?,?,?,?,?,?,?)")
        .bind(&input.transfer_id)
        .bind(&conversation)
        .bind(row.get::<Vec<u8>, _>("terminal_digest"))
        .bind(exact)
        .bind(&input.preparation_fingerprint)
        .bind(&receipt)
        .bind(hash(&receipt))
        .bind(receipt_charge)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE conversations SET last_message=(SELECT substr(content,1,100) FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1),updated_at=COALESCE((SELECT created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1),updated_at) WHERE id=?").bind(&conversation).bind(&conversation).bind(&conversation).execute(&mut *tx).await?;
    let owner=sqlx::query("UPDATE chat_admission_owners SET mode='open',browser_reconciled=0,runtime_generation=NULL WHERE conversation_id=?").bind(&conversation).execute(&mut *tx).await?;
    if owner.rows_affected() != 1 {
        return Err(invalid("connect_publication_owner_missing"));
    }
    sqlx::query("UPDATE connect_preparations SET phase='published' WHERE transfer_id=?")
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE connect_transfers SET resolution='committed' WHERE transfer_id=?")
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    #[cfg(test)]
    checkpoint("before_commit", &input.transfer_id);
    tx.commit().await?;
    lease.committed = true;
    #[cfg(test)]
    checkpoint("after_commit", &input.transfer_id);
    Ok(LocalPublication {
        conversation_id: conversation,
        receipt,
    })
}
// Fixed table/column names come only from this module. Each native allocation
// is a single stored fragment. SQLite may allocate internal pages/FTS work; the
// future resource owner must admit those costs before enabling product use.
async fn copy_text(
    db: &mut SqliteConnection,
    transfer: &str,
    kind: &str,
    ordinal: i64,
    field: &str,
    table: &str,
    column: &str,
    row: i64,
) -> DbResult<()> {
    let bytes:Option<i64>=sqlx::query_scalar("SELECT bytes FROM connect_projection_fields WHERE transfer_id=? AND kind=? AND ordinal=? AND field=?").bind(transfer).bind(kind).bind(ordinal).bind(field).fetch_optional(&mut *db).await?;
    let Some(bytes) = bytes else { return Ok(()) };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE {table} SET {column}=CAST(zeroblob(?) AS TEXT) WHERE rowid=?"
    )))
    .bind(bytes)
    .bind(row)
    .execute(&mut *db)
    .await?;
    if table == "messages" && column == "content" {
        // Remove the zero-filled FTS document BEFORE changing its bytes. A
        // second insert alone corrupts FTS document statistics even when a
        // simple MATCH query appears correct. Publication inserts final text.
        sqlx::query("INSERT INTO message_search(message_search,rowid,content) SELECT 'delete',rowid,content FROM messages WHERE rowid=?").bind(row).execute(&mut *db).await?;
    }
    let table = std::ffi::CString::new(table).unwrap();
    let column = std::ffi::CString::new(column).unwrap();
    let mut offset = 0;
    while offset < bytes {
        let data:Vec<u8>=sqlx::query_scalar("SELECT data FROM connect_projection_fragments WHERE transfer_id=? AND kind=? AND ordinal=? AND field=? AND offset_bytes=? AND length(data)<=4093").bind(transfer).bind(kind).bind(ordinal).bind(field).bind(offset).fetch_one(&mut *db).await?;
        if data.is_empty() || add(offset, data.len() as i64)? > bytes {
            return Err(invalid("connect_projection_incomplete"));
        }
        let position = i32::try_from(offset).map_err(|_| invalid("resource_limit"))?;
        {
            let mut handle = db.lock_handle().await?;
            let mut blob = std::ptr::null_mut();
            let opened = unsafe {
                libsqlite3_sys::sqlite3_blob_open(
                    handle.as_raw_handle().as_ptr(),
                    c"main".as_ptr(),
                    table.as_ptr(),
                    column.as_ptr(),
                    row,
                    1,
                    &mut blob,
                )
            };
            if opened != libsqlite3_sys::SQLITE_OK {
                if !blob.is_null() {
                    unsafe { libsqlite3_sys::sqlite3_blob_close(blob) };
                }
                return Err(invalid("connect_publication_blob_open"));
            }
            let wrote = unsafe {
                libsqlite3_sys::sqlite3_blob_write(
                    blob,
                    data.as_ptr().cast(),
                    data.len() as i32,
                    position,
                )
            };
            let closed = unsafe { libsqlite3_sys::sqlite3_blob_close(blob) };
            if wrote != libsqlite3_sys::SQLITE_OK || closed != libsqlite3_sys::SQLITE_OK {
                return Err(invalid("connect_publication_blob_write"));
            }
        }
        offset = add(offset, data.len() as i64)?;
    }
    Ok(())
}

#[cfg(test)]
fn checkpoint(phase: &str, transfer: &str) {
    if std::env::var("MACRO_PUBLICATION_CRASH_PHASE")
        .ok()
        .as_deref()
        == Some(phase)
        && std::env::var("MACRO_PUBLICATION_CRASH_TRANSFER")
            .ok()
            .as_deref()
            == Some(transfer)
    {
        // A real child process exits without destructors or explicit rollback.
        std::process::exit(91);
    }
}
