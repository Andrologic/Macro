//! Local primitives only. The content host must bind these opaque handles to its
//! authenticated account/session/reference and perform authorization at effect time.
use chrono::Utc;
use git2::{Oid, Repository};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
fn background_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
use serde::Deserialize;
use std::collections::BTreeMap;

const STORAGE: usize = 64 * 1024 * 1024;
const INSPECTION: usize = 256 * 1024 * 1024;
const FILE_LIMIT: usize = 8 * 1024 * 1024;
const PAGE_FILES: usize = 10;
const FRAGMENT: usize = 16 * 1024;
const TTL: Duration = Duration::from_secs(300);
const DEADLINE: Duration = Duration::from_secs(10);
pub(super) type CaptureResult<T> = std::result::Result<T, String>;
fn unavailable<T>(_: T) -> String {
    "content_unavailable".into()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PilotCaptureSource {
    Commits { base_sha: String, head_sha: String },
    Staged,
    Unstaged,
    LocalTotal,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PilotCaptureRequest {
    pub source: PilotCaptureSource,
    /// Values and explicitly configured encoded forms, supplied by the local host.
    pub secret_values: Vec<String>,
    pub policy_revision: String,
}
#[derive(Clone, Serialize)]
pub struct PilotCaptureInfo {
    pub snapshot_id: String,
    pub source: PilotCaptureSource,
    pub head_sha: Option<String>,
    pub observed_at: String,
    pub expires_at: String,
    pub export_policy_revision: String,
    pub availability: String,
    pub file_count: usize,
}
#[derive(Clone, Serialize)]
pub struct PilotCaptureFile {
    pub file_id: String,
    pub position: usize,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_mode: Option<String>,
    pub content_state: String,
    pub patch_bytes: usize,
}
#[derive(Serialize)]
pub struct PilotCapturePage {
    pub capture: PilotCaptureInfo,
    pub offset: usize,
    pub total: usize,
    pub next_cursor: Option<String>,
    pub items: Vec<PilotCaptureFile>,
}
#[derive(Serialize)]
pub struct PilotCaptureFragment {
    pub snapshot_id: String,
    pub file_id: String,
    pub offset_bytes: usize,
    pub next_offset_bytes: Option<usize>,
    pub total_bytes: usize,
    pub patch: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Side {
    mode: u32,
    bytes: Vec<u8>,
}
type Files = BTreeMap<String, Side>;
struct Observation {
    old: Files,
    new: Files,
    union: HashSet<String>,
    fingerprint: Vec<u8>,
    head: Option<String>,
}
struct Capture {
    info: PilotCaptureInfo,
    path: PathBuf,
    source: PilotCaptureSource,
    fingerprint: Vec<u8>,
    policy_hash: Vec<u8>,
    files: Vec<(PilotCaptureFile, String)>,
    cursors: Vec<String>,
    created: Instant,
    cost: usize,
}
#[derive(Default)]
struct Cache {
    captures: HashMap<String, Capture>,
}
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
fn cache() -> CaptureResult<std::sync::MutexGuard<'static, Cache>> {
    let mut guard = CACHE
        .get_or_init(|| Mutex::new(Cache::default()))
        .lock()
        .map_err(unavailable)?;
    guard.captures.retain(|_, c| c.created.elapsed() < TTL);
    Ok(guard)
}
struct Budget {
    bytes: usize,
    entries: usize,
    start: Instant,
}
impl Budget {
    fn new() -> Self {
        Self {
            bytes: 0,
            entries: 0,
            start: Instant::now(),
        }
    }
    fn check(&mut self, bytes: usize) -> CaptureResult<()> {
        self.bytes = self.bytes.checked_add(bytes).ok_or("resource_limit")?;
        self.entries += 1;
        if self.bytes > INSPECTION || self.entries > 100_000 {
            return Err("resource_limit".into());
        }
        if self.start.elapsed() > DEADLINE {
            return Err("content_unavailable".into());
        }
        Ok(())
    }
}
fn field(h: &mut Sha256, b: &[u8]) {
    h.update((b.len() as u64).to_le_bytes());
    h.update(b);
}
fn hash_files(h: &mut Sha256, files: &Files) {
    for (p, s) in files {
        field(h, p.as_bytes());
        h.update(s.mode.to_le_bytes());
        field(h, &s.bytes);
    }
}
fn tree_files(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &str,
    out: &mut Files,
    budget: &mut Budget,
) -> CaptureResult<()> {
    for e in tree.iter() {
        let name = e.name().map_err(unavailable)?;
        let path = format!("{prefix}{name}");
        budget.check(path.len())?;
        if e.kind() == Some(git2::ObjectType::Tree) {
            tree_files(
                repo,
                &repo.find_tree(e.id()).map_err(unavailable)?,
                &format!("{path}/"),
                out,
                budget,
            )?;
        } else {
            let bytes = if e.filemode() == 0o160000 {
                e.id().as_bytes().to_vec()
            } else {
                let blob = repo.find_blob(e.id()).map_err(unavailable)?;
                budget.check(blob.size())?;
                blob.content().to_vec()
            };
            out.insert(
                path,
                Side {
                    mode: e.filemode() as u32,
                    bytes,
                },
            );
        }
    }
    Ok(())
}
fn commit_files(repo: &Repository, oid: Oid, budget: &mut Budget) -> CaptureResult<Files> {
    let mut files = Files::new();
    let commit = repo.find_commit(oid).map_err(unavailable)?;
    tree_files(
        repo,
        &commit.tree().map_err(unavailable)?,
        "",
        &mut files,
        budget,
    )?;
    Ok(files)
}
fn explicit_oid(value: &str) -> CaptureResult<Oid> {
    if value.len() != 40 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("validation_failed".into());
    }
    Oid::from_str(value).map_err(unavailable)
}

// Descriptor-relative traversal prevents following a swapped parent symlink.
// Platforms without this implementation fail closed before reading worktree data.
#[cfg(unix)]
fn read_entry(root: &Path, relative: &Path, budget: &mut Budget) -> CaptureResult<Option<Side>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    let mut dir = fs::File::open(root).map_err(unavailable)?;
    let parts: Vec<_> = relative.components().collect();
    for (i, component) in parts.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return Err("content_unavailable".into());
        };
        let name = std::ffi::CString::new(name.as_bytes()).map_err(unavailable)?;
        let last = i + 1 == parts.len();
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(unavailable(error));
        }
        let stat = unsafe { stat.assume_init() };
        if last && stat.st_mode & libc::S_IFMT == libc::S_IFLNK {
            let mut bytes = vec![0; 65536];
            let n = unsafe {
                libc::readlinkat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if n < 0 || n as usize == bytes.len() {
                return Err("content_unavailable".into());
            }
            bytes.truncate(n as usize);
            budget.check(bytes.len())?;
            return Ok(Some(Side {
                mode: 0o120000,
                bytes,
            }));
        }
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC
            | if last { 0 } else { libc::O_DIRECTORY };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("content_unavailable".into());
        }
        let file = unsafe { fs::File::from_raw_fd(fd) };
        if last {
            let meta = file.metadata().map_err(unavailable)?;
            if !meta.is_file() {
                return Ok(Some(Side {
                    mode: 0,
                    bytes: Vec::new(),
                }));
            }
            budget.check(meta.len().try_into().map_err(unavailable)?)?;
            let mut bytes = Vec::new();
            file.take((INSPECTION - budget.bytes + meta.len() as usize + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(unavailable)?;
            if bytes.len() > meta.len() as usize {
                return Err("content_unavailable".into());
            }
            return Ok(Some(Side {
                mode: if meta.mode() & 0o111 != 0 {
                    0o100755
                } else {
                    0o100644
                },
                bytes,
            }));
        }
        dir = file;
    }
    Err("content_unavailable".into())
}
#[cfg(not(unix))]
fn read_entry(_: &Path, _: &Path, _: &mut Budget) -> CaptureResult<Option<Side>> {
    Err("content_unavailable".into())
}

