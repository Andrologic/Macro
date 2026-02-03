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

## File Structure

```
src-tauri/src/
├── fs/
│   ├── mod.rs          # Core path validation functions + module exports
│   ├── watcher.rs      # File system watcher (notify crate)
│   └── dto.rs          # Data Transfer Objects (DTOs) for IPC
├── commands/
│   └── fs.rs           # Tauri command handlers
└── core/
    └── error.rs        # BackendError variants (already exists)
```

---

## Task 1: Setup `fs/mod.rs` - Core Functions

### 1.1 Imports & Module Structure
- [x] Add module declaration `pub mod watcher;`
- [x] Add module declaration `pub mod dto;`
- [x] Replace `use std::io::Result;` with `use crate::core::error::{BackendError, Result};`
- [x] Remove unused import `use tauri::ipc::private::ResultFutureTag;`
- [x] Export public functions: `pub use self::validate_path;`, etc.

### 1.2 `validate_path` Function
- [x] Implement `validate_path(path: &Path, workspace: &Path) -> Result<PathBuf>`
- [x] Resolve path to absolute path (join with workspace if relative)
- [x] Use `canonicalize()` to resolve symlinks and `.`/`..`
- [x] Check if canonical path starts with canonical workspace
- [x] **FIX**: Return `BackendError::FilesystemPathOutsideWorkspace` instead of `std::io::Error`
- [x] **FIX**: Handle case where file doesn't exist yet (for write operations)
  - Use `normalize_path` + manual prefix check when `canonicalize` fails with NotFound
  - Only allow if the *parent* directory exists and is within workspace
- [x] **ADD**: Handle symlinks that point outside workspace (currently relies on canonicalize)

