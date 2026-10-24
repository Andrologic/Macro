//! Paged projection resources bound to the same immutable archive as E records.
use super::{reader::Archive, reader_types::*, *};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::Row;

pub(super) fn decimal(value: &str) -> DbResult<i64> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| invalid("invalid_cursor"))?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(invalid("invalid_cursor"));
    }
    Ok(parsed)
}
pub(super) fn hex(value: &[u8]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}
pub(super) fn validate(selector: &ArchiveSelector) -> DbResult<()> {
    match selector {
        ArchiveSelector::Records { ordinal, uuid: id } => {
            if ordinal.is_some() && id.is_some() {
                return Err(invalid("invalid_cursor"));
            }
            if let Some(v) = ordinal {
                decimal(v)?;
            }
            if let Some(v) = id {
                uuid(v)?;
            }
        }
        ArchiveSelector::Resources { message_id } | ArchiveSelector::Body { message_id } => {
            uuid(message_id)?
        }
        ArchiveSelector::Citation { citation_id, field } => {
            uuid(citation_id)?;
            if !matches!(field.as_str(), "source" | "title" | "snippet" | "content") {
                return Err(invalid("invalid_cursor"));
            }
        }
        ArchiveSelector::Asset { asset_id } => uuid(asset_id)?,
    }
    Ok(())
}

#[derive(Clone)]
pub(super) struct Field {
    pub(super) descriptor: ArchiveResource,
    pub(super) ordinal: i64,
    pub(super) kind: &'static str,
    pub(super) field: String,
    pub(super) bytes: i64,
    pub(super) digest: Vec<u8>,
    pub(super) record: bool,
}
fn field(row: sqlx::sqlite::SqliteRow, kind: &'static str) -> DbResult<Field> {
    let bytes: i64 = row.get("bytes");
    let digest: Vec<u8> = row.get("sha256");
    if bytes < 0 || digest.len() != 32 {
        return Err(invalid("integrity_failed"));
    }
    let ordinal: i64 = row.get("ordinal");
    let name: String = row.get("field");
    Ok(Field {
        descriptor: ArchiveResource {
            uuid: row.get("id"),
            kind: kind.into(),
            field: name.clone(),
            ordinal: ordinal.to_string(),
            message_id: Some(row.get("message_id")),
            position: row.get::<i64, _>("position").to_string(),
            mime_type: row.get("mime_type"),
            bytes: bytes.to_string(),
            sha256: hex(&digest),
        },
        ordinal,
        kind,
        field: name,
        bytes,
        digest,
        record: false,
    })
}
pub(super) async fn resolve_field(
    db: &mut SqliteConnection,
    archive: &Archive,
    selector: &ArchiveSelector,
) -> DbResult<Field> {
    if let ArchiveSelector::Records { ordinal, uuid: id } = selector {
        use crate::db::inactive_storage::{self, Mime, RecordKind};
        let ordinal = if let Some(ordinal) = ordinal {
            decimal(ordinal)?
        } else if let Some(id) = id {
            sqlx::query_scalar(
                "SELECT ordinal FROM e_inactive_mapping WHERE import_id=? AND target_uuid=?",
            )
            .bind(archive.import)
            .bind(id)
            .fetch_optional(&mut *db)
            .await?
            .ok_or_else(|| invalid("archive_record_not_found"))?
        } else {
            return Err(invalid("archive_resource_required"));
        };
        let row=sqlx::query("SELECT r.kind,r.from_record,r.to_record,r.position,r.relation,CASE WHEN length(CAST(r.header_json AS BLOB))<=4096 THEN r.header_json END AS header_json,r.complete,m.target_uuid FROM e_inactive_records r LEFT JOIN e_inactive_mapping m ON m.import_id=r.import_id AND m.ordinal=r.ordinal WHERE r.import_id=? AND r.ordinal=?").bind(archive.import).bind(ordinal).fetch_optional(&mut *db).await?.ok_or_else(||invalid("archive_record_not_found"))?;
        if row.get::<i64, _>("complete") != 1 {
            return Err(invalid("integrity_failed"));
        }
        let header: String = row
            .get::<Option<String>, _>("header_json")
            .ok_or_else(|| invalid("integrity_failed"))?;
        let header = inactive_storage::published_record(
            &archive.begin,
            header.as_bytes(),
            row.get("kind"),
            (
                row.get("from_record"),
                row.get("to_record"),
                row.get("position"),
                row.get("relation"),
            ),
        )
        .map_err(|_| invalid("integrity_failed"))?;
        let id: String = row
            .get::<Option<String>, _>("target_uuid")
            .ok_or_else(|| invalid("archive_resource_required"))?;
        uuid(&id)?;
        let mime = match &header.entry {
            RecordKind::Asset {
                mime: Mime::ImagePng,
            } => "image/png",
            RecordKind::Asset {
                mime: Mime::ImageJpeg,
            } => "image/jpeg",
            RecordKind::Asset {
                mime: Mime::ImageWebp,
            } => "image/webp",
            _ => "text/plain",
        };
        let digest = header
            .sha256
            .as_bytes()
            .chunks_exact(2)
            .map(|v| {
                u8::from_str_radix(std::str::from_utf8(v).unwrap_or(""), 16)
                    .map_err(|_| invalid("integrity_failed"))
            })
            .collect::<DbResult<Vec<_>>>()?;
        let bytes = i64::try_from(header.bytes).map_err(|_| invalid("integrity_failed"))?;
        let message = matches!(header.entry, RecordKind::Message { .. }).then_some(id.clone());
        return Ok(Field {
            descriptor: ArchiveResource {
                uuid: id,
                kind: "record".into(),
                field: "data".into(),
                ordinal: ordinal.to_string(),
                message_id: message,
                position: "0".into(),
                mime_type: Some(mime.into()),
                bytes: bytes.to_string(),
                sha256: header.sha256,
            },
            ordinal,
            kind: "record",
            field: "data".into(),
            bytes,
            digest,
            record: true,
        });
    }
    let (kind, id, name) = match selector {
        ArchiveSelector::Body { message_id } => ("message", message_id.as_str(), "content"),
        ArchiveSelector::Asset { asset_id } => ("asset", asset_id.as_str(), "data"),
        ArchiveSelector::Citation { citation_id, field } => {
            ("citation", citation_id.as_str(), field.as_str())
        }
        _ => return Err(invalid("archive_resource_required")),
    };
    let row=match kind {
        "message" => sqlx::query("SELECT m.id,m.id AS message_id,m.ordinal,0 AS position,NULL AS mime_type,f.field,f.bytes,f.sha256 FROM connect_projection_messages m JOIN connect_projection_fields f ON f.transfer_id=m.transfer_id AND f.ordinal=m.ordinal AND f.kind='message' WHERE m.transfer_id=? AND m.id=? AND f.field=?"),
        "asset" => sqlx::query("SELECT a.id,a.message_id,a.ordinal,a.position,a.mime_type,f.field,f.bytes,f.sha256 FROM connect_projection_assets a JOIN connect_projection_fields f ON f.transfer_id=a.transfer_id AND f.ordinal=a.ordinal AND f.kind='asset' WHERE a.transfer_id=? AND a.id=? AND f.field=?"),
        _ => sqlx::query("SELECT c.id,c.message_id,c.ordinal,c.ordinal AS position,NULL AS mime_type,f.field,f.bytes,f.sha256 FROM connect_projection_citations c JOIN connect_projection_fields f ON f.transfer_id=c.transfer_id AND f.ordinal=c.ordinal AND f.kind='citation' WHERE c.transfer_id=? AND c.id=? AND f.field=?"),
    }.bind(&archive.transfer).bind(id).bind(name).fetch_optional(db).await?.ok_or_else(||invalid("archive_resource_not_found"))?;
    field(row, kind)
}