fn observe(
    repo: &Repository,
    source: &PilotCaptureSource,
    budget: &mut Budget,
) -> CaptureResult<Observation> {
    observe_inner(repo, source, budget, 0)
}
fn observe_inner(
    repo: &Repository,
    source: &PilotCaptureSource,
    budget: &mut Budget,
    depth: usize,
) -> CaptureResult<Observation> {
    if depth > 8 {
        return Err("content_unavailable".into());
    }
    if let PilotCaptureSource::Commits { base_sha, head_sha } = source {
        let old = commit_files(repo, explicit_oid(base_sha)?, budget)?;
        let new = commit_files(repo, explicit_oid(head_sha)?, budget)?;
        let mut h = Sha256::new();
        hash_files(&mut h, &old);
        h.update([255]);
        hash_files(&mut h, &new);
        return Ok(Observation {
            old,
            new,
            union: HashSet::new(),
            fingerprint: h.finalize().to_vec(),
            head: Some(head_sha.clone()),
        });
    }
    let root = repo.workdir().ok_or("content_unavailable")?;
    let head = match repo.head() {
        Ok(r) => Some(r.peel_to_commit().map_err(unavailable)?.id()),
        Err(e)
            if e.code() == git2::ErrorCode::UnbornBranch
                || e.code() == git2::ErrorCode::NotFound =>
        {
            None
        }
        Err(e) => return Err(unavailable(e)),
    };
    let base = match head {
        Some(oid) => commit_files(repo, oid, budget)?,
        None => Files::new(),
    };
    let mut index = repo.index().map_err(unavailable)?;
    index.read(true).map_err(unavailable)?;
    if index.has_conflicts() {
        return Err("content_unavailable".into());
    }
    let mut indexed = Files::new();
    for e in index.iter() {
        let path = String::from_utf8(e.path).map_err(unavailable)?;
        let bytes = if e.mode == 0o160000 {
            e.id.as_bytes().to_vec()
        } else {
            let b = repo.find_blob(e.id).map_err(unavailable)?;
            budget.check(b.size())?;
            b.content().to_vec()
        };
        budget.check(path.len())?;
        indexed.insert(
            path,
            Side {
                mode: e.mode,
                bytes,
            },
        );
    }
    let mut h = Sha256::new();
    field(
        &mut h,
        head.map(|x| x.to_string()).unwrap_or_default().as_bytes(),
    );
    // Raw index checksum detects flags and index-only changes as well as contents.
    if let Some(path) = index.path() {
        match fs::File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(INSPECTION as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(unavailable)?;
                budget.check(bytes.len())?;
                field(&mut h, &bytes);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && indexed.is_empty() => (),
            Err(e) => return Err(unavailable(e)),
        }
    }
    hash_files(&mut h, &indexed);
    if matches!(source, PilotCaptureSource::Staged) {
        hash_files(&mut h, &base);
        return Ok(Observation {
            old: base,
            new: indexed,
            union: HashSet::new(),
            fingerprint: h.finalize().to_vec(),
            head: head.map(|x| x.to_string()),
        });
    }
    let mut paths: HashSet<String> = indexed.keys().chain(base.keys()).cloned().collect();
    let submodules: HashSet<_> = indexed
        .iter()
        .filter(|(_, s)| s.mode == 0o160000)
        .map(|(p, _)| p.clone())
        .collect();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || (e.file_name() != ".git"
                    && !submodules.contains(
                        &e.path()
                            .strip_prefix(root)
                            .unwrap_or(e.path())
                            .to_string_lossy()
                            .to_string(),
                    ))
        });
    for e in walker {
        let e = e.map_err(unavailable)?;
        budget.check(0)?;
        if e.depth() == 0 || e.file_type().is_dir() {
            continue;
        }
        let path = e
            .path()
            .strip_prefix(root)
            .map_err(unavailable)?
            .to_str()
            .ok_or("content_unavailable")?
            .to_string();
        if !repo.is_path_ignored(&path).map_err(unavailable)? {
            paths.insert(path);
        }
    }
    let mut work = Files::new();
    for p in paths {
        budget.check(p.len())?;
        if submodules.contains(&p) {
            // Retain the gitlink as the visible side; nested state is private.
            // An uninitialized submodule has no local bytes to inspect.
            let subroot = root.join(&p);
            let entry = read_entry(root, Path::new(&p), budget)?;
            if entry.as_ref().is_some_and(|s| s.mode == 0o120000) {
                return Err("content_unavailable".into());
            }
            if entry.is_some() {
                if fs::symlink_metadata(subroot.join(".git")).is_ok() {
                    if fs::symlink_metadata(subroot.join(".git"))
                        .map_err(unavailable)?
                        .file_type()
                        .is_symlink()
                    {
                        return Err("content_unavailable".into());
                    }
                    let nested_repo = Repository::open(&subroot).map_err(unavailable)?;
                    let nested = observe_inner(
                        &nested_repo,
                        &PilotCaptureSource::LocalTotal,
                        budget,
                        depth + 1,
                    )?;
                    field(&mut h, &nested.fingerprint);
                    let mut bytes =
                        explicit_oid(nested.head.as_deref().ok_or("content_unavailable")?)?
                            .as_bytes()
                            .to_vec();
                    if !nested.union.is_empty() {
                        bytes.extend_from_slice(&nested.fingerprint);
                    }
                    work.insert(
                        p,
                        Side {
                            mode: 0o160000,
                            bytes,
                        },
                    );
                } else {
                    field(&mut h, b"uninitialized-submodule");
                    work.insert(
                        p.clone(),
                        indexed.get(&p).ok_or("content_unavailable")?.clone(),
                    );
                }
            }
        } else if let Some(side) = read_entry(root, Path::new(&p), budget)? {
            work.insert(p, side);
        }
    }
    hash_files(&mut h, &work);
    let union = base
        .keys()
        .chain(indexed.keys())
        .chain(work.keys())
        .filter(|p| base.get(*p) != indexed.get(*p) || indexed.get(*p) != work.get(*p))
        .cloned()
        .collect();
    let old = if matches!(source, PilotCaptureSource::Unstaged) {
        indexed
    } else {
        base
    };
    Ok(Observation {
        old,
        new: work,
        union,
        fingerprint: h.finalize().to_vec(),
        head: head.map(|x| x.to_string()),
    })
}

