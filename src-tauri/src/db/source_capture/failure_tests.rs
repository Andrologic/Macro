use super::*;
use crate::db::preparation_lease::test_pause::{hold_begin, hold_commit, Pause};
use std::sync::{atomic::AtomicBool, mpsc, Condvar, Mutex};

async fn one_connection() -> (TempDir, SqlitePool, SourceCapture, Arc<AtomicI64>) {
    connections(1).await
}
async fn connections(maximum: u32) -> (TempDir, SqlitePool, SourceCapture, Arc<AtomicI64>) {
    let (dir, old, c, clock) = capture_fixture().await;
    old.close().await;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .min_connections(0)
        .max_connections(maximum)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("source.db"))
                .foreign_keys(true)
                .optimize_on_close(false, None::<u32>),
        )
        .await
        .unwrap();
    c.owner.set_ready(pool.clone()).await;
    let capture = authorized(
        c.owner.clone(),
        uuid::Uuid::new_v4().to_string(),
        Mode::Continue,
        clock.clone(),
    )
    .await;
    (dir, pool, capture, clock)
}

#[tokio::test]
async fn quota_refuses_before_blob_read_and_keeps_ordinary_long_value() {
    let (_dir, pool, c, _clock) = capture_fixture().await;
    sqlx::query("UPDATE conversations SET title=? WHERE id='s'")
        .bind("é🙂".repeat(20_000))
        .execute(&pool)
        .await
        .unwrap();
    c.authority.as_ref().unwrap().write().await.policy.budget = 2048;
    let mut receipt = begin(&c).await;
    loop {
        let reads = c.reads.calls.load(Ordering::Relaxed);
        match c
            .copy_next(&json(&Copy {
                cursor: receipt.cursor.clone(),
                expected_revision: receipt.revision,
            }))
            .await
        {
            Ok(result) => receipt = result.receipt,
            Err(reason) => {
                assert_eq!(reason, "resource_limit");
                assert_eq!(
                    c.reads.calls.load(Ordering::Relaxed),
                    reads,
                    "refused block was read before admission"
                );
                assert_eq!(c.status().await.unwrap(), receipt);
                break;
            }
        }
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT length(CAST(title AS BLOB)) FROM conversations WHERE id='s'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        120_000
    );
    let aborted = c.abort().await.unwrap();
    assert_eq!(c.abort().await.unwrap(), aborted);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_fragments")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn sqlite_full_publishes_no_fragment_or_ack_and_healthy_connection_is_reused() {
    let (_dir, pool, c, _clock) = one_connection().await;
    sqlx::query("UPDATE conversations SET title=? WHERE id='s'")
        .bind("x".repeat(50_000))
        .execute(&pool)
        .await
        .unwrap();
    let first = begin(&c).await;
    let receipt = c
        .copy_next(&json(&Copy {
            cursor: first.cursor,
            expected_revision: first.revision,
        }))
        .await
        .unwrap()
        .receipt;
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA max_page_count={pages}"
    )))
    .execute(&pool)
    .await
    .unwrap();
    let request = json(&Copy {
        cursor: receipt.cursor.clone(),
        expected_revision: receipt.revision,
    });
    assert_eq!(
        c.copy_next(&request).await.unwrap_err(),
        "database_unavailable"
    );
    assert_eq!(c.status().await.unwrap(), receipt);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_fragments")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA max_page_count={}",
        pages + 100
    )))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TEMP TABLE healthy_source_marker(value INTEGER); INSERT INTO healthy_source_marker VALUES(123)").execute(&pool).await.unwrap();
    let copied = c.copy_next(&request).await.unwrap();
    assert_eq!(copied.ack.as_ref().unwrap().revision, receipt.revision + 1);
    assert_eq!(c.copy_next(&request).await.unwrap().ack, copied.ack);
    c.status().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT value FROM healthy_source_marker")
            .fetch_one(&pool)
            .await
            .unwrap(),
        123
    );
}

