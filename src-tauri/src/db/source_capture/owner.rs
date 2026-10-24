use super::*;
use crate::core::db_state::{DbPool, DbSourceGuard};
use crate::db::{conversation_content, inactive_budget, preparation_lease::Lease};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use std::sync::Arc;
use tokio::sync::{OwnedRwLockReadGuard, OwnedSemaphorePermit, RwLock, Semaphore};
use types::*;

pub(super) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Continue,
    Recovery,
    SealedRead,
}
#[derive(Clone)]
pub(super) struct Policy {
    pub budget: i64,
    pub max_receipts: i64,
    pub absolute_ms: i64,
    pub idle_ms: i64,
}
pub(super) struct Authority {
    pub enabled: bool,
    pub capture_id: String,
    pub conversation: String,
    pub actor: String,
    pub mode: Mode,
    pub policy: Policy,
}
pub(crate) struct SourceCapture {
    pub(super) owner: DbPool,
    pub(super) generation: Option<String>,
    pub(super) authority: Option<Arc<RwLock<Authority>>>,
    pub(super) permit: Arc<Semaphore>,
    pub(super) clock: Clock,
    #[cfg(test)]
    pub(super) cleanup_started: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(test)]
    pub(super) reads: Arc<blob::ReadStats>,
}
pub(super) struct Scope {
    pub generation: DbSourceGuard,
    pub authority: OwnedRwLockReadGuard<Authority>,
    _permit: OwnedSemaphorePermit,
}
pub(super) struct Journal {
    pub id: i64,
    pub binding: Binding,
    pub phase: i64,
    pub revision: i64,
    pub family: i64,
    pub rowid: Option<i64>,
    pub field: i64,
    pub offset: i64,
    pub rows: i64,
    pub fields: i64,
    pub bytes: i64,
    pub charge: i64,
    pub progressed: i64,
    pub expires: i64,
    pub idle: i64,
    pub last: i64,
    pub manifest: Option<Vec<u8>>,
    pub transfer_leased: bool,
}
impl Journal {
    pub fn receipt(&self, id: &str) -> Receipt {
        Receipt {
            capture_id: id.into(),
            phase: self.phase,
            revision: self.revision,
            cursor: Cursor {
                field: self.fields - if self.offset > 0 { 1 } else { 0 },
                offset: self.offset,
            },
            rows: self.rows,
            fields: self.fields,
            bytes: self.bytes,
            charge: self.charge,
        }
    }
}
impl SourceCapture {
    pub fn closed(owner: DbPool) -> Self {
        Self {
            owner,
            generation: None,
            authority: None,
            permit: Arc::new(Semaphore::new(1)),
            clock: Arc::new(|| 0),
            #[cfg(test)]
            cleanup_started: None,
            #[cfg(test)]
            reads: Arc::default(),
        }
    }
    pub(super) fn present(&self) -> Result<()> {
        if self.authority.is_none() {
            Err("source_capture_disabled".into())
        } else {
            Ok(())
        }
    }
    pub(super) async fn scope(&self, mutating: bool) -> Result<Scope> {
        self.present()?;
        let generation = self
            .owner
            .source_ready(self.generation.as_deref())
            .await
            .map_err(|_| "unavailable".to_string())?;
        let authority = self.authority.as_ref().unwrap().clone().read_owned().await;
        if !authority.enabled || (mutating && authority.mode != Mode::Continue) {
            return Err("source_capture_disabled".into());
        }
        let permit = self
            .permit
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "unavailable")?;
        Ok(Scope {
            generation,
            authority,
            _permit: permit,
        })
    }
    pub(super) async fn lease(&self, pool: &SqlitePool) -> Result<Lease> {
        let mut lease = Lease::new(pool.acquire().await.map_err(error)?);
        sqlx::query("PRAGMA synchronous=FULL").execute(&mut *lease).await.map_err(error)?;
        #[cfg(test)]
        let lease = {
            let mut observed = lease;
            observed.cleanup_started = self.cleanup_started.clone();
            observed
        };
        Ok(lease)
    }
    pub(super) async fn load(&self, db: &mut SqliteConnection, scope: &Scope) -> Result<Journal> {
        scope
            .generation
            .ready
            .check_source_schema(db)
            .await
            .map_err(|_| "stale_revision")?;
        let r=sqlx::query("SELECT id,CASE WHEN length(CAST(binding_json AS BLOB))<=4096 THEN binding_json END AS binding_json,phase,revision,family,cursor_rowid,cursor_field,cursor_offset,rows_count,fields_count,bytes_received,charge_bytes,progressed_at,expires_at,idle_ms,last_clock,CASE WHEN typeof(manifest_hash)='blob' AND length(manifest_hash)=32 THEN manifest_hash END AS manifest_hash FROM e_source_captures WHERE capture_id=?").bind(&scope.authority.capture_id).fetch_optional(&mut *db).await.map_err(error)?.ok_or("not_found")?;
        let removed: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=?)").bind(r.get::<i64,_>("id")).fetch_one(&mut *db).await.map_err(error)?;
        if removed != 0 { return Err("connect_content_removed".into()); }
        let raw: Option<String> = r.try_get("binding_json").map_err(error)?;
        let binding: Binding = parse(raw.ok_or("database_unavailable")?.as_bytes())?;
        if binding.version != 1 {
            return Err("database_unavailable".into());
        }
        if scope.authority.mode == Mode::Continue
            && (binding.actor != scope.authority.actor
                || binding.conversation != scope.authority.conversation
                || binding.generation != scope.generation.ready.catalog_generation)
        {
            return Err("binding_conflict".into());
        }
        let phase: i64 = r.try_get("phase").map_err(error)?;
        if scope.authority.mode == Mode::SealedRead && phase != 2 {
            return Err("capture_not_sealed".into());
        }
        let manifest: Option<Vec<u8>> = r.try_get("manifest_hash").map_err(error)?;
        if phase == 2 && manifest.is_none() {
            return Err("integrity_failed".into());
        }
        let id: i64 = r.try_get("id").map_err(error)?;
        let transfer_leased = crate::db::connect_transfer::capture_leased(db,id).await.map_err(error)?;
        Ok(Journal {
            transfer_leased,
            id: r.try_get("id").map_err(error)?,
            binding,
            phase: r.try_get("phase").map_err(error)?,
            revision: r.try_get("revision").map_err(error)?,
            family: r.try_get("family").map_err(error)?,
            rowid: r.try_get("cursor_rowid").map_err(error)?,
            field: r.try_get("cursor_field").map_err(error)?,
            offset: r.try_get("cursor_offset").map_err(error)?,
            rows: r.try_get("rows_count").map_err(error)?,
            fields: r.try_get("fields_count").map_err(error)?,
            bytes: r.try_get("bytes_received").map_err(error)?,
            charge: r.try_get("charge_bytes").map_err(error)?,
            progressed: r.try_get("progressed_at").map_err(error)?,
            expires: r.try_get("expires_at").map_err(error)?,
            idle: r.try_get("idle_ms").map_err(error)?,
            last: r.try_get("last_clock").map_err(error)?,
            manifest,
        })
    }
    pub(super) async fn validate_live(&self, db: &mut SqliteConnection, j: &Journal) -> Result<()> {
        let token =
            conversation_content::token_in(db, &j.binding.conversation, Some(&j.binding.content))
                .await
                .map_err(|_| "stale_revision".to_string())?;
        if token != j.binding.content
            || version::token(db).await.map_err(error)? != j.binding.dependencies
            || schema(db).await? != j.binding.schema
        {
            return Err("stale_revision".into());
        }
        let global:i64=sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id=? AND scope_mode='Chat' AND task_id IS NULL AND group_id IS NULL AND project_id IS NULL").bind(&j.binding.conversation).fetch_one(db).await.map_err(error)?;
        if global != 1 {
            return Err("source_not_global_chat".into());
        }
        Ok(())
    }
    pub(super) fn time(&self, j: &Journal) -> Result<i64> {
        let now = (self.clock)();
        if now < j.last {
            return Err("clock_rollback".into());
        }
        if !j.transfer_leased && (now >= j.expires || now.saturating_sub(j.progressed) >= j.idle) {
            return Err("capture_expired".into());
        }
        Ok(now)
    }
    pub async fn begin(&self, raw: &[u8]) -> Result<Receipt> {
        self.present()?;
        let input: Open = parse(raw)?;
        if uuid::Uuid::parse_str(&input.capture_id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(input.capture_id.as_str())
        {
            return Err("validation_failed".into());
        }
        conversation_content::check_id(&input.conversation_id).map_err(|_| "validation_failed")?;
        let scope = self.scope(true).await?;
        if input.capture_id != scope.authority.capture_id
            || input.conversation_id != scope.authority.conversation
        {
            return Err("binding_conflict".into());
        }
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
        scope
            .generation
            .ready
            .check_source_schema(&mut tx)
            .await
            .map_err(|_| "stale_revision")?;
        let existing: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM e_source_captures WHERE capture_id=?")
                .bind(&input.capture_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(error)?;
        if existing != 0 {
            let j = self.load(&mut tx, &scope).await?;
            tx.commit().await.map_err(error)?;
            lease.committed = true;
            return Ok(j.receipt(&input.capture_id));
        }
        let content = conversation_content::token_in(&mut tx, &input.conversation_id, None)
            .await
            .map_err(error)?;
        let binding = Binding {
            version: 1,
            conversation: input.conversation_id.clone(),
            generation: scope.generation.ready.catalog_generation.clone(),
            actor: scope.authority.actor.clone(),
            content,
            dependencies: version::token(&mut tx).await.map_err(error)?,
            schema: schema(&mut tx).await?,
            budget: scope.authority.policy.budget,
            max_receipts: scope.authority.policy.max_receipts,
        };
        let global:i64=sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id=? AND scope_mode='Chat' AND task_id IS NULL AND group_id IS NULL AND project_id IS NULL").bind(&binding.conversation).fetch_one(&mut *tx).await.map_err(error)?;
        if global != 1 {
            return Err("source_not_global_chat".into());
        }
        let canonical = serde_json::to_string(&binding).map_err(|_| "validation_failed")?;
        if canonical.len() > CONTROL {
            return Err("resource_limit".into());
        }
        let charge = add(JOURNAL, canonical.len() as i64)?;
        if inactive_budget::journal_count(&mut tx).await? >= binding.max_receipts {
            return Err("resource_limit".into());
        }
        inactive_budget::admit_e(&mut tx, charge, binding.budget, binding.max_receipts).await?;
        let now = (self.clock)();
        let expires = add(now, scope.authority.policy.absolute_ms)?;
        sqlx::query("INSERT INTO e_source_captures(capture_id,binding_json,phase,revision,family,cursor_field,cursor_offset,row_ordinal,fields_count,rows_count,bytes_received,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES(?,?,0,0,0,0,0,0,0,0,0,?,?,?,?,?,?)").bind(&input.capture_id).bind(canonical).bind(charge).bind(now).bind(now).bind(expires).bind(scope.authority.policy.idle_ms).bind(now).execute(&mut *tx).await.map_err(error)?;
        let result = self.load(&mut tx, &scope).await?.receipt(&input.capture_id);
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(result)
    }
    pub async fn status(&self) -> Result<Receipt> {
        let scope = self.scope(false).await?;
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin().await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        let result = j.receipt(&scope.authority.capture_id);
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(result)
    }
    pub async fn abort(&self) -> Result<Receipt> {
        self.terminal(false).await
    }
    pub async fn expire(&self) -> Result<Receipt> {
        self.terminal(true).await
    }
    async fn terminal(&self, expire: bool) -> Result<Receipt> {
        let scope = self.scope(false).await?;
        if scope.authority.mode == Mode::SealedRead {
            return Err("source_capture_disabled".into());
        }
        let mut lease = self.lease(&scope.generation.ready.pool).await?;
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
        let j = self.load(&mut tx, &scope).await?;
        if j.transfer_leased { return Err("connect_transfer_leased".into()); }
        if j.phase == 2 {
            return Err("capture_pinned".into());
        }
        if j.phase < 2 {
            let now = (self.clock)();
            if expire
                && (now < j.last || (now < j.expires && now.saturating_sub(j.progressed) < j.idle))
            {
                return Err("not_expired".into());
            }
            sqlx::query("DELETE FROM e_source_relations WHERE capture_id=?")
                .bind(j.id)
                .execute(&mut *tx)
                .await
                .map_err(error)?;
            sqlx::query("DELETE FROM e_source_fields WHERE capture_id=?")
                .bind(j.id)
                .execute(&mut *tx)
                .await
                .map_err(error)?;
            let binding = serde_json::to_vec(&j.binding).map_err(|_| "database_unavailable")?;
            sqlx::query("UPDATE e_source_captures SET phase=?,revision=revision+1,charge_bytes=?,fields_count=0,rows_count=0,bytes_received=0,cursor_offset=0,manifest_hash=NULL WHERE id=?").bind(if expire{4}else{3}).bind(add(JOURNAL,binding.len() as i64)?).bind(j.id).execute(&mut *tx).await.map_err(error)?;
        }
        let result = self
            .load(&mut tx, &scope)
            .await?
            .receipt(&scope.authority.capture_id);
        tx.commit().await.map_err(error)?;
        lease.committed = true;
        Ok(result)
    }
}
pub(super) async fn schema(db: &mut SqliteConnection) -> Result<i64> {
    sqlx::query_scalar("PRAGMA schema_version")
        .fetch_one(db)
        .await
        .map_err(error)
}
