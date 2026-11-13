use super::*;
use std::sync::{Arc, Condvar, OnceLock};
use std::time::Duration;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        tauri::async_runtime::set(runtime.handle().clone());
        runtime
    })
}

struct Directory(PathBuf);
impl Directory {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("macro-http-cookie-{}-{name}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct MainLoopWaiters {
    release: Arc<(Mutex<bool>, Condvar)>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}
impl MainLoopWaiters {
    fn occupy_both_workers() -> Self {
        let mut waiters = Self {
            release: Arc::new((Mutex::new(false), Condvar::new())),
            tasks: Vec::new(),
        };
        let (started, receive) = std::sync::mpsc::channel();
        for _ in 0..2 {
            let started = started.clone();
            let release = waiters.release.clone();
            waiters.tasks.push(tauri::async_runtime::spawn(async move {
                started.send(()).unwrap();
                let (mutex, wake) = &*release;
                let mut released = mutex.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
            }));
        }
        for _ in 0..2 {
            receive.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        waiters
    }
}
impl Drop for MainLoopWaiters {
    fn drop(&mut self) {
        let (mutex, wake) = &*self.release;
        *mutex.lock().unwrap() = true;
        wake.notify_all();
        // Always release and join the synthetic waiters, including on failure.
        for task in self.tasks.drain(..) {
            let _ = runtime().block_on(task);
        }
    }
}

fn update(jar: &CookieStoreMutex, url: &url::Url, headers: &[&str]) {
    let headers: Vec<_> = headers
        .iter()
        .map(|value| HeaderValue::from_str(value).unwrap())
        .collect();
    reqwest::cookie::CookieStore::set_cookies(jar, &mut headers.iter(), url);
}

#[test]
fn cookie_save_completes_while_async_workers_wait_for_main_thread() {
    runtime();
    let directory = Directory::new("starvation");
    let path = directory.0.join("cookies.json");
    let jar = CookieStoreMutex::new(path.clone(), Default::default());
    let url = url::Url::parse("https://synthetic.invalid/").unwrap();
    update(
        &jar,
        &url,
        &[
            "persistent=first; Max-Age=3600; Path=/",
            "session=private; Path=/",
        ],
    );
    jar.request_save()
        .unwrap()
        .recv_timeout(Duration::from_secs(3))
        .unwrap();

    let waiters = MainLoopWaiters::occupy_both_workers();
    update(&jar, &url, &["persistent=final; Max-Age=3600; Path=/"]);
    // Like plugin Exit, this ordinary thread waits synchronously while every
    // async worker is waiting for it. The test deadline is only an observer.
    let saved = jar
        .request_save()
        .unwrap()
        .recv_timeout(Duration::from_secs(3));
    drop(waiters);
    saved.expect("cookie save must not require an available async worker");

    let restored = CookieStoreMutex::load(
        path,
        std::io::BufReader::new(std::fs::File::open(&jar.path).unwrap()),
    )
    .unwrap();
    assert_eq!(
        reqwest::cookie::CookieStore::cookies(&restored, &url)
            .unwrap()
            .to_str()
            .unwrap(),
        "persistent=final"
    );
}

#[test]
fn cookie_write_failure_disconnects_the_waiter() {
    runtime();
    let directory = Directory::new("write-error");
    let jar = CookieStoreMutex::new(directory.0.clone(), Default::default());
    let result = jar
        .request_save()
        .unwrap()
        .recv_timeout(Duration::from_secs(3));
    assert!(matches!(
        result,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
}
