//! User-requested local disposal, not a canonical terminal or transfer capability.
//! The ordinary delete owns one FULL/IMMEDIATE transaction and DbReady lifetime.
use super::*;
use sqlx::Row;

const ASSOCIATED: &str = "SELECT t.transfer_id FROM connect_transfers t LEFT JOIN connect_preparations p USING(transfer_id) WHERE ((t.local_role='source' AND t.source_conversation_id=?1) OR (t.local_role='target' AND p.target_conversation_id=?1)) AND t.transfer_id>?2 ORDER BY t.transfer_id LIMIT 1";

pub(in crate::db) async fn begin_in(db: &mut SqliteConnection, conversation: &str, generation: Option<&str>) -> DbResult<()> {
    let any: Option<String> = sqlx::query_scalar(ASSOCIATED).bind(conversation).bind("").fetch_optional(&mut *db).await?;
    if any.is_none() { return Ok(()); }
    // A legacy pool caller cannot fabricate a catalog generation. Only the
    // ordinary command retaining source_ready can enter this branch.
    let generation = generation.ok_or_else(|| invalid("connect_deletion_requires_ready"))?;
    let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?)").bind(conversation).fetch_one(&mut *db).await?;
    if exists == 0 {
        let incomplete: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_local_deletions WHERE conversation_id=? AND phase<>'deleted')").bind(conversation).fetch_one(&mut *db).await?;
        if incomplete != 0 { return Err(invalid("connect_deletion_inconsistent")); }
        return Ok(());
    }
    let owner = sqlx::query("SELECT incarnation,revision,mode FROM chat_admission_owners WHERE conversation_id=?").bind(conversation).fetch_one(&mut *db).await?;
    let incarnation: String = owner.get("incarnation");
    let revision: i64 = owner.get("revision");
    let mode: String = owner.get("mode");
    add(revision, 1)?;
    if !matches!(mode.as_str(), "open" | "ceded") { return Err(invalid("connect_deletion_hold")); }
    crate::db::chat_admission::reconciliation::require_quiescent(db, conversation, &incarnation).await?;
    let mut after = String::new();
    loop {
        let next: Option<String> = sqlx::query_scalar(ASSOCIATED).bind(conversation).bind(&after).fetch_optional(&mut *db).await?;
        let Some(transfer) = next else { break };
        after = transfer.clone();
        let row = sqlx::query("SELECT source_epoch,terminal_fingerprint,inactive_import_id,source_capture_id FROM connect_transfers WHERE transfer_id=?").bind(&transfer).fetch_one(&mut *db).await?;
        let terminal: Vec<u8> = row.get::<Option<Vec<u8>>,_>("terminal_fingerprint").ok_or_else(|| invalid("connect_deletion_hold"))?;
        let epoch: i64 = row.get("source_epoch");
        let import: Option<i64> = row.get("inactive_import_id");
        let capture: Option<i64> = row.get("source_capture_id");
        let receipt = serde_json::to_vec(&(1, &transfer, conversation, &incarnation, revision, &mode, generation, epoch, &terminal, import, capture)).map_err(|_| invalid("connect_deletion_receipt"))?;
        control(&receipt, CONTROL)?;
        let retained = charge(receipt.len() as i64, 256, 384)?;
        admit_journal(db, retained).await?;
        // The declared SQL context rechecks all related transfers and effects,
        // not just this lane, before authorizing any payload deletion.
        sqlx::query("INSERT INTO connect_local_deletions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'deleting',?)")
            .bind(&transfer).bind(conversation).bind(&incarnation).bind(revision).bind(&mode).bind(generation).bind(epoch).bind(&terminal).bind(import).bind(capture).bind(&receipt).bind(hash(&receipt))
            .bind(retained).execute(&mut *db).await?;
    }
    // All contexts exist before removal. No payload is assembled in memory.
    after.clear();
    loop {
        let next: Option<String> = sqlx::query_scalar(ASSOCIATED).bind(conversation).bind(&after).fetch_optional(&mut *db).await?;
        let Some(transfer) = next else { break };
        after = transfer.clone();
        for table in ["connect_projection_display", "connect_projection_fragments", "connect_projection_fields", "connect_projection_assets", "connect_projection_citations", "connect_projection_messages", "connect_raw_chunks", "connect_raw_prefix"] {
            sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE transfer_id=?"))).bind(&transfer).execute(&mut *db).await?;
        }
        let ids: (Option<i64>,Option<i64>) = sqlx::query_as("SELECT import_id,capture_id FROM connect_local_deletions WHERE transfer_id=?").bind(&transfer).fetch_one(&mut *db).await?;
        if let Some(import) = ids.0 {
            for table in ["e_inactive_fragments", "e_inactive_mapping", "e_inactive_records"] {
                sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE import_id=?"))).bind(import).execute(&mut *db).await?;
            }
            // Same retained-parent accounting as E, now with no child content.
            let (old, bytes, digest): (i64,i64,i64) = sqlx::query_as("SELECT charge_bytes,length(CAST(begin_json AS BLOB)),COALESCE(length(mapping_hash),0) FROM e_inactive_imports WHERE id=?").bind(import).fetch_one(&mut *db).await?;
            let compact = add(add(152,bytes)?,digest)?;
            if compact > old { return Err(invalid("connect_deletion_charge_inconsistent")); }
            sqlx::query("UPDATE e_inactive_imports SET charge_bytes=? WHERE id=?").bind(compact).bind(import).execute(&mut *db).await?;
        }
        if let Some(capture) = ids.1 {
            for table in ["e_source_fragments", "e_source_relations", "e_source_fields"] {
                sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE capture_id=?"))).bind(capture).execute(&mut *db).await?;
            }
            let (old, bytes, digest): (i64,i64,i64) = sqlx::query_as("SELECT charge_bytes,length(CAST(binding_json AS BLOB)),COALESCE(length(manifest_hash),0) FROM e_source_captures WHERE id=?").bind(capture).fetch_one(&mut *db).await?;
            let compact = add(add(216,bytes)?,digest)?;
            if compact > old { return Err(invalid("connect_deletion_charge_inconsistent")); }
            sqlx::query("UPDATE e_source_captures SET charge_bytes=? WHERE id=?").bind(compact).bind(capture).execute(&mut *db).await?;
        }
        sqlx::query("UPDATE connect_preparations SET title='' WHERE transfer_id=?").bind(&transfer).execute(&mut *db).await?;
    }
    Ok(())
}

