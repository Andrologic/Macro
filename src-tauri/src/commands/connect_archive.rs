//! Local archive reads only. No F decision or transfer admission is exposed.
use super::{CommandResult, DbPool};
use crate::{
    config::ConfigManager,
    db::{
        chat_admission::runtime::ChatAdmissionRuntime,
        connect_transfer::{
            reader_runtime::{ArchiveReaderRuntime, RetainedReply},
            reader_types::*,
        },
    },
};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub(crate) async fn connect_archive_open(
    pool: State<'_, DbPool>,
    manager: State<'_, ConfigManager>,
    reader: State<'_, ArchiveReaderRuntime>,
    admission: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    input: ArchiveOpenInput,
) -> CommandResult<ArchiveReadHandle> {
    let page = admission.current_page(window.label());
    reader
        .open(&pool, &manager, window.label(), &page, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn connect_archive_page(
    reader: State<'_, ArchiveReaderRuntime>,
    admission: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    input: ArchivePageInput,
) -> CommandResult<RetainedReply<ArchivePage>> {
    reader
        .page(
            window.label(),
            &admission.current_page(window.label()),
            input,
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn connect_archive_materialize(
    reader: State<'_, ArchiveReaderRuntime>,
    admission: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    input: ArchiveMaterializeInput,
) -> CommandResult<RetainedReply<ArchiveBacking>> {
    reader
        .materialize(
            window.label(),
            &admission.current_page(window.label()),
            input,
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) fn connect_archive_release(
    reader: State<'_, ArchiveReaderRuntime>,
    admission: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    input: ArchiveReleaseInput,
) -> CommandResult<()> {
    reader
        .release(
            window.label(),
            &admission.current_page(window.label()),
            input,
        )
        .map_err(Into::into)
}
