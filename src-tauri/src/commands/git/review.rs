use super::*;
use crate::fs::get_file_language;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Component;

const MAX_REVIEW_INLINE_BYTES: usize = 200 * 1024;

#[derive(Clone)]
struct ReviewFileSide {
    exists: bool,
    content: String,
    is_binary: bool,
    too_large: bool,
}

impl ReviewFileSide {
    fn absent() -> Self {
        Self {
            exists: false,
            content: String::new(),
            is_binary: false,
            too_large: false,
        }
    }
}

fn bytes_to_review_side(bytes: Option<Vec<u8>>) -> ReviewFileSide {
    let Some(bytes) = bytes else {
        return ReviewFileSide::absent();
    };

    let is_binary = bytes.contains(&0);
    let too_large = bytes.len() > MAX_REVIEW_INLINE_BYTES;
    let content = if is_binary || too_large {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    ReviewFileSide {
        exists: true,
        content,
        is_binary,
        too_large,
    }
}

fn blob_to_review_side(blob: &git2::Blob<'_>) -> ReviewFileSide {
    if blob.size() > MAX_REVIEW_INLINE_BYTES {
        return ReviewFileSide {
            exists: true,
            content: String::new(),
            is_binary: blob.is_binary(),
            too_large: true,
        };
    }
    bytes_to_review_side(Some(blob.content().to_vec()))
}

fn read_blob_header(repo: &Repository, oid: git2::Oid, operation: &str) -> Result<usize> {
    let odb = repo.odb().map_err(|error| {
        BackendError::git_object_missing(error, Some(oid.to_string()), Some(operation.to_string()))
    })?;
    let (size, kind) = odb.read_header(oid).map_err(|error| {
        BackendError::git_object_missing(error, Some(oid.to_string()), Some(operation.to_string()))
    })?;
    if kind != git2::ObjectType::Blob {
        return Err(BackendError::Git {
            message: format!("Expected Git blob {oid} while building review."),
        });
    }
    Ok(size)
}

fn read_head_file_side(repo: &Repository, relative_path: &Path) -> Result<ReviewFileSide> {
    let Some(commit) = get_head_commit(repo)? else {
        return Ok(ReviewFileSide::absent());
    };

    let tree_id = commit.tree_id();
    let tree = commit.tree().map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(tree_id.to_string()),
            Some("review_head_tree".to_string()),
        )
    })?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(error)
            if error.class() == git2::ErrorClass::Odb
                && error.code() == git2::ErrorCode::NotFound =>
        {
            return Err(BackendError::git_object_missing(
                error,
                None,
                Some("review_head_path".to_string()),
            ));
        }
        Err(_) => return Ok(ReviewFileSide::absent()),
    };
    let entry_id = entry.id();
    if read_blob_header(repo, entry_id, "review_head_blob")? > MAX_REVIEW_INLINE_BYTES {
        return Ok(ReviewFileSide {
            exists: true,
            content: String::new(),
            is_binary: false,
            too_large: true,
        });
    }
    let object = entry.to_object(repo).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry_id.to_string()),
            Some("review_head_blob".to_string()),
        )
    })?;
    let Some(blob) = object.as_blob() else {
        return Ok(ReviewFileSide::absent());
    };

    Ok(blob_to_review_side(blob))
}

fn read_index_file_side(repo: &Repository, relative_path: &Path) -> Result<ReviewFileSide> {
    let mut index = repo.index()?;
    index.read(true)?;
    let Some(entry) = index.get_path(relative_path, 0) else {
        return Ok(ReviewFileSide::absent());
    };

    if read_blob_header(repo, entry.id, "review_index_blob")? > MAX_REVIEW_INLINE_BYTES {
        return Ok(ReviewFileSide {
            exists: true,
            content: String::new(),
            is_binary: false,
            too_large: true,
        });
    }
    let blob = repo.find_blob(entry.id).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry.id.to_string()),
            Some("review_index_blob".to_string()),
        )
    })?;
    Ok(blob_to_review_side(&blob))
}

struct InspectedWorktreeEntry {
    parent: CapabilityDir,
    file_name: OsString,
    metadata: cap_std::fs::Metadata,
}

#[cfg(windows)]
fn review_metadata_is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn review_metadata_is_reparse_point(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

fn open_review_worktree(repo_root: &Path) -> Result<CapabilityDir> {
    let canonical_root = repo_root.canonicalize().map_err(|error| BackendError::Io {
        message: format!("Failed to resolve review worktree: {error}"),
        source: error,
    })?;
    CapabilityDir::open_ambient_dir(&canonical_root, ambient_authority()).map_err(|error| {
        BackendError::Io {
            message: format!("Failed to retain review worktree: {error}"),
            source: error,
        }
    })
}

fn inspect_worktree_entry(
    root: &CapabilityDir,
    relative_path: &Path,
) -> Result<Option<InspectedWorktreeEntry>> {
    let mut parent = root.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain review worktree: {error}"),
        source: error,
    })?;
    let mut components = relative_path.components().peekable();
    while let Some(component) = components.next() {
        let std::path::Component::Normal(segment) = component else {
            return Err(BackendError::Validation(
                "Review path must remain inside the worktree.".to_string(),
            ));
        };
        let metadata = match parent.symlink_metadata(segment) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to inspect review worktree entry {:?}: {}",
                        relative_path, error
                    ),
                    source: error,
                })
            }
        };
        let is_symlink = metadata.file_type().is_symlink();
        let is_reparse_point = review_metadata_is_reparse_point(&metadata);
        if components.peek().is_some() && (is_symlink || is_reparse_point) {
            return Err(BackendError::Validation(
                "Review path crosses a linked directory.".to_string(),
            ));
        }
        if components.peek().is_none() {
            if is_reparse_point && !is_symlink {
                return Err(BackendError::Validation(
                    "Review path resolves to an unsupported linked entry.".to_string(),
                ));
            }
            return Ok(Some(InspectedWorktreeEntry {
                parent,
                file_name: segment.to_os_string(),
                metadata,
            }));
        }
        parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
            message: format!(
                "Failed to retain review worktree parent {:?}: {error}",
                relative_path
            ),
            source: error,
        })?;
    }
    Ok(None)
}

fn open_review_regular_file(entry: &InspectedWorktreeEntry) -> std::io::Result<cap_std::fs::File> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = entry.parent.open_with(&entry.file_name, &options)?;
    let metadata = file.metadata()?;
    if metadata.file_type().is_symlink() || review_metadata_is_reparse_point(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Review file changed to a linked entry.",
        ));
    }
    Ok(file)
}

