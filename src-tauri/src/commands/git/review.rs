use super::*;
use crate::fs::get_file_language;
use std::collections::HashMap;

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
        let review_file = build_git_review_file(repo, repo_root, &relative_path, &raw_status)?;
        let requires_hydration = review_file.is_binary
            || review_file.too_large
            || !review_file.full_diff.hunks.is_empty()
            || !review_file.pending_diff.hunks.is_empty();

        changes.push(GitReviewChangeDto {
            path: path.clone(),
            status: review_file.status,
            additions: review_file.pending_diff.additions,
            deletions: review_file.pending_diff.deletions,
            has_pending_visible_change,
            has_validated_stage: review_file.has_validated_stage,
            validated_removed_line_numbers: review_file.validated_removed_line_numbers,
            validated_added_line_numbers: review_file.validated_added_line_numbers,
            is_binary: review_file.is_binary,
            too_large: review_file.too_large,
            requires_hydration,
            original_content: String::new(),
            index_content: String::new(),
            modified_content: String::new(),
            language: review_file.language,
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
    use super::build_review_diff;

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
}
