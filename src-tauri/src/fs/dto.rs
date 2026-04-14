use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResultDto {
    /// Path where file was written
    pub path: String,
    /// Number of bytes written
    pub bytes_written: u64,
    /// Whether the file was created (true) or overwritten (false)
    pub created: bool,
    /// Whether the write was skipped because the content was identical
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FsEventDto {
    Created { path: String },
    Modified { path: String },
    Deleted { path: String },
    Renamed { old_path: String, new_path: String },
}
