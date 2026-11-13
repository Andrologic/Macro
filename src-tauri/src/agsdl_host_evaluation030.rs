//! Bounded native pure calculations. A detached calculation keeps its permit
//! until its closure actually returns; dropping a waiter does not stop a thread.
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
pub(crate) type Probe = Arc<dyn Fn(&str, &mut String) + Send + Sync>;

pub(crate) struct Bounded<const N: usize> {
    slots: Arc<tokio::sync::Semaphore>,
    closed: CancellationToken,
    #[cfg(test)]
    pub(crate) probe: std::sync::Mutex<Option<Probe>>,
}
impl<const N: usize> Default for Bounded<N> {
    fn default() -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(N)),
            closed: CancellationToken::new(),
            #[cfg(test)]
            probe: Default::default(),
        }
    }
}
impl<const N: usize> Bounded<N> {
    pub(crate) fn close(&self) {
        self.closed.cancel();
    }
    pub(crate) async fn run<E: Clone + Send + 'static>(
        &self,
        unavailable: E,
        interrupted: E,
        cancelled: &CancellationToken,
        _raw_job: String,
        compute: impl FnOnce() -> Result<String, E> + Send + 'static,
    ) -> Result<String, E> {
        if self.closed.is_cancelled() || cancelled.is_cancelled() {
            return Err(unavailable.clone());
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable.clone())?;
        #[cfg(test)]
        let probe = self.probe.lock().unwrap().clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let output = compute()?;
            #[cfg(test)]
            let output = {
                let mut output = output;
                if let Some(probe) = probe {
                    probe(&_raw_job, &mut output);
                }
                output
            };
            Ok(output)
        });
        let result = tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(unavailable.clone()),
            _ = cancelled.cancelled() => Err(interrupted.clone()),
            result = task => result.map_err(|_| unavailable.clone())?,
        };
        if self.closed.is_cancelled() {
            return Err(unavailable.clone());
        }
        if cancelled.is_cancelled() {
            return Err(interrupted);
        }
        result
    }
}

#[cfg(test)]
mod conformance030_tests {
    use super::*;

    async fn detached<const N: usize>(abort: bool) {
        let evaluator = Arc::new(Bounded::<N>::default());
        let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let mut tasks = Vec::new();
        let cancel = CancellationToken::new();
        for _ in 0..N {
            let evaluator = evaluator.clone();
            let release = release.clone();
            let cancelled = cancel.clone();
            let (entered, entered_rx) = tokio::sync::oneshot::channel();
            tasks.push(tokio::spawn(async move {
                evaluator
                    .run(
                        "RUNTIME_UNAVAILABLE",
                        "INTERRUPTED",
                        &cancelled,
                        String::new(),
                        move || {
                            let _ = entered.send(());
                            let (mutex, condition) = &*release;
                            let mut released = mutex.lock().unwrap();
                            while !*released {
                                released = condition.wait(released).unwrap();
                            }
                            Ok("computed after waiter disappeared".into())
                        },
                    )
                    .await
            }));
            entered_rx.await.unwrap();
        }
        if abort {
            for task in &tasks {
                task.abort();
            }
        } else {
            cancel.cancel();
        }
        for task in tasks {
            if abort {
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(task.await.unwrap().unwrap_err(), "INTERRUPTED");
            }
        }
        assert_eq!(evaluator.slots.available_permits(), 0);
        let denied = evaluator
            .run(
                "RUNTIME_UNAVAILABLE",
                "INTERRUPTED",
                &CancellationToken::new(),
                String::new(),
                || panic!("capacity must stay occupied"),
            )
            .await
            .unwrap_err();
        assert_eq!(denied, "RUNTIME_UNAVAILABLE");
        let (mutex, condition) = &*release;
        *mutex.lock().unwrap() = true;
        condition.notify_all();
        // Acquiring every permit also joins the lifetime of all detached closures.
        let all = evaluator.slots.acquire_many(N as u32).await.unwrap();
        drop(all);
        assert_eq!(
            evaluator
                .run(
                    "RUNTIME_UNAVAILABLE",
                    "INTERRUPTED",
                    &CancellationToken::new(),
                    String::new(),
                    || Ok("next".into())
                )
                .await
                .unwrap(),
            "next"
        );
    }

    #[tokio::test]
    async fn cancelled_and_dropped_waiters_keep_all_native_slots_until_calculation_ends() {
        detached::<32>(false).await;
        detached::<64>(true).await;
    }

    #[tokio::test]
    async fn expiration_does_not_release_a_running_calculation_and_failure_is_local() {
        let evaluator = Arc::new(Bounded::<1>::default());
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let worker = evaluator.clone();
        let task = tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                worker.run(
                    "RUNTIME_UNAVAILABLE",
                    "INTERRUPTED",
                    &CancellationToken::new(),
                    String::new(),
                    move || {
                        let _ = entered.send(());
                        release_rx.recv().unwrap();
                        Ok("expired".into())
                    },
                ),
            )
            .await
        });
        entered_rx.await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(evaluator.slots.available_permits(), 0);
        release.send(()).unwrap();
        drop(evaluator.slots.acquire().await.unwrap());
        let failed = evaluator
            .run(
                "RUNTIME_UNAVAILABLE",
                "INTERRUPTED",
                &CancellationToken::new(),
                String::new(),
                || Err("RUNTIME_UNAVAILABLE"),
            )
            .await
            .unwrap_err();
        assert_eq!(failed, "RUNTIME_UNAVAILABLE");
        let panic = evaluator
            .run(
                "RUNTIME_UNAVAILABLE",
                "INTERRUPTED",
                &CancellationToken::new(),
                String::new(),
                || panic!("synthetic native calculation panic"),
            )
            .await
            .unwrap_err();
        assert_eq!(panic, "RUNTIME_UNAVAILABLE");
        assert_eq!(
            evaluator
                .run(
                    "RUNTIME_UNAVAILABLE",
                    "INTERRUPTED",
                    &CancellationToken::new(),
                    String::new(),
                    || Ok("still live".into())
                )
                .await
                .unwrap(),
            "still live"
        );
        evaluator.close();
        assert!(evaluator
            .run(
                "RUNTIME_UNAVAILABLE",
                "INTERRUPTED",
                &CancellationToken::new(),
                String::new(),
                || panic!("closed evaluator")
            )
            .await
            .is_err());
    }
}
