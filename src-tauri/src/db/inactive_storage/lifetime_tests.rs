//! Real worker probes. The OS controller can release SQLite even while a
//! current-thread runtime is blocked in an abandoned lease's Drop.
use super::*;
use crate::db::preparation_lease::test_pause::{hold_begin, hold_commit, Pause};
use std::sync::{atomic::AtomicBool, mpsc, Condvar, Mutex};

async fn single_connection() -> (TempDir, InactiveStorage, Arc<AtomicI64>) {
    let (dir, old, clock) = fixture().await;
    old.pool.close().await;
    drop(old);
    let pool = SqlitePoolOptions::new()
        .min_connections(0)
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("target.db"))
                .foreign_keys(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
                .optimize_on_close(false, None::<u32>),
        )
        .await
        .unwrap();
    (dir, active(pool, clock.clone()), clock)
}
async fn worker_probe(commit: bool) {
    let (_dir, mut store, _clock) = single_connection().await;
    let payload = b"history";
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, payload.to_vec())]);
    let original = if commit {
        Some(store.begin(json(&begin).unwrap().as_bytes()).await.unwrap())
    } else {
        None
    };
    let (entered, waiting) = mpsc::channel();
    let pause = Arc::new(Pause {
        entered,
        once: AtomicBool::new(false),
        released: Mutex::new(false),
        wake: Condvar::new(),
    });
    {
        let mut connection = store.pool.acquire().await.unwrap();
        let mut handle = connection.lock_handle().await.unwrap();
        let context = Arc::as_ptr(&pause).cast_mut().cast();
        if commit {
            unsafe {
                libsqlite3_sys::sqlite3_commit_hook(
                    handle.as_raw_handle().as_ptr(),
                    Some(hold_commit),
                    context,
                )
            };
        } else {
            assert_eq!(
                unsafe {
                    libsqlite3_sys::sqlite3_set_authorizer(
                        handle.as_raw_handle().as_ptr(),
                        Some(hold_begin),
                        context,
                    )
                },
                libsqlite3_sys::SQLITE_OK
            );
        }
    }
    let (cleanup_started, cleanup_waiting) = mpsc::channel();
    store.lease_cleanup_started = Some(cleanup_started);
    let store = Arc::new(store);
    let worker = store.clone();
    let key = identity_key(&begin.identity).unwrap();
    let key_for_task = key.clone();
    let header = headers[0].clone();
    let begin_control = json(&begin).unwrap();
    let task = tokio::spawn(async move {
        if commit {
            worker
                .append(
                    &key_for_task,
                    json(&Append {
                        record: header,
                        offset: 0,
                        sha256: digest(payload),
                    })
                    .unwrap()
                    .as_bytes(),
                    payload,
                )
                .await
                .map(|_| ())
        } else {
            worker.begin(begin_control.as_bytes()).await.map(|_| ())
        }
    });
    let abort = task.abort_handle();
    let controller_pause = pause.clone();
    let authority = store.authority.as_ref().unwrap().clone();
    let controller = std::thread::spawn(move || {
        let arrived = waiting
            .recv_timeout(std::time::Duration::from_secs(15))
            .is_ok();
        if !arrived {
            controller_pause.release();
            return (false, false, false);
        }
        abort.abort();
        // The first Pending proves close was polled and Shutdown sent. The
        // worker is still paused, so this observes cleanup rather than timing
        // the executor. Only this OS controller can release SQLite.
        let cleaning = cleanup_waiting
            .recv_timeout(std::time::Duration::from_secs(15))
            .is_ok();
        let held = authority.try_write().is_err();
        let facade_finished = abort.is_finished();
        controller_pause.release();
        (cleaning, held, !facade_finished)
    });
    let cancelled = task.await.unwrap_err().is_cancelled();
    let (cleaning, held, pending_cleanup) = controller.join().unwrap();
    assert!(cancelled);
    assert!(cleaning, "lease never reached pending native close");
    assert!(held, "authority released while native worker was paused");
    assert!(
        pending_cleanup,
        "facade considered finished while worker was paused"
    );
    assert!(store.authority.as_ref().unwrap().try_write().is_ok());
    if let Some(original) = original {
        // COMMIT was already accepted: facade cancellation loses the answer,
        // but explicit replay must recover one immutable ACK, without a write.
        let status = store.status(&key).await.unwrap();
        assert_eq!(status.revision, 1);
        assert_eq!(status.received_bytes, payload.len() as i64);
        let control = json(&Append {
            record: headers[0].clone(),
            offset: 0,
            sha256: digest(payload),
        })
        .unwrap();
        let ack = store
            .append(&key, control.as_bytes(), payload)
            .await
            .unwrap();
        assert_eq!(ack.revision, 1);
        assert_eq!(store.status(&key).await.unwrap(), status);
        assert!(status.charge_bytes > original.charge_bytes);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_fragments")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
    } else {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_imports")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .begin(json(&begin).unwrap().as_bytes())
                .await
                .unwrap()
                .revision,
            0
        );
    }
    store.pool.close().await;
    drop(pause);
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_native_commit_keeps_permit_until_worker_shutdown_and_recovers_ack() {
    worker_probe(true).await;
}
#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_sent_begin_keeps_permit_until_worker_shutdown_without_publication() {
    worker_probe(false).await;
}

#[test]
fn abandoned_lease_closes_without_runtime_and_inside_an_existing_futures_executor() {
    for nested in [false, true] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (dir, store, receipt, authority, lease) = runtime.block_on(async {
            let (dir, store, _clock) = single_connection().await;
            assert_eq!(store.pool.options().get_min_connections(), 0);
            let (begin, _) = intent(&[(
                RecordKind::Message { role: Role::User },
                b"history".to_vec(),
            )]);
            let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
            let authority = store.authorize().await.unwrap();
            let mut lease = store.lease().await.unwrap();
            let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.unwrap();
            sqlx::query("UPDATE e_inactive_imports SET revision=99,charge_bytes=charge_bytes+1")
                .execute(&mut *tx)
                .await
                .unwrap();
            // Deliberately leave a transaction for the lease to close. This
            // probes the cleanup seam, not a public native operation.
            std::mem::forget(tx);
            (dir, store, receipt, authority, lease)
        });
        drop(runtime);
        if nested {
            futures::executor::block_on(async {
                drop(lease);
            });
        } else {
            drop(lease);
        }
        drop(authority);
        let reopened_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        reopened_runtime.block_on(async {
            assert_eq!(store.status(&receipt.key).await.unwrap(), receipt);
            store.pool.close().await;
        });
        drop(dir);
    }
}
