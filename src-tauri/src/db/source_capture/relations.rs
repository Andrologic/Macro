use super::{owner::*, seal::verifying, types::*, *};
use crate::db::inactive_budget;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashSet;
impl SourceCapture {
    pub(super) async fn build_relations(&self, revision: i64, rows: i64) -> Result<()> {
        for row in 0..rows {
            let scope = self.scope(true).await?;
            let mut lease = self.lease(&scope.generation.ready.pool).await?;
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
            let j = self.load(&mut tx, &scope).await?;
            verifying(&j, revision)?;
            self.validate_live(&mut tx, &j).await?;
            let now = self.time(&j)?;
            let header=sqlx::query("SELECT family,source_rowid FROM e_source_fields WHERE capture_id=? AND row_ordinal=? AND field_tag=0").bind(j.id).bind(row).fetch_one(&mut *tx).await.map_err(error)?;
            let family: i64 = header.try_get("family").map_err(error)?;
            let source: i64 = header.try_get("source_rowid").map_err(error)?;
            let mut relations = Vec::with_capacity(13);
            let required = |kind: i64, to: Option<i64>| -> Result<StoredRelation> {
                Ok(StoredRelation {
                    from: row,
                    kind,
                    position: 0,
                    to: Some(to.ok_or("required_relation_missing")?),
                    status: 0,
                })
            };
            match family {
                0=>{},
                1=>{
                    relations.push(required(0,target(&mut tx,j.id,0,"SELECT rowid FROM conversations WHERE id=(SELECT conversation_id FROM messages WHERE rowid=?)",source).await?)?);
                    let abnormal:i64=sqlx::query_scalar("SELECT role NOT IN ('user','assistant') FROM messages WHERE rowid=?").bind(source).fetch_one(&mut *tx).await.map_err(error)?;
                    if abnormal!=0{relations.push(StoredRelation{from:row,kind:11,position:0,to:None,status:2});}
                },
                2=>relations.push(required(1,target(&mut tx,j.id,1,"SELECT m.rowid FROM app_settings p JOIN messages m ON p.key=('chat:assistant-visible-provenance:v1:'||m.id) COLLATE BINARY WHERE p.rowid=? AND m.role='assistant'",source).await?)?),
                3|7=>{
                    let table=if family==3{"conversation_management"}else{"conversation_toolbox_state"};
                    relations.push(required(if family==3{2}else{3},target(&mut tx,j.id,0,&format!("SELECT c.rowid FROM {table} t JOIN conversations c ON c.id=t.conversation_id WHERE t.rowid=?"),source).await?)?);
                },
                4=>relations.push(required(4,target(&mut tx,j.id,1,"SELECT m.rowid FROM conversation_response_versions v JOIN messages m ON m.id=v.message_id AND m.conversation_id=v.conversation_id AND m.role='assistant' WHERE v.rowid=? AND v.revision>0 AND v.read_revision>=0",source).await?)?),
                5=>relations.push(required(5,target(&mut tx,j.id,1,"SELECT m.rowid FROM conversation_compactions c JOIN messages m ON m.id=c.up_to_message_id AND m.conversation_id=c.conversation_id WHERE c.rowid=?",source).await?)?),
                6=>{
                    let to=target(&mut tx,j.id,1,"SELECT m.rowid FROM conversation_citations c JOIN messages m ON m.id=c.message_id AND m.conversation_id=c.conversation_id WHERE c.rowid=?",source).await?;
                    relations.push(StoredRelation{from:row,kind:6,position:0,to,status:if to.is_some(){0}else{1}});
                    let mirror:i64=sqlx::query_scalar("SELECT source='pilot_attachment' FROM conversation_citations WHERE rowid=?").bind(source).fetch_one(&mut *tx).await.map_err(error)?;
                    if mirror!=0{
                        let to=target(&mut tx,j.id,8,"SELECT a.rowid FROM conversation_citations c JOIN pilot_message_attachments a ON a.id=c.id AND a.message_id=c.message_id AND a.mime_type NOT LIKE 'image/%' WHERE c.rowid=? AND c.type='file' AND c.scope='context' AND c.path=('attachment://'||a.id) AND c.content IS NOT NULL",source).await?;
                        relations.push(required(7,to)?);
                    }
                },
                8=>{
                    relations.push(required(8,target(&mut tx,j.id,1,"SELECT m.rowid FROM pilot_message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.rowid=?",source).await?)?);
                    let metadata=sqlx::query("SELECT CASE WHEN typeof(sha256)='text' AND length(CAST(sha256 AS BLOB))=64 THEN sha256 END AS sha,CASE WHEN typeof(total_bytes)='integer' AND total_bytes>=0 THEN total_bytes END AS bytes,mime_type LIKE 'image/%' AS image FROM pilot_message_attachments WHERE rowid=?").bind(source).fetch_one(&mut *tx).await.map_err(error)?;
                    let (length,digest)=field_hash(&mut tx,j.id,row,6).await?;
                    let expected=metadata.try_get::<Option<String>,_>("sha").map_err(error)?.ok_or("integrity_failed")?;
                    if metadata.try_get::<Option<i64>,_>("bytes").map_err(error)?!=Some(length) || hex(&digest)!=expected{return Err("integrity_failed".into());}
                    if metadata.try_get::<i64,_>("image").map_err(error)?==0{
                        let to=target(&mut tx,j.id,6,"SELECT c.rowid FROM pilot_message_attachments a JOIN conversation_citations c ON c.id=a.id AND c.message_id=a.message_id AND c.source='pilot_attachment' AND c.type='file' AND c.scope='context' AND c.path=('attachment://'||a.id) AND c.content IS NOT NULL WHERE a.rowid=?",source).await?.ok_or("required_relation_missing")?;
                        let (mirror_length,mirror)=field_hash(&mut tx,j.id,to,8).await?;
                        if length!=mirror_length || digest!=mirror{return Err("integrity_failed".into());}
                        relations.push(required(9,Some(to))?);
                    }
                },
                9=>{
                    relations.push(required(10,target(&mut tx,j.id,1,"SELECT m.rowid FROM pilot_file_sends s JOIN messages m ON m.id=s.message_id AND m.turn_id=s.turn_id AND m.role='user' WHERE s.rowid=?",source).await?)?);
                    let assistant=target(&mut tx,j.id,1,"SELECT m.rowid FROM pilot_file_sends s JOIN messages u ON u.id=s.message_id JOIN messages m ON m.id=s.assistant_message_id AND m.conversation_id=u.conversation_id AND m.role='assistant' WHERE s.rowid=?",source).await?;
                    relations.push(StoredRelation{from:row,kind:12,position:0,to:assistant,status:if assistant.is_some(){0}else{1}});
                    let raw=small_field(&mut tx,j.id,row,4,8192).await?;
                    let ids:Vec<String>=serde_json::from_slice(&raw).map_err(|_|"send_order_invalid")?;
                    if ids.len()>10 || ids.iter().any(|id|id.is_empty() || id.len()>256 || id.chars().any(char::is_control)) || ids.iter().collect::<HashSet<_>>().len()!=ids.len(){return Err("send_order_invalid".into());}
                    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM pilot_message_attachments a JOIN pilot_file_sends s ON s.message_id=a.message_id WHERE s.rowid=?").bind(source).fetch_one(&mut *tx).await.map_err(error)?;
                    if count!=ids.len() as i64{return Err("required_relation_missing".into());}
                    for (position,id) in ids.iter().enumerate(){
                        let native:Option<i64>=sqlx::query_scalar("SELECT a.rowid FROM pilot_message_attachments a JOIN pilot_file_sends s ON a.message_id=s.message_id WHERE s.rowid=? AND a.id=?").bind(source).bind(id).fetch_optional(&mut *tx).await.map_err(error)?;
                        let to=if let Some(native)=native{captured_row(&mut tx,j.id,8,native).await?}else{None};
                        let mut relation=required(13,to)?;relation.position=position as i64;relations.push(relation);
                    }
                },
                _=>return Err("integrity_failed".into()),
            }
            for r in relations {
                let old=sqlx::query("SELECT to_row,status FROM e_source_relations WHERE capture_id=? AND from_row=? AND kind=? AND position=?").bind(j.id).bind(r.from).bind(r.kind).bind(r.position).fetch_optional(&mut *tx).await.map_err(error)?;
                if let Some(old) = old {
                    if old.try_get::<Option<i64>, _>("to_row").map_err(error)? != r.to
                        || old.try_get::<i64, _>("status").map_err(error)? != r.status
                    {
                        return Err("capture_conflict".into());
                    }
                } else {
                    inactive_budget::admit_e(
                        &mut tx,
                        RELATION,
                        j.binding.budget,
                        j.binding.max_receipts,
                    )
                    .await?;
                    sqlx::query("INSERT INTO e_source_relations VALUES(?,?,?,?,?,?)")
                        .bind(j.id)
                        .bind(r.from)
                        .bind(r.kind)
                        .bind(r.position)
                        .bind(r.to)
                        .bind(r.status)
                        .execute(&mut *tx)
                        .await
                        .map_err(error)?;
                    sqlx::query("UPDATE e_source_captures SET charge_bytes=charge_bytes+?,progressed_at=?,last_clock=? WHERE id=?").bind(RELATION).bind(now).bind(now).bind(j.id).execute(&mut *tx).await.map_err(error)?;
                }
            }
            tx.commit().await.map_err(error)?;
            lease.committed = true;
        }
        Ok(())
    }
}
async fn target(
    db: &mut SqliteConnection,
    capture: i64,
    family: i64,
    query: &str,
    row: i64,
) -> Result<Option<i64>> {
    // Query text is chosen only from the closed cases above.
    let native: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(row)
        .fetch_optional(&mut *db)
        .await
        .map_err(error)?;
    if let Some(native) = native {
        captured_row(db, capture, family, native).await
    } else {
        Ok(None)
    }
}
async fn captured_row(
    db: &mut SqliteConnection,
    capture: i64,
    family: i64,
    row: i64,
) -> Result<Option<i64>> {
    sqlx::query_scalar("SELECT row_ordinal FROM e_source_fields WHERE capture_id=? AND family=? AND source_rowid=? AND field_tag=0").bind(capture).bind(family).bind(row).fetch_optional(db).await.map_err(error)
}
async fn field_hash(
    db: &mut SqliteConnection,
    capture: i64,
    row: i64,
    tag: i64,
) -> Result<(i64, Vec<u8>)> {
    let r=sqlx::query("SELECT total_bytes,CASE WHEN length(sha256)=32 THEN sha256 END AS hash FROM e_source_fields WHERE capture_id=? AND row_ordinal=? AND field_tag=?").bind(capture).bind(row).bind(tag).fetch_one(db).await.map_err(error)?;
    Ok((
        r.try_get("total_bytes").map_err(error)?,
        r.try_get::<Option<Vec<u8>>, _>("hash")
            .map_err(error)?
            .ok_or("integrity_failed")?,
    ))
}
async fn small_field(
    db: &mut SqliteConnection,
    capture: i64,
    row: i64,
    tag: i64,
    cap: i64,
) -> Result<Vec<u8>> {
    let r=sqlx::query("SELECT ordinal,total_bytes FROM e_source_fields WHERE capture_id=? AND row_ordinal=? AND field_tag=?").bind(capture).bind(row).bind(tag).fetch_one(&mut *db).await.map_err(error)?;
    let bytes: i64 = r.try_get("total_bytes").map_err(error)?;
    if bytes < 0 || bytes > cap {
        return Err("resource_limit".into());
    }
    let ordinal: i64 = r.try_get("ordinal").map_err(error)?;
    let fragments=sqlx::query("SELECT CASE WHEN length(data)<=4093 THEN data END AS data,offset_bytes,CASE WHEN length(sha256)=32 THEN sha256 END AS hash FROM e_source_fragments WHERE capture_id=? AND field_ordinal=? ORDER BY offset_bytes LIMIT 4").bind(capture).bind(ordinal).fetch_all(db).await.map_err(error)?;
    let mut out = Vec::with_capacity(bytes as usize);
    for r in fragments {
        let data = r
            .try_get::<Option<Vec<u8>>, _>("data")
            .map_err(error)?
            .ok_or("integrity_failed")?;
        let hash = r
            .try_get::<Option<Vec<u8>>, _>("hash")
            .map_err(error)?
            .ok_or("integrity_failed")?;
        if r.try_get::<i64, _>("offset_bytes").map_err(error)? != out.len() as i64
            || out.len() + data.len() > bytes as usize
            || Sha256::digest(&data).as_slice() != hash
        {
            return Err("integrity_failed".into());
        }
        out.extend_from_slice(&data);
    }
    if out.len() != bytes as usize {
        return Err("integrity_failed".into());
    }
    Ok(out)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
