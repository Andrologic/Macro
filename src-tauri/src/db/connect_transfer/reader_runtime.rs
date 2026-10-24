//! Local read lifetimes. Opaque IDs select native slots; none authenticate F.
use super::{reader, reader_resources as resources, reader_types::*, *};
use crate::{
    config::ConfigManager,
    connect_resources::{WorkingCharge, WorkingLease, WORKING_OWNER},
    core::db_state::{DbPool, DbSourceGuard},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Serialize, Serializer};
use sqlx::Connection;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

const CONTROL_MEMORY: u64 = 16 * 1024;
// Includes bounded SQLite/header copies, base64, escaped IPC JSON, parsed
// renderer strings/containers and the retained native DTO. Not process RSS.
const PAGE_MEMORY: u64 = 8 * 1024 * 1024;
#[derive(Clone)]
enum Position {
    Start,
    Entries(i64),
    Records(reader::Cursor),
    Resources(resources::ResourceCursor),
    Field(i64),
}
struct Previous {
    request: Option<String>,
    before: Position,
    next: Option<String>,
}
struct Progress {
    token: Option<String>,
    position: Option<Position>,
    previous: Option<Previous>,
    limit: Option<u8>,
}
struct Session {
    caller: String,
    page: String,
    epoch: String,
    conversation: String,
    selector: ArchiveSelector,
    binding: Vec<u8>,
    manifest: String,
    working: Arc<WorkingLease>,
    ready: DbSourceGuard,
    progress: tokio::sync::Mutex<Progress>,
    // One selected field per session. Binding is revalidated on every read;
    // the complete digest is proved once, subsequent slices still hash each
    // immutable stored fragment. No history-sized verification index.
    verified: tokio::sync::Mutex<Option<(i64, Vec<u8>)>>,
    #[cfg(test)]
    fragments_read: std::sync::atomic::AtomicUsize,
    closed: AtomicBool,
    _control: WorkingCharge,
    _gate: OwnedRwLockReadGuard<()>,
}
impl Session {
    fn check(&self, caller: &str, page: &str) -> DbResult<()> {
        if self.caller != caller || self.page != page || self.closed.load(Ordering::Acquire) {
            Err(invalid("archive_read_retired"))
        } else {
            Ok(())
        }
    }
}
/// Data drops before its charges and the session/generation it retains.
pub(crate) struct OwnedReply<T> {
    data: T,
    _charges: Vec<WorkingCharge>,
    session: Arc<Session>,
}
pub(crate) struct RetainedReply<T>(Arc<OwnedReply<T>>);
impl<T: Serialize> Serialize for RetainedReply<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.data.serialize(serializer)
    }
}
enum Slot {
    Read(Arc<Session>),
    Page(Arc<OwnedReply<ArchivePage>>),
    Backing(Arc<OwnedReply<ArchiveBacking>>),
}
impl Slot {
    fn session(&self) -> &Arc<Session> {
        match self {
            Self::Read(v) => v,
            Self::Page(v) => &v.session,
            Self::Backing(v) => &v.session,
        }
    }
}
#[derive(Default)]
struct Registry {
    slots: HashMap<String, Slot>,
    epochs: HashMap<String, String>,
}
#[derive(Default)]
pub(crate) struct ArchiveReaderRuntime {
    registry: Mutex<Registry>,
    working: tokio::sync::Mutex<Weak<WorkingLease>>,
    gates: Mutex<HashMap<String, Weak<RwLock<()>>>>,
}
impl ArchiveReaderRuntime {
    fn gate(&self, conversation: &str) -> Arc<RwLock<()>> {
        let mut gates = self.gates.lock().unwrap_or_else(|e| e.into_inner());
        gates.retain(|_, v| v.strong_count() != 0);
        if let Some(v) = gates.get(conversation).and_then(Weak::upgrade) {
            return v;
        }
        let gate = Arc::new(RwLock::new(()));
        gates.insert(conversation.into(), Arc::downgrade(&gate));
        gate
    }
    pub(in crate::db) fn deleting(
        &self,
        conversations: &[String],
    ) -> DbResult<Vec<OwnedRwLockWriteGuard<()>>> {
        conversations
            .iter()
            .map(|id| {
                self.gate(id)
                    .try_write_owned()
                    .map_err(|_| invalid("archive_content_in_use"))
            })
            .collect()
    }
    fn read(&self, id: &str, caller: &str, page: &str) -> DbResult<Arc<Session>> {
        uuid(id)?;
        let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        let Some(Slot::Read(session)) = registry.slots.get(id) else {
            return Err(invalid("archive_read_retired"));
        };
        session.check(caller, page)?;
        Ok(session.clone())
    }
    async fn working(&self, manager: &ConfigManager) -> DbResult<Arc<WorkingLease>> {
        let mut current = self.working.lock().await;
        if let Some(working) = current.upgrade() {
            return Ok(working);
        }
        // Reuse this one admitted state for all reader sessions/backings.
        // Another heavy owner preserves the existing recoverable Busy refusal.
        let working = Arc::new(WORKING_OWNER.admit(manager).await.map_err(|e| {
            invalid(if e == crate::connect_resources::ResourceError::Busy {
                "archive_busy"
            } else {
                "resource_limit"
            })
        })?);
        *current = Arc::downgrade(&working);
        Ok(working)
    }
    fn insert(&self, id: String, slot: Slot) -> DbResult<()> {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if slot.session().closed.load(Ordering::Acquire) {
            return Err(invalid("archive_read_retired"));
        }
        if registry.epochs.get(&slot.session().caller) != Some(&slot.session().epoch) {
            return Err(invalid("archive_read_retired"));
        }
        match registry.slots.entry(id) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(slot);
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err(invalid("archive_handle_collision"))
            }
        }
        Ok(())
    }
    pub(crate) fn retire_caller(&self, caller: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry
            .epochs
            .insert(caller.into(), uuid::Uuid::new_v4().to_string());
        registry.slots.retain(|_, slot| {
            let session = slot.session();
            if session.caller == caller {
                session.closed.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
        // Command/response Arcs keep their backing, charge and DbReady until
        // actual completion even though no slot is now reachable by the page.
    }
    pub(crate) fn release(
        &self,
        caller: &str,
        page: &str,
        input: ArchiveReleaseInput,
    ) -> DbResult<()> {
        uuid(&input.id)?;
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = registry.slots.get(&input.id) {
            if slot.session().caller != caller || slot.session().page != page {
                return Err(invalid("archive_foreign_handle"));
            }
            if let Slot::Read(s) = slot {
                s.closed.store(true, Ordering::Release);
            }
        }
        registry.slots.remove(&input.id);
        Ok(())
    }
    pub(crate) async fn open(
        &self,
        owner: &DbPool,
        manager: &ConfigManager,
        caller: &str,
        page: &str,
        input: ArchiveOpenInput,
    ) -> DbResult<ArchiveReadHandle> {
        uuid(&input.conversation_id)?;
        resources::validate(&input.selector)?;
        // Capture native retirement before the first await. A late opening
        // cannot publish a new slot after its caller's page has retired.
        let epoch = {
            let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            registry
                .epochs
                .entry(caller.into())
                .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone()
        };
        let ready = owner
            .source_ready(None)
            .await
            .map_err(|_| invalid("stale_revision"))?;
        let working = self.working(manager).await?;
        working
            .before_phase()
            .await
            .map_err(|_| invalid("resource_limit"))?;
        let control = working
            .reserve(CONTROL_MEMORY)
            .await
            .map_err(|_| invalid("resource_limit"))?;
        let scratch = working
            .reserve(PAGE_MEMORY)
            .await
            .map_err(|_| invalid("resource_limit"))?;
        let gate = self
            .gate(&input.conversation_id)
            .try_read_owned()
            .map_err(|_| invalid("archive_content_in_use"))?;
        let mut connection = lease(&ready.ready.pool).await?;
        let mut tx = connection.begin().await?;
        ready.ready.check_source_schema(&mut tx).await?;
        let archive = reader::resolve_in(
            &mut tx,
            &ready.ready.catalog_generation,
            &input.conversation_id,
        )
        .await?;
        match &input.selector {
            ArchiveSelector::Entries => {
                reader::entries_in(&mut tx, &archive, &ready.ready.catalog_generation,
                    &input.conversation_id, 0, 1).await?;
            },
            ArchiveSelector::Records { ordinal, uuid: id } => {
                let selector = record_selector(ordinal, id)?;
                reader::page_in(
                    &mut tx,
                    &ready.ready.catalog_generation,
                    &input.conversation_id,
                    selector,
                    None,
                    1,
                )
                .await?;
            }
            ArchiveSelector::Resources { message_id } => {
                resources::resources(&mut tx, &archive, message_id, None, 1).await?;
            }
            _ => {
                resources::resolve_field(&mut tx, &archive, &input.selector).await?;
            }
        }
        tx.commit().await?;
        connection.committed = true;
        drop(connection);
        drop(scratch);
        let id = uuid::Uuid::new_v4().to_string();
        let result = ArchiveReadHandle {
            read_id: id.clone(),
            generation: ready.ready.catalog_generation.clone(),
            conversation_id: input.conversation_id.clone(),
            manifest: archive.manifest.clone(),
        };
        let session = Arc::new(Session {
            caller: caller.into(),
            page: page.into(),
            epoch,
            conversation: input.conversation_id,
            selector: input.selector,
            binding: archive.binding,
            manifest: archive.manifest,
            working,
            ready,
            progress: tokio::sync::Mutex::new(Progress {
                token: None,
                position: Some(Position::Start),
                previous: None,
                limit: None,
            }),
            verified: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            fragments_read: std::sync::atomic::AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            _control: control,
            _gate: gate,
        });
        self.insert(id, Slot::Read(session))?;
        Ok(result)
    }
    pub(crate) async fn page(
        &self,
        caller: &str,
        page: &str,
        input: ArchivePageInput,
    ) -> DbResult<RetainedReply<ArchivePage>> {
        if input.limit == 0 || input.limit > 32 {
            return Err(invalid("invalid_cursor"));
        }
        if let Some(cursor) = &input.cursor_id {
            uuid(cursor)?;
        }
        let session = self.read(&input.read_id, caller, page)?;
        let charge = session
            .working
            .reserve(PAGE_MEMORY)
            .await
            .map_err(|_| invalid("resource_limit"))?;
        let mut progress = session.progress.lock().await;
        if progress.limit.is_some_and(|v| v != input.limit) {
            return Err(invalid("invalid_cursor"));
        }
        let repeated = progress
            .previous
            .as_ref()
            .filter(|p| p.request == input.cursor_id);
        let (before, replay_next) = if let Some(previous) = repeated {
            (previous.before.clone(), Some(previous.next.clone()))
        } else if input.cursor_id == progress.token {
            (
                progress
                    .position
                    .clone()
                    .ok_or_else(|| invalid("archive_eof"))?,
                None,
            )
        } else {
            return Err(invalid("invalid_cursor"));
        };
        let mut connection = lease(&session.ready.ready.pool).await?;
        let mut tx = connection.begin().await?;
        session.ready.ready.check_source_schema(&mut tx).await?;
        let archive = reader::resolve_in(
            &mut tx,
            &session.ready.ready.catalog_generation,
            &session.conversation,
        )
        .await?;
        if archive.binding != session.binding {
            return Err(invalid("stale_revision"));
        }
        let (items, after) = match &session.selector {
            ArchiveSelector::Entries => {
                let start = match before { Position::Start => 0, Position::Entries(v) => v,
                    _ => return Err(invalid("invalid_cursor")) };
                let entries = reader::entries_in(&mut tx, &archive, &session.ready.ready.catalog_generation,
                    &session.conversation, start, input.limit as usize).await?;
                let mut items = Vec::with_capacity(entries.fragments.len());
                for f in entries.fragments {
                    let origin = reader::presentation_in(&mut tx, &archive.transfer, f.record.ordinal).await?;
                    items.push(ArchiveItem::Entry { ordinal: f.record.ordinal.to_string(), target_uuid: f.target_uuid,
                        header_json: serde_json::to_string(&f.record).map_err(|_|invalid("integrity_failed"))?, origin });
                }
                (items, entries.next.as_ref().map(|v| Position::Entries(reader::next_entry(v))))
            },
            ArchiveSelector::Records { ordinal, uuid: id } => {
                let cursor = match &before {
                    Position::Start => None,
                    Position::Records(v) => Some(v),
                    _ => return Err(invalid("invalid_cursor")),
                };
                let data = reader::page_in(
                    &mut tx,
                    &session.ready.ready.catalog_generation,
                    &session.conversation,
                    record_selector(ordinal, id)?,
                    cursor,
                    input.limit as usize,
                )
                .await?;
                let mut items = Vec::with_capacity(data.fragments.len());
                for f in data.fragments {
                    items.push(ArchiveItem::Record {
                        ordinal: f.record.ordinal.to_string(),
                        target_uuid: f.target_uuid,
                        header_json: serde_json::to_string(&f.record)
                            .map_err(|_| invalid("integrity_failed"))?,
                        offset: f.offset.to_string(),
                        sha256: resources::hex(&hash(&f.bytes)),
                        data_base64: STANDARD.encode(f.bytes),
                    });
                }
                (items, data.next.map(Position::Records))
            }
            ArchiveSelector::Resources { message_id } => {
                let cursor = match &before {
                    Position::Start => None,
                    Position::Resources(v) => Some(v),
                    _ => return Err(invalid("invalid_cursor")),
                };
                let (items, next) = resources::resources(
                    &mut tx,
                    &archive,
                    message_id,
                    cursor,
                    input.limit as usize,
                )
                .await?;
                (items, next.map(Position::Resources))
            }
            _ => {
                let offset = match &before {
                    Position::Start => 0,
                    Position::Field(v) => *v,
                    _ => return Err(invalid("invalid_cursor")),
                };
                let field = resources::resolve_field(&mut tx, &archive, &session.selector).await?;
                let (items, next) =
                    resources::fragments(&mut tx, &archive, &field, offset, input.limit as usize)
                        .await?;
                (items, next.map(Position::Field))
            }
        };
        session.check(caller, page)?;
        tx.commit().await?;
        connection.committed = true;
        let next =
            replay_next.unwrap_or_else(|| after.as_ref().map(|_| uuid::Uuid::new_v4().to_string()));
        let id = uuid::Uuid::new_v4().to_string();
        let reply = Arc::new(OwnedReply {
            data: ArchivePage {
                page_id: id.clone(),
                items,
                next_cursor_id: next.clone(),
            },
            _charges: vec![charge],
            session: session.clone(),
        });
        self.insert(id, Slot::Page(reply.clone()))?;
        if repeated.is_none() {
            progress.previous = Some(Previous {
                request: input.cursor_id,
                before,
                next: next.clone(),
            });
            progress.token = next;
            progress.position = after;
            progress.limit = Some(input.limit);
        }
        Ok(RetainedReply(reply))
    }
    pub(crate) async fn materialize(
        &self,
        caller: &str,
        page: &str,
        input: ArchiveMaterializeInput,
    ) -> DbResult<RetainedReply<ArchiveBacking>> {
        uuid(&input.resource_uuid)?;
        let session = self.read(&input.read_id, caller, page)?;
        session
            .working
            .before_phase()
            .await
            .map_err(|_| invalid("resource_limit"))?;
        let scratch = session
            .working
            .reserve(PAGE_MEMORY)
            .await
            .map_err(|_| invalid("resource_limit"))?;
        // Declared before SQLite so cancellation closes its worker before any
        // of these reservations or the generation/session can be released.
        let mut charges = vec![scratch];
        let mut connection = lease(&session.ready.ready.pool).await?;
        let mut tx = connection.begin().await?;
        session.ready.ready.check_source_schema(&mut tx).await?;
        let archive = reader::resolve_in(
            &mut tx,
            &session.ready.ready.catalog_generation,
            &session.conversation,
        )
        .await?;
        if archive.binding != session.binding {
            return Err(invalid("stale_revision"));
        }
        let field = resources::resolve_field(&mut tx, &archive, &session.selector).await?;
        if field.descriptor.uuid != input.resource_uuid {
            return Err(invalid("archive_foreign_resource"));
        }
        let (start, end) = if let Some(range) = input.range {
            (
                resources::decimal(&range.start)?,
                resources::decimal(&range.end)?,
            )
        } else {
            (0, field.bytes)
        };
        if start > end || end > field.bytes {
            return Err(invalid("invalid_cursor"));
        }
        if input.r#use == ArchiveUse::Image && (start != 0 || end != field.bytes) {
            return Err(invalid("archive_partial_image"));
        }
        let length = u64::try_from(end - start).map_err(|_| invalid("resource_limit"))?;
        let memory = length
            .checked_mul(32)
            .and_then(|v| v.checked_add(1024 * 1024))
            .ok_or_else(|| invalid("resource_limit"))?;
        charges.push(
            session
                .working
                .reserve(memory)
                .await
                .map_err(|_| invalid("resource_limit"))?,
        );
        let capacity = usize::try_from(length).map_err(|_| invalid("resource_limit"))?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(capacity)
            .map_err(|_| invalid("resource_limit"))?;
        let mut verified = session.verified.lock().await;
        let complete_verification = verified.as_ref() != Some(&(field.bytes, field.digest.clone()));
        let mut offset = if complete_verification || start == end {
            0
        } else {
            resources::covering_offset(&mut tx, &archive, &field, start).await?
        };
        let mut digest = Sha256::new();
        let mut fragments = 0;
        if field.record && field.bytes == 0 {
            let empty = resources::fragment(&mut tx, &archive, &field, 0).await?;
            if !empty.is_empty() {
                return Err(invalid("integrity_failed"));
            }
        }
        let stop = if complete_verification { field.bytes } else { end };
        while offset < stop {
            let fragment = resources::fragment(&mut tx, &archive, &field, offset).await?;
            #[cfg(test)]
            session.fragments_read.fetch_add(1, Ordering::Relaxed);
            let next = add(offset, fragment.len() as i64)?;
            if complete_verification { digest.update(&fragment); }
            let left = start.max(offset);
            let right = end.min(next);
            if left < right {
                bytes.extend_from_slice(
                    &fragment[(left - offset) as usize..(right - offset) as usize],
                );
            }
            offset = next;
            fragments += 1;
            if fragments % 32 == 0 {
                session.check(caller, page)?;
                session
                    .working
                    .before_phase()
                    .await
                    .map_err(|_| invalid("resource_limit"))?;
            }
        }
        if (complete_verification && digest.finalize().as_slice() != field.digest) || bytes.len() != capacity {
            return Err(invalid("integrity_failed"));
        }
        let (text, image, width, height) = if input.r#use == ArchiveUse::Image {
            let mime = field
                .descriptor
                .mime_type
                .as_deref()
                .ok_or_else(|| invalid("archive_not_image"))?;
            let (w, h) = crate::db::pilot_files::archive_image_dimensions(mime, &bytes)
                .map_err(|_| invalid("integrity_failed"))?;
            let decoded = u64::from(w)
                .checked_mul(u64::from(h))
                .and_then(|v| v.checked_mul(4 * 3))
                .ok_or_else(|| invalid("resource_limit"))?;
            charges.push(
                session
                    .working
                    .reserve(decoded)
                    .await
                    .map_err(|_| invalid("resource_limit"))?,
            );
            crate::db::pilot_files::validate_archive_image(mime, &bytes)
                .map_err(|_| invalid("integrity_failed"))?;
            (
                None,
                Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes))),
                Some(w),
                Some(h),
            )
        } else {
            if field
                .descriptor
                .mime_type
                .as_deref()
                .is_some_and(|m| m.starts_with("image/"))
            {
                return Err(invalid("archive_not_text"));
            }
            // A split UTF-8 code point is an explicit range error, never replaced.
            (
                Some(String::from_utf8(bytes).map_err(|_| invalid("archive_invalid_utf8_range"))?),
                None,
                None,
                None,
            )
        };
        session.check(caller, page)?;
        tx.commit().await?;
        connection.committed = true;
        *verified = Some((field.bytes, field.digest.clone()));
        let id = uuid::Uuid::new_v4().to_string();
        let reply = Arc::new(OwnedReply {
            data: ArchiveBacking {
                backing_id: id.clone(),
                conversation_id: session.conversation.clone(),
                manifest: session.manifest.clone(),
                resource: field.descriptor,
                start: start.to_string(),
                end: end.to_string(),
                complete: start == 0 && end == field.bytes,
                text,
                ready_data_url: image,
                width,
                height,
            },
            _charges: charges,
            session: session.clone(),
        });
        self.insert(id, Slot::Backing(reply.clone()))?;
        Ok(RetainedReply(reply))
    }
}
fn record_selector<'a>(
    ordinal: &Option<String>,
    id: &'a Option<String>,
) -> DbResult<reader::Selector<'a>> {
    Ok(if let Some(v) = ordinal {
        reader::Selector::Ordinal(resources::decimal(v)?)
    } else if let Some(id) = id {
        reader::Selector::Uuid(id)
    } else {
        reader::Selector::All
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    #[tokio::test]
    async fn connect_archive_native_runtime_keeps_real_backings_until_last_consumer_and_preserves_selection(
    ) {
        let (dir, pool, conversation) =
            super::super::preparation::tests::published_reader_fixture().await;
        let owner = DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        let manager = ConfigManager::initialize(dir.path().join("reader-config"))
            .await
            .unwrap();
        let runtime = ArchiveReaderRuntime::default();
        let open = |selector| ArchiveOpenInput {
            conversation_id: conversation.clone(),
            selector,
        };
        let catalog = runtime.open(&owner, &manager, "window", "page", open(ArchiveSelector::Entries)).await.unwrap();
        let expected: i64 = sqlx::query_scalar("SELECT next_record FROM e_inactive_imports LIMIT 1").fetch_one(&pool).await.unwrap();
        let mut cursor = None;
        let mut count = 0;
        let mut calls = 0;
        loop {
            let reply = runtime.page("window", "page", ArchivePageInput {
                read_id: catalog.read_id.clone(), cursor_id: cursor, limit: 2,
            }).await.unwrap();
            calls += 1;
            for item in &reply.0.data.items {
                let ArchiveItem::Entry { ordinal, origin, .. } = item else { panic!("catalog must not return payload fragments"); };
                assert_eq!(ordinal, &count.to_string());
                if let Some(origin) = origin { assert_eq!(origin.source_ordinal.as_deref(), Some(ordinal.as_str())); }
                count += 1;
            }
            cursor = reply.0.data.next_cursor_id.clone();
            runtime.release("window", "page", ArchiveReleaseInput { id: reply.0.data.page_id.clone() }).unwrap();
            if cursor.is_none() { break; }
        }
        assert_eq!(count, expected);
        assert_eq!(calls, (expected + 1) / 2, "long records and empty associations consume one catalog entry each");
        runtime.release("window", "page", ArchiveReleaseInput { id: catalog.read_id }).unwrap();
        let read = runtime
            .open(
                &owner,
                &manager,
                "window",
                "page",
                open(ArchiveSelector::Records {
                    ordinal: None,
                    uuid: None,
                }),
            )
            .await
            .unwrap();
        assert!(runtime
            .page(
                "foreign",
                "page",
                ArchivePageInput {
                    read_id: read.read_id.clone(),
                    cursor_id: None,
                    limit: 32
                }
            )
            .await
            .is_err());
        let first = runtime
            .page(
                "window",
                "page",
                ArchivePageInput {
                    read_id: read.read_id.clone(),
                    cursor_id: None,
                    limit: 32,
                },
            )
            .await
            .unwrap();
        assert!(first.0.data.next_cursor_id.is_some());
        let next = first.0.data.next_cursor_id.clone();
        let repeated = runtime
            .page(
                "window",
                "page",
                ArchivePageInput {
                    read_id: read.read_id.clone(),
                    cursor_id: None,
                    limit: 32,
                },
            )
            .await
            .unwrap();
        assert_eq!(repeated.0.data.next_cursor_id, next);
        assert_eq!(
            serde_json::to_value(&first).unwrap()["items"],
            serde_json::to_value(&repeated).unwrap()["items"]
        );
        let selected = runtime
            .open(
                &owner,
                &manager,
                "window",
                "page",
                open(ArchiveSelector::Records {
                    ordinal: Some("0".into()),
                    uuid: None,
                }),
            )
            .await
            .unwrap();
        assert!(runtime
            .page(
                "window",
                "page",
                ArchivePageInput {
                    read_id: selected.read_id.clone(),
                    cursor_id: next.clone(),
                    limit: 32
                }
            )
            .await
            .is_err());
        runtime
            .release(
                "window",
                "page",
                ArchiveReleaseInput {
                    id: selected.read_id,
                },
            )
            .unwrap();
        for reply in [&first, &repeated] {
            runtime
                .release(
                    "window",
                    "page",
                    ArchiveReleaseInput {
                        id: reply.0.data.page_id.clone(),
                    },
                )
                .unwrap();
        }
        drop(first);
        drop(repeated);
        let mut cursor = next;
        let mut associations = 0;
        loop {
            let reply = runtime
                .page(
                    "window",
                    "page",
                    ArchivePageInput {
                        read_id: read.read_id.clone(),
                        cursor_id: cursor.clone(),
                        limit: 32,
                    },
                )
                .await
                .unwrap();
            for item in &reply.0.data.items {
                if let ArchiveItem::Record {
                    header_json,
                    data_base64,
                    ..
                } = item
                {
                    if header_json.contains("association") {
                        associations += 1;
                        assert_eq!(data_base64, "");
                    }
                }
            }
            cursor = reply.0.data.next_cursor_id.clone();
            runtime
                .release(
                    "window",
                    "page",
                    ArchiveReleaseInput {
                        id: reply.0.data.page_id.clone(),
                    },
                )
                .unwrap();
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(associations, 1);
        runtime
            .release("window", "page", ArchiveReleaseInput { id: read.read_id })
            .unwrap();
        let messages =
            sqlx::query("SELECT id,role FROM messages WHERE conversation_id=? ORDER BY role")
                .bind(&conversation)
                .fetch_all(&pool)
                .await
                .unwrap();
        let user = messages
            .iter()
            .find(|r| r.get::<String, _>("role") == "user")
            .unwrap()
            .get::<String, _>("id");
        let assistant = messages
            .iter()
            .find(|r| r.get::<String, _>("role") == "assistant")
            .unwrap()
            .get::<String, _>("id");
        let catalog = runtime
            .open(
                &owner,
                &manager,
                "window",
                "page",
                open(ArchiveSelector::Resources { message_id: user }),
            )
            .await
            .unwrap();
        let mut cursor = None;
        let mut descriptors = Vec::new();
        loop {
            let reply = runtime
                .page(
                    "window",
                    "page",
                    ArchivePageInput {
                        read_id: catalog.read_id.clone(),
                        cursor_id: cursor.clone(),
                        limit: 1,
                    },
                )
                .await
                .unwrap();
            for item in &reply.0.data.items {
                if let ArchiveItem::Resource { resource } = item {
                    descriptors.push(resource.clone());
                }
            }
            cursor = reply.0.data.next_cursor_id.clone();
            runtime
                .release(
                    "window",
                    "page",
                    ArchiveReleaseInput {
                        id: reply.0.data.page_id.clone(),
                    },
                )
                .unwrap();
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(descriptors.len(), 4);
        assert_eq!(descriptors[0].kind, "asset");
        assert_eq!(descriptors[0].position, "0");
        runtime
            .release(
                "window",
                "page",
                ArchiveReleaseInput {
                    id: catalog.read_id,
                },
            )
            .unwrap();
        let body = runtime
            .open(
                &owner,
                &manager,
                "window",
                "page",
                open(ArchiveSelector::Body {
                    message_id: assistant.clone(),
                }),
            )
            .await
            .unwrap();
        // This endpoint intentionally intersects the UTF-8 é of 'café'.
        let value = sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id=?")
            .bind(&assistant)
            .fetch_one(&pool)
            .await
            .unwrap();
        let split = value.find('é').unwrap() + 1;
        assert!(runtime
            .materialize(
                "window",
                "page",
                ArchiveMaterializeInput {
                    read_id: body.read_id.clone(),
                    resource_uuid: assistant.clone(),
                    r#use: ArchiveUse::ContextText,
                    range: Some(ArchiveRange {
                        start: "0".into(),
                        end: split.to_string()
                    })
                }
            )
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("utf8"));
        let text = runtime
            .materialize(
                "window",
                "page",
                ArchiveMaterializeInput {
                    read_id: body.read_id.clone(),
                    resource_uuid: assistant.clone(),
                    r#use: ArchiveUse::ContextText,
                    range: Some(ArchiveRange {
                        start: "0".into(),
                        end: (split + 1).to_string(),
                    }),
                },
            )
            .await
            .unwrap();
        assert!(!text.0.data.complete);
        assert!(text.0.data.text.as_ref().unwrap().ends_with('é'));
        let selected = runtime.read(&body.read_id, "window", "page").unwrap();
        let checked = selected.fragments_read.load(Ordering::Relaxed);
        assert!(checked > 8, "first slices really verify the entire long field");
        // Later display pages read only the indexed covering fragments. The
        // same manifest/revision/selector has already passed its full digest.
        for start in [0, value.rfind("recoveryneedle").unwrap()] {
            let end = start + 9;
            let before = selected.fragments_read.load(Ordering::Relaxed);
            let slice = runtime.materialize("window", "page", ArchiveMaterializeInput {
                read_id: body.read_id.clone(), resource_uuid: assistant.clone(),
                r#use: ArchiveUse::RenderText,
                range: Some(ArchiveRange { start: start.to_string(), end: end.to_string() }),
            }).await.unwrap();
            assert_eq!(slice.0.data.text.as_deref(), Some(&value[start..end]));
            assert!(selected.fragments_read.load(Ordering::Relaxed) - before <= 2);
            runtime.release("window", "page", ArchiveReleaseInput { id: slice.0.data.backing_id.clone() }).unwrap();
        }
        drop(selected);
        runtime
            .release(
                "window",
                "page",
                ArchiveReleaseInput {
                    id: text.0.data.backing_id.clone(),
                },
            )
            .unwrap();
        drop(text);
        runtime
            .release("window", "page", ArchiveReleaseInput { id: body.read_id })
            .unwrap();
        let asset = &descriptors[0];
        let image = runtime
            .open(
                &owner,
                &manager,
                "window",
                "page",
                open(ArchiveSelector::Asset {
                    asset_id: asset.uuid.clone(),
                }),
            )
            .await
            .unwrap();
        assert!(runtime
            .materialize(
                "window",
                "page",
                ArchiveMaterializeInput {
                    read_id: image.read_id.clone(),
                    resource_uuid: asset.uuid.clone(),
                    r#use: ArchiveUse::Image,
                    range: Some(ArchiveRange {
                        start: "0".into(),
                        end: "1".into()
                    })
                }
            )
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("partial_image"));
        let backing = runtime
            .materialize(
                "window",
                "page",
                ArchiveMaterializeInput {
                    read_id: image.read_id.clone(),
                    resource_uuid: asset.uuid.clone(),
                    r#use: ArchiveUse::Image,
                    range: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            (backing.0.data.width, backing.0.data.height),
            (Some(32), Some(32))
        );
        assert!(backing
            .0
            .data
            .ready_data_url
            .as_ref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        runtime
            .release("window", "page", ArchiveReleaseInput { id: image.read_id })
            .unwrap();
        runtime
            .release(
                "window",
                "page",
                ArchiveReleaseInput {
                    id: backing.0.data.backing_id.clone(),
                },
            )
            .unwrap();
        assert!(runtime.deleting(&[conversation.clone()]).is_err());
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(20),
            owner.set_initializing()
        )
        .await
        .is_err());
        // Registry slots are gone, but the actual command/response still owns
        // the native backing and generation. Drop it before returning credit.
        drop(backing);
        assert!(runtime.deleting(&[conversation.clone()]).is_ok());
        owner.set_initializing().await;
        owner.set_ready(pool.clone()).await.unwrap();
        let fresh = runtime
            .open(
                &owner,
                &manager,
                "window",
                "new-page",
                open(ArchiveSelector::Records {
                    ordinal: None,
                    uuid: None,
                }),
            )
            .await
            .unwrap();
        runtime.retire_caller("window");
        assert!(runtime
            .page(
                "window",
                "new-page",
                ArchivePageInput {
                    read_id: fresh.read_id,
                    cursor_id: None,
                    limit: 1
                }
            )
            .await
            .is_err());
        crate::db::repository::delete_conversations_with_readers(&owner, &[conversation], &runtime)
            .await
            .unwrap();
    }
}