### 1.3 `validate_path_for_write` Function (NEW)
- [x] Implement `validate_path_for_write(path: &Path, workspace: &Path) -> Result<PathBuf>`
  - Similar to `validate_path` but handles non-existent files
  - Check parent directory exists and is within workspace
  - Return the target path (not canonicalized, since file doesn't exist)
  - Prevent creating files in restricted locations

### 1.4 `normalize_path` Function
- [x] Implement `normalize_path(path: &Path) -> PathBuf`
- [x] Handle `Component::CurDir` (ignore `.`)
- [x] Handle `Component::ParentDir` (pop `..`)
- [x] Push other components
- [x] **ADD**: Handle empty path edge case (return empty PathBuf or error?)
- [x] **ADD**: Handle Windows UNC paths (`\\?\` prefix)
- [x] **ADD**: Handle trailing slashes consistently

### 1.5 `get_file_language` Function
- [x] Implement `get_file_language(path: &Path) -> Result<String>`
- [x] Extract extension with `path.extension()`
- [x] Map common extensions to language names
- [x] Return `"Unknown"` for unrecognized extensions
- [x] Return error for files without extension
- [x] **FIX**: Return `BackendError` instead of `std::io::Error`
- [x] **ADD**: Consider returning `Option<String>` instead of error for no extension
- [x] **ADD**: Handle case-insensitive extensions (`.RS` vs `.rs`)
- [x] **ADD**: Add more extensions:
  - `.astro` → "Astro"
  - `.graphql`, `.gql` → "GraphQL"
  - `.proto` → "Protocol Buffers"
  - `.dockerfile`, `Dockerfile` → "Dockerfile"
  - `.nginx`, `.conf` → "Config"
  - `.env` → "Environment"
  - `.gitignore`, `.dockerignore` → "Ignore File"
  - `.lock` → "Lock File"

### 1.6 `is_binary_file` Function (NEW)
- [x] Implement `is_binary_file(path: &Path) -> Result<bool>`
- [x] **Step 1: Check by extension** (fast, no file read)
  - Create constant `BINARY_EXTENSIONS: &[&str]` with common binary extensions:
    - Images: `png`, `jpg`, `jpeg`, `gif`, `bmp`, `ico`, `webp`, `svg`, `tiff`
    - Audio/Video: `mp3`, `mp4`, `wav`, `avi`, `mkv`, `mov`, `flac`, `ogg`
    - Archives: `zip`, `tar`, `gz`, `rar`, `7z`, `bz2`, `xz`
    - Executables: `exe`, `dll`, `so`, `dylib`, `bin`, `wasm`
    - Documents: `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`
    - Databases: `db`, `sqlite`, `sqlite3`
    - Other: `class`, `pyc`, `o`, `a`, `lib`
  - If extension matches → return `true` immediately
- [x] **Step 2: Content check** (fallback if extension unknown)
  - Read first 8KB of file
  - Check for NULL bytes (0x00) in content
  - **Note**: This heuristic works because UTF-8/ASCII text never contains 0x00,
    while binary formats (padding, integers, compressed data) almost always do
  - **Limitation**: UTF-16/UTF-32 text files contain 0x00 but are rare in codebases
  - Return `true` if NULL bytes found, `false` otherwise

---

## Task 2: Setup `fs/dto.rs` - Data Transfer Objects

### 2.1 File Structure
- [x] Create new file `src-tauri/src/fs/dto.rs`
- [x] Add `use serde::{Serialize, Deserialize};`

### 2.2 FileContentDto
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContentDto {
    /// File content as UTF-8 string (empty for binary files if not base64 encoded)
    pub content: String,
    /// Detected programming language
    pub language: String,
    /// Whether the file is binary
    pub is_binary: bool,
    /// File size in bytes
    pub size: u64,
    /// Encoding used ("utf-8", "base64", etc.)
    pub encoding: String,
}
```
- [x] Implement `FileContentDto` struct
- [x] Add `is_binary` field to indicate binary content
- [x] Add `size` field for file size
- [x] Add `encoding` field ("utf-8" or "base64")

### 2.3 DirEntryDto
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryDto {
    /// Absolute path to the entry
    pub path: String,
    /// Relative path from workspace root
    pub relative_path: String,
    /// File or directory name
    pub name: String,
    /// Type: "file", "directory", or "symlink"
    pub kind: String,
    /// File size in bytes (None for directories)
    pub size: Option<u64>,
    /// Last modified timestamp (ISO 8601)
    pub modified: Option<String>,
    /// Created timestamp (ISO 8601, may not be available on all platforms)
    pub created: Option<String>,
    /// Detected programming language (None for directories)
    pub language: Option<String>,
    /// Whether the entry is hidden (starts with `.` on Unix, hidden attribute on Windows)
    pub is_hidden: bool,
    /// Whether the entry is read-only
    pub is_readonly: bool,
}
```
- [x] Implement `DirEntryDto` struct
- [x] Add `relative_path` field (path relative to workspace)
- [x] Add `is_hidden` field
- [x] Add `is_readonly` field
- [x] Add `created` field (optional, platform-dependent)
### 2.4 FileStatsDto
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatsDto {
    /// Absolute path
    pub path: String,
    /// File or directory name
    pub name: String,
    /// Type: "file", "directory", or "symlink"
    pub kind: String,
    /// File size in bytes
    pub size: u64,
    /// Created timestamp (ISO 8601)
    pub created: Option<String>,
    /// Last modified timestamp (ISO 8601)
    pub modified: String,
    /// Last accessed timestamp (ISO 8601)
    pub accessed: Option<String>,
    /// Unix permissions as octal string (e.g., "0644") or Windows attributes
    pub permissions: String,
    /// Detected programming language (None for directories)
    pub language: Option<String>,
    /// Whether the file is read-only
    pub is_readonly: bool,
    /// Whether the file is hidden
    pub is_hidden: bool,
    /// Whether the file is a symlink
    pub is_symlink: bool,
    /// Symlink target path (if is_symlink is true)
    pub symlink_target: Option<String>,
}
```
- [x] Implement `FileStatsDto` struct
- [x] Add `accessed` field for last access time
- [x] Add `is_readonly`, `is_hidden`, `is_symlink` fields
- [x] Add `symlink_target` field for symlink resolution

### 2.5 WriteResultDto (NEW)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResultDto {
    /// Path where file was written
    pub path: String,
    /// Number of bytes written
    pub bytes_written: u64,
    /// Whether the file was created (true) or overwritten (false)
    pub created: bool,
}
```

- [x] Implement `WriteResultDto` struct
- [x] Return this instead of `()` for better feedback

### 2.6 FsEventDto (NEW - for watcher)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FsEventDto {
    Created { path: String },
    Modified { path: String },
    Deleted { path: String },
    Renamed { old_path: String, new_path: String },
}
```
- [x] Implement `FsEventDto` enum
- [x] Use `#[serde(tag = "type")]` for TypeScript-friendly serialization

---

## Task 3: Update `core/error.rs` - Error Handling

### 3.1 Verify Existing Variants
- [x] `BackendError::FilesystemPathOutsideWorkspace { message: String }`
- [x] `BackendError::FilesystemNotFound { message: String }`
- [x] `BackendError::FilesystemPermissionDenied { message: String }`
- [x] `BackendError::FilesystemDirectoryNotFound { message: String }`
- [x] `BackendError::Filesystem { message: String }` (generic)

### 3.2 Add Missing Variants
- [x] `BackendError::FilesystemIsDirectory { message: String }` - when file operation attempted on directory
- [x] `BackendError::FilesystemIsFile { message: String }` - when directory operation attempted on file
- [x] `BackendError::FilesystemAlreadyExists { message: String }` - file/dir already exists
- [x] `BackendError::FilesystemBinaryFile { message: String }` - binary file cannot be read as text
- [x] `BackendError::FilesystemFileTooLarge { message: String, max_size: u64, actual_size: u64 }` - file exceeds size limit
- [x] `BackendError::FilesystemInvalidPath { message: String }` - malformed path
- [x] `BackendError::FilesystemDiskFull { message: String }` - no space left on device

### 3.3 Error Conversion Helper
- [x] Create helper function `io_error_to_backend_error(err: std::io::Error, path: &Path) -> BackendError`
  - Map `ErrorKind::NotFound` → `FilesystemNotFound`
  - Map `ErrorKind::PermissionDenied` → `FilesystemPermissionDenied`
  - Map `ErrorKind::AlreadyExists` → `FilesystemAlreadyExists`
  - Map `ErrorKind::IsADirectory` → `FilesystemIsDirectory` (Unix only)
  - Map `ErrorKind::StorageFull` → `FilesystemDiskFull`
  - Map others → `Filesystem { message }`

---

## Task 4: Implement `fs_read_file` Command

### 4.1 Command Signature
```rust
#[tauri::command]
pub async fn fs_read_file(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileContentDto, BackendError>
```
- [x] Define command in `commands/fs.rs`
- [x] Remove `pool` parameter (not needed for FS operations)
- [x] Use `workspace` state for sandbox validation

### 4.2 Implementation Steps
- [x] Parse path string to `PathBuf`
- [x] Call `validate_path(&path, &workspace)` to ensure sandboxed
- [x] Get file metadata with `tokio::fs::metadata(&validated_path)`
  - [x] Check if it's a file (not directory)
  - [x] Check file size against max limit (e.g., 10MB default)
  - [x] Return `FilesystemFileTooLarge` if exceeded
- [x] Check if binary with `is_binary_file(&validated_path)`
  - [x] If binary: return with `is_binary: true`, `content: ""`, `encoding: "none"`
  - [x] OR: base64 encode binary content if requested
- [x] Read file content with `tokio::fs::read_to_string(&validated_path)`
  - [x] Handle UTF-8 decode errors gracefully
- [x] Detect language with `get_file_language(&validated_path)`
- [x] Build and return `FileContentDto`

### 4.3 Error Handling
- [x] `validate_path` fails → propagate error (already BackendError)
- [x] File not found → `FilesystemNotFound { message: format!("File not found: {}", path) }`
- [x] Permission denied → `FilesystemPermissionDenied`
- [x] Is directory → `FilesystemIsDirectory { message }`
- [x] Read error → `Io` or specific variant

### 4.4 Configuration Constants
- [x] Define `const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;` (10MB)
- [x] Consider making this configurable via `core/config.rs`

---

## Task 5: Implement `fs_write_file` Command

### 5.1 Command Signature
```rust
#[tauri::command]
pub async fn fs_write_file(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    content: String,
    create_dirs: Option<bool>,  // Default: true
) -> Result<WriteResultDto, BackendError>
```
- [x] Define command in `commands/fs.rs`
- [x] Add `create_dirs` parameter to control auto-creation of parent dirs

### 5.2 Implementation Steps
- [x] Parse path string to `PathBuf`
- [x] Call `validate_path_for_write(&path, &workspace)` (handles non-existent files)
- [x] Check if file already exists (for `created` flag in response)
- [x] Get parent directory path
- [x] If `create_dirs` (default true):
  - [x] Create parent directories with `tokio::fs::create_dir_all(&parent)`
  - [x] Handle creation errors
- [x] Atomic write implementation:
  1. [x] Generate temp file path: `path + ".tmp." + random_suffix`
  2. [x] Write content to temp file with `tokio::fs::write(&temp_path, &content)`
  3. [x] Rename temp file to final path with `tokio::fs::rename(&temp_path, &validated_path)`
  4. [x] If rename fails, clean up temp file
- [x] Return `WriteResultDto { path, bytes_written, created }`

### 5.3 Security Considerations
- [x] **Extension whitelist** (optional, configurable):
  - [x] Define `ALLOWED_EXTENSIONS: Option<HashSet<&str>>` in config
  - [x] If set, reject writes to files with non-whitelisted extensions
  - [x] Log rejected attempts
- [x] **Size limit** for writes:
  - [x] Define `MAX_WRITE_SIZE: u64` (e.g., 50MB)
  - [x] Reject writes exceeding limit
- [x] **Audit logging**:
  - [x] Use `tracing::info!` to log successful writes
  - [x] Include: path, user, bytes written, timestamp

### 5.4 Error Handling
- [x] Path validation fails → propagate error
- [x] Parent directory creation fails → `Filesystem` or `FilesystemPermissionDenied`
- [x] Write fails → `Io` or specific variant
- [x] Rename fails → clean up temp, return error
- [x] Disk full → `FilesystemDiskFull`

---

## Task 6: Implement `fs_list_dir` Command

### 6.1 Command Signature
```rust
#[tauri::command]
pub async fn fs_list_dir(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,        // Default: false
    include_hidden: Option<bool>,   // Default: false
    max_depth: Option<u32>,         // Default: unlimited when recursive
) -> Result<Vec<DirEntryDto>, BackendError>
```
- [x] Define command in `commands/fs.rs`
- [x] Add `include_hidden` parameter
- [x] Add `max_depth` parameter for recursive listing

### 6.2 Implementation Steps
- [x] Parse path string to `PathBuf`
- [x] Call `validate_path(&path, &workspace)`
- [x] Verify path is a directory with `tokio::fs::metadata`
  - [x] If file → `FilesystemIsFile { message }`
- [x] Choose listing strategy:
  - [x] If `recursive = false`: use `tokio::fs::read_dir`
  - [x] If `recursive = true`: use `walkdir` crate with `max_depth`
- [x] For each entry:
  - [x] Get entry path and name
  - [x] Check if hidden (starts with `.` on Unix)
  - [x] Skip if hidden and `include_hidden = false`
  - [x] Skip ignored paths (`.git`, `node_modules`, `target`, etc.)
  - [x] Get metadata (size, modified, created)
  - [x] Detect language for files
  - [x] Build `DirEntryDto`
- [x] Sort entries: directories first, then files, alphabetically
- [x] Return `Vec<DirEntryDto>`

### 6.3 Ignore Patterns
- [x] Create constant list of default ignored directories:
```rust
const DEFAULT_IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "__pycache__",
    ".cache",
    ".DS_Store",
    "Thumbs.db",
    ".idea",
    ".vscode",  // Consider keeping this for settings
];
```
- [x] Make configurable via workspace settings
- [x] Consider using `ignore` crate to parse `.gitignore`

### 6.4 Performance Considerations
- [x] Limit maximum entries returned (e.g., 10,000)
- [x] Stream entries for very large directories (future enhancement)
- [x] Use parallel iteration with `rayon` for large recursive listings (optional)

---

## Task 7: Implement `fs_stat` Command

### 7.1 Command Signature
```rust
#[tauri::command]
pub async fn fs_stat(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileStatsDto, BackendError>
```
- [x] Define command in `commands/fs.rs`

### 7.2 Implementation Steps
- [x] Parse path string to `PathBuf`
- [x] Call `validate_path(&path, &workspace)`
- [x] Get file metadata with `tokio::fs::metadata(&validated_path)`
- [x] Get symlink metadata with `tokio::fs::symlink_metadata` (to detect symlinks)
- [x] Extract all metadata fields:
  - [x] `size`: `metadata.len()`
  - [x] `modified`: `metadata.modified()?.into::<DateTime<Utc>>().to_rfc3339()`
  - [x] `created`: `metadata.created().ok()` (platform-dependent)
  - [x] `accessed`: `metadata.accessed().ok()` (platform-dependent)
  - [x] `permissions`: format as octal on Unix, attributes on Windows
  - [x] `is_readonly`: `metadata.permissions().readonly()`
  - [x] `is_symlink`: from symlink_metadata
- [x] If symlink, resolve target:
  - [x] Use `tokio::fs::read_link(&validated_path)`
  - [x] Store in `symlink_target`
- [x] Detect kind: "file", "directory", or "symlink"
- [x] Detect language for files
- [x] Detect if hidden (platform-specific)
- [x] Build and return `FileStatsDto`

### 7.3 Platform-Specific Handling
- [x] Unix permissions: format as octal (e.g., "0644", "0755")
- [x] Windows attributes: parse and format as string (e.g., "readonly,hidden")
- [x] Use `#[cfg(unix)]` and `#[cfg(windows)]` conditionally

---

## Task 8: Additional FS Commands

### 8.1 `fs_exists` Command
```rust
#[tauri::command]
pub async fn fs_exists(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<bool, BackendError>
```
- [x] Validate path within workspace
- [x] Return `tokio::fs::try_exists(&validated_path).await?`
- [x] Simple existence check without full metadata

### 8.2 `fs_delete` Command
```rust
#[tauri::command]
pub async fn fs_delete(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,  // Default: false, required for directories
) -> Result<(), BackendError>
```
- [x] Validate path within workspace
- [x] Check if file or directory
- [x] If file: `tokio::fs::remove_file`
- [x] If directory and `recursive = true`: `tokio::fs::remove_dir_all`
- [x] If directory and `recursive = false`: `tokio::fs::remove_dir` (fails if not empty)
- [x] **Security**: Log all delete operations
- [x] **Security**: Consider requiring confirmation for recursive deletes

### 8.3 `fs_create_dir` Command
```rust
#[tauri::command]
pub async fn fs_create_dir(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,  // Default: true
) -> Result<(), BackendError>
```
- [x] Validate path for write
- [x] If `recursive`: `tokio::fs::create_dir_all`
- [x] If not recursive: `tokio::fs::create_dir`

### 8.4 `fs_copy` Command
```rust
#[tauri::command]
pub async fn fs_copy(
    workspace: tauri::State<'_, PathBuf>,
    src: String,
    dest: String,
) -> Result<u64, BackendError>  // Returns bytes copied
```
- [x] Validate both paths within workspace
- [x] Use `tokio::fs::copy(&src, &dest)`
- [x] Return number of bytes copied

### 8.5 `fs_move` Command
```rust
#[tauri::command]
pub async fn fs_move(
    workspace: tauri::State<'_, PathBuf>,
    src: String,
    dest: String,
) -> Result<(), BackendError>
```
- [x] Validate both paths within workspace
- [x] Try `tokio::fs::rename` first (atomic, same filesystem)
- [x] If rename fails (cross-filesystem), fallback to copy + delete
- [x] Handle directory moves (recursive)

---

## Task 9: Implement File System Watcher

### 9.1 Setup `fs/watcher.rs`

#### Struct Definition
```rust
pub struct FsWatcher {
    watcher: notify::RecommendedWatcher,
    workspace: PathBuf,
    app_handle: AppHandle,
    debounce_tx: mpsc::Sender<notify::Event>,
}
```
- [x] Store watcher instance
- [x] Store workspace path for filtering
- [x] Store Tauri AppHandle for emitting events
- [x] Store channel sender for debouncing

#### Initialization
- [x] Implement `FsWatcher::new(workspace: PathBuf, app_handle: AppHandle) -> Result<Self>`
  - [x] Create mpsc channel for debouncing
  - [x] Create `notify::RecommendedWatcher` with event handler callback
  - [x] Start watching workspace directory recursively
  - [x] Spawn debounce task

### 9.2 Event Handler Callback
```rust
fn handle_event(event: notify::Result<notify::Event>) {
    // ...
}
```
- [x] Unwrap event, log errors
- [x] Filter events from ignored paths
- [x] Send event to debounce channel

### 9.3 Debounce Logic
- [x] Spawn tokio task that:
  - [x] Collects events for configurable duration (default 300ms)
  - [x] Deduplicates events by path
  - [x] Converts to `FsEventDto`
  - [x] Emits via `app_handle.emit("fs:change", &events)`

### 9.4 Event Types to Handle
- [x] `EventKind::Create` → `FsEventDto::Created`
- [x] `EventKind::Modify` → `FsEventDto::Modified`
- [x] `EventKind::Remove` → `FsEventDto::Deleted`
- [x] `EventKind::Rename` → `FsEventDto::Renamed` (with old and new paths)

### 9.5 Ignored Paths Filter
- [x] Use same `DEFAULT_IGNORED` list as `fs_list_dir`
- [x] Check if any path component matches ignored patterns
- [x] Consider supporting `.gitignore` parsing with `ignore` crate

### 9.6 Integration with `lib.rs`
- [x] Create watcher in `tauri::Builder::setup`
- [x] Store in Tauri managed state
- [x] Optionally expose `fs_watcher_pause`/`fs_watcher_resume` commands

### 9.7 Graceful Shutdown
- [x] Implement `Drop` for `FsWatcher` to stop watching
- [x] Or add explicit `stop()` method

---

## Task 10: Tauri Capabilities & Security

### 10.1 Update `src-tauri/capabilities/default.json`
- [x] Add FS command permissions:
```json
{
  "permissions": [
    "fs:allow-read-file",
    "fs:allow-write-file",
    "fs:allow-read-dir",
    "fs:allow-stat",
    "fs:allow-exists",
    "fs:allow-delete",
    "fs:allow-create-dir",
    "fs:allow-copy",
    "fs:allow-move"
  ]
}
```
- [x] Remove any `*` or `allow-all` permissions
- [x] Consider path-scoped permissions (`fs:allow-read-file:${workspace}`)

### 10.2 CSP (Content Security Policy)
- [x] Ensure CSP doesn't block local file access
- [x] Review `src-tauri/tauri.conf.json` for security settings

### 10.3 Audit Logging
- [x] Log all write/delete operations with `tracing::info!`
- [x] Log security violations with `tracing::warn!`
- [x] Include timestamp, path, operation type

---

## Task 11: Register Commands in `lib.rs`

### 11.1 Add Command Imports
- [x] Update `commands/mod.rs` to export FS commands:
```rust
pub mod fs;
pub use fs::*;
```

### 11.2 Register with Tauri
- [x] Add FS commands to `invoke_handler`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::fs::fs_read_file,
    commands::fs::fs_write_file,
    commands::fs::fs_list_dir,
    commands::fs::fs_stat,
    commands::fs::fs_exists,
    commands::fs::fs_delete,
    commands::fs::fs_create_dir,
    commands::fs::fs_copy,
    commands::fs::fs_move,
])
```

### 11.3 Initialize Watcher
- [x] Create `FsWatcher` in `setup` closure
- [x] Store in managed state: `app.manage(watcher);`

---

## Task 12: Tests

### 12.1 Unit Tests for `fs/mod.rs`

#### `validate_path` Tests
- [x] Valid relative path within workspace → returns canonical path
- [x] Valid absolute path within workspace → returns canonical path
- [x] Path with `../` traversing outside → returns error
- [ ] Symlink pointing outside workspace → returns error
- [ ] Non-existent file within workspace → returns error (or normalized path?)
- [ ] Empty path → returns workspace root or error?
- [ ] Path with redundant slashes (`//`) → handles gracefully