fn unsafe_text(text: &str, secrets: &[String]) -> bool {
    static SIGNATURES: OnceLock<regex::Regex> = OnceLock::new();
    SIGNATURES.get_or_init(|| regex::Regex::new(r"file://|/(Users|home|private|var|tmp|opt|etc|root|Volumes)/|[A-Za-z]:\\|gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap()).is_match(text)
        || secrets.iter().any(|s| !s.is_empty() && text.contains(s))
}
fn unsafe_path(path: &str, secrets: &[String]) -> bool {
    let lower = path.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    unsafe_text(path, secrets)
        || lower.split('/').any(|p| p == ".git" || p == ".ssh")
        || base == ".env"
        || base.starts_with(".env.")
        || matches!(base, "credentials.json" | "id_rsa" | "id_ed25519")
        || base.ends_with(".key")
        || base.ends_with(".p12")
}
fn content_state(
    path: &str,
    a: Option<&Side>,
    b: Option<&Side>,
    secrets: &[String],
) -> &'static str {
    if unsafe_path(path, secrets) {
        return "withheld";
    }
    if path.len() > 1024
        || path.contains('\\')
        || path.starts_with('/')
        || path.split('/').any(|p| p == "..")
    {
        return "unsupported";
    }
    let sides: Vec<_> = a.into_iter().chain(b).collect();
    if sides.iter().any(|s| s.bytes.len() > FILE_LIMIT) {
        return "too_large";
    }
    // Whole sides are inspected before any fragments or disk copies are made.
    if sides
        .iter()
        .any(|s| unsafe_text(&String::from_utf8_lossy(&s.bytes), secrets))
    {
        return "withheld";
    }
    if sides.iter().any(|s| s.mode == 0o160000) {
        return "submodule";
    }
    if sides.iter().any(|s| !matches!(s.mode, 0o100644 | 0o100755)) {
        return "unsupported";
    }
    if sides.iter().any(|s| s.bytes.contains(&0)) {
        return "binary";
    }
    if sides.iter().any(|s| std::str::from_utf8(&s.bytes).is_err()) {
        return "unsupported";
    }
    "text"
}
fn mode(s: Option<&Side>) -> Option<String> {
    s.filter(|s| matches!(s.mode, 0o100644 | 0o100755 | 0o120000 | 0o160000))
        .map(|s| format!("{:06o}", s.mode))
}
fn file_info(path: &str, a: Option<&Side>, b: Option<&Side>, state: &str) -> PilotCaptureFile {
    let hidden = state == "withheld" || path.contains('\\') || path.len() > 1024;
    PilotCaptureFile {
        file_id: id(),
        position: 0,
        old_path: if hidden {
            None
        } else {
            a.map(|_| path.to_owned())
        },
        new_path: if hidden {
            None
        } else {
            b.map(|_| path.to_owned())
        },
        change: if a == b {
            "unchanged"
        } else if a.is_none() {
            "added"
        } else if b.is_none() {
            "deleted"
        } else if a.unwrap().mode & 0o170000 != b.unwrap().mode & 0o170000 {
            "type_changed"
        } else {
            "modified"
        }
        .into(),
        old_mode: if hidden { None } else { mode(a) },
        new_mode: if hidden { None } else { mode(b) },
        content_state: state.into(),
        patch_bytes: 0,
    }
}
fn write_controlled(root: &Path, path: &str, side: &Side) -> CaptureResult<()> {
    let dest = root.join(path);
    fs::create_dir_all(dest.parent().ok_or("content_unavailable")?).map_err(unavailable)?;
    fs::write(&dest, &side.bytes).map_err(unavailable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dest, fs::Permissions::from_mode(side.mode & 0o777))
            .map_err(unavailable)?;
    }
    Ok(())
}
fn controlled_diff(root: &Path, start: Instant) -> CaptureResult<Vec<u8>> {
    let mut command = background_command("git");
    command
        .current_dir(root)
        .args([
            "-c",
            "core.quotePath=true",
            "-c",
            "diff.algorithm=myers",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames=50%",
            "-l0",
            "--unified=3",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "old",
            "new",
        ])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let mut child = command.spawn().map_err(unavailable)?;
    let stdout = child.stdout.take().ok_or("content_unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(STORAGE as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let status = loop {
        if let Some(status) = child.try_wait().map_err(unavailable)? {
            break status;
        }
        if start.elapsed() >= DEADLINE {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("content_unavailable".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader.join().map_err(unavailable)?.map_err(unavailable)?;
    if bytes.len() > STORAGE {
        return Err("resource_limit".into());
    }
    if !matches!(status.code(), Some(0 | 1)) {
        return Err("content_unavailable".into());
    }
    Ok(bytes)
}
// Quote exactly the controlled UTF-8 bytes, including tabs/newlines and quotes.
fn quote_path(prefix: &str, path: &str) -> String {
    let s = format!("{prefix}{path}");
    if s.bytes()
        .all(|b| (33..127).contains(&b) && b != b'"' && b != b'\\')
    {
        return s;
    }
    let mut result = String::from("\"");
    for b in s.bytes() {
        match b {
            b'"' => result.push_str("\\\""),
            b'\\' => result.push_str("\\\\"),
            32..=126 => result.push(b as char),
            _ => result.push_str(&format!("\\{b:03o}")),
        }
    }
    result.push('"');
    result
}
fn project(
    observation: &Observation,
    request: &PilotCaptureRequest,
    start: Instant,
) -> CaptureResult<Vec<(PilotCaptureFile, String)>> {
    let tmp = tempfile::tempdir().map_err(unavailable)?;
    let old_root = tmp.path().join("old");
    let new_root = tmp.path().join("new");
    fs::create_dir(&old_root).map_err(unavailable)?;
    fs::create_dir(&new_root).map_err(unavailable)?;
    let paths: std::collections::BTreeSet<_> = observation
        .old
        .keys()
        .chain(observation.new.keys())
        .chain(observation.union.iter())
        .collect();
    // A withheld old side can be renamed to an otherwise innocent new path.
    // Do not run secret bytes through a disk diff to discover that association.
    // Conservatively withhold all one-sided candidates in that capture instead.
    let private_rename_candidate = paths.iter().any(|path| {
        let a = observation.old.get(*path);
        let b = observation.new.get(*path);
        (a.is_none() || b.is_none()) && content_state(path, a, b, &request.secret_values) != "text"
    });
    let mut files = Vec::new();
    let mut names = BTreeMap::new();
    for (number, path) in paths.into_iter().enumerate() {
        let a = observation.old.get(path);
        let b = observation.new.get(path);
        if a == b
            && !(matches!(request.source, PilotCaptureSource::LocalTotal)
                && observation.union.contains(path))
        {
            continue;
        }
        let state = if private_rename_candidate
            && (a.is_none() || b.is_none())
            && content_state(path, a, b, &request.secret_values) == "text"
        {
            "withheld"
        } else {
            content_state(path, a, b, &request.secret_values)
        };
        if state != "text" || a == b {
            files.push((file_info(path, a, b, state), String::new()));
            continue;
        }
        let name = format!("file-{number}");
        names.insert(name.clone(), path.as_str());
        if let Some(side) = a {
            write_controlled(&old_root, &name, side)?;
        }
        if let Some(side) = b {
            write_controlled(&new_root, &name, side)?;
        }
    }
    let bytes = controlled_diff(tmp.path(), start)?;
    if !bytes.is_empty() {
        let diff = git2::Diff::from_buffer(&bytes).map_err(unavailable)?;
        for (i, delta) in diff.deltas().enumerate() {
            let old = delta
                .old_file()
                .path()
                .and_then(|p| p.strip_prefix("old").ok())
                .and_then(Path::to_str)
                .and_then(|name| names.get(name).copied());
            let new = delta
                .new_file()
                .path()
                .and_then(|p| p.strip_prefix("new").ok())
                .and_then(Path::to_str)
                .and_then(|name| names.get(name).copied());
            let old = if delta.status() == git2::Delta::Added {
                None
            } else {
                old
            };
            let new = if delta.status() == git2::Delta::Deleted {
                None
            } else {
                new
            };
            let path = new.or(old).ok_or("content_unavailable")?;
            let a = old.and_then(|p| observation.old.get(p));
            let b = new.and_then(|p| observation.new.get(p));
            let mut info = file_info(path, a, b, "text");
            info.old_path = old.map(str::to_owned);
            info.new_path = new.map(str::to_owned);
            let op = old.or(new).ok_or("content_unavailable")?;
            let np = new.or(old).ok_or("content_unavailable")?;
            let mut patch = format!(
                "diff --git {} {}\n",
                quote_path("a/", op),
                quote_path("b/", np)
            );
            if old != new && old.is_some() && new.is_some() {
                info.change = "renamed".into();
                patch.push_str(&format!(
                    "similarity index {}%\nrename from {}\nrename to {}\n",
                    {
                        let mut parsed = git2::Patch::from_diff(&diff, i)
                            .map_err(unavailable)?
                            .ok_or("content_unavailable")?;
                        let rendered = parsed.to_buf().map_err(unavailable)?;
                        let text = std::str::from_utf8(&rendered).map_err(unavailable)?;
                        text.lines()
                            .find_map(|line| {
                                line.strip_prefix("similarity index ")
                                    .and_then(|v| v.strip_suffix('%'))
                                    .and_then(|v| v.parse::<u16>().ok())
                            })
                            .ok_or("content_unavailable")?
                    },
                    quote_path("", op),
                    quote_path("", np)
                ));
            }
            match (a, b) {
                (None, Some(s)) => patch.push_str(&format!("new file mode {:06o}\n", s.mode)),
                (Some(s), None) => patch.push_str(&format!("deleted file mode {:06o}\n", s.mode)),
                (Some(a), Some(b)) if a.mode != b.mode => patch.push_str(&format!(
                    "old mode {:06o}\nnew mode {:06o}\n",
                    a.mode, b.mode
                )),
                _ => (),
            }
            if let Some(p) = git2::Patch::from_diff(&diff, i).map_err(unavailable)? {
                if p.num_hunks() > 0 {
                    patch.push_str(&format!(
                        "--- {}\n+++ {}\n",
                        if old.is_some() {
                            quote_path("a/", op)
                        } else {
                            "/dev/null".into()
                        },
                        if new.is_some() {
                            quote_path("b/", np)
                        } else {
                            "/dev/null".into()
                        }
                    ));
                }
                for h in 0..p.num_hunks() {
                    let (hunk, count) = p.hunk(h).map_err(unavailable)?;
                    // Rebuild the header to exclude arbitrary function-name suffixes.
                    patch.push_str(&format!(
                        "@@ -{},{} +{},{} @@\n",
                        hunk.old_start(),
                        hunk.old_lines(),
                        hunk.new_start(),
                        hunk.new_lines()
                    ));
                    for l in 0..count {
                        let line = p.line_in_hunk(h, l).map_err(unavailable)?;
                        if matches!(line.origin(), ' ' | '+' | '-') {
                            patch.push(line.origin());
                        }
                        patch.push_str(std::str::from_utf8(line.content()).map_err(unavailable)?);
                    }
                }
            }
            if unsafe_text(&patch, &request.secret_values) {
                info.old_path = None;
                info.new_path = None;
                info.old_mode = None;
                info.new_mode = None;
                info.content_state = "withheld".into();
                patch.clear();
            }
            info.patch_bytes = patch.len();
            files.push((info, patch));
        }
    }
    files.sort_by(|a, b| {
        a.0.old_path
            .as_ref()
            .or(a.0.new_path.as_ref())
            .cmp(&b.0.old_path.as_ref().or(b.0.new_path.as_ref()))
    });
    for (position, (file, _)) in files.iter_mut().enumerate() {
        file.position = position;
    }
    Ok(files)
}
fn policy_hash(request: &PilotCaptureRequest) -> Vec<u8> {
    let mut h = Sha256::new();
    field(&mut h, request.policy_revision.as_bytes());
    for secret in &request.secret_values {
        field(&mut h, secret.as_bytes());
    }
    h.finalize().to_vec()
}
pub(super) fn create(
    repo: &Repository,
    path: PathBuf,
    request: PilotCaptureRequest,
) -> CaptureResult<PilotCaptureInfo> {
    if request.policy_revision != "visible-1"
        || request.secret_values.len() > 4096
        || request.secret_values.iter().map(String::len).sum::<usize>() > FILE_LIMIT
    {
        return Err("validation_failed".into());
    }
    let mut budget = Budget::new();
    for attempt in 0..2 {
        let observed_at = Utc::now();
        let first = observe(repo, &request.source, &mut budget)?;
        #[cfg(test)]
        CAPTURE_HOOK.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook();
            }
        });
        let second = observe(repo, &request.source, &mut budget)?;
        if first.fingerprint != second.fingerprint {
            if attempt == 0 {
                continue;
            }
            return Err("content_unavailable".into());
        }
        let files = project(&first, &request, budget.start)?;
        if budget.start.elapsed() > DEADLINE {
            return Err("content_unavailable".into());
        }
        let info = PilotCaptureInfo {
            snapshot_id: id(),
            source: request.source.clone(),
            head_sha: first.head,
            observed_at: observed_at.to_rfc3339(),
            expires_at: (observed_at + chrono::Duration::seconds(300)).to_rfc3339(),
            export_policy_revision: request.policy_revision.clone(),
            availability: if files.iter().all(|(f, _)| f.content_state == "text") {
                "complete"
            } else {
                "partial"
            }
            .into(),
            file_count: files.len(),
        };
        let cost = files
            .iter()
            .map(|(f, p)| {
                p.len() + serde_json::to_vec(f).map(|x| x.len()).unwrap_or(STORAGE) + 1024
            })
            .sum::<usize>()
            + path.as_os_str().len()
            + 1024;
        let mut cache = cache()?;
        if cache.captures.len() >= 256
            || cache.captures.values().map(|c| c.cost).sum::<usize>() + cost > STORAGE
        {
            return Err("resource_limit".into());
        }
        let cursors = (0..files.len().div_ceil(PAGE_FILES))
            .map(|_| id())
            .collect();
        cache.captures.insert(
            info.snapshot_id.clone(),
            Capture {
                info: info.clone(),
                path,
                source: request.source.clone(),
                fingerprint: first.fingerprint,
                policy_hash: policy_hash(&request),
                files,
                cursors,
                created: budget.start,
                cost,
            },
        );
        return Ok(info);
    }
    Err("content_unavailable".into())
}