fn read_worktree_file_side(
    worktree: &CapabilityDir,
    relative_path: &Path,
) -> Result<ReviewFileSide> {
    let Some(entry) = inspect_worktree_entry(worktree, relative_path)? else {
        return Ok(ReviewFileSide::absent());
    };

    if entry.metadata.file_type().is_symlink() {
        let target = entry
            .parent
            .read_link_contents(&entry.file_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to read review worktree link {:?}: {}",
                    relative_path, error
                ),
                source: error,
            })?;
        if link_target_escapes_worktree(relative_path, &target) {
            return Ok(bytes_to_review_side(Some(
                b"[external link target]".to_vec(),
            )));
        }
        return Ok(bytes_to_review_side(Some(
            target.to_string_lossy().as_bytes().to_vec(),
        )));
    }
    if !entry.metadata.is_file() {
        return Ok(ReviewFileSide::absent());
    }

    match open_review_regular_file(&entry) {
        Ok(file) => {
            let mut bytes = Vec::with_capacity(
                entry
                    .metadata
                    .len()
                    .min((MAX_REVIEW_INLINE_BYTES + 1) as u64) as usize,
            );
            file.take((MAX_REVIEW_INLINE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| BackendError::Io {
                    message: format!(
                        "Failed to read review worktree file {:?}: {error}",
                        relative_path
                    ),
                    source: error,
                })?;
            Ok(bytes_to_review_side(Some(bytes)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ReviewFileSide::absent()),
        Err(error) => Err(BackendError::Io {
            message: format!(
                "Failed to open review worktree file {:?}: {}",
                relative_path, error
            ),
            source: error,
        }),
    }
}

fn link_target_escapes_worktree(relative_path: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return true;
    }
    let mut depth = relative_path
        .parent()
        .map(|parent| {
            parent
                .components()
                .filter(|component| matches!(component, Component::Normal(_)))
                .count()
        })
        .unwrap_or(0);
    for component in target.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return true,
            Component::ParentDir if depth == 0 => return true,
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
        }
    }
    false
}

fn split_review_lines(value: &str) -> Vec<&str> {
    if value.is_empty() {
        Vec::new()
    } else {
        value.split('\n').collect()
    }
}

