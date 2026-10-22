use super::command_error::{command_error, CommandResult};
use sqlx::SqlitePool;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{watch, OwnedRwLockReadGuard, RwLock};
use tokio::time::{timeout, Duration};

const DB_INIT_WAIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub enum DbInitializationState {
    Initializing,
    Ready(DbReady),
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct DbReady {
    pub pool: SqlitePool,
    pub(crate) catalog_generation: String,
    source_opening: crate::db::ValidatedSourceOpening,
    chat_work: Arc<AtomicUsize>,
}

// A process-local lifetime fence, never a transfer permission or a substitute
// for the SQLite journal. A task owns this value until its physical cleanup ends.
pub(crate) struct ChatWorkLifetime(Arc<AtomicUsize>);
impl Drop for ChatWorkLifetime {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DbReady {
    pub(crate) fn retain_chat_work(&self) -> ChatWorkLifetime {
        self.chat_work.fetch_add(1, Ordering::AcqRel);
        ChatWorkLifetime(self.chat_work.clone())
    }
    pub(crate) async fn check_source_schema(
        &self,
        db: &mut sqlx::SqliteConnection,
    ) -> crate::db::DbResult<()> {
        self.source_opening.check(db).await
    }
}

#[derive(Clone, Debug)]
pub struct DbPool {
    state: watch::Sender<DbInitializationState>,
    source_gate: Arc<RwLock<()>>,
    // Revocation stops new work but must not forget work from that generation.
    last_published: Arc<RwLock<Option<DbReady>>>,
    #[cfg(test)]
    pub(crate) opening_cleanup_started: Option<std::sync::mpsc::Sender<()>>,
}

impl Default for DbPool {
    fn default() -> Self {
        let (state, _) = watch::channel(DbInitializationState::Initializing);
        Self {
            state,
            source_gate: Arc::new(RwLock::new(())),
            last_published: Arc::new(RwLock::new(None)),
            #[cfg(test)]
            opening_cleanup_started: None,
        }
    }
}

impl DbPool {
    pub async fn set_initializing(&self) {
        let _gate = self.source_gate.write().await;
        self.state.send_replace(DbInitializationState::Initializing);
    }

    pub async fn set_ready(&self, pool: SqlitePool) -> CommandResult<()> {
        let _gate = self.source_gate.write().await;
        if let Some(previous) = self.last_published.read().await.clone() {
            if previous.chat_work.load(Ordering::Acquire) != 0 {
                return Err(command_error("chat_admission_generation_busy"));
            }
        }
        // Retire the previous generation before waiting for a connection. An
        // abandoned validation cannot leave its predecessor advertised Ready.
        self.state.send_replace(DbInitializationState::Initializing);
        let source_opening = match crate::db::validate_source_opening(
            &pool,
            #[cfg(test)]
            self.opening_cleanup_started.clone(),
        )
        .await
        {
            Ok(opening) => opening,
            Err(_) => {
                let message = "Database schema validation failed";
                self.state
                    .send_replace(DbInitializationState::Failed(message.into()));
                return Err(command_error(message));
            }
        };
        let ready = DbReady {
            pool,
            catalog_generation: uuid::Uuid::new_v4().simple().to_string(),
            source_opening,
            chat_work: Arc::new(AtomicUsize::new(0)),
        };
        *self.last_published.write().await = Some(ready.clone());
        self.state.send_replace(DbInitializationState::Ready(ready));
        Ok(())
    }

    pub async fn set_failed(&self, message: impl Into<String>) {
        let _gate = self.source_gate.write().await;
        self.state
            .send_replace(DbInitializationState::Failed(message.into()));
    }

    pub fn current(&self) -> DbInitializationState {
        self.state.borrow().clone()
    }

    pub fn ready_pool(&self) -> Option<SqlitePool> {
        match self.current() {
            DbInitializationState::Ready(ready) => Some(ready.pool),
            DbInitializationState::Initializing | DbInitializationState::Failed(_) => None,
        }
    }

    pub(crate) fn catalog_is_current(&self, ready: &DbReady) -> bool {
        matches!(self.current(), DbInitializationState::Ready(current)
            if current.catalog_generation == ready.catalog_generation)
    }

    /// Source mutations alone borrow this generation gate. C2's read checks
    /// remain observational and do not grant a mutation permit.
    pub(crate) async fn source_ready(
        &self,
        expected: Option<&str>,
    ) -> CommandResult<DbSourceGuard> {
        // Never hold the gate while waiting: Ready publication needs its writer.
        let ready = self.wait_until_ready_context().await?;
        let gate = self.source_gate.clone().read_owned().await;
        if !self.catalog_is_current(&ready)
            || expected.is_some_and(|value| value != ready.catalog_generation)
        {
            return Err(command_error("stale_revision"));
        }
        Ok(DbSourceGuard { ready, _gate: gate })
    }

    pub(crate) async fn wait_until_ready(&self) -> CommandResult<SqlitePool> {
        Ok(self.wait_until_ready_context().await?.pool)
    }

    pub(crate) async fn wait_until_ready_context(&self) -> CommandResult<DbReady> {
        let mut receiver = self.state.subscribe();
        let wait = async {
            loop {
                match receiver.borrow().clone() {
                    DbInitializationState::Ready(pool) => return Ok(pool),
                    DbInitializationState::Failed(message) => {
                        return Err(command_error(format!(
                            "Database initialization failed: {message}"
                        )))
                    }
                    DbInitializationState::Initializing => {}
                }

                receiver.changed().await.map_err(|_| {
                    command_error("Database initialization state channel closed unexpectedly.")
                })?;
            }
        };

        timeout(DB_INIT_WAIT_TIMEOUT, wait).await.map_err(|_| {
            command_error("Database is still initializing. Please retry in a moment.")
        })?
    }
}

/// The source owner declares this before authority and SQLite lease so native
/// cleanup finishes before either lifetime permit is released.
pub(crate) struct DbSourceGuard {
    pub ready: DbReady,
    _gate: OwnedRwLockReadGuard<()>,
}

#[cfg(test)]
mod source_gate_tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };
    async fn pending<T>(future: std::pin::Pin<&mut impl Future<Output = T>>) {
        let mut future = future;
        assert!(poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx).is_pending())).await);
    }
    #[tokio::test]
    async fn initializing_wait_does_not_hold_ready_writer_gate() {
        let owner = DbPool::default();
        let request = owner.source_ready(None);
        tokio::pin!(request);
        pending(request.as_mut()).await;
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&directory.path().join("gate.db"))
            .await
            .unwrap();
        owner.set_ready(pool).await.unwrap();
        let guard = request.await.unwrap();
        assert!(owner.catalog_is_current(&guard.ready));
    }
    #[tokio::test]
    async fn source_permit_defers_each_transition_and_rejects_old_generation() {
        for mode in 0..3 {
            let owner = DbPool::default();
            let directory = tempfile::tempdir().unwrap();
            let pool = crate::db::create_pool(&directory.path().join("gate.db"))
                .await
                .unwrap();
            owner.set_ready(pool.clone()).await.unwrap();
            let guard = owner.source_ready(None).await.unwrap();
            let old = guard.ready.catalog_generation.clone();
            let transition = async {
                match mode {
                    0 => owner.set_ready(pool.clone()).await.unwrap(),
                    1 => owner.set_initializing().await,
                    _ => owner.set_failed("synthetic").await,
                }
            };
            tokio::pin!(transition);
            pending(transition.as_mut()).await;
            assert!(owner.catalog_is_current(&guard.ready));
            drop(guard);
            transition.await;
            if mode != 0 {
                owner.set_ready(pool.clone()).await.unwrap();
            }
            assert!(owner.source_ready(Some(&old)).await.is_err());
            let fresh = owner.source_ready(None).await.unwrap();
            assert_ne!(old, fresh.ready.catalog_generation);
        }
    }
}
