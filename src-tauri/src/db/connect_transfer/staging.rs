use super::*;
use sqlx::{Connection, Row};

#[derive(Serialize)]
pub(super) struct Session {
    pub transfer_id: String,
    pub transit_id: String,
    pub producer_generation: String,
    pub binding_digest: Vec<u8>,
    pub session_json: Vec<u8>,
    pub stream_bytes: i64,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Prefix {
    pub next_sequence: i64,
    pub next_offset: i64,
    pub eof: bool,
}
pub(super) struct Chunk<'a> {
    pub sequence: i64,
    pub offset: i64,
    pub sha256: &'a [u8],
    pub data: &'a [u8],
    pub eof: bool,
}
async fn current(
    db: &mut SqliteConnection,
    session: &Session,
    digest: &[u8],
    mutation: bool,
) -> DbResult<Prefix> {
    let row=sqlx::query("SELECT p.fingerprint,p.next_sequence,p.next_offset,p.eof,t.binding_digest,t.target_generation,t.restore_hold,t.phase FROM connect_raw_prefix p JOIN connect_transfers t ON t.transfer_id=p.transfer_id WHERE p.transfer_id=?")
        .bind(&session.transfer_id).fetch_optional(db).await?.ok_or_else(||invalid("connect_transfer_prefix_missing"))?;
    if row.get::<Vec<u8>, _>("fingerprint") != digest
        || row.get::<Vec<u8>, _>("binding_digest") != session.binding_digest
        || row.get::<String, _>("target_generation") != session.producer_generation
    {
        return Err(invalid("connect_transfer_session_conflict"));
    }
    if mutation
        && (row.get::<i64, _>("restore_hold") != 0
            || row.get::<String, _>("phase") == "reconciliation_required")
    {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    Ok(Prefix {
        next_sequence: row.get("next_sequence"),
        next_offset: row.get("next_offset"),
        eof: row.get::<i64, _>("eof") != 0,
    })
}
fn inspect(session: &Session) -> DbResult<(Vec<u8>, i64)> {
    uuid(&session.transfer_id)?;
    uuid(&session.transit_id)?;
    control(&session.session_json, 4096)?;
    if session.stream_bytes <= 0
        || session.binding_digest.len() != 32
        || session.producer_generation.is_empty()
        || session.producer_generation.len() > 128
    {
        return Err(invalid("connect_transfer_invalid_input"));
    }
    fingerprint(session)
}
pub(super) async fn open_prefix(pool: &SqlitePool, session: &Session) -> DbResult<Prefix> {
    let (digest, bytes) = inspect(session)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM connect_raw_prefix WHERE transfer_id=?")
            .bind(&session.transfer_id)
            .fetch_one(&mut *tx)
            .await?;
    if exists == 0 {
        let valid: i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_transfers WHERE transfer_id=? AND local_role='target' AND binding_digest=? AND target_generation=? AND restore_hold=0 AND phase='receiving')")
            .bind(&session.transfer_id).bind(&session.binding_digest).bind(&session.producer_generation).fetch_one(&mut *tx).await?;
        if valid != 1 {
            return Err(invalid("connect_transfer_recovery_hold"));
        }
        let extra = charge(bytes, 72, 256)?;
        admit_journal(&mut tx, extra).await?;
        sqlx::query("INSERT INTO connect_raw_prefix(transfer_id,transit_id,producer_generation,session_json,fingerprint,stream_bytes,next_sequence,next_offset,eof,charge_bytes) VALUES(?,?,?,?,?,?,0,0,0,?)")
            .bind(&session.transfer_id).bind(&session.transit_id).bind(&session.producer_generation).bind(&session.session_json).bind(&digest).bind(session.stream_bytes).bind(extra).execute(&mut *tx).await?;
    }
    let prefix = current(&mut tx, session, &digest, false).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(prefix)
}
/// Return a local durable prefix only after FULL-synchronous commit. This is not
/// an ACK DTO and never sends an ACK. All delivery authority remains upstream.
pub(super) async fn stage(
    pool: &SqlitePool,
    session: &Session,
    chunk: &Chunk<'_>,
) -> DbResult<Prefix> {
    let (digest, _) = inspect(session)?;
    if chunk.sequence < 0
        || chunk.offset < 0
        || chunk.data.is_empty()
        || chunk.data.len() > 65_536
        || chunk.sha256.len() != 32
        || hash(chunk.data) != chunk.sha256
        || std::str::from_utf8(chunk.data).is_err()
    {
        return Err(invalid("connect_transfer_invalid_chunk"));
    }
    let end = add(chunk.offset, chunk.data.len() as i64)?;
    let next_sequence = add(chunk.sequence, 1)?;
    if end > session.stream_bytes || chunk.eof != (end == session.stream_bytes) {
        return Err(invalid("connect_transfer_invalid_chunk"));
    }
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let prefix = current(&mut tx, session, &digest, true).await?;
    if prefix.next_sequence == next_sequence && prefix.next_offset == end {
        let saved: (i64,Vec<u8>,Vec<u8>,i64)=sqlx::query_as("SELECT offset_bytes,sha256,data,eof FROM connect_raw_chunks WHERE transfer_id=? AND sequence=?")
            .bind(&session.transfer_id).bind(chunk.sequence).fetch_one(&mut *tx).await?;
        if saved.0 != chunk.offset
            || saved.1 != chunk.sha256
            || saved.2 != chunk.data
            || saved.3 != i64::from(chunk.eof)
        {
            return Err(invalid("connect_transfer_chunk_conflict"));
        }
    } else {
        if prefix.eof
            || prefix.next_sequence != chunk.sequence
            || prefix.next_offset != chunk.offset
        {
            return Err(invalid("connect_transfer_chunk_conflict"));
        }
        let extra = charge(chunk.data.len() as i64, 112, 128)?;
        admit(&mut tx, extra).await?;
        sqlx::query("INSERT INTO connect_raw_chunks(transfer_id,sequence,offset_bytes,sha256,data,eof,charge_bytes) VALUES(?,?,?,?,?,?,?)")
            .bind(&session.transfer_id).bind(chunk.sequence).bind(chunk.offset).bind(chunk.sha256).bind(chunk.data).bind(i64::from(chunk.eof)).bind(extra).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE connect_raw_prefix SET next_sequence=?,next_offset=?,eof=? WHERE transfer_id=?",
        )
        .bind(next_sequence)
        .bind(end)
        .bind(i64::from(chunk.eof))
        .bind(&session.transfer_id)
        .execute(&mut *tx)
        .await?;
    }
    let committed = current(&mut tx, session, &digest, false).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(committed)
}
pub(super) async fn read_chunk(
    pool: &SqlitePool,
    session: &Session,
    sequence: i64,
) -> DbResult<Vec<u8>> {
    let (digest, _) = inspect(session)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin().await?;
    validate_schema(&mut tx).await?;
    let prefix = current(&mut tx, session, &digest, false).await?;
    if sequence < 0 || sequence >= prefix.next_sequence {
        return Err(invalid("connect_transfer_prefix_missing"));
    }
    let (data,digest):(Vec<u8>,Vec<u8>)=sqlx::query_as("SELECT data,sha256 FROM connect_raw_chunks WHERE transfer_id=? AND sequence=? AND length(data) BETWEEN 1 AND 65536")
        .bind(&session.transfer_id).bind(sequence).fetch_one(&mut *tx).await?;
    if hash(&data) != digest {
        return Err(invalid("connect_transfer_integrity_failed"));
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(data)
}