#[derive(Clone, Copy)]
enum ReviewDiffOp<'a> {
    Equal(&'a str),
    Remove(&'a str),
    Add(&'a str),
}

fn build_review_diff_ops<'a>(left: &'a [&'a str], right: &'a [&'a str]) -> Vec<ReviewDiffOp<'a>> {
    let cell_count = left
        .len()
        .saturating_add(1)
        .saturating_mul(right.len().saturating_add(1));
    if cell_count > 1_000_000 {
        let mut operations = Vec::with_capacity(left.len() + right.len());
        operations.extend(left.iter().map(|line| ReviewDiffOp::Remove(line)));
        operations.extend(right.iter().map(|line| ReviewDiffOp::Add(line)));
        return operations;
    }

    let mut table = vec![vec![0usize; right.len() + 1]; left.len() + 1];
    for left_index in (0..left.len()).rev() {
        for right_index in (0..right.len()).rev() {
            table[left_index][right_index] = if left[left_index] == right[right_index] {
                table[left_index + 1][right_index + 1] + 1
            } else {
                table[left_index + 1][right_index].max(table[left_index][right_index + 1])
            };
        }
    }

    let mut operations = Vec::new();
    let mut left_index = 0usize;
    let mut right_index = 0usize;

    while left_index < left.len() && right_index < right.len() {
        if left[left_index] == right[right_index] {
            operations.push(ReviewDiffOp::Equal(left[left_index]));
            left_index += 1;
            right_index += 1;
        } else if table[left_index + 1][right_index] >= table[left_index][right_index + 1] {
            operations.push(ReviewDiffOp::Remove(left[left_index]));
            left_index += 1;
        } else {
            operations.push(ReviewDiffOp::Add(right[right_index]));
            right_index += 1;
        }
    }

    while left_index < left.len() {
        operations.push(ReviewDiffOp::Remove(left[left_index]));
        left_index += 1;
    }
    while right_index < right.len() {
        operations.push(ReviewDiffOp::Add(right[right_index]));
        right_index += 1;
    }

    operations
}

fn build_review_diff(original_content: &str, modified_content: &str) -> GitReviewParsedDiffDto {
    let left = split_review_lines(original_content);
    let right = split_review_lines(modified_content);
    let operations = build_review_diff_ops(&left, &right);
    let mut lines = Vec::new();
    let mut additions = 0u32;
    let mut deletions = 0u32;
    let mut old_line_number = 1u32;
    let mut new_line_number = 1u32;

    for operation in operations {
        match operation {
            ReviewDiffOp::Equal(value) => {
                lines.push(GitReviewDiffLineDto {
                    line_type: "context".to_string(),
                    content: value.to_string(),
                    old_line_number: Some(old_line_number),
                    new_line_number: Some(new_line_number),
                });
                old_line_number += 1;
                new_line_number += 1;
            }
            ReviewDiffOp::Remove(value) => {
                deletions += 1;
                lines.push(GitReviewDiffLineDto {
                    line_type: "removed".to_string(),
                    content: value.to_string(),
                    old_line_number: Some(old_line_number),
                    new_line_number: None,
                });
                old_line_number += 1;
            }
            ReviewDiffOp::Add(value) => {
                additions += 1;
                lines.push(GitReviewDiffLineDto {
                    line_type: "added".to_string(),
                    content: value.to_string(),
                    old_line_number: None,
                    new_line_number: Some(new_line_number),
                });
                new_line_number += 1;
            }
        }
    }

    let hunks = if additions == 0 && deletions == 0 {
        Vec::new()
    } else {
        vec![GitReviewDiffHunkDto {
            header: format!(
                "@@ -{},{} +{},{} @@",
                if left.is_empty() { 0 } else { 1 },
                left.len(),
                if right.is_empty() { 0 } else { 1 },
                right.len()
            ),
            old_start: if left.is_empty() { 0 } else { 1 },
            old_count: left.len() as u32,
            new_start: if right.is_empty() { 0 } else { 1 },
            new_count: right.len() as u32,
            lines,
        }]
    };

    GitReviewParsedDiffDto {
        original_content: original_content.to_string(),
        modified_content: modified_content.to_string(),
        additions,
        deletions,
        hunks,
    }
}

fn collect_review_changed_line_numbers(diff: &GitReviewParsedDiffDto) -> (Vec<u32>, Vec<u32>) {
    let mut removed = Vec::new();
    let mut added = Vec::new();
    for hunk in &diff.hunks {
        for line in &hunk.lines {
            if line.line_type == "removed" {
                if let Some(line_number) = line.old_line_number {
                    removed.push(line_number);
                }
            } else if line.line_type == "added" {
                if let Some(line_number) = line.new_line_number {
                    added.push(line_number);
                }
            }
        }
    }
    removed.sort_unstable();
    removed.dedup();
    added.sort_unstable();
    added.dedup();
    (removed, added)
}

fn build_review_stable_line_number_map(
    left_content: &str,
    right_content: &str,
) -> HashMap<u32, u32> {
    let left = split_review_lines(left_content);
    let right = split_review_lines(right_content);
    let operations = build_review_diff_ops(&left, &right);
    let mut line_map = HashMap::new();
    let mut left_line_number = 1u32;
    let mut right_line_number = 1u32;

    for operation in operations {
        match operation {
            ReviewDiffOp::Equal(_) => {
                line_map.insert(left_line_number, right_line_number);
                left_line_number += 1;
                right_line_number += 1;
            }
            ReviewDiffOp::Remove(_) => {
                left_line_number += 1;
            }
            ReviewDiffOp::Add(_) => {
                right_line_number += 1;
            }
        }
    }

    line_map
}

fn build_review_validated_stage_decorations(
    head_content: &str,
    index_content: &str,
    worktree_content: &str,
) -> (bool, Vec<u32>, Vec<u32>) {
    let staged_diff = build_review_diff(head_content, index_content);
    if staged_diff.hunks.is_empty() {
        return (false, Vec::new(), Vec::new());
    }

    let (removed, added_in_index) = collect_review_changed_line_numbers(&staged_diff);
    let index_to_worktree = build_review_stable_line_number_map(index_content, worktree_content);
    let mut added = added_in_index
        .into_iter()
        .filter_map(|line_number| index_to_worktree.get(&line_number).copied())
        .collect::<Vec<_>>();
    added.sort_unstable();
    added.dedup();

    (!removed.is_empty() || !added.is_empty(), removed, added)
}

fn normalize_review_status(status: &str) -> String {
    match status {
        "added" | "untracked" => "added".to_string(),
        "deleted" => "deleted".to_string(),
        _ => "modified".to_string(),
    }
}

#[derive(Default)]
struct ReviewSnapshotStats {
    additions: u32,
    deletions: u32,
    is_binary: bool,
}

#[derive(Default)]
struct ReviewSideMetadata {
    exists: bool,
    is_binary: bool,
    too_large: bool,
}

fn review_diff_path(delta: git2::DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn build_review_diff_stats(
    diff: &git2::Diff<'_>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let stats_by_path: RefCell<HashMap<String, ReviewSnapshotStats>> = RefCell::new(HashMap::new());
    let cancelled = std::cell::Cell::new(false);

    let foreach_result = diff.foreach(
        &mut |delta, _progress| {
            if should_cancel() {
                cancelled.set(true);
                return false;
            }
            if let Some(path) = review_diff_path(delta) {
                stats_by_path.borrow_mut().entry(path).or_default();
            }
            true
        },
        Some(&mut |delta, _binary| {
            if should_cancel() {
                cancelled.set(true);
                return false;
            }
            if let Some(path) = review_diff_path(delta) {
                stats_by_path
                    .borrow_mut()
                    .entry(path)
                    .or_default()
                    .is_binary = true;
            }
            true
        }),
        None,
        Some(&mut |delta, _hunk, line| {
            if should_cancel() {
                cancelled.set(true);
                return false;
            }
            let Some(path) = review_diff_path(delta) else {
                return true;
            };
            let mut stats = stats_by_path.borrow_mut();
            let entry = stats.entry(path).or_default();
            match line.origin() {
                '+' => entry.additions = entry.additions.saturating_add(line.num_lines()),
                '-' => entry.deletions = entry.deletions.saturating_add(line.num_lines()),
                _ => {}
            }
            true
        }),
    );
    if cancelled.get() || should_cancel() {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    foreach_result?;

    Ok(stats_by_path.into_inner())
}

fn build_staged_review_stats(
    repo: &Repository,
    should_cancel: &dyn Fn() -> bool,
) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let head_commit = get_head_commit(repo)?;
    let head_tree = match head_commit.as_ref() {
        Some(commit) => Some(commit.tree()?),
        None => None,
    };
    let mut index = repo.index()?;
    index.read(true)?;
    let mut options = git2::DiffOptions::new();
    options.max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut options))?;
    build_review_diff_stats(&diff, should_cancel)
}

fn build_pending_review_stats(
    repo: &Repository,
    should_cancel: &dyn Fn() -> bool,
) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let mut index = repo.index()?;
    index.read(true)?;
    let mut options = git2::DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut options))?;
    build_review_diff_stats(&diff, should_cancel)
}

fn build_workdir_review_stats(
    repo: &Repository,
    should_cancel: &dyn Fn() -> bool,
) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let head_commit = get_head_commit(repo)?;
    let head_tree = match head_commit.as_ref() {
        Some(commit) => Some(commit.tree()?),
        None => None,
    };
    let mut options = git2::DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let diff = repo.diff_tree_to_workdir(head_tree.as_ref(), Some(&mut options))?;
    build_review_diff_stats(&diff, should_cancel)
}

fn review_blob_side_metadata(blob: git2::Blob<'_>) -> ReviewSideMetadata {
    ReviewSideMetadata {
        exists: true,
        is_binary: blob.is_binary(),
        too_large: blob.size() > MAX_REVIEW_INLINE_BYTES,
    }
}

