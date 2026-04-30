use super::*;
use crate::fs::get_file_language;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read;

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

fn read_head_file_bytes(repo: &Repository, relative_path: &Path) -> Result<Option<Vec<u8>>> {
    let Some(commit) = get_head_commit(repo)? else {
        return Ok(None);
    };

    let tree = commit.tree()?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    let object = entry.to_object(repo)?;
    let Some(blob) = object.as_blob() else {
        return Ok(None);
    };

    Ok(Some(blob.content().to_vec()))
}

fn read_index_file_bytes(repo: &Repository, relative_path: &Path) -> Result<Option<Vec<u8>>> {
    let mut index = repo.index()?;
    index.read(true)?;
    let Some(entry) = index.get_path(relative_path, 0) else {
        return Ok(None);
    };

    let blob = repo.find_blob(entry.id)?;
    Ok(Some(blob.content().to_vec()))
}

fn read_worktree_file_bytes(repo_root: &Path, relative_path: &Path) -> Result<Option<Vec<u8>>> {
    let absolute_path = repo_root.join(relative_path);

    match fs::read(&absolute_path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BackendError::Io {
            message: format!(
                "Failed to read worktree file {:?}: {}",
                absolute_path, error
            ),
            source: error,
        }),
    }
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

fn read_review_file_sides(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
) -> Result<(ReviewFileSide, ReviewFileSide, ReviewFileSide)> {
    Ok((
        bytes_to_review_side(read_head_file_bytes(repo, relative_path)?),
        bytes_to_review_side(read_index_file_bytes(repo, relative_path)?),
        bytes_to_review_side(read_worktree_file_bytes(repo_root, relative_path)?),
    ))
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

fn build_review_diff_stats(diff: &git2::Diff<'_>) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let stats_by_path: RefCell<HashMap<String, ReviewSnapshotStats>> = RefCell::new(HashMap::new());

    diff.foreach(
        &mut |delta, _progress| {
            if let Some(path) = review_diff_path(delta) {
                stats_by_path.borrow_mut().entry(path).or_default();
            }
            true
        },
        Some(&mut |delta, _binary| {
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
        None,
    )?;

    let mut stats_by_path = stats_by_path.into_inner();
    let stats = diff.stats()?;
    let stats_buffer = stats.to_buf(git2::DiffStatsFormat::NUMBER, 0)?;
    let stats_text = std::str::from_utf8(stats_buffer.as_ref()).unwrap_or_default();
    for line in stats_text.lines() {
        let mut parts = line.split_whitespace();
        let Some(additions) = parts.next() else {
            continue;
        };
        let Some(deletions) = parts.next() else {
            continue;
        };
        let path = parts.collect::<Vec<_>>().join(" ");
        if path.is_empty() {
            continue;
        }
        let entry = stats_by_path.entry(path).or_default();
        entry.additions = additions.parse::<u32>().unwrap_or(0);
        entry.deletions = deletions.parse::<u32>().unwrap_or(0);
    }

    Ok(stats_by_path)
}

fn build_staged_review_stats(repo: &Repository) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let head_commit = get_head_commit(repo)?;
    let head_tree = match head_commit.as_ref() {
        Some(commit) => Some(commit.tree()?),
        None => None,
    };
    let mut index = repo.index()?;
    index.read(true)?;
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)?;
    build_review_diff_stats(&diff)
}

fn build_pending_review_stats(repo: &Repository) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let mut index = repo.index()?;
    index.read(true)?;
    let mut options = git2::DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true);
    let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut options))?;
    build_review_diff_stats(&diff)
}

fn build_workdir_review_stats(repo: &Repository) -> Result<HashMap<String, ReviewSnapshotStats>> {
    let head_commit = get_head_commit(repo)?;
    let head_tree = match head_commit.as_ref() {
        Some(commit) => Some(commit.tree()?),
        None => None,
    };
    let mut options = git2::DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true);
    let diff = repo.diff_tree_to_workdir(head_tree.as_ref(), Some(&mut options))?;
    build_review_diff_stats(&diff)
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

    let tree = commit.tree()?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(_) => return Ok(ReviewSideMetadata::default()),
    };
    let object = entry.to_object(repo)?;
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

    let blob = repo.find_blob(entry.id)?;
    Ok(review_blob_side_metadata(blob))
}

fn read_worktree_side_metadata(
    repo_root: &Path,
    relative_path: &Path,
) -> Result<ReviewSideMetadata> {
    let absolute_path = repo_root.join(relative_path);
    let metadata = match fs::metadata(&absolute_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReviewSideMetadata::default());
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!(
                    "Failed to inspect worktree file {:?}: {}",
                    absolute_path, error
                ),
                source: error,
            });
        }
    };

    if !metadata.is_file() {
        return Ok(ReviewSideMetadata::default());
    }

    let mut sample = [0u8; 8192];
    let bytes_read =
        match fs::File::open(&absolute_path).and_then(|mut file| file.read(&mut sample)) {
            Ok(bytes_read) => bytes_read,
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to sample worktree file {:?}: {}",
                        absolute_path, error
                    ),
                    source: error,
                });
            }
        };

    Ok(ReviewSideMetadata {
        exists: true,
        is_binary: sample[..bytes_read].contains(&0),
        too_large: metadata.len() > MAX_REVIEW_INLINE_BYTES as u64,
    })
}

fn read_review_snapshot_metadata(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
) -> Result<ReviewSideMetadata> {
    let head = read_head_side_metadata(repo, relative_path)?;
    let index = read_index_side_metadata(repo, relative_path)?;
    let worktree = read_worktree_side_metadata(repo_root, relative_path)?;

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
    let (head, index, worktree) = read_review_file_sides(repo, repo_root, relative_path)?;
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
    let staged_stats = build_staged_review_stats(repo)?;
    let pending_stats = build_pending_review_stats(repo)?;
    let workdir_stats = build_workdir_review_stats(repo)?;
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
        let relative_path = validate_repo_relative_file_path(&path)?;
        let metadata = read_review_snapshot_metadata(repo, repo_root, &relative_path)?;
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

#[cfg(test)]
mod tests {
    use super::{build_git_review_file, build_git_review_snapshot, build_review_diff};
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
        assert!(large.modified_content.is_empty());
        assert!(binary.is_binary);
        assert!(binary.modified_content.is_empty());
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
}
