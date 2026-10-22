//! Fixed raw field vocabulary, not a portable context schema.
use super::{error, Result};
use sqlx::{Row, SqliteConnection};
#[derive(Clone, Copy)]
pub(super) struct Family {
    pub table: &'static str,
    pub columns: &'static [&'static str],
    pub integers: &'static [&'static str],
    pub nullable: &'static [&'static str],
    predicate: &'static str,
    key: &'static str,
}
pub(super) const FAMILIES: &[Family] = &[
    Family { table:"conversations",columns:&["id","title","description","scope_mode","task_id","group_id","project_id","provider_id","model_id","reasoning_effort","created_at","updated_at","last_message","message_count","is_pinned"],integers:&["message_count","is_pinned"],nullable:&["description","task_id","group_id","project_id","provider_id","model_id","reasoning_effort","last_message"],predicate:"t.id=?1",key:"id" },
    Family { table:"messages",columns:&["id","conversation_id","turn_id","role","content","created_at","token_count","tool_traces_json","hidden_context","provider_input_items_json","provider_turn_state_json","context_refs_json","completion_reason","generation_attempts_json"],integers:&["token_count"],nullable:&["turn_id","token_count","tool_traces_json","hidden_context","provider_input_items_json","provider_turn_state_json","context_refs_json","completion_reason","generation_attempts_json"],predicate:"t.conversation_id=?1",key:"created_at,id" },
    Family { table:"app_settings",columns:&["key","value_json"],integers:&[],nullable:&[],predicate:"EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=?1 AND m.role='assistant' AND t.key=('chat:assistant-visible-provenance:v1:'||m.id) COLLATE BINARY)",key:"key" },
    Family { table:"conversation_management",columns:&["conversation_id","revision","archived","response_revision","read_revision"],integers:&["revision","archived","response_revision","read_revision"],nullable:&[],predicate:"t.conversation_id=?1",key:"conversation_id" },
    Family { table:"conversation_response_versions",columns:&["message_id","conversation_id","revision","read_revision"],integers:&["revision","read_revision"],nullable:&[],predicate:"t.conversation_id=?1 OR EXISTS(SELECT 1 FROM messages m WHERE m.id=t.message_id AND m.conversation_id=?1)",key:"message_id" },
    Family { table:"conversation_compactions",columns:&["conversation_id","up_to_message_id","summary_text","tool_digest_json","used_source_passage_ids_json","interesting_source_passage_ids_json","estimated_tokens_before","estimated_tokens_after","fingerprint","version","pruned_tool_context_message_ids_json","reserved_tokens","footprint_before_json","footprint_after_json","degraded_reason","compaction_kind","compaction_pass","summary_format_version","summary_source","policy_version","fingerprint_inputs_json","source_hashes_json","model_context_window_tokens","provider_id","model_id","checkpoint_health","last_trigger","created_at","updated_at"],integers:&["estimated_tokens_before","estimated_tokens_after","version","reserved_tokens","summary_format_version","policy_version","model_context_window_tokens"],nullable:&["pruned_tool_context_message_ids_json","reserved_tokens","footprint_before_json","footprint_after_json","degraded_reason","compaction_kind","compaction_pass","summary_format_version","summary_source","policy_version","fingerprint_inputs_json","source_hashes_json","model_context_window_tokens","provider_id","model_id","checkpoint_health","last_trigger"],predicate:"t.conversation_id=?1",key:"conversation_id" },
    Family { table:"conversation_citations",columns:&["id","conversation_id","message_id","type","scope","source","title","snippet","content","url","favicon","path","language","size_bytes","kind","reason","created_at","updated_at"],integers:&["size_bytes"],nullable:&["snippet","content","url","favicon","path","language","size_bytes","kind","reason"],predicate:"t.conversation_id=?1",key:"id" },
    Family { table:"conversation_toolbox_state",columns:&["conversation_id","composer_context_refs_json","created_at","updated_at"],integers:&[],nullable:&[],predicate:"t.conversation_id=?1",key:"conversation_id" },
    Family { table:"pilot_message_attachments",columns:&["id","message_id","file_name","mime_type","total_bytes","sha256","data"],integers:&["total_bytes"],nullable:&[],predicate:"EXISTS(SELECT 1 FROM messages m WHERE m.id=t.message_id AND m.conversation_id=?1)",key:"id" },
    Family { table:"pilot_file_sends",columns:&["message_id","turn_id","state","revision","attachment_ids_json","assistant_message_id","context_state"],integers:&["revision"],nullable:&["assistant_message_id"],predicate:"EXISTS(SELECT 1 FROM messages m WHERE m.id=t.message_id AND m.conversation_id=?1)",key:"message_id" },
];
impl Family {
    pub async fn next(
        &self,
        db: &mut SqliteConnection,
        conversation: &str,
        after: Option<i64>,
    ) -> Result<Option<i64>> {
        let keys: Vec<_> = self.key.split(',').collect();
        let left = keys
            .iter()
            .map(|k| format!("t.{k}"))
            .collect::<Vec<_>>()
            .join(",");
        // All identifiers originate from this fixed table. The cursor is rowid,
        // while SQL resolves the actual native ordering under the same token.
        let query=format!("SELECT t.rowid FROM {} t WHERE ({}) AND (?2 IS NULL OR ({})>(SELECT {} FROM {} WHERE rowid=?2)) ORDER BY {} LIMIT 1",self.table,self.predicate,left,self.key,self.table,left);
        sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .bind(conversation)
            .bind(after)
            .fetch_optional(db)
            .await
            .map_err(error)
    }
    pub async fn scalar(
        &self,
        db: &mut SqliteConnection,
        row: i64,
        tag: usize,
    ) -> Result<(i64, Option<i64>)> {
        let column = self.columns.get(tag).ok_or("invalid_cursor")?;
        let query=format!("SELECT CASE typeof({column}) WHEN 'null' THEN 0 WHEN 'integer' THEN 1 WHEN 'text' THEN 2 WHEN 'blob' THEN 3 ELSE 4 END AS kind,CASE WHEN typeof({column})='integer' THEN {column} END AS value FROM {} WHERE rowid=?",self.table);
        let value = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(row)
            .fetch_one(db)
            .await
            .map_err(error)?;
        let kind: i64 = value.try_get("kind").map_err(error)?;
        let expected = if *column == "data" && self.table == "pilot_message_attachments" {
            3
        } else if self.integers.contains(column) {
            1
        } else {
            2
        };
        if kind != expected && !(kind == 0 && self.nullable.contains(column)) {
            return Err("source_type_invalid".into());
        }
        Ok((kind, value.try_get("value").map_err(error)?))
    }
}
