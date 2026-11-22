//! Read existing Macro metadata without creating or repairing a checkout.
use super::{MACRO_BRANCH_NAME, MACRO_WORKTREE_DIR_NAME, MACRO_WORKTREE_NAME};
use git2::{ErrorCode, Oid, Repository, RepositoryOpenFlags, Tree};
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

type ReadResult<T> = Result<T, String>;

#[derive(PartialEq, Eq)]
pub(crate) enum EntryKind {
    Directory,
    File,
    Unsupported,
}

pub(crate) fn disk_kind(path: &Path) -> ReadResult<Option<EntryKind>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(Some(EntryKind::Directory)),
        Ok(metadata) if metadata.is_file() => Ok(Some(EntryKind::File)),
        Ok(_) => Ok(Some(EntryKind::Unsupported)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_git_pointer(file: &Path, prefix: &str, base: &Path) -> ReadResult<PathBuf> {
    if disk_kind(file)? != Some(EntryKind::File) {
        return Err("Expected a regular Git pointer file".into());
    }
    let text = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let path = text
        .trim()
        .strip_prefix(prefix)
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.contains(['\n', '\r']))
        .ok_or("Invalid Git pointer")?;
    base.join(path)
        .canonicalize()
        .map_err(|error| error.to_string())
}

fn linked_git_dirs(
    worktree: &Path,
    admin: PathBuf,
    expected_admin: Option<&Path>,
) -> ReadResult<(PathBuf, PathBuf)> {
    let gitfile = worktree.join(".git");
    if expected_admin.is_some_and(|expected| admin != expected) {
        return Err("Metadata checkout is outside this repository's Macro registration".into());
    }
    // Git registers linked checkouts under <common>/worktrees/<name>.
    let common = admin
        .parent()
        .filter(|parent| parent.ends_with("worktrees"))
        .and_then(Path::parent)
        .ok_or("Git pointer is outside the worktree registrations")?;
    if read_git_pointer(&admin.join("commondir"), "", &admin)? != common
        || read_git_pointer(&admin.join("gitdir"), "", &admin)? != gitfile
    {
        return Err("Git worktree registration does not point back to this checkout".into());
    }
    let common = common.to_path_buf();
    Ok((admin, common))
}