#### `normalize_path` Tests
- [x] Path with `.` and `..` → cleaned path
- [ ] Empty path → empty PathBuf
- [ ] Absolute path → preserved
- [ ] Windows path separators (if cross-platform)

#### `get_file_language` Tests
- [x] `.rs` file → "Rust"
- [x] Unknown extension → "Unknown"
- [x] No extension → error
- [ ] Case insensitive (`.RS` vs `.rs`)
- [ ] Multiple dots (`file.test.ts`)

### 12.2 Integration Tests for Commands

#### `fs_read_file` Tests
- [ ] Read existing text file → success with content
- [ ] Read non-existent file → `FilesystemNotFound`
- [ ] Read file outside workspace → `FilesystemPathOutsideWorkspace`
- [ ] Read directory → `FilesystemIsDirectory`
- [ ] Read binary file → `is_binary: true` or error
- [ ] Read file exceeding size limit → `FilesystemFileTooLarge`

#### `fs_write_file` Tests
- [ ] Write new file → success, `created: true`
- [ ] Overwrite existing file → success, `created: false`
- [ ] Write with nested directories → directories created
- [ ] Write outside workspace → `FilesystemPathOutsideWorkspace`
- [ ] Write to read-only location → `FilesystemPermissionDenied`
- [ ] Atomic write verification: interrupt mid-write, verify no partial file

