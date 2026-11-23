use super::{get_pool, CommandResult, DbPool};
use crate::architect_library::{
    imports,
    project_editor::{EditBatch, FileRead, ProjectTarget, ProjectView},
    storage::{
        editor::{DraftProject, ImportedProject, VersionProject},
        Storage,
    },
    Error,
};
use crate::db::architect_library::{self, *};
use std::path::PathBuf;
use tauri::State;
use tauri::{Emitter, Manager};

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

#[derive(serde::Serialize)]
#[serde(untagged)]
pub(crate) enum DraftResponse {
    Project(DraftProject),
    Legacy(Draft),
}

#[derive(serde::Serialize)]
#[serde(untagged)]
pub(crate) enum VersionResponse {
    Project(VersionProject),
    Legacy(Version),
}

#[derive(serde::Serialize)]
#[serde(untagged)]
pub(crate) enum SaveResponse {
    Project(ProjectView),
    Legacy(Draft),
}

async fn project_storage(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
) -> CommandResult<Storage> {
    current_storage(app, pool)
        .await?
        .ok_or_else(|| project_error(Error::Editor("LEGACY_LIBRARY")))
}

fn project_error(error: Error) -> crate::core::command_error::CommandError {
    crate::db::DbError::from(error).into()
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
    document: Option<Document>,
) -> CommandResult<DraftResponse> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(DraftResponse::Project(
            storage
                .create_project_draft(&pool, &project_id, &name)
                .await?,
        ));
    }
    let document = document.ok_or_else(|| project_error(Error::Editor("LEGACY_LIBRARY")))?;
    Ok(DraftResponse::Legacy(
        architect_library::create_blueprint(&pool, project_id, name, document).await?,
    ))
}

#[tauri::command]
pub(crate) async fn architect_get_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
) -> CommandResult<DraftResponse> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(DraftResponse::Project(
            storage.open_draft_project(&pool, &blueprint_id).await?,
        ));
    }
    Ok(DraftResponse::Legacy(
        architect_library::get_draft(&pool, blueprint_id).await?,
    ))
}

#[tauri::command]
pub(crate) async fn architect_read_project_file(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    target: ProjectTarget,
    path: String,
) -> CommandResult<FileRead> {
    let pool = get_pool(&pool).await?;
    Ok(project_storage(&app, &pool)
        .await?
        .read_project_file(&pool, target, &path)
        .await?)
}

#[tauri::command]
pub(crate) async fn architect_save_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    batch: Option<EditBatch>,
    document: Option<Document>,
) -> CommandResult<SaveResponse> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        let batch = batch.ok_or_else(|| project_error(Error::Editor("PROJECT_BATCH_REQUIRED")))?;
        return Ok(SaveResponse::Project(
            storage
                .edit_project(&pool, &blueprint_id, expected_revision, batch, true)
                .await?,
        ));
    }
    let document = document.ok_or_else(|| project_error(Error::Editor("LEGACY_LIBRARY")))?;
    architect_library::require_editable(&pool, &blueprint_id).await?;
    Ok(SaveResponse::Legacy(
        architect_library::save_draft(&pool, blueprint_id, expected_revision, document).await?,
    ))
}