fn read_head_side_metadata(repo: &Repository, relative_path: &Path) -> Result<ReviewSideMetadata> {
    let Some(commit) = get_head_commit(repo)? else {
        return Ok(ReviewSideMetadata::default());
    };

    let tree_id = commit.tree_id();
    let tree = commit.tree().map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(tree_id.to_string()),
            Some("review_head_tree_metadata".to_string()),
        )
    })?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(error)
            if error.class() == git2::ErrorClass::Odb
                && error.code() == git2::ErrorCode::NotFound =>
        {
            return Err(BackendError::git_object_missing(
                error,
                None,
                Some("review_head_path_metadata".to_string()),
            ));
        }
        Err(_) => return Ok(ReviewSideMetadata::default()),
    };
    let entry_id = entry.id();
    let size = read_blob_header(repo, entry_id, "review_head_blob_metadata")?;
    if size > MAX_REVIEW_INLINE_BYTES {
        return Ok(ReviewSideMetadata {
            exists: true,
            is_binary: false,
            too_large: true,
        });
    }
    let object = entry.to_object(repo).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry_id.to_string()),
            Some("review_head_blob_metadata".to_string()),
        )
    })?;
    let Some(blob) = object.as_blob() else {
        return Ok(ReviewSideMetadata::default());
    };

    Ok(review_blob_side_metadata(blob.clone()))
}

fn read_index_side_metadata(repo: &Repository, relative_path: &Path) -> Result<ReviewSideMetadata> {
    let mut index = repo.index()?;
    index.read(true)?;
    let Some(entry) = index.get_path(relative_path, 0) else {
        return Ok(ReviewSideMetadata::default());
    };

    let size = read_blob_header(repo, entry.id, "review_index_blob_metadata")?;
    if size > MAX_REVIEW_INLINE_BYTES {
        return Ok(ReviewSideMetadata {
            exists: true,
            is_binary: false,
            too_large: true,
        });
    }
    let blob = repo.find_blob(entry.id).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry.id.to_string()),
            Some("review_index_blob_metadata".to_string()),
        )
    })?;
    Ok(review_blob_side_metadata(blob))
}

fn read_worktree_side_metadata(
    worktree: &CapabilityDir,
    relative_path: &Path,
) -> Result<ReviewSideMetadata> {
    let Some(entry) = inspect_worktree_entry(worktree, relative_path)? else {
        return Ok(ReviewSideMetadata::default());
    };

    if entry.metadata.file_type().is_symlink() {
        let target = entry
            .parent
            .read_link_contents(&entry.file_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to read review worktree link {:?}: {}",
                    relative_path, error
                ),
                source: error,
            })?;
        let target_bytes = target.to_string_lossy();
        return Ok(ReviewSideMetadata {
            exists: true,
            is_binary: target_bytes.as_bytes().contains(&0),
            too_large: target_bytes.len() > MAX_REVIEW_INLINE_BYTES,
        });
    }
    if !entry.metadata.is_file() {
        return Ok(ReviewSideMetadata::default());
    }

    let mut sample = [0u8; 8192];
    let bytes_read =
        match open_review_regular_file(&entry).and_then(|mut file| file.read(&mut sample)) {
            Ok(bytes_read) => bytes_read,
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to sample review worktree file {:?}: {}",
                        relative_path, error
                    ),
                    source: error,
                });
            }
        };

    Ok(ReviewSideMetadata {
        exists: true,
        is_binary: sample[..bytes_read].contains(&0),
        too_large: entry.metadata.len() > MAX_REVIEW_INLINE_BYTES as u64,
    })
}

fn read_review_snapshot_metadata(
    repo: &Repository,
    worktree: &CapabilityDir,
    relative_path: &Path,
) -> Result<ReviewSideMetadata> {
    let head = read_head_side_metadata(repo, relative_path)?;
    let index = read_index_side_metadata(repo, relative_path)?;
    let worktree = read_worktree_side_metadata(worktree, relative_path)?;

    Ok(ReviewSideMetadata {
        exists: head.exists || index.exists || worktree.exists,
        is_binary: head.is_binary || index.is_binary || worktree.is_binary,
        too_large: head.too_large || index.too_large || worktree.too_large,
    })
}

fn read_frozen_review_snapshot_metadata(
    repo: &Repository,
    head_tree: &git2::Tree<'_>,
    index: &git2::Index,
    worktree: &CapabilityDir,
    relative_path: &Path,
) -> Result<ReviewSideMetadata> {
    let head = match head_tree.get_path(relative_path) {
        Ok(entry) => {
            let entry_id = entry.id();
            let size = read_blob_header(repo, entry_id, "review_head_blob_metadata")?;
            if size > MAX_REVIEW_INLINE_BYTES {
                ReviewSideMetadata {
                    exists: true,
                    is_binary: false,
                    too_large: true,
                }
            } else {
                let blob = repo.find_blob(entry_id).map_err(|error| {
                    BackendError::git_object_missing(
                        error,
                        Some(entry_id.to_string()),
                        Some("review_head_blob_metadata".to_string()),
                    )
                })?;
                review_blob_side_metadata(blob)
            }
        }
        Err(error)
            if error.class() == git2::ErrorClass::Odb
                && error.code() == git2::ErrorCode::NotFound =>
        {
            return Err(BackendError::git_object_missing(
                error,
                None,
                Some("review_head_path_metadata".to_string()),
            ));
        }
        Err(_) => ReviewSideMetadata::default(),
    };
    let index = match index.get_path(relative_path, 0) {
        Some(entry) => {
            let size = read_blob_header(repo, entry.id, "review_index_blob_metadata")?;
            if size > MAX_REVIEW_INLINE_BYTES {
                ReviewSideMetadata {
                    exists: true,
                    is_binary: false,
                    too_large: true,
                }
            } else {
                let blob = repo.find_blob(entry.id).map_err(|error| {
                    BackendError::git_object_missing(
                        error,
                        Some(entry.id.to_string()),
                        Some("review_index_blob_metadata".to_string()),
                    )
                })?;
                review_blob_side_metadata(blob)
            }
        }
        None => ReviewSideMetadata::default(),
    };
    let worktree = read_worktree_side_metadata(worktree, relative_path)?;
    Ok(ReviewSideMetadata {
        exists: head.exists || index.exists || worktree.exists,
        is_binary: head.is_binary || index.is_binary || worktree.is_binary,
        too_large: head.too_large || index.too_large || worktree.too_large,
    })
}

pub(super) fn build_git_review_file(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
    status: &str,
) -> Result<GitReviewFileDto> {
    build_git_review_file_with_cancellation(repo, repo_root, relative_path, status, || false)
}

