# File System (FS) Implementation - TODO List

> **⚠️ CRITICAL TASK**: This module must be implemented manually without AI assistance.
> This document provides a detailed checklist for implementing the file system module.

## Overview

The file system module provides secure, sandboxed access to the workspace file system. It must:
- Validate all paths are within the workspace (sandboxing)
- Support read, write, list, and stat operations
- Provide file system watching for re-indexing triggers
- Handle cross-platform path normalization

---

## Task 1: Setup `fs/mod.rs`

### Core Path Validation
- [ ] Implement `validate_path(path: &Path, workspace: &Path) -> Result<PathBuf>`
  - Resolve path to absolute path
  - Check if path is within workspace using `canonicalize`
  - Prevent path traversal attacks (`../`, symlinks outside workspace)
  - Return normalized absolute path

- [ ] Implement `normalize_path(path: &Path) -> PathBuf`
  - Convert to OS-specific format
  - Resolve `.` and `..` segments
  - Handle UNC paths on Windows

- [ ] Implement `get_file_language(path: &Path) -> Result<String>`
  - Extract file extension
  - Map extensions to languages (e.g., `.ts` → "typescript", `.rs` → "rust")
  - Support for common programming languages

### Error Handling
- [ ] Create FS-specific error variants in `core/error.rs` (if not already covered)
  - `Filesystem::PathOutsideWorkspace`
  - `Filesystem::NotFound`
  - `Filesystem::PermissionDenied`
  - `Filesystem::DirectoryNotFound`
- [ ] Ensure all FS operations convert to `BackendError`

---

## Task 2: Implement `fs_read_file` Command

### Command Signature
```rust
#[tauri::command]
async fn fs_read_file(
    pool: tauri::State<'_, DbPool>,
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileContentDto>
```

### Implementation Steps
- [ ] Parse and validate the path
  - Parse string to `Path`
  - Call `validate_path` to ensure it's within workspace
- [ ] Read file content asynchronously
  - Use `tokio::fs::read_to_string`
  - Handle binary files gracefully (return error or base64 encode)
- [ ] Detect language
  - Call `get_file_language` on the path
- [ ] Return `FileContentDto { content, language }`
- [ ] Handle errors
  - File not found → `BackendError::NotFound`
  - Permission denied → `BackendError::PermissionDenied`

### Expected Response
```rust
#[derive(Serialize)]
struct FileContentDto {
    content: String,
    language: String,
}
```

---

## Task 3: Implement `fs_write_file` Command

### Command Signature
```rust
#[tauri::command]
async fn fs_write_file(
    pool: tauri::State<'_, DbPool>,
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    content: String,
) -> Result<()>
```

### Implementation Steps
- [ ] Parse and validate the path
  - Ensure path is within workspace (sandboxing)
  - Check write permissions on parent directories
- [ ] Create parent directories if they don't exist
  - Use `tokio::fs::create_dir_all`
  - Handle creation failures
- [ ] Write file atomically
  - Write to temporary file (`.tmp` suffix)
  - Use `tokio::fs::write`
  - Atomic rename to final path using `tokio::fs::rename`
  - This prevents partial writes/corruption
- [ ] Emit file change event
  - Emit `fs:file-changed` event via Tauri `app.emit()`
  - This triggers the watcher and potentially re-indexing
- [ ] Handle errors
  - Permission denied → `BackendError::PermissionDenied`
  - Disk full → `BackendError::Io`

### Security Considerations
- [ ] Validate file extension (optional whitelist)
- [ ] Check if file is being overwritten vs created
- [ ] Log write operations for audit trail

---

## Task 4: Implement `fs_list_dir` Command

### Command Signature
```rust
#[tauri::command]
async fn fs_list_dir(
    pool: tauri::State<'_, DbPool>,
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: bool,
) -> Result<Vec<DirEntryDto>>
```

### Implementation Steps
- [ ] Parse and validate the path
  - Ensure path is a directory, not a file
- [ ] Filter ignored directories/files
  - Create `.gitignore` parser or use `ignore` crate
  - Filter out: `.git`, `node_modules`, `target`, `.DS_Store`, etc.
  - Respect workspace-specific ignore patterns
- [ ] Read directory entries
  - If `recursive`: use `walkdir` crate or recursive traversal
  - If not recursive: use `tokio::fs::read_dir`
- [ ] Collect metadata for each entry
  - Name, type (file/directory/symlink)
  - Size (for files only)
  - Last modified timestamp
  - Language (for files)
- [ ] Return `Vec<DirEntryDto>`

### Expected Response
```rust
#[derive(Serialize)]
struct DirEntryDto {
    path: String,           // Relative to workspace
    name: String,           // File/directory name
    kind: String,           // "file" | "directory" | "symlink"
    size: Option<u64>,      // File size in bytes
    modified: String,       // ISO 8601 timestamp
    language: Option<String>, // File language
}
```

---

## Task 5: Implement `fs_stat` Command

### Command Signature
```rust
#[tauri::command]
async fn fs_stat(
    pool: tauri::State<'_, DbPool>,
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileStatsDto>
```

### Implementation Steps
- [ ] Parse and validate the path
- [ ] Get file metadata
  - Use `tokio::fs::metadata`
  - Extract: size, modified, created, permissions
  - Determine file type (file/directory/symlink)
- [ ] Return `FileStatsDto`

### Expected Response
```rust
#[derive(Serialize)]
struct FileStatsDto {
    path: String,
    name: String,
    kind: String,           // "file" | "directory" | "symlink"
    size: u64,
    created: String,        // ISO 8601
    modified: String,       // ISO 8601
    permissions: String,    // Unix mode or Windows attributes
    language: Option<String>,
}
```

