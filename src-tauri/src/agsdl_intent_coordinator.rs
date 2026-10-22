//! Owns UI submissions independently of compiler incarnations.
use crate::db::agsdl_execution::intents::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::watch;

type Outcome = IntentResult<PublicExecutionIntent>;
#[derive(Default)]
pub(crate) struct IntentCoordinator {
    slots: Mutex<HashMap<String, Weak<Slot>>>,
}
#[derive(Default)]
struct Slot {
    operation: Mutex<Option<Operation>>,
}
enum Operation {
    Submit {
        token: String,
        key: ExecutionIntentKey,
        result: watch::Sender<Option<Outcome>>,
    },
    Close {
        token: String,
    },
}
pub(crate) struct Owner {
    slot: Arc<Slot>,
    token: String,
}
impl IntentCoordinator {
    fn slot(&self, id: &str) -> IntentResult<Arc<Slot>> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| error(ExecutionIntentErrorCode::RuntimeUnavailable))?;
        slots.retain(|_, slot| slot.strong_count() > 0);
        if let Some(slot) = slots.get(id).and_then(Weak::upgrade) {
            return Ok(slot);
        }
        let slot = Arc::new(Slot::default());
        slots.insert(id.into(), Arc::downgrade(&slot));
        Ok(slot)
    }
    pub(crate) fn reserve_close(&self, key: &ExecutionIntentKey) -> IntentResult<Owner> {
        validate_key(key)?;
        let slot = self.slot(&key.intent_id)?;
        let token = uuid::Uuid::new_v4().to_string();
        {
            let mut operation = slot
                .operation
                .lock()
                .map_err(|_| error(ExecutionIntentErrorCode::RuntimeUnavailable))?;
            if operation.is_some() {
                return Err(error(ExecutionIntentErrorCode::SubmissionInProgress));
            }
            *operation = Some(Operation::Close {
                token: token.clone(),
            });
        }
        Ok(Owner { slot, token })
    }
    pub(crate) async fn submit<F, Fut>(&self, key: ExecutionIntentKey, work: F) -> Outcome
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Outcome> + Send + 'static,
    {
        validate_key(&key)?;
        let slot = self.slot(&key.intent_id)?;
        let (mut receiver, launch) = {
            let mut operation = slot
                .operation
                .lock()
                .map_err(|_| error(ExecutionIntentErrorCode::RuntimeUnavailable))?;
            match operation.as_ref() {
                Some(Operation::Close { .. }) => {
                    return Err(error(ExecutionIntentErrorCode::SubmissionInProgress))
                }
                Some(Operation::Submit {
                    key: retained,
                    result,
                    ..
                }) => {
                    if retained != &key {
                        return Err(error(ExecutionIntentErrorCode::NotFound));
                    }
                    (result.subscribe(), None)
                }
                None => {
                    let token = uuid::Uuid::new_v4().to_string();
                    let (sender, receiver) = watch::channel(None);
                    *operation = Some(Operation::Submit {
                        token: token.clone(),
                        key,
                        result: sender.clone(),
                    });
                    (
                        receiver,
                        Some((
                            Owner {
                                slot: slot.clone(),
                                token,
                            },
                            sender,
                        )),
                    )
                }
            }
        };
        // The marker and channel exist before spawning. No slot mutex crosses any await.
        if let Some((owner, sender)) = launch {
            tokio::spawn(async move {
                use futures::FutureExt;
                let result = std::panic::AssertUnwindSafe(async { work().await })
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err(error(ExecutionIntentErrorCode::RuntimeUnavailable)));
                sender.send_replace(Some(result));
                drop(owner);
            });
        }
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| error(ExecutionIntentErrorCode::RuntimeUnavailable))?;
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        let mut operation = self
            .slot
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let owned = match operation.as_ref() {
            Some(Operation::Submit { token, .. }) | Some(Operation::Close { token }) => {
                token == &self.token
            }
            None => false,
        };
        if owned {
            if let Some(Operation::Submit { result, .. }) = operation.as_ref() {
                if result.borrow().is_none() {
                    result.send_replace(Some(Err(error(
                        ExecutionIntentErrorCode::RuntimeUnavailable,
                    ))));
                }
            }
            *operation = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agsdl_execution::dto::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn row() -> PublicExecutionIntent {
        let source = EngineSourceRevision {
            owner: EngineSourceOwner {
                project_id: "project".into(),
                plan_id: "plan".into(),
                branch: "feature/synthetic".into(),
            },
            revision: "1".into(),
            source_sha256: "a".repeat(64),
        };
        PublicExecutionIntent {
            format_version: ExecutionIntentFormatVersion::V1,
            key: ExecutionIntentKey {
                scope: ExecutionIntentScope {
                    owner: source.owner.clone(),
                    conversation_id: "conversation".into(),
                },
                intent_id: "intent".into(),
            },
            revision: "1".into(),
            payload: ExecutionIntentPayload::Start {
                request: EngineStartRequest {
                    source,
                    profile: "macro-serial-inline-v1".into(),
                    associations: EngineAssociations::default(),
                    request_id: "start".into(),
                    entry: None,
                },
            },
            state: ExecutionIntentState::Prepared,
        }
    }
    #[tokio::test]
    async fn owned_submit_survives_observer_abort_joins_one_flight_and_keeps_mutex_free() {
        let coordinator = Arc::new(IntentCoordinator::default());
        let row = row();
        let key = row.key.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let launches = Arc::new(AtomicUsize::new(0));
        let count = launches.clone();
        let c = coordinator.clone();
        let first_key = key.clone();
        let outer = tokio::spawn(async move {
            c.submit(first_key, move || async move {
                count.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(row)
            })
            .await
        });
        started_rx.await.unwrap();
        outer.abort();
        assert!(outer.await.unwrap_err().is_cancelled());
        let slot = coordinator.slot(&key.intent_id).unwrap();
        assert!(slot.operation.try_lock().is_ok());
        assert!(coordinator.slots.try_lock().is_ok());
        assert!(matches!(
            coordinator.reserve_close(&key),
            Err(ExecutionIntentError {
                code: ExecutionIntentErrorCode::SubmissionInProgress,
                ..
            })
        ));
        let mut foreign = key.clone();
        foreign.scope.owner.plan_id = "foreign".into();
        assert_eq!(
            coordinator
                .submit(foreign, || async {
                    panic!("foreign observer must never dispatch")
                })
                .await
                .unwrap_err()
                .code,
            ExecutionIntentErrorCode::NotFound
        );
        let c = coordinator.clone();
        let second_key = key.clone();
        let observer = tokio::spawn(async move {
            c.submit(second_key, || async {
                panic!("joined observer must never dispatch")
            })
            .await
        });
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();
        observer.await.unwrap().unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        tokio::task::yield_now().await;
        assert!(coordinator.reserve_close(&key).is_ok());
    }
    #[tokio::test]
    async fn panic_and_abandoned_close_release_only_the_owning_token() {
        let coordinator = IntentCoordinator::default();
        let key = row().key;
        let failed = coordinator
            .submit(key.clone(), || async { panic!("synthetic worker panic") })
            .await
            .unwrap_err();
        assert_eq!(failed.code, ExecutionIntentErrorCode::RuntimeUnavailable);
        tokio::task::yield_now().await;
        let owner = coordinator.reserve_close(&key).unwrap();
        let slot = owner.slot.clone();
        assert!(slot.operation.try_lock().is_ok());
        *slot.operation.lock().unwrap() = Some(Operation::Close {
            token: "new-owner".into(),
        });
        drop(owner);
        assert!(
            matches!(&*slot.operation.lock().unwrap(),Some(Operation::Close{token}) if token == "new-owner")
        );
        drop(Owner {
            slot: slot.clone(),
            token: "new-owner".into(),
        });
        assert!(slot.operation.lock().unwrap().is_none());
        let owner = coordinator.reserve_close(&key).unwrap();
        drop(owner);
        assert!(coordinator.reserve_close(&key).is_ok());
    }
}
