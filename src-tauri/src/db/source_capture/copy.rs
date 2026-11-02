use super::{allowlist::FAMILIES, owner::*, types::*, *};
use crate::db::inactive_budget;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};

impl SourceCapture {
    pub async fn copy_next(&self, raw: &[u8]) -> Result<Copied> {
        self.present()?;
        let input: Copy = parse(raw)?;
        if input.cursor.field < 0 || input.cursor.offset < 0 || input.expected_revision < 0 {
            return Err("invalid_cursor".into());
        }
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        let replay=sqlx::query("SELECT ack_next_field,ack_next_offset,ack_total_bytes,ack_revision FROM e_source_fragments WHERE capture_id=? AND field_ordinal=? AND offset_bytes=?").bind(j.id).bind(input.cursor.field).bind(input.cursor.offset).fetch_optional(&mut *tx).await.map_err(error)?;
        if let Some(r) = replay {
            let revision: i64 = r.try_get("ack_revision").map_err(error)?;
            if input.expected_revision != revision - 1 {
                return Err("cursor_conflict".into());
            }
            let ack = Ack {
                next: Cursor {
                    field: r.try_get("ack_next_field").map_err(error)?,
                    offset: r.try_get("ack_next_offset").map_err(error)?,
                },
                total_bytes: r.try_get("ack_total_bytes").map_err(error)?,
                revision,
            };
            let receipt = j.receipt(&scope.authority.capture_id);
            tx.commit().await.map_err(error)?;
            lease.committed = true;
            return Ok(Copied {
                receipt,
                ack: Some(ack),
            });
        }
        if j.phase != 0 {
            return Err("capture_not_receiving".into());
        }
        if input.cursor != j.receipt(&scope.authority.capture_id).cursor
            || (input.expected_revision != j.revision
                && !(j.family == 10 && input.expected_revision == j.revision - 1))
        {
            return Err("cursor_conflict".into());
        }
        self.validate_live(&mut tx, &j).await?;
        let now = self.time(&j)?;
        let mut family = j.family as usize;
        let mut rowid = j.rowid;
        if j.field == 0 && j.offset == 0 {
            loop {
                if family == FAMILIES.len() {
                    if j.family != 10 {
                        sqlx::query("UPDATE e_source_captures SET family=10,cursor_rowid=NULL,revision=revision+1,progressed_at=?,last_clock=? WHERE id=?").bind(now).bind(now).bind(j.id).execute(&mut *tx).await.map_err(error)?;
                    }
                    let result = self
                        .load(&mut tx, &scope)
                        .await?
                        .receipt(&scope.authority.capture_id);
                    tx.commit().await.map_err(error)?;
                    lease.committed = true;
                    return Ok(Copied {
                        receipt: result,
                        ack: None,
                    });
                }
                if let Some(next) = FAMILIES[family]
                    .next(&mut tx, &j.binding.conversation, rowid)
                    .await?
                {
                    rowid = Some(next);
                    break;
                }
                family += 1;
                rowid = None;
            }
        }
        let f = *FAMILIES.get(family).ok_or("invalid_cursor")?;
        let row = rowid.ok_or("invalid_cursor")?;
        let tag = j.field as usize;
        let (kind, scalar) = f.scalar(&mut tx, row, tag).await?;
        let total = match kind {
            0 => 0,
            1 => 8,
            2 | 3 => {
                blob::access(
                    &mut tx,
                    f,
                    row,
                    tag,
                    None,
                    None,
                    #[cfg(test)]
                    &self.reads,
                )
                .await?
                .0
            }
            _ => return Err("source_type_invalid".into()),
        };
        let existing=sqlx::query("SELECT ordinal,total_bytes,sql_type,CASE WHEN length(utf8_tail)<=3 THEN utf8_tail END AS tail FROM e_source_fields WHERE capture_id=? AND family=? AND source_rowid=? AND field_tag=?").bind(j.id).bind(family as i64).bind(row).bind(tag as i64).fetch_optional(&mut *tx).await.map_err(error)?;
        let (ordinal, old_tail, new_field) = if let Some(r) = existing {
            if r.try_get::<i64, _>("total_bytes").map_err(error)? != total
                || r.try_get::<i64, _>("sql_type").map_err(error)? != kind
            {
                return Err("stale_revision".into());
            }
            (
                r.try_get("ordinal").map_err(error)?,
                r.try_get::<Option<Vec<u8>>, _>("tail")
                    .map_err(error)?
                    .ok_or("database_unavailable")?,
                false,
            )
        } else {
            (j.fields, Vec::new(), true)
        };
        if ordinal != input.cursor.field || j.offset > total {
            return Err("cursor_conflict".into());
        }
        let size = (total - j.offset).min(BLOCK as i64);
        // The transaction owns the writer slot while checking this reservation.
        // Up to three bytes reserve the future UTF-8 tail; only its actual
        // retained length is charged at commit.
        let reserve = add(
            if new_field { FIELD } else { 0 },
            add(FRAGMENT, add(size, 3 - old_tail.len() as i64)?)?,
        )?;
        inactive_budget::admit_e(&mut tx, reserve, j.binding.budget, j.binding.max_receipts)
            .await?;
        let (again_kind, again_scalar) = f.scalar(&mut tx, row, tag).await?;
        if (again_kind, again_scalar) != (kind, scalar) {
            return Err("stale_revision".into());
        }
        let data = match kind {
            0 => Vec::new(),
            1 => scalar.ok_or("source_type_invalid")?.to_le_bytes().to_vec(),
            _ => {
                blob::access(
                    &mut tx,
                    f,
                    row,
                    tag,
                    Some(j.offset),
                    Some(total),
                    #[cfg(test)]
                    &self.reads,
                )
                .await?
                .1
            }
        };
        let end = add(j.offset, data.len() as i64)?;
        let complete = end == total;
        let tail = if kind == 2 {
            utf8(&old_tail, &data, complete)?
        } else {
            Vec::new()
        };
        let extra = reserve - 3 + tail.len() as i64;
        if new_field {
            sqlx::query("INSERT INTO e_source_fields(capture_id,ordinal,row_ordinal,family,source_rowid,field_tag,sql_type,total_bytes,received_bytes,complete,utf8_tail) VALUES(?,?,?,?,?,?,?,?,0,0,X'')").bind(j.id).bind(ordinal).bind(j.rows).bind(family as i64).bind(row).bind(tag as i64).bind(kind).bind(total).execute(&mut *tx).await.map_err(error)?;
        }
        let next_field = if complete { ordinal + 1 } else { ordinal };
        let next_offset = if complete { 0 } else { end };
        let revision = add(j.revision, 1)?;
        let bytes = add(j.bytes, data.len() as i64)?;
        let digest = Sha256::digest(&data);
        sqlx::query("INSERT INTO e_source_fragments VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(j.id)
            .bind(ordinal)
            .bind(j.offset)
            .bind(&data)
            .bind(digest.as_slice())
            .bind(next_field)
            .bind(next_offset)
            .bind(bytes)
            .bind(revision)
            .execute(&mut *tx)
            .await
            .map_err(error)?;
        sqlx::query("UPDATE e_source_fields SET received_bytes=?,complete=?,utf8_tail=? WHERE capture_id=? AND ordinal=?").bind(end).bind(complete).bind(&tail).bind(j.id).bind(ordinal).execute(&mut *tx).await.map_err(error)?;
        let row_complete = complete && tag + 1 == f.columns.len();
        let rows = j.rows + i64::from(row_complete);
        sqlx::query("UPDATE e_source_captures SET family=?,cursor_rowid=?,cursor_field=?,cursor_offset=?,row_ordinal=?,rows_count=?,fields_count=fields_count+?,bytes_received=?,revision=?,charge_bytes=charge_bytes+?,progressed_at=?,last_clock=? WHERE id=?").bind(family as i64).bind(row).bind(if row_complete{0}else if complete{tag as i64+1}else{tag as i64}).bind(next_offset).bind(rows).bind(rows).bind(i64::from(new_field)).bind(bytes).bind(revision).bind(extra).bind(now).bind(now).bind(j.id).execute(&mut *tx).await.map_err(error)?;
        let result = self
            .load(&mut tx, &scope)
            .await?
            .receipt(&scope.authority.capture_id);
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(Copied {
            receipt: result,
            ack: Some(Ack {
                next: Cursor {
                    field: next_field,
                    offset: next_offset,
                },
                total_bytes: bytes,
                revision,
            }),
        })
    }
}
fn utf8(tail: &[u8], data: &[u8], complete: bool) -> Result<Vec<u8>> {
    let mut joined = Vec::with_capacity(tail.len() + data.len());
    joined.extend_from_slice(tail);
    joined.extend_from_slice(data);
    match std::str::from_utf8(&joined) {
        Ok(_) => Ok(Vec::new()),
        Err(e) if e.error_len().is_none() && !complete && joined.len() - e.valid_up_to() <= 3 => {
            Ok(joined[e.valid_up_to()..].to_vec())
        }
        _ => Err("source_utf8_invalid".into()),
    }
}