#[derive(Clone, Default)]
pub(super) struct ResourceCursor {
    pub(super) position: i64,
    pub(super) id: String,
    pub(super) field: String,
    pub(super) kind: String,
}
pub(super) async fn resources(
    db: &mut SqliteConnection,
    archive: &Archive,
    message: &str,
    after: Option<&ResourceCursor>,
    limit: usize,
) -> DbResult<(Vec<ArchiveItem>, Option<ResourceCursor>)> {
    let valid: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM connect_projection_messages WHERE transfer_id=? AND id=?)",
    )
    .bind(&archive.transfer)
    .bind(message)
    .fetch_one(&mut *db)
    .await?;
    if valid != 1 {
        return Err(invalid("archive_resource_not_found"));
    }
    let default = ResourceCursor {
        position: -1,
        ..Default::default()
    };
    let after = after.unwrap_or(&default);
    let mut fields = Vec::with_capacity(limit + 1);
    for (kind, table, position, mime) in [
        (
            "asset",
            "connect_projection_assets",
            "position",
            "mime_type",
        ),
        (
            "citation",
            "connect_projection_citations",
            "ordinal",
            "NULL",
        ),
    ] {
        if kind < after.kind.as_str() {
            continue;
        }
        let same = kind == after.kind;
        let pos = if same { after.position } else { -1 };
        let id = if same { after.id.as_str() } else { "" };
        let name = if same { after.field.as_str() } else { "" };
        let remaining = limit + 1 - fields.len();
        // Each lane first bounds indexed objects. At most one current object
        // has already consumed fields, hence remaining+1 objects suffice for
        // a real lookahead. LEFT JOIN makes missing fields an integrity error.
        let query=format!("WITH objects AS (SELECT id,message_id,ordinal,{position} AS position,{mime} AS mime_type,transfer_id FROM {table} WHERE transfer_id=? AND message_id=? AND ({position},id)>=(?,?) ORDER BY {position},id LIMIT ?) SELECT o.id,o.message_id,o.ordinal,o.position,o.mime_type,f.field,f.bytes,f.sha256 FROM objects o LEFT JOIN connect_projection_fields f ON f.transfer_id=o.transfer_id AND f.ordinal=o.ordinal AND f.kind=? WHERE f.field IS NULL OR (o.position,o.id,f.field)>(?,?,?) ORDER BY o.position,o.id,f.field LIMIT ?");
        let rows = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(&archive.transfer)
            .bind(message)
            .bind(pos)
            .bind(id)
            .bind((remaining + 1) as i64)
            .bind(kind)
            .bind(pos)
            .bind(id)
            .bind(name)
            .bind(remaining as i64)
            .fetch_all(&mut *db)
            .await?;
        for row in rows {
            if row.get::<Option<String>, _>("field").is_none() {
                return Err(invalid("integrity_failed"));
            }
            fields.push(field(row, kind)?);
        }
        if fields.len() > limit {
            break;
        }
    }
    let more = fields.len() > limit;
    let mut items = Vec::with_capacity(limit);
    let mut next = None;
    for f in fields.into_iter().take(limit) {
        next = Some(ResourceCursor {
            kind: f.kind.into(),
            position: decimal(&f.descriptor.position)?,
            id: f.descriptor.uuid.clone(),
            field: f.field.clone(),
        });
        items.push(ArchiveItem::Resource {
            resource: f.descriptor,
        });
    }
    Ok((items, if more { next } else { None }))
}

