use super::{owner::*, types::*, *};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};
impl SourceCapture {
    pub async fn readback(&self, after: Option<Cursor>, limit: usize) -> Result<Readback> {
        self.present()?;
        if limit == 0 || limit > 32 || after.as_ref().is_some_and(|c| c.field < 0 || c.offset < 0) {
            return Err("invalid_cursor".into());
        }
        let scope = self.scope(false).await?;
        if scope.authority.mode == Mode::Recovery {
            return Err("source_capture_disabled".into());
        }
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        if j.phase != 2 {
            return Err("capture_not_sealed".into());
        }
        let cursor = after.unwrap_or(Cursor {
            field: 0,
            offset: 0,
        });
        let rows=sqlx::query("SELECT f.ordinal,f.row_ordinal,f.family,f.field_tag,f.sql_type,f.total_bytes,CASE WHEN length(f.sha256)=32 THEN f.sha256 END AS field_hash,b.offset_bytes,CASE WHEN typeof(b.data)='blob' AND length(b.data)<=4093 THEN b.data END AS data,CASE WHEN length(b.sha256)=32 THEN b.sha256 END AS hash FROM e_source_fragments b JOIN e_source_fields f ON f.capture_id=b.capture_id AND f.ordinal=b.field_ordinal WHERE b.capture_id=? AND (b.field_ordinal>? OR (b.field_ordinal=? AND b.offset_bytes>=?)) ORDER BY b.field_ordinal,b.offset_bytes LIMIT ?").bind(j.id).bind(cursor.field).bind(cursor.field).bind(cursor.offset).bind(limit as i64).fetch_all(&mut *tx).await.map_err(error)?;
        let mut fragments = Vec::with_capacity(rows.len());
        let mut next = None;
        for r in rows {
            let data: Vec<u8> = r
                .try_get::<Option<Vec<u8>>, _>("data")
                .map_err(error)?
                .ok_or("integrity_failed")?;
            let hash: Vec<u8> = r
                .try_get::<Option<Vec<u8>>, _>("hash")
                .map_err(error)?
                .ok_or("integrity_failed")?;
            if Sha256::digest(&data).as_slice() != hash.as_slice() {
                return Err("integrity_failed".into());
            }
            let field = FieldInfo {
                ordinal: r.try_get("ordinal").map_err(error)?,
                row: r.try_get("row_ordinal").map_err(error)?,
                family: r.try_get("family").map_err(error)?,
                tag: r.try_get("field_tag").map_err(error)?,
                sql_type: r.try_get("sql_type").map_err(error)?,
                bytes: r.try_get("total_bytes").map_err(error)?,
                sha256: Some(
                    r.try_get::<Option<Vec<u8>>, _>("field_hash")
                        .map_err(error)?
                        .ok_or("integrity_failed")?,
                ),
            };
            let offset = r.try_get::<i64, _>("offset_bytes").map_err(error)?;
            let end = add(offset, data.len() as i64)?;
            next = Some(if end == field.bytes {
                Cursor {
                    field: field.ordinal + 1,
                    offset: 0,
                }
            } else {
                Cursor {
                    field: field.ordinal,
                    offset: end,
                }
            });
            fragments.push(Stored {
                field,
                offset,
                sha256: hash,
                data,
            });
        }
        if next.as_ref().is_some_and(|v| v.field >= j.fields) {
            next = None;
        }
        if fragments.is_empty() {
            next = None;
        }
        let result = Readback {
            receipt: j.receipt(&scope.authority.capture_id),
            binding: j.binding,
            manifest: j.manifest,
            fragments,
            next,
            limits: LIMITS,
        };
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(result)
    }
    pub async fn readback_relations(
        &self,
        after: Option<(i64, i64, i64)>,
        limit: usize,
    ) -> Result<Vec<StoredRelation>> {
        self.present()?;
        if limit == 0 || limit > 32 || after.is_some_and(|(a, b, c)| a < 0 || b < 0 || c < 0) {
            return Err("invalid_cursor".into());
        }
        let scope = self.scope(false).await?;
        if scope.authority.mode == Mode::Recovery {
            return Err("source_capture_disabled".into());
        }
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        if j.phase != 2 {
            return Err("capture_not_sealed".into());
        }
        let (from, kind, pos) = after.unwrap_or((-1, -1, -1));
        let rows=sqlx::query("SELECT from_row,kind,position,to_row,status FROM e_source_relations WHERE capture_id=? AND (from_row,kind,position)>(?,?,?) ORDER BY from_row,kind,position LIMIT ?").bind(j.id).bind(from).bind(kind).bind(pos).bind(limit as i64).fetch_all(&mut *tx).await.map_err(error)?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(StoredRelation {
                from: r.try_get("from_row").map_err(error)?,
                kind: r.try_get("kind").map_err(error)?,
                position: r.try_get("position").map_err(error)?,
                to: r.try_get("to_row").map_err(error)?,
                status: r.try_get("status").map_err(error)?,
            });
        }
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(out)
    }
}
