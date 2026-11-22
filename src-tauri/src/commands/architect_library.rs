use super::{get_pool, CommandResult, DbPool};
use crate::db::architect_library::{self, *};
use tauri::State;

#[tauri::command]
pub(crate) async fn architect_list_projects(
    pool: State<'_, DbPool>,
) -> CommandResult<Vec<Project>> {
    Ok(architect_library::list_projects(&get_pool(&pool).await?).await?)
}

#[tauri::command]
pub(crate) async fn architect_create_project(
    pool: State<'_, DbPool>,
    name: String,
) -> CommandResult<Project> {
    Ok(architect_library::create_project(&get_pool(&pool).await?, name).await?)
}

#[tauri::command]
pub(crate) async fn architect_list_blueprints(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Vec<Summary>> {
    Ok(architect_library::list_blueprints(&get_pool(&pool).await?, project_id).await?)
}

#[tauri::command]
pub(crate) async fn architect_create_blueprint(
    pool: State<'_, DbPool>,
    project_id: String,
    name: String,
    document: Document,
) -> CommandResult<Draft> {
    Ok(
        architect_library::create_blueprint(&get_pool(&pool).await?, project_id, name, document)
            .await?,
    )
}

#[tauri::command]
pub(crate) async fn architect_get_draft(
    pool: State<'_, DbPool>,
    blueprint_id: String,
) -> CommandResult<Draft> {
    Ok(architect_library::get_draft(&get_pool(&pool).await?, blueprint_id).await?)
}

#[tauri::command]
pub(crate) async fn architect_save_draft(
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    document: Document,
) -> CommandResult<Draft> {
    let pool = get_pool(&pool).await?;
    architect_library::require_editable(&pool, &blueprint_id).await?;
    Ok(architect_library::save_draft(&pool, blueprint_id, expected_revision, document).await?)
}

#[tauri::command]
pub(crate) async fn architect_save_version(
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    note: Option<String>,
) -> CommandResult<SavedVersion> {
    let pool = get_pool(&pool).await?;
    architect_library::require_editable(&pool, &blueprint_id).await?;
    Ok(architect_library::save_version(&pool, blueprint_id, expected_revision, note).await?)
}

#[tauri::command]
pub(crate) async fn architect_list_versions(
    pool: State<'_, DbPool>,
    blueprint_id: String,
) -> CommandResult<Vec<VersionSummary>> {
    Ok(architect_library::list_versions(&get_pool(&pool).await?, blueprint_id).await?)
}

#[tauri::command]
pub(crate) async fn architect_get_version(
    pool: State<'_, DbPool>,
    key: VersionKey,
) -> CommandResult<Version> {
    Ok(architect_library::get_version(&get_pool(&pool).await?, key).await?)
}

#[tauri::command]
pub(crate) async fn architect_delete_version(
    pool: State<'_, DbPool>,
    key: VersionKey,
) -> CommandResult<()> {
    Ok(architect_library::delete_version(&get_pool(&pool).await?, key).await?)
}

#[tauri::command]
pub(crate) async fn architect_adapt_version(
    pool: State<'_, DbPool>,
    key: VersionKey,
    project_id: String,
    name: String,
) -> CommandResult<Draft> {
    Ok(architect_library::adapt_version(&get_pool(&pool).await?, key, project_id, name).await?)
}

#[tauri::command]
pub(crate) async fn architect_record_use(
    pool: State<'_, DbPool>,
    key: VersionKey,
    usage: Usage,
) -> CommandResult<()> {
    Ok(architect_library::record_use(&get_pool(&pool).await?, key, usage).await?)
}

#[tauri::command]
pub(crate) async fn architect_release_use(
    pool: State<'_, DbPool>,
    key: VersionKey,
    usage: Usage,
) -> CommandResult<()> {
    Ok(architect_library::release_use(&get_pool(&pool).await?, key, usage).await?)
}

#[tauri::command]
pub(crate) async fn architect_list_uses(
    pool: State<'_, DbPool>,
    key: VersionKey,
) -> CommandResult<Vec<Usage>> {
    Ok(architect_library::list_uses(&get_pool(&pool).await?, key).await?)
}

#[tauri::command]
pub(crate) async fn architect_import_blueprint(
    pool: State<'_, DbPool>,
    input: Import,
) -> CommandResult<ImportResult> {
    Ok(architect_library::import_blueprint(&get_pool(&pool).await?, input).await?)
}

#[tauri::command]
pub(crate) async fn architect_ensure_conversation(
    pool: State<'_, DbPool>,
    blueprint_id: String,
) -> CommandResult<ConversationResolution> {
    Ok(architect_library::ensure_conversation(&get_pool(&pool).await?, blueprint_id).await?)
}

#[tauri::command]
pub(crate) async fn architect_attach_conversation(
    pool: State<'_, DbPool>,
    blueprint_id: String,
    conversation_id: String,
) -> CommandResult<Summary> {
    Ok(architect_library::attach_conversation(
        &get_pool(&pool).await?,
        blueprint_id,
        conversation_id,
    )
    .await?)
}

#[tauri::command]
pub(crate) async fn architect_migrate_legacy(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    workspace: State<'_, crate::WorkspaceMetadataRoot>,
    config: State<'_, crate::config::ConfigManager>,
    active: State<'_, crate::WorkspaceRoot>,
    local_storage: crate::legacy_agsdl_import::LegacyLocalStorage,
) -> CommandResult<crate::legacy_agsdl_import::LegacyImportReport> {
    use tauri::Manager;
    let roots = vec![
        workspace.0.read().await.clone(),
        active.inner().read().await.clone(),
    ];
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| super::command_error(e.to_string()))?;
    Ok(crate::legacy_agsdl_import::migrate_profile(
        &get_pool(&pool).await?,
        crate::legacy_agsdl_import::configured_roots(&config, roots).await,
        Some(crate::core::config::resolve_desktop_default_workspace_path(
            &data,
        )),
        local_storage,
    )
    .await?)
}