pub(in crate::db) async fn finish_in(db: &mut SqliteConnection, conversation: &str) -> DbResult<()> {
    let mut after = String::new();
    loop {
        let next: Option<String> = sqlx::query_scalar("SELECT transfer_id FROM connect_local_deletions WHERE conversation_id=? AND phase='deleting' AND transfer_id>? ORDER BY transfer_id LIMIT 1").bind(conversation).bind(&after).fetch_optional(&mut *db).await?;
        let Some(transfer) = next else { break };
        after = transfer.clone();
        // Retained preparation metadata and index keys only. Every variable
        // length is read independently and summed with native checked integers.
        if let Some(old) = sqlx::query_scalar::<_, i64>("SELECT charge_bytes FROM connect_preparations WHERE transfer_id=?").bind(&transfer).fetch_optional(&mut *db).await? {
            let mut compact = 512_i64;
            for column in ["transfer_id", "canonical_import_id", "target_conversation_id", "lineage_id", "raw_manifest", "portable_manifest", "storage_manifest", "mapping_hash", "local_generation", "source_generation", "target_generation", "configuration_digest", "preparators_digest", "prepared_digest", "projection_hash", "provider_id", "model_id", "reasoning_effort", "created_at", "fingerprint", "phase", "pin_receipt", "pin_fingerprint"] {
                let bytes: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COALESCE(length(CAST({column} AS BLOB)),0) FROM connect_preparations WHERE transfer_id=?"))).bind(&transfer).fetch_one(&mut *db).await?;
                compact = add(compact, bytes)?;
            }
            // Unique transfer/import/conversation keys retain their index cost.
            compact = add(compact, 256)?;
            if compact > old { return Err(invalid("connect_deletion_charge_inconsistent")); }
            sqlx::query("UPDATE connect_preparations SET charge_bytes=? WHERE transfer_id=?").bind(compact).bind(&transfer).execute(&mut *db).await?;
        }
        sqlx::query("UPDATE connect_local_deletions SET phase='deleted' WHERE transfer_id=?").bind(&transfer).execute(&mut *db).await?;
    }
    Ok(())
}

pub(in crate::db) async fn require_import(db: &mut SqliteConnection, import: i64) -> DbResult<()> {
    let removed: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=?)").bind(import).fetch_one(db).await?;
    if removed != 0 { return Err(invalid("connect_content_removed")); }
    Ok(())
}

pub(super) async fn require_transfer(db: &mut SqliteConnection, transfer: &str) -> DbResult<()> {
    let removed: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=?)").bind(transfer).fetch_one(db).await?;
    if removed != 0 { return Err(invalid("connect_content_removed")); }
    Ok(())
}