pub(super) async fn fragment(
    db: &mut SqliteConnection,
    archive: &Archive,
    field: &Field,
    offset: i64,
) -> DbResult<Vec<u8>> {
    let row=if field.record {
        sqlx::query("SELECT CASE WHEN typeof(data)='blob' AND length(data)<=4093 THEN data END AS data,sha256 FROM e_inactive_fragments WHERE import_id=? AND ordinal=? AND offset_bytes=?").bind(archive.import).bind(field.ordinal).bind(offset).fetch_optional(db).await?
    } else {
        sqlx::query("SELECT CASE WHEN typeof(data)='blob' AND length(data) BETWEEN 1 AND 4093 THEN data END AS data,sha256 FROM connect_projection_fragments WHERE transfer_id=? AND kind=? AND ordinal=? AND field=? AND offset_bytes=?")
            .bind(&archive.transfer).bind(field.kind).bind(field.ordinal).bind(&field.field).bind(offset).fetch_optional(db).await?
    }.ok_or_else(||invalid("integrity_failed"))?;
    let data: Vec<u8> = row
        .get::<Option<Vec<u8>>, _>("data")
        .ok_or_else(|| invalid("integrity_failed"))?;
    if hash(&data) != row.get::<Vec<u8>, _>("sha256")
        || add(offset, data.len() as i64)? > field.bytes
        || (data.is_empty() && field.bytes != 0)
    {
        return Err(invalid("integrity_failed"));
    }
    Ok(data)
}
pub(super) async fn fragments(
    db: &mut SqliteConnection,
    archive: &Archive,
    field: &Field,
    offset: i64,
    limit: usize,
) -> DbResult<(Vec<ArchiveItem>, Option<i64>)> {
    if offset < 0 || offset > field.bytes || (offset > 0 && offset == field.bytes) {
        return Err(invalid("invalid_cursor"));
    }
    if field.bytes == 0 {
        if field.digest != hash(&[]) {
            return Err(invalid("integrity_failed"));
        }
        return Ok((
            vec![ArchiveItem::Fragment {
                resource: field.descriptor.clone(),
                offset: "0".into(),
                data_base64: String::new(),
                sha256: hex(&field.digest),
            }],
            None,
        ));
    }
    let mut offset = offset;
    let mut items = Vec::with_capacity(limit);
    while offset < field.bytes && items.len() < limit {
        let data = fragment(db, archive, field, offset).await?;
        let digest = hash(&data);
        let next = add(offset, data.len() as i64)?;
        items.push(ArchiveItem::Fragment {
            resource: field.descriptor.clone(),
            offset: offset.to_string(),
            data_base64: STANDARD.encode(data),
            sha256: hex(&digest),
        });
        offset = next;
    }
    Ok((items, (offset < field.bytes).then_some(offset)))
}
