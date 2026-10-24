//! Local immutable data reads. No transfer capability is constructed here.
//! The page retains native memory and DbReady lifetimes. There is deliberately
//! no IPC serializer: renderer/encoding/cache ownership must be joined before
//! that boundary can open, rather than dropping this charge at command return.
use super::*;
use crate::{
    config::ConfigManager,
    connect_resources::{WorkingCharge, WORKING_OWNER},
    core::db_state::{DbPool, DbSourceGuard},
    db::inactive_storage::{self, Begin, RecordHeader, RecordKind},
};
use sqlx::{Connection, Row};

const PAGE_ITEMS: usize = 32;
// Includes SQLite copies, validated headers, UUIDs, fragments and page vectors.
// This is per-page admission, never a ceiling on the archive's record count.
const PAGE_WORKING_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Cursor {
    generation: String,
    conversation: String,
    binding: Vec<u8>,
    end: i64,
    ordinal: i64,
    offset: i64,
}
pub(super) enum Selector<'a> {
    All,
    Ordinal(i64),
    Uuid(&'a str),
}
pub(super) struct Archive {
    pub(super) transfer: String,
    pub(super) import: i64,
    pub(super) records: i64,
    pub(super) begin: Begin,
    pub(super) binding: Vec<u8>,
    pub(super) manifest: String,
}
pub(super) struct Fragment {
    pub(super) record: RecordHeader,
    pub(super) target_uuid: Option<String>,
    pub(super) offset: i64,
    pub(super) bytes: Vec<u8>,
}
pub(super) struct PageData {
    pub(super) fragments: Vec<Fragment>,
    pub(super) next: Option<Cursor>,
}
struct Page {
    // Payload drops before its physical charge and generation guard.
    data: PageData,
    _charge: WorkingCharge,
    _generation: DbSourceGuard,
}

async fn read(
    owner: &DbPool,
    manager: &ConfigManager,
    generation: Option<&str>,
    conversation: &str,
    selector: Selector<'_>,
    after: Option<&Cursor>,
    limit: usize,
) -> DbResult<Page> {
    if limit == 0 || limit > PAGE_ITEMS || conversation.len() > 36 {
        return Err(invalid("invalid_cursor"));
    }
    let generation = owner
        .source_ready(generation)
        .await
        .map_err(|_| invalid("stale_revision"))?;
    let working = WORKING_OWNER
        .admit(manager)
        .await
        .map_err(|_| invalid("resource_limit"))?;
    working
        .before_phase()
        .await
        .map_err(|_| invalid("resource_limit"))?;
    let charge = working
        .reserve(PAGE_WORKING_BYTES)
        .await
        .map_err(|_| invalid("resource_limit"))?;
    // Declared last: on cancellation SQLite closes before either retained
    // physical lifetime above is released.
    let mut lease = lease(&generation.ready.pool).await?;
    let mut tx = lease.begin().await?;
    generation.ready.check_source_schema(&mut tx).await?;
    let data = page_in(
        &mut tx,
        &generation.ready.catalog_generation,
        conversation,
        selector,
        after,
        limit,
    )
    .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(Page {
        data,
        _charge: charge,
        _generation: generation,
    })
}

// The SQL portion is tested separately. Those tests prove neither native
// allocation admission nor IPC ownership, and cannot enable a product factory.
pub(super) async fn page_in(
    db: &mut SqliteConnection,
    generation: &str,
    conversation: &str,
    selector: Selector<'_>,
    after: Option<&Cursor>,
    limit: usize,
) -> DbResult<PageData> {
    if limit == 0 || limit > PAGE_ITEMS {
        return Err(invalid("invalid_cursor"));
    }
    let archive = resolve_in(db, generation, conversation).await?;
    let Archive {
        import,
        records,
        begin,
        binding,
        ..
    } = archive;
    let start = match selector {
        Selector::All => None,
        Selector::Ordinal(value) => Some(value),
        Selector::Uuid(value) => {
            uuid(value)?;
            Some(
                sqlx::query_scalar(
                    "SELECT ordinal FROM e_inactive_mapping WHERE import_id=? AND target_uuid=?",
                )
                .bind(import)
                .bind(value)
                .fetch_optional(&mut *db)
                .await?
                .ok_or_else(|| invalid("archive_record_not_found"))?,
            )
        }
    };
    if start.is_some_and(|v| v < 0 || v >= records) {
        return Err(invalid("archive_record_not_found"));
    }
    let end = start.map_or(records, |v| v + 1);
    let mut cursor = Cursor {
        generation: generation.into(),
        conversation: conversation.into(),
        binding,
        end,
        ordinal: start.unwrap_or(0),
        offset: 0,
    };
    if let Some(after) = after {
        if after.generation != cursor.generation
            || after.conversation != cursor.conversation
            || after.binding != cursor.binding
            || after.end != end
            || after.ordinal < cursor.ordinal
            || after.ordinal >= end
            || after.offset < 0
        {
            return Err(invalid("invalid_cursor"));
        }
        cursor.ordinal = after.ordinal;
        cursor.offset = after.offset;
    }
    read_records(db, &begin, import, cursor, limit).await
}

