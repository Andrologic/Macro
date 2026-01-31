// File System Commands
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

// Placeholder - to be implemented manually

// Expected commands:
// - fs_read_file(path: String) -> Result<FileContentDto>
// - fs_write_file(path: String, content: String) -> Result<()>
// - fs_list_dir(path: String, recursive: bool) -> Result<DirEntry[]>
// - fs_stat(path: String) -> Result<FileStats>

#[tauri::command]
pub async fn fs_read_file(workspace: tauri::State<'_, PathBuf>, path: String) -> Result<FileContentDto, BackendError> {
    unimplemented!("fs_read_file command is not yet implemented");
}
