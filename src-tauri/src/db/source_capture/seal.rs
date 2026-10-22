use super::{owner::*, types::*, *};
use crate::db::inactive_budget;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};

impl SourceCapture {
    pub async fn seal_raw(&self) -> Result<RawNativeCapture> {
        let (revision, fields, rows, bytes, binding) = {
            let scope = self.scope(true).await?;
            let mut lease = self.lease(&scope.generation.ready.pool).await?;
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
            let j = self.load(&mut tx, &scope).await?;
            if j.phase == 2 {
                let result = RawNativeCapture {
                    receipt: j.receipt(&scope.authority.capture_id),
                    binding: j.binding,
                    manifest: j.manifest.ok_or("integrity_failed")?,
                    limits: LIMITS,
                };
                tx.commit().await.map_err(error)?;
                lease.committed = true;
                return Ok(result);
            }
            if j.phase > 1 || j.family != 10 || j.offset != 0 {
                return Err("capture_incomplete".into());
            }
            self.validate_live(&mut tx, &j).await?;
            self.time(&j)?;
            let revision = if j.phase == 0 {
                sqlx::query("UPDATE e_source_captures SET phase=1,revision=revision+1 WHERE id=?")
                    .bind(j.id)
                    .execute(&mut *tx)
                    .await
                    .map_err(error)?;
                add(j.revision, 1)?
            } else {
                j.revision
            };
            tx.commit().await.map_err(error)?;
            lease.committed = true;
            (revision, j.fields, j.rows, j.bytes, j.binding)
        };
        let mut manifest = Sha256::new();
        manifest.update(b"macro.raw.native.source.v1\0");
        frame(
            &mut manifest,
            &serde_json::to_vec(&binding).map_err(|_| "database_unavailable")?,
        );
        frame(&mut manifest, &serde_json::to_vec(LIMITS).unwrap());
        let mut expected_charge = add(JOURNAL, serde_json::to_vec(&binding).unwrap().len() as i64)?;
        let mut observed_bytes = 0;
        let mut observed_rows = 0;
        let mut previous: Option<(i64, i64, i64)> = None;
        for ordinal in 0..fields {
            let meta = self.field_meta(revision, ordinal).await?;
            if meta.0.row == observed_rows && meta.0.tag == 0 {
                if previous.is_some_and(|(_, family, tag)| {
                    tag as usize + 1 != allowlist::FAMILIES[family as usize].columns.len()
                }) {
                    return Err("integrity_failed".into());
                }
                observed_rows += 1;
            } else if previous != Some((meta.0.row, meta.0.family, meta.0.tag - 1)) {
                return Err("integrity_failed".into());
            }
            if meta.0.ordinal != ordinal || meta.0.row != observed_rows - 1 {
                return Err("integrity_failed".into());
            }
            previous = Some((meta.0.row, meta.0.family, meta.0.tag));
            let mut hash = Sha256::new();
            let mut offset = 0;
            let mut first = true;
            while first || offset < meta.0.bytes {
                first = false;
                let (next, count) = self
                    .hash_page(revision, ordinal, offset, meta.0.bytes, &mut hash)
                    .await?;
                let bytes = next - offset;
                observed_bytes = add(observed_bytes, bytes)?;
                expected_charge = add(
                    expected_charge,
                    add(count.checked_mul(FRAGMENT).ok_or("resource_limit")?, bytes)?,
                )?;
                offset = next;
            }
            let digest = hash.finalize().to_vec();
            self.store_field_hash(revision, ordinal, &digest).await?;
            for n in [
                ordinal,
                meta.0.row,
                meta.0.family,
                meta.0.tag,
                meta.0.sql_type,
                meta.0.bytes,
            ] {
                manifest.update(n.to_le_bytes());
            }
            manifest.update(&digest);
            expected_charge = add(expected_charge, FIELD)?;
        }
        if previous.is_some_and(|(_, family, tag)| {
            tag as usize + 1 != allowlist::FAMILIES[family as usize].columns.len()
        }) {
            return Err("integrity_failed".into());
        }
        if observed_bytes != bytes || observed_rows != rows {
            return Err("integrity_failed".into());
        }
        self.build_relations(revision, rows).await?;
        let mut cursor = None;
        loop {
            let (next, count) = self
                .verifying_relations(revision, cursor, &mut manifest)
                .await?;
            if count == 0 {
                break;
            }
            expected_charge = add(
                expected_charge,
                count.checked_mul(RELATION).ok_or("resource_limit")?,
            )?;
            cursor = next;
        }
        let manifest = manifest.finalize().to_vec();
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        verifying(&j, revision)?;
        self.validate_live(&mut tx, &j).await?;
        let now = self.time(&j)?;
        if j.fields != fields
            || j.rows != rows
            || j.bytes != bytes
            || j.charge != expected_charge
            || j.binding != binding
        {
            return Err("integrity_failed".into());
        }
        inactive_budget::admit_e(&mut tx, 32, j.binding.budget, j.binding.max_receipts).await?;
        sqlx::query("UPDATE e_source_captures SET phase=2,revision=revision+1,manifest_hash=?,charge_bytes=charge_bytes+32,progressed_at=?,last_clock=? WHERE id=?").bind(&manifest).bind(now).bind(now).bind(j.id).execute(&mut *tx).await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        let result = RawNativeCapture {
            receipt: j.receipt(&scope.authority.capture_id),
            binding: j.binding,
            manifest,
            limits: LIMITS,
        };
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(result)
    }
    async fn field_meta(&self, revision: i64, ordinal: i64) -> Result<(FieldInfo, i64)> {
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        verifying(&j, revision)?;
        self.validate_live(&mut tx, &j).await?;
        self.time(&j)?;
        let r=sqlx::query("SELECT ordinal,row_ordinal,family,field_tag,sql_type,total_bytes,source_rowid,complete,received_bytes,length(utf8_tail) AS tail FROM e_source_fields WHERE capture_id=? AND ordinal=?").bind(j.id).bind(ordinal).fetch_one(&mut *tx).await.map_err(error)?;
        let info = FieldInfo {
            ordinal: r.try_get("ordinal").map_err(error)?,
            row: r.try_get("row_ordinal").map_err(error)?,
            family: r.try_get("family").map_err(error)?,
            tag: r.try_get("field_tag").map_err(error)?,
            sql_type: r.try_get("sql_type").map_err(error)?,
            bytes: r.try_get("total_bytes").map_err(error)?,
            sha256: None,
        };
        if r.try_get::<i64, _>("complete").map_err(error)? != 1
            || r.try_get::<i64, _>("received_bytes").map_err(error)? != info.bytes
            || r.try_get::<i64, _>("tail").map_err(error)? != 0
            || info.family < 0
            || info.family > 9
            || info.tag < 0
            || info.tag as usize >= allowlist::FAMILIES[info.family as usize].columns.len()
        {
            return Err("integrity_failed".into());
        }
        let rowid = r.try_get("source_rowid").map_err(error)?;
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok((info, rowid))
    }
    // Only scalars leave this function. All page payloads are decoded,
    // verified and hashed before the Scope (including its permit) is dropped.
    async fn hash_page(
        &self,
        revision: i64,
        ordinal: i64,
        offset: i64,
        total: i64,
        hash: &mut Sha256,
    ) -> Result<(i64, i64)> {
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        verifying(&j, revision)?;
        self.validate_live(&mut tx, &j).await?;
        self.time(&j)?;
        let rows=sqlx::query("SELECT offset_bytes,CASE WHEN typeof(data)='blob' AND length(data)<=4093 THEN data END AS data,CASE WHEN length(sha256)=32 THEN sha256 END AS hash FROM e_source_fragments WHERE capture_id=? AND field_ordinal=? AND offset_bytes>=? ORDER BY offset_bytes LIMIT 32").bind(j.id).bind(ordinal).bind(offset).fetch_all(&mut *tx).await.map_err(error)?;
        if rows.is_empty() {
            return Err("integrity_failed".into());
        }
        let count = rows.len() as i64;
        let mut next = offset;
        for r in rows {
            let at: i64 = r.try_get("offset_bytes").map_err(error)?;
            let data = r
                .try_get::<Option<Vec<u8>>, _>("data")
                .map_err(error)?
                .ok_or("integrity_failed")?;
            let digest = r
                .try_get::<Option<Vec<u8>>, _>("hash")
                .map_err(error)?
                .ok_or("integrity_failed")?;
            if at != next
                || (data.is_empty() && total != 0)
                || Sha256::digest(&data).as_slice() != digest
            {
                return Err("integrity_failed".into());
            }
            next = add(next, data.len() as i64)?;
            if next > total {
                return Err("integrity_failed".into());
            }
            hash.update(&data);
        }
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok((next, count))
    }
    async fn store_field_hash(&self, revision: i64, ordinal: i64, digest: &[u8]) -> Result<()> {
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        verifying(&j, revision)?;
        self.validate_live(&mut tx, &j).await?;
        let now = self.time(&j)?;
        let old:Option<Vec<u8>>=sqlx::query_scalar("SELECT CASE WHEN length(sha256)=32 THEN sha256 END FROM e_source_fields WHERE capture_id=? AND ordinal=?").bind(j.id).bind(ordinal).fetch_one(&mut *tx).await.map_err(error)?;
        if let Some(old) = old {
            if old != digest {
                return Err("integrity_failed".into());
            }
        } else {
            sqlx::query("UPDATE e_source_fields SET sha256=? WHERE capture_id=? AND ordinal=?")
                .bind(digest)
                .bind(j.id)
                .bind(ordinal)
                .execute(&mut *tx)
                .await
                .map_err(error)?;
            sqlx::query("UPDATE e_source_captures SET progressed_at=?,last_clock=? WHERE id=?")
                .bind(now)
                .bind(now)
                .bind(j.id)
                .execute(&mut *tx)
                .await
                .map_err(error)?;
        }
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(())
    }
    async fn verifying_relations(
        &self,
        revision: i64,
        cursor: Option<(i64, i64, i64)>,
        manifest: &mut Sha256,
    ) -> Result<(Option<(i64, i64, i64)>, i64)> {
        let scope = self.scope(true).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        verifying(&j, revision)?;
        self.validate_live(&mut tx, &j).await?;
        self.time(&j)?;
        let (a, b, c) = cursor.unwrap_or((-1, -1, -1));
        let rows=sqlx::query("SELECT from_row,kind,position,to_row,status FROM e_source_relations WHERE capture_id=? AND (from_row,kind,position)>(?,?,?) ORDER BY from_row,kind,position LIMIT 32").bind(j.id).bind(a).bind(b).bind(c).fetch_all(&mut *tx).await.map_err(error)?;
        let count = rows.len() as i64;
        let mut next = None;
        for r in rows {
            let from: i64 = r.try_get("from_row").map_err(error)?;
            let kind: i64 = r.try_get("kind").map_err(error)?;
            let position: i64 = r.try_get("position").map_err(error)?;
            let to: Option<i64> = r.try_get("to_row").map_err(error)?;
            let status: i64 = r.try_get("status").map_err(error)?;
            for n in [from, kind, position, to.unwrap_or(-1), status] {
                manifest.update(n.to_le_bytes());
            }
            next = Some((from, kind, position));
        }
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok((next, count))
    }
}
pub(super) fn verifying(j: &Journal, revision: i64) -> Result<()> {
    if j.phase != 1 || j.revision != revision {
        Err("capture_conflict".into())
    } else {
        Ok(())
    }
}
fn frame(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value);
}
