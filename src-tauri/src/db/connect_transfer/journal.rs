use super::*;
use crate::core::db_state::DbPool;
use crate::db::{
    chat_admission::reconciliation::{self, Snapshot},
    models::ConversationContentToken,
};
use sqlx::{Connection, Row};

/// Owned expectations supplied by the later canonical/native composition. No
/// production constructor or deserializer accepts these from IPC/network JSON.
/// Its bytes are stored exactly; this low-level owner does not authenticate them
/// or replace the canonical validators with a second Rust contract implementation.
#[derive(Clone, Serialize)]
pub(in crate::db) struct Reservation {
    transfer_id: String,
    relay_origin: String,
    account_id: String,
    source_instance_id: String,
    source_conversation_id: String,
    source_epoch: i64,
    target_instance_id: String,
    source_generation: String,
    target_generation: String,
    binding_digest: Vec<u8>,
    binding_json: Vec<u8>,
    expectation_json: Vec<u8>,
    reserve_request: Vec<u8>,
    expected_ownership_revision: i64,
    expected_content: ConversationContentToken,
}
impl Reservation {
    fn inspect(&self) -> DbResult<(Vec<u8>, i64)> {
        uuid(&self.transfer_id)?;
        for id in [
            &self.account_id,
            &self.source_instance_id,
            &self.source_conversation_id,
            &self.target_instance_id,
            &self.source_generation,
            &self.target_generation,
        ] {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            {
                return Err(invalid("connect_transfer_invalid_identity"));
            }
        }
        if self.source_epoch <= 0
            || self.expected_ownership_revision <= 0
            || self.binding_digest.len() != 32
            || self.relay_origin.is_empty()
            || self.relay_origin.len() > 2048
            || self.source_instance_id == self.target_instance_id
        {
            return Err(invalid("connect_transfer_invalid_identity"));
        }
        for bytes in [
            &self.binding_json,
            &self.expectation_json,
            &self.reserve_request,
        ] {
            control(bytes, CONTROL)?;
        }
        fingerprint(self)
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(in crate::db) struct LocalReservation {
    pub transfer_id: String,
    pub fingerprint: Vec<u8>,
    pub ownership_revision: Option<i64>,
}
async fn existing(
    db: &mut SqliteConnection,
    input: &Reservation,
    role: &str,
    digest: &[u8],
) -> DbResult<Option<LocalReservation>> {
    super::deletion::require_transfer(db, &input.transfer_id).await?;
    let row = sqlx::query("SELECT local_role,fingerprint,ownership_revision FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_optional(db).await?;
    row.map(|row| {
        if row.get::<String, _>("local_role") != role
            || row.get::<Vec<u8>, _>("fingerprint") != digest
        {
            return Err(invalid("connect_transfer_conflict"));
        }
        Ok(LocalReservation {
            transfer_id: input.transfer_id.clone(),
            fingerprint: digest.to_vec(),
            ownership_revision: row.get("ownership_revision"),
        })
    })
    .transpose()
}
async fn insert(
    db: &mut SqliteConnection,
    input: &Reservation,
    role: &str,
    frozen: Option<&reconciliation::FrozenSource>,
    digest: &[u8],
    bytes: i64,
) -> DbResult<LocalReservation> {
    let high: Option<i64> = sqlx::query_scalar("SELECT MAX(source_epoch) FROM connect_transfers WHERE relay_origin=? AND account_id=? AND source_instance_id=? AND source_conversation_id=?")
        .bind(&input.relay_origin).bind(&input.account_id).bind(&input.source_instance_id).bind(&input.source_conversation_id).fetch_one(&mut *db).await?;
    if high.is_some_and(|high| input.source_epoch <= high) {
        return Err(invalid("connect_transfer_stale_epoch"));
    }
    // Three identity/index keys plus the PK and optional resource indexes.
    let key = add(
        add(
            input.relay_origin.len() as i64,
            input.account_id.len() as i64,
        )?,
        add(
            input.source_instance_id.len() as i64,
            input.source_conversation_id.len() as i64,
        )?,
    )?;
    let extra = charge(
        bytes,
        add(
            key.checked_mul(3)
                .ok_or_else(|| invalid("resource_limit"))?,
            256,
        )?,
        512,
    )?;
    admit_journal(db, extra).await?;
    sqlx::query("INSERT INTO connect_transfers(transfer_id,local_role,relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch,target_instance_id,source_generation,target_generation,binding_digest,binding_json,expectation_json,reserve_request,fingerprint,local_generation,ownership_incarnation,ownership_revision,content_incarnation,content_revision,phase,charge_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&input.transfer_id).bind(role).bind(&input.relay_origin).bind(&input.account_id).bind(&input.source_instance_id).bind(&input.source_conversation_id).bind(input.source_epoch).bind(&input.target_instance_id).bind(&input.source_generation).bind(&input.target_generation)
        .bind(&input.binding_digest).bind(&input.binding_json).bind(&input.expectation_json).bind(&input.reserve_request).bind(digest)
        .bind(frozen.map(|f| f.generation.as_str())).bind(frozen.map(|f| f.incarnation.as_str())).bind(frozen.map(|f| f.revision)).bind(frozen.map(|f| f.content.incarnation.as_str())).bind(frozen.map(|f| f.content.revision.as_str())).bind(if role=="source" {"reserved"} else {"receiving"}).bind(extra)
        .execute(db).await?;
    Ok(LocalReservation {
        transfer_id: input.transfer_id.clone(),
        fingerprint: digest.to_vec(),
        ownership_revision: frozen.map(|f| f.revision),
    })
}
/// Called only under the live browser lifecycle/inspection locks. Journal insert,
/// real 017 recheck and freeze share this FULL-synchronous transaction.
pub(in crate::db) async fn reserve_source(
    owner: &DbPool,
    snapshot: &Snapshot,
    input: &Reservation,
) -> DbResult<LocalReservation> {
    let (digest, bytes) = input.inspect()?;
    let guard = owner
        .source_ready(Some(snapshot.generation()))
        .await
        .map_err(|_| invalid("chat_admission_stale_generation"))?;
    let mut lease = lease(&guard.ready.pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    guard.ready.check_source_schema(&mut tx).await?;
    if input.source_conversation_id != snapshot.conversation {
        return Err(invalid("connect_transfer_conflict"));
    }
    if let Some(receipt) = existing(&mut tx, input, "source", &digest).await? {
        // A replay is a receipt read, never permission to emit or to unfreeze.
        tx.commit().await?;
        lease.committed = true;
        return Ok(receipt);
    }
    let frozen = reconciliation::freeze_in(&mut tx, snapshot).await?;
    if frozen.revision != input.expected_ownership_revision
        || frozen.content != input.expected_content
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let receipt = insert(&mut tx, input, "source", Some(&frozen), &digest, bytes).await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(receipt)
}
async fn reserve_target(pool: &SqlitePool, input: &Reservation) -> DbResult<LocalReservation> {
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let receipt = match existing(&mut tx, input, "target", &digest).await? {
        Some(receipt) => receipt,
        None => insert(&mut tx, input, "target", None, &digest, bytes).await?,
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(receipt)
}
/// No externally usable lease handle is returned. References in the journal own
/// retention even after the process, window or original test object disappears.
async fn attach_capture(pool: &SqlitePool, input: &Reservation, capture: &str) -> DbResult<()> {
    let (digest, _) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    existing(&mut tx, input, "source", &digest)
        .await?
        .ok_or_else(|| invalid("connect_transfer_not_found"))?;
    let row = sqlx::query("SELECT source_capture_id,local_generation,content_incarnation,content_revision,restore_hold,phase FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_one(&mut *tx).await?;
    if row.get::<i64, _>("restore_hold") != 0
        || row.get::<String, _>("phase") == "reconciliation_required"
    {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    let id = crate::db::source_capture::transfer_attachment(
        &mut tx,
        capture,
        &input.source_conversation_id,
        &row.get::<String, _>("local_generation"),
        &input.expected_content,
    )
    .await?;
    if row
        .get::<Option<i64>, _>("source_capture_id")
        .is_some_and(|old| old != id)
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    sqlx::query("UPDATE connect_transfers SET source_capture_id=? WHERE transfer_id=?")
        .bind(id)
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}
async fn attach_import(pool: &SqlitePool, input: &Reservation, key: &str) -> DbResult<()> {
    let (digest, _) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    existing(&mut tx, input, "target", &digest)
        .await?
        .ok_or_else(|| invalid("connect_transfer_not_found"))?;
    let current: (Option<i64>, i64, String) = sqlx::query_as(
        "SELECT inactive_import_id,restore_hold,phase FROM connect_transfers WHERE transfer_id=?",
    )
    .bind(&input.transfer_id)
    .fetch_one(&mut *tx)
    .await?;
    if current.1 != 0 || current.2 == "reconciliation_required" {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    let row = sqlx::query("SELECT id,begin_json FROM e_inactive_imports WHERE identity_key=? AND length(CAST(begin_json AS BLOB))<=4096 AND phase BETWEEN 0 AND 2").bind(key).fetch_optional(&mut *tx).await?.ok_or_else(|| invalid("connect_transfer_import_unavailable"))?;
    let begin: crate::db::inactive_storage::Begin =
        serde_json::from_str(&row.get::<String, _>("begin_json"))
            .map_err(|_| invalid("connect_transfer_import_unavailable"))?;
    let identity = &begin.identity;
    if identity.origin != input.relay_origin
        || identity.account_incarnation != input.account_id
        || identity.source_instance != input.source_instance_id
        || identity.source_conversation != input.source_conversation_id
        || identity.transfer != input.transfer_id
        || identity.source_epoch != input.source_epoch.to_string()
        || begin.bindings.target_instance != input.target_instance_id
        || begin.bindings.source_generation != input.source_generation
        || begin.bindings.target_generation != input.target_generation
        || crate::db::inactive_storage::identity_key(identity)
            .map_err(|_| invalid("connect_transfer_conflict"))?
            != key
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let id: i64 = row.get("id");
    if current.0.is_some_and(|old| old != id) {
        return Err(invalid("connect_transfer_conflict"));
    }
    sqlx::query("UPDATE connect_transfers SET inactive_import_id=? WHERE transfer_id=?")
        .bind(id)
        .bind(&input.transfer_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

#[derive(Serialize)]
struct Exchange {
    delivery_id: String,
    transfer_id: String,
    challenge_id: String,
    request_id: String,
    kind: String,
    subject_digest: Vec<u8>,
    prior_receipt_digest: Option<Vec<u8>>,
    producer_generation: String,
    connection_id: String,
    canonical_request: Vec<u8>,
    expectation_json: Vec<u8>,
}
impl Exchange {
    fn inspect(&self) -> DbResult<(Vec<u8>, i64)> {
        uuid(&self.delivery_id)?;
        uuid(&self.challenge_id)?;
        uuid(&self.connection_id)?;
        if self.request_id.is_empty()
            || self.request_id.len() > 128
            || self.producer_generation.is_empty()
            || self.producer_generation.len() > 128
            || self.subject_digest.len() != 32
            || self
                .prior_receipt_digest
                .as_ref()
                .is_some_and(|v| v.len() != 32)
        {
            return Err(invalid("connect_transfer_invalid_input"));
        }
        control(&self.canonical_request, CONTROL)?;
        control(&self.expectation_json, CONTROL)?;
        fingerprint(self)
    }
}
async fn prior_exchange(
    db: &mut SqliteConnection,
    input: &Exchange,
    digest: &[u8],
) -> DbResult<bool> {
    let old:Option<Vec<u8>>=sqlx::query_scalar("SELECT fingerprint FROM connect_exchanges WHERE delivery_id=? UNION ALL SELECT previous_fingerprint FROM connect_exchanges WHERE previous_delivery_id=?")
        .bind(&input.delivery_id).bind(&input.delivery_id).fetch_optional(&mut *db).await?;
    if let Some(old) = old {
        if old != digest {
            return Err(invalid("connect_transfer_conflict"));
        }
        return Ok(true);
    }
    let collision:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_exchanges WHERE challenge_id=? OR previous_challenge_id=?)")
        .bind(&input.challenge_id).bind(&input.challenge_id).fetch_one(db).await?;
    if collision != 0 {
        return Err(invalid("connect_transfer_conflict"));
    }
    Ok(false)
}
async fn check_new_exchange(db: &mut SqliteConnection, input: &Exchange) -> DbResult<()> {
    super::deletion::require_transfer(db, &input.transfer_id).await?;
    let role:Option<(String,String,String,i64,String,Option<String>,Option<String>)>=sqlx::query_as("SELECT local_role,source_generation,target_generation,restore_hold,phase,resolution,terminal_outcome FROM connect_transfers WHERE transfer_id=?")
        .bind(&input.transfer_id).fetch_optional(db).await?;
    let (role, source, target, hold, phase, resolution, terminal) =
        role.ok_or_else(|| invalid("connect_transfer_not_found"))?;
    if hold != 0
        || phase == "reconciliation_required"
        || input.producer_generation != if role == "source" { source } else { target }
    {
        return Err(invalid("connect_transfer_recovery_hold"));
    }
    if (terminal.is_some() || resolution.is_some())
        && !(role == "target"
            && resolution.as_deref() == Some("committed")
            && input.kind == "target_activated")
    {
        return Err(invalid("connect_transfer_terminal"));
    }
    if (role == "source"
        && !matches!(
            input.kind.as_str(),
            "source_frozen" | "source_sealed" | "source_maintained"
        ))
        || (role == "target"
            && !matches!(
                input.kind.as_str(),
                "target_pinned" | "target_maintained" | "target_activated"
            ))
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    Ok(())
}
async fn accept_exchange(pool: &SqlitePool, input: &Exchange) -> DbResult<Vec<u8>> {
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    if !prior_exchange(&mut tx, input, &digest).await? {
        check_new_exchange(&mut tx, input).await?;
        let occupied: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connect_exchanges WHERE transfer_id=? AND kind=?)",
        )
        .bind(&input.transfer_id)
        .bind(&input.kind)
        .fetch_one(&mut *tx)
        .await?;
        if occupied != 0 {
            return Err(invalid("connect_transfer_renewal_required"));
        }
        let extra = charge(bytes, 512, 256)?;
        admit_journal(&mut tx, extra).await?;
        sqlx::query("INSERT INTO connect_exchanges(delivery_id,transfer_id,challenge_id,request_id,kind,subject_digest,prior_receipt_digest,producer_generation,connection_id,canonical_request,expectation_json,fingerprint,phase,charge_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?)")
            .bind(&input.delivery_id).bind(&input.transfer_id).bind(&input.challenge_id).bind(&input.request_id).bind(&input.kind).bind(&input.subject_digest).bind(&input.prior_receipt_digest).bind(&input.producer_generation).bind(&input.connection_id).bind(&input.canonical_request).bind(&input.expectation_json).bind(&digest).bind(extra).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(digest)
}
/// A persisted adapter receipt, not an authentication capability. Only the
/// future canonical receiver may supply its closed bytes to this private owner.
/// No constructor or caller is exposed in product composition.
struct RecordedExchange {
    transfer_id: String,
    kind: String,
    delivery_id: String,
    fingerprint: Vec<u8>,
    receipt: Vec<u8>,
}
async fn record_exchange_receipt(
    pool: &SqlitePool,
    delivery: &str,
    expected_fingerprint: &[u8],
    receipt: &[u8],
) -> DbResult<RecordedExchange> {
    control(receipt, CONTROL)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let row=sqlx::query("SELECT transfer_id,kind,fingerprint,phase,relay_receipt FROM connect_exchanges WHERE delivery_id=? UNION ALL SELECT transfer_id,kind,previous_fingerprint AS fingerprint,'result_recorded' AS phase,previous_relay_receipt AS relay_receipt FROM connect_exchanges WHERE previous_delivery_id=?")
        .bind(delivery).bind(delivery).fetch_one(&mut *tx).await?;
    let digest: Vec<u8> = row.get("fingerprint");
    let old: Option<Vec<u8>> = row.get("relay_receipt");
    if digest != expected_fingerprint || old.as_deref().is_some_and(|v| v != receipt) {
        return Err(invalid("connect_transfer_conflict"));
    }
    if old.is_none() {
        if row.get::<String, _>("phase") != "result_pending" {
            return Err(invalid("connect_transfer_result_missing"));
        }
        let extra = receipt.len() as i64;
        admit(&mut tx, extra).await?;
        sqlx::query("UPDATE connect_exchanges SET relay_receipt=?,phase='result_recorded',charge_bytes=charge_bytes+? WHERE delivery_id=?")
            .bind(receipt).bind(extra).bind(delivery).execute(&mut *tx).await?;
    }
    let recorded = RecordedExchange {
        transfer_id: row.get("transfer_id"),
        kind: row.get("kind"),
        delivery_id: delivery.into(),
        fingerprint: digest,
        receipt: receipt.to_vec(),
    };
    tx.commit().await?;
    lease.committed = true;
    Ok(recorded)
}
/// Maintenance is renewable after its prior result was recorded. Keep the
/// immediately preceding receipt for exact retries; replace only this slot.
/// Older deliveries cannot enter through accept_exchange while the slot exists.
/// A future renewal caller must independently authenticate the new outstanding
/// canonical challenge; the predecessor here proves local storage only.
async fn renew_maintained_exchange(
    pool: &SqlitePool,
    input: &Exchange,
    previous: &RecordedExchange,
) -> DbResult<Vec<u8>> {
    if !matches!(
        input.kind.as_str(),
        "source_maintained" | "target_maintained"
    ) || input.transfer_id != previous.transfer_id
        || input.kind != previous.kind
    {
        return Err(invalid("connect_transfer_conflict"));
    }
    let (digest, bytes) = input.inspect()?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    if !prior_exchange(&mut tx, input, &digest).await? {
        check_new_exchange(&mut tx, input).await?;
        let row=sqlx::query("SELECT delivery_id,challenge_id,fingerprint,local_result,relay_receipt,phase,charge_bytes FROM connect_exchanges WHERE transfer_id=? AND kind=?")
            .bind(&input.transfer_id).bind(&input.kind).fetch_one(&mut *tx).await?;
        let old_result: Option<Vec<u8>> = row.get("local_result");
        let old_receipt: Option<Vec<u8>> = row.get("relay_receipt");
        if row.get::<String, _>("delivery_id") != previous.delivery_id
            || row.get::<Vec<u8>, _>("fingerprint") != previous.fingerprint
            || old_receipt.as_deref() != Some(previous.receipt.as_slice())
            || row.get::<String, _>("phase") != "result_recorded"
        {
            return Err(invalid("connect_transfer_conflict"));
        }
        let old_result = old_result.ok_or_else(|| invalid("connect_transfer_result_missing"))?;
        let old_receipt = old_receipt.ok_or_else(|| invalid("connect_transfer_result_missing"))?;
        let retained_previous = charge(
            add(old_result.len() as i64, old_receipt.len() as i64)?,
            144,
            128,
        )?;
        let new_charge = add(charge(bytes, 512, 256)?, retained_previous)?;
        let delta = new_charge
            .checked_sub(row.get::<i64, _>("charge_bytes"))
            .ok_or_else(|| invalid("resource_limit"))?;
        if delta > 0 {
            admit(&mut tx, delta).await?;
        }
        sqlx::query("UPDATE connect_exchanges SET previous_delivery_id=delivery_id,previous_challenge_id=challenge_id,previous_fingerprint=fingerprint,previous_local_result=local_result,previous_relay_receipt=relay_receipt,delivery_id=?,challenge_id=?,request_id=?,subject_digest=?,prior_receipt_digest=?,producer_generation=?,connection_id=?,canonical_request=?,expectation_json=?,fingerprint=?,phase='accepted',local_result=NULL,relay_receipt=NULL,charge_bytes=? WHERE transfer_id=? AND kind=?")
            .bind(&input.delivery_id).bind(&input.challenge_id).bind(&input.request_id).bind(&input.subject_digest).bind(&input.prior_receipt_digest).bind(&input.producer_generation).bind(&input.connection_id).bind(&input.canonical_request).bind(&input.expectation_json).bind(&digest).bind(new_charge).bind(&input.transfer_id).bind(&input.kind).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(digest)
}
async fn record_local_result(
    pool: &SqlitePool,
    delivery: &str,
    expected_fingerprint: &[u8],
    result: &[u8],
) -> DbResult<()> {
    control(result, CONTROL)?;
    let mut lease = lease(pool).await?;
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await?;
    validate_schema(&mut tx).await?;
    let (fingerprint, old, hold, phase): (Vec<u8>, Option<Vec<u8>>, i64, String) = sqlx::query_as(
        "SELECT e.fingerprint,e.local_result,t.restore_hold,t.phase FROM connect_exchanges e JOIN connect_transfers t ON t.transfer_id=e.transfer_id WHERE e.delivery_id=? UNION ALL SELECT e.previous_fingerprint,e.previous_local_result,t.restore_hold,t.phase FROM connect_exchanges e JOIN connect_transfers t ON t.transfer_id=e.transfer_id WHERE e.previous_delivery_id=?",
    )
    .bind(delivery)
    .bind(delivery)
    .fetch_one(&mut *tx)
    .await?;
    if fingerprint != expected_fingerprint || old.as_deref().is_some_and(|old| old != result) {
        return Err(invalid("connect_transfer_conflict"));
    }
    if old.is_none() {
        if hold != 0 || phase == "reconciliation_required" {
            return Err(invalid("connect_transfer_recovery_hold"));
        }
        let extra = i64::try_from(result.len()).map_err(|_| invalid("resource_limit"))?;
        admit(&mut tx, extra).await?;
        sqlx::query("UPDATE connect_exchanges SET phase='result_pending',local_result=?,charge_bytes=charge_bytes+? WHERE delivery_id=?")
            .bind(result).bind(extra).bind(delivery).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    lease.committed = true;
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
pub(super) mod tests;