/// Shared immutable identity validation for record, projection and resource reads.
/// This is a local data binding and never a transport capability.
pub(super) async fn resolve_in(
    db: &mut SqliteConnection,
    generation: &str,
    conversation: &str,
) -> DbResult<Archive> {
    let row = sqlx::query("SELECT p.transfer_id,p.canonical_import_id,p.import_id,p.import_revision,p.fingerprint,p.raw_manifest,p.portable_manifest,p.storage_manifest,p.mapping_hash,p.projection_hash,p.pin_fingerprint,p.prepared_digest,r.fingerprint AS activation_fingerprint,i.begin_json,i.next_record FROM conversation_portable_archives a JOIN connect_preparations p ON p.transfer_id=a.transfer_id JOIN connect_activation_receipts r ON r.transfer_id=p.transfer_id JOIN connect_transfers t ON t.transfer_id=p.transfer_id JOIN e_inactive_imports i ON i.id=a.import_id JOIN conversations c ON c.id=a.conversation_id JOIN chat_admission_owners o ON o.conversation_id=c.id WHERE a.conversation_id=? AND p.target_conversation_id=c.id AND r.conversation_id=c.id AND a.import_id=p.import_id AND a.import_revision=p.import_revision AND a.manifest=p.storage_manifest AND a.mapping_hash=p.mapping_hash AND r.preparation_fingerprint=p.fingerprint AND r.terminal_digest=t.terminal_digest AND r.terminal_exact=t.terminal_exact AND t.terminal_outcome='committed' AND t.resolution='committed' AND p.phase='published' AND p.pin_fingerprint IS NOT NULL AND o.mode<>'removed' AND length(CAST(i.begin_json AS BLOB))<=4096 AND NOT EXISTS(SELECT 1 FROM connect_local_deletions d WHERE d.transfer_id=p.transfer_id)")
        .bind(conversation).fetch_optional(&mut *db).await?
        .ok_or_else(|| invalid("archive_unavailable"))?;
    let transfer: String = row.get("transfer_id");
    super::preparation::check_import(&mut *db, &transfer).await?;
    let begin: Begin = serde_json::from_str(&row.get::<String, _>("begin_json"))
        .map_err(|_| invalid("integrity_failed"))?;
    let records = i64::try_from(begin.records).map_err(|_| invalid("integrity_failed"))?;
    if records != row.get::<i64, _>("next_record") {
        return Err(invalid("integrity_failed"));
    }
    let import: i64 = row.get("import_id");
    let binding = fingerprint(&(
        generation,
        conversation,
        &transfer,
        row.get::<String, _>("canonical_import_id"),
        import,
        row.get::<i64, _>("import_revision"),
        row.get::<Vec<u8>, _>("fingerprint"),
        row.get::<Vec<u8>, _>("raw_manifest"),
        row.get::<Vec<u8>, _>("portable_manifest"),
        row.get::<Vec<u8>, _>("storage_manifest"),
        row.get::<Vec<u8>, _>("mapping_hash"),
        row.get::<Vec<u8>, _>("projection_hash"),
        row.get::<Vec<u8>, _>("pin_fingerprint"),
        row.get::<Vec<u8>, _>("activation_fingerprint"),
    ))?
    .0;
    Ok(Archive {
        transfer,
        import,
        records,
        begin,
        binding,
        manifest: row
            .get::<Vec<u8>, _>("storage_manifest")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    })
}

