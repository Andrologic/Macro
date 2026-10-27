//! Storage-only terminal transitions. There is intentionally no production
//! constructor, deserializer or export. A canonical authenticated receiver must
//! eventually own construction; neither these bytes nor a DB replay authenticate.
use super::*;
use sqlx::{Connection, Row};

#[derive(Serialize)]
struct TerminalWrite {
    transfer_id: String,
    reservation_fingerprint: Vec<u8>,
    binding_digest: Vec<u8>,
    source_epoch: i64,
    outcome: Outcome,
    decision_revision: String,
    exact: Vec<u8>,
    canonical_digest: Vec<u8>,
    prepared_digest: Option<Vec<u8>>,
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
enum Outcome {
    Committed,
    Aborted,
}
impl Outcome {
    fn name(self) -> &'static str {
        match self {
            Self::Committed => "committed",
            Self::Aborted => "aborted",
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
enum SourceApplication {
    Held,
    Applied,
    PreviouslyApplied,
}
async fn store_in(db: &mut SqliteConnection, input: &TerminalWrite) -> DbResult<()> {
    control(&input.exact, CONTROL)?;
    if input.canonical_digest.len() != 32
        || input.binding_digest.len() != 32
        || input.reservation_fingerprint.len() != 32
        || input
            .prepared_digest
            .as_ref()
            .is_some_and(|d| d.len() != 32)
    {
        return Err(invalid("connect_terminal_invalid_input"));
    }
    // Storage bounds only. Canonical decimals, digests and decision rules belong
    // to the codec, not this owner. The revision never becomes a native counter.
    control(input.decision_revision.as_bytes(), 32)?;
    let (fp, bytes) = fingerprint(input)?;
    let row=sqlx::query("SELECT fingerprint,binding_digest,source_epoch,terminal_fingerprint FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_one(&mut *db).await?;
    if row.get::<Vec<u8>, _>("fingerprint") != input.reservation_fingerprint
        || row.get::<Vec<u8>, _>("binding_digest") != input.binding_digest
        || row.get::<i64, _>("source_epoch") != input.source_epoch
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    if let Some(old) = row.get::<Option<Vec<u8>>, _>("terminal_fingerprint") {
        if old != fp {
            return Err(invalid("connect_terminal_conflict"));
        }
        return Ok(());
    }
    let extra = charge(bytes, 96, 256)?;
    admit(db, extra).await?;
    let retained: i64 =
        sqlx::query_scalar("SELECT charge_bytes FROM connect_transfers WHERE transfer_id=?")
            .bind(&input.transfer_id)
            .fetch_one(&mut *db)
            .await?;
    sqlx::query("UPDATE connect_transfers SET terminal_outcome=?,terminal_exact=?,terminal_digest=?,terminal_fingerprint=?,terminal_revision=?,terminal_prepared_digest=?,charge_bytes=? WHERE transfer_id=?")
        .bind(input.outcome.name()).bind(&input.exact).bind(&input.canonical_digest).bind(fp).bind(&input.decision_revision).bind(&input.prepared_digest).bind(add(retained,extra)?).bind(&input.transfer_id).execute(db).await?;
    Ok(())
}
async fn store(pool: &SqlitePool, input: &TerminalWrite) -> DbResult<()> {
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    store_in(&mut tx, input).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
async fn apply_source(pool: &SqlitePool, input: &TerminalWrite) -> DbResult<SourceApplication> {
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    crate::db::chat_admission::validate_schema(&mut tx).await?;
    store_in(&mut tx, input).await?;
    let row=sqlx::query("SELECT t.local_role,t.source_conversation_id,t.ownership_incarnation,t.ownership_revision,t.resolution,t.restore_hold,o.incarnation,o.revision,o.mode FROM connect_transfers t LEFT JOIN chat_admission_owners o ON o.conversation_id=t.source_conversation_id WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    if row.get::<String, _>("local_role") != "source" {
        return Err(invalid("connect_terminal_wrong_role"));
    }
    let result = if row.get::<Option<String>, _>("resolution").is_some() {
        // In particular an old aborted T cannot touch the next reservation.
        SourceApplication::PreviouslyApplied
    } else if row.get::<i64, _>("restore_hold") != 0
        || row.get::<String, _>("mode") == "restore_hold"
    {
        SourceApplication::Held
    } else {
        if row.get::<String, _>("incarnation") != row.get::<String, _>("ownership_incarnation")
            || row.get::<i64, _>("revision") != row.get::<i64, _>("ownership_revision")
            || row.get::<String, _>("mode") != "frozen"
        {
            return Err(invalid("connect_terminal_owner_stale"));
        }
        let conversation: String = row.get("source_conversation_id");
        let rev = add(row.get("revision"), 1)?;
        sqlx::query("UPDATE connect_transfers SET resolution=? WHERE transfer_id=? AND source_epoch=? AND resolution IS NULL")
            .bind(input.outcome.name()).bind(&input.transfer_id).bind(input.source_epoch).execute(&mut *tx).await?;
        let changed=sqlx::query("UPDATE chat_admission_owners SET mode=?,revision=?,browser_reconciled=0,runtime_generation=NULL WHERE conversation_id=? AND incarnation=? AND revision=? AND mode='frozen'")
            .bind(if input.outcome==Outcome::Committed {"ceded"} else {"open"}).bind(rev).bind(conversation).bind(row.get::<String,_>("ownership_incarnation")).bind(row.get::<i64,_>("ownership_revision")).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(invalid("connect_terminal_owner_stale"));
        }
        SourceApplication::Applied
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(result)
}

// Storage composition only. The caller retains the original native reservation
// and has already obtained and matched the authenticated canonical terminal.
fn decode_digest(value: String) -> DbResult<Vec<u8>> {
    if value.len() != 64 {
        return Err(invalid("connect_terminal_invalid_input"));
    }
    (0..64)
        .step_by(2)
        .map(|n| {
            u8::from_str_radix(&value[n..n + 2], 16)
                .map_err(|_| invalid("connect_terminal_invalid_input"))
        })
        .collect()
}
pub(super) async fn store_committed(
    pool: &SqlitePool,
    transfer: &str,
    reservation_fingerprint: Vec<u8>,
    binding_digest: Vec<u8>,
    source_epoch: i64,
    terminal: &serde_json::Value,
    source: bool,
) -> DbResult<Vec<u8>> {
    use crate::commands::pilot_secrets::transport::commitment;
    let decode = decode_digest;
    let input = TerminalWrite {
        transfer_id: transfer.into(),
        reservation_fingerprint,
        binding_digest,
        source_epoch,
        outcome: Outcome::Committed,
        decision_revision: terminal["decision_revision"]
            .as_str()
            .ok_or_else(|| invalid("connect_terminal_invalid_input"))?
            .into(),
        exact: serde_json::to_vec(terminal)
            .map_err(|_| invalid("connect_terminal_invalid_input"))?,
        canonical_digest: decode(commitment("terminal", terminal).map_err(invalid)?)?,
        prepared_digest: Some(decode(
            commitment("prepared", &terminal["prepared"]).map_err(invalid)?,
        )?),
    };
    if source {
        if apply_source(pool, &input).await? == SourceApplication::Held {
            return Err(invalid("connect_terminal_hold"));
        }
    } else {
        store(pool, &input).await?;
    }
    Ok(fingerprint(&input)?.0)
}
// Only a durable aborted receipt for this epoch reopens the frozen source.
pub(super) async fn store_aborted_source(
    pool: &SqlitePool,
    transfer: &str,
    reservation_fingerprint: Vec<u8>,
    binding_digest: Vec<u8>,
    source_epoch: i64,
    terminal: &serde_json::Value,
) -> DbResult<()> {
    use crate::commands::pilot_secrets::transport::commitment;
    if terminal["outcome"] != "aborted" || !terminal["prepared"].is_null() {
        return Err(invalid("connect_terminal_invalid_input"));
    }
    let input = TerminalWrite {
        transfer_id: transfer.into(),
        reservation_fingerprint,
        binding_digest,
        source_epoch,
        outcome: Outcome::Aborted,
        decision_revision: terminal["decision_revision"]
            .as_str()
            .ok_or_else(|| invalid("connect_terminal_invalid_input"))?
            .into(),
        exact: serde_json::to_vec(terminal)
            .map_err(|_| invalid("connect_terminal_invalid_input"))?,
        canonical_digest: decode_digest(commitment("terminal", terminal).map_err(invalid)?)?,
        prepared_digest: None,
    };
    if apply_source(pool, &input).await? == SourceApplication::Held {
        return Err(invalid("connect_terminal_hold"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;

#[cfg(test)]
pub(super) async fn store_target_fixture(
    pool: &SqlitePool,
    transfer: &str,
    prepared: &[u8],
) -> Vec<u8> {
    let row = sqlx::query(
        "SELECT fingerprint,binding_digest,source_epoch FROM connect_transfers WHERE transfer_id=?",
    )
    .bind(transfer)
    .fetch_one(pool)
    .await
    .unwrap();
    let input = TerminalWrite {
        transfer_id: transfer.into(),
        reservation_fingerprint: row.get("fingerprint"),
        binding_digest: row.get("binding_digest"),
        source_epoch: row.get("source_epoch"),
        outcome: Outcome::Committed,
        decision_revision: "2".into(),
        exact: b"synthetic storage terminal, not authenticated".to_vec(),
        canonical_digest: vec![7; 32],
        prepared_digest: Some(prepared.to_vec()),
    };
    store(pool, &input).await.unwrap();
    fingerprint(&input).unwrap().0
}

/// SQLite transition fixture only. This is absent from production and emits no
/// authenticated terminal or transport capability.
#[cfg(test)]
pub(in crate::db) async fn commit_source_fixture(pool: &SqlitePool, transfer: &str) {
    let row = sqlx::query(
        "SELECT fingerprint,binding_digest,source_epoch FROM connect_transfers WHERE transfer_id=?",
    )
    .bind(transfer)
    .fetch_one(pool)
    .await
    .unwrap();
    let input = TerminalWrite {
        transfer_id: transfer.into(),
        reservation_fingerprint: row.get("fingerprint"),
        binding_digest: row.get("binding_digest"),
        source_epoch: row.get("source_epoch"),
        outcome: Outcome::Committed,
        decision_revision: "2".into(),
        exact: b"synthetic storage terminal, not authenticated".to_vec(),
        canonical_digest: vec![7; 32],
        prepared_digest: None,
    };
    assert_eq!(
        apply_source(pool, &input).await.unwrap(),
        SourceApplication::Applied
    );
}
