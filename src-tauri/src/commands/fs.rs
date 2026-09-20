// Desktop adapters resolve managed state before calling shared FS operations.
use crate::core::error::BackendError;
use crate::core::tool_policy::is_macro_scoped_path;
use crate::fs::dto::*;
pub use crate::fs::operations::*;
use crate::git::GitState;
use crate::WorkspaceRoot;
use std::path::PathBuf;

#[tauri::command]
pub async fn fs_read_file(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<FileContentDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    read_file_internal(&workspace, effective_path, allow_outside_workspace).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_write_file(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
    expected_revision: Option<String>,
    unix_mode: Option<u32>,
) -> Result<WriteResultDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    write_file_internal_with_revision_and_mode(
        &workspace,
        effective_path,
        content,
        create_dirs,
        allow_outside_workspace,
        expected_revision.as_deref(),
        unix_mode,
    )
    .await
}

#[tauri::command]
pub async fn fs_search_files(
    roots: Vec<WorkspaceFileSearchRootDto>,
    query: String,
    limit: Option<u32>,
    include_hidden: Option<bool>,
    virtual_root_enabled: Option<bool>,
) -> Result<Vec<WorkspaceFileSearchResultDto>, BackendError> {
    search_files(roots, query, limit, include_hidden, virtual_root_enabled).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_list_dir(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    list_dir_internal(
        &workspace,
        effective_path,
        recursive,
        include_hidden,
        max_depth,
        allow_outside_workspace,
    )
    .await
}

#[tauri::command]
pub async fn fs_stat(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<FileStatsDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    stat_internal(&workspace, effective_path).await
}

#[tauri::command]
pub async fn fs_exists(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<bool, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    exists_internal(&workspace, effective_path).await
}

#[tauri::command]
pub async fn fs_delete(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
    expected_revision: Option<String>,
) -> Result<(), BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    delete_path_internal_with_revision(
        &workspace,
        effective_path,
        recursive,
        expected_revision.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn fs_create_dir(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    create_dir_internal(&workspace, effective_path, recursive).await
}

#[tauri::command]
pub async fn fs_copy(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    src: String,
    dest: String,
) -> Result<u64, BackendError> {
    let workspace = workspace_root.inner().read().await.clone();
    let src_macro = is_macro_scoped_path(&src);
    let dest_macro = is_macro_scoped_path(&dest);
    if src_macro != dest_macro {
        return Err(BackendError::Validation(
            "Copy across workspace and metadata roots is not supported".to_string(),
        ));
    }
    let workspace = if src_macro {
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None)
            .await?
    } else {
        workspace
    };
    let src_effective = if src_macro {
        map_macro_virtual_path(&src)
    } else {
        src.clone()
    };
    let dest_effective = if dest_macro {
        map_macro_virtual_path(&dest)
    } else {
        dest.clone()
    };
    copy_path_internal(&workspace, src_effective, dest_effective).await
}

#[tauri::command]
pub async fn fs_move(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    src: String,
    dest: String,
) -> Result<(), BackendError> {
    let workspace = workspace_root.inner().read().await.clone();
    let src_macro = is_macro_scoped_path(&src);
    let dest_macro = is_macro_scoped_path(&dest);
    if src_macro != dest_macro {
        return Err(BackendError::Validation(
            "Move across workspace and metadata roots is not supported".to_string(),
        ));
    }
    let workspace = if src_macro {
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None)
            .await?
    } else {
        workspace
    };
    let src_effective = if src_macro {
        map_macro_virtual_path(&src)
    } else {
        src.clone()
    };
    let dest_effective = if dest_macro {
        map_macro_virtual_path(&dest)
    } else {
        dest.clone()
    };
    move_path_internal(&workspace, src_effective, dest_effective).await
}