pub(super) fn build_git_review_file_with_cancellation<F>(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
    status: &str,
    should_cancel: F,
) -> Result<GitReviewFileDto>
where
    F: Fn() -> bool,
{
    let check_cancelled = || {
        if should_cancel() {
            Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            })
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let retained_worktree = open_review_worktree(repo_root)?;
    let head = read_head_file_side(repo, relative_path)?;
    check_cancelled()?;
    let index = read_index_file_side(repo, relative_path)?;
    check_cancelled()?;
    let worktree = read_worktree_file_side(&retained_worktree, relative_path)?;
    check_cancelled()?;
    let is_binary = head.is_binary || index.is_binary || worktree.is_binary;
    let too_large = head.too_large || index.too_large || worktree.too_large;
    let pending_diff = if is_binary || too_large {
        build_review_diff("", "")
    } else {
        build_review_diff(&index.content, &worktree.content)
    };
    let full_diff = if is_binary || too_large {
        build_review_diff("", "")
    } else {
        build_review_diff(&head.content, &worktree.content)
    };
    check_cancelled()?;
    let (has_validated_stage, validated_removed_line_numbers, validated_added_line_numbers) =
        if is_binary || too_large {
            (false, Vec::new(), Vec::new())
        } else {
            build_review_validated_stage_decorations(
                &head.content,
                &index.content,
                &worktree.content,
            )
        };
    check_cancelled()?;
    let absolute_path = repo_root.join(relative_path);

    Ok(GitReviewFileDto {
        path: relative_path.to_string_lossy().replace('\\', "/"),
        status: normalize_review_status(status),
        head_exists: head.exists,
        index_exists: index.exists,
        worktree_exists: worktree.exists,
        head_content: head.content.clone(),
        index_content: index.content.clone(),
        worktree_content: worktree.content.clone(),
        pending_diff,
        full_diff,
        has_validated_stage,
        validated_removed_line_numbers,
        validated_added_line_numbers,
        is_binary,
        too_large,
        language: get_file_language(&absolute_path).unwrap_or_else(|| "Unknown".to_string()),
    })
}

pub(super) fn build_git_review_snapshot(
    repo: &Repository,
    repo_root: &Path,
) -> Result<GitReviewSnapshotDto> {
    build_git_review_snapshot_with_cancellation(repo, repo_root, || false)
}

pub(super) fn build_git_review_snapshot_with_cancellation<F>(
    repo: &Repository,
    repo_root: &Path,
    should_cancel: F,
) -> Result<GitReviewSnapshotDto>
where
    F: Fn() -> bool,
{
    let check_cancelled = || {
        if should_cancel() {
            Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            })
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let retained_worktree = open_review_worktree(repo_root)?;
    let staged_stats = build_staged_review_stats(repo, &should_cancel)?;
    check_cancelled()?;
    let pending_stats = build_pending_review_stats(repo, &should_cancel)?;
    check_cancelled()?;
    let workdir_stats = build_workdir_review_stats(repo, &should_cancel)?;
    check_cancelled()?;
    let status = build_git_status(repo)?;
    let staged_paths = {
        let mut paths = status
            .staged_files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        paths
    };
    let staged_path_set = staged_paths.iter().cloned().collect::<HashSet<_>>();

    let mut visible_by_path: HashMap<String, (String, bool)> = HashMap::new();
    for file in status
        .unstaged_files
        .iter()
        .chain(status.untracked_files.iter())
    {
        if file.path.trim().is_empty() {
            continue;
        }
        visible_by_path.insert(file.path.clone(), (file.status.clone(), true));
    }
    for file in &status.staged_files {
        if file.path.trim().is_empty() {
            continue;
        }
        visible_by_path
            .entry(file.path.clone())
            .and_modify(|entry| {
                if !entry.1 {
                    entry.0 = file.status.clone();
                }
            })
            .or_insert_with(|| (file.status.clone(), false));
    }

    let mut visible_files = visible_by_path.into_iter().collect::<Vec<_>>();
    visible_files.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut changes = Vec::with_capacity(visible_files.len());
    for (path, (raw_status, has_pending_visible_change)) in visible_files {
        check_cancelled()?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let metadata = read_review_snapshot_metadata(repo, &retained_worktree, &relative_path)?;
        let pending = match (pending_stats.get(&path), workdir_stats.get(&path)) {
            (Some(pending), Some(workdir)) if pending.additions == 0 && pending.deletions == 0 => {
                Some(workdir)
            }
            (Some(pending), _) => Some(pending),
            (None, workdir) => workdir,
        };
        let staged = staged_stats.get(&path);
        let has_validated_stage = staged_path_set.contains(&path);
        let is_binary = metadata.is_binary
            || pending.is_some_and(|stats| stats.is_binary)
            || staged.is_some_and(|stats| stats.is_binary);

        changes.push(GitReviewChangeDto {
            path: path.clone(),
            status: normalize_review_status(&raw_status),
            additions: if has_pending_visible_change {
                pending.map(|stats| stats.additions).unwrap_or(0)
            } else {
                0
            },
            deletions: if has_pending_visible_change {
                pending.map(|stats| stats.deletions).unwrap_or(0)
            } else {
                0
            },
            has_pending_visible_change,
            has_validated_stage,
            validated_removed_line_numbers: Vec::new(),
            validated_added_line_numbers: Vec::new(),
            is_binary,
            too_large: metadata.too_large,
            requires_hydration: true,
            original_content: String::new(),
            index_content: String::new(),
            modified_content: String::new(),
            language: get_file_language(&repo_root.join(&relative_path))
                .unwrap_or_else(|| "Unknown".to_string()),
            hunks: Vec::new(),
        });
    }

    Ok(GitReviewSnapshotDto {
        branch: status.branch,
        staged_paths,
        changes,
        conflicted_files: status.conflicted_files,
        merge_in_progress: status.merge_in_progress,
        is_clean: status.is_clean,
    })
}

fn review_delta_status(status: git2::Delta) -> String {
    match status {
        git2::Delta::Added | git2::Delta::Untracked => "added",
        git2::Delta::Deleted => "deleted",
        git2::Delta::Renamed => "renamed",
        _ => "modified",
    }
    .to_string()
}

