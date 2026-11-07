//! Blocking secret calls retain their join even when their async caller disappears.
use super::SecretError;
use futures::{future::BoxFuture, FutureExt};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

type Join = futures::future::Shared<BoxFuture<'static, bool>>;
#[derive(Default)]
struct State {
    closed: bool,
    failed: bool,
    next: u64,
    joins: BTreeMap<u64, Join>,
}
#[derive(Default)]
struct Jobs(Mutex<State>);
static JOBS: LazyLock<Jobs> = LazyLock::new(Jobs::default);

// Only secret workers inherit these owners. Dropping the caller still cancels
// its network/SQL future; an already admitted blocking effect retains the real
// business guards until it returns or unwinds. Nested scopes retain both owners.
tokio::task_local! {
    static BUSINESS_GUARDS: Vec<std::sync::Arc<dyn Send + Sync>>;
}

pub(crate) async fn with_guard<G: Send + Sync + 'static, T>(
    guard: G,
    operation: impl std::future::Future<Output = T>,
) -> T {
    let mut guards = BUSINESS_GUARDS.try_with(Clone::clone).unwrap_or_default();
    guards.push(std::sync::Arc::new(guard));
    BUSINESS_GUARDS.scope(guards, operation).await
}

impl Jobs {
    fn start<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> T + Send + 'static,
    ) -> Result<(u64, Join, tokio::sync::oneshot::Receiver<T>), SecretError> {
        let mut state = self.0.lock().map_err(|_| SecretError::PolicyUnavailable)?;
        if state.closed {
            return Err(SecretError::PolicyUnavailable);
        }
        // Poll only finished joins. An unpolled shared future still owns its handle.
        let mut failed = false;
        state
            .joins
            .retain(|_, join| match join.clone().now_or_never() {
                None => true,
                Some(success) => {
                    failed |= !success;
                    false
                }
            });
        state.failed |= failed;
        let id = state.next;
        state.next = id.checked_add(1).ok_or(SecretError::PolicyUnavailable)?;
        let (send, receive) = tokio::sync::oneshot::channel();
        let guards = BUSINESS_GUARDS.try_with(Clone::clone).unwrap_or_default();
        let handle = tauri::async_runtime::spawn_blocking(move || {
            let _guards = guards;
            let value = operation();
            let _ = send.send(value);
        });
        let join = async move { handle.await.is_ok() }.boxed().shared();
        state.joins.insert(id, join.clone());
        Ok((id, join, receive))
    }

    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, SecretError> {
        let (id, join, receive) = self.start(operation)?;
        let result = receive.await;
        let joined = join.await;
        self.finished(id, joined)?;
        if !joined {
            return Err(SecretError::PolicyUnavailable);
        }
        result.map_err(|_| SecretError::PolicyUnavailable)
    }

    fn finished(&self, id: u64, success: bool) -> Result<(), SecretError> {
        let mut state = self.0.lock().map_err(|_| SecretError::PolicyUnavailable)?;
        state.failed |= !success;
        state.joins.remove(&id);
        Ok(())
    }

    async fn close_and_join(&self) -> Result<(), SecretError> {
        {
            let mut state = self.0.lock().map_err(|_| SecretError::PolicyUnavailable)?;
            state.closed = true;
        }
        loop {
            let next = self
                .0
                .lock()
                .map_err(|_| SecretError::PolicyUnavailable)?
                .joins
                .first_key_value()
                .map(|(id, join)| (*id, join.clone()));
            let Some((id, join)) = next else { break };
            // Keep the original in the owner if this shutdown future is cancelled.
            self.finished(id, join.await)?;
        }
        if !self
            .0
            .lock()
            .map_err(|_| SecretError::PolicyUnavailable)?
            .failed
        {
            Ok(())
        } else {
            Err(SecretError::PolicyUnavailable)
        }
    }
}

pub(crate) async fn run<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SecretError> {
    JOBS.run(operation).await
}

/// Lifecycle operations have no async caller; the same owner retains their joins.
pub(crate) fn submit(operation: impl FnOnce() + Send + 'static) -> Result<(), SecretError> {
    JOBS.start(operation).map(|_| ())
}

/// A lifecycle caller can join its specific operation without closing other jobs.
#[derive(Clone)]
pub(crate) struct Completion(futures::future::Shared<BoxFuture<'static, bool>>);
impl Completion {
    pub(crate) fn wait(&self) -> bool {
        futures::executor::block_on(self.0.clone())
    }
    pub(crate) fn completed(&self) -> bool {
        self.0.clone().now_or_never().is_some()
    }
}
pub(crate) fn submit_joined(
    operation: impl FnOnce() -> Result<(), SecretError> + Send + 'static,
) -> Result<Completion, SecretError> {
    let (id, join, receive) = JOBS.start(operation)?;
    Ok(Completion(
        async move {
            let result = receive.await;
            let joined = join.await;
            let recorded = JOBS.finished(id, joined).is_ok();
            joined && recorded && matches!(result, Ok(Ok(())))
        }
        .boxed()
        .shared(),
    ))
}

pub(crate) async fn shutdown() -> Result<(), SecretError> {
    JOBS.close_and_join().await
}

#[cfg(test)]
pub(crate) async fn join_test_jobs() {
    let jobs: Vec<_> = JOBS
        .0
        .lock()
        .unwrap()
        .joins
        .iter()
        .map(|(id, join)| (*id, join.clone()))
        .collect();
    for (id, join) in jobs {
        let success = join.await;
        JOBS.finished(id, success).unwrap();
        assert!(success);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_caller_retains_join_and_does_not_block_the_runtime() {
        let jobs = Arc::new(Jobs::default());
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let caller = {
            let jobs = jobs.clone();
            tokio::spawn(async move {
                jobs.run(move || {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                    42
                })
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(jobs.0.lock().unwrap().joins.len(), 1);
        let mut closing = Box::pin(jobs.close_and_join());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut closing)
                .await
                .is_err()
        );
        assert_eq!(jobs.0.lock().unwrap().joins.len(), 1);
        assert!(jobs.run(|| 1).await.is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), closing)
            .await
            .unwrap()
            .unwrap();
        assert!(jobs.0.lock().unwrap().joins.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn results_and_panics_are_joined_without_retaining_their_payloads() {
        let jobs = Jobs::default();
        assert_eq!(jobs.run(|| 17).await.unwrap(), 17);
        assert!(jobs
            .run(|| panic!("synthetic worker failure"))
            .await
            .is_err());
        assert!(jobs.0.lock().unwrap().joins.is_empty());
        assert!(jobs.close_and_join().await.is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn real_secret_getter_waits_for_policy_gate_without_stalling_tokio() {
        let _serial = super::super::lock_test_store();
        let directory = tempfile::tempdir().unwrap();
        super::super::init(directory.path()).unwrap();
        super::super::set_api_key("synthetic", "stored").unwrap();
        // This test exercises a disk miss; cache hits must not wait for policy.
        super::super::clear_caches();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            super::super::policy::POLICY.capture(|_, _| {
                entered.send(()).unwrap();
                wait.recv().unwrap();
                Ok(())
            })
        });
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap();
        let mut reading = Box::pin(super::super::get_api_key_async("synthetic"));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut reading)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        let value = tokio::time::timeout(Duration::from_secs(2), reading)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value.as_deref(), Some("stored"));
        // The admitted cache miss revoked this older capture while waiting.
        assert!(holder.join().unwrap().is_err());
    }
}
