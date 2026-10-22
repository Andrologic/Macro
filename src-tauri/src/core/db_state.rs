use super::command_error::{command_error, CommandResult};
use sqlx::SqlitePool;
use tokio::sync::watch;
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
}

#[derive(Clone, Debug)]
pub struct DbPool {
    state: watch::Sender<DbInitializationState>,
}

impl Default for DbPool {
    fn default() -> Self {
        let (state, _) = watch::channel(DbInitializationState::Initializing);
        Self { state }
    }
}

impl DbPool {
    pub fn set_initializing(&self) {
        self.state.send_replace(DbInitializationState::Initializing);
    }

    pub fn set_ready(&self, pool: SqlitePool) {
        self.state
            .send_replace(DbInitializationState::Ready(DbReady {
                pool,
                catalog_generation: uuid::Uuid::new_v4().simple().to_string(),
            }));
    }

    pub fn set_failed(&self, message: impl Into<String>) {
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