pub(super) fn build_direct_git_review_snapshot_with_cancellation<F>(
    repo: &Repository,
    repo_root: &Path,
    index: &git2::Index,
    head_id: git2::Oid,
    should_cancel: F,
) -> Result<GitReviewSnapshotDto>
where
    F: Fn() -> bool,
{
    let check_cancelled = || {
        if should_cancel() {
            Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            })
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let retained_worktree = open_review_worktree(repo_root)?;
    let head_commit = repo.find_commit(head_id).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(head_id.to_string()),
            Some("direct_review_head_commit".to_string()),
        )
    })?;
    let head_tree_id = head_commit.tree_id();
    let head_tree = head_commit.tree().map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(head_tree_id.to_string()),
            Some("direct_review_head_tree".to_string()),
        )
    })?;

    let mut staged_options = git2::DiffOptions::new();
    staged_options.max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let staged_diff =
        repo.diff_tree_to_index(Some(&head_tree), Some(index), Some(&mut staged_options))?;
    let staged_stats = build_review_diff_stats(&staged_diff, &should_cancel)?;
    check_cancelled()?;

    let mut pending_options = git2::DiffOptions::new();
    pending_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let pending_diff = repo.diff_index_to_workdir(Some(index), Some(&mut pending_options))?;
    let pending_stats = build_review_diff_stats(&pending_diff, &should_cancel)?;
    check_cancelled()?;

    let mut workdir_options = git2::DiffOptions::new();
    workdir_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .max_size(MAX_REVIEW_INLINE_BYTES as i64);
    let workdir_diff = repo.diff_tree_to_workdir(Some(&head_tree), Some(&mut workdir_options))?;
    let workdir_stats = build_review_diff_stats(&workdir_diff, &should_cancel)?;
    check_cancelled()?;

    let mut staged_paths = staged_diff
        .deltas()
        .filter_map(review_diff_path)
        .collect::<Vec<_>>();
    staged_paths.sort();
    staged_paths.dedup();
    let staged_path_set = staged_paths.iter().cloned().collect::<HashSet<_>>();
    let mut visible_by_path: HashMap<String, (String, bool)> = HashMap::new();
    for delta in pending_diff.deltas() {
        let status = review_delta_status(delta.status());
        if let Some(path) = review_diff_path(delta) {
            visible_by_path.insert(path, (status, true));
        }
    }
    for delta in staged_diff.deltas() {
        let status = review_delta_status(delta.status());
        if let Some(path) = review_diff_path(delta) {
            visible_by_path.entry(path).or_insert((status, false));
        }
    }
    let mut visible_files = visible_by_path.into_iter().collect::<Vec<_>>();
    visible_files.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut changes = Vec::with_capacity(visible_files.len());
    for (path, (raw_status, has_pending_visible_change)) in visible_files {
        check_cancelled()?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let metadata = read_frozen_review_snapshot_metadata(
            repo,
            &head_tree,
            index,
            &retained_worktree,
            &relative_path,
        )?;
        let pending = match (pending_stats.get(&path), workdir_stats.get(&path)) {
            (Some(pending), Some(workdir)) if pending.additions == 0 && pending.deletions == 0 => {
                Some(workdir)
            }
            (Some(pending), _) => Some(pending),
            (None, workdir) => workdir,
        };
        let staged = staged_stats.get(&path);
        let has_validated_stage = staged_path_set.contains(&path);
        changes.push(GitReviewChangeDto {
            path: path.clone(),
            status: normalize_review_status(&raw_status),
            additions: if has_pending_visible_change {
                pending.map(|stats| stats.additions).unwrap_or(0)
            } else {
                0
            },
            deletions: if has_pending_visible_change {
                pending.map(|stats| stats.deletions).unwrap_or(0)
            } else {
                0
            },
            has_pending_visible_change,
            has_validated_stage,
            validated_removed_line_numbers: Vec::new(),
            validated_added_line_numbers: Vec::new(),
            is_binary: metadata.is_binary
                || pending.is_some_and(|stats| stats.is_binary)
                || staged.is_some_and(|stats| stats.is_binary),
            too_large: metadata.too_large,
            requires_hydration: true,
            original_content: String::new(),
            index_content: String::new(),
            modified_content: String::new(),
            language: get_file_language(&repo_root.join(&relative_path))
                .unwrap_or_else(|| "Unknown".to_string()),
            hunks: Vec::new(),
        });
    }
    let mut conflicted_files = Vec::new();
    if index.has_conflicts() {
        for conflict in index.conflicts()? {
            let conflict = conflict?;
            let path = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref())
                .map(|entry| String::from_utf8_lossy(&entry.path).replace('\\', "/"));
            if let Some(path) = path {
                conflicted_files.push(path);
            }
        }
        conflicted_files.sort();
        conflicted_files.dedup();
    }
    let is_clean = changes.is_empty() && conflicted_files.is_empty();
    Ok(GitReviewSnapshotDto {
        branch: get_branch_name(repo)?.unwrap_or_else(|| "DETACHED".to_string()),
        staged_paths,
        changes,
        conflicted_files,
        merge_in_progress: is_merge_in_progress(repo),
        is_clean,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_git_review_file, build_git_review_file_with_cancellation, build_git_review_snapshot,
        build_git_review_snapshot_with_cancellation, build_review_diff, inspect_worktree_entry,
        open_review_regular_file, open_review_worktree,
    };
    use crate::core::error::BackendError;
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_review_repo() -> (TempDir, Repository) {
        let temp = TempDir::new().expect("temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");
        fs::write(temp.path().join("README.md"), "hello\nworld\n").expect("write readme");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add readme");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("find tree");
            let signature = Signature::now("Tester", "tester@example.com").expect("signature");
            repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
                .expect("commit");
        }

        (temp, repo)
    }

    #[test]
    fn review_diff_tracks_additions_and_deletions() {
        let diff = build_review_diff("one\ntwo\nthree\n", "one\ntwo changed\nthree\nfour\n");

        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.hunks.len(), 1);
    }

    #[test]
    fn review_diff_limits_large_lcs_inputs() {
        let left = (0..1100)
            .map(|value| format!("left-{value}"))
            .collect::<Vec<_>>()
            .join("\n");
        let right = (0..1100)
            .map(|value| format!("right-{value}"))
            .collect::<Vec<_>>()
            .join("\n");

        let diff = build_review_diff(&left, &right);

        assert_eq!(diff.deletions, 1100);
        assert_eq!(diff.additions, 1100);
    }

    #[test]
    fn git_review_snapshot_is_lightweight_for_modified_files() {
        let (temp, repo) = init_review_repo();
        fs::write(temp.path().join("README.md"), "hello\nthere\nworld\n").expect("modify readme");

        let snapshot = build_git_review_snapshot(&repo, temp.path()).expect("snapshot");

        assert_eq!(snapshot.changes.len(), 1);
        let change = &snapshot.changes[0];
        assert_eq!(change.path, "README.md");
        assert_eq!(change.additions, 1);
        assert_eq!(change.deletions, 0);
        assert!(change.has_pending_visible_change);
        assert!(change.requires_hydration);
        assert!(change.original_content.is_empty());
        assert!(change.index_content.is_empty());
        assert!(change.modified_content.is_empty());
        assert!(change.hunks.is_empty());
    }

    #[test]
    fn git_review_snapshot_keeps_exact_paths_with_repeated_spaces() {
        let (temp, repo) = init_review_repo();
        let spaced = Path::new("a  b.txt");
        fs::write(temp.path().join(spaced), "accepted\n").expect("write spaced file");
        let mut index = repo.index().expect("index");
        index.add_path(spaced).expect("add spaced file");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let parent = repo.head().expect("head").peel_to_commit().expect("commit");
        let signature = Signature::now("Macro", "macro@example.com").expect("signature");
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "track spaced file",
            &tree,
            &[&parent],
        )
        .expect("commit spaced file");
        drop(tree);
        drop(parent);
        fs::write(temp.path().join(spaced), "accepted\npending\n").expect("modify spaced file");

        let snapshot = build_git_review_snapshot(&repo, temp.path()).expect("snapshot");
        let change = snapshot
            .changes
            .iter()
            .find(|change| change.path == "a  b.txt")
            .expect("exact spaced path");
        assert_eq!(change.additions, 1);
        assert_eq!(change.deletions, 0);
    }

    #[test]
    fn git_review_snapshot_stops_during_file_traversal_when_cancelled() {
        let (temp, repo) = init_review_repo();
        for index in 0..8 {
            fs::write(
                temp.path().join(format!("pending-{index}.txt")),
                "pending\n",
            )
            .expect("write pending file");
        }
        let checks = std::cell::Cell::new(0usize);

        let error = match build_git_review_snapshot_with_cancellation(&repo, temp.path(), || {
            let next = checks.get() + 1;
            checks.set(next);
            next > 5
        }) {
            Ok(_) => panic!("cancellation must stop snapshot traversal"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            BackendError::Git { message } if message == "Git review was cancelled."
        ));
        assert!(checks.get() > 5);
    }

    #[test]
    fn git_review_file_stops_between_bounded_reads_when_cancelled() {
        let (temp, repo) = init_review_repo();
        fs::write(temp.path().join("README.md"), "changed\n").expect("modify readme");
        let checks = std::cell::Cell::new(0usize);

        let error = match build_git_review_file_with_cancellation(
            &repo,
            temp.path(),
            Path::new("README.md"),
            "modified",
            || {
                let next = checks.get() + 1;
                checks.set(next);
                next >= 4
            },
        ) {
            Ok(_) => panic!("cancellation must stop file hydration before diff calculation"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            BackendError::Git { message } if message == "Git review was cancelled."
        ));
        assert_eq!(checks.get(), 4);
    }

    #[test]
    fn git_review_snapshot_detects_large_and_binary_without_content() {
        let (temp, repo) = init_review_repo();
        fs::write(
            temp.path().join("large.txt"),
            "x".repeat(super::MAX_REVIEW_INLINE_BYTES + 1),
        )
        .expect("write large file");
        fs::write(temp.path().join("binary.bin"), b"abc\0def").expect("write binary file");

        let snapshot = build_git_review_snapshot(&repo, temp.path()).expect("snapshot");
        let large = snapshot
            .changes
            .iter()
            .find(|change| change.path == "large.txt")
            .expect("large change");
        let binary = snapshot
            .changes
            .iter()
            .find(|change| change.path == "binary.bin")
            .expect("binary change");

        assert!(large.too_large);
        assert_eq!(large.additions, 0);
        assert_eq!(large.deletions, 0);
        assert!(large.modified_content.is_empty());
        assert!(binary.is_binary);
        assert!(binary.modified_content.is_empty());
    }

    #[test]
    fn git_review_file_keeps_large_blob_and_worktree_reads_bounded() {
        let (temp, repo) = init_review_repo();
        let large_content = "x".repeat(super::MAX_REVIEW_INLINE_BYTES * 4);
        fs::write(temp.path().join("README.md"), &large_content).expect("write large file");
        let mut index = repo.index().expect("index");
        index
            .add_path(Path::new("README.md"))
            .expect("stage large file");
        index.write().expect("write index");

        let file = build_git_review_file(&repo, temp.path(), Path::new("README.md"), "modified")
            .expect("review large file");

        assert!(file.too_large);
        assert!(file.index_content.is_empty());
        assert!(file.worktree_content.is_empty());
        assert!(file.full_diff.hunks.is_empty());
    }

    #[test]
    fn git_review_file_hydrates_staged_only_changes() {
        let (temp, repo) = init_review_repo();
        fs::write(temp.path().join("README.md"), "hello\nstaged\nworld\n").expect("modify readme");
        let mut index = repo.index().expect("index");
        index
            .add_path(Path::new("README.md"))
            .expect("stage readme");
        index.write().expect("write index");

        let snapshot = build_git_review_snapshot(&repo, temp.path()).expect("snapshot");
        let change = snapshot
            .changes
            .iter()
            .find(|change| change.path == "README.md")
            .expect("staged change");
        assert!(!change.has_pending_visible_change);
        assert!(change.has_validated_stage);

        let file = build_git_review_file(&repo, temp.path(), Path::new("README.md"), "modified")
            .expect("review file");
        assert_eq!(file.head_content, "hello\nworld\n");
        assert_eq!(file.index_content, "hello\nstaged\nworld\n");
        assert_eq!(file.worktree_content, "hello\nstaged\nworld\n");
        assert!(!file.full_diff.hunks.is_empty());
        assert!(file.has_validated_stage);
    }

    #[test]
    fn review_reports_an_index_blob_that_is_really_missing_without_touching_worktree() {
        let (temp, repo) = init_review_repo();
        let worktree_path = temp.path().join("README.md");
        fs::write(&worktree_path, "content only in the index\n").expect("modify readme");
        let mut index = repo.index().expect("index");
        index
            .add_path(Path::new("README.md"))
            .expect("stage readme");
        index.write().expect("write index");
        index.read(true).expect("refresh index");
        let object_id = index
            .get_path(Path::new("README.md"), 0)
            .expect("index entry")
            .id;
        let object_path = repo
            .path()
            .join("objects")
            .join(&object_id.to_string()[..2])
            .join(&object_id.to_string()[2..]);
        assert!(object_path.is_file(), "test requires a loose staged blob");
        fs::remove_file(&object_path).expect("remove only the temporary staged blob");
        let worktree_before = fs::read(&worktree_path).expect("read worktree before review");

        let file_error =
            match build_git_review_file(&repo, temp.path(), Path::new("README.md"), "modified") {
                Ok(_) => panic!("missing index blob must fail review hydration"),
                Err(error) => error,
            };
        assert!(matches!(
            file_error,
            BackendError::GitObjectMissing {
                object_id: Some(ref missing_id),
                ..
            } if missing_id == &object_id.to_string()
        ));

        let snapshot_error = match build_git_review_snapshot(&repo, temp.path()) {
            Ok(_) => panic!("missing index blob must fail review snapshot"),
            Err(error) => error,
        };
        assert!(snapshot_error.is_git_object_missing());
        assert_eq!(
            fs::read(&worktree_path).expect("read worktree after review"),
            worktree_before
        );
    }

    #[test]
    fn review_reads_a_symbolic_link_itself_without_exposing_its_target() {
        let (temp, repo) = init_review_repo();
        let outside = temp
            .path()
            .parent()
            .expect("parent")
            .join("outside-review-secret.txt");
        fs::write(&outside, "secret outside project\n").expect("write outside file");
        let link = temp.path().join("linked.txt");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).expect("create link");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }

        let file = build_git_review_file(&repo, temp.path(), Path::new("linked.txt"), "added")
            .expect("review link");

        assert_eq!(file.worktree_content, "[external link target]");
        assert!(!file
            .worktree_content
            .contains(&outside.to_string_lossy().to_string()));
        assert!(!file.worktree_content.contains("secret outside project"));
        assert!(!temp
            .path()
            .join(".git")
            .join("outside-review-secret.txt")
            .exists());
    }

    #[test]
    fn review_masks_a_relative_link_target_that_escapes_the_worktree() {
        let (temp, repo) = init_review_repo();
        let outside_name = format!(
            "outside-review-relative-{}.txt",
            uuid::Uuid::new_v4().simple()
        );
        let outside = temp.path().parent().expect("parent").join(&outside_name);
        fs::write(&outside, "secret outside project\n").expect("write outside file");
        let link = temp.path().join("linked-relative.txt");
        let relative_target = std::path::PathBuf::from("..").join(&outside_name);

        #[cfg(unix)]
        std::os::unix::fs::symlink(&relative_target, &link).expect("create relative link");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&relative_target, &link).is_err() {
            let _ = fs::remove_file(&outside);
            return;
        }

        let file = build_git_review_file(
            &repo,
            temp.path(),
            Path::new("linked-relative.txt"),
            "added",
        )
        .expect("review relative link");

        assert_eq!(file.worktree_content, "[external link target]");
        assert!(!file.worktree_content.contains(&outside_name));
        assert!(!file.worktree_content.contains("secret outside project"));
        fs::remove_file(outside).expect("remove outside fixture");
    }

    #[test]
    fn review_rejects_a_path_through_a_linked_directory() {
        let (temp, repo) = init_review_repo();
        let outside_dir = temp
            .path()
            .parent()
            .expect("parent")
            .join("outside-review-dir");
        fs::create_dir_all(&outside_dir).expect("outside dir");
        fs::write(outside_dir.join("secret.txt"), "secret outside project\n")
            .expect("write outside file");
        let link = temp.path().join("linked-dir");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_dir, &link).expect("create link");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside_dir, &link).is_err() {
            return;
        }

        let error = match build_git_review_file(
            &repo,
            temp.path(),
            Path::new("linked-dir/secret.txt"),
            "added",
        ) {
            Ok(_) => panic!("review must not cross linked directories"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("crosses a linked directory"));
    }

    #[test]
    fn review_file_open_does_not_follow_a_link_swapped_after_inspection() {
        let (temp, _repo) = init_review_repo();
        let victim = temp.path().join("victim.txt");
        fs::write(&victim, "safe\n").expect("initial file");
        let retained = open_review_worktree(temp.path()).expect("retain worktree");
        let entry = inspect_worktree_entry(&retained, Path::new("victim.txt"))
            .expect("inspect file")
            .expect("file exists");
        fs::remove_file(&victim).expect("remove inspected file");
        let outside = TempDir::new().expect("outside directory");
        fs::write(
            outside.path().join("secret.txt"),
            "secret outside project\n",
        )
        .expect("outside secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &victim)
            .expect("swap file for link");
        #[cfg(windows)]
        {
            let status = crate::core::process::background_command("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&victim)
                .arg(outside.path())
                .status()
                .expect("swap file for junction");
            assert!(status.success(), "mklink /J must create the test junction");
        }

        let error = open_review_regular_file(&entry)
            .expect_err("a swapped linked entry must not be opened");

        assert!(!error.to_string().contains("secret outside project"));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).expect("outside preserved"),
            "secret outside project\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn review_never_reads_through_a_windows_junction() {
        let (temp, repo) = init_review_repo();
        let outside = TempDir::new().expect("outside directory");
        fs::write(
            outside.path().join("secret.txt"),
            "secret outside project\n",
        )
        .expect("outside secret");
        let junction = temp.path().join("linked-dir");
        let status = crate::core::process::background_command("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .status()
            .expect("create junction");
        assert!(status.success(), "mklink /J must create the test junction");

        let file_error = match build_git_review_file(
            &repo,
            temp.path(),
            Path::new("linked-dir/secret.txt"),
            "added",
        ) {
            Ok(_) => panic!("review must not cross a junction"),
            Err(error) => error,
        };
        assert!(file_error
            .to_string()
            .contains("crosses a linked directory"));
        assert!(!file_error.to_string().contains("secret outside project"));

        let snapshot = build_git_review_snapshot(&repo, temp.path()).expect("safe snapshot");
        assert!(snapshot
            .changes
            .iter()
            .all(|change| !change.path.contains("secret.txt")
                && !change.original_content.contains("secret outside project")
                && !change.index_content.contains("secret outside project")
                && !change.modified_content.contains("secret outside project")));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).expect("outside preserved"),
            "secret outside project\n"
        );
    }
}
