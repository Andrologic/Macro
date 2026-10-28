//! Durable target storage. The normal composition has no active authority until F.
#![allow(dead_code)] // No product caller or public command in this partial E slice.
mod types;
use super::{inactive_budget, preparation_lease::Lease};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, Sqlite, SqlitePool, Transaction};
use std::sync::Arc;
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
pub(crate) use types::*;

type Result<T> = std::result::Result<T, String>;
type Tx<'a> = Transaction<'a, Sqlite>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

// No deserialization or production constructor can create this authority.
struct Authority {
    enabled: bool,
    identity: Identity,
    bindings: Bindings,
    policy: Policy,
}
#[derive(Clone)]
struct Policy {
    budget: i64,
    max_receipts: i64,
    absolute_ms: i64,
    idle_ms: i64,
    secrets: Vec<Vec<u8>>,
}

pub(crate) struct InactiveStorage {
    pool: SqlitePool,
    authority: Option<Arc<RwLock<Authority>>>,
    clock: Clock,
    // The tuple retains the authenticated native scope and DbReady lifetime.
    // The two JSON values are expectations only, rechecked against that scope.
    native: Option<(
        Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
        serde_json::Value,
        serde_json::Value,
        crate::core::db_state::ChatWorkLifetime,
    )>,
    #[cfg(test)]
    lease_cleanup_started: Option<std::sync::mpsc::Sender<()>>,
}
impl InactiveStorage {
    pub fn closed(pool: SqlitePool) -> Self {
        Self {
            pool,
            authority: None,
            clock: Arc::new(|| 0),
            native: None,
            #[cfg(test)]
            lease_cleanup_started: None,
        }
    }
    pub(crate) async fn for_transfer(
        owner: &crate::core::db_state::DbPool,
        transport: Arc<crate::commands::pilot_secrets::transport::VerifiedTransport>,
        sent: serde_json::Value,
        manifest: serde_json::Value,
    ) -> Result<Self> {
        transport
            .check_target_transfer(&sent, &manifest)
            .await
            .map_err(str::to_owned)?;
        let (session_id, device_id) = transport.session_binding().map_err(str::to_owned)?;
        let binding = &sent["binding"];
        let source = &binding["provenance"]["source"];
        let text = |v: &serde_json::Value| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("binding_conflict".to_string())
        };
        let identity = Identity {
            origin: text(&source["relay_origin"])?,
            account_incarnation: text(&source["account_id"])?,
            source_instance: text(&source["source_instance_id"])?,
            source_conversation: text(&source["source_conversation_id"])?,
            transfer: text(&binding["transfer_id"])?,
            source_epoch: text(&binding["epoch"])?,
        };
        let bindings = Bindings {
            target_instance: text(&binding["target_instance_id"])?,
            source_generation: text(&binding["source_producer_generation"])?,
            target_generation: text(&binding["target_producer_generation"])?,
            actor: device_id.to_owned(),
            initial_session: session_id.to_owned(),
            policy_revision: uuid::Uuid::new_v4().to_string(),
        };
        let secrets = transport
            .detection_values()
            .await
            .map_err(str::to_owned)?
            .into_iter()
            .map(String::into_bytes)
            .collect();
        let guard = owner
            .source_ready(None)
            .await
            .map_err(|_| "database_unavailable")?;
        let lifetime = guard.ready.retain_chat_work();
        let pool = guard.ready.pool.clone();
        drop(guard);
        Ok(Self {
            pool,
            authority: Some(Arc::new(RwLock::new(Authority {
                enabled: true,
                identity,
                bindings,
                policy: Policy {
                    budget: super::inactive_budget::NATIVE_BUDGET,
                    max_receipts: super::inactive_budget::NATIVE_MAX_RECEIPTS,
                    absolute_ms: 300_000,
                    idle_ms: 30_000,
                    secrets,
                },
            }))),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            native: Some((transport, sent, manifest, lifetime)),
            #[cfg(test)]
            lease_cleanup_started: None,
        })
    }
    pub(crate) async fn begin_portable(
        &self,
        descriptor: &serde_json::Value,
        headers: &[RecordHeader],
    ) -> Result<Receipt> {
        let authority = self.authorize().await?;
        if let Some((_, _, manifest, _)) = &self.native {
            if descriptor["manifest_sha256"] != manifest["manifest_sha256"]
                || descriptor["content_contract_sha256"] != manifest["content_contract_sha256"]
            {
                return Err("binding_conflict".into());
            }
        }
        let mut begin = Begin {
            version: 1,
            identity: authority.identity.clone(),
            bindings: authority.bindings.clone(),
            profile: Profile::PortableChatHistoryV1,
            records: descriptor["records"].as_u64().ok_or("invalid_frame")?,
            bytes: descriptor["bytes"].as_u64().ok_or("invalid_frame")?,
            manifest_sha256: String::new(),
        };
        if headers.len() as u64 != begin.records || begin.bytes > 8 * 1024 * 1024 {
            return Err("resource_limit".into());
        }
        let mut manifest = Manifest::new(&begin)?;
        for header in headers {
            manifest.record(header)?;
        }
        begin.manifest_sha256 = manifest.finish();
        drop(authority);
        self.begin(json(&begin)?.as_bytes()).await
    }
    pub(crate) async fn portable_root(&self, key: &str) -> Result<serde_json::Value> {
        let receipt = self.status(key).await?;
        if receipt.phase != Phase::SealedStorage {
            return Err("not_sealed".into());
        }
        let (_, _, manifest, _) = self.native.as_ref().ok_or("inactive_storage_disabled")?;
        Ok(
            serde_json::json!({"kind":"archive","profile":"portable_chat_history_v1",
            "binding":{"version":1,"importKey":key,"manifest":manifest["manifest_sha256"]},"records":receipt.records.to_string(),
            "storage_revision":receipt.revision.to_string(),"mapping_sha256":receipt.mapping_sha256.ok_or("integrity_failed")?}),
        )
    }
    pub(crate) async fn check_native(&self) -> Result<()> {
        drop(self.authorize().await?);
        Ok(())
    }
    async fn authorize(&self) -> Result<OwnedRwLockReadGuard<Authority>> {
        if let Some((transport, sent, manifest, _)) = &self.native {
            transport
                .check_target_transfer(sent, manifest)
                .await
                .map_err(str::to_owned)?;
        }
        let authority = self
            .authority
            .as_ref()
            .ok_or("inactive_storage_disabled")?
            .clone()
            .read_owned()
            .await;
        if !authority.enabled {
            return Err("inactive_storage_disabled".into());
        }
        Ok(authority)
    }
    async fn lease(&self) -> Result<Lease> {
        let mut lease = Lease {
            connection: Some(self.pool.acquire().await.map_err(db)?),
            committed: false,
            #[cfg(test)]
            cleanup_started: self.lease_cleanup_started.clone(),
        };
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *lease)
            .await
            .map_err(db)?;
        Ok(lease)
    }
    async fn load(&self, tx: &mut Tx<'_>, key: &str, authority: &Authority) -> Result<Journal> {
        if identity_key(&authority.identity)? != key {
            return Err("binding_conflict".into());
        }
        let row=sqlx::query("SELECT * FROM e_inactive_imports WHERE identity_key=? AND length(CAST(begin_json AS BLOB))<=4096")
            .bind(key).fetch_optional(&mut **tx).await.map_err(db)?.ok_or("not_found")?;
        crate::db::connect_transfer::deletion::require_import(&mut **tx, row.get("id"))
            .await
            .map_err(|_| "connect_content_removed")?;
        let begin_json: String = row.get("begin_json");
        let begin: Begin = parse(begin_json.as_bytes())?;
        if begin.identity != authority.identity || begin.bindings != authority.bindings {
            return Err("binding_conflict".into());
        }
        let transfer_leased = crate::db::connect_transfer::import_leased(&mut **tx, row.get("id"))
            .await
            .map_err(|_| "database_unavailable")?;
        Ok(Journal {
            transfer_leased,
            id: row.get("id"),
            begin,
            phase: Phase::from_db(row.get("phase"))?,
            revision: row.get("revision"),
            next_record: row.get("next_record"),
            received: row.get("received_bytes"),
            charge: row.get("charge_bytes"),
            progress: row.get("progressed_at"),
            expires: row.get("expires_at"),
            idle: row.get("idle_ms"),
            last_clock: row.get("last_clock"),
            mapping: row.get("mapping_hash"),
        })
    }
    pub async fn begin(&self, control: &[u8]) -> Result<Receipt> {
        let authority = self.authorize().await?;
        let begin: Begin = parse(control)?;
        validate_begin(&begin)?;
        if begin.identity != authority.identity || begin.bindings != authority.bindings {
            return Err("binding_conflict".into());
        }
        let key = identity_key(&begin.identity)?;
        let canonical = json(&begin)?;
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT begin_json FROM e_inactive_imports WHERE identity_key=?")
                .bind(&key)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        if let Some(value) = existing {
            if value != canonical {
                return Err("intent_conflict".into());
            }
            let result = self.load(&mut tx, &key, &authority).await?.receipt(&key);
            tx.commit().await.map_err(db)?;
            lease.committed = true;
            return Ok(result);
        }
        let policy = &authority.policy;
        let count = inactive_budget::journal_count(&mut tx).await?;
        if count >= policy.max_receipts {
            return Err("resource_limit".into());
        }
        let charge = JOURNAL_BYTES
            .checked_add(canonical.len() as i64)
            .ok_or("resource_limit")?;
        inactive_budget::admit_e(&mut tx, charge, policy.budget, policy.max_receipts).await?;
        let now = (self.clock)();
        let expires = now
            .checked_add(policy.absolute_ms)
            .ok_or("resource_limit")?;
        sqlx::query("INSERT INTO e_inactive_imports(identity_key,begin_json,phase,revision,next_record,received_bytes,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES(?,?,0,0,0,0,?,?,?,?,?,?)")
            .bind(&key).bind(&canonical).bind(charge).bind(now).bind(now).bind(expires).bind(policy.idle_ms).bind(now).execute(&mut *tx).await.map_err(db)?;
        let result = self.load(&mut tx, &key, &authority).await?.receipt(&key);
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(result)
    }
    pub async fn append(&self, key: &str, control: &[u8], payload: &[u8]) -> Result<AppendAck> {
        let authority = self.authorize().await?;
        if payload.len() > FRAGMENT_BYTES {
            return Err("resource_limit".into());
        }
        let input: Append = parse(control)?;
        validate_record(&input.record)?;
        if !hash_valid(&input.sha256)
            || digest(payload) != input.sha256
            || input.offset > i64::MAX as u64
        {
            return Err("integrity_failed".into());
        }
        let canonical = json(&input.record)?;
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let journal = self.load(&mut tx, key, &authority).await?;
        validate_profile_record(&journal.begin, &input.record)?;
        let record=sqlx::query("SELECT header_json,received_bytes,complete,utf8_tail,scan_tail FROM e_inactive_records WHERE import_id=? AND ordinal=?")
            .bind(journal.id).bind(input.record.ordinal as i64).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = &record {
            if row.get::<String, _>("header_json") != canonical {
                return Err("intent_conflict".into());
            }
        }
        let previous=sqlx::query("SELECT data,ack_next_offset,ack_total_received,ack_revision FROM e_inactive_fragments WHERE import_id=? AND ordinal=? AND offset_bytes=? AND length(data)<=4093")
            .bind(journal.id).bind(input.record.ordinal as i64).bind(input.offset as i64).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = previous {
            if row.get::<Vec<u8>, _>("data") != payload {
                return Err("intent_conflict".into());
            }
            let ack = AppendAck {
                ordinal: input.record.ordinal,
                next_offset: row.get::<i64, _>("ack_next_offset") as u64,
                received_bytes: row.get::<i64, _>("ack_total_received") as u64,
                revision: row.get("ack_revision"),
            };
            tx.commit().await.map_err(db)?;
            lease.committed = true;
            return Ok(ack);
        }
        if journal.phase != Phase::Receiving {
            return Err("not_receiving".into());
        }
        let now = (self.clock)();
        journal.check_time(now)?;
        if input.record.ordinal != journal.next_record as u64
            || input.record.ordinal >= journal.begin.records
        {
            return Err("invalid_offset".into());
        }
        // The disk fills once the first record is stored: SQLITE_FULL rolls
        // the append back with this error (see sqlite_full_rolls_back_*).
        #[cfg(test)]
        if input.record.ordinal >= 1
            && std::env::var("MACRO_CONNECT_TEST_INTERRUPT").as_deref() == Ok("target_import_full")
        {
            return Err("database_unavailable".into());
        }
        let (offset, old_utf8, old_scan) = match &record {
            Some(row) => (
                row.get::<i64, _>("received_bytes"),
                row.get::<Vec<u8>, _>("utf8_tail"),
                row.get::<Vec<u8>, _>("scan_tail"),
            ),
            None => (0, vec![], vec![]),
        };
        let end = input
            .offset
            .checked_add(payload.len() as u64)
            .ok_or("resource_limit")?;
        if offset as u64 != input.offset
            || end > input.record.bytes
            || (payload.is_empty() && input.record.bytes != 0)
        {
            return Err("invalid_offset".into());
        }
        let complete = end == input.record.bytes;
        let utf8 = if input.record.entry.text() {
            utf8_tail(&old_utf8, payload, complete)?
        } else {
            vec![]
        };
        let scan = inspect(&old_scan, payload, &authority.policy.secrets)?;
        let mut extra =
            FRAGMENT_META_BYTES + payload.len() as i64 + utf8.len() as i64 + scan.len() as i64
                - old_utf8.len() as i64
                - old_scan.len() as i64;
        let new_record = record.is_none();
        if new_record {
            extra += RECORD_BYTES + canonical.len() as i64;
            if input.record.entry.tag() != 4 {
                extra += MAPPING_BYTES;
            }
        }
        let total = journal
            .received
            .checked_add(payload.len() as i64)
            .ok_or("resource_limit")?;
        if total as u64 > journal.begin.bytes {
            return Err("integrity_failed".into());
        }
        inactive_budget::admit(&mut tx, extra).await?;
        if new_record {
            let (from, to, position, relation) = input.record.entry.links();
            sqlx::query("INSERT INTO e_inactive_records VALUES(?,?,?,?,?,?,?,?,0,0,X'',X'')")
                .bind(journal.id)
                .bind(input.record.ordinal as i64)
                .bind(&canonical)
                .bind(input.record.entry.tag())
                .bind(from)
                .bind(to)
                .bind(position)
                .bind(relation)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            if input.record.entry.tag() != 4 {
                sqlx::query("INSERT INTO e_inactive_mapping VALUES(?,?,?)")
                    .bind(journal.id)
                    .bind(input.record.ordinal as i64)
                    .bind(uuid::Uuid::new_v4().to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
        }
        let revision = journal.revision.checked_add(1).ok_or("resource_limit")?;
        sqlx::query("INSERT INTO e_inactive_fragments VALUES(?,?,?,?,?,?,?,?)")
            .bind(journal.id)
            .bind(input.record.ordinal as i64)
            .bind(input.offset as i64)
            .bind(Sha256::digest(payload).as_slice())
            .bind(payload)
            .bind(end as i64)
            .bind(total)
            .bind(revision)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE e_inactive_records SET received_bytes=?,complete=?,utf8_tail=?,scan_tail=? WHERE import_id=? AND ordinal=?")
            .bind(end as i64).bind(complete).bind(utf8).bind(scan).bind(journal.id).bind(input.record.ordinal as i64).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE e_inactive_imports SET revision=?,next_record=?,received_bytes=?,charge_bytes=charge_bytes+?,progressed_at=?,last_clock=? WHERE id=?")
            .bind(revision).bind(journal.next_record+i64::from(complete)).bind(total).bind(extra).bind(now).bind(now).bind(journal.id).execute(&mut *tx).await.map_err(db)?;
        journal.check_time((self.clock)())?;
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(AppendAck {
            ordinal: input.record.ordinal,
            next_offset: end,
            received_bytes: total as u64,
            revision,
        })
    }
    pub async fn status(&self, key: &str) -> Result<Receipt> {
        let authority = self.authorize().await?;
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let receipt = self.load(&mut tx, key, &authority).await?.receipt(key);
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(receipt)
    }
    pub async fn abort_receiving(&self, key: &str) -> Result<Receipt> {
        let authority = self.authorize().await?;
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let journal = self.load(&mut tx, key, &authority).await?;
        if journal.transfer_leased {
            return Err("connect_transfer_leased".into());
        }
        if journal.phase == Phase::SealedStorage {
            return Err("storage_pinned".into());
        }
        if matches!(journal.phase, Phase::Receiving | Phase::Verifying) {
            sqlx::query("DELETE FROM e_inactive_records WHERE import_id=?")
                .bind(journal.id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            let charge = JOURNAL_BYTES + json(&journal.begin)?.len() as i64;
            let phase = if matches!(journal.check_time((self.clock)()), Err(error) if error == "expired")
            {
                Phase::Expired
            } else {
                Phase::Aborted
            };
            sqlx::query("UPDATE e_inactive_imports SET phase=?,revision=revision+1,next_record=0,received_bytes=0,charge_bytes=?,mapping_hash=NULL WHERE id=?")
                .bind(phase as i64).bind(charge).bind(journal.id).execute(&mut *tx).await.map_err(db)?;
        }
        let receipt = self.load(&mut tx, key, &authority).await?.receipt(key);
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(receipt)
    }
    pub async fn seal_storage(&self, key: &str) -> Result<SealedStorage> {
        let authority = self.authorize().await?;
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let mut journal = self.load(&mut tx, key, &authority).await?;
        if journal.phase == Phase::SealedStorage {
            let receipt = journal.receipt(key);
            tx.commit().await.map_err(db)?;
            lease.committed = true;
            return Ok(SealedStorage {
                receipt,
                manifest_sha256: journal.begin.manifest_sha256,
            });
        }
        if !matches!(journal.phase, Phase::Receiving | Phase::Verifying) {
            return Err("not_receiving".into());
        }
        journal.check_time((self.clock)())?;
        if journal.next_record as u64 != journal.begin.records
            || journal.received as u64 != journal.begin.bytes
        {
            return Err("incomplete_storage".into());
        }
        if journal.phase == Phase::Receiving {
            sqlx::query("UPDATE e_inactive_imports SET phase=1,revision=revision+1 WHERE id=?")
                .bind(journal.id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            journal.revision += 1;
        }
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        drop(lease);
        // No write transaction is kept while hashing payloads or scanning index pages.
        let mut manifest = Manifest::new(&journal.begin)?;
        let mut mapping = Sha256::new();
        mapping.update(b"macro-inactive-mapping-v1\0");
        let mut ordinal = 0u64;
        let mut bytes = 0u64;
        while ordinal < journal.begin.records {
            let rows=sqlx::query("SELECT r.ordinal,r.header_json,m.target_uuid FROM e_inactive_records r LEFT JOIN e_inactive_mapping m ON m.import_id=r.import_id AND m.ordinal=r.ordinal WHERE r.import_id=? AND r.ordinal>=? AND length(CAST(r.header_json AS BLOB))<=4096 ORDER BY r.ordinal LIMIT 32")
                .bind(journal.id).bind(ordinal as i64).fetch_all(&self.pool).await.map_err(db)?;
            if rows.is_empty() {
                return Err("integrity_failed".into());
            }
            for row in rows {
                if row.get::<i64, _>("ordinal") as u64 != ordinal {
                    return Err("integrity_failed".into());
                }
                let record: RecordHeader = parse(row.get::<String, _>("header_json").as_bytes())?;
                validate_record(&record)?;
                validate_profile_record(&journal.begin, &record)?;
                let mut offset = 0u64;
                let mut hash = Sha256::new();
                loop {
                    let fragment=sqlx::query("SELECT offset_bytes,data,sha256 FROM e_inactive_fragments WHERE import_id=? AND ordinal=? AND offset_bytes=? AND length(data)<=4093")
                        .bind(journal.id).bind(ordinal as i64).bind(offset as i64).fetch_optional(&self.pool).await.map_err(db)?.ok_or("integrity_failed")?;
                    let payload: Vec<u8> = fragment.get("data");
                    if Sha256::digest(&payload).as_slice() != fragment.get::<Vec<u8>, _>("sha256") {
                        return Err("integrity_failed".into());
                    }
                    hash.update(&payload);
                    offset += payload.len() as u64;
                    if offset == record.bytes {
                        break;
                    }
                    if payload.is_empty() || offset > record.bytes {
                        return Err("integrity_failed".into());
                    }
                }
                if format!("{:x}", hash.finalize()) != record.sha256 {
                    return Err("integrity_failed".into());
                }
                manifest.record(&record)?;
                bytes = bytes.checked_add(record.bytes).ok_or("resource_limit")?;
                let target: Option<String> = row.get("target_uuid");
                if record.entry.tag() != 4 {
                    let uuid = uuid::Uuid::parse_str(target.as_deref().ok_or("integrity_failed")?)
                        .map_err(|_| "integrity_failed")?;
                    mapping.update(ordinal.to_le_bytes());
                    mapping.update(uuid.as_bytes());
                } else if target.is_some() {
                    return Err("integrity_failed".into());
                }
                ordinal += 1;
                journal.check_time((self.clock)())?;
            }
        }
        let manifest_hash = manifest.finish();
        let mapping_hash = mapping.finalize().to_vec();
        if bytes != journal.begin.bytes || manifest_hash != journal.begin.manifest_sha256 {
            return Err("integrity_failed".into());
        }
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let current = self.load(&mut tx, key, &authority).await?;
        if current.phase != Phase::Verifying || current.revision != journal.revision {
            return Err("stale_revision".into());
        }
        current.check_time((self.clock)())?;
        let charge = charge(&mut tx, journal.id).await?;
        if charge != current.charge {
            return Err("integrity_failed".into());
        }
        let invalid:i64=sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_records a LEFT JOIN e_inactive_records f ON f.import_id=a.import_id AND f.ordinal=a.from_record LEFT JOIN e_inactive_records t ON t.import_id=a.import_id AND t.ordinal=a.to_record WHERE a.import_id=? AND (a.complete<>1 OR (a.kind=4 AND (f.ordinal IS NULL OR f.kind<>0 OR t.ordinal IS NULL OR t.kind<>CASE a.relation WHEN 0 THEN 3 WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE -1 END)))")
            .bind(journal.id).fetch_one(&mut *tx).await.map_err(db)?;
        if invalid != 0 {
            return Err("invalid_association".into());
        }
        if current.begin.profile == Profile::PortableChatHistoryV1 {
            let invalid:i64=sqlx::query_scalar("SELECT COUNT(*) FROM e_inactive_records r LEFT JOIN e_inactive_records o ON o.import_id=r.import_id AND o.ordinal=json_extract(r.header_json,'$.origin') WHERE r.import_id=? AND r.kind<>4 AND json_extract(r.header_json,'$.entry.purpose') IS NOT 'portable_metadata' AND (o.kind IS NULL OR o.kind<>1 OR json_extract(o.header_json,'$.entry.kind') IS NOT 'historical_text' OR json_extract(o.header_json,'$.entry.purpose') IS NOT 'portable_metadata')")
                .bind(journal.id).fetch_one(&mut *tx).await.map_err(db)?;
            if invalid != 0 {
                return Err("invalid_origin".into());
            }
        }
        inactive_budget::admit(&mut tx, 32).await?;
        sqlx::query("UPDATE e_inactive_imports SET phase=2,revision=revision+1,charge_bytes=charge_bytes+32,mapping_hash=? WHERE id=?")
            .bind(mapping_hash).bind(journal.id).execute(&mut *tx).await.map_err(db)?;
        let receipt = self.load(&mut tx, key, &authority).await?.receipt(key);
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(SealedStorage {
            receipt,
            manifest_sha256: manifest_hash,
        })
    }
    pub async fn readback(
        &self,
        key: &str,
        after: Option<Cursor>,
        limit: usize,
    ) -> Result<Readback> {
        let authority = self.authorize().await?;
        if limit == 0
            || limit > PAGE_FRAGMENTS
            || after.is_some_and(|c| c.ordinal > i64::MAX as u64 || c.offset > i64::MAX as u64)
        {
            return Err("resource_limit".into());
        }
        let mut lease = self.lease().await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let journal = self.load(&mut tx, key, &authority).await?;
        if journal.phase != Phase::SealedStorage {
            return Err("not_sealed".into());
        }
        let (ordinal, offset) = after.map_or((-1, -1), |c| (c.ordinal as i64, c.offset as i64));
        let rows=sqlx::query("SELECT r.header_json,f.offset_bytes,f.data,f.sha256,m.target_uuid FROM e_inactive_fragments f JOIN e_inactive_records r ON r.import_id=f.import_id AND r.ordinal=f.ordinal LEFT JOIN e_inactive_mapping m ON m.import_id=f.import_id AND m.ordinal=f.ordinal WHERE f.import_id=? AND (f.ordinal>? OR (f.ordinal=? AND f.offset_bytes>?)) AND length(f.data)<=4093 AND length(CAST(r.header_json AS BLOB))<=4096 ORDER BY f.ordinal,f.offset_bytes LIMIT ?")
            .bind(journal.id).bind(ordinal).bind(ordinal).bind(offset).bind(limit as i64).fetch_all(&mut *tx).await.map_err(db)?;
        let mut fragments = Vec::with_capacity(rows.len());
        for row in rows {
            let payload: Vec<u8> = row.get("data");
            if Sha256::digest(&payload).as_slice() != row.get::<Vec<u8>, _>("sha256") {
                return Err("integrity_failed".into());
            }
            fragments.push(StoredFragment {
                record: parse(row.get::<String, _>("header_json").as_bytes())?,
                offset: row.get::<i64, _>("offset_bytes") as u64,
                bytes: payload,
                target_uuid: row.get("target_uuid"),
            });
        }
        let next = fragments
            .last()
            .filter(|_| fragments.len() == limit)
            .map(|f| Cursor {
                ordinal: f.record.ordinal,
                offset: f.offset,
            });
        tx.commit().await.map_err(db)?;
        lease.committed = true;
        Ok(Readback { fragments, next })
    }
}
struct Journal {
    id: i64,
    begin: Begin,
    phase: Phase,
    revision: i64,
    next_record: i64,
    received: i64,
    charge: i64,
    progress: i64,
    expires: i64,
    idle: i64,
    last_clock: i64,
    mapping: Option<Vec<u8>>,
    transfer_leased: bool,
}
impl Journal {
    fn receipt(&self, key: &str) -> Receipt {
        Receipt {
            key: key.into(),
            phase: self.phase,
            revision: self.revision,
            received_bytes: self.received,
            records: self.next_record,
            charge_bytes: self.charge,
            mapping_sha256: self
                .mapping
                .as_ref()
                .map(|v| v.iter().map(|b| format!("{b:02x}")).collect()),
        }
    }
    fn check_time(&self, now: i64) -> Result<()> {
        if now < self.last_clock {
            return Err("clock_rollback".into());
        }
        if !self.transfer_leased
            && (now >= self.expires
                || now.checked_sub(self.progress).ok_or("clock_rollback")? >= self.idle)
        {
            return Err("expired".into());
        }
        Ok(())
    }
}
fn db(_: sqlx::Error) -> String {
    "database_unavailable".into()
}
fn validate_begin(input: &Begin) -> Result<()> {
    if input.version != 1
        || input.records == 0
        || input.records > i64::MAX as u64
        || input.bytes > i64::MAX as u64
        || !hash_valid(&input.manifest_sha256)
    {
        return Err("invalid_frame".into());
    }
    for v in [
        &input.identity.origin,
        &input.identity.account_incarnation,
        &input.identity.source_instance,
        &input.identity.source_conversation,
        &input.identity.transfer,
        &input.identity.source_epoch,
        &input.bindings.target_instance,
        &input.bindings.source_generation,
        &input.bindings.target_generation,
        &input.bindings.actor,
        &input.bindings.initial_session,
        &input.bindings.policy_revision,
    ] {
        if v.is_empty() || v.len() > 128 {
            return Err("invalid_frame".into());
        }
    }
    Ok(())
}
/// Shared stored-header validation for the local published archive reader.
/// This parses data only and never constructs inactive-storage authority.
pub(in crate::db) fn published_record(
    begin: &Begin,
    bytes: &[u8],
    kind: i64,
    links: (Option<i64>, Option<i64>, Option<i64>, Option<i64>),
) -> Result<RecordHeader> {
    let record: RecordHeader = parse(bytes)?;
    validate_record(&record)?;
    validate_profile_record(begin, &record)?;
    if record.entry.tag() != kind || record.entry.links() != links {
        return Err("integrity_failed".into());
    }
    Ok(record)
}

fn validate_record(input: &RecordHeader) -> Result<()> {
    if input.ordinal > i64::MAX as u64
        || input.bytes > i64::MAX as u64
        || !hash_valid(&input.sha256)
        || input.origin.is_some_and(|value| value > i64::MAX as u64)
    {
        return Err("invalid_frame".into());
    }
    if let RecordKind::Association {
        from, to, position, ..
    } = input.entry
    {
        if input.bytes != 0
            || from > i64::MAX as u64
            || to > i64::MAX as u64
            || position > i64::MAX as u64
        {
            return Err("invalid_frame".into());
        }
    }
    Ok(())
}
fn validate_profile_record(begin: &Begin, input: &RecordHeader) -> Result<()> {
    let portable = matches!(
        input.entry,
        RecordKind::HistoricalText {
            purpose: TextPurpose::PortableMetadata
                | TextPurpose::OriginalText
                | TextPurpose::HistoricalData
        }
    );
    match begin.profile {
        Profile::SyntheticHistoryV1 if input.origin.is_some() || portable => {
            Err("invalid_profile".into())
        }
        Profile::PortableChatHistoryV1 => {
            let metadata = matches!(
                input.entry,
                RecordKind::HistoricalText {
                    purpose: TextPurpose::PortableMetadata
                }
            );
            let association = matches!(input.entry, RecordKind::Association { .. });
            if metadata || association {
                if input.origin.is_some() {
                    return Err("invalid_origin".into());
                }
            } else if input
                .origin
                .is_none_or(|origin| origin >= begin.records || origin == input.ordinal)
            {
                return Err("invalid_origin".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn utf8_tail(previous: &[u8], payload: &[u8], complete: bool) -> Result<Vec<u8>> {
    let mut joined = Vec::with_capacity(previous.len() + payload.len());
    joined.extend_from_slice(previous);
    joined.extend_from_slice(payload);
    match std::str::from_utf8(&joined) {
        Ok(_) => Ok(vec![]),
        Err(error)
            if error.error_len().is_none()
                && !complete
                && joined.len() - error.valid_up_to() <= 3 =>
        {
            Ok(joined[error.valid_up_to()..].to_vec())
        }
        _ => Err("invalid_utf8".into()),
    }
}
fn inspect(previous: &[u8], payload: &[u8], secrets: &[Vec<u8>]) -> Result<Vec<u8>> {
    let mut joined = Vec::with_capacity(previous.len() + payload.len());
    joined.extend_from_slice(previous);
    joined.extend_from_slice(payload);
    if secrets
        .iter()
        .any(|s| !s.is_empty() && joined.windows(s.len()).any(|w| w == s))
    {
        return Err("private_context".into());
    }
    let keep = secrets
        .iter()
        .map(|s| s.len().saturating_sub(1))
        .max()
        .unwrap_or(0)
        .min(joined.len());
    Ok(joined[joined.len() - keep..].to_vec())
}
async fn charge(db: &mut sqlx::SqliteConnection, id: i64) -> Result<i64> {
    sqlx::query_scalar("SELECT 152+length(CAST(begin_json AS BLOB))+COALESCE(length(mapping_hash),0)+COALESCE((SELECT SUM(104+length(CAST(header_json AS BLOB))+length(utf8_tail)+length(scan_tail)) FROM e_inactive_records WHERE import_id=?),0)+COALESCE((SELECT SUM(96+length(data)) FROM e_inactive_fragments WHERE import_id=?),0)+COALESCE((SELECT COUNT(*)*104 FROM e_inactive_mapping WHERE import_id=?),0) FROM e_inactive_imports WHERE id=?")
        .bind(id).bind(id).bind(id).bind(id).fetch_one(db).await.map_err(db_error)
}
fn db_error(_: sqlx::Error) -> String {
    "database_unavailable".into()
}

#[cfg(test)]
pub(crate) mod tests;