pub fn pilot_review_files(
    snapshot_id: String,
    cursor: Option<String>,
) -> CaptureResult<PilotCapturePage> {
    let cache = cache()?;
    let c = cache.captures.get(&snapshot_id).ok_or("snapshot_expired")?;
    let offset = match cursor {
        None => 0,
        Some(cursor) => {
            (c.cursors
                .iter()
                .position(|s| *s == cursor)
                .ok_or("validation_failed")?
                + 1)
                * PAGE_FILES
        }
    };
    if offset > c.files.len() {
        return Err("validation_failed".into());
    }
    let end = (offset + PAGE_FILES).min(c.files.len());
    Ok(PilotCapturePage {
        capture: c.info.clone(),
        offset,
        total: c.files.len(),
        next_cursor: if end < c.files.len() {
            c.cursors.get(end / PAGE_FILES - 1).cloned()
        } else {
            None
        },
        items: c.files[offset..end]
            .iter()
            .map(|(f, _)| f.clone())
            .collect(),
    })
}
pub fn pilot_review_read(
    snapshot_id: String,
    file_id: String,
    offset_bytes: usize,
) -> CaptureResult<PilotCaptureFragment> {
    let cache = cache()?;
    let c = cache.captures.get(&snapshot_id).ok_or("snapshot_expired")?;
    let (f, p) = c
        .files
        .iter()
        .find(|(f, _)| f.file_id == file_id)
        .ok_or("not_found")?;
    if f.content_state != "text" {
        return Err("content_unavailable".into());
    }
    if offset_bytes > p.len() || !p.is_char_boundary(offset_bytes) {
        return Err("validation_failed".into());
    }
    let mut end = (offset_bytes + FRAGMENT).min(p.len());
    while !p.is_char_boundary(end) {
        end -= 1;
    }
    Ok(PilotCaptureFragment {
        snapshot_id,
        file_id,
        offset_bytes,
        next_offset_bytes: (end < p.len()).then_some(end),
        total_bytes: p.len(),
        patch: p[offset_bytes..end].into(),
    })
}
pub fn pilot_review_release(snapshot_id: String) -> CaptureResult<()> {
    cache()?.captures.remove(&snapshot_id);
    Ok(())
}