fn open_git_checkout(path: &Path, admin: &Path, common: &Path) -> ReadResult<Repository> {
    if disk_kind(&admin.join("HEAD"))? != Some(EntryKind::File) {
        return Err("Expected a regular Git HEAD file".into());
    }
    let repo = Repository::open_ext(
        path,
        RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .map_err(|error| error.to_string())?;
    let canonical = |path: &Path| path.canonicalize().map_err(|error| error.to_string());
    if canonical(repo.path())? != admin
        || canonical(repo.commondir())? != common
        || !repo
            .workdir()
            .and_then(|dir| canonical(dir).ok())
            .is_some_and(|dir| dir == path)
        || repo.is_worktree() != (admin != common)
    {
        return Err("Git repository does not match this checkout".into());
    }
    Ok(repo)
}

fn open_git_submodule(path: &Path, admin: &Path) -> ReadResult<Repository> {
    let mut superproject = None;
    for parent in path.ancestors().skip(1) {
        if let Some(repo) = open_git_workspace(parent)? {
            superproject = Some((parent, repo));
            break;
        }
    }
    let (parent, repo) = superproject.ok_or("Git pointer has no enclosing superproject")?;
    let relative = path
        .strip_prefix(parent)
        .expect("superproject is an ancestor");
    let modules_file = parent.join(".gitmodules");
    if disk_kind(&modules_file)? != Some(EntryKind::File)
        || !repo
            .index()
            .map_err(|error| error.to_string())?
            .get_path(relative, 0)
            .is_some_and(|entry| entry.mode == 0o160000)
    {
        return Err("Git pointer is not registered as a submodule in the superproject".into());
    }

    let modules = repo
        .path()
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join("modules");
    let name = admin
        .strip_prefix(&modules)
        .ok()
        .and_then(Path::to_str)
        .filter(|name| !name.is_empty())
        .ok_or("Git pointer is outside the superproject's submodule registrations")?
        .replace(std::path::MAIN_SEPARATOR, "/");
    let gitmodules = git2::Config::open(&modules_file).map_err(|error| error.to_string())?;
    let registered_path = gitmodules
        .get_string(&format!("submodule.{name}.path"))
        .map_err(|error| error.to_string())?;
    if Path::new(&registered_path) != relative {
        return Err("Git submodule registration does not match this checkout".into());
    }
    // The registered admin directory and each directory below the verified
    // superproject must be real directories, even if a symlink stays inside it.
    let mut registered_admin = modules;
    if disk_kind(&registered_admin)? != Some(EntryKind::Directory) {
        return Err("Expected a physical submodule registrations directory".into());
    }
    for part in Path::new(&name) {
        registered_admin.push(part);
        if disk_kind(&registered_admin)? != Some(EntryKind::Directory) {
            return Err("Expected a physical submodule admin directory".into());
        }
    }
    open_git_checkout(path, admin, admin)
}

pub(crate) fn open_git_workspace(path: &Path) -> ReadResult<Option<Repository>> {
    let dot_git = path.join(".git");
    match disk_kind(&dot_git)? {
        None => Ok(None),
        Some(EntryKind::Directory) if disk_kind(&dot_git.join("commondir"))?.is_none() => {
            open_git_checkout(path, &dot_git, &dot_git).map(Some)
        }
        Some(EntryKind::File) => {
            let admin = read_git_pointer(&dot_git, "gitdir:", path)?;
            if admin
                .parent()
                .is_some_and(|parent| parent.ends_with("worktrees"))
                && disk_kind(&admin.join("commondir"))? == Some(EntryKind::File)
            {
                let (admin, common) = linked_git_dirs(path, admin, None)?;
                return open_git_checkout(path, &admin, &common).map(Some);
            }
            open_git_submodule(path, &admin).map(Some)
        }
        _ => Err("Expected a local .git directory or a registered checkout".into()),
    }
}

fn is_metadata_checkout(path: &Path, common: &Path) -> ReadResult<bool> {
    match disk_kind(path)? {
        None => return Ok(false),
        Some(EntryKind::Directory) => {}
        _ => return Err("Expected a metadata worktree directory".into()),
    }
    if fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        return Ok(false);
    }
    let expected_admin = common.join("worktrees").join(MACRO_WORKTREE_NAME);
    let admin = read_git_pointer(&path.join(".git"), "gitdir:", path)?;
    let (admin, _) = linked_git_dirs(path, admin, Some(&expected_admin))?;
    let reference = macro_reference();
    let repo = open_git_checkout(path, &admin, common)?;
    let head = repo
        .find_reference("HEAD")
        .map_err(|error| error.to_string())?;
    if head.symbolic_target().map_err(|error| error.to_string())? != Some(reference.as_str()) {
        return Err("Metadata checkout is on a branch other than @macro".into());
    }
    let branch = repo
        .find_reference(&reference)
        .map_err(|error| error.to_string())?;
    if branch.target().is_none() {
        return Err("Expected @macro to be a direct Git reference".into());
    }
    Ok(true)
}

pub(crate) fn tree_entry(
    tree: &Tree<'_>,
    path: &Path,
) -> ReadResult<Option<git2::TreeEntry<'static>>> {
    match tree.get_path(path) {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn macro_reference() -> String {
    format!("refs/heads/{MACRO_BRANCH_NAME}")
}

pub(crate) fn macro_metadata_checkouts(
    repo: &Repository,
) -> ReadResult<Vec<(PathBuf, ReadResult<bool>)>> {
    let canonical = |path: &Path| path.canonicalize().map_err(|error| error.to_string());
    let common = canonical(repo.commondir())?;
    let admin = canonical(repo.path())?;
    Ok(BTreeSet::from([admin, common.clone()])
        .into_iter()
        .map(|admin| {
            let path = admin.join(MACRO_WORKTREE_DIR_NAME);
            let checked = is_metadata_checkout(&path, &common);
            (path, checked)
        })
        .collect())
}

pub(crate) fn local_macro_tree(repo: &Repository) -> ReadResult<Option<(Oid, Tree<'_>)>> {
    let metadata_ref = match repo.find_reference(&macro_reference()) {
        Ok(reference) => reference,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let tip = metadata_ref
        .target()
        .ok_or("Expected @macro to be a direct Git reference")?;
    let commit = repo.find_commit(tip).map_err(|error| error.to_string())?;
    let tree = commit.tree().map_err(|error| error.to_string())?;
    Ok(Some((tip, tree)))
}

pub(crate) fn read_tree_file(
    repo: &Repository,
    tree: &Tree<'_>,
    path: &Path,
) -> ReadResult<Option<String>> {
    let Some(entry) = tree_entry(tree, path)? else {
        return Ok(None);
    };
    if !matches!(entry.filemode(), 0o100644 | 0o100755) {
        return Err("Expected a regular Git blob".into());
    }
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    std::str::from_utf8(blob.content())
        .map(|text| Some(text.to_owned()))
        .map_err(|error| error.to_string())
}