async fn cancelled_worker(commit: bool) {
    let (_dir, pool, mut c, _clock) = one_connection().await;
    let original = if commit { Some(begin(&c).await) } else { None };
    let (entered, waiting) = mpsc::channel();
    let pause = Arc::new(Pause {
        entered,
        once: AtomicBool::new(false),
        released: Mutex::new(false),
        wake: Condvar::new(),
    });
    {
        let mut connection = pool.acquire().await.unwrap();
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
    c.cleanup_started = Some(cleanup_started);
    let c = Arc::new(c);
    let worker = c.clone();
    let request = original.as_ref().map(|r| {
        json(&Copy {
            cursor: r.cursor.clone(),
            expected_revision: r.revision,
        })
    });
    let task_request = request.clone();
    let task = tokio::spawn(async move {
        if let Some(request) = task_request {
            worker.copy_next(&request).await.map(|_| ())
        } else {
            begin(&worker).await;
            Ok(())
        }
    });
    let abort = task.abort_handle();
    let authority = c.authority.as_ref().unwrap().clone();
    let owner = c.owner.clone();
    let controller_pause = pause.clone();
    let controller = std::thread::spawn(move || {
        let entered = waiting
            .recv_timeout(std::time::Duration::from_secs(15))
            .is_ok();
        if !entered {
            controller_pause.release();
            return (false, false, false, false);
        }
        abort.abort();
        let cleaning = cleanup_waiting
            .recv_timeout(std::time::Duration::from_secs(15))
            .is_ok();
        let authority_held = authority.try_write().is_err();
        // Source_ready has already acquired the actual shared gate; poll a
        // setter once without a Tokio executor and observe Pending causally.
        let mut setter = Box::pin(owner.set_initializing());
        struct NoWake;
        impl std::task::Wake for NoWake {
            fn wake(self: Arc<Self>) {}
        }
        let waker = std::task::Waker::from(Arc::new(NoWake));
        let gate_held =
            std::future::Future::poll(setter.as_mut(), &mut std::task::Context::from_waker(&waker))
                .is_pending();
        drop(setter);
        let facade_pending = !abort.is_finished();
        controller_pause.release();
        (cleaning, authority_held, gate_held, facade_pending)
    });
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(controller.join().unwrap(), (true, true, true, true));
    assert!(c.authority.as_ref().unwrap().try_write().is_ok());
    if let Some(original) = original {
        let receipt = c.status().await.unwrap();
        assert_eq!(receipt.revision, original.revision + 1);
        assert_eq!(
            c.copy_next(request.as_ref().unwrap())
                .await
                .unwrap()
                .receipt,
            receipt
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_fragments")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    } else {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_captures")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
    c.owner.set_ready(pool.clone()).await;
    assert!(
        c.status().await.is_err(),
        "next block retained a stale generation"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn abandoned_begin_holds_both_guards_until_real_worker_shutdown() {
    cancelled_worker(false).await;
}
#[tokio::test(flavor = "current_thread")]
async fn abandoned_commit_holds_both_guards_and_explicit_retry_recovers_ack() {
    cancelled_worker(true).await;
}

#[tokio::test]
async fn closed_controls_invalid_utf8_and_clock_do_not_advance_capture() {
    let (_dir, pool, c, clock) = capture_fixture().await;
    for raw in [
        br#"{"capture_id":"x","capture_id":"x","conversation_id":"s"}"#.as_slice(),
        br#"{"capture_id":"x","conversation_id":"s","extra":true}"#,
    ] {
        assert_eq!(c.begin(raw).await.unwrap_err(), "validation_failed");
    }
    assert_eq!(
        c.begin(&vec![b' '; 4097]).await.unwrap_err(),
        "resource_limit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_captures")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE conversations SET title=CAST(X'FF' AS TEXT) WHERE id='s'")
        .execute(&pool)
        .await
        .unwrap();
    let first = begin(&c).await;
    let receipt = c
        .copy_next(&json(&Copy {
            cursor: first.cursor,
            expected_revision: first.revision,
        }))
        .await
        .unwrap()
        .receipt;
    let request = json(&Copy {
        cursor: receipt.cursor.clone(),
        expected_revision: receipt.revision,
    });
    assert!(c.copy_next(&request).await.is_err());
    assert_eq!(c.status().await.unwrap(), receipt);
    clock.store(999_999, Ordering::SeqCst);
    assert_eq!(c.copy_next(&request).await.unwrap_err(), "clock_rollback");
    assert_eq!(c.status().await.unwrap(), receipt);
}

#[tokio::test]
async fn concurrent_source_and_target_share_atomic_receipt_admission() {
    let (_dir, pool, c, clock) = capture_fixture().await;
    c.authority
        .as_ref()
        .unwrap()
        .write()
        .await
        .policy
        .max_receipts = 1;
    let (target, intent) = crate::db::inactive_storage::tests::shared_preparation_owner(
        pool.clone(),
        clock,
        128 * 1024 * 1024,
        1,
        "concurrent",
    )
    .await;
    let id = c
        .authority
        .as_ref()
        .unwrap()
        .read()
        .await
        .capture_id
        .clone();
    let source_request = json(&Open {
        capture_id: id,
        conversation_id: "s".into(),
    });
    let target_request = json(&intent);
    let (source, target) = tokio::join!(c.begin(&source_request), target.begin(&target_request));
    assert_eq!(usize::from(source.is_ok()) + usize::from(target.is_ok()), 1);
    assert_eq!(source.err().or(target.err()).unwrap(), "resource_limit");
    assert_eq!(
        crate::db::inactive_budget::journal_count(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn concurrent_abort_invalidates_seal_and_its_owned_copies() {
    let (_dir, pool, c, _clock) = capture_fixture().await;
    rich(&pool).await;
    begin(&c).await;
    copy_all(&c).await;
    let (seal, abort) = tokio::join!(c.seal_raw(), c.abort());
    assert!(seal.is_err());
    let terminal = abort.unwrap();
    assert_eq!(terminal.phase, 3);
    assert_eq!(c.status().await.unwrap(), terminal);
    for table in [
        "e_source_fields",
        "e_source_fragments",
        "e_source_relations",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table}"
            )))
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn non_global_source_refuses_before_budget_and_sealed_raw_stays_pinned() {
    let (_dir, pool, c, clock) = capture_fixture().await;
    sqlx::query("UPDATE conversations SET task_id='synthetic-task' WHERE id='s'")
        .execute(&pool)
        .await
        .unwrap();
    let id = c
        .authority
        .as_ref()
        .unwrap()
        .read()
        .await
        .capture_id
        .clone();
    assert_eq!(
        c.begin(&json(&Open {
            capture_id: id,
            conversation_id: "s".into()
        }))
        .await
        .unwrap_err(),
        "source_not_global_chat"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE conversations SET task_id=NULL WHERE id='s'")
        .execute(&pool)
        .await
        .unwrap();
    begin(&c).await;
    copy_all(&c).await;
    let sealed = c.seal_raw().await.unwrap();
    clock.fetch_add(7_200_000, Ordering::SeqCst);
    assert_eq!(c.expire().await.unwrap_err(), "capture_pinned");
    assert_eq!(c.abort().await.unwrap_err(), "capture_pinned");
    assert_eq!(c.status().await.unwrap(), sealed.receipt);
    assert_eq!(c.seal_raw().await.unwrap().manifest, sealed.manifest);
}

#[tokio::test]
async fn native_response_revision_and_stored_fragment_corruption_fail_closed() {
    let (_dir, pool, c, _clock) = capture_fixture().await;
    rich(&pool).await;
    sqlx::query(
        "UPDATE conversation_response_versions SET revision=0 WHERE message_id='assistant'",
    )
    .execute(&pool)
    .await
    .unwrap();
    begin(&c).await;
    copy_all(&c).await;
    assert!(c.seal_raw().await.is_err());
    assert_ne!(c.status().await.unwrap().phase, 2);
    c.abort().await.unwrap();
    sqlx::query(
        "UPDATE conversation_response_versions SET revision=1 WHERE message_id='assistant'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let next = authorized(
        c.owner.clone(),
        uuid::Uuid::new_v4().to_string(),
        Mode::Continue,
        Arc::new(AtomicI64::new(1_000_000)),
    )
    .await;
    begin(&next).await;
    copy_all(&next).await;
    next.seal_raw().await.unwrap();
    sqlx::query("UPDATE e_source_fragments SET data=X'78' WHERE rowid=(SELECT MAX(rowid) FROM e_source_fragments)").execute(&pool).await.unwrap();
    let mut cursor = None;
    let mut refused = false;
    loop {
        match next.readback(cursor, 32).await {
            Err(reason) => {
                assert_eq!(reason, "integrity_failed");
                refused = true;
                break;
            }
            Ok(page) => {
                cursor = page.next;
                if cursor.is_none() {
                    break;
                }
            }
        }
    }
    assert!(
        refused,
        "stored corruption escaped the actual paged readback"
    );
}

#[tokio::test]
async fn concurrent_seals_agree_or_refuse_without_duplicate_retention() {
    let (_dir, pool, c, _clock) = capture_fixture().await;
    sqlx::query("UPDATE messages SET content=? WHERE id='m'")
        .bind("é🙂".repeat(40_000))
        .execute(&pool)
        .await
        .unwrap();
    begin(&c).await;
    copy_all(&c).await;
    // Hash pages return only scalars under their Scope. Exercise two actual
    // multi-page verifiers; a stale final CAS may refuse the second one.
    let (first, second) = tokio::join!(c.seal_raw(), c.seal_raw());
    assert!(first.is_ok() || second.is_ok());
    let sealed = first.as_ref().or(second.as_ref()).unwrap();
    if let (Ok(first), Ok(second)) = (&first, &second) {
        assert_eq!(first.manifest, second.manifest);
        assert_eq!(first.receipt, second.receipt);
    }
    let receipt = c.status().await.unwrap();
    assert_eq!(receipt, sealed.receipt);
    assert_eq!(c.seal_raw().await.unwrap().receipt, receipt);
    assert_eq!(
        crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        receipt.charge + 24
    );
}

#[tokio::test]
async fn real_sqlite_writer_defers_capture_commit_until_unlock() {
    use sqlx::Connection;
    let (_dir, pool, c, _clock) = connections(2).await;
    let first = begin(&c).await;
    let mut writer = pool.acquire().await.unwrap();
    let writer_tx = writer.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let (entered, waiting) = mpsc::channel();
    let pause = Arc::new(Pause {
        entered,
        once: AtomicBool::new(false),
        released: Mutex::new(false),
        wake: Condvar::new(),
    });
    {
        let mut probe = pool.acquire().await.unwrap();
        let mut handle = probe.lock_handle().await.unwrap();
        assert_eq!(
            unsafe {
                libsqlite3_sys::sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr(),
                    Some(hold_begin),
                    Arc::as_ptr(&pause).cast_mut().cast(),
                )
            },
            libsqlite3_sys::SQLITE_OK
        );
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while pool.num_idle() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let c = Arc::new(c);
    let worker = c.clone();
    let request = json(&Copy {
        cursor: first.cursor.clone(),
        expected_revision: first.revision,
    });
    let start = std::time::Instant::now();
    let pending = tokio::spawn(async move { worker.copy_next(&request).await });
    let arrived = tokio::task::spawn_blocking(move || {
        waiting
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_ok()
    })
    .await
    .unwrap();
    pause.release();
    assert!(arrived, "capture never reached the real SQLite BEGIN");
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(
        !pending.is_finished(),
        "capture acknowledged while another writer held SQLite"
    );
    writer_tx.commit().await.unwrap();
    let copied = pending.await.unwrap().unwrap();
    assert_eq!(copied.receipt.revision, first.revision + 1);
    eprintln!(
        "SOURCE_WRITER_CONTENTION {}",
        serde_json::json!({"controlled_writer_hold_ms":20,"observed_call_us":start.elapsed().as_micros(),"no_ack_before_unlock":true,"native_begin_observed":true,"production_latency_claim":false})
    );
    // The callback context outlives every connection that contains its pointer.
    drop(writer);
    pool.close().await;
}
