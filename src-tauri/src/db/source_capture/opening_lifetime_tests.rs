use super::*;
use crate::db::preparation_lease::test_pause::{hold_begin, hold_commit, Pause};
use std::sync::{atomic::AtomicBool, mpsc, Condvar, Mutex};

unsafe extern "C" fn hold_read_commit(
    context: *mut std::ffi::c_void,
    action: i32,
    arg: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> i32 {
    if action == libsqlite3_sys::SQLITE_TRANSACTION
        && !arg.is_null()
        && unsafe { std::ffi::CStr::from_ptr(arg) }.to_bytes() == b"COMMIT"
    {
        unsafe { hold_commit(context) }
    } else {
        libsqlite3_sys::SQLITE_OK
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_publication_keeps_gate_until_worker_shutdown_and_never_publishes_ready() {
    for commit in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opening.db");
        let original = crate::db::create_pool(&path).await.unwrap();
        original.close().await;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .min_connections(0)
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(path)
                    .optimize_on_close(false, None::<u32>),
            )
            .await
            .unwrap();
        let mut owner = DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
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
            // The Arc survives until the worker is closed by the abandoned
            // lease. The controller releases independently of this runtime.
            assert_eq!(
                unsafe {
                    libsqlite3_sys::sqlite3_set_authorizer(
                        handle.as_raw_handle().as_ptr(),
                        Some(if commit { hold_read_commit } else { hold_begin }),
                        context,
                    )
                },
                libsqlite3_sys::SQLITE_OK
            );
        }
        let (cleaning, cleanup) = mpsc::channel();
        owner.opening_cleanup_started = Some(cleaning);
        let task_owner = owner.clone();
        let task_pool = pool.clone();
        let task = tokio::spawn(async move { task_owner.set_ready(task_pool).await });
        let abort = task.abort_handle();
        let controller_owner = owner.clone();
        let controller_pause = pause.clone();
        let controller = std::thread::spawn(move || {
            if waiting
                .recv_timeout(std::time::Duration::from_secs(15))
                .is_err()
            {
                controller_pause.release();
                return (false, false, false, false);
            }
            abort.abort();
            let cleaning = cleanup
                .recv_timeout(std::time::Duration::from_secs(15))
                .is_ok();
            let initializing = matches!(
                controller_owner.current(),
                DbInitializationState::Initializing
            );
            struct NoWake;
            impl std::task::Wake for NoWake {
                fn wake(self: Arc<Self>) {}
            }
            let waker = std::task::Waker::from(Arc::new(NoWake));
            let mut setter = Box::pin(controller_owner.set_initializing());
            let gate_held = std::future::Future::poll(
                setter.as_mut(),
                &mut std::task::Context::from_waker(&waker),
            )
            .is_pending();
            drop(setter);
            let facade_pending = !abort.is_finished();
            controller_pause.release();
            (cleaning, initializing, gate_held, facade_pending)
        });
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            controller.join().unwrap(),
            (true, true, true, true),
            "commit={commit}"
        );
        assert!(matches!(
            owner.current(),
            DbInitializationState::Initializing
        ));
        owner.opening_cleanup_started = None;
        owner.set_ready(pool.clone()).await.unwrap();
        assert!(matches!(owner.current(), DbInitializationState::Ready(_)));
        pool.close().await;
    }
}