#[tauri::command]
pub(crate) async fn architect_validate_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    batch: EditBatch,
) -> CommandResult<ProjectView> {
    let pool = get_pool(&pool).await?;
    Ok(project_storage(&app, &pool)
        .await?
        .edit_project(&pool, &blueprint_id, expected_revision, batch, false)
        .await?)
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
        if edited_draft.is_some() {
            return Err(project_error(Error::Editor("PROJECT_BATCH_REQUIRED")));
        }
        return Ok(storage
            .freeze(&pool, blueprint_id, expected_revision, note, None)
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
) -> CommandResult<VersionResponse> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        return Ok(VersionResponse::Project(
            storage.open_version_project(&pool, &key).await?,
        ));
    }
    Ok(VersionResponse::Legacy(
        architect_library::get_version(&pool, key).await?,
    ))
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
) -> CommandResult<DraftResponse> {
    let pool = get_pool(&pool).await?;
    if let Some(storage) = current_storage(&app, &pool).await? {
        let draft = storage.adapt_version(&pool, key, project_id, name).await?;
        return Ok(DraftResponse::Project(
            storage.open_draft_project(&pool, &draft.summary.id).await?,
        ));
    }
    Ok(DraftResponse::Legacy(
        architect_library::adapt_version(&pool, key, project_id, name).await?,
    ))
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
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    input: Import,
) -> CommandResult<ImportResult> {
    let storage = Storage::new(&app_data(&app)?);
    Ok(architect_library::import_blueprint_with_storage(
        &get_pool(&pool).await?,
        input,
        Some(&storage),
    )
    .await?)
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
pub(crate) async fn architect_inspect_import(
    app: tauri::AppHandle,
    path: PathBuf,
) -> CommandResult<imports::InspectedImport> {
    let data = app_data(&app)?;
    tokio::task::spawn_blocking(move || imports::inspect(data, &path))
        .await
        .map_err(|error| super::command_error(error.to_string()))?
        .map_err(project_error)
}

#[tauri::command]
pub(crate) async fn architect_commit_import(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    handle: uuid::Uuid,
    project_id: String,
    name: String,
) -> CommandResult<ImportedProject> {
    Storage::validate_project_name(&name).map_err(project_error)?;
    let pool = get_pool(&pool).await?;
    let storage = project_storage(&app, &pool).await?;
    let data = app_data(&app)?;
    let claim = tokio::task::spawn_blocking(move || imports::take(&data, handle))
        .await
        .map_err(|error| super::command_error(error.to_string()))?
        .map_err(project_error)?;
    let imported = storage
        .import_project(&pool, &project_id, &name, claim.candidate())
        .await?;
    claim.commit();
    Ok(imported)
}

#[tauri::command]
pub(crate) async fn architect_export_archive(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    key: VersionKey,
    destination: PathBuf,
) -> CommandResult<PathBuf> {
    let pool = get_pool(&pool).await?;
    project_storage(&app, &pool)
        .await?
        .export_version_archive(&pool, &key, &destination)
        .await?;
    Ok(destination)
}

#[tauri::command]
pub(crate) async fn architect_export_project(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    target: ProjectTarget,
    destination: PathBuf,
) -> CommandResult<usize> {
    let pool = get_pool(&pool).await?;
    Ok(project_storage(&app, &pool)
        .await?
        .export_project(&pool, target, &destination)
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
    Ok(crate::legacy_agsdl_import::bootstrap_profile(
        &pool,
        &Storage::new(&data),
        crate::legacy_agsdl_import::configured_roots(&config, roots).await,
        Some(crate::core::config::resolve_desktop_default_workspace_path(
            &data,
        )),
        local_storage,
        |progress| {
            let _ = app.emit("architect:cutover-progress", progress);
        },
    )
    .await?)
}

#[tauri::command]
pub(crate) async fn architect_discard_import(
    app: tauri::AppHandle,
    handle: uuid::Uuid,
) -> CommandResult<()> {
    let data = app_data(&app)?;
    tokio::task::spawn_blocking(move || imports::discard(&data, handle))
        .await
        .map_err(|error| super::command_error(error.to_string()))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn architect_execution_hidden_agents(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    execution_id: String,
) -> CommandResult<Vec<String>> {
    let pool = get_pool(&pool).await?;
    let Some(storage) = current_storage(&app, &pool).await? else {
        return Ok(Vec::new());
    };
    Ok(storage
        .execution_hidden_agents(&pool, &execution_id)
        .await?)
}

#[tauri::command]
pub(crate) async fn architect_adapt_recovery_draft(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    blueprint_id: String,
    expected_revision: i64,
    project_id: String,
    name: String,
) -> CommandResult<DraftProject> {
    let pool = get_pool(&pool).await?;
    Ok(project_storage(&app, &pool)
        .await?
        .adapt_recovery_draft(&pool, &blueprint_id, expected_revision, &project_id, &name)
        .await?)
}
