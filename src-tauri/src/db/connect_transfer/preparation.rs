//! Closed preparation storage, not a worker or a product pin factory. Inputs
//! have no Deserialize/IPC path. The future native worker must supply admitted,
//! validated projections and native builders before these transitions can open.
use super::*;
use sqlx::{Connection, Row};

#[derive(Serialize)]
struct Spec {
    transfer_id: String,
    reservation_fingerprint: Vec<u8>,
    import_key: String,
    import_revision: i64,
    lineage_id: String,
    raw_manifest: Vec<u8>,
    portable_manifest: Vec<u8>,
    storage_manifest: Vec<u8>,
    mapping_hash: Vec<u8>,
    local_generation: String,
    source_generation: String,
    target_generation: String,
    configuration_digest: Vec<u8>,
    preparators_digest: Vec<u8>,
    preparation_revision: i64,
    provider_id: String,
    model_id: String,
    reasoning_effort: Option<String>,
    title: String,
    created_at: String,
    message_count: i64,
    citation_count: i64,
    asset_count: i64,
}
#[derive(Debug, PartialEq, Eq)]
struct Allocation {
    canonical_import_id: String,
    conversation_id: String,
    fingerprint: Vec<u8>,
}
pub(super) async fn grow(db: &mut SqliteConnection, transfer: &str, extra: i64) -> DbResult<()> {
    admit(db, extra).await?;
    let before: i64 =
        sqlx::query_scalar("SELECT charge_bytes FROM connect_preparations WHERE transfer_id=?")
            .bind(transfer)
            .fetch_one(&mut *db)
            .await?;
    sqlx::query("UPDATE connect_preparations SET charge_bytes=? WHERE transfer_id=?")
        .bind(add(before, extra)?)
        .bind(transfer)
        .execute(db)
        .await?;
    Ok(())
}
async fn mutable(db: &mut SqliteConnection, transfer: &str, phase: &str) -> DbResult<()> {
    super::deletion::require_transfer(db, transfer).await?;
    let valid:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_preparations p JOIN connect_transfers t USING(transfer_id) WHERE transfer_id=? AND p.phase=? AND t.restore_hold=0 AND t.phase<>'reconciliation_required' AND t.resolution IS NULL AND t.terminal_outcome IS NULL)").bind(transfer).bind(phase).fetch_one(db).await?;
    if valid != 1 {
        return Err(invalid("connect_preparation_not_mutable"));
    }
    Ok(())
}
pub(super) async fn check_import(db: &mut SqliteConnection, transfer: &str) -> DbResult<()> {
    super::deletion::require_transfer(db, transfer).await?;
    let row=sqlx::query("SELECT p.import_id,p.import_revision,p.storage_manifest,p.mapping_hash,p.local_generation,p.source_generation,p.target_generation,t.inactive_import_id,t.source_generation AS actual_source,t.target_generation AS actual_target,i.phase,i.revision,i.mapping_hash AS actual_mapping,i.begin_json FROM connect_preparations p JOIN connect_transfers t USING(transfer_id) JOIN e_inactive_imports i ON i.id=p.import_id WHERE p.transfer_id=?")
        .bind(transfer).fetch_one(&mut *db).await?;
    let begin: crate::db::inactive_storage::Begin =
        serde_json::from_str(&row.get::<String, _>("begin_json"))
            .map_err(|_| invalid("connect_preparation_import_stale"))?;
    if row.get::<i64, _>("phase") != 2
        || row.get::<i64, _>("revision") != row.get::<i64, _>("import_revision")
        || row.get::<Option<i64>, _>("inactive_import_id") != Some(row.get("import_id"))
        || row.get::<Vec<u8>, _>("mapping_hash") != row.get::<Vec<u8>, _>("actual_mapping")
        || begin.manifest_sha256 != hex(&row.get::<Vec<u8>, _>("storage_manifest"))
        || row.get::<String, _>("source_generation") != row.get::<String, _>("actual_source")
        || row.get::<String, _>("target_generation") != row.get::<String, _>("actual_target")
    {
        return Err(invalid("connect_preparation_import_stale"));
    }
    Ok(())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
async fn begin(pool: &SqlitePool, spec: &Spec) -> DbResult<Allocation> {
    uuid(&spec.lineage_id)?;
    for value in [
        &spec.raw_manifest,
        &spec.portable_manifest,
        &spec.storage_manifest,
        &spec.mapping_hash,
        &spec.configuration_digest,
        &spec.preparators_digest,
        &spec.reservation_fingerprint,
    ] {
        if value.len() != 32 {
            return Err(invalid("connect_preparation_invalid_input"));
        }
    }
    for text in [
        &spec.local_generation,
        &spec.source_generation,
        &spec.target_generation,
        &spec.provider_id,
        &spec.model_id,
        &spec.created_at,
    ] {
        control(text.as_bytes(), CONTROL)?;
    }
    if spec.import_revision < 0
        || spec.preparation_revision <= 0
        || spec.message_count < 0
        || spec.citation_count < 0
        || spec.asset_count < 0
    {
        return Err(invalid("connect_preparation_invalid_input"));
    }
    let (fp, bytes) = fingerprint(spec)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    super::deletion::require_transfer(&mut tx, &spec.transfer_id).await?;
    if let Some(row)=sqlx::query("SELECT canonical_import_id,target_conversation_id,fingerprint FROM connect_preparations WHERE transfer_id=?").bind(&spec.transfer_id).fetch_optional(&mut *tx).await? {
        if row.get::<Vec<u8>,_>("fingerprint")!=fp {return Err(invalid("connect_preparation_conflict"));}
        let result=Allocation{canonical_import_id:row.get("canonical_import_id"),conversation_id:row.get("target_conversation_id"),fingerprint:fp};
        tx.commit().await?;lease.committed=true;return Ok(result);
    }
    let import:Option<i64>=sqlx::query_scalar("SELECT t.inactive_import_id FROM connect_transfers t JOIN e_inactive_imports i ON i.id=t.inactive_import_id WHERE t.transfer_id=? AND t.local_role='target' AND t.fingerprint=? AND i.identity_key=? AND t.restore_hold=0 AND t.phase='receiving' AND EXISTS(SELECT 1 FROM connect_raw_prefix r WHERE r.transfer_id=t.transfer_id AND r.eof=1) AND t.resolution IS NULL AND t.terminal_outcome IS NULL")
        .bind(&spec.transfer_id).bind(&spec.reservation_fingerprint).bind(&spec.import_key).fetch_optional(&mut *tx).await?;
    let import = import.ok_or_else(|| invalid("connect_preparation_import_unavailable"))?;
    let allocation = Allocation {
        canonical_import_id: uuid::Uuid::new_v4().to_string(),
        conversation_id: uuid::Uuid::new_v4().to_string(),
        fingerprint: fp.clone(),
    };
    let extra = charge(bytes, 256, 1024)?;
    admit_journal(&mut tx, extra).await?;
    sqlx::query("INSERT INTO connect_preparations(transfer_id,canonical_import_id,target_conversation_id,import_id,import_revision,lineage_id,raw_manifest,portable_manifest,storage_manifest,mapping_hash,local_generation,source_generation,target_generation,configuration_digest,preparators_digest,preparation_revision,provider_id,model_id,reasoning_effort,title,created_at,message_count,citation_count,asset_count,fingerprint,phase,charge_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',?)")
        .bind(&spec.transfer_id).bind(&allocation.canonical_import_id).bind(&allocation.conversation_id).bind(import).bind(spec.import_revision).bind(&spec.lineage_id).bind(&spec.raw_manifest).bind(&spec.portable_manifest).bind(&spec.storage_manifest).bind(&spec.mapping_hash).bind(&spec.local_generation).bind(&spec.source_generation).bind(&spec.target_generation).bind(&spec.configuration_digest).bind(&spec.preparators_digest).bind(spec.preparation_revision).bind(&spec.provider_id).bind(&spec.model_id).bind(&spec.reasoning_effort).bind(&spec.title).bind(&spec.created_at).bind(spec.message_count).bind(spec.citation_count).bind(spec.asset_count).bind(fp).bind(extra).execute(&mut *tx).await?;
    check_import(&mut tx, &spec.transfer_id).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(allocation)
}
#[derive(Serialize)]
struct DisplayDate {
    original_date: Option<String>,
    inherited_from: Option<i64>,
}
#[derive(Serialize)]
enum Header {
    Message {
        role: String,
        created_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_date: Option<DisplayDate>,
    },
    Citation {
        message_ordinal: i64,
        r#type: String,
        scope: String,
        kind: Option<String>,
    },
    Asset {
        message_ordinal: i64,
        position: i64,
        mime_type: String,
    },
}
impl Header {
    fn kind(&self) -> &'static str {
        match self {
            Self::Message { .. } => "message",
            Self::Citation { .. } => "citation",
            Self::Asset { .. } => "asset",
        }
    }
    fn table(&self) -> &'static str {
        match self {
            Self::Message { .. } => "connect_projection_messages",
            Self::Citation { .. } => "connect_projection_citations",
            Self::Asset { .. } => "connect_projection_assets",
        }
    }
}
#[derive(Serialize)]
struct Field {
    name: String,
    bytes: i64,
    sha256: Vec<u8>,
}
#[derive(Serialize)]
struct Entry {
    transfer_id: String,
    ordinal: i64,
    source_ordinal: Option<i64>,
    header: Header,
    fields: Vec<Field>,
}
async fn entry(pool: &SqlitePool, input: &Entry) -> DbResult<String> {
    if input.ordinal < 0 || input.source_ordinal.is_some_and(|n| n < 0) || input.fields.len() > 4 {
        return Err(invalid("connect_projection_invalid_input"));
    }
    let names: std::collections::BTreeSet<&str> =
        input.fields.iter().map(|f| f.name.as_str()).collect();
    let shape = match &input.header {
        Header::Message { .. } => names == std::collections::BTreeSet::from(["content"]),
        Header::Asset { .. } => names == std::collections::BTreeSet::from(["data"]),
        Header::Citation { .. } => {
            names.contains("source")
                && names.contains("title")
                && names
                    .iter()
                    .all(|n| matches!(*n, "source" | "title" | "content" | "snippet"))
        }
    };
    if !shape
        || names.len() != input.fields.len()
        || input
            .fields
            .iter()
            .any(|f| f.bytes < 0 || f.sha256.len() != 32)
    {
        return Err(invalid("connect_projection_invalid_input"));
    }
    let (fp, bytes) = fingerprint(input)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let lookup = sqlx::AssertSqlSafe(format!(
        "SELECT id,fingerprint FROM {} WHERE transfer_id=? AND ordinal=?",
        input.header.table()
    ));
    if let Some(row) = sqlx::query(lookup)
        .bind(&input.transfer_id)
        .bind(input.ordinal)
        .fetch_optional(&mut *tx)
        .await?
    {
        if row.get::<Vec<u8>, _>("fingerprint") != fp {
            return Err(invalid("connect_projection_conflict"));
        }
        let id = row.get("id");
        tx.commit().await?;
        lease.committed = true;
        return Ok(id);
    }
    mutable(&mut tx, &input.transfer_id, "preparing").await?;
    let id = if let Some(ordinal) = input.source_ordinal {
        sqlx::query_scalar("SELECT m.target_uuid FROM e_inactive_mapping m JOIN connect_preparations p ON p.import_id=m.import_id JOIN e_inactive_records r ON r.import_id=m.import_id AND r.ordinal=m.ordinal WHERE p.transfer_id=? AND m.ordinal=? AND r.kind IN (?,?)").bind(&input.transfer_id).bind(ordinal).bind(match &input.header {Header::Message{..}=>0,Header::Citation{..}=>2,Header::Asset{..}=>3}).bind(match &input.header {Header::Message{..}=>1,Header::Citation{..}=>2,Header::Asset{..}=>3}).fetch_one(&mut *tx).await?
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    grow(&mut tx, &input.transfer_id, charge(bytes, 256, 512)?).await?;
    match &input.header {
        Header::Message {
            role,
            created_at,
            display_date,
        } => {
            sqlx::query("INSERT INTO connect_projection_messages VALUES(?,?,?,?,?,?,?)")
                .bind(&input.transfer_id)
                .bind(input.ordinal)
                .bind(&id)
                .bind(role)
                .bind(created_at)
                .bind(input.source_ordinal)
                .bind(&fp)
                .execute(&mut *tx)
                .await?;
            if let Some(display) = display_date {
                if display.inherited_from.is_some_and(|n| n < 0)
                    || display
                        .original_date
                        .as_ref()
                        .is_some_and(|date| date.len() > CONTROL)
                {
                    return Err(invalid("connect_projection_invalid_date"));
                }
                grow(&mut tx, &input.transfer_id, 512).await?;
                sqlx::query("INSERT INTO connect_projection_display VALUES(?,?,?,?)")
                    .bind(&input.transfer_id)
                    .bind(input.ordinal)
                    .bind(&display.original_date)
                    .bind(display.inherited_from)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        Header::Citation {
            message_ordinal,
            r#type,
            scope,
            kind,
        } => {
            sqlx::query("INSERT INTO connect_projection_citations SELECT ?,?,?,m.id,?,?,?,? FROM connect_projection_messages m WHERE transfer_id=? AND ordinal=?")
                .bind(&input.transfer_id).bind(input.ordinal).bind(&id).bind(r#type).bind(scope).bind(kind).bind(&fp).bind(&input.transfer_id).bind(message_ordinal).execute(&mut *tx).await?;
        }
        Header::Asset {
            message_ordinal,
            position,
            mime_type,
        } => {
            sqlx::query("INSERT INTO connect_projection_assets SELECT ?,?,?,m.id,?,?,? FROM connect_projection_messages m WHERE transfer_id=? AND ordinal=?")
                .bind(&input.transfer_id).bind(input.ordinal).bind(&id).bind(position).bind(mime_type).bind(&fp).bind(&input.transfer_id).bind(message_ordinal).execute(&mut *tx).await?;
        }
    }
    // Reject a missing owning message rather than storing orphan fields.
    let exists: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM {} WHERE transfer_id=? AND ordinal=?",
        input.header.table()
    )))
    .bind(&input.transfer_id)
    .bind(input.ordinal)
    .fetch_one(&mut *tx)
    .await?;
    if exists != 1 {
        return Err(invalid("connect_projection_owner_missing"));
    }
    for field in &input.fields {
        sqlx::query("INSERT INTO connect_projection_fields(transfer_id,kind,ordinal,field,bytes,sha256) VALUES(?,?,?,?,?,?)").bind(&input.transfer_id).bind(input.header.kind()).bind(input.ordinal).bind(&field.name).bind(field.bytes).bind(&field.sha256).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(id)
}
struct Fragment<'a> {
    transfer: &'a str,
    kind: &'a str,
    ordinal: i64,
    field: &'a str,
    offset: i64,
    data: &'a [u8],
    sha256: &'a [u8],
}
async fn append(pool: &SqlitePool, f: &Fragment<'_>) -> DbResult<()> {
    control(f.data, 4093)?;
    if hash(f.data) != f.sha256 {
        return Err(invalid("connect_projection_hash"));
    }
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    if let Some(old)=sqlx::query_scalar::<_,Vec<u8>>("SELECT data FROM connect_projection_fragments WHERE transfer_id=? AND kind=? AND ordinal=? AND field=? AND offset_bytes=?")
        .bind(f.transfer).bind(f.kind).bind(f.ordinal).bind(f.field).bind(f.offset).fetch_optional(&mut *tx).await? {
        if old!=f.data {return Err(invalid("connect_projection_conflict"));}
        tx.commit().await?;lease.committed=true;return Ok(());
    }
    mutable(&mut tx, f.transfer, "preparing").await?;
    let (total,received):(i64,i64)=sqlx::query_as("SELECT bytes,received FROM connect_projection_fields WHERE transfer_id=? AND kind=? AND ordinal=? AND field=?").bind(f.transfer).bind(f.kind).bind(f.ordinal).bind(f.field).fetch_one(&mut *tx).await?;
    let end = add(f.offset, f.data.len() as i64)?;
    if f.offset != received || end > total {
        return Err(invalid("connect_projection_cursor"));
    }
    grow(&mut tx, f.transfer, charge(f.data.len() as i64, 128, 128)?).await?;
    sqlx::query("INSERT INTO connect_projection_fragments VALUES(?,?,?,?,?,?,?)")
        .bind(f.transfer)
        .bind(f.kind)
        .bind(f.ordinal)
        .bind(f.field)
        .bind(f.offset)
        .bind(f.data)
        .bind(f.sha256)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE connect_projection_fields SET received=? WHERE transfer_id=? AND kind=? AND ordinal=? AND field=?").bind(end).bind(f.transfer).bind(f.kind).bind(f.ordinal).bind(f.field).execute(&mut *tx).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
// One field and one <=4093-byte fragment at a time, never fetch_all(history).
async fn verify_fields(db: &mut SqliteConnection, transfer: &str) -> DbResult<()> {
    let mut cursor = (String::new(), -1_i64, String::new());
    loop {
        let row=sqlx::query("SELECT kind,ordinal,field,bytes,received,sha256 FROM connect_projection_fields WHERE transfer_id=? AND (kind,ordinal,field)>(?,?,?) ORDER BY kind,ordinal,field LIMIT 1")
            .bind(transfer).bind(&cursor.0).bind(cursor.1).bind(&cursor.2).fetch_optional(&mut *db).await?;
        let Some(row) = row else { break };
        cursor = (row.get("kind"), row.get("ordinal"), row.get("field"));
        let bytes: i64 = row.get("bytes");
        if row.get::<i64, _>("received") != bytes {
            return Err(invalid("connect_projection_incomplete"));
        }
        let mut offset = 0;
        let mut sha = Sha256::new();
        let mut tail = Vec::<u8>::new();
        while offset < bytes {
            let fragment=sqlx::query("SELECT data,sha256 FROM connect_projection_fragments WHERE transfer_id=? AND kind=? AND ordinal=? AND field=? AND offset_bytes=? AND length(data)<=4093")
                .bind(transfer).bind(&cursor.0).bind(cursor.1).bind(&cursor.2).bind(offset).fetch_one(&mut *db).await?;
            let data: Vec<u8> = fragment.get("data");
            if data.is_empty() || hash(&data) != fragment.get::<Vec<u8>, _>("sha256") {
                return Err(invalid("connect_projection_hash"));
            }
            offset = add(offset, data.len() as i64)?;
            sha.update(&data);
            if cursor.0 != "asset" {
                tail.extend_from_slice(&data);
                match std::str::from_utf8(&tail) {
                    Ok(_) => tail.clear(),
                    Err(e) if e.error_len().is_none() => {
                        tail.drain(..e.valid_up_to());
                    }
                    Err(_) => return Err(invalid("connect_projection_utf8")),
                }
            }
        }
        if offset != bytes
            || !tail.is_empty()
            || sha.finalize().as_slice() != row.get::<Vec<u8>, _>("sha256")
        {
            return Err(invalid("connect_projection_hash"));
        }
    }
    Ok(())
}
async fn finish(
    pool: &SqlitePool,
    transfer: &str,
    expected: &[u8],
    prepared_digest: &[u8],
) -> DbResult<()> {
    if prepared_digest.len() != 32 {
        return Err(invalid("connect_preparation_invalid_input"));
    }
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    super::deletion::require_transfer(&mut tx, transfer).await?;
    let row=sqlx::query("SELECT fingerprint,phase,prepared_digest,message_count,citation_count,asset_count FROM connect_preparations WHERE transfer_id=?").bind(transfer).fetch_one(&mut *tx).await?;
    if row.get::<Vec<u8>, _>("fingerprint") != expected {
        return Err(invalid("connect_preparation_conflict"));
    }
    if row.get::<String, _>("phase") == "preparing" {
        mutable(&mut tx, transfer, "preparing").await?;
        check_import(&mut tx, transfer).await?;
        for (table, column) in [
            ("connect_projection_messages", "message_count"),
            ("connect_projection_citations", "citation_count"),
            ("connect_projection_assets", "asset_count"),
        ] {
            let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table} WHERE transfer_id=?"
            )))
            .bind(transfer)
            .fetch_one(&mut *tx)
            .await?;
            if count != row.get::<i64, _>(column) {
                return Err(invalid("connect_projection_incomplete"));
            }
        }
        verify_fields(&mut tx, transfer).await?;
        let mut digest = Sha256::new();
        digest.update(b"macro.connect.projection.storage.v1\0");
        digest.update(expected);
        for table in [
            "connect_projection_messages",
            "connect_projection_citations",
            "connect_projection_assets",
        ] {
            digest.update(table.as_bytes());
            let mut cursor = -1_i64;
            loop {
                let row=sqlx::query(sqlx::AssertSqlSafe(format!("SELECT ordinal,id,fingerprint FROM {table} WHERE transfer_id=? AND ordinal>? ORDER BY ordinal LIMIT 1"))).bind(transfer).bind(cursor).fetch_optional(&mut *tx).await?;
                let Some(row) = row else { break };
                cursor = row.get("ordinal");
                digest.update(cursor.to_be_bytes());
                digest.update(row.get::<String, _>("id").as_bytes());
                digest.update(row.get::<Vec<u8>, _>("fingerprint"));
            }
        }
        digest.update(b"connect_projection_display\0");
        let mut cursor = -1_i64;
        loop {
            let row = sqlx::query("SELECT ordinal,original_date,inherited_from FROM connect_projection_display WHERE transfer_id=? AND ordinal>? ORDER BY ordinal LIMIT 1")
                .bind(transfer).bind(cursor).fetch_optional(&mut *tx).await?;
            let Some(row) = row else { break };
            cursor = row.get("ordinal");
            let (date_fingerprint, _) = fingerprint(&(
                cursor,
                row.get::<Option<String>, _>("original_date"),
                row.get::<Option<i64>, _>("inherited_from"),
            ))?;
            digest.update(date_fingerprint);
        }
        sqlx::query("UPDATE connect_preparations SET phase='prepared',prepared_digest=?,projection_hash=? WHERE transfer_id=?").bind(prepared_digest).bind(digest.finalize().as_slice()).bind(transfer).execute(&mut *tx).await?;
    } else if row.get::<Option<Vec<u8>>, _>("prepared_digest").as_deref() != Some(prepared_digest) {
        return Err(invalid("connect_preparation_conflict"));
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
#[derive(Serialize)]
struct PinWrite {
    transfer_id: String,
    preparation_fingerprint: Vec<u8>,
    local_generation: String,
    configuration_digest: Vec<u8>,
    preparators_digest: Vec<u8>,
    prepared_digest: Vec<u8>,
    projection_hash: Vec<u8>,
    exact_local_receipt: Vec<u8>,
}
async fn pin(pool: &SqlitePool, input: &PinWrite) -> DbResult<()> {
    control(&input.exact_local_receipt, CONTROL)?;
    let (fp, bytes) = fingerprint(input)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    super::deletion::require_transfer(&mut tx, &input.transfer_id).await?;
    let row=sqlx::query("SELECT fingerprint,local_generation,configuration_digest,preparators_digest,prepared_digest,projection_hash,pin_fingerprint FROM connect_preparations WHERE transfer_id=?").bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    if row.get::<Vec<u8>, _>("fingerprint") != input.preparation_fingerprint
        || row.get::<String, _>("local_generation") != input.local_generation
        || row.get::<Vec<u8>, _>("configuration_digest") != input.configuration_digest
        || row.get::<Vec<u8>, _>("preparators_digest") != input.preparators_digest
        || row.get::<Vec<u8>, _>("prepared_digest") != input.prepared_digest
        || row.get::<Vec<u8>, _>("projection_hash") != input.projection_hash
    {
        return Err(invalid("connect_pin_stale"));
    }
    if let Some(old) = row.get::<Option<Vec<u8>>, _>("pin_fingerprint") {
        if old != fp {
            return Err(invalid("connect_pin_conflict"));
        }
    } else {
        mutable(&mut tx, &input.transfer_id, "prepared").await?;
        check_import(&mut tx, &input.transfer_id).await?;
        grow(&mut tx, &input.transfer_id, charge(bytes, 32, 128)?).await?;
        sqlx::query("UPDATE connect_preparations SET phase='pinned',pin_receipt=?,pin_fingerprint=? WHERE transfer_id=?").bind(&input.exact_local_receipt).bind(fp).bind(&input.transfer_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

/// Storage composition only: no permission is returned. The native reservation
/// caller checks its retained authenticated scope before and after this write.
/// Neither Spec nor Allocation changes shape or visibility.
pub(super) async fn pin_native(
    ready: &crate::core::db_state::DbReady,
    config: &crate::config::ConfigManager,
    expected_reservation: &[u8],
    binding: &serde_json::Value,
    manifest: &serde_json::Value,
    imported: &crate::connect::transfer_worker::TransferWorker,
    prepared: &mut crate::connect::transfer_worker::TransferWorker,
) -> DbResult<serde_json::Value> {
    use crate::commands::pilot_secrets::transport::commitment;
    let decode_hash = |value: &serde_json::Value| -> DbResult<Vec<u8>> {
        let value = value
            .as_str()
            .filter(|s| s.len() == 64)
            .ok_or_else(|| invalid("connect_preparation_invalid_input"))?;
        (0..64)
            .step_by(2)
            .map(|i| {
                value
                    .get(i..i + 2)
                    .and_then(|s| u8::from_str_radix(s, 16).ok())
                    .ok_or_else(|| invalid("connect_preparation_invalid_input"))
            })
            .collect()
    };
    let text = |v: &serde_json::Value| {
        v.as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("connect_preparation_invalid_input"))
    };
    let (draft, request, _, configuration) = prepared.native_prepared().map_err(invalid)?;
    let sealed = imported.imported_storage().map_err(invalid)?;
    let metadata = imported.imported_metadata().map_err(invalid)?;
    let (provider, _, _, fresh) = crate::connect::runtime::transfer_target_snapshot(
        config,
        ready,
        &request.provider_id,
        &request.model_id,
    )
    .await
    .map_err(invalid)?;
    if fresh != configuration {
        return Err(invalid("configuration_changed"));
    }
    // The immutable archive retains checkpoint/tool/attachment data for the
    // model and the existing reader. Only original message records become
    // ordinary chat rows; supplemental context is not a new user message.
    let mut messages = Vec::new();
    for message in draft
        .get("message")
        .ok_or_else(|| invalid("connect_preparation_missing"))?
    {
        let ordinal = text(&message["portable_history"]["sourceOrdinal"])?
            .parse::<i64>()
            .map_err(|_| invalid("connect_projection_invalid_input"))?;
        let kind:i64=sqlx::query_scalar("SELECT r.kind FROM e_inactive_records r JOIN e_inactive_imports i ON i.id=r.import_id WHERE i.identity_key=? AND r.ordinal=?")
            .bind(&sealed.receipt.key).bind(ordinal).fetch_one(&ready.pool).await?;
        if kind == 0 {
            messages.push(message);
        } else if !(1..=3).contains(&kind) {
            return Err(invalid("connect_projection_invalid_input"));
        }
    }
    let citations = draft
        .get("citation")
        .ok_or_else(|| invalid("connect_preparation_missing"))?;
    let images = draft
        .get("image")
        .ok_or_else(|| invalid("connect_preparation_missing"))?;
    let image_count = images
        .iter()
        .map(|group| {
            group["images"]
                .as_array()
                .map(Vec::len)
                .ok_or_else(|| invalid("connect_projection_invalid_input"))
        })
        .collect::<DbResult<Vec<_>>>()?
        .into_iter()
        .sum::<usize>();
    let text_assets=sqlx::query("SELECT r.ordinal,m.target_uuid,a.from_record,a.position FROM e_inactive_records r JOIN e_inactive_imports i ON i.id=r.import_id JOIN e_inactive_mapping m ON m.import_id=r.import_id AND m.ordinal=r.ordinal JOIN e_inactive_records a ON a.import_id=r.import_id AND a.to_record=r.ordinal AND a.kind=4 AND a.relation=0 WHERE i.identity_key=? AND r.kind=3 AND json_extract(r.header_json,'$.entry.mime')='text_plain' ORDER BY a.from_record,a.position")
        .bind(&sealed.receipt.key).fetch_all(&ready.pool).await?;
    let identity: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../copilot-bridge/src/connect-transfer.identity.json"
    ))
    .map_err(|_| invalid("transfer_identity"))?;
    let preparators = decode_hash(&identity["preparation_set_sha256"])?;
    let spec =
        Spec {
            transfer_id: text(&binding["transfer_id"])?,
            reservation_fingerprint: expected_reservation.to_vec(),
            import_key: sealed.receipt.key.clone(),
            import_revision: sealed.receipt.revision,
            lineage_id: uuid::Uuid::new_v4().to_string(),
            raw_manifest: decode_hash(&metadata["captureManifest"])?,
            portable_manifest: decode_hash(&manifest["manifest_sha256"])?,
            storage_manifest: decode_hash(&serde_json::json!(sealed.manifest_sha256))?,
            mapping_hash: decode_hash(&serde_json::json!(sealed
                .receipt
                .mapping_sha256
                .as_ref()
                .ok_or_else(|| invalid("connect_preparation_missing"))?))?,
            local_generation: ready.catalog_generation.clone(),
            source_generation: text(&binding["source_producer_generation"])?,
            target_generation: text(&binding["target_producer_generation"])?,
            configuration_digest: configuration.to_vec(),
            preparators_digest: preparators.clone(),
            preparation_revision: 1,
            provider_id: request.provider_id.clone(),
            model_id: request.model_id.clone(),
            reasoning_effort: request.reasoning_effort.clone(),
            title: source_title(&ready.pool, &sealed.receipt.key)
                .await?
                .unwrap_or_else(|| "Transferred conversation".into()),
            created_at: text(
                &messages
                    .first()
                    .ok_or_else(|| invalid("connect_preparation_missing"))?["timestamp"],
            )?,
            message_count: messages.len() as i64,
            citation_count: citations.len() as i64,
            asset_count: (image_count + text_assets.len()) as i64,
        };
    let allocation = begin(&ready.pool, &spec).await?;
    for (ordinal, message) in messages.iter().enumerate() {
        let content = text(&message["content"])?;
        if content.len() > 65_536 {
            return Err(invalid("resource_limit"));
        }
        let source_ordinal = text(&message["portable_history"]["sourceOrdinal"])?
            .parse::<i64>()
            .map_err(|_| invalid("connect_projection_invalid_input"))?;
        let display = &message["portable_history"];
        let inherited = display["inheritedFrom"]
            .as_str()
            .map(|id| {
                messages
                    .iter()
                    .position(|m| m["id"] == id)
                    .map(|n| n as i64)
                    .ok_or_else(|| invalid("connect_projection_invalid_date"))
            })
            .transpose()?;
        let input = Entry {
            transfer_id: spec.transfer_id.clone(),
            ordinal: ordinal as i64,
            source_ordinal: Some(source_ordinal),
            header: Header::Message {
                role: text(&message["role"])?,
                created_at: text(&message["timestamp"])?,
                display_date: Some(DisplayDate {
                    original_date: display["displayDate"].as_str().map(str::to_owned),
                    inherited_from: inherited,
                }),
            },
            fields: vec![Field {
                name: "content".into(),
                bytes: content.len() as i64,
                sha256: hash(content.as_bytes()),
            }],
        };
        if message["id"] != entry(&ready.pool, &input).await? {
            return Err(invalid("connect_projection_conflict"));
        }
        for (n, data) in content.as_bytes().chunks(4093).enumerate() {
            append(
                &ready.pool,
                &Fragment {
                    transfer: &spec.transfer_id,
                    kind: "message",
                    ordinal: ordinal as i64,
                    field: "content",
                    offset: (n * 4093) as i64,
                    data,
                    sha256: &hash(data),
                },
            )
            .await?;
        }
    }
    for (ordinal, citation) in citations.iter().enumerate() {
        let owner = messages
            .iter()
            .position(|message| message["id"] == citation["messageId"])
            .ok_or_else(|| invalid("connect_projection_owner_missing"))?;
        let source:i64=sqlx::query_scalar("SELECT m.ordinal FROM e_inactive_mapping m JOIN e_inactive_imports i ON i.id=m.import_id JOIN e_inactive_records r ON r.import_id=m.import_id AND r.ordinal=m.ordinal WHERE i.identity_key=? AND m.target_uuid=? AND r.kind=2")
            .bind(&sealed.receipt.key).bind(text(&citation["id"])?).fetch_one(&ready.pool).await?;
        let mut fields = Vec::new();
        for name in ["source", "title", "snippet", "content"] {
            if let Some(value) = citation[name].as_str() {
                fields.push((name.to_owned(), value.as_bytes().to_vec()));
            }
        }
        let id = write_native_entry(
            &ready.pool,
            &spec.transfer_id,
            ordinal as i64,
            source,
            Header::Citation {
                message_ordinal: owner as i64,
                r#type: text(&citation["type"])?,
                scope: text(&citation["scope"])?,
                kind: citation["kind"].as_str().map(str::to_owned),
            },
            fields,
        )
        .await?;
        if citation["id"] != id {
            return Err(invalid("connect_projection_conflict"));
        }
    }
    let mut asset_ordinal = 0_i64;
    for group in images {
        let owner = messages
            .iter()
            .position(|message| message["id"] == group["messageId"])
            .ok_or_else(|| invalid("connect_projection_owner_missing"))?;
        let source_owner = text(&messages[owner]["portable_history"]["sourceOrdinal"])?
            .parse::<i64>()
            .map_err(|_| invalid("connect_projection_invalid_input"))?;
        for image in group["images"]
            .as_array()
            .ok_or_else(|| invalid("connect_projection_invalid_input"))?
        {
            let (source,position):(i64,i64)=sqlx::query_as("SELECT m.ordinal,a.position FROM e_inactive_mapping m JOIN e_inactive_imports i ON i.id=m.import_id JOIN e_inactive_records a ON a.import_id=m.import_id AND a.to_record=m.ordinal AND a.kind=4 AND a.relation=0 WHERE i.identity_key=? AND m.target_uuid=? AND a.from_record=?")
                .bind(&sealed.receipt.key).bind(text(&image["id"])?).bind(source_owner).fetch_one(&ready.pool).await?;
            let (bytes, mime) =
                native_asset_bytes(&ready.pool, &sealed.receipt.key, source).await?;
            use base64::Engine;
            if image["mimeType"] != mime
                || image["dataUrl"]
                    != format!(
                        "data:{mime};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    )
            {
                return Err(invalid("connect_projection_conflict"));
            }
            let id = write_native_entry(
                &ready.pool,
                &spec.transfer_id,
                asset_ordinal,
                source,
                Header::Asset {
                    message_ordinal: owner as i64,
                    position,
                    mime_type: mime,
                },
                vec![("data".into(), bytes)],
            )
            .await?;
            if image["id"] != id {
                return Err(invalid("connect_projection_conflict"));
            }
            asset_ordinal += 1;
        }
    }
    for row in text_assets {
        let source_owner: i64 = row.get("from_record");
        let owner = messages
            .iter()
            .position(|message| {
                message["portable_history"]["sourceOrdinal"].as_str()
                    == Some(source_owner.to_string().as_str())
            })
            .ok_or_else(|| invalid("connect_projection_owner_missing"))?;
        let source: i64 = row.get("ordinal");
        let (bytes, mime) = native_asset_bytes(&ready.pool, &sealed.receipt.key, source).await?;
        let id = write_native_entry(
            &ready.pool,
            &spec.transfer_id,
            asset_ordinal,
            source,
            Header::Asset {
                message_ordinal: owner as i64,
                position: row.get("position"),
                mime_type: mime,
            },
            vec![("data".into(), bytes)],
        )
        .await?;
        if id != row.get::<String, _>("target_uuid") {
            return Err(invalid("connect_projection_conflict"));
        }
        asset_ordinal += 1;
    }
    // Rebuild with the existing SQLite writer's actual conversation id. The
    // history must remain identical; Codex alone updates its conversation cache key.
    prepared
        .retarget_native_preparation(&provider, &allocation.conversation_id, &fresh)
        .map_err(invalid)?;
    let (draft, request, body, configuration) = prepared.native_prepared().map_err(invalid)?;
    let preparation_sha = hash(
        &serde_json::to_vec(&(request, body, configuration, &preparators, draft))
            .map_err(|_| invalid("connect_preparation_invalid_input"))?,
    );
    let value = serde_json::json!({"format_version":"1","binding_digest":manifest["binding_digest"],"manifest_digest":commitment("manifest",manifest).map_err(invalid)?,
        "import_id":allocation.canonical_import_id,"target_conversation_id":allocation.conversation_id,"lineage_id":spec.lineage_id,
        "mapping_sha256":sealed.receipt.mapping_sha256,"preparation_sha256":hex(&preparation_sha)});
    let prepared_digest = decode_hash(&serde_json::json!(
        commitment("prepared", &value).map_err(invalid)?
    ))?;
    finish(
        &ready.pool,
        &spec.transfer_id,
        &allocation.fingerprint,
        &prepared_digest,
    )
    .await?;
    let projection_hash =
        sqlx::query_scalar("SELECT projection_hash FROM connect_preparations WHERE transfer_id=?")
            .bind(&spec.transfer_id)
            .fetch_one(&ready.pool)
            .await?;
    let (_, _, _, current) = crate::connect::runtime::transfer_target_snapshot(
        config,
        ready,
        &request.provider_id,
        &request.model_id,
    )
    .await
    .map_err(invalid)?;
    if current != fresh {
        return Err(invalid("configuration_changed"));
    }
    pin(
        &ready.pool,
        &PinWrite {
            transfer_id: spec.transfer_id,
            preparation_fingerprint: allocation.fingerprint,
            local_generation: spec.local_generation,
            configuration_digest: fresh,
            preparators_digest: preparators,
            prepared_digest,
            projection_hash,
            exact_local_receipt: serde_json::to_vec(&value)
                .map_err(|_| invalid("connect_preparation_invalid_input"))?,
        },
    )
    .await?;
    Ok(value)
}

#[cfg(test)]
#[path = "publication_tests.rs"]
pub(in crate::db::connect_transfer) mod tests;

// Canonical digest already validated by the codec; conversion for SQLite only.
pub(super) fn native_digest_bytes(value: &str) -> DbResult<Vec<u8>> {
    if value.len() != 64 || !value.is_ascii() {
        return Err(invalid("connect_preparation_invalid_input"));
    }
    (0..64)
        .step_by(2)
        .map(|n| {
            u8::from_str_radix(&value[n..n + 2], 16)
                .map_err(|_| invalid("connect_preparation_invalid_input"))
        })
        .collect()
}

async fn write_native_entry(
    pool: &SqlitePool,
    transfer: &str,
    ordinal: i64,
    source: i64,
    header: Header,
    data: Vec<(String, Vec<u8>)>,
) -> DbResult<String> {
    if data.iter().any(|(_, bytes)| bytes.len() > 65_536) {
        return Err(invalid("resource_limit"));
    }
    let input = Entry {
        transfer_id: transfer.into(),
        ordinal,
        source_ordinal: Some(source),
        header,
        fields: data
            .iter()
            .map(|(name, bytes)| Field {
                name: name.clone(),
                bytes: bytes.len() as i64,
                sha256: hash(bytes),
            })
            .collect(),
    };
    let id = entry(pool, &input).await?;
    for (name, bytes) in data {
        for (n, part) in bytes.chunks(4093).enumerate() {
            append(
                pool,
                &Fragment {
                    transfer,
                    kind: input.header.kind(),
                    ordinal,
                    field: &name,
                    offset: (n * 4093) as i64,
                    data: part,
                    sha256: &hash(part),
                },
            )
            .await?;
        }
    }
    Ok(id)
}
async fn native_asset_bytes(
    pool: &SqlitePool,
    key: &str,
    ordinal: i64,
) -> DbResult<(Vec<u8>, String)> {
    use crate::db::inactive_storage::{Mime, RecordHeader, RecordKind};
    let header:String=sqlx::query_scalar("SELECT r.header_json FROM e_inactive_records r JOIN e_inactive_imports i ON i.id=r.import_id WHERE i.identity_key=? AND i.phase=2 AND r.ordinal=? AND r.kind=3 AND r.complete=1")
        .bind(key).bind(ordinal).fetch_one(pool).await?;
    let header: RecordHeader =
        serde_json::from_str(&header).map_err(|_| invalid("integrity_failed"))?;
    if header.bytes > 65_536 {
        return Err(invalid("resource_limit"));
    }
    let mime = match header.entry {
        RecordKind::Asset {
            mime: Mime::TextPlain,
        } => "text/plain",
        RecordKind::Asset {
            mime: Mime::ImagePng,
        } => "image/png",
        RecordKind::Asset {
            mime: Mime::ImageJpeg,
        } => "image/jpeg",
        RecordKind::Asset {
            mime: Mime::ImageWebp,
        } => "image/webp",
        _ => return Err(invalid("integrity_failed")),
    };
    Ok((
        record_bytes(pool, key, ordinal, &header).await?,
        mime.into(),
    ))
}
/// A complete record's payload, each fragment and the whole checked against
/// their stored and declared hashes.
async fn record_bytes(
    pool: &SqlitePool,
    key: &str,
    ordinal: i64,
    header: &crate::db::inactive_storage::RecordHeader,
) -> DbResult<Vec<u8>> {
    let rows=sqlx::query("SELECT f.offset_bytes,f.data,f.sha256 FROM e_inactive_fragments f JOIN e_inactive_imports i ON i.id=f.import_id WHERE i.identity_key=? AND f.ordinal=? ORDER BY f.offset_bytes")
        .bind(key).bind(ordinal).fetch_all(pool).await?;
    let mut bytes = Vec::with_capacity(header.bytes as usize);
    for row in rows {
        let data: Vec<u8> = row.get("data");
        if row.get::<i64, _>("offset_bytes") != bytes.len() as i64
            || data.len() > 4093
            || data.len() > header.bytes as usize - bytes.len()
            || hash(&data) != row.get::<Vec<u8>, _>("sha256")
        {
            return Err(invalid("integrity_failed"));
        }
        bytes.extend_from_slice(&data);
    }
    if bytes.len() != header.bytes as usize || hex(&hash(&bytes)) != header.sha256 {
        return Err(invalid("integrity_failed"));
    }
    Ok(bytes)
}
/// The source conversation's title. Normalization retains `conversations.title`
/// (family 0, tag 1) as original text whose origin is its metadata record.
async fn source_title(pool: &SqlitePool, key: &str) -> DbResult<Option<String>> {
    use crate::db::inactive_storage::RecordHeader;
    let header = |raw: &str| -> DbResult<RecordHeader> {
        let header: RecordHeader =
            serde_json::from_str(raw).map_err(|_| invalid("integrity_failed"))?;
        if header.bytes > 65_536 {
            return Err(invalid("resource_limit"));
        }
        Ok(header)
    };
    let metadata=sqlx::query("SELECT r.ordinal,r.header_json FROM e_inactive_records r JOIN e_inactive_imports i ON i.id=r.import_id WHERE i.identity_key=? AND i.phase=2 AND r.complete=1 AND json_extract(r.header_json,'$.entry.purpose')='portable_metadata' ORDER BY r.ordinal")
        .bind(key).fetch_all(pool).await?;
    for row in metadata {
        let ordinal: i64 = row.get("ordinal");
        let described = header(row.get("header_json"))?;
        let value: serde_json::Value =
            serde_json::from_slice(&record_bytes(pool, key, ordinal, &described).await?)
                .map_err(|_| invalid("integrity_failed"))?;
        if value["source"]["family"] != 0 || value["source"]["tag"] != 1 {
            continue;
        }
        if value["classification"] != "retained_original" {
            return Ok(None);
        }
        let text=sqlx::query("SELECT r.ordinal,r.header_json FROM e_inactive_records r JOIN e_inactive_imports i ON i.id=r.import_id WHERE i.identity_key=? AND i.phase=2 AND r.complete=1 AND json_extract(r.header_json,'$.entry.purpose')='original_text' AND json_extract(r.header_json,'$.origin')=?")
            .bind(key).bind(ordinal).fetch_optional(pool).await?;
        let Some(text) = text else {
            return Ok(None);
        };
        let retained = header(text.get("header_json"))?;
        let bytes = record_bytes(pool, key, text.get("ordinal"), &retained).await?;
        let title = String::from_utf8(bytes).map_err(|_| invalid("integrity_failed"))?;
        return Ok((!title.trim().is_empty()).then_some(title));
    }
    Ok(None)
}