#### `fs_list_dir` Tests
- [ ] List empty directory → empty vec
- [ ] List directory with files → correct entries
- [ ] List recursively → includes nested
- [ ] Hidden files excluded by default
- [ ] Hidden files included when `include_hidden: true`
- [ ] Ignored directories excluded (`.git`, `node_modules`)
- [ ] List file (not directory) → `FilesystemIsFile`
- [ ] List outside workspace → error

#### `fs_stat` Tests
- [ ] Stat file → all metadata correct
- [ ] Stat directory → kind = "directory"
- [ ] Stat symlink → detects symlink, resolves target
- [ ] Stat non-existent → `FilesystemNotFound`

#### Watcher Tests
- [ ] Create file → event emitted
- [ ] Modify file → event emitted
- [ ] Delete file → event emitted
- [ ] Rename file → event with old and new paths
- [ ] Rapid modifications → debounced
- [ ] Changes in ignored directories → no events

---

## Task 13: Documentation

### 13.1 Inline Documentation
- [ ] Add `///` doc comments to all public functions
- [ ] Document parameters and return values
- [ ] Include usage examples in doc comments
- [ ] Document error conditions

### 13.2 Module-Level Documentation
- [ ] Add `//!` module docs at top of each file
- [ ] Explain module purpose and design decisions
- [ ] Document security considerations