---

## Task 6: Implement File System Watcher

### Setup `fs/watcher.rs`

#### Initialization
- [ ] Create `FsWatcher` struct
  - Hold reference to `notify::RecommendedWatcher`
  - Hold path to workspace to watch
  - Debounce timer (prevent event spam)

- [ ] Implement `FsWatcher::new(workspace: PathBuf) -> Result<Self>`
  - Initialize `notify::RecommendedWatcher`
  - Subscribe to event types: `Create`, `Modify`, `Delete`, `Rename`
  - Start watching workspace directory (recursive)
  - Setup debounce timer (e.g., 300ms)

#### Event Processing
- [ ] Implement event handler callback
  - Filter events from ignored paths (`.git`, `node_modules`, etc.)
  - Debounce: collect events and emit after timer expires
  - Convert notify events to Tauri events

- [ ] Emit Tauri events
  - `fs:file-created` → `{ path: String }`
  - `fs:file-modified` → `{ path: String }`
  - `fs:file-deleted` → `{ path: String }`
  - `fs:file-renamed` → `{ old_path: String, new_path: String }`

- [ ] Integration with main app
  - Store watcher instance in Tauri `manage` state
  - Start watcher on app startup in `lib.rs`
  - Shutdown watcher on app exit

#### Debouncing Logic
- [ ] Use `tokio::time::interval` or `tokio::sync::mpsc` channel
- [ ] Collect events during debounce period
- [ ] Deduplicate events (same path modified multiple times)
- [ ] Emit batched events after debounce

---

## Task 7: Security Enhancements

### Sandbox Enforcement
- [ ] Ensure ALL path operations go through `validate_path`
- [ ] Reject symbolic links that point outside workspace
- [ ] Implement whitelist of allowed file extensions for write operations (optional)
  - Example: Only allow `.ts`, `.tsx`, `.rs`, `.py`, `.json`, etc.
  - Prevent execution files: `.exe`, `.sh`, `.bat`, `.ps1`

### Permission Validation
- [ ] Check file/directory permissions before operations
- [ ] Return clear error messages for permission issues
- [ ] Log security violations (attempted access outside workspace)

### Tauri Capabilities
- [ ] Update `src-tauri/capabilities/default.json`
  - Add `fs:allow-read-file`
  - Add `fs:allow-write-file`
  - Add `fs:allow-read-dir`
  - Add `fs:allow-stat`
  - Remove `allow-all` permissions (if present)
- [ ] Consider using path-specific permissions (whitelist workspace path)

---

## Task 8: Tests

### Unit Tests
- [ ] Test `validate_path`
  - Valid path within workspace → passes
  - Path with `../` traversing outside → rejected
  - Symlink pointing outside → rejected
  - Non-existent path → returns normalized path

- [ ] Test `normalize_path`
  - Relative path → absolute
  - Path with `.` and `..` → cleaned
  - Empty path → workspace root

### Integration Tests
- [ ] Test `fs_read_file`
  - Read existing file → success
  - Read non-existent file → `NotFound` error
  - Read file outside workspace → `PermissionDenied` error
  - Read binary file → appropriate error or base64

- [ ] Test `fs_write_file`
  - Write new file → success
  - Overwrite existing file → success
  - Write outside workspace → `PermissionDenied` error
  - Create nested directories → directories created
  - Atomic write: check no partial writes during crash simulation

- [ ] Test `fs_list_dir`
  - List empty directory → empty list
  - List directory with files → returns correct metadata
  - List recursively → includes nested files
  - Filter ignored files → `.git`, `node_modules` excluded

- [ ] Test `fs_stat`
  - Stat file → correct metadata
  - Stat directory → correct metadata
  - Stat non-existent → `NotFound` error

- [ ] Test watcher
  - Create file → `fs:file-created` event emitted
  - Modify file → `fs:file-modified` event emitted
  - Delete file → `fs:file-deleted` event emitted
  - Multiple rapid modifications → debounced to single event
  - Ignored files → no events emitted

---

## Task 9: Documentation

- [ ] Document command signatures in `commands/fs.rs`
- [ ] Add Rust doc comments to all public functions
- [ ] Document sandboxing rules and security considerations
- [ ] Document file extension → language mapping
- [ ] Document ignored paths (similar to `.gitignore`)
- [ ] Create example usage in README or separate docs

---

## Task 10: Integration with Frontend

- [ ] Update frontend service to use real IPC commands
  - Replace mock implementations with `invoke()` calls
  - Handle `BackendError` responses and display to user
  - Subscribe to watcher events (`listen()`)

- [ ] Test end-to-end
  - Open file in frontend → reads from backend
  - Save file in frontend → writes to backend
  - Browse file tree → lists directory from backend
  - File watcher triggers → updates in UI

---

## Completion Criteria

- [ ] All commands implemented and passing tests
- [ ] Sandbox validation never allows access outside workspace
- [ ] Watcher emits events correctly with debouncing
- [ ] All error paths covered with tests
- [ ] Frontend successfully uses all FS commands
- [ ] Security audit passed (no permission bypasses)
- [ ] Documentation complete

---

## Notes

- Use `notify` crate for file system watching (already in `Cargo.toml`)
- Use `ignore` crate for `.gitignore`-style filtering (add to `Cargo.toml` if needed)
- Use `walkdir` crate for recursive directory listing (add to `Cargo.toml` if needed)
- All async operations should use `tokio::fs` for performance
- Consider adding file locking for write operations to prevent race conditions
