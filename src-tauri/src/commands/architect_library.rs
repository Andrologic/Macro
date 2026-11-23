use super::{get_pool, CommandResult, DbPool};
use crate::architect_library::{migration, storage::Storage};
use crate::db::architect_library::{self, *};
use std::path::PathBuf;
use tauri::Manager;
use tauri::State;

async fn current_storage(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
) -> CommandResult<Option<Storage>> {
    let mut connection = pool.acquire().await.map_err(crate::db::DbError::from)?;
    if !storage_index::is_current(&mut connection).await? {
        return Ok(None);
    }
    Ok(Some(Storage::new(&app_data(app)?)))
}

fn app_data(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| super::command_error(error.to_string()))
}

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
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    project_id: String,
    name: String,
    document: Document,
) -> CommandResult<Draft> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage.create(&pool, project_id, name, document).await?);
    }
    Ok(architect_library::create_blueprint(&pool, project_id, name, document).await?)
}

#[tauri::command]
pub(crate) async fn architect_get_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
) -> CommandResult<Draft> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage.get_draft(&pool, blueprint_id).await?);
    }
    Ok(architect_library::get_draft(&pool, blueprint_id).await?)
}

#[tauri::command]
pub(crate) async fn architect_save_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    document: Document,
) -> CommandResult<Draft> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage
            .save_draft(&pool, blueprint_id, expected_revision, document)
            .await?);
    }
    architect_library::require_editable(&pool, &blueprint_id).await?;
    Ok(architect_library::save_draft(&pool, blueprint_id, expected_revision, document).await?)
}

#[tauri::command]
pub(crate) async fn architect_save_version(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    note: Option<String>,
    edited_draft: Option<Document>,
) -> CommandResult<SavedVersion> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage
            .freeze(&pool, blueprint_id, expected_revision, note, edited_draft)
            .await?);
    }
    architect_library::require_editable(&pool, &blueprint_id).await?;
    Ok(
        architect_library::save_version(&pool, blueprint_id, expected_revision, note, edited_draft)
            .await?,
    )
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
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    key: VersionKey,
) -> CommandResult<Version> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage.get_version(&pool, key).await?);
    }
    Ok(architect_library::get_version(&pool, key).await?)
}

#[tauri::command]
pub(crate) async fn architect_delete_version(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    key: VersionKey,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage.delete_version(&pool, key).await?);
    }
    Ok(architect_library::delete_version(&pool, key).await?)
}

#[tauri::command]
pub(crate) async fn architect_adapt_version(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    key: VersionKey,
    project_id: String,
    name: String,
) -> CommandResult<Draft> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(storage.adapt_version(&pool, key, project_id, name).await?);
    }
    Ok(architect_library::adapt_version(&pool, key, project_id, name).await?)
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
pub(crate) async fn architect_export_original_envelope(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    revision: i64,
    number: Option<i64>,
    destination: PathBuf,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let storage = current_storage(&app, &pool)
        .await?
        .ok_or_else(|| super::command_error("Architect is still using legacy storage"))?;
    Ok(storage
        .export_original(&pool, blueprint_id, revision, number, &destination)
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
    let roots = vec![
        workspace.0.read().await.clone(),
        active.inner().read().await.clone(),
    ];
    let data = app_data(&app)?;
    let pool = get_pool(&pool).await?;
    let report = crate::legacy_agsdl_import::migrate_profile(
        &pool,
        crate::legacy_agsdl_import::configured_roots(&config, roots).await,
        Some(crate::core::config::resolve_desktop_default_workspace_path(
            &data,
        )),
        local_storage,
    )
    .await?;
    if report.status == crate::legacy_agsdl_import::LegacyImportStatus::Complete {
        migration::startup(&pool, &data).await?;
    }
    Ok(report)
}