pub(super) fn fresh(
    repo: &Repository,
    snapshot_id: &str,
    request: &PilotCaptureRequest,
) -> CaptureResult<bool> {
    let (source, fingerprint, policy) = {
        let cache = cache()?;
        let c = cache.captures.get(snapshot_id).ok_or("snapshot_expired")?;
        (
            c.source.clone(),
            c.fingerprint.clone(),
            c.policy_hash.clone(),
        )
    };
    if request.source != source || policy_hash(request) != policy {
        return Err("stale_revision".into());
    }
    let mut budget = Budget::new();
    for _ in 0..2 {
        if observe(repo, &source, &mut budget)?.fingerprint != fingerprint {
            return Err("stale_revision".into());
        }
    }
    if !cache()?.captures.contains_key(snapshot_id) {
        return Err("snapshot_expired".into());
    }
    Ok(true)
}
pub(super) fn capture_path(snapshot_id: &str) -> CaptureResult<PathBuf> {
    cache()?
        .captures
        .get(snapshot_id)
        .map(|c| c.path.clone())
        .ok_or("snapshot_expired".into())
}

#[cfg(test)]
thread_local! { static CAPTURE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = std::cell::RefCell::new(None); }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn git(path: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.name", "Capture Test"]);
        git(
            dir.path(),
            &["config", "user.email", "capture@example.invalid"],
        );
        let repo = Repository::open(dir.path()).unwrap();
        (dir, repo)
    }
    fn request(source: PilotCaptureSource) -> PilotCaptureRequest {
        PilotCaptureRequest {
            source,
            secret_values: vec!["configured-password".into()],
            policy_revision: "visible-1".into(),
        }
    }
    fn capture(repo: &Repository, source: PilotCaptureSource) -> PilotCaptureInfo {
        create(repo, repo.workdir().unwrap().to_path_buf(), request(source)).unwrap()
    }
    fn list(info: &PilotCaptureInfo) -> Vec<PilotCaptureFile> {
        let mut result = Vec::new();
        let mut cursor = None;
        loop {
            let page = pilot_review_files(info.snapshot_id.clone(), cursor).unwrap();
            result.extend(page.items);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        result
    }
    fn patch(info: &PilotCaptureInfo, file: &PilotCaptureFile) -> String {
        let mut result = String::new();
        let mut offset = 0;
        loop {
            let page =
                pilot_review_read(info.snapshot_id.clone(), file.file_id.clone(), offset).unwrap();
            assert!(page.patch.len() <= FRAGMENT);
            result.push_str(&page.patch);
            match page.next_offset_bytes {
                Some(next) => {
                    assert_eq!(next, offset + page.patch.len());
                    offset = next;
                }
                None => break,
            }
        }
        assert_eq!(result.len(), file.patch_bytes);
        result
    }
    fn commit(dir: &Path) -> String {
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "test"]);
        git(dir, &["rev-parse", "HEAD"]).trim().into()
    }
    #[test]
    fn sources_unborn_and_cancellation_are_distinct_without_git_mutations() {
        let (dir, repo) = repo();
        let p = dir.path();
        fs::write(p.join("a.txt"), "base\n").unwrap();
        let unborn = capture(&repo, PilotCaptureSource::Unstaged);
        assert_eq!(unborn.head_sha, None);
        assert_eq!(unborn.file_count, 1);
        let base = commit(p);
        fs::write(p.join("a.txt"), "staged\n").unwrap();
        git(p, &["add", "."]);
        fs::write(p.join("a.txt"), "base\n").unwrap();
        fs::write(p.join("new.txt"), "untracked\n").unwrap();
        let before = fs::read(repo.path().join("index")).unwrap();
        let status = git(p, &["status", "--porcelain=v1"]);
        let staged = capture(&repo, PilotCaptureSource::Staged);
        assert!(patch(&staged, &list(&staged)[0]).contains("+staged"));
        let unstaged = capture(&repo, PilotCaptureSource::Unstaged);
        assert_eq!(unstaged.file_count, 2);
        assert!(list(&unstaged)
            .iter()
            .any(|f| patch(&unstaged, f).contains("-staged")));
        let total = capture(&repo, PilotCaptureSource::LocalTotal);
        assert_eq!(total.file_count, 2);
        assert!(list(&total).iter().any(|f| f.change == "unchanged"));
        assert_eq!(before, fs::read(repo.path().join("index")).unwrap());
        assert_eq!(status, git(p, &["status", "--porcelain=v1"]));
        let head = commit(p);
        let commits = capture(
            &repo,
            PilotCaptureSource::Commits {
                base_sha: base,
                head_sha: head,
            },
        );
        assert_eq!(commits.file_count, 1);
        fs::write(p.join("new.txt"), "later\n").unwrap();
        assert!(fresh(
            &repo,
            &commits.snapshot_id,
            &request(commits.source.clone())
        )
        .unwrap());
    }
    #[test]
    fn rename_modes_no_newline_and_special_paths_are_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, repo) = repo();
        let p = dir.path();
        fs::write(p.join("old name.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        fs::write(p.join("mode"), "same\n").unwrap();
        commit(p);
        fs::rename(p.join("old name.txt"), p.join("new\t\"é.txt")).unwrap();
        fs::write(p.join("new\t\"é.txt"), "one\ntwo\nthree\nfour\nfive\nseven").unwrap();
        fs::set_permissions(p.join("mode"), fs::Permissions::from_mode(0o755)).unwrap();
        let info = capture(&repo, PilotCaptureSource::LocalTotal);
        let files = list(&info);
        assert_eq!(files.len(), 2);
        let renamed = files.iter().find(|f| f.change == "renamed").unwrap();
        let text = patch(&info, renamed);
        assert!(text.contains("rename from"));
        assert!(text.contains("No newline at end of file"));
        assert!(!text.contains("similarity index 100%"));
        let mode = files
            .iter()
            .find(|f| f.new_path.as_deref() == Some("mode"))
            .unwrap();
        assert_eq!(mode.new_mode.as_deref(), Some("100755"));
        assert!(patch(&info, mode).contains("old mode 100644\nnew mode 100755"));
    }
    #[test]
    fn immutable_utf8_pages_and_same_length_mutation_freshness() {
        let (dir, repo) = repo();
        let p = dir.path();
        fs::write(p.join("a"), "initial\n").unwrap();
        commit(p);
        let body = "é🙂 fin\n".repeat(6000);
        fs::write(p.join("a"), &body).unwrap();
        let info = capture(&repo, PilotCaptureSource::Unstaged);
        let file = list(&info).remove(0);
        let expected = patch(&info, &file);
        assert!(expected.len() > FRAGMENT * 2);
        let stamp = fs::metadata(p.join("a")).unwrap().modified().unwrap();
        fs::write(p.join("a"), body.replace("fin", "new")).unwrap();
        fs::File::options()
            .write(true)
            .open(p.join("a"))
            .unwrap()
            .set_modified(stamp)
            .unwrap();
        assert_eq!(patch(&info, &file), expected);
        assert_eq!(
            fresh(&repo, &info.snapshot_id, &request(info.source.clone())).unwrap_err(),
            "stale_revision"
        );
        assert!(pilot_review_read(
            info.snapshot_id.clone(),
            file.file_id,
            expected.find('é').unwrap() + 1
        )
        .is_err());
    }
    #[test]
    fn secrets_binary_symlink_large_and_submodule_remain_visible_as_limits() {
        use std::os::unix::fs::symlink;
        let (dir, repo) = repo();
        let p = dir.path();
        fs::write(p.join("base"), "base\n").unwrap();
        commit(p);
        fs::write(p.join(".env.local"), "private\n").unwrap();
        fs::write(p.join("safe"), "configured-password\n").unwrap();
        fs::write(p.join("binary"), [0, 1, 2]).unwrap();
        symlink("/nonexistent/private", p.join("link")).unwrap();
        fs::write(p.join("big"), vec![b'a'; FILE_LIMIT + 1]).unwrap();
        let info = capture(&repo, PilotCaptureSource::Unstaged);
        assert_eq!(info.availability, "partial");
        let files = list(&info);
        assert_eq!(files.len(), 5);
        assert_eq!(
            files
                .iter()
                .filter(|f| f.content_state == "withheld" && f.new_path.is_none())
                .count(),
            2
        );
        for f in files {
            assert_eq!(f.patch_bytes, 0);
            assert_eq!(
                pilot_review_read(info.snapshot_id.clone(), f.file_id, 0)
                    .err()
                    .as_deref(),
                Some("content_unavailable")
            );
        }
        fs::write(p.join("safe"), "changed-password!!!\n").unwrap();
        assert!(fresh(&repo, &info.snapshot_id, &request(info.source.clone())).is_err());
        let (subdir, _) = self::repo();
        fs::write(subdir.path().join("nested"), "nested\n").unwrap();
        commit(subdir.path());
        git(
            p,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                subdir.path().to_str().unwrap(),
                "sub",
            ],
        );
        let sub = capture(&repo, PilotCaptureSource::Staged);
        assert!(list(&sub).iter().any(|f| f.content_state == "submodule"));
    }
    #[test]
    fn credential_rename_never_exports_the_other_path_or_bytes() {
        let (dir, repo) = repo();
        fs::write(dir.path().join(".env"), "innocent-looking-value\n").unwrap();
        commit(dir.path());
        fs::rename(dir.path().join(".env"), dir.path().join("public.txt")).unwrap();
        let info = capture(&repo, PilotCaptureSource::LocalTotal);
        let files = list(&info);
        assert!(files.iter().all(|f| f.content_state == "withheld"
            && f.old_path.is_none()
            && f.new_path.is_none()));
        assert!(!serde_json::to_string(&files)
            .unwrap()
            .contains("public.txt"));
    }
    #[test]
    fn mutation_during_capture_retries_once_then_fails() {
        let (dir, repo) = repo();
        let path = dir.path().join("a");
        fs::write(&path, "before\n").unwrap();
        let changed = path.clone();
        let mut count = 0;
        CAPTURE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                count += 1;
                if count == 1 {
                    fs::write(&changed, "after!\n").unwrap();
                }
            }))
        });
        let info = capture(&repo, PilotCaptureSource::Unstaged);
        CAPTURE_HOOK.with(|hook| *hook.borrow_mut() = None);
        assert!(patch(&info, &list(&info)[0]).contains("+after!"));
        let mut toggle = false;
        CAPTURE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                toggle = !toggle;
                fs::write(&path, if toggle { "other!\n" } else { "after!\n" }).unwrap();
            }))
        });
        let result = create(
            &repo,
            dir.path().into(),
            request(PilotCaptureSource::Unstaged),
        );
        CAPTURE_HOOK.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(result.err().as_deref(), Some("content_unavailable"));
    }
    #[test]
    fn complete_catalog_cursor_binding_release_expiry_and_budget() {
        let (dir, repo) = repo();
        for n in 0..25 {
            fs::write(dir.path().join(format!("f{n}")), "x\n").unwrap();
        }
        let a = capture(&repo, PilotCaptureSource::Unstaged);
        let b = capture(&repo, PilotCaptureSource::Unstaged);
        assert_eq!(list(&a).len(), 25);
        let first = pilot_review_files(a.snapshot_id.clone(), None).unwrap();
        assert_eq!(first.items.len(), PAGE_FILES);
        assert!(pilot_review_files(b.snapshot_id.clone(), first.next_cursor).is_err());
        pilot_review_release(a.snapshot_id.clone()).unwrap();
        assert_eq!(
            pilot_review_files(a.snapshot_id, None).err().as_deref(),
            Some("snapshot_expired")
        );
        cache()
            .unwrap()
            .captures
            .get_mut(&b.snapshot_id)
            .unwrap()
            .created = Instant::now() - TTL;
        assert_eq!(
            pilot_review_files(b.snapshot_id, None).err().as_deref(),
            Some("snapshot_expired")
        );
        let c = capture(&repo, PilotCaptureSource::Unstaged);
        cache()
            .unwrap()
            .captures
            .get_mut(&c.snapshot_id)
            .unwrap()
            .cost = STORAGE;
        assert_eq!(
            create(
                &repo,
                dir.path().into(),
                request(PilotCaptureSource::Unstaged)
            )
            .err()
            .as_deref(),
            Some("resource_limit")
        );
        pilot_review_release(c.snapshot_id).unwrap();
    }
}
