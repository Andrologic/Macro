use super::{project::ImportCandidate, Error, ImportPreview, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING: usize = 4;
const MAX_BYTES: u64 = 768 * 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct InspectedImport {
    pub handle: Uuid,
    pub preview: ImportPreview,
}

struct Pending {
    app_data: PathBuf,
    expires: Instant,
    bytes: u64,
    // Claimed snapshots keep their reservation until commit has finished.
    candidate: Option<ImportCandidate>,
}

static IMPORTS: LazyLock<Mutex<HashMap<Uuid, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending() -> Result<MutexGuard<'static, HashMap<Uuid, Pending>>> {
    let mut imports = IMPORTS
        .lock()
        .map_err(|_| std::io::Error::other("Architect import state unavailable"))?;
    imports.retain(|_, entry| entry.candidate.is_none() || entry.expires > Instant::now());
    Ok(imports)
}

pub(crate) fn inspect(app_data: PathBuf, path: &Path) -> Result<InspectedImport> {
    // Serialize opening as well as registration to bound transient native
    // decoding even if several frontend windows inspect at once.
    let mut imports = pending()?;
    if imports.len() == MAX_PENDING {
        return Err(Error::Editor("IMPORT_CANDIDATE_LIMIT"));
    }
    let candidate = ImportCandidate::open(path)?;
    let bytes = candidate.retained_bytes()?;
    if bytes + imports.values().map(|entry| entry.bytes).sum::<u64>() > MAX_BYTES {
        return Err(Error::Editor("IMPORT_CANDIDATE_LIMIT"));
    }
    let preview = candidate.preview()?;
    let handle = Uuid::new_v4();
    imports.insert(
        handle,
        Pending {
            app_data,
            expires: Instant::now() + TTL,
            bytes,
            candidate: Some(candidate),
        },
    );
    Ok(InspectedImport { handle, preview })
}

pub(crate) struct Claim {
    handle: Uuid,
    candidate: Option<ImportCandidate>,
}

impl Claim {
    pub(crate) fn candidate(&self) -> &ImportCandidate {
        self.candidate.as_ref().expect("live import claim")
    }

    pub(crate) fn commit(mut self) {
        self.candidate = None;
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut imports) = IMPORTS.lock() {
            if let Some(entry) = imports.get_mut(&self.handle) {
                if entry.expires > Instant::now() && self.candidate.is_some() {
                    entry.candidate = self.candidate.take();
                    return;
                }
            }
            imports.remove(&self.handle);
        }
    }
}

pub(crate) fn take(app_data: &Path, handle: Uuid) -> Result<Claim> {
    let candidate = pending()?
        .get_mut(&handle)
        .filter(|pending| pending.app_data == app_data)
        .and_then(|pending| pending.candidate.take())
        .ok_or(Error::Editor("IMPORT_HANDLE_EXPIRED"))?;
    Ok(Claim {
        handle,
        candidate: Some(candidate),
    })
}

pub(crate) fn discard(app_data: &Path, handle: Uuid) {
    let Ok(mut imports) = pending() else { return };
    if imports
        .get(&handle)
        .is_some_and(|pending| pending.app_data == app_data && pending.candidate.is_some())
    {
        imports.remove(&handle);
    }
}
