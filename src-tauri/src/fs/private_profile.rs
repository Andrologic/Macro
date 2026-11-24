//! The desktop profile is reached through typed services and recovery commands.
//!
//! Generic file commands refuse Macro's private profile (credential store,
//! database, backups, configuration, caches, and logs) in two ways:
//!
//! - by location: the physical path of every handle a command opens is
//!   compared with the private roots ([`check_normalized`]);
//! - by identity: a regular file with more than one hard link is compared,
//!   by device and inode (volume and file index on Windows), with the files
//!   stored under the private roots ([`LinkedPrivateFiles`]). A hard link
//!   keeps its workspace path, so only its identity reveals the private file.
use super::confined::{os, HandleFacts};
use super::{nearest_existing_ancestor, normalize_path, path_is_same_or_descendant};
use crate::core::error::{BackendError, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

struct PrivateProfile {
    data: [PathBuf; 2],
    workspace: [PathBuf; 2],
    other: Vec<PathBuf>,
}

/// Production installs exactly one profile. Tests install one per fixture;
/// their temporary roots never overlap, so the union keeps each test exact.
static PROFILES: RwLock<Vec<Arc<PrivateProfile>>> = RwLock::new(Vec::new());

/// A scan of private files stops here and refuses the object instead.
const MAX_PRIVATE_SCAN_ENTRIES: usize = 200_000;

fn profiles() -> Vec<Arc<PrivateProfile>> {
    PROFILES
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn resolved(path: &Path) -> Result<PathBuf> {
    let (ancestor, canonical) = nearest_existing_ancestor(path)?;
    Ok(normalize_path(
        &canonical.join(path.strip_prefix(ancestor).map_err(|_| {
            BackendError::FilesystemInvalidPath {
                message: "Cannot resolve the filesystem path.".into(),
            }
        })?),
    ))
}

fn aliases(path: &Path) -> Result<[PathBuf; 2]> {
    let path = absolute(path)?;
    Ok([normalize_path(&path), resolved(&path)?])
}

pub(crate) fn install(data: &Path, config: &[&Path]) -> Result<()> {
    let data = aliases(data)?;
    let workspace = data.each_ref().map(|root| root.join("workspace"));
    let mut other = Vec::new();
    for path in config {
        for alias in aliases(path)? {
            if !data.contains(&alias) && !other.contains(&alias) {
                other.push(alias);
            }
        }
    }
    let mut installed = PROFILES
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cfg!(not(test)) && !installed.is_empty() {
        return Err(BackendError::Internal {
            message: "The private profile guard is already installed.".into(),
        });
    }
    installed.push(Arc::new(PrivateProfile {
        data,
        workspace,
        other,
    }));
    Ok(())
}

pub(super) fn installed() -> bool {
    !PROFILES
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_empty()
}

fn denied() -> BackendError {
    BackendError::FilesystemPermissionDenied {
        message: "Generic filesystem access to the private Macro profile is denied.".into(),
    }
}

fn check_visible(path: &Path, tree: bool) -> Result<()> {
    for profile in profiles() {
        let contains = |root| tree && path_is_same_or_descendant(root, path);
        let protected = |root| path_is_same_or_descendant(path, root) || contains(root);
        if profile.other.iter().any(|root| protected(root))
            || profile
                .data
                .iter()
                .zip(&profile.workspace)
                .any(|(data, workspace)| {
                    contains(data)
                        || (path_is_same_or_descendant(path, data)
                            && !path_is_same_or_descendant(path, workspace))
                })
        {
            return Err(denied());
        }
    }
    Ok(())
}

/// Paths already normalized or resolved by workspace validation or a directory walker.
pub(super) fn check_normalized(path: &Path) -> Result<()> {
    check_visible(path, false)
}

/// Check both the requested location and its resolved aliases, even before creation.
pub(super) fn check(path: &Path) -> Result<()> {
    check_path(path, false)
}

/// A rename or recursive deletion also has authority over the target's children.
pub(super) fn check_tree(path: &Path) -> Result<()> {
    check_path(path, true)
}

fn check_path(path: &Path, tree: bool) -> Result<()> {
    if installed() {
        let path = absolute(path)?;
        check_visible(&normalize_path(&path), tree)?;
        check_visible(&resolved(&path)?, tree)?;
    }
    Ok(())
}

/// Identities of hard-linked private files, scanned lazily once per operation
/// and per volume. Hard links cannot cross volumes, so only objects on the
/// same volume can match.
#[derive(Default)]
pub(crate) struct LinkedPrivateFiles {
    volumes: HashMap<u64, Option<HashSet<u64>>>,
}

impl LinkedPrivateFiles {
    /// Admit an open object whose physical location is `real`.
    pub(crate) fn admit(&mut self, real: &Path, facts: &HandleFacts) -> Result<()> {
        self.admit_with(real, facts, false)
    }

    /// Admit an open directory whose whole subtree is about to be removed.
    pub(crate) fn admit_tree(&mut self, real: &Path, facts: &HandleFacts) -> Result<()> {
        self.admit_with(real, facts, true)
    }

    fn admit_with(&mut self, real: &Path, facts: &HandleFacts, tree: bool) -> Result<()> {
        check_visible(real, tree)?;
        if !facts.is_file || facts.links <= 1 || !installed() {
            return Ok(());
        }
        let linked = self
            .volumes
            .entry(facts.identity.volume)
            .or_insert_with(|| scan_linked_private_files(facts.identity.volume));
        match linked {
            Some(linked) if !linked.contains(&facts.identity.index) => Ok(()),
            // An incomplete scan cannot prove that the object is public.
            _ => Err(denied()),
        }
    }
}

fn scan_roots() -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut roots: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for profile in profiles() {
        // The default workspace below the data root holds user files.
        for (data, workspace) in profile.data.iter().zip(&profile.workspace) {
            roots.push((data.clone(), vec![workspace.clone()]));
        }
        for other in &profile.other {
            roots.push((other.clone(), Vec::new()));
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn scan_linked_private_files(volume: u64) -> Option<HashSet<u64>> {
    let mut linked = HashSet::new();
    let mut visited = 0usize;
    for (root, excluded) in scan_roots() {
        match std::fs::symlink_metadata(&root) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
        let entries = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .same_file_system(true)
            .into_iter()
            .filter_entry(|entry| {
                !excluded
                    .iter()
                    .any(|excluded| path_is_same_or_descendant(entry.path(), excluded))
            });
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error)
                    if error.io_error().map(std::io::Error::kind)
                        == Some(std::io::ErrorKind::NotFound) =>
                {
                    continue
                }
                Err(_) => return None,
            };
            visited += 1;
            if visited > MAX_PRIVATE_SCAN_ENTRIES {
                return None;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            match os::path_facts(entry.path()) {
                Ok(facts) if facts.identity.volume == volume && facts.links > 1 => {
                    linked.insert(facts.identity.index);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return None,
            }
        }
    }
    Some(linked)
}