async fn read_records(
    db: &mut SqliteConnection,
    begin: &Begin,
    import: i64,
    mut cursor: Cursor,
    limit: usize,
) -> DbResult<PageData> {
    let end = cursor.end;
    let mut fragments = Vec::with_capacity(limit);
    while fragments.len() < limit && cursor.ordinal < end {
        // Do not filter malformed or absent data out: that would manufacture an
        // EOF. Each expected ordinal and exact offset must be present.
        let item = sqlx::query("SELECT CASE WHEN length(CAST(r.header_json AS BLOB))<=4096 THEN r.header_json END AS header_json,r.complete,r.kind,r.from_record,r.to_record,r.position,r.relation,m.target_uuid,f.offset_bytes,CASE WHEN typeof(f.data)='blob' AND length(f.data)<=4093 THEN f.data END AS data,f.sha256 FROM e_inactive_records r LEFT JOIN e_inactive_mapping m ON m.import_id=r.import_id AND m.ordinal=r.ordinal LEFT JOIN e_inactive_fragments f ON f.import_id=r.import_id AND f.ordinal=r.ordinal AND f.offset_bytes=? WHERE r.import_id=? AND r.ordinal=?")
            .bind(cursor.offset).bind(import).bind(cursor.ordinal).fetch_optional(&mut *db).await?
            .ok_or_else(|| invalid("integrity_failed"))?;
        let header: String = item
            .get::<Option<String>, _>("header_json")
            .ok_or_else(|| invalid("integrity_failed"))?;
        let record = inactive_storage::published_record(
            begin,
            header.as_bytes(),
            item.get("kind"),
            (
                item.get("from_record"),
                item.get("to_record"),
                item.get("position"),
                item.get("relation"),
            ),
        )
        .map_err(|_| invalid("integrity_failed"))?;
        let payload = item
            .get::<Option<Vec<u8>>, _>("data")
            .ok_or_else(|| invalid("integrity_failed"))?;
        let digest = item
            .get::<Option<Vec<u8>>, _>("sha256")
            .ok_or_else(|| invalid("integrity_failed"))?;
        let target: Option<String> = item.get("target_uuid");
        if record.ordinal != cursor.ordinal as u64
            || item.get::<i64, _>("complete") != 1
            || hash(&payload) != digest
        {
            return Err(invalid("integrity_failed"));
        }
        if let RecordKind::Association {
            from,
            to,
            position,
            relation: _,
        } = &record.entry
        {
            if target.is_some()
                || item.get::<i64, _>("kind") != 4
                || item.get::<Option<i64>, _>("from_record") != Some(*from as i64)
                || item.get::<Option<i64>, _>("to_record") != Some(*to as i64)
                || item.get::<Option<i64>, _>("position") != Some(*position as i64)
            {
                return Err(invalid("integrity_failed"));
            }
            let valid: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e_inactive_records a JOIN e_inactive_records f ON f.import_id=a.import_id AND f.ordinal=a.from_record JOIN e_inactive_records t ON t.import_id=a.import_id AND t.ordinal=a.to_record WHERE a.import_id=? AND a.ordinal=? AND f.kind=0 AND t.kind=CASE a.relation WHEN 0 THEN 3 WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE -1 END)")
                .bind(import).bind(cursor.ordinal).fetch_one(&mut *db).await?;
            if valid != 1 {
                return Err(invalid("integrity_failed"));
            }
        } else {
            uuid(
                target
                    .as_deref()
                    .ok_or_else(|| invalid("integrity_failed"))?,
            )?;
        }
        let next_offset = add(cursor.offset, payload.len() as i64)?;
        let bytes = i64::try_from(record.bytes).map_err(|_| invalid("integrity_failed"))?;
        if next_offset > bytes
            || (payload.is_empty() && bytes != 0)
            || (cursor.offset > 0 && cursor.offset >= bytes)
        {
            return Err(invalid("integrity_failed"));
        }
        fragments.push(Fragment {
            record,
            target_uuid: target,
            offset: cursor.offset,
            bytes: payload,
        });
        if next_offset == bytes {
            cursor.ordinal += 1;
            cursor.offset = 0;
        } else {
            cursor.offset = next_offset;
        }
    }
    Ok(PageData {
        fragments,
        next: (cursor.ordinal < end).then_some(cursor),
    })
}
