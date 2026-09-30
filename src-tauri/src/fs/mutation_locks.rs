// Shared content locks serialize direct FS writes with transactional workspace mutations.
use super::normalize_path;
use crate::project_path::WslProjectPath;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, Weak};

static CONTENT_MUTATION_LOCKS: LazyLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn content_mutation_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = CONTENT_MUTATION_LOCKS
        .lock()
        .expect("content mutation lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key.to_string(), Arc::downgrade(&lock));
    lock
}

pub(crate) fn wsl_content_mutation_key(target: &WslProjectPath) -> String {
    format!(
        "wsl:{}:{}",
        target.distro.to_ascii_lowercase(),
        target.linux_path
    )
}

pub(crate) async fn native_content_mutation_key(path: &Path) -> String {
    let resolved_path = match tokio::fs::canonicalize(path).await {
        Ok(path) => path,
        Err(_) => {
            let parent = path.parent();
            match parent {
                Some(parent) => match tokio::fs::canonicalize(parent).await {
                    Ok(canonical_parent) => path
                        .file_name()
                        .map(|name| canonical_parent.join(name))
                        .unwrap_or_else(|| normalize_path(path)),
                    Err(_) => normalize_path(path),
                },
                None => normalize_path(path),
            }
        }
    };
    let key = resolved_path.to_string_lossy().replace('\\', "/");
    #[cfg(any(windows, target_os = "macos"))]
    let key = key.to_ascii_lowercase();
    format!("native:{key}")
}
