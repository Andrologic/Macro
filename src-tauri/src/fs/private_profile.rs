//! The desktop profile is reached through typed services and recovery commands.
use super::{nearest_existing_ancestor, normalize_path, path_is_same_or_descendant};
use crate::core::error::{BackendError, Result};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct PrivateProfile {
    data: [PathBuf; 2],
    workspace: [PathBuf; 2],
    other: Vec<PathBuf>,
}

static PROFILE: OnceLock<PrivateProfile> = OnceLock::new();

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
    PROFILE
        .set(PrivateProfile {
            data,
            workspace,
            other,
        })
        .map_err(|_| BackendError::Internal {
            message: "The private profile guard is already installed.".into(),
        })
}

pub(super) fn installed() -> bool {
    PROFILE.get().is_some()
}

fn denied() -> BackendError {
    BackendError::FilesystemPermissionDenied {
        message: "Generic filesystem access to the private Macro profile is denied.".into(),
    }
}

fn check_visible(path: &Path, tree: bool) -> Result<()> {
    let Some(profile) = PROFILE.get() else {
        return Ok(());
    };
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

/// Read outside a workspace through the same resolved path that was checked.
pub(super) fn public_read_path(path: PathBuf) -> Result<PathBuf> {
    if !installed() {
        return Ok(path);
    }
    check_visible(&path, false)?;
    let path = resolved(&path)?;
    check_visible(&path, false)?;
    Ok(path)
}
