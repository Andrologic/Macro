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
        Header::Message { role, created_at, display_date } => {
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
                    || display.original_date.as_ref().is_some_and(|date| date.len() > CONTROL)
                {
                    return Err(invalid("connect_projection_invalid_date"));
                }
                grow(&mut tx, &input.transfer_id, 512).await?;
                sqlx::query("INSERT INTO connect_projection_display VALUES(?,?,?,?)")
                    .bind(&input.transfer_id).bind(input.ordinal)
                    .bind(&display.original_date).bind(display.inherited_from)
                    .execute(&mut *tx).await?;
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
                cursor, row.get::<Option<String>, _>("original_date"), row.get::<Option<i64>, _>("inherited_from"),
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

#[cfg(test)]
#[path = "publication_tests.rs"]
pub(in crate::db::connect_transfer) mod tests;
