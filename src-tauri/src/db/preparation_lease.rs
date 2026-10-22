use sqlx::Sqlite;
use std::sync::Arc;
// SQLite may auto-rollback while SQLx retains depth1; a sent BEGIN may
// conversely still report depth0. Only an acknowledged COMMIT is reusable.
// The native pool has min_connections=0 and optimize_on_close disabled.
pub(super) struct Lease {
    pub(super) connection: Option<sqlx::pool::PoolConnection<Sqlite>>,
    pub(super) committed: bool,
    #[cfg(test)]
    pub(super) cleanup_started: Option<std::sync::mpsc::Sender<()>>,
}
impl std::ops::Deref for Lease {
    type Target = sqlx::SqliteConnection;
    fn deref(&self) -> &Self::Target {
        self.connection.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for Lease {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection.as_mut().unwrap()
    }
}
struct CloseWake(std::thread::Thread);
impl std::task::Wake for CloseWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.committed {
            // ponytail: abandonment blocks this thread until the native worker
            // closes; normal composition is disabled, not a UI latency promise.
            // This polls only SQLx close, without a runtime/nested executor or
            // timeout that could release the earlier authority guard too soon.
            let Some(connection) = self.connection.take() else {
                return;
            };
            let waker = std::task::Waker::from(Arc::new(CloseWake(std::thread::current())));
            let mut context = std::task::Context::from_waker(&waker);
            let mut close = Box::pin(connection.close());
            while std::future::Future::poll(close.as_mut(), &mut context).is_pending() {
                #[cfg(test)]
                if let Some(observer) = self.cleanup_started.take() {
                    let _ = observer.send(());
                }
                std::thread::park();
            }
        }
    }
}

impl Lease {
    pub(super) fn new(connection: sqlx::pool::PoolConnection<Sqlite>) -> Self {
        Self {
            connection: Some(connection),
            committed: false,
            #[cfg(test)]
            cleanup_started: None,
        }
    }
}

#[cfg(test)]
#[path = "preparation_lease_test_pause.rs"]
pub(crate) mod test_pause;
