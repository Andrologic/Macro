use super::command_error::{CommandError, CommandResult};
use super::error::BackendError;
use sqlx::SqlitePool;
use tokio::sync::watch;
use tokio::time::{timeout, Duration};

const DB_INIT_WAIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub enum DbInitializationState {
    Initializing,
    Ready(SqlitePool),
    Failed(String),
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
        self.state.send_replace(DbInitializationState::Ready(pool));
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
            DbInitializationState::Ready(pool) => Some(pool),
            DbInitializationState::Initializing | DbInitializationState::Failed(_) => None,
        }
    }

    pub(crate) async fn wait_until_ready(&self) -> CommandResult<SqlitePool> {
        let mut receiver = self.state.subscribe();
        let wait = async {
            loop {
                match receiver.borrow().clone() {
                    DbInitializationState::Ready(pool) => return Ok(pool),
                    DbInitializationState::Failed(message) => {
                        return Err(database_error(format!(
                            "Database initialization failed: {message}"
                        )))
                    }
                    DbInitializationState::Initializing => {}
                }

                receiver.changed().await.map_err(|_| {
                    database_error("Database initialization state channel closed unexpectedly.")
                })?;
            }
        };

        timeout(DB_INIT_WAIT_TIMEOUT, wait).await.map_err(|_| {
            database_error("Database is still initializing. Please retry in a moment.")
        })?
    }
}

fn database_error(message: impl Into<String>) -> CommandError {
    let message = message.into();
    CommandError::from(BackendError::Database {
        message: message.clone(),
    })
    .with_message(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initialization_failure_keeps_its_database_code_and_message() {
        let pool = DbPool::default();
        pool.set_failed("storage unavailable");
        let error = pool.wait_until_ready().await.unwrap_err();
        assert_eq!(error.code(), Some("Database"));
        assert_eq!(
            error.message,
            "Database initialization failed: storage unavailable"
        );
    }
}
