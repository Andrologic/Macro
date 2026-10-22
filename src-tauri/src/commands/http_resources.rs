use super::{command_error, CommandResult};
use tauri::{Manager, ResourceId, ResourceTable, Runtime, Webview};

#[derive(Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum WebviewResourceRelease {
    Removed,
    AlreadyAbsent,
}

fn release(table: &mut ResourceTable, rid: ResourceId) -> CommandResult<WebviewResourceRelease> {
    if !table.has(rid) {
        return Ok(WebviewResourceRelease::AlreadyAbsent);
    }
    table
        .close(rid)
        .map_err(|error| command_error(error.to_string()))?;
    Ok(WebviewResourceRelease::Removed)
}

/// Proves table absence only. Callers must also join every operation holding an Arc.
#[tauri::command]
pub fn http_release_webview_resource<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> CommandResult<WebviewResourceRelease> {
    release(&mut webview.resources_table(), rid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Resource(Arc<AtomicUsize>);
    impl tauri::Resource for Resource {}
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn removal_is_idempotent_and_does_not_remove_a_distinct_body() {
        let mut table = ResourceTable::default();
        let dropped = Arc::new(AtomicUsize::new(0));
        let request = table.add(Resource(dropped.clone()));
        let body = table.add(Resource(dropped.clone()));
        assert_eq!(
            release(&mut table, request).unwrap(),
            WebviewResourceRelease::Removed
        );
        assert_eq!(
            release(&mut table, request).unwrap(),
            WebviewResourceRelease::AlreadyAbsent
        );
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(table.has(body));
        assert_eq!(
            serde_json::to_value(WebviewResourceRelease::AlreadyAbsent).unwrap(),
            "alreadyAbsent"
        );
    }

    #[test]
    fn missing_resource_does_not_fall_back_to_another_table() {
        let mut caller = ResourceTable::default();
        let mut other_webview = ResourceTable::default();
        let dropped = Arc::new(AtomicUsize::new(0));
        let other_rid = other_webview.add(Resource(dropped.clone()));
        assert_eq!(
            release(&mut caller, other_rid).unwrap(),
            WebviewResourceRelease::AlreadyAbsent
        );
        assert!(other_webview.has(other_rid));
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn removal_does_not_claim_to_join_an_active_operation() {
        let mut table = ResourceTable::default();
        let dropped = Arc::new(AtomicUsize::new(0));
        let rid = table.add(Resource(dropped.clone()));
        let active = table.get::<Resource>(rid).unwrap();
        assert_eq!(
            release(&mut table, rid).unwrap(),
            WebviewResourceRelease::Removed
        );
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(active);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }
}