### 13.3 External Documentation
- [ ] Create `docs/fs-api.md` with IPC command reference
- [ ] Document TypeScript types for frontend
- [ ] Document configuration options
- [ ] Document ignored patterns

---

## Task 14: Frontend Integration

> Note: This task will be done later after backend is complete.

- [ ] Create TypeScript types matching DTOs
- [ ] Create FS service with `invoke()` wrappers
- [ ] Subscribe to watcher events with `listen()`
- [ ] Handle errors and display to user
- [ ] Test end-to-end

---

## Completion Criteria

- [ ] All core functions in `fs/mod.rs` use `BackendError`
- [ ] All DTOs defined in `fs/dto.rs`
- [ ] All commands implemented in `commands/fs.rs`
- [ ] All commands registered in `lib.rs`
- [ ] Watcher implemented and integrated
- [ ] Sandbox validation bulletproof (no escapes)
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Tauri capabilities configured

---

## Dependencies to Add (if needed)

Check `src-tauri/Cargo.toml` for these:
- [ ] `notify` - file system watching (likely already present)
- [ ] `walkdir` - recursive directory listing
- [ ] `ignore` - .gitignore parsing (optional)
- [ ] `chrono` - timestamp formatting (likely already present)
- [ ] `base64` - binary file encoding (if supporting base64 output)

---

## Notes

- All async operations must use `tokio::fs`, not `std::fs`
- Consider file locking for concurrent writes (future enhancement)
- Maximum file size limits protect against memory exhaustion
- Atomic writes prevent data corruption on crash
- Watcher debouncing prevents event storms during bulk operations
